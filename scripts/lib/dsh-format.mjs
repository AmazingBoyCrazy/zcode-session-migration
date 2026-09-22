/**
 * DSH v3 session-log authoring primitives.
 *
 * The logical records are produced by DSH's own shipped codec
 * (`@deepseek-ai/dsh-session-format-catalog`), so they cannot drift from the format
 * the installed build understands. Only the physical container is implemented here,
 * mirroring `dsh-session-persistence-jsonl`:
 *   - every frame starts with the Zstandard magic and carries a checksum
 *     (`compressZstdFrame` uses `{ params: { ZSTD_c_checksumFlag: 1 } }`);
 *   - the first frame holds exactly one header line and nothing else
 *     (`assertZstdHeaderFrame`);
 *   - `scanZstdFrames` walks frame and block headers without decompressing.
 */
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib';
import path from 'node:path';
import { importDshModule, resolveDshHome } from './paths.mjs';

/** Installed logical session format generation this skill writes. */
export const SESSION_FORMAT_VERSION = 3;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };

const catalogCache = new Map();

/** Load DSH's shipped session-format catalog for one DSH home. */
export async function loadCatalog(home = resolveDshHome()) {
  const key = path.resolve(home);
  if (!catalogCache.has(key)) {
    catalogCache.set(
      key,
      importDshModule(key, '@deepseek-ai/dsh-session-format-catalog').then((mod) => mod.sessionFormatCatalog),
    );
  }
  return catalogCache.get(key);
}

/**
 * The persistence backend's readable project-directory key.
 * Separators collapse to `-`; anything outside `[A-Za-z0-9._-]` escapes as `~XXXX`.
 * @param {string} cwd - absolute session working directory.
 * @returns {string} the `--name--` directory component.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** The persistence backend's single path-segment encoder for session ids. */
export function encodeSegment(id) {
  let out = '';
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** Absolute artifact path for one session under a sessions root. */
export function sessionArtifactPath(sessionsRoot, cwd, id) {
  return path.join(sessionsRoot, projectKey(cwd), encodeSegment(id), `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`);
}

function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS);
}

/**
 * Encode one session artifact: a header-only first frame, then one frame carrying
 * every event line.
 * @param {{header: object, events: object[]}} artifact
 * @param {string} [home] - DSH home used to load the catalog.
 * @returns {Promise<Buffer>}
 */
export async function encodeSessionArtifact(artifact, home) {
  const catalog = await loadCatalog(home);
  const headerRecord = catalog.encodeCurrentHeader(artifact.header, 0);
  const rows = artifact.events.map((event) => catalog.encodeCurrentEvent(event));
  const headerLine = `${JSON.stringify(headerRecord)}\n`;
  const eventText = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  return Buffer.concat([frame(headerLine), frame(eventText)]);
}

/** Structural frame scan; throws unless every frame is complete and checksummed. */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) throw new Error(`torn frame header at byte ${offset}`);
    if (!buffer.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    if (!checksum) throw new Error(`frame at byte ${start} lacks the checksum flag DSH writes`);
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn block header at byte ${offset}`);
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/**
 * Validate an artifact the way DSH reads it: structural frame scan, per-frame
 * decode, then the strictest logical replay (`recovery: 'strict'`,
 * `validation: 'current'`, which routes through `Session.fromRestore`).
 * @param {Buffer} buffer
 * @param {string} [label]
 * @param {string} [home]
 */
export async function validateSessionArtifact(buffer, label = 'session artifact', home, options = {}) {
  const catalog = await loadCatalog(home);
  let frames;
  try {
    frames = scanZstdFrames(buffer);
  } catch (error) {
    throw new Error(`${label}: physical framing rejected: ${error.message}`);
  }
  if (frames.length < 2) throw new Error(`${label}: expected a header frame plus at least one event frame`);

  const plaintexts = frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
  const headerLine = plaintexts[0];
  if (headerLine.length === 0 || headerLine.indexOf('\n') !== headerLine.length - 1) {
    throw new Error(`${label}: first frame is not exactly one header line`);
  }
  const headerRecord = JSON.parse(headerLine);
  if (headerRecord.type !== 'session') throw new Error(`${label}: header frame is not a session header`);

  const rows = [];
  for (const plaintext of plaintexts.slice(1)) {
    for (const line of plaintext.split('\n')) if (line.length > 0) rows.push(JSON.parse(line));
  }
  if (rows.length === 0) throw new Error(`${label}: artifact carries no events`);

  try {
    const restore = catalog.createRestore(headerRecord, {
      recovery: options.recovery ?? 'strict',
      validation: options.validation ?? 'current',
    });
    for (const row of rows) restore.decodeRow(row);
    const current = restore.finish();
    return {
      events: current.events.length,
      turns: current.events.filter((event) => event.type === 'turn/start').length,
      steps: current.events.filter((event) => event.type === 'step/start').length,
      title: current.events.find((event) => event.type === 'session/title')?.data.title,
    };
  } catch (error) {
    throw new Error(`${label}: logical replay rejected: ${error.message}`);
  }
}

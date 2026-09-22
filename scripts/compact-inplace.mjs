#!/usr/bin/env node
/**
 * Compact an already-migrated session IN PLACE, reusing the source tool's summary.
 *
 * Why this exists next to compact.mjs:
 *   - compact.mjs writes a *new* continuation session and leaves the original alone;
 *   - this one rewrites the original artifact so the very session the user keeps opening
 *     becomes usable. That is what people actually want after hitting the error once.
 *
 * Why DSH cannot do it itself: `dsh-compaction-basic` replays the shadowed region
 * verbatim in its summarization request (so the auxiliary call reuses the provider's warm
 * prefix). Summarizing an already over-limit session therefore overflows the same window —
 * which is exactly what the failed `compaction/end` in such a log records.
 *
 * The append-only log is extended with one native transaction after the last `turn/end`:
 *
 *   compaction/start    { compactionId, turn: null }
 *   compaction/summary  { summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model }
 *   user/message        checkpoint, surfaceOp replace [start..end]
 *   compaction/end      { compactionId, turn: null }
 *
 * `shadowedSeqs` must be an exact contiguous slice of the *current* surface, so this
 * recomputes the surface from the log (honouring earlier `compaction/prune` removals and
 * any replacement checkpoints) instead of assuming every append is still on it.
 *
 * The original file is backed up next to itself before the rewrite, and the rewrite is
 * validated by DSH's strictest replay before it is published. DSH must be stopped.
 *
 * Usage:
 *   node compact-inplace.mjs --manifest <file> [--only <zcodeId,…>] [--dry-run] [--allow-real]
 *                            [--manifest-out <file>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { resolveDshHome, resolveZcodeDb } from './lib/paths.mjs';
import { openZcodeDatabase } from './lib/zcode.mjs';
import { encodeSessionArtifact, validateSessionArtifact, sessionArtifactPath } from './lib/dsh-format.mjs';
import { buildProjectionCacheDocument, writeProjectionCacheDocument, projectionCachePath } from './lib/cache-seed.mjs';

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);
const CHECKPOINT_MARKER = { kind: 'plugin', plugin: 'compact' };
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Prepended to the reused summary so the model knows the history changed hands.
 * The imported transcript happened under another tool: its tool names, approval rules and
 * permission scopes do not describe this environment, and a model that reads them as
 * current will call tools that do not exist or assume access it does not have. Override
 * with `--note <text>`, drop with `--no-note`.
 */
const DEFAULT_MIGRATION_NOTE =
  'Note: this conversation history was migrated from another agent tool into DSH. ' +
  'Tool names, approval rules and permission scopes have changed, and the earlier working ' +
  'directory may not be the current workspace. Treat the earlier transcript as background ' +
  'only: verify paths and state with the tools available here before acting, and do not ' +
  'assume that an approval or permission recorded earlier still applies.';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else options[key] = true;
  }
  return options;
}

/** Decode every zstd frame of a session artifact back into its logical rows. */
function readArtifact(file) {
  const buffer = fs.readFileSync(file);
  const offsets = [];
  let index = 0;
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index);
    index += 4;
  }
  let text = '';
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length;
    text += zstdDecompressSync(buffer.subarray(offsets[k], end)).toString('utf8');
  }
  const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const headerRow = rows[0];
  if (headerRow?.type !== 'session') throw new Error(`${file}: first row is not a session header`);
  return { headerRow, events: rows.slice(1) };
}

/**
 * The current surface: appended surface nodes, minus anything a later `compaction/prune`
 * shadowed, with replacement checkpoints swapped in for the range they replace.
 */
function currentSurface(events) {
  const shadowed = new Set();
  let surface = [];
  for (const event of events) {
    if (event.type === 'compaction/prune') {
      for (const seq of event.data?.shadowedSeqs ?? []) shadowed.add(seq);
      continue;
    }
    if (SURFACE_TYPES.has(event.type)) {
      const op = event.surfaceOp;
      if (op === 'append' || op === undefined) {
        surface.push(event.seq);
        continue;
      }
      if (typeof op === 'object' && op.op === 'replace') {
        surface = surface.filter((seq) => seq < op.startSeq || seq > op.endSeq);
        surface.push(event.seq);
      }
    }
  }
  return surface.filter((seq) => !shadowed.has(seq));
}

const options = parseArgs(process.argv.slice(2));
const home = resolveDshHome(options.home);
const manifestFile = path.resolve(options.manifest ?? 'zcode-migration-manifest.json');
const outFile = path.resolve(options['manifest-out'] ?? 'zcode-compaction-manifest.json');
const dryRun = options['dry-run'] === true;

const defaultHome = resolveDshHome();
if (home === defaultHome && options['allow-real'] !== true) {
  console.error(`refusing to modify sessions in the default DSH home (${home}). Rehearse on a copy first, then pass --allow-real.`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const only = typeof options.only === 'string' ? new Set(options.only.split(',').map((v) => v.trim())) : undefined;
const emitted = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { version: 1, home, sessions: [] };
emitted.sessions ??= [];
const alreadyDone = new Set(emitted.sessions.map((entry) => entry.zcodeId));

const db = openZcodeDatabase(resolveZcodeDb(options.db));
const queryOne = (sql, ...params) => db.prepare(sql).get(...params);

/** Last ZCode compaction boundary for one session, if any. */
function lastCompaction(sessionId) {
  const row = queryOne(
    `select data from part
      where session_id = ? and json_extract(data,'$.type') = 'compaction'
        and json_extract(data,'$.compactBoundary') is not null
      order by time_created desc limit 1`,
    sessionId,
  );
  if (row === undefined) return undefined;
  return JSON.parse(row.data).compactBoundary;
}

/** Text of one ZCode message (its text parts joined). */
function messageText(messageId) {
  return db
    .prepare(`select data from part where message_id = ? order by sequence`)
    .all(messageId)
    .map((row) => JSON.parse(row.data))
    .filter((data) => data.type === 'text' && typeof data.text === 'string')
    .map((data) => data.text)
    .join('\n\n');
}

const report = { home, dryRun, compacted: [], skipped: [], failed: [] };
const chosen = manifest.sessions.filter((entry) => only === undefined || only.has(entry.zcodeId));

for (const entry of chosen) {
  try {
    if (alreadyDone.has(entry.zcodeId) && options.force !== true) {
      report.skipped.push({ zcodeId: entry.zcodeId, reason: 'already compacted in the output manifest' });
      continue;
    }
    const boundary = lastCompaction(entry.zcodeId);
    if (boundary === undefined) {
      report.skipped.push({ zcodeId: entry.zcodeId, reason: 'no compaction in ZCode' });
      continue;
    }
    // Derive the artifact path from --home, never from the manifest: the manifest records
    // where a *previous* run wrote, and a rehearsal against a copy must stay in the copy.
    const artifactPath = sessionArtifactPath(path.join(home, 'sessions'), entry.cwd, entry.dshId);
    if (!fs.existsSync(artifactPath)) {
      report.skipped.push({ zcodeId: entry.zcodeId, reason: `artifact not found under this home: ${artifactPath}` });
      continue;
    }

    const rawSummary = messageText(boundary.summaryMessageIds?.[0] ?? boundary.summaryMessageId).trim();
    if (rawSummary.length === 0) throw new Error('the source compaction has an empty summary message');
    const note =
      options['no-note'] === true ? '' : typeof options.note === 'string' ? options.note : DEFAULT_MIGRATION_NOTE;
    const summary = note.length > 0 ? `${note}\n\n---\n\n${rawSummary}` : rawSummary;

    const { headerRow, events } = readArtifact(artifactPath);
    const before = events.length;
    const surface = currentSurface(events);
    if (surface.length === 0) throw new Error('the session has no current surface to shadow');
    // The bracket must not cross a turn boundary, and a standalone one needs no open turn.
    const lastTurnEnd = events.map((event) => event.type).lastIndexOf('turn/end');
    if (lastTurnEnd !== events.length - 1) {
      throw new Error(
        `the log does not end between turns (last event is ${events.at(-1)?.type}); ` +
          `compacting in place would cross a turn boundary`,
      );
    }

    const lastSeq = events.at(-1).seq;
    const anchor = Number.isSafeInteger(events.at(-1).time) ? events.at(-1).time : Date.now();
    const compactionId = `cmp_${randomUUID()}`;
    const start = surface[0];
    const end = surface.at(-1);
    const shadowedTokenCount = Number.isSafeInteger(boundary.preCompactTokenCount) ? boundary.preCompactTokenCount : 0;
    const model = queryOne(
      `select json_extract(data,'$.providerID') as provider, json_extract(data,'$.modelID') as model
         from message where session_id = ? and json_extract(data,'$.role') = 'assistant'
        order by sequence desc limit 1`,
      entry.zcodeId,
    );

    let nextSeq = lastSeq + 1;
    const appended = [
      { type: 'compaction/start', seq: nextSeq++, time: anchor, data: { compactionId, turn: null } },
      {
        type: 'compaction/summary',
        seq: nextSeq++,
        time: anchor,
        data: {
          compactionId,
          summary,
          shadowedRange: { start, end },
          shadowedSeqs: surface,
          shadowedTokenCount,
          provider: model?.provider ?? 'zcode',
          model: model?.model ?? 'unknown',
        },
      },
      {
        type: 'user/message',
        seq: nextSeq++,
        time: anchor,
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [lastSeq + 1, lastSeq + 2, ...surface],
        data: {
          content: [{ type: 'text', text: summary }],
          source: { ...CHECKPOINT_MARKER, compactionId },
          role: 'user',
          id: `compaction-checkpoint-${compactionId}`,
        },
      },
      { type: 'compaction/end', seq: nextSeq++, time: anchor, data: { compactionId, turn: null } },
    ];

    // The physical header row carries `type: 'session'`; the encoder takes the logical
    // header only, and rejects the extra field.
    const { type: _physicalType, ...logicalHeader } = headerRow;
    const merged = { header: logicalHeader, events: [...events, ...appended] };
    const buffer = await encodeSessionArtifact(merged, home);
    // Production reads persisted logs with `transformed` validation, which skips the
    // installed current-format rules. Those rules require the first surface node to be a
    // `system/message`; a migrated log starts with `user/message`, so once DSH has appended
    // a system/message of its own only this mode accepts the log — the same mode DSH uses.
    const validation = await validateSessionArtifact(buffer, entry.zcodeId, home, {
      recovery: 'recoverable',
      validation: 'transformed',
    });

    const backup = `${artifactPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    if (!dryRun) {
      fs.copyFileSync(artifactPath, backup);
      const temp = `${artifactPath}.compact-tmp`;
      fs.writeFileSync(temp, buffer);
      fs.renameSync(temp, artifactPath);
      // Keep the listing consistent: the cache row must name the new last seq.
      const document = buildProjectionCacheDocument(merged);
      if (document !== null) writeProjectionCacheDocument(path.join(home, 'storages'), entry.dshId, document, true);
    }

    report.compacted.push({
      zcodeId: entry.zcodeId,
      dshId: entry.dshId,
      title: entry.title,
      artifactPath,
      backup,
      eventsBefore: before,
      eventsAfter: validation.events,
      shadowedNodes: surface.length,
      shadowedTokens: shadowedTokenCount,
    });
    emitted.sessions.push({
      zcodeId: entry.zcodeId,
      dshId: entry.dshId,
      title: entry.title,
      artifactPath,
      backup,
      compactionId,
      shadowedNodes: surface.length,
    });
  } catch (error) {
    report.failed.push({ zcodeId: entry.zcodeId, error: error.message });
  }
}
db.close();

if (!dryRun && emitted.sessions.length > 0) {
  emitted.updatedAt = new Date().toISOString();
  fs.writeFileSync(outFile, `${JSON.stringify(emitted, null, 2)}\n`, 'utf8');
}

if (options.json === true) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`In-place compaction ${dryRun ? '(dry run)' : ''}`);
  console.log(`  candidates : ${chosen.length}`);
  console.log(`  compacted  : ${report.compacted.length}`);
  console.log(`  skipped    : ${report.skipped.length}`);
  console.log(`  failed     : ${report.failed.length}`);
  for (const e of report.compacted) {
    console.log(`  + ${e.title ?? e.zcodeId}  (${e.dshId})`);
    console.log(
      `      events ${e.eventsBefore} -> ${e.eventsAfter}; shadowed ${e.shadowedNodes} surface nodes ` +
        `(~${e.shadowedTokens} tokens); model surface now just the summary`,
    );
  }
  for (const e of report.skipped) console.log(`  = skipped ${e.zcodeId}: ${e.reason}`);
  for (const e of report.failed) console.log(`  ! FAILED ${e.zcodeId}: ${e.error}`);
  if (!dryRun && emitted.sessions.length > 0) console.log(`\noutput manifest: ${outFile}\nbackups: <artifact>.bak-<timestamp>`);
}
process.exitCode = report.failed.length > 0 ? 1 : 0;

/**
 * Projection-cache seeding.
 *
 * The sidebar reads a cold session's title exclusively from the persisted projection
 * cache (`session_projcache`, `per-record` layout, one document per session). A session
 * that was never live has no record, and `displayTitleOf()` then falls back to the cwd
 * basename — every imported session would read as its folder name instead of its title.
 *
 * DSH itself would only ever write this record while the session is live, so the
 * migration writes the equivalent checkpoint directly. The values reproduce what the
 * installed projection units compute:
 *   - `title` (stateVersion 1): the latest `session/title` payload, a plain string;
 *   - `sessionListMetadata` (stateVersion 1): `blank` flips false at the first
 *     `turn/start`; `lastPromptAt` tracks the last human `user/message` time and drives
 *     the sidebar's "updated" ordering.
 *
 * The domain is declared `invalidRecords: 'backup-and-skip'`, so a record this tool got
 * wrong is moved aside by DSH and the session simply serves uncached — it can never
 * cost a boot. `identity.formatVersion` is mandatory: a record without it is only ever
 * usable as a predecessor title hint, never as a listing value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_FORMAT_VERSION } from './dsh-format.mjs';

/** Domain document version of the `session_projcache` unit in this DSH build. */
export const PROJECTION_CACHE_VERSION = 7;

/** Absolute path of one session's projection-cache document. */
export function projectionCachePath(storagesRoot, sessionId) {
  return path.join(storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`);
}

/** Build the projection-cache document for one converted session. */
export function buildProjectionCacheDocument(artifact) {
  const { header, events } = artifact;
  const lastSeq = events.at(-1)?.seq;
  if (lastSeq === undefined) return null;

  const title = events.findLast((event) => event.type === 'session/title')?.data?.title;
  if (typeof title !== 'string' || title.length === 0) return null;

  let lastPromptAt = null;
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') lastPromptAt = event.time;
  }
  const blank = !events.some((event) => event.type === 'turn/start');

  return {
    version: PROJECTION_CACHE_VERSION,
    record: {
      identity: {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: header.createdAt,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        isSeeded: header.isSeeded,
        inheritedEventCount: 0,
      },
      rows: {
        title: { ver: 1, seq: lastSeq, val: title },
        sessionListMetadata: { ver: 1, seq: lastSeq, val: { blank, lastPromptAt } },
      },
    },
  };
}

/**
 * Write one projection-cache document. Existing documents are never replaced unless
 * `overwrite` is set, so a re-run cannot clobber a real checkpoint. The file is written
 * by Node as UTF-8 with no BOM and published by rename.
 */
export function writeProjectionCacheDocument(storagesRoot, sessionId, document, overwrite = false) {
  const file = projectionCachePath(storagesRoot, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !overwrite) throw new Error(`projection cache document already exists: ${file}`);
  const temp = `${file}.migrate-tmp-${process.pid}`;
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('refusing to write a BOM-prefixed document');
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
  return file;
}

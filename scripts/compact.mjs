#!/usr/bin/env node
/**
 * Re-emit an imported session with the compaction ZCode had already applied.
 *
 * The problem: ZCode compacts long conversations, so what it actually sends to the
 * model is a summary plus a short tail. The migration copies the *raw* log, so DSH
 * tries to send the whole thing and the provider rejects the request as too long.
 *
 * Running DSH's own compaction instead does not help here: its summarization request
 * replays the shadowed region verbatim, so summarizing a 1.7M-token history overflows
 * the same window. ZCode already paid for that summary, so we reuse it.
 *
 * This writes a NEW session (new id, new directory) and leaves the original untouched:
 *
 *   [ full pre-compaction history, kept in the log ]
 *   compaction/start      { compactionId, turn: null }
 *   compaction/summary    { summary, shadowedRange, shadowedSeqs, ... }
 *   user/message          checkpoint, surfaceOp replace [start..end]
 *   compaction/end        { compactionId, turn: null }
 *   [ post-compaction tail, verbatim ]
 *
 * The shadowed events stay readable in the log; the model surface becomes
 * summary + tail, which is exactly what ZCode was sending.
 *
 * Usage:
 *   node compact.mjs --manifest <file> [--only <zcodeId,…>] [--dry-run] [--allow-real]
 *                    [--suffix <text>] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDshHome, resolveZcodeDb } from './lib/paths.mjs';
import { openZcodeDatabase, loadSessionMessages } from './lib/zcode.mjs';
import { convertSession } from './lib/convert.mjs';
import { encodeSessionArtifact, validateSessionArtifact, sessionArtifactPath, projectKey } from './lib/dsh-format.mjs';
import { buildProjectionCacheDocument, writeProjectionCacheDocument, projectionCachePath } from './lib/cache-seed.mjs';

/** Event types the format layer treats as surface nodes. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);
/** The compaction checkpoint marker DSH writes and recognizes. */
const CHECKPOINT_MARKER = { kind: 'plugin', plugin: 'compact' };

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

const options = parseArgs(process.argv.slice(2));
const home = resolveDshHome(options.home);
const manifestFile = path.resolve(options.manifest ?? 'zcode-migration-manifest.json');
const dryRun = options['dry-run'] === true;
const suffix = typeof options.suffix === 'string' ? options.suffix : ' · 压缩续接';
const dbFile = resolveZcodeDb(options.db);

const defaultHome = resolveDshHome();
if (home === defaultHome && options['allow-real'] !== true) {
  console.error(`refusing to write into the default DSH home (${home}). Rehearse on a copy first, then pass --allow-real.`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const only = typeof options.only === 'string' ? new Set(options.only.split(',').map((v) => v.trim())) : undefined;

// Each run mints new session ids, so a re-run would duplicate every continuation.
// Remember what has already been emitted and skip it unless --force is given.
const outFile = path.resolve(options['manifest-out'] ?? 'zcode-compaction-manifest.json');
const emitted = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { version: 1, home, sessions: [] };
emitted.sessions ??= [];
const alreadyDone = new Set(emitted.sessions.map((entry) => entry.zcodeId));

const db = openZcodeDatabase(dbFile);
const queryOne = (sql, ...params) => db.prepare(sql).get(...params);

/** Last compaction of one ZCode session, or undefined. */
function lastCompaction(sessionId) {
  const row = queryOne(
    `select p.data
       from part p
      where p.session_id = ? and json_extract(p.data,'$.type') = 'compaction'
        and json_extract(p.data,'$.compactBoundary') is not null
      order by p.time_created desc limit 1`,
    sessionId,
  );
  if (row === undefined) return undefined;
  const data = JSON.parse(row.data);
  return { boundary: data.compactBoundary, tailStartId: data.tail_start_id };
}

/** Text of one ZCode message (its text parts joined). */
function messageText(messageId) {
  const rows = db
    .prepare(`select data from part where message_id = ? order by sequence`)
    .all(messageId);
  const chunks = [];
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (data.type === 'text' && typeof data.text === 'string') chunks.push(data.text);
  }
  return chunks.join('\n\n');
}

/**
 * Splice a native compaction transaction into a converted event list.
 * The shadowed region is the surface prefix before the turn that contains the tail
 * message, so the bracket never crosses a turn boundary and every seq before the
 * insertion point keeps its number.
 * @returns {{events: object[], shadowedSeqs: number[], boundarySeq: number, tailTurn: number}}
 */
function spliceCompaction(events, tailMessageId, summary, meta) {
  const tailIndex = events.findIndex(
    (event) =>
      (event.type === 'user/message' && event.data.id === tailMessageId) ||
      (event.type === 'assistant/message' && event.data.message?.id === tailMessageId),
  );
  if (tailIndex < 0) throw new Error(`tail message ${tailMessageId} not found in the converted log`);

  // Walk back to the turn/start that owns the tail so the bracket sits between turns.
  let turnStartIndex = tailIndex;
  while (turnStartIndex > 0 && events[turnStartIndex].type !== 'turn/start') turnStartIndex -= 1;
  if (events[turnStartIndex].type !== 'turn/start') throw new Error('no turn/start owns the tail message');
  const tailTurn = events[turnStartIndex].data.turn;

  const shadowedSeqs = events
    .slice(0, turnStartIndex)
    .filter((event) => SURFACE_TYPES.has(event.type) && event.surfaceOp === 'append')
    .map((event) => event.seq);
  if (shadowedSeqs.length === 0) throw new Error('nothing to shadow: the tail starts at the very first surface event');

  const compactionId = `cmp_${randomUUID()}`;
  const shift = 4;
  const start = shadowedSeqs[0];
  const end = shadowedSeqs.at(-1);
  // Every event needs a millisecond `time`; the bracket is stamped just before the
  // turn it precedes so the log stays ordered.
  const anchor = Number.isSafeInteger(events[turnStartIndex].time) ? events[turnStartIndex].time : Date.now();
  const at = (offset) => Math.max(1, anchor - (shift - offset));

  const inserted = [
    { type: 'compaction/start', time: at(0), data: { compactionId, turn: null } },
    {
      type: 'compaction/summary',
      time: at(1),
      data: {
        compactionId,
        summary,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount: meta.shadowedTokenCount,
        provider: meta.provider,
        model: meta.model,
      },
    },
    {
      type: 'user/message',
      time: at(2),
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      data: {
        content: [{ type: 'text', text: summary }],
        source: { ...CHECKPOINT_MARKER, compactionId },
        role: 'user',
        id: `compaction-checkpoint-${compactionId}`,
      },
    },
    { type: 'compaction/end', time: at(3), data: { compactionId, turn: null } },
  ];

  // Every event from the insertion point on shifts by the inserted count, so their
  // recorded cross-references must shift with them. The shadowed prefix is untouched.
  const shiftMap = new Map();
  for (const event of events.slice(turnStartIndex)) shiftMap.set(event.seq, event.seq + shift);
  const remap = (seq) => shiftMap.get(seq) ?? seq;

  const after = events.slice(turnStartIndex).map((event) => {
    const next = { ...event, seq: remap(event.seq) };
    if (Array.isArray(next.sourceEventSeqs)) next.sourceEventSeqs = next.sourceEventSeqs.map(remap);
    return next;
  });
  // The checkpoint's provenance cites the bracket it belongs to plus everything it shadows.
  inserted[2].sourceEventSeqs = [turnStartIndex, turnStartIndex + 1, ...shadowedSeqs];

  const before = events.slice(0, turnStartIndex);
  const merged = [...before, ...inserted, ...after];
  merged.forEach((event, index) => {
    event.seq = index;
  });
  return { events: merged, shadowedSeqs, tailTurn, checkpointSeq: turnStartIndex + 2 };
}

const report = { home, dryRun, compacted: [], skipped: [], failed: [] };
const chosen = manifest.sessions.filter((entry) => only === undefined || only.has(entry.zcodeId));

for (const entry of chosen) {
  try {
    if (alreadyDone.has(entry.zcodeId) && options.force !== true) {
      report.skipped.push({ zcodeId: entry.zcodeId, reason: 'already compacted in the output manifest' });
      continue;
    }
    const compaction = lastCompaction(entry.zcodeId);
    if (compaction === undefined) {
      report.skipped.push({ zcodeId: entry.zcodeId, reason: 'no compaction in ZCode' });
      continue;
    }
    const summary = messageText(compaction.boundary.summaryMessageIds?.[0] ?? compaction.summaryMessageId).trim();
    if (summary.length === 0) throw new Error('ZCode recorded a compaction boundary but the summary message is empty');

    const zcodeTitle = queryOne(`select title, directory, time_created from session where id = ?`, entry.zcodeId);
    const model = queryOne(
      `select json_extract(data,'$.providerID') as provider, json_extract(data,'$.modelID') as model
         from message where session_id = ? and json_extract(data,'$.role') = 'assistant'
        order by sequence desc limit 1`,
      entry.zcodeId,
    );
    const { messages } = loadSessionMessages(db, entry.zcodeId);
    const dshId = `session-${randomUUID()}`;
    const artifact = convertSession({
      session: { id: entry.zcodeId, title: zcodeTitle.title, directory: zcodeTitle.directory, timeCreated: zcodeTitle.time_created, dshId },
      messages,
      includeToolOutput: true,
    });

    const meta = {
      shadowedTokenCount: Number.isSafeInteger(compaction.boundary.preCompactTokenCount)
        ? compaction.boundary.preCompactTokenCount
        : 0,
      provider: model?.provider ?? 'zcode',
      model: model?.model ?? 'unknown',
    };
    const { events, checkpointSeq, shadowedSeqs } = spliceCompaction(artifact.events, compaction.tailStartId, summary, meta);
    // Distinguish the continuation from the untouched original in the sidebar.
    for (const event of events) {
      if (event.type === 'session/title' && typeof event.data.title === 'string') {
        event.data = { ...event.data, title: `${event.data.title}${suffix}` };
      }
    }
    const finalArtifact = {
      header: { ...artifact.header, id: dshId },
      events: events.map((event, index) => ({ ...event, seq: index })),
    };

    const artifactPath = sessionArtifactPath(path.join(home, 'sessions'), finalArtifact.header.cwd, dshId);
    const buffer = await encodeSessionArtifact(finalArtifact, home);
    const validation = await validateSessionArtifact(buffer, entry.zcodeId, home);

    const cacheDocument = buildProjectionCacheDocument(finalArtifact);
    const cachePath = projectionCachePath(path.join(home, 'storages'), dshId);

    if (!dryRun) {
      if (fs.existsSync(artifactPath)) throw new Error(`destination already exists: ${artifactPath}`);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, buffer, { flag: 'wx' });
      if (cacheDocument !== null) writeProjectionCacheDocument(path.join(home, 'storages'), dshId, cacheDocument, false);
    }

    const isSurface = (event) => SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined;
    report.compacted.push({
      zcodeId: entry.zcodeId,
      dshId,
      title: validation.title,
      cwd: finalArtifact.header.cwd,
      events: validation.events,
      shadowedNodes: shadowedSeqs.length,
      surfaceNodes: finalArtifact.events.filter((event) => isSurface(event) && event.seq > checkpointSeq).length + 1,
      shadowedTokens: meta.shadowedTokenCount,
      artifactPath,
      cachePath: cacheDocument === null ? null : cachePath,
    });
    emitted.sessions.push({
      zcodeId: entry.zcodeId,
      dshId,
      title: validation.title,
      cwd: finalArtifact.header.cwd,
      artifactPath,
      cachePath: cacheDocument === null ? null : cachePath,
      shadowedNodes: shadowedSeqs.length,
      shadowedTokens: meta.shadowedTokenCount,
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
  console.log(`ZCode compaction replay ${dryRun ? '(dry run)' : ''}`);
  console.log(`  candidates : ${chosen.length}`);
  console.log(`  compacted  : ${report.compacted.length}`);
  console.log(`  skipped    : ${report.skipped.length}`);
  console.log(`  failed     : ${report.failed.length}`);
  for (const e of report.compacted) {
    console.log(`  + ${e.title ?? e.zcodeId} -> ${e.dshId}`);
    console.log(
      `      ${e.events} events; shadowed ${e.shadowedNodes} surface nodes (~${e.shadowedTokens} tokens); ` +
        `model surface now ${e.surfaceNodes} nodes`,
    );
  }
  for (const e of report.skipped) console.log(`  = skipped ${e.zcodeId}: ${e.reason}`);
  for (const e of report.failed) console.log(`  ! FAILED ${e.zcodeId}: ${e.error}`);
  if (!dryRun && emitted.sessions.length > 0) console.log(`\noutput manifest: ${outFile}`);
}
process.exitCode = report.failed.length > 0 ? 1 : 0;

#!/usr/bin/env node
/**
 * ZCode → DeepSeek Harness session migration.
 *
 * Additive by construction: only new session directories and new projection-cache
 * documents are ever created. No existing DSH artifact is read, rewritten or removed,
 * and every write is refused when the destination already exists.
 *
 * Usage:
 *   node migrate.mjs [--home <DSH_HOME>] [--only <id,id>] [--limit N] [--since <ms|ISO>]
 *                    [--no-forks] [--include-subagents] [--no-tool-output]
 *                    [--manifest <file>] [--dry-run] [--allow-real] [--json]
 *
 * The default DSH home (`$DSH_HOME`, else `~/.dsh`) additionally requires
 * `--allow-real`, so a rehearsal against a throwaway home is the path of least
 * resistance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDshHome, resolveZcodeDb } from './lib/paths.mjs';
import { openZcodeDatabase, listSessions, loadSessionMessages } from './lib/zcode.mjs';
import { convertSession } from './lib/convert.mjs';
import { encodeSessionArtifact, validateSessionArtifact, sessionArtifactPath, projectKey } from './lib/dsh-format.mjs';
import { buildProjectionCacheDocument, writeProjectionCacheDocument, projectionCachePath } from './lib/cache-seed.mjs';

const DEFAULT_MANIFEST = 'zcode-migration-manifest.json';

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      options[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else options[key] = true;
  }
  return options;
}

function parseSince(value) {
  if (value === undefined) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error(`--since is neither a timestamp nor a date: ${value}`);
  return parsed;
}

const options = parseArgs(process.argv.slice(2));
const home = resolveDshHome(options.home);
const sessionsRoot = path.resolve(options['sessions-root'] ?? path.join(home, 'sessions'));
const storagesRoot = path.resolve(options['storages-root'] ?? path.join(home, 'storages'));
const dbFile = resolveZcodeDb(options.db);
const dryRun = options['dry-run'] === true;
const force = options.force === true;
const includeToolOutput = options['no-tool-output'] !== true;
const manifestFile = path.resolve(options.manifest ?? DEFAULT_MANIFEST);

const defaultHome = resolveDshHome();
if (home === defaultHome && options['allow-real'] !== true) {
  console.error(
    `refusing to write into the default DSH home (${home}).\n` +
      `Rehearse against a throwaway home first, then re-run with --allow-real.`,
  );
  process.exit(2);
}

function loadManifest() {
  if (!fs.existsSync(manifestFile)) {
    return { version: 1, createdAt: new Date().toISOString(), home, sessions: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  parsed.sessions ??= [];
  return parsed;
}

const manifest = loadManifest();
const migratedIds = new Set(manifest.sessions.map((entry) => entry.zcodeId));

const db = openZcodeDatabase(dbFile);
const since = parseSince(options.since);
const only = typeof options.only === 'string' ? new Set(options.only.split(',').map((v) => v.trim())) : undefined;

let candidates = listSessions(db, {
  includeForks: options['no-forks'] !== true,
  includeSubagents: options['include-subagents'] === true,
});
if (only !== undefined) candidates = candidates.filter((session) => only.has(session.id));
if (since !== undefined) candidates = candidates.filter((session) => session.timeUpdated >= since);
if (options.limit !== undefined) candidates = candidates.slice(0, Number(options.limit));

const report = { home, sessionsRoot, storagesRoot, dryRun, converted: [], skipped: [], failed: [] };

for (const session of candidates) {
  const label = `${session.id} (${session.title ?? 'untitled'})`;
  if (migratedIds.has(session.id) && !force) {
    report.skipped.push({ zcodeId: session.id, reason: 'already present in manifest' });
    continue;
  }
  if (typeof session.directory !== 'string' || session.directory.length === 0) {
    // DSH's `session.list` drops cwd-less sessions from the sidebar entirely.
    report.skipped.push({ zcodeId: session.id, reason: 'session has no directory' });
    continue;
  }

  try {
    const dshId = `session-${randomUUID()}`;
    const { messages } = loadSessionMessages(db, session.id);
    const artifact = convertSession({ session: { ...session, dshId }, messages, includeToolOutput });

    const artifactPath = sessionArtifactPath(sessionsRoot, artifact.header.cwd, dshId);
    const buffer = await encodeSessionArtifact(artifact, home);
    const validation = await validateSessionArtifact(buffer, label, home);

    const cacheDocument = buildProjectionCacheDocument(artifact);
    const cachePath = projectionCachePath(storagesRoot, dshId);

    if (!dryRun) {
      if (fs.existsSync(artifactPath)) throw new Error(`destination already exists: ${artifactPath}`);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, buffer, { flag: 'wx' });
      if (cacheDocument !== null) writeProjectionCacheDocument(storagesRoot, dshId, cacheDocument, false);
    }

    manifest.sessions.push({
      zcodeId: session.id,
      dshId,
      kind: session.taskType,
      zcodeParentId: session.zcodeParentId,
      cwd: artifact.header.cwd,
      projectKey: projectKey(artifact.header.cwd),
      title: validation.title ?? session.title ?? null,
      artifactPath,
      cachePath: cacheDocument === null ? null : cachePath,
      createdAt: artifact.header.createdAt,
      bytes: buffer.length,
      events: validation.events,
      turns: validation.turns,
      steps: validation.steps,
      toolCalls: artifact.stats.toolCalls,
      toolErrors: artifact.stats.toolErrors,
      fileParts: artifact.stats.fileParts,
      skippedParts: artifact.stats.skippedParts,
    });
    report.converted.push({
      zcodeId: session.id,
      dshId,
      kind: session.taskType,
      title: validation.title ?? session.title,
      cwd: artifact.header.cwd,
      bytes: buffer.length,
      events: validation.events,
      turns: validation.turns,
      steps: validation.steps,
      toolCalls: artifact.stats.toolCalls,
    });
  } catch (error) {
    report.failed.push({ zcodeId: session.id, title: session.title, error: error.message });
  }
}

db.close();

if (!dryRun) {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (options.json === true) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`ZCode -> DSH migration ${dryRun ? '(dry run)' : ''}`);
  console.log(`  zcode db      : ${dbFile}`);
  console.log(`  dsh home      : ${home}`);
  console.log(`  sessions root : ${sessionsRoot}`);
  console.log(`  candidates    : ${candidates.length}`);
  console.log(`  converted     : ${report.converted.length}`);
  console.log(`  skipped       : ${report.skipped.length}`);
  console.log(`  failed        : ${report.failed.length}`);
  for (const entry of report.converted) {
    console.log(
      `  + [${entry.kind}] ${entry.title ?? entry.zcodeId} -> ${entry.dshId}\n` +
        `      ${entry.cwd} | ${entry.turns} turns, ${entry.steps} steps, ${entry.toolCalls} tool calls, ` +
        `${entry.events} events, ${(entry.bytes / 1024).toFixed(1)} KiB`,
    );
  }
  for (const entry of report.skipped) console.log(`  = skipped ${entry.zcodeId}: ${entry.reason}`);
  for (const entry of report.failed) console.log(`  ! FAILED ${entry.zcodeId} (${entry.title ?? ''}): ${entry.error}`);
  if (!dryRun) console.log(`\nmanifest: ${manifestFile}`);
  if (report.converted.length > 0 && !dryRun) {
    console.log('Next: run register-workspaces.mjs with DSH stopped, then start DSH.');
  }
}

process.exitCode = report.failed.length > 0 ? 1 : 0;

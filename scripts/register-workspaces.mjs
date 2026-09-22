#!/usr/bin/env node
/**
 * Register the ZCode source directories as DSH Workspaces.
 *
 * Why this is needed: the sidebar groups Sessions by the Workspaces recorded in
 * `<DSH_HOME>/storages/workspace.json`. DSH derives that registry from Session `cwd`
 * values only during its one-time history bootstrap, which runs solely while
 * `global.initialized` is false. An already-initialized registry is never re-derived,
 * so freshly imported Sessions would otherwise sit in the browser-local "ungrouped"
 * bucket instead of named groups.
 *
 * Rather than reimplementing the derivation, this script re-arms DSH's own bootstrap:
 * it clears `initialized` and lets `WorkspaceRegistry.bootstrap()` rebuild the registry
 * from session headers on the next boot. That path preserves each existing workspace's
 * `title`, `path` and `createdAt`, keeps `archivedSessionIds`, and only adds the missing
 * groups and their Session ownership.
 *
 * Two hard safety rules:
 *   - the file is written by Node as UTF-8 with NO BOM. A BOM makes DSH fail to boot with
 *     "unit 'workspace': file is not valid JSON" — the `single` layout rejects the whole
 *     unit, so one bad byte costs the entire workspace list. Never use PowerShell's
 *     `Set-Content`/`Out-File` on this file;
 *   - the document is validated against DSH's own exported zod schemas
 *     (`workspaceDomainState`, `workspaceRecord`) before and after writing.
 *
 * DSH must be stopped: a running Host holds the registry in memory and would overwrite
 * the file.
 *
 * Usage:
 *   node register-workspaces.mjs [--home <DSH_HOME>] [--list-only] [--dry-run] [--restore]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshHome, importDshSubpath } from './lib/paths.mjs';

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
const workspaceFile = path.join(home, 'storages', 'workspace.json');
const dryRun = options['dry-run'] === true;

if (!fs.existsSync(workspaceFile)) {
  console.error(`workspace registry not found: ${workspaceFile}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(home, 'sessions'))) {
  console.error(`refusing to touch "${workspaceFile}": "${home}" does not look like a DSH home (no sessions directory)`);
  process.exit(2);
}

const spec = await importDshSubpath(home, '@deepseek-ai/dsh-workspace', 'lib/types/spec.js');
const { workspaceDomainSpec, workspaceDomainState, workspaceRecord } = spec;

/** Parse a document exactly as DSH's storage backend will, and fail loudly. */
function parseAndValidate(text, label) {
  const document = JSON.parse(text);
  if (document?.unit?.name !== workspaceDomainSpec.name) {
    throw new Error(`${label}: unit name is ${JSON.stringify(document?.unit?.name)}, expected ${workspaceDomainSpec.name}`);
  }
  if (document.unit.version !== workspaceDomainSpec.version) {
    throw new Error(`${label}: unit version is ${document.unit.version}, expected ${workspaceDomainSpec.version}`);
  }
  const global = workspaceDomainState.parse(document.global);
  const table = document.tables?.['workspaces'];
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new Error(`${label}: tables.workspaces is not an object`);
  }
  const records = {};
  for (const [id, record] of Object.entries(table)) records[id] = workspaceRecord.parse(record);
  for (const id of global.workspaceIds) {
    if (!Object.hasOwn(records, id)) throw new Error(`${label}: workspaceIds names ${id}, which has no record`);
  }
  for (const id of Object.keys(records)) {
    if (!global.workspaceIds.includes(id)) throw new Error(`${label}: record ${id} is missing from workspaceIds`);
  }
  return { global, records };
}

/* ---------------------------------------------------------------- --restore */
if (options.restore === true) {
  const backups = fs
    .readdirSync(path.dirname(workspaceFile))
    .filter((name) => name.startsWith('workspace.json.bak-'))
    .sort();
  if (backups.length === 0) {
    console.error('no workspace.json.bak-* backup found');
    process.exit(2);
  }
  const newest = path.join(path.dirname(workspaceFile), backups.at(-1));
  parseAndValidate(fs.readFileSync(newest, 'utf8'), newest);
  if (!dryRun) fs.copyFileSync(newest, workspaceFile);
  console.log(`${dryRun ? 'would restore' : 'restored'} ${workspaceFile} from ${newest}`);
  process.exit(0);
}

/* ------------------------------------------------------------------ inspect */
const original = fs.readFileSync(workspaceFile, 'utf8');
if (original.charCodeAt(0) === 0xfeff) throw new Error(`${workspaceFile} starts with a BOM; refusing to operate on it`);
const { global, records } = parseAndValidate(original, workspaceFile);

console.log(`workspace registry : ${workspaceFile}`);
console.log(`initialized        : ${global.initialized}`);
console.log(`workspaces         : ${global.workspaceIds.length} (archived sessions: ${global.archivedSessionIds.length})`);
for (const id of global.workspaceIds) {
  const record = records[id];
  console.log(`  ${record.title.padEnd(16)} ${String(record.sessionIds.length).padStart(3)} sessions  ${record.path}`);
}

if (!global.initialized) {
  console.log('\nglobal.initialized is already false — the next DSH boot will run the history bootstrap.');
} else if (options['list-only'] === true) {
  // nothing to do
} else {
  const backup = `${workspaceFile}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const next = { ...JSON.parse(original) };
  next.global = { ...next.global, initialized: false };
  parseAndValidate(JSON.stringify(next), 're-armed document');

  if (dryRun) {
    console.log(`\n[dry run] would back up to ${backup} and set global.initialized = false`);
  } else {
    fs.copyFileSync(workspaceFile, backup);
    const temp = `${workspaceFile}.rewrite-tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    if (fs.readFileSync(temp, 'utf8').charCodeAt(0) === 0xfeff) throw new Error('refusing to publish a BOM-prefixed document');
    parseAndValidate(fs.readFileSync(temp, 'utf8'), 'rewritten document');
    fs.renameSync(temp, workspaceFile);
    parseAndValidate(fs.readFileSync(workspaceFile, 'utf8'), workspaceFile);
    console.log(`\nbackup             : ${backup}`);
    console.log('global.initialized -> false');
    console.log('\nNext: start DSH. Its own history bootstrap will add the missing Workspaces and');
    console.log('attach every Session whose cwd maps to them. Restore with --restore if needed.');
  }
}

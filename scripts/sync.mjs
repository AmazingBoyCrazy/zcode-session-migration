#!/usr/bin/env node
/**
 * One-command incremental re-sync: ZCode → DSH.
 *
 * ZCode gains sessions over time, so this wraps the two steps that must happen in order:
 *   1. `migrate.mjs` — convert every not-yet-migrated session. It is idempotent: the
 *      manifest remembers each `zcodeId`, so a re-run only picks up what is new;
 *   2. `register-workspaces.mjs` — re-arm DSH's history bootstrap. Bootstrap is the only
 *      thing that attaches *cold* Sessions to a Workspace by `cwd`, and it runs only
 *      while `global.initialized` is false. Without it, newly imported sessions would sit
 *      in the browser-local "ungrouped" bucket.
 *
 * Run with DSH fully stopped, then start DSH: the bootstrap and the projection cache both
 * take effect on that boot.
 *
 * Usage:
 *   node sync.mjs [--home <DSH_HOME>] [--allow-real] [--dry-run]
 *                 [--no-forks] [--include-subagents] [--manifest <file>]
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);

const flag = (name) => argv.includes(`--${name}`);
function value(name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const manifest = value('manifest') ?? 'zcode-migration-manifest.json';
const dryRun = flag('dry-run');

/** Re-enter a sibling script with inherited stdio (no pipes). */
function run(script, args, label) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, script), ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    console.error(`\n${label} exited with ${result.status}; stopping before the next step.`);
    process.exit(result.status ?? 1);
  }
}

const migrateArgs = ['--manifest', manifest];
if (value('home') !== undefined) migrateArgs.push('--home', value('home'));
if (flag('allow-real')) migrateArgs.push('--allow-real');
if (dryRun) migrateArgs.push('--dry-run');
if (flag('no-forks')) migrateArgs.push('--no-forks');
if (flag('include-subagents')) migrateArgs.push('--include-subagents');

run('migrate.mjs', migrateArgs, '1/2 import new ZCode sessions (forks included by default)');

if (dryRun) {
  console.log('\n=== 2/2 workspace registration skipped (dry run) ===');
} else {
  run('register-workspaces.mjs', value('home') === undefined ? [] : ['--home', value('home')], '2/2 re-arm the DSH workspace bootstrap');
}

console.log('\nNext: start DSH. It derives the missing Workspaces, attaches the new Sessions');
console.log('by cwd, and loads the seeded titles from the projection cache.');
console.log(`Rollback: node rollback.mjs ${manifest}`);

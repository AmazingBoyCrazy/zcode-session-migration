#!/usr/bin/env node
/**
 * Reverse a ZCode → DSH migration.
 *
 * Reads the manifest written by `migrate.mjs` and removes exactly what that run created:
 * the session directories it wrote and the projection-cache documents it seeded. Nothing
 * else is touched, so pre-existing DSH sessions are never at risk.
 *
 * Safety rules:
 *   - a session directory is removed only when it contains the artifact recorded in the
 *     manifest and nothing else (a foreign file stops the delete);
 *   - a path is removed only when it lives under the roots derived from the manifest;
 *   - `--dry-run` prints the plan without deleting anything.
 *
 * Usage:
 *   node rollback.mjs [manifest.json] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const manifestFile = path.resolve(argv.find((value) => !value.startsWith('--')) ?? 'zcode-migration-manifest.json');

if (!fs.existsSync(manifestFile)) {
  console.error(`manifest not found: ${manifestFile}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (!Array.isArray(manifest.sessions) || manifest.sessions.length === 0) {
  console.error(`manifest ${manifestFile} records no sessions; nothing to roll back`);
  process.exit(2);
}

const first = manifest.sessions[0];
// <root>/<projectKey>/<sessionDir>/<artifact>  ->  <root>
const sessionsRoot = path.resolve(path.dirname(path.dirname(path.dirname(first.artifactPath))));
// <root>/session_projcache/sessions/<id>.json  ->  <root>
const storagesRoot = path.resolve(path.dirname(path.dirname(path.dirname(first.cachePath ?? path.join(path.dirname(manifestFile), 'storages', 'session_projcache', 'sessions', 'x.json')))));

/** Refuse any path outside the derived roots, so a corrupt manifest cannot delete elsewhere. */
function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to touch "${target}": outside the derived root "${root}"`);
  }
}

const removed = { sessionDirs: [], cacheFiles: [], blocked: [], missing: [] };

for (const entry of manifest.sessions) {
  const sessionDir = path.dirname(entry.artifactPath);
  if (!fs.existsSync(entry.artifactPath)) {
    removed.missing.push(entry.artifactPath);
  } else {
    const contents = fs.readdirSync(sessionDir);
    const expected = path.basename(entry.artifactPath);
    if (contents.length !== 1 || contents[0] !== expected) {
      removed.blocked.push({ sessionDir, contents });
      console.error(`! refusing to delete ${sessionDir}: unexpected contents (${contents.join(', ')})`);
    } else {
      assertInside(sessionsRoot, sessionDir);
      if (!dryRun) fs.rmSync(sessionDir, { recursive: true, force: true });
      removed.sessionDirs.push(sessionDir);
    }
  }

  if (entry.cachePath !== null && entry.cachePath !== undefined && fs.existsSync(entry.cachePath)) {
    assertInside(storagesRoot, entry.cachePath);
    if (!dryRun) fs.rmSync(entry.cachePath, { force: true });
    removed.cacheFiles.push(entry.cachePath);
  }
}

if (!dryRun) fs.renameSync(manifestFile, `${manifestFile}.rolled-back`);

console.log(`rollback ${dryRun ? '(dry run)' : ''}`);
console.log(`  session dirs removed : ${removed.sessionDirs.length}`);
console.log(`  cache docs removed   : ${removed.cacheFiles.length}`);
console.log(`  already absent       : ${removed.missing.length}`);
console.log(`  blocked (untouched)  : ${removed.blocked.length}`);
for (const dir of removed.sessionDirs) console.log(`  - ${dir}`);
if (!dryRun) console.log(`\nmanifest archived as ${manifestFile}.rolled-back`);
console.log('\nRestart or refresh DSH to drop the removed sessions from the sidebar.');

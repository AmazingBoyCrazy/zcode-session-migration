#!/usr/bin/env node
/**
 * Post-migration verification, entirely offline.
 *
 * Re-reads every artifact recorded in the manifest and re-runs the strictest logical
 * replay, then validates each seeded projection-cache document against DSH's own
 * exported schemas (`checkpointRecord`, `checkpointIdentity`) plus the installed
 * projection units' `stateSchema` for `title` and `sessionListMetadata`.
 *
 * This is the check that decides whether the sidebar can show real titles, because the
 * listing path reads a cold session's title exclusively from the projection cache and
 * accepts it only when the record's identity carries the exact format generation.
 *
 * Usage:
 *   node verify.mjs [manifest.json] [--home <DSH_HOME>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshHome, importDshSubpath, createDshRequire } from './lib/paths.mjs';
import { SESSION_FORMAT_VERSION, validateSessionArtifact } from './lib/dsh-format.mjs';

const argv = process.argv.slice(2);
const homeIndex = argv.indexOf('--home');
const home = resolveDshHome(homeIndex === -1 ? undefined : argv[homeIndex + 1]);
const positional = argv.filter((value, index) => !value.startsWith('--') && index !== homeIndex + 1);
const manifestFile = path.resolve(positional[0] ?? 'zcode-migration-manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

const cacheModule = await importDshSubpath(home, '@deepseek-ai/dsh-session-projection-cache', 'lib/index.js');
const titleModule = await importDshSubpath(home, '@deepseek-ai/dsh-session-title', 'lib/index.js');
const { checkpointRecord } = cacheModule;
const { titleProjectionDefinition } = titleModule;

// The list-metadata unit belongs to the API session controller and is not exported from
// a barrel, so its schema is replicated verbatim from that package's `types/list.js`.
const { z } = createDshRequire(home)('zod');
const sessionListMetadataSchema = z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() });

const results = { ok: [], failed: [], cacheMissing: [], cacheRejected: [], grown: [] };

for (const entry of manifest.sessions) {
  try {
    const buffer = fs.readFileSync(entry.artifactPath);
    const replay = await validateSessionArtifact(buffer, entry.zcodeId, home);
    // A migrated log may legitimately grow: once DSH opens the session it appends its own
    // events (seed markers, model selection) as further checksummed frames. Only a
    // shrink or a rewrite would mean the artifact is not the one this run wrote.
    if (replay.events < entry.events) {
      throw new Error(`artifact shrank: manifest ${entry.events} events, artifact ${replay.events}`);
    }
    if (replay.events > entry.events) {
      results.grown.push({ id: entry.zcodeId, from: entry.events, to: replay.events });
    }
  } catch (error) {
    results.failed.push({ id: entry.zcodeId, error: error.message });
    continue;
  }

  if (entry.cachePath === null) {
    results.cacheMissing.push({ id: entry.zcodeId, reason: 'no title event; listing falls back to the cwd basename' });
    continue;
  }
  if (!fs.existsSync(entry.cachePath)) {
    results.cacheMissing.push({ id: entry.zcodeId, reason: `cache document absent: ${entry.cachePath}` });
    continue;
  }

  try {
    const document = JSON.parse(fs.readFileSync(entry.cachePath, 'utf8'));
    const parsed = checkpointRecord.parse(document.record);
    if (parsed.identity.formatVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(`identity carries formatVersion ${parsed.identity.formatVersion}; listing needs ${SESSION_FORMAT_VERSION}`);
    }
    if (parsed.identity.isSeeded !== false || parsed.identity.inheritedEventCount !== 0) {
      throw new Error('identity lineage is not the unseeded lineage');
    }
    if (parsed.identity.cwd !== entry.cwd) throw new Error('identity cwd does not match the artifact header');

    const titleRow = parsed.rows.title;
    const metadataRow = parsed.rows.sessionListMetadata;
    if (titleRow === undefined || metadataRow === undefined) throw new Error('cache document lacks the title or sessionListMetadata row');
    if (titleRow.ver !== titleProjectionDefinition.stateVersion) {
      throw new Error(`title row ver ${titleRow.ver} != installed stateVersion ${titleProjectionDefinition.stateVersion}`);
    }
    titleProjectionDefinition.stateSchema.parse(titleRow.val);
    sessionListMetadataSchema.parse(metadataRow.val);
    results.ok.push({ id: entry.zcodeId, kind: entry.kind ?? 'interactive', title: titleRow.val });
  } catch (error) {
    results.cacheRejected.push({ id: entry.zcodeId, error: error.message });
  }
}

const byKind = {};
for (const entry of results.ok) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;

console.log(`manifest      : ${manifestFile}`);
console.log(`dsh home      : ${home}`);
console.log(`sessions      : ${manifest.sessions.length} (${Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'})`);
console.log(`replay ok     : ${results.ok.length}`);
console.log(`cache issues  : ${results.cacheMissing.length}`);
console.log(`cache rejected: ${results.cacheRejected.length}`);
console.log(`replay failed : ${results.failed.length}`);
if (results.grown.length > 0) {
  console.log(`grown by DSH  : ${results.grown.length} (DSH appended its own events; expected once a session is used)`);
}

if (results.ok.length > 0) {
  console.log('\nsample verified titles:');
  for (const entry of results.ok.slice(0, 8)) console.log(`  ${entry.title}  <- ${entry.kind}`);
}
for (const entry of results.cacheMissing) console.log(`  ~ ${entry.id}: ${entry.reason}`);
for (const entry of results.grown) console.log(`  ^ ${entry.id}: ${entry.from} -> ${entry.to} events`);
for (const entry of results.cacheRejected) console.log(`  ! ${entry.id}: ${entry.error}`);
for (const entry of results.failed) console.log(`  ! REPLAY ${entry.id}: ${entry.error}`);

process.exitCode = results.failed.length + results.cacheRejected.length > 0 ? 1 : 0;

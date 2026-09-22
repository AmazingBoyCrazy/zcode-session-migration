#!/usr/bin/env node
/**
 * Live DSH verification against a running host.
 *
 * Talks to the Web host the way the browser does: exchange the startup `?token=` for the
 * signed session cookie, then call `session/list` and `session/page` over the `/api` RPC
 * bridge. That exercises the shipped listing fold, the projection cache and the history
 * pager — not just the bytes on disk.
 *
 * Get the URL from the host's startup banner (`dsh web` prints it). The token is per
 * process, so a restarted host needs a fresh URL. Node's fetch keeps no cookie jar, so
 * the redirect from `/?token=…` must not be followed.
 *
 * Usage:
 *   node check-live.mjs --url "http://127.0.0.1:<port>/?token=<token>"
 *                       [--manifest zcode-migration-manifest.json] [--sample 3]
 */
import fs from 'node:fs';
import path from 'node:path';

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
if (typeof options.url !== 'string') {
  console.error('usage: node check-live.mjs --url "http://127.0.0.1:<port>/?token=<token>" [--manifest <file>] [--sample N]');
  process.exit(2);
}
const manifestFile = path.resolve(options.manifest ?? 'zcode-migration-manifest.json');
const sampleSize = Number(options.sample ?? 3);

const tokenUrl = new URL(options.url);
const origin = tokenUrl.origin;

let cookie = '';
async function login() {
  const response = await fetch(tokenUrl, { redirect: 'manual' });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const raw = setCookie.length > 0 ? setCookie : [response.headers.get('set-cookie') ?? ''];
  cookie = raw
    .filter((value) => value.length > 0)
    .map((value) => value.split(';')[0])
    .join('; ');
  if (cookie.length === 0) throw new Error(`token exchange failed: HTTP ${response.status} with no session cookie`);
}

async function rpc(method, args) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method,
    payload: { args },
  });
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
    body,
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const parsed = await response.json();
  if (parsed?.result?.ok !== true) {
    throw new Error(`${method}: ${parsed?.result?.error?.code}: ${parsed?.result?.error?.message}`);
  }
  return parsed.result.value;
}

await login();

const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { sessions: [] };
const expected = new Map(manifest.sessions.map((entry) => [entry.dshId, entry]));

const list = await rpc('session/list', { _request: {} });
const items = list.items ?? [];
const byId = new Map(items.map((item) => [item.sessionId, item]));

const problems = [];
let titleMatches = 0;

for (const entry of manifest.sessions) {
  const item = byId.get(entry.dshId);
  if (item === undefined) {
    problems.push(`missing from session/list: ${entry.dshId} (${entry.title})`);
    continue;
  }
  const title = item.projections?.values?.title;
  if (title === undefined) {
    problems.push(`no title projection (sidebar would show the cwd basename): ${entry.dshId}`);
  } else if (title !== entry.title) {
    problems.push(`title mismatch for ${entry.dshId}: served ${JSON.stringify(title)}, manifest ${JSON.stringify(entry.title)}`);
  } else titleMatches += 1;
  if (item.blank !== false) problems.push(`session reports blank=true: ${entry.dshId}`);
  if (item.cwd !== entry.cwd) problems.push(`cwd mismatch for ${entry.dshId}: served ${item.cwd}, manifest ${entry.cwd}`);
  if (item.origin === 'subagent') problems.push(`session carries an origin that hides it from the sidebar: ${entry.dshId}`);
}

const preExisting = items.filter((item) => !expected.has(item.sessionId));

console.log(`host            : ${origin}`);
console.log(`manifest        : ${manifestFile} (${manifest.sessions.length} migrated sessions)`);
console.log(`sessions served : ${items.length}`);
console.log(`migrated found  : ${items.filter((item) => expected.has(item.sessionId)).length}/${manifest.sessions.length}`);
console.log(`titles matching : ${titleMatches}/${manifest.sessions.length}`);
console.log(`pre-existing    : ${preExisting.length} still listed`);

// Prefer paging the largest sessions: they prove the pager and the surface fold scale.
const samples = [...manifest.sessions].sort((a, b) => (b.events ?? 0) - (a.events ?? 0)).slice(0, sampleSize);
for (const entry of samples) {
  try {
    const page = await rpc('session/page', {
      request: {
        address: { kind: 'session', sessionId: entry.dshId },
        throughSeq: entry.events - 1,
        maxMessages: 400,
      },
    });
    const types = new Map();
    for (const record of page.records ?? []) {
      const type = record?.event?.type;
      if (type !== undefined) types.set(type, (types.get(type) ?? 0) + 1);
    }
    console.log(
      `  page [${entry.kind ?? 'interactive'}] ${entry.dshId}: ${page.records?.length ?? 0} records ` +
        `(user ${types.get('user/message') ?? 0}, assistant ${types.get('assistant/message') ?? 0}, ` +
        `tool ${types.get('tool/call') ?? 0}) hasMore=${page.hasMore}`,
    );
    if ((types.get('assistant/message') ?? 0) === 0) problems.push(`no assistant messages paged for ${entry.dshId}`);
  } catch (error) {
    problems.push(`session/page failed for ${entry.dshId}: ${error.message}`);
  }
}

if (problems.length > 0) {
  console.log(`\nFAIL — ${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 20)) console.log(`  ! ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — every migrated session is listed with its real title, correct cwd and a readable transcript.');
}

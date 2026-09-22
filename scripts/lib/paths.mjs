/**
 * Locating DSH on this machine, without hardcoding any installation path.
 *
 * Everything here is derived from the environment:
 *   - `DSH_HOME` (or `~/.dsh`) gives the state root that holds `sessions/`,
 *     `storages/` and `profiles/`;
 *   - the shipped DSH packages are resolved through `<DSH_HOME>/profiles`, whose
 *     `node_modules` the DSH installer populates (on Windows with junctions into the
 *     application checkout). Node's normal resolution therefore works, and the
 *     application directory never has to be named;
 *   - `DSH_APP_ROOT` is honoured only as an explicit override for layouts that do not
 *     expose the packages under the profile root.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default DSH state root: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(explicit) {
  const value = explicit ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.resolve(value);
}

/** Default ZCode CLI database: `~/.zcode/cli/db/db.sqlite`. */
export function resolveZcodeDb(explicit) {
  const value = explicit ?? process.env.ZCODE_DB ?? path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  return path.resolve(value);
}

/** The directory whose `node_modules` the shipped DSH packages resolve from. */
function packageAnchor(home) {
  const profileRoot = path.join(home, 'profiles');
  return path.join(profileRoot, 'package.json');
}

/**
 * A `require` bound to the DSH profile root, so `require.resolve()` finds the exact
 * package copies this DSH build is running.
 * @param {string} home - resolved DSH home.
 */
export function createDshRequire(home) {
  const anchor = packageAnchor(home);
  if (fs.existsSync(path.dirname(anchor))) return createRequire(anchor);
  const appRoot = process.env.DSH_APP_ROOT;
  if (appRoot !== undefined && appRoot.length > 0) {
    return createRequire(path.join(path.resolve(appRoot), 'package.json'));
  }
  throw new Error(
    `cannot locate the DSH packages: "${path.dirname(anchor)}" does not exist.\n` +
      `Set DSH_HOME to your DSH state root, or set DSH_APP_ROOT to the DSH application directory.`,
  );
}

/** Resolve a DSH package entry point to an absolute path. */
export function resolveDshModule(home, specifier) {
  return createDshRequire(home).resolve(specifier);
}

/** Import a DSH package's ESM entry point from the resolved install. */
export async function importDshModule(home, specifier) {
  return import(pathToFileURL(resolveDshModule(home, specifier)).href);
}

/** Import a DSH package's subpath (e.g. `pkg/lib/types/spec.js`), not just its entry. */
export async function importDshSubpath(home, packageName, relativePath) {
  const require = createDshRequire(home);
  const manifest = require.resolve(`${packageName}/package.json`);
  const file = path.join(path.dirname(manifest), relativePath);
  if (!fs.existsSync(file)) throw new Error(`${packageName}/${relativePath} not found at ${file}`);
  return import(pathToFileURL(file).href);
}

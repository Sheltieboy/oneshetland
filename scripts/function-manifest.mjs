#!/usr/bin/env node
/**
 * function-manifest.mjs — the record of what each deployed Edge Function actually bundles.
 *
 *   generate --bundles <dir> --list <functions.json>   build supabase/production/edge-function-manifest.json from READ-ONLY downloads
 *       <dir>/<name>/supabase/functions/...   one `supabase functions download <name> --use-api` per function (see docs/EDGE-FUNCTION-DEPLOYMENT.md)
 *       <functions.json>                      the output of `supabase functions list -o json` (slug, version, verify_jwt)
 *   verify                                    offline: does the manifest still describe this source tree? (also run by the test suite)
 *
 * The manifest holds names, versions, verify_jwt flags and file hashes only — no secrets and no environment values.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, bundleHashes } from './lib/function-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = join(ROOT, 'supabase/functions');
const MANIFEST_PATH = join(ROOT, 'supabase/production/edge-function-manifest.json');
const PROJECT_REF = 'nkrtmakxygkvxuxriiil';

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Hashes of every file in one downloaded bundle, keyed by path relative to supabase/functions. */
export function downloadedBundle(bundlesDir, fn) {
  const root = join(bundlesDir, fn, 'supabase/functions');
  const out = {};
  for (const f of walk(root)) out[relative(root, f).split(/[\\/]/).join('/')] = sha256(readFileSync(f));
  return out;
}

/** Declared drift = files whose production hash differs from the canonical source (or that exist on only one side). */
export function sharedDrift(prodFiles, sourceFiles) {
  const paths = new Set([...Object.keys(prodFiles), ...Object.keys(sourceFiles)]);
  return [...paths].filter((p) => prodFiles[p] !== sourceFiles[p]).sort();
}

export function buildManifest(list, bundlesDir) {
  const functions = {};
  for (const f of [...list].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const files = downloadedBundle(bundlesDir, f.slug);
    const source = bundleHashes(FUNCTIONS_DIR, f.slug);
    const drift = sharedDrift(files, source);
    const idx = `${f.slug}/index.ts`;
    const ownDrift = drift.filter((p) => p.startsWith(`${f.slug}/`));
    if (ownDrift.length) throw new Error(`${f.slug}: the function's own files differ from production (${ownDrift.join(', ')}) — the source tree must represent production first`);
    functions[f.slug] = {
      version: f.version, verify_jwt: !!f.verify_jwt,
      classification: drift.length ? 'intentional-shared-drift' : 'canonical-current',
      index_sha256: files[idx], files, shared_drift: drift,
    };
  }
  const all = Object.values(functions);
  return {
    schema: 1, project_ref: PROJECT_REF, captured_on: '2026-10-08',
    captured_by: 'read-only `supabase functions list` + `supabase functions download <name> --use-api` for every function',
    summary: {
      functions: all.length, canonical_current: all.filter((x) => x.classification === 'canonical-current').length,
      intentional_shared_drift: all.filter((x) => x.classification === 'intentional-shared-drift').length,
      verify_jwt_true: all.filter((x) => x.verify_jwt).length, verify_jwt_false: all.filter((x) => !x.verify_jwt).length,
    },
    functions,
  };
}

/** Problems between a manifest and the source tree; empty = consistent. */
export function verifyManifest(manifest, functionsDir = FUNCTIONS_DIR) {
  const problems = [];
  const dirs = readdirSync(functionsDir).filter((n) => !n.startsWith('_') && statSync(join(functionsDir, n)).isDirectory() && existsSync(join(functionsDir, n, 'index.ts')));
  for (const d of dirs) if (!manifest.functions[d]) problems.push(`${d}: has source but is not in the manifest`);
  for (const n of Object.keys(manifest.functions)) {
    if (!dirs.includes(n)) { problems.push(`${n}: in the manifest but has no source directory`); continue; }
    const m = manifest.functions[n]; let src;
    try { src = bundleHashes(functionsDir, n); } catch (e) { problems.push(`${n}: ${e.message}`); continue; }
    // A shared file that production's older copy did not import (or no longer imports) is simply part of the declared drift below.
    if (src[`${n}/index.ts`] !== m.index_sha256) problems.push(`${n}: index.ts differs from the production bundle`);
    const declared = [...m.shared_drift].sort().join(','); const actual = sharedDrift(m.files, src).join(',');
    if (declared !== actual) problems.push(`${n}: declared shared drift [${declared}] != actual [${actual}] — update the manifest only after a reviewed deploy`);
    if ((m.classification === 'canonical-current') !== (actual === '')) problems.push(`${n}: classification ${m.classification} does not match the drift`);
  }
  return problems;
}

function main(argv) {
  const [cmd, ...rest] = argv.slice(2); const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'generate') {
    const bundles = opt('--bundles'), list = opt('--list');
    if (!bundles || !list) { console.error('usage: generate --bundles <dir> --list <functions.json>'); return 1; }
    const raw = JSON.parse(readFileSync(list, 'utf8')); const fns = Array.isArray(raw) ? raw : raw.functions;
    const m = buildManifest(fns, bundles);
    writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
    console.log(JSON.stringify(m.summary)); return 0;
  }
  if (cmd === 'verify') {
    const problems = verifyManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
    if (problems.length) { console.error(problems.join('\n')); return 1; }
    console.log('manifest consistent with source'); return 0;
  }
  console.error('usage: function-manifest.mjs generate|verify'); return 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv));

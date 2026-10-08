#!/usr/bin/env node
/**
 * check-function-deploy.mjs — run BEFORE `supabase functions deploy <name>`.
 *
 * Production runs each Edge Function from the bundle it was last deployed with, and those bundles do not all contain the same copy of
 * supabase/functions/_shared/*. Deploying a function re-bundles the CURRENT source, so it can silently pull newer shared helpers into a
 * function that production has been running on older ones. This compares what the function would deploy now against the production
 * manifest (supabase/production/edge-function-manifest.json) and makes every difference explicit.
 *
 *   node scripts/check-function-deploy.mjs <function> [--ack <shared-file>,<shared-file>] [--json]
 *
 * Exit 0  — nothing changes except the function's own files, or every changed/added/removed SHARED file is named in --ack.
 * Exit 2  — shared files would change and were not (exactly) acknowledged. Read the list, review each file's diff, then re-run with --ack.
 * Exit 1  — usage or environment problem (unknown function, missing manifest, verify_jwt in config.toml disagrees with production).
 *
 * Read-only: touches no network and no production. After a reviewed deploy, regenerate the manifest (docs/EDGE-FUNCTION-DEPLOYMENT.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleHashes } from './lib/function-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FUNCTIONS_DIR = join(ROOT, 'supabase/functions');
export const MANIFEST_PATH = join(ROOT, 'supabase/production/edge-function-manifest.json');

/** Pure comparison: what would change in production's bundle if `source` were deployed. */
export function compareBundle(prodFiles, sourceFiles, fnName) {
  const own = (p) => p.startsWith(`${fnName}/`);
  const changed = [], added = [], removed = [], ownChanged = [], ownAdded = [], ownRemoved = [];
  for (const [p, h] of Object.entries(sourceFiles)) {
    if (!(p in prodFiles)) (own(p) ? ownAdded : added).push(p);
    else if (prodFiles[p] !== h) (own(p) ? ownChanged : changed).push(p);
  }
  for (const p of Object.keys(prodFiles)) if (!(p in sourceFiles)) (own(p) ? ownRemoved : removed).push(p);
  const shared = [...changed, ...added, ...removed].sort();
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), ownChanged, ownAdded, ownRemoved, shared };
}

/** Pure verdict. `ack` is the list given to --ack. */
export function verdict(cmp, ack) {
  const need = new Set(cmp.shared), given = new Set(ack);
  const unacked = cmp.shared.filter((p) => !given.has(p));
  const stale = ack.filter((p) => !need.has(p));
  return { ok: unacked.length === 0 && stale.length === 0, unacked, stale };
}

function configVerifyJwt(fnName) {
  const t = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
  const m = t.match(new RegExp(`\\[functions\\.${fnName.replace(/[-]/g, '\\-')}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!m) return true;
  const v = m[1].match(/verify_jwt\s*=\s*(true|false)/);
  return v ? v[1] === 'true' : true;
}

function main(argv) {
  const args = argv.slice(2); const fn = args.find((a) => !a.startsWith('--'));
  const ackIdx = args.indexOf('--ack'); const ack = ackIdx >= 0 ? (args[ackIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  const asJson = args.includes('--json');
  if (!fn) { console.error('usage: check-function-deploy.mjs <function> [--ack file,file] [--json]'); return 1; }
  if (!existsSync(MANIFEST_PATH)) { console.error('supabase/production/edge-function-manifest.json is missing'); return 1; }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const prod = manifest.functions[fn];
  if (!prod) { console.error(`${fn} is not in the production manifest — a NEW function, or the manifest is stale.`); return 1; }
  const src = bundleHashes(FUNCTIONS_DIR, fn);
  const cmp = compareBundle(prod.files, src, fn);
  const v = verdict(cmp, ack);
  const jwt = configVerifyJwt(fn);
  const jwtOk = jwt === prod.verify_jwt;
  if (asJson) console.log(JSON.stringify({ function: fn, production_version: prod.version, verify_jwt: { production: prod.verify_jwt, config_toml: jwt }, ...cmp, ...v }, null, 2));
  else {
    console.log(`${fn}  (production v${prod.version}, classification: ${prod.classification})`);
    console.log(`  verify_jwt: production=${prod.verify_jwt}  config.toml=${jwt}  ${jwtOk ? 'ok' : 'MISMATCH — deploying would change it'}`);
    console.log(`  own files (the change you intend): ${[...cmp.ownChanged.map((p) => `changed ${p}`), ...cmp.ownAdded.map((p) => `added ${p}`), ...cmp.ownRemoved.map((p) => `removed ${p}`)].join(', ') || 'none — identical to production'}`);
    if (!cmp.shared.length) console.log('  shared files: identical to the production bundle');
    for (const p of cmp.changed) console.log(`  SHARED CHANGES  ${p}  (production ${prod.files[p].slice(0, 8)} -> source ${src[p].slice(0, 8)})`);
    for (const p of cmp.added) console.log(`  SHARED ADDED    ${p}  (not in the production bundle)`);
    for (const p of cmp.removed) console.log(`  SHARED REMOVED  ${p}  (in the production bundle, no longer imported)`);
    if (v.stale.length) console.log(`  --ack names files that are not changing: ${v.stale.join(', ')}`);
    if (!v.ok) console.log(`\nNOT ACKNOWLEDGED. Review the diff of each shared file above, then re-run with:\n  --ack ${cmp.shared.join(',')}`);
  }
  if (!jwtOk) return 1;
  return v.ok ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv));

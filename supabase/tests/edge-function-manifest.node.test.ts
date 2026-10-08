/**
 * edge-function-manifest.node.test.ts — the repository and the production Edge Function manifest must describe the same thing.
 *
 * supabase/production/edge-function-manifest.json records, for every deployed function, its version, verify_jwt and the hash of every
 * file in the bundle production runs. This proves, offline and without touching production, that: every function has source and a
 * manifest entry; each function's own index.ts IS what production runs; config.toml carries the live verify_jwt split; and any shared
 * file whose source differs from production's bundle is DECLARED (intentional-shared-drift) rather than silent.
 *
 * After a reviewed deploy, regenerate the manifest (docs/EDGE-FUNCTION-DEPLOYMENT.md). Editing a function or a shared helper without doing
 * so makes this fail — that is the point.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from '../../scripts/function-manifest.mjs';
import { sha256 } from '../../scripts/lib/function-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = join(ROOT, 'supabase/functions');
const manifest = JSON.parse(readFileSync(join(ROOT, 'supabase/production/edge-function-manifest.json'), 'utf8'));
const dirs = readdirSync(FN).filter((n) => !n.startsWith('_') && statSync(join(FN, n)).isDirectory());

describe('production Edge Function manifest', () => {
  test('describes exactly the 100 deployed functions, each with source', () => {
    assert.equal(Object.keys(manifest.functions).length, 100);
    assert.deepEqual(Object.keys(manifest.functions).sort(), dirs.sort());
    assert.equal(manifest.summary.functions, 100);
  });

  test('is consistent with the source tree (index.ts exact; shared drift declared, not silent)', () => {
    assert.deepEqual(verifyManifest(manifest, FN), []);
  });

  test('every function directory carries index.ts exactly as production runs it', () => {
    for (const [n, m] of Object.entries(manifest.functions) as [string, any][]) {
      assert.equal(sha256(readFileSync(join(FN, n, 'index.ts'))), m.index_sha256, `${n}/index.ts differs from the production bundle`);
      assert.equal(m.files[`${n}/index.ts`], m.index_sha256);
    }
  });

  test('config.toml carries the live verify_jwt split (88 true / 12 false) function by function', () => {
    const toml = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
    const declared = new Map<string, boolean>();
    for (const m of toml.matchAll(/\[functions\.([\w-]+)\]([\s\S]*?)(?=\n\[|$)/g)) {
      const v = m[2].match(/verify_jwt\s*=\s*(true|false)/); if (v) declared.set(m[1], v[1] === 'true');
    }
    let t = 0, f = 0;
    for (const [n, m] of Object.entries(manifest.functions) as [string, any][]) {
      assert.equal(declared.get(n) ?? true, m.verify_jwt, `${n}: config.toml and production disagree about verify_jwt`);
      m.verify_jwt ? t++ : f++;
    }
    assert.deepEqual([t, f], [88, 12]);
    assert.deepEqual(manifest.summary, { functions: 100, canonical_current: manifest.summary.canonical_current, intentional_shared_drift: manifest.summary.intentional_shared_drift, verify_jwt_true: 88, verify_jwt_false: 12 });
  });

  test('every classification is honest: canonical-current means NO drift; intentional-shared-drift lists only _shared files', () => {
    let drift = 0;
    for (const [n, m] of Object.entries(manifest.functions) as [string, any][]) {
      if (m.classification === 'canonical-current') assert.deepEqual(m.shared_drift, [], n);
      else { drift++; assert.ok(m.shared_drift.length > 0, n); for (const p of m.shared_drift) assert.match(p, /^_shared\//, `${n}: drift outside _shared: ${p}`); }
    }
    assert.equal(drift, manifest.summary.intentional_shared_drift);
  });

  test('the two functions that had no git source before reconciliation are captured exactly as deployed', () => {
    for (const n of ['wallet-checkout', 'local-billing-portal']) {
      assert.equal(sha256(readFileSync(join(FN, n, 'index.ts'))), manifest.functions[n].index_sha256, n);
    }
  });

  test('the manifest holds names, versions, flags and hashes only — no secrets or environment values', () => {
    assert.doesNotMatch(JSON.stringify(manifest), /sk_(live|test)_|whsec_|rk_(live|test)_|eyJ[A-Za-z0-9_-]{20,}/);
    for (const m of Object.values(manifest.functions) as any[]) {
      assert.deepEqual(Object.keys(m).sort(), ['classification', 'files', 'index_sha256', 'shared_drift', 'verify_jwt', 'version']);
      for (const h of Object.values(m.files)) assert.match(h as string, /^[0-9a-f]{64}$/);
    }
  });
});

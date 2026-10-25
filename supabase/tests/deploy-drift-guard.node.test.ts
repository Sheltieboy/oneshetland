/**
 * deploy-drift-guard.node.test.ts — scripts/check-function-deploy.mjs makes shared-file drift explicit before a deploy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBundle, verdict } from '../../scripts/check-function-deploy.mjs';
import { bundleFiles, bundleHashes, relativeImports, sha256 } from '../../scripts/lib/function-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts/check-function-deploy.mjs'), ...args], { encoding: 'utf8' });

describe('import closure', () => {
  test('follows static, multi-line, re-export and dynamic relative imports; ignores URLs, npm: and comments', () => {
    const src = `import a from './a.ts';\nimport {\n  b,\n} from '../_shared/b.ts';\nexport * from './c.ts';\nimport x from 'https://esm.sh/x';\nimport y from 'npm:y';\n// import z from './z.ts'\n/* import w from './w.ts' */\nconst d = await import('./d.ts');`;
    assert.deepEqual(relativeImports(src).sort(), ['../_shared/b.ts', './a.ts', './c.ts', './d.ts']);
  });
  test('resolves a real bundle and refuses an import that does not exist', () => {
    const d = mkdtempSync(join(tmpdir(), 'fdeps-'));
    try {
      mkdirSync(join(d, 'f')); mkdirSync(join(d, '_shared'));
      writeFileSync(join(d, 'f/index.ts'), `import { a } from '../_shared/a.ts';`);
      writeFileSync(join(d, '_shared/a.ts'), `import { b } from './b.ts';`);
      writeFileSync(join(d, '_shared/b.ts'), `export const b = 1;`);
      writeFileSync(join(d, '_shared/unused.ts'), `export const u = 1;`);
      assert.deepEqual(bundleFiles(d, 'f'), ['_shared/a.ts', '_shared/b.ts', 'f/index.ts']);
      writeFileSync(join(d, '_shared/b.ts'), `import './gone.ts';`);
      assert.throws(() => bundleFiles(d, 'f'), /gone\.ts/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('comparison and verdict', () => {
  const prod = { 'f/index.ts': 'a', '_shared/x.ts': '1', '_shared/old.ts': '9' };
  test('identical bundle: nothing to acknowledge', () => {
    const c = compareBundle(prod, { ...prod }, 'f'); assert.deepEqual(c.shared, []); assert.equal(verdict(c, []).ok, true);
  });
  test('a changed own file is the intended change and needs no acknowledgement', () => {
    const c = compareBundle(prod, { ...prod, 'f/index.ts': 'b' }, 'f'); assert.deepEqual(c.ownChanged, ['f/index.ts']); assert.equal(verdict(c, []).ok, true);
  });
  test('changed, added and removed shared files are all listed and all must be acknowledged', () => {
    const src = { 'f/index.ts': 'a', '_shared/x.ts': '2', '_shared/new.ts': '3' };
    const c = compareBundle(prod, src, 'f');
    assert.deepEqual(c.shared, ['_shared/new.ts', '_shared/old.ts', '_shared/x.ts']);
    assert.equal(verdict(c, []).ok, false);
    assert.equal(verdict(c, ['_shared/x.ts']).ok, false);
    assert.equal(verdict(c, ['_shared/new.ts', '_shared/old.ts', '_shared/x.ts']).ok, true);
  });
  test('a stale acknowledgement (a file that is not changing) is refused', () => {
    const c = compareBundle(prod, { ...prod }, 'f'); const v = verdict(c, ['_shared/x.ts']);
    assert.equal(v.ok, false); assert.deepEqual(v.stale, ['_shared/x.ts']);
  });
});

describe('the command against the real repository', () => {
  test('a function that matches production exactly passes (exit 0)', () => {
    const r = run('delete-account'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /identical to the production bundle/);
  });
  test('a function whose bundle would pull in newer shared helpers is stopped (exit 2) and names them', () => {
    const r = run('notify-event-update'); assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /SHARED CHANGES\s+_shared\/rate-limit\.ts/); assert.match(r.stdout, /--ack _shared\/rate-limit\.ts/);
  });
  test('acknowledging exactly the listed files lets it through; acknowledging a different file does not', () => {
    assert.equal(run('notify-event-update', '--ack', '_shared/rate-limit.ts').status, 0);
    assert.equal(run('notify-event-update', '--ack', '_shared/rate-limit.ts,_shared/send-push.ts').status, 2);
    assert.equal(run('notify-event-update', '--ack', '_shared/send-push.ts').status, 2);
  });
  test('an added shared dependency (not in production\'s bundle) is reported', () => {
    const r = run('create-product-order-intent', '--json'); assert.equal(r.status, 2);
    const j = JSON.parse(r.stdout); assert.ok(j.added.includes('_shared/ticket-payment-binding.ts')); assert.ok(j.changed.includes('_shared/fulfilment.ts'));
  });
  test('an unknown function is a usage error (exit 1), never a pass', () => {
    assert.equal(run('no-such-function').status, 1); assert.equal(run().status, 1);
  });
  test('hashes are sha256 of the exact bytes', () => {
    assert.equal(sha256(Buffer.from('x')), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
    assert.equal(Object.keys(bundleHashes(join(ROOT, 'supabase/functions'), 'delete-account')).length, 1);
  });
});

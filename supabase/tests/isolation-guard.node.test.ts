/** isolation-guard.node.test.ts — the fail-closed guards themselves. Offline: makes no request and reads no credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertIsolatedUrl, assertNoProductionEnv, assertNotLinked } from './_support/isolation.ts';

test('only loopback URLs are accepted; production, hosted Supabase and the live site are refused', () => {
  for (const ok of ['http://127.0.0.1:54800', 'http://localhost:3011', 'http://[::1]:3000']) assertIsolatedUrl('x', ok);
  for (const bad of ['https://nkrtmakxygkvxuxriiil.supabase.co', 'https://oneshetland.com', 'https://abc.supabase.co/rest/v1', 'http://example.org', 'http://127.0.0.1.evil.example', 'not a url', 'http://localhost.oneshetland.com'])
    assert.throws(() => assertIsolatedUrl('x', bad), /ISOLATION/, bad);
});
test('an environment value naming production is refused; unrelated values are ignored', () => {
  assert.throws(() => assertNoProductionEnv({ EXPO_PUBLIC_SUPABASE_URL: 'https://nkrtmakxygkvxuxriiil.supabase.co' }), /ISOLATION/);
  assert.throws(() => assertNoProductionEnv({ SITE_URL: 'https://oneshetland.com' }), /ISOLATION/);
  assertNoProductionEnv({ HOME: '/Users/x', ACCEPT_URL: 'http://127.0.0.1:54800', NOTE: 'oneshetland.com is the live site' });
});
test('a checkout linked to a hosted project is refused', () => {
  const d = mkdtempSync(join(tmpdir(), 'iso-')); mkdirSync(join(d, 'supabase/.temp'), { recursive: true });
  assertNotLinked(d); writeFileSync(join(d, 'supabase/.temp/project-ref'), 'abc');
  assert.throws(() => assertNotLinked(d), /linked/);
});
test('THIS checkout is not linked, and the acceptance client and the isolated runner use the guards', () => {
  const root = join(import.meta.dirname, '..', '..');
  assert.ok(!existsSync(join(root, 'supabase/.temp/project-ref')) && !existsSync(join(root, 'supabase/.temp/linked-project.json')));
  assert.match(readFileSync(join(root, 'supabase/tests/api/_accept-client.ts'), 'utf8'), /assertIsolated\(\{ ACCEPT_URL: URL_ \}\)/);
  assert.match(readFileSync(join(root, 'scripts/isolated-pg.mjs'), 'utf8'), /refusing to run/);
});

/**
 * test-safety.node.test.ts — the test guard itself (Fetch v2, Step 13).
 *
 * WHAT WAS WRONG
 * In Step 12 an "offline" run of the app suites queried the production database: every worktree carries the tracked
 * supabase/.temp/project-ref, 86 suites shell out to `supabase db query --linked`, and nothing in the test setup said no. The README even
 * promised that `npm test` talked to production, just carefully.
 *
 * WHAT IS ASSERTED
 *   · production is positively identified (project, database, pooler login; live Stripe keys; push, Google, the website)
 *   · the guard refuses a production-pointing environment at start-up, before any test runs
 *   · it refuses sockets, fetches and child processes that would reach a live service — before they connect or start
 *   · it re-arms itself in children that were given an environment without it
 *   · the opt-in read-only lane allows only a plain read, and Postgres is told to make the session read-only besides
 *   · the lane environment is built from an allow-list, so a dirty shell hands a test nothing
 *
 * SAFETY
 * Uses a FAKE production ref (zzfakeprodrefzz) and stand-in programs (/usr/bin/false, /bin/echo) everywhere a real call would go, so even
 * a broken guard could not reach anything: the fake hosts do not exist and the stand-ins do nothing.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childProcessRisk, isLocalHost, isProductionHost, liveCredential, liveService, productionFindings, sqlWriteReason } from '../../scripts/test-safety/production.mjs';
import { cleanEnv, GUARD } from '../../scripts/test-safety/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = 'zzfakeprodrefzz';

/** Run a snippet in a fresh node with the guard, a fake production ref and a chosen lane. */
function guarded(code: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const file = join(dir, 'probe.mjs'), log = join(dir, 'blocked.tsv');
  writeFileSync(file, code); writeFileSync(log, '');
  const r = spawnSync(process.execPath, [`--import=${GUARD}`, file], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ONESHETLAND_EXTRA_PRODUCTION_REFS: FAKE, ONESHETLAND_TEST_LANE: 'offline', ONESHETLAND_TEST_BLOCK_LOG: log, ...env },
  });
  const blocked = readFileSync(log, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout, err: r.stderr, blocked };
}

describe('production is identified positively', () => {
  test('the live project by its ref: API, database and pooler login', () => {
    assert.ok(isProductionHost('nkrtmakxygkvxuxriiil.supabase.co'));
    assert.ok(isProductionHost('db.nkrtmakxygkvxuxriiil.supabase.co'));
    assert.equal(liveService('aws-1-eu-west-2.pooler.supabase.com'), 'Supabase (hosted)');
    assert.ok(productionFindings({ DATABASE_URL: 'postgresql://postgres.nkrtmakxygkvxuxriiil@aws-1-eu-west-2.pooler.supabase.com:5432/postgres' }).length > 0);
    assert.match(readFileSync(join(ROOT, 'supabase/.temp/project-ref'), 'utf8'), /nkrtmakxygkvxuxriiil/, 'the tracked link this guard exists for');
  });
  test('the other live services', () => {
    for (const [h, name] of [['api.stripe.com', 'Stripe'], ['exp.host', 'Expo (push / updates)'], ['maps.googleapis.com', 'Google APIs'], ['oneshetland.com', 'the live OneShetland website']])
      assert.equal(liveService(h), name, h);
    assert.equal(liveCredential('sk_live_abcdefghijkl'), 'a live Stripe secret key');
    assert.equal(liveCredential('pk_live_abcdefghijkl'), 'a live Stripe publishable key');
    assert.equal(liveCredential('sk_test_abcdefghijkl'), null, 'test keys are fine');
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.ok(isLocalHost(h), h);
    assert.ok(!isLocalHost('example.com'));
  });
  test('child processes that reach or change the linked project, a live database or a live host', () => {
    for (const [cmd, args] of [['npx', ['supabase', 'db', 'query', '--linked', 'select 1']], ['supabase', ['db', 'push']], ['supabase', ['functions', 'deploy', 'x']],
      ['supabase', ['link', '--project-ref', 'x']], ['supabase', ['secrets', 'list']], ['psql', ['-h', 'db.nkrtmakxygkvxuxriiil.supabase.co']],
      ['curl', ['https://api.stripe.com/v1/charges']], ['eas', ['update', '--channel', 'production']], ['bash', ['-c', 'supabase db query --linked "select 1"']]] as const)
      assert.ok(childProcessRisk(cmd, [...args]), `${cmd} ${args.join(' ')}`);
    for (const [cmd, args] of [['supabase', ['db', 'query', 'select 1']], ['psql', ['postgresql://proof@/proof?host=/tmp/x']], ['git', ['status']], ['node', ['-e', '1']]] as const)
      assert.equal(childProcessRisk(cmd, [...args]), null, `${cmd} ${args.join(' ')} is local`);
  });
  test('only a plain read passes the read-only lane\'s SQL check', () => {
    assert.equal(sqlWriteReason('select 1 as _guard where false;\nselect count(*) from public.profiles'), null);
    for (const sql of ['insert into t values (1)', 'begin; update t set a=1; rollback;', 'delete from t', 'create or replace function f()', 'set default_transaction_read_only = off', 'do $$ begin end $$', 'grant select on t to anon'])
      assert.ok(sqlWriteReason(sql), sql);
  });
});

describe('the guard refuses before anything connects', () => {
  test('a production-pointing environment stops the process at start-up', () => {
    const r = guarded('console.log("RAN")', { EXPO_PUBLIC_SUPABASE_URL: `https://${FAKE}.supabase.co` });
    assert.equal(r.status, 78); assert.ok(!r.out.includes('RAN')); assert.match(r.err, /REFUSING TO RUN/);
    assert.ok(!r.err.includes(FAKE), 'values are never echoed');
    const k = guarded('console.log("RAN")', { STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop' });
    assert.equal(k.status, 78);
  });
  test('fetch, raw sockets and the linked CLI are refused, and each refusal is logged', () => {
    const r = guarded(`
      import { execFileSync, spawnSync } from 'node:child_process';
      import https from 'node:https';
      const out = [];
      try { await fetch('https://${FAKE}.supabase.co/rest/v1/profiles'); out.push('fetch:through'); } catch (e) { out.push('fetch:' + e.code); }
      try { https.get('https://${FAKE}.supabase.co/'); out.push('https:through'); } catch (e) { out.push('https:' + e.code); }
      try { await fetch('https://api.stripe.com/v1/charges', { method: 'POST' }); out.push('stripe:through'); } catch (e) { out.push('stripe:' + e.code); }
      try { execFileSync('/usr/bin/false', ['supabase', 'db', 'query', '--linked', 'select 1']); out.push('cli:through'); } catch (e) { out.push('cli:' + e.code); }
      try { spawnSync('/usr/bin/false', ['psql', '-h', 'db.${FAKE}.supabase.co']); out.push('psql:through'); } catch (e) { out.push('psql:' + e.code); }
      console.log(out.join(' '));`);
    assert.equal(r.out.trim(), 'fetch:ONESHETLAND_TEST_GUARD https:ONESHETLAND_TEST_GUARD stripe:ONESHETLAND_TEST_GUARD cli:ONESHETLAND_TEST_GUARD psql:ONESHETLAND_TEST_GUARD');
    assert.equal(r.blocked.trim().split('\n').length, 5);
    assert.match(r.blocked, /Supabase CLI against the linked\/remote project/);
  });
  test('localhost still works (the isolated lane and local servers)', () => {
    const r = guarded(`
      import net from 'node:net';
      const srv = net.createServer((s) => s.end('ok')).listen(0, '127.0.0.1', () => {
        const c = net.connect(srv.address().port, '127.0.0.1'); c.on('data', (d) => { console.log('local:' + d); c.destroy(); srv.close(); });
      });`);
    assert.equal(r.out.trim(), 'local:ok'); assert.equal(r.blocked, '');
  });
  test('a child given an environment without the guard is guarded anyway', () => {
    const r = guarded(`
      import { spawnSync } from 'node:child_process';
      const c = spawnSync(process.execPath, ['-e', "fetch('https://${FAKE}.supabase.co/').then(()=>console.log('through'),(e)=>console.log('child:'+e.code))"],
        { encoding: 'utf8', env: { PATH: process.env.PATH, ONESHETLAND_EXTRA_PRODUCTION_REFS: '${FAKE}' } });
      console.log(c.stdout.trim());`);
    assert.equal(r.out.trim(), 'child:ONESHETLAND_TEST_GUARD');
  });
});

describe('the opt-in read-only lane', () => {
  const RO = { ONESHETLAND_TEST_LANE: 'production-readonly', ONESHETLAND_PRODUCTION_READONLY: 'yes-read-only-production' };
  test('a plain read is allowed and the session is forced read-only', () => {
    // /bin/echo stands in for the CLI: it prints the arguments the guard let through.
    const r = guarded(`import { execFileSync } from 'node:child_process';
      console.log(execFileSync('/bin/echo', ['supabase', 'db', 'query', '--linked', 'select 1', '--output-format', 'json'], { encoding: 'utf8' }).trim());`, RO);
    assert.match(r.out, /--linked set default_transaction_read_only = on;\nselect 1 --output-format json/);
  });
  test('writes, rolled-back transactions and other remote CLI actions stay refused', () => {
    const r = guarded(`import { execFileSync } from 'node:child_process';
      const out = [];
      for (const args of [['supabase','db','query','--linked','begin; insert into t values (1); rollback;'], ['supabase','db','push'], ['supabase','functions','deploy','x']]) {
        try { execFileSync('/usr/bin/false', args); out.push('through'); } catch (e) { out.push(e.code); }
      }
      try { await fetch('https://${FAKE}.supabase.co/rest/v1/rpc/f', { method: 'POST' }); out.push('through'); } catch (e) { out.push(e.code); }
      try { await fetch('https://api.stripe.com/v1/x'); out.push('through'); } catch (e) { out.push(e.code); }
      console.log(out.join(' '));`, RO);
    assert.equal(r.out.trim(), Array(5).fill('ONESHETLAND_TEST_GUARD').join(' '));
  });
  test('without the runner\'s token the lane is just offline', () => {
    const r = guarded(`import { execFileSync } from 'node:child_process';
      try { execFileSync('/bin/echo', ['supabase','db','query','--linked','select 1']); console.log('through'); } catch (e) { console.log(e.code); }`, { ONESHETLAND_TEST_LANE: 'production-readonly' });
    assert.equal(r.out.trim(), 'ONESHETLAND_TEST_GUARD');
  });
});

describe('the lane environment is an allow-list', () => {
  test('a dirty shell hands a test nothing', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { EXPO_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', STRIPE_SECRET_KEY: 'sk_live_x', EXPO_TOKEN: 't', DATABASE_URL: 'postgres://x', GOOGLE_GEOCODING_API_KEY: 'g' });
    try {
      const env = cleanEnv('offline');
      for (const k of ['EXPO_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'EXPO_TOKEN', 'DATABASE_URL', 'GOOGLE_GEOCODING_API_KEY']) assert.equal(env[k], undefined, k);
      assert.equal(env.ONESHETLAND_TEST_LANE, 'offline');
      assert.equal(env.SUPABASE_ACCESS_TOKEN, 'invalid-offline-run');
      assert.match(env.NODE_OPTIONS, /--import=.*guard\.mjs/);
      assert.deepEqual(productionFindings(env), []);
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
  test('npm test is the guarded offline lane; nothing runs the old production lanes', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    assert.equal(pkg.test, 'node scripts/test-lanes.mjs offline');
    assert.equal(pkg['test:fixtures'], undefined, 'the committed-fixture production lane is gone');
    assert.equal(pkg['test:all'], 'npm test && npm run test:isolated');
    assert.ok(!Object.values(pkg).some((v) => /ONESHETLAND_ALLOW_PRODUCTION_READS|--linked/.test(v)), 'no script opts in for you');
    assert.match(readFileSync(join(ROOT, 'scripts/isolated-pg.mjs'), 'utf8'), /env: cleanEnv\('isolated'/);
  });
});

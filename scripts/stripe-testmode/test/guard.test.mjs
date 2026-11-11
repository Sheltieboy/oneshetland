// Unit tests for webhook-guard.mjs and run-with-guard.mjs against a FAKE `stripe` executable (no network, no real account).
// Run: node --test scripts/stripe-testmode/test/guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)); const GUARD = join(HERE, '..', 'webhook-guard.mjs'), WRAP = join(HERE, '..', 'run-with-guard.mjs');
const PROD = 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook';
const ep = (id, url, status = 'enabled', extra = {}) => ({ id, object: 'webhook_endpoint', status, url, enabled_events: ['charge.succeeded', 'payment_intent.succeeded'], api_version: '2023-10-16', description: `d-${id}`, metadata: { a: '1' }, application: null, ...extra });

function world(v1, v2 = []) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-')); const bin = join(dir, 'bin'); spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ v1, v2 })); writeFileSync(join(dir, 'calls.log'), '');
  writeFileSync(join(bin, 'stripe'), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fake-stripe.mjs')}" "$@"\n`); chmodSync(join(bin, 'stripe'), 0o755);
  writeFileSync(join(dir, 'allow.txt'), '# local only\nhost:127.0.0.1:54920\n'); writeFileSync(join(dir, 'approved.txt'), '');
  const state = join(dir, 'state.json');
  const env = (x = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_STATE: state, GUARD_STATE_DIR: join(dir, 'states'), STRIPE_API_KEY: undefined, ...x });
  const run = (script, args, x = {}) => spawnSync(process.execPath, [script, ...args], { env: env(x), encoding: 'utf8' });
  const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const posts = () => calls().filter((c) => c.args[0] === 'post');
  const eps = () => JSON.parse(readFileSync(join(dir, 'endpoints.json'), 'utf8')).v1;
  const approve = (...ids) => writeFileSync(join(dir, 'approved.txt'), ids.join('\n'));
  return { dir, state, env, run, calls, posts, eps, approve, allow: join(dir, 'allow.txt'), approved: join(dir, 'approved.txt') };
}
const base = () => world([ep('we_prod', PROD), ep('we_other', 'https://example.org/hook'), ep('we_local', 'http://127.0.0.1:54920/h'), ep('we_off', 'https://example.org/off', 'disabled')]);
const dis = (w, x) => w.run(GUARD, ['disable', '--allow', w.allow, '--approved', w.approved, '--state', w.state], x);

test('plan is read-only, classifies production/allowed/other, and lists what would be disabled', () => {
  const w = base(); const r = w.run(GUARD, ['plan', '--allow', w.allow]);
  assert.equal(r.status, 0); assert.match(r.stdout, /PRODUCTION\s+v1 we_prod/); assert.match(r.stdout, /OTHER\s+v1 we_other/); assert.match(r.stdout, /Would be disabled by an approved run \(2\)/);
  assert.equal(w.posts().length, 0); assert.ok(w.calls().every((c) => c.args.includes('--project-name') && !c.args.includes('--live') && !c.args.includes('--api-key')));
});
test('a production endpoint can never be allowed, even if listed in the allow file', () => {
  const w = base(); writeFileSync(w.allow, 'we_prod\nhost:nkrtmakxygkvxuxriiil.supabase.co\n');
  assert.match(w.run(GUARD, ['plan', '--allow', w.allow]).stdout, /PRODUCTION\s+v1 we_prod/);
  assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow]).status, 2);
});
test('disable: state saved BEFORE the first POST, only approved ids are POSTed, others untouched, originals complete', () => {
  const w = base(); w.approve('we_prod'); const r = dis(w); assert.equal(r.status, 0, r.stderr);
  const p = w.posts(); assert.equal(p.length, 1); assert.ok(p[0].args.includes('/v1/webhook_endpoints/we_prod') && p[0].args.includes('disabled=true')); assert.equal(p[0].stateFileExisted, true, 'state must exist before the first POST');
  const st = JSON.parse(readFileSync(w.state, 'utf8')); const o = st.endpoints.we_prod.original;
  assert.deepEqual([o.id, o.status, o.url, o.api_version, o.description, o.connect], ['we_prod', 'enabled', PROD, '2023-10-16', 'd-we_prod', false]); assert.deepEqual(o.enabled_events, ['charge.succeeded', 'payment_intent.succeeded']); assert.deepEqual(o.metadata, { a: '1' });
  assert.deepEqual(Object.keys(st.endpoints), ['we_prod']); assert.equal(w.eps().find((e) => e.id === 'we_other').status, 'enabled');
});
test('disable refuses: id not in account, allowed id, empty approved file, missing approved file, livemode (nothing changed, no POST)', () => {
  let w = base(); w.approve('we_nope'); assert.equal(dis(w).status, 2); assert.equal(w.posts().length, 0);
  w = base(); w.approve('we_local'); assert.equal(dis(w).status, 2); assert.equal(w.posts().length, 0);
  w = base(); assert.equal(dis(w).status, 2); assert.equal(w.posts().length, 0);
  w = base(); assert.equal(w.run(GUARD, ['disable', '--allow', w.allow, '--state', w.state]).status, 1);
  w = base(); w.approve('we_prod'); assert.equal(dis(w, { FAKE_LIVEMODE: '1' }).status, 3); assert.equal(w.posts().length, 0); assert.ok(!existsSync(w.state));
  w = base(); w.approve('we_prod', 'we_nope'); assert.equal(dis(w).status, 2); assert.equal(w.eps().find((e) => e.id === 'we_prod').status, 'enabled', 'one bad id means NOTHING is disabled');
});
test('disable is idempotent and never overwrites the recorded originals with disabled values', () => {
  const w = base(); w.approve('we_prod', 'we_off'); assert.equal(dis(w).status, 0); assert.equal(dis(w).status, 0);
  assert.equal(w.posts().length, 1, 'second run posts nothing'); const st = JSON.parse(readFileSync(w.state, 'utf8'));
  assert.equal(st.endpoints.we_prod.original.status, 'enabled'); assert.equal(st.endpoints.we_off.original.status, 'disabled');
});
test('restore re-enables exactly the recorded endpoints (not the one that was originally disabled), then verifies', () => {
  const w = base(); w.approve('we_prod', 'we_other', 'we_off'); assert.equal(dis(w).status, 0);
  const r = w.run(GUARD, ['restore', '--state', w.state]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /verified we_prod/);
  const e = Object.fromEntries(w.eps().map((x) => [x.id, x.status])); assert.deepEqual(e, { we_prod: 'enabled', we_other: 'enabled', we_local: 'enabled', we_off: 'disabled' });
  const again = w.run(GUARD, ['restore', '--state', w.state]); assert.equal(again.status, 0); const enables = w.posts().filter((p) => p.args.includes('disabled=false')); assert.equal(enables.length, 2, 'idempotent: no second enable');
});
test('restore that cannot be verified is LOUD and non-zero (endpoint changed while disabled)', () => {
  const w = base(); w.approve('we_prod'); dis(w); const r = w.run(GUARD, ['restore', '--state', w.state], { FAKE_CORRUPT_ON_ENABLE: '1' });
  assert.equal(r.status, 4); assert.match(r.stderr, /RESTORE NOT VERIFIED for we_prod: enabled_events differ/); assert.match(r.stderr, /RESTORATION COULD NOT BE VERIFIED/);
});
test('a crash midway through disable (CLI dies after the first POST) leaves a state file from which restore recovers everything', () => {
  const w = base(); w.approve('we_prod', 'we_other'); const r = dis(w, { FAKE_CRASH_AFTER_POSTS: '1' }); assert.equal(r.status, 4);
  assert.equal(JSON.parse(readFileSync(w.state, 'utf8')).endpoints.we_other.original.status, 'enabled');
  const rr = w.run(GUARD, ['restore', '--state', w.state]); assert.equal(rr.status, 0, rr.stderr);
  assert.deepEqual(w.eps().map((x) => x.status), ['enabled', 'enabled', 'enabled', 'disabled']);
});
test('verify-isolated: fails while a non-allowed endpoint is enabled, passes once disabled; unreadable v2 fails unless explicitly accepted', () => {
  const w = base(); assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow]).status, 2);
  w.approve('we_prod', 'we_other'); dis(w); assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow]).status, 0);
  assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow], { FAKE_V2_FAIL: '1' }).status, 5);
  assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow, '--allow-v2-unreadable'], { FAKE_V2_FAIL: '1' }).status, 4);
});
test('v2 event destinations are classified and an enabled production one blocks isolation', () => {
  const w = world([], [{ id: 'ed_1', status: 'enabled', webhook_endpoint: { url: PROD }, enabled_events: ['x'], type: 'webhook_endpoint' }]);
  assert.equal(w.run(GUARD, ['verify-isolated', '--allow', w.allow]).status, 2); assert.match(w.run(GUARD, ['plan', '--allow', w.allow]).stdout, /PRODUCTION\s+v2 ed_1/);
});
test('run-with-guard: disable, run, ALWAYS restore; command exit code propagates; the command sees isolation', () => {
  const w = base(); w.approve('we_prod', 'we_other');
  const r = w.run(WRAP, ['--allow', w.allow, '--approved', w.approved, '--state', w.state, '--', process.execPath, '-e', `const {readFileSync}=require('fs');const e=JSON.parse(readFileSync('${w.dir}/endpoints.json')).v1;process.exit(e.filter(x=>x.status==='enabled'&&x.id!=='we_local').length===0?7:9)`]);
  assert.equal(r.status, 7, r.stderr); assert.deepEqual(w.eps().map((x) => x.status), ['enabled', 'enabled', 'enabled', 'disabled']);
});
test('run-with-guard restores when the command fails, and does not run the command when disable fails', () => {
  let w = base(); w.approve('we_prod'); let r = w.run(WRAP, ['--allow', w.allow, '--approved', w.approved, '--state', w.state, '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(r.status, 3); assert.equal(w.eps()[0].status, 'enabled');
  w = base(); w.approve('we_prod'); writeFileSync(join(w.dir, 'marker.js'), `require('fs').writeFileSync('${w.dir}/ran','1')`);
  r = w.run(WRAP, ['--allow', w.allow, '--approved', w.approved, '--state', w.state, '--', process.execPath, join(w.dir, 'marker.js')], { FAKE_FAIL_POST: 'we_prod' });
  assert.notEqual(r.status, 0); assert.ok(!existsSync(join(w.dir, 'ran'))); assert.equal(w.eps()[0].status, 'enabled');
});
test('run-with-guard: restoration failure overrides a successful command with exit 4 and a prominent alert', () => {
  const w = base(); w.approve('we_prod'); const r = w.run(WRAP, ['--allow', w.allow, '--approved', w.approved, '--state', w.state, '--', process.execPath, '-e', 'process.exit(0)'], { FAKE_CORRUPT_ON_ENABLE: '1' });
  assert.equal(r.status, 4); assert.match(r.stderr, /RESTORATION NOT VERIFIED/); assert.match(r.stderr, /restore-now --state/);
});
test('run-with-guard: SIGTERM mid-command still restores', async () => {
  const w = base(); w.approve('we_prod');
  const c = spawn(process.execPath, [WRAP, '--allow', w.allow, '--approved', w.approved, '--state', w.state, '--', process.execPath, '-e', 'setTimeout(()=>{},60000)'], { env: w.env(), stdio: 'ignore' });
  for (let i = 0; i < 100 && w.eps()[0].status !== 'disabled'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.eps()[0].status, 'disabled'); c.kill('SIGTERM'); const code = await new Promise((r) => c.on('exit', r));
  assert.ok(code !== null); assert.equal(w.eps()[0].status, 'enabled');
});
test('restore-now is the manual recovery entry point', () => {
  const w = base(); w.approve('we_prod'); dis(w); const r = w.run(WRAP, ['restore-now', '--state', w.state]); assert.equal(r.status, 0, r.stderr); assert.equal(w.eps()[0].status, 'enabled');
});
test('STRIPE_API_KEY from the environment is never passed to the CLI, and --live/--api-key are never used', () => {
  const w = base(); const r = w.run(GUARD, ['plan', '--allow', w.allow], { STRIPE_API_KEY: 'sk_test_should_not_pass' }); assert.equal(r.status, 0);
  assert.ok(!w.calls().some((c) => JSON.stringify(c.args).includes('sk_test')));
});
test('every scenario refuses a LIVE run without --allow, and when an enabled non-allowed endpoint exists (no Stripe write, no local stack started)', () => {
  for (const sc of ['e0-package-orders', 'e1-participation', 'e2-memberships', 'e3-refunds', 'e4-disputes', 'e5-webhooks-reconcile']) {
    const script = join(HERE, '..', 'scenarios', `${sc}.mjs`);
    let w = base(); let r = w.run(script, []); assert.equal(r.status, 2, `${sc}: ${r.stderr}`); assert.match(r.stderr, /--allow FILE/);
    w = base(); r = w.run(script, ['--allow', w.allow]); assert.equal(r.status, 2, `${sc}: ${r.stderr}`); assert.match(r.stderr, /verify-isolated failed/);
    assert.equal(w.posts().length, 0);
  }
});
test('stripe-cli: an error object printed with exit 0 is a FAILURE; a warning line before the JSON does not break parsing', async () => {
  const w = base(); const { stripe } = await import('../lib/stripe-cli.mjs'); const old = process.env.PATH; Object.assign(process.env, w.env({ FAKE_ERR_EXIT0: '1' })); 
  let r = stripe('GET', '/v1/charges'); assert.equal(r.ok, false); assert.equal(r.status, 404); assert.match(r.body.error.message, /3 customers/);
  delete process.env.FAKE_ERR_EXIT0; process.env.FAKE_WARN = '1'; r = stripe('GET', '/v1/charges'); assert.equal(r.ok, true); assert.equal(r.body.data[0].id, 'ch_1'); delete process.env.FAKE_WARN; process.env.PATH = old;
});

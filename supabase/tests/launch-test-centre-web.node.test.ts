/**
 * launch-test-centre-web.node.test.ts — Web as a first-class launch platform (migration 20261126000000), against the real SQL.
 * Replays every earlier migration (incl. the original Test Centre), applies the Web migration on top, then proves:
 *   · web is a recognised platform on testers / sessions / tests; junk platforms are rejected;
 *   · tester platform assignments are enforced when opening a session (empty list = all platforms);
 *   · RC1 now holds 11 tests: 9 shared + 2 web-only; web-only tests cannot be started from an iOS/Android session;
 *   · results are per platform: a Web attempt lives on the Web session only;
 *   · a session's platform / owner can never be changed afterwards;
 *   · web context is stored lightly and sanitised; app sessions keep build, ignore web context;
 *   · the money acknowledgement still applies on Web.
 * ISOLATED DATABASE ONLY. Fake users; no Stripe; no money.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_NAME = '20261125000000_launch_test_centre.sql';
const WEB_NAME = '20261126000000_launch_test_centre_web_platform.sql';
let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ids = { ADMIN: 'ad000000-0000-4000-8000-0000000000ad', A: 'a1000000-0000-4000-8000-000000000001', B: 'a2000000-0000-4000-8000-000000000002',
  C: 'a3000000-0000-4000-8000-000000000003' } as const;
type Who = keyof typeof ids;
const role = (w: Who) => `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`;
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${role(w)} ${sql}; rollback;`);
const doAs = (w: Who, sql: string) => db.raw(`begin; ${role(w)} ${sql}; commit;`);
const err = (o: string) => /ERROR/.test(o);
const PROG = () => scalar(`select id from public.launch_test_programmes where slug='rc1'`);
const TEST = (slug: string) => scalar(`select id from public.launch_tests where slug='${slug}'`);
const open = (w: Who, platform: string, extra = '') => doAs(w, `select public.launch_test_open_session('${PROG()}', '${platform}', 'Build 148', 'Dev'${extra})`);
const sid = (o: string) => lastRow(o);
const start = (w: Who, slug: string, session: string, ack = false) => doAs(w, `select public.launch_test_start('${TEST(slug)}', '${session}', ${ack})`);

before(() => {
  db = createReplayDb('launchtestweb', { stopBefore: WEB_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const seed = db.raw(`
    insert into auth.users (id, email) select x, 'w' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';`);
  assert.doesNotMatch(seed, /ERROR/, seed);
  const ap = db.rawFile(join(REPO_ROOT, 'supabase/migrations', WEB_NAME));
  assert.doesNotMatch(ap, /ERROR/, ap);
  const add = (u: string, plats: string) => doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}', 'w${u.slice(0, 4)}@example.org', '${plats}', null)`);
  assert.doesNotMatch(add(ids.A, '{web,ios}'), /ERROR/);
  assert.doesNotMatch(add(ids.B, '{android}'), /ERROR/);
  assert.doesNotMatch(add(ids.C, '{}'), /ERROR/);
});
after(() => { db?.drop(); });

describe('web platform model', () => {
  test('RC1 has 11 tests; applicability is Web 11, iOS 9, Android 9', () => {
    const n = (p: string) => scalar(`select count(*) from public.launch_tests where programme_id='${PROG()}' and mandatory and platform in ('all','${p}')`);
    assert.equal(scalar(`select count(*) from public.launch_tests where programme_id='${PROG()}'`), '11');
    assert.deepEqual([n('web'), n('ios'), n('android')], ['11', '9', '9']);
    assert.equal(scalar(`select count(*) from public.launch_tests where platform='web'`), '2');
  });
  test('every shared test has website wording', () => {
    assert.equal(scalar(`select count(*) from public.launch_tests where platform='all' and web_steps is null`), '0');
  });
  test('junk platforms are rejected on testers, sessions and tests', () => {
    assert.ok(err(doAs('ADMIN', `select public.launch_test_admin_update_tester((select id from public.launch_testers limit 1), true, '{desktop}', null)`)));
    assert.ok(err(open('C', 'windows')));
    assert.ok(err(doAs('ADMIN', `select public.launch_test_admin_update_test('${TEST('web-links')}', '{"platform":"tv"}')`)));
  });
  test('admin can assign web; assignments are stored', () => {
    assert.match(scalar(`select platforms::text from public.launch_testers t join auth.users u on u.id=t.user_id where u.id='${ids.A}'`), /web/);
  });
});

describe('assignments and sessions', () => {
  const S: Record<string, string> = {};
  test('tester A (web+ios) can open web and ios, not android', () => {
    S.aw = sid(open('A', 'web', `, 'Chrome 130', 'desktop', '1440x900'`));
    S.ai = sid(open('A', 'ios'));
    assert.match(S.aw, /^[0-9a-f-]{36}$/); assert.match(S.ai, /^[0-9a-f-]{36}$/);
    assert.match(open('A', 'android'), /not part of your test assignment/);
  });
  test('tester B (android only) cannot open web or ios; tester C (all) can open all three', () => {
    assert.match(open('B', 'web'), /not part of your test assignment/);
    assert.match(open('B', 'ios'), /not part of your test assignment/);
    S.bd = sid(open('B', 'android'));
    for (const p of ['web', 'ios', 'android']) assert.match(sid(open('C', p)), /^[0-9a-f-]{36}$/);
  });
  test('web context is stored and sanitised; app sessions drop it', () => {
    const r = scalar(`select browser || '|' || device_class || '|' || viewport || '|' || coalesce(app_build,'none') from public.launch_test_sessions where id='${S.aw}'`);
    assert.equal(r, 'Chrome 130|desktop|1440x900|none');
    const odd = sid(open('C', 'web', `, null, 'toaster', 'huge'`));
    assert.equal(scalar(`select coalesce(device_class,'null')||'|'||coalesce(viewport,'null') from public.launch_test_sessions where id='${odd}'`), 'null|null');
    const app = scalar(`select coalesce(browser,'null')||'|'||app_build from public.launch_test_sessions where id='${S.ai}'`);
    assert.equal(app, 'null|Build 148');
  });
  test('a session cannot be moved to another platform or owner, even by a trusted writer', () => {
    assert.ok(err(db.raw(`update public.launch_test_sessions set platform='ios' where id='${S.aw}'`)));
    assert.ok(err(db.raw(`update public.launch_test_sessions set user_id='${ids.B}' where id='${S.aw}'`)));
    assert.ok(err(tryAs('A', `update public.launch_test_sessions set platform='android' where id='${S.aw}'`)));
  });
  test('web-only tests start on web, never on iOS or Android sessions; shared tests start on all', () => {
    assert.ok(!err(start('A', 'web-layout', S.aw)));
    assert.match(start('A', 'web-layout', S.ai), /./);
    assert.ok(err(start('A', 'web-layout', S.ai)));
    assert.ok(err(start('B', 'web-links', S.bd)));
    assert.ok(!err(start('A', 'sign-in-account', S.aw)));
    assert.ok(!err(start('A', 'sign-in-account', S.ai)));
    assert.ok(!err(start('B', 'sign-in-account', S.bd)));
  });
  test('results are per platform: a web pass lives only on the web session', () => {
    const a = lastRow(start('A', 'home-navigation', S.aw));
    assert.ok(!err(doAs('A', `select public.launch_test_submit('${a}', 'passed', 'fine', '')`)));
    const rows = scalar(`select count(*) from public.launch_test_attempts a join public.launch_test_sessions s on s.id=a.session_id where a.test_id='${TEST('home-navigation')}' and a.user_id='${ids.A}' and a.status='passed' and s.platform='web'`);
    const other = scalar(`select count(*) from public.launch_test_attempts a join public.launch_test_sessions s on s.id=a.session_id where a.test_id='${TEST('home-navigation')}' and a.user_id='${ids.A}' and s.platform<>'web'`);
    assert.equal(rows, '1'); assert.equal(other, '0');
    const latest = db.raw(`begin; ${role('ADMIN')} select platform||':'||status from public.launch_test_admin_latest('${PROG()}') where test_id='${TEST('home-navigation')}'; rollback;`);
    assert.match(latest, /web:passed/); assert.doesNotMatch(latest, /ios:|android:/);
  });
  test('the real-money acknowledgement still applies on Web', () => {
    db.raw(`update public.launch_tests set expected_max_spend_pence=200, target_note='ZZ' where slug='shop-card'`);
    assert.ok(err(start('A', 'shop-card', S.aw, false)));
    assert.ok(!err(start('A', 'shop-card', S.aw, true)));
  });
  test('a tester cannot see another tester\'s sessions', () => {
    assert.equal(lastRow(tryAs('B', `select count(*) from public.launch_test_sessions where user_id <> '${ids.B}'`)), '0');
  });
});

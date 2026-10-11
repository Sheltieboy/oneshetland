/**
 * launch-test-centre.node.test.ts — the private Launch Test Centre (migration 20261125000000), against the real SQL.
 *
 * WHAT IT IS: trusted testers follow real journeys in the live app and record the outcome on the website. The database must make that
 * private for real — hiding a URL is not security — so this proves, against the REAL migrated schema (every earlier migration replayed
 * into a private database, then the Test Centre migration applied):
 *   · a signed-in user who is not an enabled tester, a disabled tester, and anon, can read and do nothing;
 *   · a tester sees only their own sessions / attempts / evidence, cannot read or write another tester's, and cannot write any table directly;
 *   · results are append-only history (a re-run is a new row; a submitted result cannot be edited, even by a superuser);
 *   · a real-money test cannot be started without the acknowledgement;
 *   · administrators see everything and are the only ones who can run the admin functions; testers are found by existing account only;
 *   · screenshot evidence is private: owners write only under their own attempt id with a generated name, read only their own, administrators
 *     read all, nobody overwrites, only administrators delete;
 *   · mutation controls: loosening each protection makes the matching check fail.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; no Stripe; no money; nothing near production.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261125000000_launch_test_centre.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));

const ids = { ADMIN: 'ad000000-0000-4000-8000-0000000000ad', T1: 'a1000000-0000-4000-8000-000000000001', T2: 'a2000000-0000-4000-8000-000000000002',
  DIS: 'd1000000-0000-4000-8000-000000000003', USER: 'e1000000-0000-4000-8000-000000000004', GONE: 'f1000000-0000-4000-8000-000000000005' } as const;
type Who = keyof typeof ids | 'anon' | 'service';
const roleSql = (w: Who) => (w === 'anon' ? 'set local role anon;' : w === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`);
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; rollback;`);
const doAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; commit;`);
const denied = (o: string) => /permission denied/i.test(o);
const rls = (o: string) => /row-level security/i.test(o);
const err = (o: string) => /ERROR/.test(o);
const count = (w: Who, table: string, where = 'true') => Number(lastRow(tryAs(w, `select count(*) from public.${table} where ${where}`)));

const PROG = () => scalar(`select id from public.launch_test_programmes where slug='rc1'`);
const TEST = (slug: string) => scalar(`select id from public.launch_tests where slug='${slug}'`);
const uuid = () => scalar('select gen_random_uuid()');
const open = (w: Who, platform = 'ios') => lastRow(doAs(w, `select public.launch_test_open_session('${PROG()}', '${platform}', 'Build 148', 'Test phone')`));
const start = (w: Who, slug: string, session: string, ack = false) => lastRow(doAs(w, `select public.launch_test_start('${TEST(slug)}', '${session}', ${ack})`));
const submit = (w: Who, attempt: string, status: string, note = 'ok', issue = '') => doAs(w, `select public.launch_test_submit('${attempt}', '${status}', '${note}', '${issue}')`);

const S: Record<string, string> = {};

before(() => {
  db = createReplayDb('launchtest', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const seed = db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    update auth.users set email = 'tester.one@example.org' where id = '${ids.T1}';
    update auth.users set deleted_at = now() where id = '${ids.GONE}';
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    grant select, insert, update, delete on storage.objects to authenticated;`);
  assert.doesNotMatch(seed, /ERROR/, seed);
  S.apply = db.rawFile(FIX);
  assert.doesNotMatch(S.apply, /ERROR/, S.apply);
  // enable T1 and T2 (and a DISABLED tester) through the real admin function
  S.add1 = lastRow(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}', 'Tester.One@Example.org', '{}', 'trusted')`));
  S.add2 = lastRow(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}', '${'u' + ids.T2.slice(0, 4)}@example.org', '{ios,android}', null)`));
  S.addDis = lastRow(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}', '${'u' + ids.DIS.slice(0, 4)}@example.org', '{}', null)`));
  doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.addDis}', false, null, 'left the programme')`);
});
after(() => { db?.drop(); });

describe('0 · the migration', () => {
  test('applies clean (with its own end-state assertions) and re-applies is not needed: the programme and nine tests are seeded', () => {
    assert.equal(scalar(`select count(*) from public.launch_test_programmes where slug='rc1' and status='active'`), '1');
    assert.equal(scalar(`select count(*) from public.launch_tests where programme_id='${PROG()}'`), '9');
    assert.equal(scalar(`select string_agg(slug, ',' order by sort_order) from public.launch_tests`),
      'sign-in-account,home-navigation,directory-map,whats-on,shop-wallet,shop-card,hub-donation,wallet-history,games-spik');
  });
  test('the three real-money tests are flagged with their type and a small expected spend; the rest are not', () => {
    assert.equal(scalar(`select string_agg(slug || ':' || money_test_type || ':' || coalesce(expected_max_spend_pence::text,'-'), ',' order by sort_order) from public.launch_tests where money_test_type <> 'none'`),
      'shop-wallet:wallet:200,shop-card:real_card:200,hub-donation:donation:200');
    assert.equal(scalar(`select count(*) from public.launch_tests where mandatory`), '9');
  });
  test('expected builds are the ones in review', () => {
    assert.equal(scalar(`select expected_ios_build || ' | ' || expected_android_version from public.launch_test_programmes where slug='rc1'`), 'Build 148 | 1.0.0 (version code 3)');
  });
  test('anon has nothing; authenticated can only SELECT; the evidence bucket is private, 5 MB, images only', () => {
    for (const t of ['launch_test_programmes', 'launch_testers', 'launch_tests', 'launch_test_sessions', 'launch_test_attempts', 'launch_test_attachments']) {
      assert.equal(scalar(`select has_table_privilege('anon','public.${t}','SELECT')`), 'f', `${t} anon`);
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(scalar(`select has_table_privilege('authenticated','public.${t}','${p}')`), 'f', `${t} ${p}`);
      assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.${t}'::regclass`), 't');
    }
    assert.equal(scalar(`select public::text || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',') from storage.buckets where id='launch-test-evidence'`),
      'false|5242880|image/jpeg,image/png,image/webp,image/heic,image/heif');
  });
});

describe('1 · who can get in at all', () => {
  test('anon: permission denied everywhere', () => {
    for (const t of ['launch_test_programmes', 'launch_tests', 'launch_testers', 'launch_test_attempts']) assert.ok(denied(tryAs('anon', `select * from public.${t}`)), t);
    assert.ok(denied(tryAs('anon', `select public.launch_test_open_session('${PROG()}','ios','x',null)`)));
  });
  test('a signed-in user who is NOT a tester sees nothing and cannot start anything', () => {
    for (const t of ['launch_test_programmes', 'launch_tests', 'launch_testers', 'launch_test_sessions', 'launch_test_attempts', 'launch_test_attachments']) assert.equal(count('USER', t), 0, t);
    assert.match(tryAs('USER', `select public.launch_test_open_session('${PROG()}','ios','Build 148',null)`), /not available/);
  });
  test('a DISABLED tester sees nothing and cannot start anything', () => {
    for (const t of ['launch_test_programmes', 'launch_tests', 'launch_testers']) assert.equal(count('DIS', t), 0, t);
    assert.match(tryAs('DIS', `select public.launch_test_open_session('${PROG()}','ios','Build 148',null)`), /not available/);
  });
  test('an enabled tester sees the programme and the nine tests, and only their own tester row', () => {
    assert.equal(count('T1', 'launch_test_programmes'), 1);
    assert.equal(count('T1', 'launch_tests'), 9);
    assert.equal(count('T1', 'launch_testers'), 1);
    assert.equal(scalar(`select count(*) from public.launch_testers`), '3');
  });
  test('inactive tests are hidden from testers but visible to admins', () => {
    doAs('ADMIN', `select public.launch_test_admin_update_test('${TEST('games-spik')}', '{"active": false}')`);
    assert.equal(count('T1', 'launch_tests'), 8); assert.equal(count('ADMIN', 'launch_tests'), 9);
    doAs('ADMIN', `select public.launch_test_admin_update_test('${TEST('games-spik')}', '{"active": true}')`);
  });
  test('a draft programme is invisible to testers', () => {
    doAs('ADMIN', `select public.launch_test_admin_update_programme('${PROG()}', '{"status":"draft"}')`);
    assert.equal(count('T1', 'launch_test_programmes'), 0);
    assert.match(tryAs('T1', `select public.launch_test_open_session('${PROG()}','ios','b',null)`), /not open right now/);
    doAs('ADMIN', `select public.launch_test_admin_update_programme('${PROG()}', '{"status":"active"}')`);
  });
  test('a platform-restricted tester cannot open a session for the other platform', () => {
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add1}', true, '{ios}', 'iphone only')`);
    assert.match(tryAs('T1', `select public.launch_test_open_session('${PROG()}','android','1.0.0',null)`), /not part of your test assignment/);
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add1}', true, '{}', 'trusted')`);
  });
});

describe('2 · the tester journey and the history it leaves', () => {
  test('open a session, start, submit — and a second submission is refused', () => {
    S.s1 = open('T1');
    assert.match(S.s1, /^[0-9a-f-]{36}$/);
    S.a1 = start('T1', 'home-navigation', S.s1);
    assert.match(S.a1, /^[0-9a-f-]{36}$/);
    assert.equal(start('T1', 'home-navigation', S.s1), S.a1, 'starting again just resumes');
    assert.ok(!err(submit('T1', S.a1, 'passed', 'all fine')));
    assert.match(submit('T1', S.a1, 'issue', 'x', 'changed my mind'), /already been sent/);
    assert.equal(scalar(`select status || '|' || tester_note from public.launch_test_attempts where id='${S.a1}'`), 'passed|all fine');
  });
  test('"went wrong" and "couldn\'t complete" must say what happened', () => {
    const a = start('T1', 'whats-on', S.s1);
    assert.match(submit('T1', a, 'issue', '', ''), /tell us what happened/);
    assert.match(submit('T1', a, 'blocked', '', 'ab'), /tell us what happened/);
    assert.match(submit('T1', a, 'nonsense', 'x', 'y'), /Choose how it went/);
    assert.ok(!err(submit('T1', a, 'issue', '', 'The event page showed a blank map')));
    assert.equal(scalar(`select status || '|' || review_state from public.launch_test_attempts where id='${a}'`), 'issue|open');
    S.issueAttempt = a;
  });
  test('a re-run is a NEW attempt linked to the previous one; the earlier result is untouched', () => {
    const b = start('T1', 'whats-on', S.s1);
    assert.notEqual(b, S.issueAttempt);
    assert.equal(scalar(`select retest_of from public.launch_test_attempts where id='${b}'`), S.issueAttempt);
    submit('T1', b, 'passed', 'works now');
    assert.equal(scalar(`select count(*) from public.launch_test_attempts where test_id='${TEST('whats-on')}' and user_id='${ids.T1}'`), '2');
    assert.equal(scalar(`select status || '|' || issue_description from public.launch_test_attempts where id='${S.issueAttempt}'`), 'issue|The event page showed a blank map');
  });
  test('a submitted result can never be edited — not even by a superuser — but an admin\'s review fields still move', () => {
    assert.match(db.raw(`update public.launch_test_attempts set status='passed' where id='${S.issueAttempt}'`), /cannot be edited/);
    assert.match(db.raw(`update public.launch_test_attempts set issue_description='rewritten' where id='${S.issueAttempt}'`), /cannot be edited/);
    assert.match(db.raw(`update public.launch_test_attempts set user_id='${ids.T2}' where id='${S.issueAttempt}'`), /identity cannot change/);
    assert.ok(!err(doAs('ADMIN', `select public.launch_test_admin_review('${S.issueAttempt}', 'reviewed', 'looking at it')`)));
    assert.equal(scalar(`select review_state || '|' || admin_note from public.launch_test_attempts where id='${S.issueAttempt}'`), 'reviewed|looking at it');
  });
  test('real-money tests cannot be started without the acknowledgement; with it the time is recorded', () => {
    for (const slug of ['shop-wallet', 'shop-card', 'hub-donation']) {
      assert.match(doAs('T1', `select public.launch_test_start('${TEST(slug)}','${S.s1}',false)`), /real transaction/, slug);
      assert.match(doAs('T1', `select public.launch_test_start('${TEST(slug)}','${S.s1}',null)`), /real transaction/, slug);
    }
    const a = start('T1', 'shop-card', S.s1, true);
    assert.equal(scalar(`select money_acknowledged_at is not null from public.launch_test_attempts where id='${a}'`), 't');
    submit('T1', a, 'blocked', '', 'My card was declined by my bank');
    assert.equal(scalar(`select count(*) from public.launch_test_attempts where test_id='${TEST('home-navigation')}' and money_acknowledged_at is not null`), '0', 'ordinary tests record no acknowledgement');
  });
  test('a platform-specific test cannot be started on the other phone type', () => {
    doAs('ADMIN', `select public.launch_test_admin_update_test('${TEST('games-spik')}', '{"platform":"android"}')`);
    assert.match(doAs('T1', `select public.launch_test_start('${TEST('games-spik')}','${S.s1}',false)`), /not for this phone type/);
    doAs('ADMIN', `select public.launch_test_admin_update_test('${TEST('games-spik')}', '{"platform":"all"}')`);
  });
  test('a session finishes only when nothing applicable is left unanswered', () => {
    assert.equal(scalar(`select completed_at is null from public.launch_test_sessions where id='${S.s1}'`), 't');
    const slugs = scalar(`select string_agg(slug, ',') from public.launch_tests`).split(',');
    for (const slug of slugs) {
      const open_ = scalar(`select count(*) from public.launch_test_attempts a join public.launch_tests t on t.id=a.test_id where t.slug='${slug}' and a.session_id='${S.s1}' and a.status<>'in_progress'`);
      if (open_ === '0') submit('T1', start('T1', slug, S.s1, true), 'passed', 'fine');
    }
    assert.equal(scalar(`select completed_at is not null from public.launch_test_sessions where id='${S.s1}'`), 't');
  });
});

describe('3 · testers cannot reach each other', () => {
  before(() => {
    S.s2 = open('T2');
    S.b1 = start('T2', 'directory-map', S.s2);
  });
  test('T2 cannot read T1\'s sessions, attempts or attachments, and T1 cannot read T2\'s', () => {
    assert.equal(count('T2', 'launch_test_sessions'), 1); assert.equal(count('T2', 'launch_test_sessions', `user_id='${ids.T1}'`), 0);
    assert.equal(count('T2', 'launch_test_attempts', `user_id='${ids.T1}'`), 0);
    assert.equal(count('T2', 'launch_test_attempts', `id='${S.a1}'`), 0);
    assert.equal(count('T1', 'launch_test_attempts', `id='${S.b1}'`), 0);
  });
  test('T2 cannot start in, submit, or attach to T1\'s session / attempt (guessing ids does nothing)', () => {
    assert.match(doAs('T2', `select public.launch_test_start('${TEST('sign-in-account')}','${S.s1}',false)`), /not available/);
    assert.match(doAs('T2', `select public.launch_test_submit('${S.a1}','passed','x','')`), /not available/);
    const open1 = start('T1', 'sign-in-account', S.s1);   // already passed earlier -> this is a new open attempt
    assert.match(doAs('T2', `select public.launch_test_submit('${open1}','passed','forged','')`), /not available/);
    assert.equal(scalar(`select status from public.launch_test_attempts where id='${open1}'`), 'in_progress');
    assert.match(doAs('T2', `select public.launch_test_add_attachment('${open1}','${open1}/${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.png','image/png',10)`), /not available/);
    submit('T1', open1, 'passed', 'done');
  });
  test('no table can be written directly by a tester or any signed-in user', () => {
    for (const w of ['T1', 'T2', 'USER'] as Who[]) {
      assert.ok(denied(tryAs(w, `insert into public.launch_test_attempts (programme_id,test_id,session_id,user_id) values ('${PROG()}','${TEST('home-navigation')}','${S.s1}','${ids[w as 'T1']}')`)), `${w} insert attempt`);
      assert.ok(denied(tryAs(w, `update public.launch_test_attempts set status='passed'`)), `${w} update attempt`);
      assert.ok(denied(tryAs(w, `delete from public.launch_test_attempts`)), `${w} delete attempt`);
      assert.ok(denied(tryAs(w, `update public.launch_tests set title='hacked'`)), `${w} update test`);
      assert.ok(denied(tryAs(w, `insert into public.launch_testers (programme_id,user_id) values ('${PROG()}','${ids.USER}')`)), `${w} self-enrol`);
      assert.ok(denied(tryAs(w, `update public.launch_testers set enabled = true`)), `${w} enable self`);
    }
  });
  test('a tester cannot run any administrator function, and cannot find out who else is testing', () => {
    for (const call of [
      `select * from public.launch_test_admin_testers('${PROG()}')`,
      `select public.launch_test_admin_add_tester('${PROG()}','x@example.org','{}',null)`,
      `select public.launch_test_admin_update_tester('${S.add1}', false, null, null)`,
      `select public.launch_test_admin_update_test('${TEST('home-navigation')}','{"active":false}')`,
      `select public.launch_test_admin_update_programme('${PROG()}','{"status":"completed"}')`,
      `select public.launch_test_admin_review('${S.issueAttempt}','resolved',null)`,
      `select public.launch_test_admin_request_retest('${S.a1}',null)`,
      `select * from public.launch_test_admin_latest('${PROG()}')`,
    ]) assert.match(tryAs('T1', call), /Only an administrator|permission denied/, call);
    assert.equal(scalar(`select enabled from public.launch_testers where id='${S.add1}'`), 't');
  });
});

describe('4 · administrators', () => {
  test('see every tester\'s sessions and attempts', () => {
    assert.ok(count('ADMIN', 'launch_test_attempts') >= 5);
    assert.equal(count('ADMIN', 'launch_test_attempts', `user_id='${ids.T2}'`), 1);
    assert.equal(count('ADMIN', 'launch_test_sessions'), 2);
    assert.equal(count('ADMIN', 'launch_testers'), 3);
  });
  test('list testers WITH email and name (admins only); the service role works too', () => {
    const out = tryAs('ADMIN', `select email, full_name, enabled from public.launch_test_admin_testers('${PROG()}') where user_id='${ids.T1}'`);
    assert.match(out, /tester\.one@example\.org\|Fixture a100\|t\b/);
    assert.match(tryAs('service', `select count(*) from public.launch_test_admin_testers('${PROG()}')`), /3/);
  });
  test('add a tester by the email of an EXISTING account only; unknown or deleted accounts are refused with a helpful message', () => {
    assert.match(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}','nobody@example.org','{}',null)`), /no OneShetland account with that email yet/);
    assert.match(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}','${'u' + ids.GONE.slice(0, 4)}@example.org','{}',null)`), /no OneShetland account/);
    assert.match(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}','not-an-email','{}',null)`), /Enter an email/);
    assert.match(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}','tester.one@example.org','{windows}',null)`), /ios or android/);
    const again = lastRow(doAs('ADMIN', `select public.launch_test_admin_add_tester('${PROG()}','TESTER.ONE@example.org','{}',null)`));
    assert.equal(again, S.add1, 'adding the same person again re-uses their row (case-insensitive)');
  });
  test('disabling a tester closes everything at once; re-enabling restores it, and history is kept', () => {
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add2}', false, null, null)`);
    assert.equal(count('T2', 'launch_test_attempts'), 0); assert.equal(count('T2', 'launch_tests'), 0);
    assert.match(tryAs('T2', `select public.launch_test_start('${TEST('home-navigation')}','${S.s2}',false)`), /not available/);
    assert.equal(count('ADMIN', 'launch_test_attempts', `user_id='${ids.T2}'`), 1, 'admins still see it');
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add2}', true, null, null)`);
    assert.equal(count('T2', 'launch_test_attempts'), 1);
  });
  test('edit a test: whitelisted fields only, https links only', () => {
    const t = TEST('shop-wallet');
    assert.ok(!err(doAs('ADMIN', `select public.launch_test_admin_update_test('${t}', '{"expected_max_spend_pence": 150, "target_note":"Buy the £1.50 tea towel", "target_url":"https://oneshetland.com/shop/x", "help_text":"We will refund you.", "steps":["a","b"], "sort_order": 55}')`)));
    assert.equal(scalar(`select expected_max_spend_pence || '|' || target_note || '|' || help_text || '|' || cardinality(steps) || '|' || sort_order from public.launch_tests where id='${t}'`), '150|Buy the £1.50 tea towel|We will refund you.|2|55');
    assert.match(doAs('ADMIN', `select public.launch_test_admin_update_test('${t}', '{"programme_id":"${PROG()}"}')`), /Cannot edit/);
    assert.ok(err(doAs('ADMIN', `select public.launch_test_admin_update_test('${t}', '{"target_url":"javascript:alert(1)"}')`)), 'only https links');
    assert.ok(err(doAs('ADMIN', `select public.launch_test_admin_update_test('${t}', '{"money_test_type":"bitcoin"}')`)));
    doAs('ADMIN', `select public.launch_test_admin_update_test('${t}', '{"expected_max_spend_pence": 200, "target_url": null, "help_text": null, "sort_order": 50}')`);
  });
  test('issue workflow and retest: the original failed attempt is preserved, a passing re-check resolves it', () => {
    const t = TEST('directory-map');
    const bad = start('T2', 'directory-map', S.s2);          // resumes b1
    assert.equal(bad, S.b1);
    submit('T2', S.b1, 'issue', '', 'The map was a grey box');
    assert.equal(scalar(`select review_state from public.launch_test_attempts where id='${S.b1}'`), 'open');
    assert.ok(!err(doAs('ADMIN', `select public.launch_test_admin_review('${S.b1}', 'fix_pending', 'Fix is on its way')`)));
    assert.equal(scalar(`select review_state from public.launch_test_attempts where id='${S.b1}'`), 'fix_pending');
    assert.ok(!err(doAs('ADMIN', `select public.launch_test_admin_request_retest('${S.b1}', 'Please check again on the new build')`)));
    assert.equal(scalar(`select retest_requested || '|' || review_state from public.launch_test_attempts where id='${S.b1}'`), 'true|ready_for_retest');
    const again = start('T2', 'directory-map', S.s2);
    assert.notEqual(again, S.b1);
    submit('T2', again, 'passed', 'Map shows now');
    assert.equal(scalar(`select review_state || '|' || retest_requested || '|' || status from public.launch_test_attempts where id='${S.b1}'`), 'resolved|false|issue');
    assert.equal(scalar(`select count(*) from public.launch_test_attempts where test_id='${t}' and user_id='${ids.T2}'`), '2');
    assert.match(doAs('ADMIN', `select public.launch_test_admin_review('${again}', 'resolved', null)`), /Only an issue or a blocked/);
    assert.match(doAs('ADMIN', `select public.launch_test_admin_review('${S.b1}', 'bogus', null)`), /Unknown review state/);
  });
  test('the matrix feed returns the LATEST attempt per test × tester × phone type, with how many attempts there were', () => {
    const out = tryAs('ADMIN', `select test_id, status, attempts_total from public.launch_test_admin_latest('${PROG()}') where user_id='${ids.T2}' order by test_id`);
    assert.match(out, /\|passed\|2/);
    assert.equal(Number(lastRow(tryAs('ADMIN', `select count(*) from public.launch_test_admin_latest('${PROG()}') where user_id='${ids.T1}'`))), 9);
  });
});

describe('5 · private screenshot evidence', () => {
  const png = (attempt: string) => `${attempt}/${uuidv4()}.png`;
  const uuidv4 = () => scalar('select gen_random_uuid()');
  const putAs = (w: Who, name: string, bucket = 'launch-test-evidence') => tryAs(w, `insert into storage.objects (bucket_id, name, owner) values ('${bucket}', '${name}', ${w === 'anon' ? 'null' : `'${ids[w as 'T1']}'`})`);
  let att1 = '', att2 = '';
  before(() => { att1 = start('T1', 'sign-in-account', S.s1, true); att2 = start('T2', 'home-navigation', S.s2); });

  test('an owner can store an image under THEIR attempt, with a generated name', () => {
    const name = png(att1);
    assert.ok(!err(doAs('T1', `insert into storage.objects (bucket_id, name, owner) values ('launch-test-evidence', '${name}', '${ids.T1}')`)));
    S.obj1 = name;
    assert.equal(scalar(`select count(*) from storage.objects where name='${name}'`), '1');
  });
  test('…but not under someone else\'s attempt, not with a hand-made or unsafe name, and not when disabled', () => {
    assert.ok(rls(putAs('T1', png(att2))), 'another tester\'s attempt');
    assert.ok(rls(putAs('T1', png(uuidv4()))), 'an attempt that does not exist');
    for (const bad of [`${att1}/evidence.png`, `${att1}/../${att2}/x.png`, `${att1}/${uuidv4()}.exe`, `${att1}/${uuidv4()}.svg`, `${att1}/${uuidv4()}.png/extra`, `${att1}/${uuidv4()}.PNG`, `x/${uuidv4()}.png`]) {
      assert.ok(rls(putAs('T1', bad)), bad);
    }
    assert.ok(denied(putAs('anon', png(att1))), 'anon');
    assert.ok(rls(putAs('USER', png(att1))), 'a signed-in non-tester');
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add1}', false, null, null)`);
    assert.ok(rls(putAs('T1', png(att1))), 'a disabled tester');
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${S.add1}', true, null, null)`);
  });
  test('other buckets are untouched by these policies', () => {
    assert.ok(!/launch-test-evidence/.test(scalar(`select string_agg(coalesce(qual,''), ' ') from pg_policies where schemaname='storage' and policyname not like 'launch-test-evidence %'`)));
  });
  test('reading: the owner and administrators only', () => {
    assert.equal(count('T1', 'launch_test_attachments'), 0);
    assert.equal(Number(lastRow(tryAs('T1', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))), 1);
    assert.equal(Number(lastRow(tryAs('T2', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))), 0);
    assert.equal(Number(lastRow(tryAs('USER', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))), 0);
    assert.equal(Number(lastRow(tryAs('ADMIN', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))), 1);
    assert.ok(denied(tryAs('anon', `select count(*) from storage.objects`)) || Number(lastRow(tryAs('anon', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))) === 0);
  });
  test('nobody overwrites; only administrators delete', () => {
    assert.equal(Number(lastRow(tryAs('T1', `with u as (update storage.objects set metadata='{}' where name='${S.obj1}' returning 1) select count(*) from u`))), 0);
    assert.equal(Number(lastRow(tryAs('T1', `with d as (delete from storage.objects where name='${S.obj1}' returning 1) select count(*) from d`))), 0);
    assert.equal(Number(lastRow(tryAs('ADMIN', `with u as (update storage.objects set metadata='{}' where name='${S.obj1}' returning 1) select count(*) from u`))), 0);
    assert.equal(Number(lastRow(tryAs('ADMIN', `with d as (delete from storage.objects where name='${S.obj1}' returning 1) select count(*) from d`))), 1);
  });
  test('registering evidence: the object must exist, belong to the attempt, be a generated image name, and at most four per result', () => {
    const ok_ = png(att1);
    assert.match(doAs('T1', `select public.launch_test_add_attachment('${att1}','${ok_}','image/png',1000)`), /has not been uploaded/);
    doAs('T1', `insert into storage.objects (bucket_id, name, owner) values ('launch-test-evidence', '${ok_}', '${ids.T1}')`);
    assert.match(lastRow(doAs('T1', `select public.launch_test_add_attachment('${att1}','${ok_}','image/png',1000)`)), /^[0-9a-f-]{36}$/);
    assert.match(doAs('T1', `select public.launch_test_add_attachment('${att1}','${ok_}','image/png',1000)`), /duplicate|unique/i, 'the same object twice');
    assert.match(doAs('T1', `select public.launch_test_add_attachment('${att1}','${att1}/evidence.png','image/png',1000)`), /not valid/);
    assert.match(doAs('T1', `select public.launch_test_add_attachment('${att1}','${ok_}x','image/png',1000)`), /not valid/);
    assert.ok(err(doAs('T1', `select public.launch_test_add_attachment('${att1}','${png(att1)}','application/pdf',1000)`)));
    assert.ok(err(doAs('T1', `select public.launch_test_add_attachment('${att1}','${png(att1)}','image/png',99999999)`)));
    for (let i = 0; i < 3; i++) { const n = png(att1); doAs('T1', `insert into storage.objects (bucket_id, name, owner) values ('launch-test-evidence', '${n}', '${ids.T1}')`); doAs('T1', `select public.launch_test_add_attachment('${att1}','${n}','image/png',1000)`); }
    const extra = png(att1); doAs('T1', `insert into storage.objects (bucket_id, name, owner) values ('launch-test-evidence', '${extra}', '${ids.T1}')`);
    assert.match(doAs('T1', `select public.launch_test_add_attachment('${att1}','${extra}','image/png',1000)`), /up to 4 screenshots/);
    assert.equal(count('T1', 'launch_test_attachments'), 4);
    assert.equal(count('T2', 'launch_test_attachments'), 0);
    assert.equal(count('ADMIN', 'launch_test_attachments'), 4);
    assert.match(doAs('T2', `select public.launch_test_add_attachment('${att1}','${extra}','image/png',1000)`), /not available/);
  });
});

describe('6 · mutation controls: loosen a protection and the matching check fails', () => {
  const restore = () => {
    db.raw(`drop policy if exists "launch attempts read" on public.launch_test_attempts;
            create policy "launch attempts read" on public.launch_test_attempts for select to authenticated
              using (public.is_admin() or (user_id = auth.uid() and public.launch_test_is_enabled_tester(programme_id)));`);
  };
  test('a permissive attempts policy lets T2 read T1\'s results (and the isolation check notices)', () => {
    db.raw(`drop policy "launch attempts read" on public.launch_test_attempts; create policy "launch attempts read" on public.launch_test_attempts for select to authenticated using (true);`);
    try { assert.ok(count('T2', 'launch_test_attempts', `user_id='${ids.T1}'`) > 0); } finally { restore(); }
    assert.equal(count('T2', 'launch_test_attempts', `user_id='${ids.T1}'`), 0);
  });
  test('granting INSERT on attempts reopens direct forgery', () => {
    db.raw(`grant insert on public.launch_test_attempts to authenticated`);
    try { assert.ok(!denied(tryAs('T1', `insert into public.launch_test_attempts (programme_id,test_id,session_id,user_id,status,completed_at) values ('${PROG()}','${TEST('home-navigation')}','${S.s1}','${ids.T1}','passed',now())`))); }
    finally { db.raw(`revoke insert on public.launch_test_attempts from authenticated`); }
    assert.ok(denied(tryAs('T1', `insert into public.launch_test_attempts (programme_id,test_id,session_id,user_id) values ('${PROG()}','${TEST('home-navigation')}','${S.s1}','${ids.T1}')`)));
  });
  test('removing the immutability trigger lets a submitted result be rewritten', () => {
    db.raw(`alter table public.launch_test_attempts disable trigger tg_launch_attempt_immutable`);
    try { assert.ok(!err(db.raw(`update public.launch_test_attempts set tester_note='rewritten' where id='${S.a1}'`))); }
    finally { db.raw(`alter table public.launch_test_attempts enable trigger tg_launch_attempt_immutable; update public.launch_test_attempts set tester_note='all fine' where id='${S.a1}' and false`); }
    assert.match(db.raw(`update public.launch_test_attempts set tester_note='again' where id='${S.a1}'`), /cannot be edited/);
  });
  test('a permissive storage read policy exposes one tester\'s evidence to another', () => {
    db.raw(`drop policy "launch-test-evidence read" on storage.objects; create policy "launch-test-evidence read" on storage.objects for select to authenticated using (bucket_id = 'launch-test-evidence');`);
    try { assert.ok(Number(lastRow(tryAs('T2', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))) > 0); }
    finally {
      db.raw(`drop policy "launch-test-evidence read" on storage.objects;
        create policy "launch-test-evidence read" on storage.objects for select to authenticated using (bucket_id = 'launch-test-evidence' and (public.is_admin() or exists (select 1 from public.launch_test_attempts a where a.id::text = (storage.foldername(objects.name))[1] and a.user_id = auth.uid() and public.launch_test_is_enabled_tester(a.programme_id))));`);
    }
    assert.equal(Number(lastRow(tryAs('T2', `select count(*) from storage.objects where bucket_id='launch-test-evidence'`))), 0);
  });
  test('dropping the money check lets a real-money test start unacknowledged (the acknowledgement test would fail)', () => {
    const def = db.raw(`select pg_get_functiondef('public.launch_test_start(uuid,uuid,boolean)'::regprocedure)`).trim();
    const weakened = def.replace(/if v_test\.money_test_type <> 'none' and p_ack is not true then[\s\S]*?end if;/, '');
    assert.notEqual(weakened, def, 'the money check was not found to remove');
    db.raw(weakened);
    try { const a = lastRow(doAs('T2', `select public.launch_test_start('${TEST('hub-donation')}','${S.s2}',false)`)); assert.match(a, /^[0-9a-f-]{36}$/); }
    finally { db.raw(def); }
    assert.match(doAs('T2', `select public.launch_test_start('${TEST('shop-card')}','${S.s2}',false)`), /real transaction/);
  });
});

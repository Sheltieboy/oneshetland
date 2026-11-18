/**
 * editions-web-handoff.node.test.ts — ISOLATED Postgres only. The hash-only code table, mint rules (role, switches, destination allowlist), the atomic single-use consume,
 * re-checks at redeem time (role removed, switch off, closed account), expiry, races, audit hygiene, privileges and the rollback. Real Supabase Auth and the website are not involved
 * (those are covered by the edge-function unit tests and the web route tests).
 * Run: ISOLATED_ONLY=editions-web-handoff npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, draftEdition, last } from './_support/editions-env.ts';

let E: Env;
let S: ReturnType<typeof seed>;
const O = { BIZ: '', HUB: '', BIZ2: '' };
let ED_BIZ = '', ED_BIZ2 = '', BIZ_SLUG = '', ED_SLUG = '';
const bad = (o: string) => /ERROR/.test(o);
const hint = (o: string) => o.match(/HINT:\s+(\S+)/)?.[1] ?? '';
const svc2 = (sql: string) => E.db.raw(`begin; set local role service_role; ${sql}; commit;`);
const svc = (sql: string) => E.db.raw(`begin; set local role service_role; ${sql}; commit;`);
let n = 0;
const sha = (code: string) => E.q(`select encode(sha256('${code}'::bytea), 'hex')`);
/** mint as the edge function would: a fresh code, its hash stored. Returns { out, code, hash } */
let keepRows = false;
function mint(who: keyof typeof USERS, org: string, dest: string, edition: string | null = null, platform = 'ios') {
  if (!keepRows) E.sup(`delete from public.edition_web_handoff_codes where user_id='${USERS[who]}'`);   // the per-user brake is tested on its own below
  const code = `zz-handoff-code-${++n}-${'x'.repeat(30)}`;
  const hash = sha(code);
  const out = svc(`select public.edition_handoff_mint('${USERS[who]}', '${org}', '${dest}', ${edition ? `'${edition}'` : 'null'}, '${platform}', '${hash}', ${chk(hash)})`);
  return { out, code, hash };
}
const NUM = '4821';
const chk = (hash: string, num = NUM) => `encode(sha256(('${hash}:${num}')::bytea), 'hex')`;
const redeem = (hash: string, num = NUM) => svc(`select public.edition_handoff_redeem('${hash}', ${chk(hash, num)})`);
const finish = (hash: string, ok = true, reason = 'x_y') => last(svc(`select public.edition_handoff_finish('${hash}', ${ok}, '${reason}')`));
const res = (out: string) => { try { return JSON.parse(last(out)); } catch { return null; } };
const on = (v: 'on' | 'off', k = 'ios') => E.sup(`insert into admin_config (key, value, category) values ('editions.app.handoff_${k}','${v}','editions') on conflict (key) do update set value='${v}'`);
const audit = (action: string) => Number(E.q(`select count(*) from public.edition_audit_log where action='${action}'`));

before(() => {
  E = new Env('editionswebhandoff');
  S = seed(E);
  O.BIZ = enter(E, 'BIZ_OWNER', 'business', S.BIZ);
  O.HUB = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  O.BIZ2 = enter(E, 'BIZ2_OWNER', 'business', S.BIZ2);
  ED_BIZ = draftEdition(E, 'BIZ_OWNER', O.BIZ, 'zz-handoff-fest', 'ZZ Handoff Fest');
  ED_BIZ2 = draftEdition(E, 'BIZ2_OWNER', O.BIZ2, 'zz-handoff-other', 'ZZ Other Fest');
  BIZ_SLUG = E.q(`select slug from public.edition_organisers where id='${O.BIZ}'`); ED_SLUG = 'zz-handoff-fest';
  E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.HELPER}','editor'),('${O.BIZ}','${USERS.EDITOR}','editor') on conflict do nothing`);
  E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.HUB_MEMBER}','admin') on conflict do nothing`);
  E.sup(`delete from admin_config where key like 'editions.app.handoff_%'`);
});
after(() => E?.drop());

describe('privileges: only the service role can touch any of it', () => {
  test('the table is closed to every client role and holds a hash, never a code', () => {
    for (const who of ['anon', 'BIZ_OWNER'] as const) assert.ok(bad(E.try(who, `select * from public.edition_web_handoff_codes`)), who);
    assert.ok(bad(E.try('BIZ_OWNER', `insert into public.edition_web_handoff_codes (code_hash, check_hash, user_id, organiser_id, destination, platform, expires_at) values (repeat('a',64),repeat('c',64),'${USERS.BIZ_OWNER}','${O.BIZ}','dashboard','ios',now()+interval '30 seconds')`)));
    assert.equal(E.q(`select count(*) from information_schema.columns where table_name='edition_web_handoff_codes' and column_name in ('code','token','secret','url')`), '0');
    assert.equal(E.q(`select count(*) from pg_class where relname='edition_web_handoff_codes' and relrowsecurity`), '1');
  });
  test('mint, peek, redeem and the identity helper cannot be called by anon or signed-in users (nor the helper by anyone)', () => {
    const calls = [`public.edition_handoff_mint('${USERS.BIZ_OWNER}','${O.BIZ}','dashboard',null,'ios',repeat('a',64),repeat('b',64))`, `public.edition_handoff_peek(repeat('a',64))`, `public.edition_handoff_redeem(repeat('a',64),repeat('b',64))`, `public.edition_handoff_finish(repeat('a',64),true,'x')`, `public.edition_handoff_refusal('${USERS.BIZ_OWNER}','${O.BIZ}','ios')`.replace(/^$/, ''), `public.edition_handoff_path('dashboard','${O.BIZ}',null)`];
    assert.match(svc(`select public.edition_handoff_refusal('${USERS.BIZ_OWNER}','${O.BIZ}','ios')`), /permission denied/, 'not even the service role');
    for (const c of calls) for (const who of ['anon', 'BIZ_OWNER'] as const) assert.match(E.try(who, `select ${c}`), /permission denied/, `${who} ${c}`);
    assert.match(svc(`select public.edition_handoff_as('${USERS.BIZ_OWNER}')`), /permission denied/);
    assert.match(E.try('BIZ_OWNER', `select public.edition_handoff_as('${USERS.BIZ2_OWNER}')`), /permission denied/);
  });
  test('the rate-limit policies exist for every action the function claims', () => {
    for (const a of ['editions_handoff_mint', 'editions_handoff_mint_day', 'editions_handoff_redeem_ip', 'editions_handoff_redeem_code', 'editions_handoff_view_ip', 'editions_handoff_view_code', 'editions_handoff_secret_fail']) assert.equal(E.q(`select count(*) from public.rate_limit_policies where action='${a}'`), '1', a);
  });
});

describe('mint: switches', () => {
  test('refused by default (switch absent = off), whichever the platform', () => { for (const p of ['ios', 'android']) { const m = mint('BIZ_OWNER', O.BIZ, 'dashboard', null, p); assert.ok(bad(m.out)); assert.equal(hint(m.out), 'handoff_off'); } });
  test('per platform: iOS on does not enable Android', () => { on('on', 'ios'); assert.ok(!bad(mint('BIZ_OWNER', O.BIZ, 'dashboard', null, 'ios').out)); const a = mint('BIZ_OWNER', O.BIZ, 'dashboard', null, 'android'); assert.equal(hint(a.out), 'handoff_off'); on('off', 'ios'); });
  test('refused whenever Editions itself is off', () => { on('on'); E.sup(`update admin_config set value='false' where key='editions.enabled'`); assert.equal(hint(mint('BIZ_OWNER', O.BIZ, 'dashboard').out), 'feature_off'); E.sup(`update admin_config set value='true' where key='editions.enabled'`); });
  test('junk values do not turn it on', () => { for (const v of ['true', 'ON', '1', 'yes', '']) { E.sup(`update admin_config set value='${v}' where key='editions.app.handoff_ios'`); assert.equal(hint(mint('BIZ_OWNER', O.BIZ, 'dashboard').out), 'handoff_off', v); } on('on'); });
});

describe('mint: who may', () => {
  test('owners (Business and Hub), Hub committee and administrators may; the code is stored hashed and bound', () => {
    on('on');
    const cases: [keyof typeof USERS, string][] = [['BIZ_OWNER', O.BIZ], ['HUB_OWNER', O.HUB], ['HUB_COMMITTEE', O.HUB], ['HUB_MEMBER', O.BIZ]];
    for (const [who, org] of cases) { const m = mint(who, org, 'dashboard'); assert.ok(!bad(m.out), `${who}: ${m.out.slice(0, 200)}`); }
    const m = mint('BIZ_OWNER', O.BIZ, 'editions');
    assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where code_hash='${m.hash}' and user_id='${USERS.BIZ_OWNER}' and organiser_id='${O.BIZ}' and destination='editions' and platform='ios' and used_at is null`), '1');
    assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where position('${m.code}' in code_hash::text) > 0`), '0');
    assert.equal(E.q(`select expires_at - created_at from public.edition_web_handoff_codes where code_hash='${m.hash}'`), '00:01:00');
  });
  test('editors, bare helpers, plain members, strangers and other organisers\' owners are refused', () => {
    for (const [who, org] of [['HELPER', O.BIZ], ['EDITOR', O.BIZ], ['HUB_MEMBER', O.HUB], ['STRANGER', O.BIZ], ['BIZ2_OWNER', O.BIZ], ['HUB2_OWNER', O.HUB], ['BIZ_OWNER', O.HUB]] as [keyof typeof USERS, string][]) {
      const m = mint(who, org, 'dashboard'); assert.ok(bad(m.out), `${who} on ${org}`); assert.equal(hint(m.out), 'not_allowed');
      assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where code_hash='${m.hash}'`), '0');
    }
  });
  test('a suspended organiser, a closed account and an unknown user are refused', () => {
    E.sup(`update public.edition_organisers set status='suspended' where id='${O.BIZ2}'`); assert.equal(hint(mint('BIZ2_OWNER', O.BIZ2, 'dashboard').out), 'organiser_unavailable'); E.sup(`update public.edition_organisers set status='verified' where id='${O.BIZ2}'`);
    E.sup(`update public.profiles set deleted_at = now() where id='${USERS.BIZ2_OWNER}'`); assert.equal(hint(mint('BIZ2_OWNER', O.BIZ2, 'dashboard').out), 'account_closed'); E.sup(`update public.profiles set deleted_at = null where id='${USERS.BIZ2_OWNER}'`);
    const code = 'zz-no-such-user-code-xxxxxxxxxxxxxxxxxxxxxxxx';
    assert.ok(bad(svc(`select public.edition_handoff_mint('99000000-0000-4000-8000-000000000099','${O.BIZ}','dashboard',null,'ios','${sha(code)}',repeat('d',64))`)));
  });
});

describe('destination allowlist, server side', () => {
  const ok = ['dashboard', 'editions', 'team', 'profile'];
  test('each allowed key resolves to the organiser area, built from slugs', () => {
    for (const k of ok) assert.equal(E.q(`select public.edition_handoff_path('${k}','${O.BIZ}',null)`), `/organise/${BIZ_SLUG}${k === 'dashboard' ? '' : '/' + k}`);
    assert.equal(E.q(`select public.edition_handoff_path('edition','${O.BIZ}','${ED_BIZ}')`), `/organise/${BIZ_SLUG}/editions/${ED_SLUG}`);
  });
  test('packages, promote, checkout, payments, participation, members, free URLs and paths are refused at mint', () => {
    for (const d of ['packages', 'package', 'promote', 'promotion', 'checkout', 'payments', 'participation', 'members', 'brand', 'https://evil.example/', '//evil.example', '/organise/x/packages', '../../account', "dashboard'; drop table x;--", '']) {
      const m = mint('BIZ_OWNER', O.BIZ, d); assert.ok(bad(m.out), `"${d}" should be refused`);
      assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where code_hash='${m.hash}'`), '0');
    }
  });
  test('the edition key needs an Edition of THAT organiser; others never store an edition', () => {
    assert.ok(bad(mint('BIZ_OWNER', O.BIZ, 'edition', null).out));
    assert.ok(bad(mint('BIZ_OWNER', O.BIZ, 'edition', ED_BIZ2).out), 'another organiser\'s Edition');
    assert.ok(bad(mint('BIZ_OWNER', O.BIZ, 'edition', '99000000-0000-4000-8000-000000000099').out));
    const m = mint('BIZ_OWNER', O.BIZ, 'edition', ED_BIZ); assert.ok(!bad(m.out), m.out.slice(0, 200));
    const d = mint('BIZ_OWNER', O.BIZ, 'dashboard', ED_BIZ); assert.ok(!bad(d.out));
    assert.equal(E.q(`select edition_id is null from public.edition_web_handoff_codes where code_hash='${d.hash}'`), 't');
  });
  test('table constraints hold even for a superuser insert: lifetime at most 60 seconds, closed key list', () => {
    const ins = (dest: string, secs: number) => E.sup(`insert into public.edition_web_handoff_codes (code_hash, check_hash, user_id, organiser_id, destination, platform, created_at, expires_at) values (repeat('b',64),repeat('c',64),'${USERS.BIZ_OWNER}','${O.BIZ}','${dest}','ios', now(), now() + interval '${secs} seconds')`);
    assert.ok(bad(ins('dashboard', 61))); assert.ok(bad(ins('packages', 30))); assert.ok(bad(ins('promote', 30))); assert.ok(bad(ins('edition', 30)), 'edition key without an edition');
  });
});

describe('redeem: single use, expiry, re-checks', () => {
  test('first use returns the user and the destination; the second use, the third, and an unknown or malformed code are all refused', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'edition', ED_BIZ);
    const r = res(redeem(m.hash)); assert.equal(r.ok, true); assert.equal(r.user_id, USERS.BIZ_OWNER); assert.equal(r.path, `/organise/${BIZ_SLUG}/editions/${ED_SLUG}`);
    assert.deepEqual(res(redeem(m.hash)), { ok: false, reason: 'invalid' }); assert.deepEqual(res(redeem(m.hash)), { ok: false, reason: 'invalid' });
    for (const h of [sha('never-minted'), 'nothex', '', 'a'.repeat(63), "x'; drop table public.edition_web_handoff_codes;--"]) assert.notEqual(res(redeem(h))?.ok, true, h);
    assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes`) !== '0', true, 'the table survived');
  });
  test('the response never contains the code or its hash, and no row keeps either outside code_hash', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); const out = redeem(m.hash);
    assert.ok(!out.includes(m.code) && !out.includes(m.hash));
    assert.equal(E.q(`select count(*) from public.edition_audit_log where detail::text like '%${m.hash}%' or detail::text like '%${m.code}%'`), '0');
  });
  test('a code is spent whether or not it was good enough, and peek never consumes', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    for (let i = 0; i < 3; i++) assert.equal(last(svc(`select public.edition_handoff_peek('${m.hash}')`)), USERS.BIZ_OWNER);
    assert.equal(E.q(`select used_at is null from public.edition_web_handoff_codes where code_hash='${m.hash}'`), 't');
    assert.equal(res(redeem(m.hash)).ok, true);
    assert.equal(last(svc(`select coalesce(public.edition_handoff_peek('${m.hash}')::text,'none')`)), 'none');
  });
  test('expired codes are refused by the DATABASE clock (no client time is ever consulted)', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    E.sup(`update public.edition_web_handoff_codes set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where code_hash='${m.hash}'`);
    assert.equal(res(redeem(m.hash)).ok, false);
    assert.equal(last(svc(`select coalesce(public.edition_handoff_peek('${m.hash}')::text,'none')`)), 'none');
    assert.equal(E.q(`select used_at is null from public.edition_web_handoff_codes where code_hash='${m.hash}'`), 't', 'an expired code is not "used"');
    const edge = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    E.sup(`update public.edition_web_handoff_codes set created_at = now() - interval '61 seconds', expires_at = now() - interval '1 second' where code_hash='${edge.hash}'`);
    assert.equal(res(redeem(edge.hash)).ok, false, 'one second past');
  });
  test('role removed between mint and redeem: refused, code spent, refusal audited', () => {
    E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.STRANGER}','admin') on conflict (organiser_id, user_id) do update set role='admin'`);
    const m = mint('STRANGER', O.BIZ, 'dashboard'); assert.ok(!bad(m.out), m.out.slice(0, 200));
    const before = audit('app_handoff_refused');
    E.sup(`delete from public.edition_organiser_members where organiser_id='${O.BIZ}' and user_id='${USERS.STRANGER}'`);
    const r = res(redeem(m.hash)); assert.deepEqual(r, { ok: false, reason: 'not_allowed' });
    assert.equal(audit('app_handoff_refused'), before + 1);
    assert.equal(E.q(`select used_at is not null from public.edition_web_handoff_codes where code_hash='${m.hash}'`), 't');
    assert.equal(res(redeem(m.hash)).ok, false);
  });
  test('demoted to editor between mint and redeem: refused', () => {
    E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${O.BIZ}','${USERS.STRANGER}','admin') on conflict (organiser_id, user_id) do update set role='admin'`);
    const m = mint('STRANGER', O.BIZ, 'dashboard'); E.sup(`update public.edition_organiser_members set role='editor' where organiser_id='${O.BIZ}' and user_id='${USERS.STRANGER}'`);
    assert.equal(res(redeem(m.hash)).reason, 'not_allowed'); E.sup(`delete from public.edition_organiser_members where organiser_id='${O.BIZ}' and user_id='${USERS.STRANGER}'`);
  });
  test('Hub committee removed between mint and redeem: refused', () => {
    const m = mint('HUB_COMMITTEE', O.HUB, 'dashboard'); assert.ok(!bad(m.out));
    E.sup(`update hub_members set status='removed' where hub_id='${S.HUB}' and user_id='${USERS.HUB_COMMITTEE}'`);
    assert.equal(res(redeem(m.hash)).reason, 'not_allowed'); E.sup(`update hub_members set status='active' where hub_id='${S.HUB}' and user_id='${USERS.HUB_COMMITTEE}'`);
  });
  test('switch turned off (kill switch), Editions turned off, organiser suspended, account closed: each refuses an already-minted code', () => {
    const attempt = (change: string, undo: string, why: string) => { const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); assert.ok(!bad(m.out), m.out.slice(0, 200)); E.sup(change); const r = res(redeem(m.hash)); E.sup(undo); assert.equal(r.ok, false, why); assert.equal(r.reason, why); };
    attempt(`update admin_config set value='off' where key='editions.app.handoff_ios'`, `update admin_config set value='on' where key='editions.app.handoff_ios'`, 'handoff_off');
    attempt(`update admin_config set value='false' where key='editions.enabled'`, `update admin_config set value='true' where key='editions.enabled'`, 'feature_off');
    attempt(`update public.edition_organisers set status='suspended' where id='${O.BIZ}'`, `update public.edition_organisers set status='verified' where id='${O.BIZ}'`, 'organiser_unavailable');
    attempt(`update public.profiles set deleted_at=now() where id='${USERS.BIZ_OWNER}'`, `update public.profiles set deleted_at=null where id='${USERS.BIZ_OWNER}'`, 'account_closed');
  });
  test('an Edition that moved or vanished between mint and redeem gives no destination', () => {
    const ed = draftEdition(E, 'BIZ_OWNER', O.BIZ, 'zz-handoff-temp', 'ZZ Temp'); const m = mint('BIZ_OWNER', O.BIZ, 'edition', ed);
    // the Edition is deleted: the code goes with it (cascade) and there is nothing to redeem; if the row ever survived, the path lookup still yields no destination
    E.sup(`delete from public.editions where id='${ed}'`);
    assert.equal(res(redeem(m.hash)).ok, false);
    const m2 = mint('BIZ_OWNER', O.BIZ, 'dashboard'); E.sup(`update public.edition_web_handoff_codes set destination='edition', edition_id='${ED_BIZ2}' where code_hash='${m2.hash}'`);
    assert.deepEqual(res(redeem(m2.hash)), { ok: false, reason: 'bad_destination' }, 'an Edition of another organiser is never a destination');
  });
  test('a code minted for one user is only ever redeemed AS that user (the user is read from the row, not supplied)', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); const r = res(redeem(m.hash)); assert.equal(r.user_id, USERS.BIZ_OWNER);
    assert.equal(E.q(`select count(*) from pg_proc where proname='edition_handoff_redeem' and pg_get_function_arguments(oid) <> 'p_code_hash text, p_check_hash text'`), '0');
  });
});

describe('check number (login-CSRF defence): wrong numbers, burning, binding', () => {
  test('the right number redeems; the code row stores only a hash of code+number', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where code_hash='${m.hash}' and check_hash <> '${NUM}' and position('${NUM}' in check_hash) = 0 and check_hash ~ '^[0-9a-f]{64}$'`), '1');
    assert.equal(res(redeem(m.hash)).ok, true);
  });
  test('a wrong number is refused, counted, does not consume the code, and the right number still works afterwards', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    assert.deepEqual(res(redeem(m.hash, '0000')), { ok: false, reason: 'bad_number', left: 2 });
    assert.equal(E.q(`select used_at is null and check_fails = 1 from public.edition_web_handoff_codes where code_hash='${m.hash}'`), 't');
    assert.equal(res(redeem(m.hash)).ok, true);
  });
  test('THREE wrong numbers burn the code: the right number is refused afterwards, a refusal is audited, and no session data was ever returned', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); const outs = ['1111', '2222', '3333'].map((n) => res(redeem(m.hash, n)));
    assert.deepEqual(outs.map((o) => o.left), [2, 1, 0]);
    for (const o of outs) assert.equal(o.ok, false);
    assert.deepEqual(res(redeem(m.hash)), { ok: false, reason: 'invalid' }); assert.equal(last(svc(`select coalesce(public.edition_handoff_peek('${m.hash}')::text,'none')`)), 'none');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='app_handoff_refused' and detail->>'reason'='check_number_burned'`) !== '0', true);
  });
  test('a number from another code never works (it is bound to its own code)', () => {
    const a = mint('BIZ_OWNER', O.BIZ, 'dashboard'); const b = mint('HUB_OWNER', O.HUB, 'dashboard');
    assert.equal(res(svc2(`select public.edition_handoff_redeem('${a.hash}', ${chk(b.hash)})`)).reason, 'bad_number');
  });
  test('a malformed check hash is refused without counting or consuming', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); assert.equal(res(svc2(`select public.edition_handoff_redeem('${m.hash}', 'zzz')`)).reason, 'invalid');
    assert.equal(E.q(`select used_at is null and check_fails = 0 from public.edition_web_handoff_codes where code_hash='${m.hash}'`), 't');
  });
  test('parallel wrong guesses cannot get more than three tries (row-locked counter)', async () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => E.db.bg(`begin; set local role service_role; select public.edition_handoff_redeem('${m.hash}', ${chk(m.hash, String(1000 + i))}); commit;`)));
    assert.equal(outs.filter((o) => /bad_number/.test(o.stdout)).length, 3, outs.map((o) => o.stdout).join('|'));
    assert.equal(res(redeem(m.hash)).ok, false);
  });
});

describe('audit ordering: "redeemed" only after the session exists', () => {
  test('redeem alone writes no redeemed row; finish(ok) writes exactly one, once', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); const before = audit('app_handoff_redeemed');
    assert.equal(res(redeem(m.hash)).ok, true); assert.equal(audit('app_handoff_redeemed'), before, 'not yet');
    assert.equal(finish(m.hash), 't'); assert.equal(audit('app_handoff_redeemed'), before + 1);
    assert.equal(finish(m.hash), 'f', 'a second finish is a no-op'); assert.equal(audit('app_handoff_redeemed'), before + 1);
  });
  test('finish(false, reason) records a refusal with that reason and never a redeemed row; reasons must be plain codes', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); assert.equal(res(redeem(m.hash)).ok, true); const b = audit('app_handoff_redeemed');
    assert.equal(finish(m.hash, false, 'Bad Reason!'), 'f'); assert.equal(finish(m.hash, false, 'unconfirmed'), 't');
    assert.equal(audit('app_handoff_redeemed'), b); assert.equal(E.q(`select count(*) from public.edition_audit_log where action='app_handoff_refused' and detail->>'reason'='unconfirmed'`), '1');
  });
  test('finish cannot be used on an unredeemed, unknown or already-refused code', () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); assert.equal(finish(m.hash), 'f'); assert.equal(finish(sha('nope')), 'f');
    E.sup(`update admin_config set value='off' where key='editions.app.handoff_ios'`); assert.equal(res(redeem(m.hash)).reason, 'handoff_off'); on('on');
    assert.equal(finish(m.hash), 'f', 'the database already wrote its refusal');
  });
});

describe('route-name slugs cannot be organiser or Edition addresses', () => {
  test('the new names are refused by the table trigger for organisers and Editions', () => {
    // slugs are immutable once set, so the new-row path is what matters: inserts, as the real user would make them
    for (const n of ['team', 'profile', 'packages', 'promote', 'report', 'members', 'payments', 'new', 'editions']) {
      assert.match(E.do('BIZ2_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${O.BIZ2}','${n}','T','S','multi_day',current_date+20,current_date+22)`), /reserved/, `edition ${n}`);
    }
    for (const n of ['team', 'promote', 'members']) assert.match(E.sup(`insert into public.edition_organisers (slug, name, status) values ('${n}','ZZ Route Name','pending')`), /reserved/, `organiser ${n}`);
    assert.equal(E.q(`select slug from public.edition_organisers where id='${O.BIZ2}'`) !== 'team', true);
  });
  test('the generator skips them: a Business called "Team" or "Promote" gets a different address', () => {
    for (const name of ['Team', 'Promote', 'Members']) {
      const b = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${USERS.STRANGER}','${name}','food_drink','1 Commercial Street, Lerwick',true) returning id`));
      const out = last(E.do('STRANGER', `select (public.edition_ensure_organiser('business', '${b}') ->> 'slug')`));
      assert.match(out, /^[a-z0-9-]+-editions/, `${name}: ${out}`);
    }
  });
  test('a pre-existing route-named slug yields no destination', () => {
    E.sup(`alter table public.edition_organisers disable trigger user; update public.edition_organisers set slug='team' where id='${O.BIZ2}'; alter table public.edition_organisers enable trigger user;`);
    assert.equal(E.q(`select coalesce(public.edition_handoff_path('dashboard','${O.BIZ2}',null),'none')`), 'none');
    E.sup(`alter table public.edition_organisers disable trigger user; update public.edition_organisers set slug='zz-biz2-back' where id='${O.BIZ2}'; alter table public.edition_organisers enable trigger user;`);
  });
});

describe('race and brakes', () => {
  test('many simultaneous redeems of one code: exactly one wins', async () => {
    const m = mint('BIZ_OWNER', O.BIZ, 'dashboard');
    const outs = await Promise.all(Array.from({ length: 8 }, () => E.db.bg(`begin; set local role service_role; select public.edition_handoff_redeem('${m.hash}', ${chk(m.hash)}); select pg_sleep(0.2); commit;`)));
    const wins = outs.filter((o) => /"ok": true/.test(o.stdout)).length;
    assert.equal(wins, 1, outs.map((o) => o.stdout).join('|'));
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='app_handoff_redeemed' and detail ->> 'destination' is not null`) !== '', true);
  });
  test('a user cannot mint more than 10 in ten minutes at the database, whatever the edge function does', () => {
    E.sup(`delete from public.edition_web_handoff_codes where user_id='${USERS.BIZ_OWNER}'`);
    keepRows = true;
    let refused = 0, minted = 0; for (let i = 0; i < 13; i++) { const m = mint('BIZ_OWNER', O.BIZ, 'dashboard'); if (bad(m.out)) { refused++; assert.equal(hint(m.out), 'too_many'); } else minted++; }
    keepRows = false; assert.deepEqual([minted, refused], [10, 3]);
    E.sup(`delete from public.edition_web_handoff_codes where user_id='${USERS.BIZ_OWNER}'`);
  });
  test('old rows are purged on the next mint', () => {
    const old = mint('HUB_OWNER', O.HUB, 'dashboard'); E.sup(`update public.edition_web_handoff_codes set created_at=now()-interval '2 days', expires_at=now()-interval '2 days' + interval '60 seconds' where code_hash='${old.hash}'`);
    mint('HUB_OWNER', O.HUB, 'dashboard'); assert.equal(E.q(`select count(*) from public.edition_web_handoff_codes where code_hash='${old.hash}'`), '0');
  });
});

describe('audit', () => {
  test('mint, redeem and refusal are recorded against the organiser and the user, without any code', () => {
    assert.ok(audit('app_handoff_minted') > 5 && audit('app_handoff_redeemed') >= 1 && audit('app_handoff_refused') > 3);
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action like 'app_handoff_%' and actor is null`), '0');
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action like 'app_handoff_%' and detail::text ~ '[A-Za-z0-9_-]{40,}'`), '0');
  });
  test('the identity helper leaves nothing behind: after a call the connection has no user', () => {
    mint('BIZ_OWNER', O.BIZ, 'dashboard'); assert.equal(E.q(`select coalesce(nullif(current_setting('request.jwt.claim.sub', true),''), 'none')`), 'none');
  });
});

describe('rollback', () => {
  test('the rollback is re-runnable, removes everything, and the migration re-applies cleanly', () => {
    const rb = new URL('../rollbacks/20270104020000_editions_web_handoff.rollback.sql', import.meta.url).pathname;
    const mg = new URL('../migrations/20270104020000_editions_web_handoff.sql', import.meta.url).pathname;
    assert.ok(!bad(E.db.rawFile(rb))); assert.ok(!bad(E.db.rawFile(rb)), 'twice');
    assert.equal(E.q(`select count(*) from pg_proc where proname like 'edition_handoff_%'`), '0');
    assert.equal(E.q(`select count(*) from pg_class where relname='edition_web_handoff_codes'`), '0');
    assert.equal(E.q(`select count(*) from public.rate_limit_policies where action like 'editions_handoff_%'`), '0');
    assert.ok(readFileSync(mg, 'utf8').length > 0);
    assert.ok(!bad(E.db.rawFile(mg)), 're-apply'); assert.ok(!bad(E.db.rawFile(mg)), 're-apply twice (idempotent)');
    assert.equal(E.q(`select count(*) from pg_proc where proname like 'edition_handoff_%'`), '7');
  });
});

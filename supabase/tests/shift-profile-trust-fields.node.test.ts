/**
 * shift-profile-trust-fields.node.test.ts — worker / employer payment and trust fields are server-controlled.
 *
 * WHAT WAS WRONG
 *
 *  · shift_worker_profiles: anon + authenticated had table-level SELECT / INSERT / UPDATE and the policy "worker profile visible to all"
 *    (USING true) lets every row through, so anyone could READ every worker's Stripe connected-account id, and the owner could WRITE their own
 *    stripe_account_id, the two Stripe flags and their ratings. The policy "worker manages own profile" accepted `auth.uid() = id OR
 *    auth.uid() = user_id`, so a worker could re-point id / user_id. (Empty in production, unused by the apps — latent.)
 *  · shift_employer_profiles: is_verified, rating_avg and rating_count were client-writable: an employer could mark themselves "✓ Verified".
 *    Build 147 and the web send `is_verified: false` on every save, so the column cannot be revoked — a guard trigger makes it server-controlled
 *    (and a verified employer who edits their profile now keeps the badge).
 *
 * HOW IT PROVES IT
 *
 * The database is the REAL one: every migration except the fix is replayed into a private database of the throwaway cluster (production's
 * catalogue is reproduced exactly by the same replay — see scripts/migration-replay). The attacks run first and must SUCCEED (a control), then
 * migration 20261123000000 is applied and the same attacks must be neutralised, the apps' exact request shapes must keep working, driver_profiles
 * must be untouched, and the connected-account / customer-id exposure guards must pass over the whole schema. Mutation controls remove each protection
 * and show the attack comes back.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. Fake ids (acct_FAKE…) only.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — plain ESM helpers shared with the migration replay
import { evaluate as accountGuard, ALLOWED as ACCOUNT_ALLOWED } from '../../scripts/lib/stripe-account-exposure.mjs';
// @ts-ignore
import { evaluate as customerGuard } from '../../scripts/lib/stripe-customer-exposure.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const SUPPLEMENTS = join(REPO_ROOT, 'supabase/production/hand-applied-supplements');
const FIX_NAME = '20261123000000_shift_profile_trust_fields.sql';
const FIX = join(MIG, FIX_NAME);
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const DB = 'shifttrust';
const dsnFor = (user: string, db: string) => DSN.replace(/^postgresql:\/\/[^@]+@\/[^?]+/, `postgresql://${user}@/${db}`);
const DSN_PROOF = dsnFor('proof', 'proof');
const DSN_PG = dsnFor('postgres', DB);

function psql(dsn: string, args: string[], input?: string) {
  return spawnSync(PSQL, [dsn, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, input, maxBuffer: 1 << 26 });
}
/** everything psql said — stdout AND stderr — so a refusal is visible. Never throws. */
function raw(body: string): string { const r = psql(DSN_PG, ['-c', body]); return `${r.stdout ?? ''}${r.stderr ?? ''}`; }
function rawFile(path: string): string { const r = psql(DSN_PG, ['-f', path]); return `${r.stdout ?? ''}${r.stderr ?? ''}`; }
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
function guardQuery(sql: string): string[][] {
  const r = psql(DSN_PG, ['-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  assert.equal(r.status, 0, `guard query failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

const U = {
  W1: 'a1000000-0000-4000-8000-000000000001', W2: 'a2000000-0000-4000-8000-000000000002', W3: 'a3000000-0000-4000-8000-000000000003', W4: 'a4000000-0000-4000-8000-000000000004',
  D1: 'd1000000-0000-4000-8000-000000000001', D2: 'd2000000-0000-4000-8000-000000000002', D3: 'd3000000-0000-4000-8000-000000000003',
  E1: 'e1000000-0000-4000-8000-000000000001', E2: 'e2000000-0000-4000-8000-000000000002', E3: 'e3000000-0000-4000-8000-000000000003', E4: 'e4000000-0000-4000-8000-000000000004',
  AD: 'ad000000-0000-4000-8000-0000000000ad',
} as const;
type Who = keyof typeof U | 'anon' | 'service';
const roleSql = (who: Who) =>
  who === 'anon' ? 'set local role anon;'
  : who === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated;`;
/** one statement as `who`, in a transaction that is ROLLED BACK — a write that succeeds leaves nothing behind */
const tryAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
/** as `who`, committed */
const doAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; commit;`);
const denied = (o: string) => /permission denied/i.test(o);
const rlsRefused = (o: string) => /row-level security/i.test(o);
const ok = (o: string) => !/ERROR|permission denied|row-level security/i.test(o);
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const touched = (who: Who, write: string) => Number(lastRow(tryAs(who, `with w as (${write} returning 1) select count(*) from w`)));

const PROTECTED_W = ['stripe_account_id', 'stripe_onboarding_complete', 'stripe_payouts_enabled', 'rating_avg', 'rating_count'];
const SAFE_W = ['id', 'user_id', 'tagline', 'skills', 'is_open_to_work', 'open_to_categories', 'min_hourly_pay', 'bio', 'experience_summary', 'hourly_rate_min', 'hourly_rate_max', 'qualifications', 'created_at', 'updated_at'];
const has = (role: string, table: string, col: string, priv: string) => scalar(`select has_column_privilege('${role}','public.${table}','${col}','${priv}')`) === 't';

/** The exact request shapes the apps send, as PostgREST turns them into SQL. */
const upsertSql = (table: string, id: string, cols: Record<string, string | boolean | number | null>, mode: 'update' | 'ignore' = 'update', returning = '') => {
  const names = Object.keys(cols);
  const json = JSON.stringify([{ id, ...cols }]).replace(/'/g, "''");
  const list = ['id', ...names].map((n) => `"${n}"`).join(', ');
  return `insert into public.${table} (${list}) select ${list} from json_populate_recordset(null::public.${table}, '${json}'::json) _
    on conflict ("id") ${mode === 'ignore' ? 'do nothing' : `do update set ${['id', ...names].map((n) => `"${n}" = excluded."${n}"`).join(', ')}`} ${returning}`;
};
const BUILD147_EMPLOYER_PROFILE = (id: string, name = 'E Renamed', desc = 'described') => upsertSql('shift_employer_profiles', id, { business_name: name, description: desc, is_verified: false, logo_url: null }, 'update', 'returning is_verified, business_name');
const BUILD147_SHIFT_POST_EMPLOYER = (id: string) => upsertSql('shift_employer_profiles', id, { business_name: 'Poster', is_verified: false, logo_url: null }, 'ignore');
const WEB_EMPLOYER_PROFILE = BUILD147_EMPLOYER_PROFILE;                       // components/jobs/EmployerProfileForm.tsx sends the same five keys
const WEB_SHIFT_POST_EMPLOYER = (id: string) => upsertSql('shift_employer_profiles', id, { business_name: 'Poster', is_verified: false }, 'update', 'returning is_verified');

const snapshot = (what: string) => scalar(what);
const driverFingerprint = () => scalar(`select md5(coalesce((select string_agg(t::text,'|' order by id) from public.driver_profiles t),'') || coalesce((select string_agg(policyname||cmd||coalesce(qual,'')||coalesce(with_check,''),'|' order by policyname) from pg_policies where tablename='driver_profiles'),'') || coalesce((select string_agg(tgname,'|' order by tgname) from pg_trigger where tgrelid='public.driver_profiles'::regclass and not tgisinternal),'') || coalesce((select string_agg(attname||coalesce(attacl::text,''),'|' order by attnum) from pg_attribute where attrelid='public.driver_profiles'::regclass and attnum>0 and not attisdropped),'') || (select relacl::text from pg_class where oid='public.driver_profiles'::regclass) || (select md5(prosrc) from pg_proc where proname='tg_lock_driver_columns'))`);
const employerPolicies = () => scalar(`select string_agg(policyname||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\\n' order by policyname) from pg_policies where tablename='shift_employer_profiles'`);
const otherCatalogue = () => scalar(`select md5(
  coalesce((select string_agg(format('%s|%s|%s|%s|%s', tablename, policyname, cmd, qual, with_check), E'\\n' order by tablename, policyname) from pg_policies where schemaname='public' and tablename not in ('shift_worker_profiles')),'') ||
  coalesce((select string_agg(format('%s|%s', c.relname, c.relacl::text), E'\\n' order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname not in ('shift_worker_profiles')),'') ||
  coalesce((select string_agg(format('%s|%s', c.relname||'.'||a.attname, a.attacl::text), E'\\n' order by c.relname, a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attacl is not null and c.relname not in ('shift_worker_profiles')),'') ||
  coalesce((select string_agg(format('%s|%s', tgrelid::regclass, tgname), E'\\n' order by tgrelid::regclass::text, tgname) from pg_trigger where not tgisinternal and tgname not in ('tg_zz_lock_shift_worker_columns','tg_zz_lock_shift_employer_trust')),''))`);

const PRE: Record<string, string> = {};
let DRIVER_BEFORE = '', EMPLOYER_POLICIES_BEFORE = '', OTHER_BEFORE = '';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  // a private database in the throwaway cluster, so the other suites' schemas are never disturbed
  psql(DSN_PROOF, ['-c', `drop database if exists ${DB}`]);
  const cr = psql(DSN_PROOF, ['-c', `create database ${DB} template template0 encoding 'UTF8'`]);
  assert.doesNotMatch(`${cr.stdout}${cr.stderr}`, /ERROR/, 'could not create the private database');
  const setup = readFileSync(join(REPO_ROOT, 'scripts/migration-replay/setup.sql'), 'utf8').replace('alter database proof set', `alter database ${DB} set`);
  const sres = psql(dsnFor('proof', DB), ['-v', 'ON_ERROR_STOP=0'], setup);
  assert.doesNotMatch((sres.stderr ?? '').split('\n').filter((l) => /ERROR/.test(l) && !/already exists/.test(l)).join('\n'), /ERROR/, `replay stand-ins failed:\n${sres.stderr?.slice(0, 800)}`);
  // every migration EXCEPT the fix: production's PRE-FIX state
  const errors: string[] = [];
  for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
    if (f >= FIX_NAME) continue;
    const r = psql(DSN_PG, ['-f', join(MIG, f)]);
    for (const l of (r.stderr ?? '').split('\n')) if (/ERROR/.test(l) && !(f.startsWith('20260623000000') && /schema "public" already exists/.test(l))) errors.push(`${f}: ${l.slice(0, 160)}`);
    const sup = join(SUPPLEMENTS, f.replace(/\.sql$/, '.supplement.sql'));
    if (existsSync(sup)) psql(DSN_PG, ['-f', sup]);
  }
  assert.deepEqual(errors, [], 'the migration replay must be clean');

  const ids = Object.values(U).map((i) => `'${i}'::uuid`).join(',');
  const seed = raw(`
    insert into auth.users (id, email) select x, x::text || '@x' from unnest(array[${ids}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'u' from unnest(array[${ids}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${U.AD}';
    insert into public.shift_worker_profiles (id, user_id, tagline, bio, stripe_account_id) values
      ('${U.W1}', '${U.W1}', 'welder', 'bio one', 'acct_FAKE_WORKER_1'), ('${U.W2}', '${U.W2}', 'knitter', 'bio two', 'acct_FAKE_WORKER_2');
    insert into public.driver_profiles (id, driver_status, stripe_account_id, vehicle_type) values
      ('${U.D1}', 'pending', 'acct_FAKE_DRIVER_1', 'van'), ('${U.D2}', 'approved', 'acct_FAKE_DRIVER_2', 'car');
    insert into public.shift_employer_profiles (id, business_name, is_verified) values
      ('${U.E1}', 'E1 unverified', false), ('${U.E2}', 'E2 verified', true);`);
  assert.doesNotMatch(seed, /ERROR/, `seed failed:\n${seed}`);

  // ── the attacks against the PRE-FIX database: every one must SUCCEED ──
  PRE.anonReadsAcct = tryAs('anon', `select stripe_account_id from public.shift_worker_profiles where id = '${U.W1}'`);
  PRE.otherReadsAcct = tryAs('W2', `select stripe_account_id from public.shift_worker_profiles where id = '${U.W1}'`);
  PRE.workerInsert = tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id, stripe_payouts_enabled, rating_avg, rating_count) values ('${U.W3}','${U.W3}','acct_FAKE_ATTACKER',true,5,999) returning stripe_account_id, stripe_payouts_enabled, rating_avg, rating_count`);
  PRE.workerUpdate = tryAs('W1', `update public.shift_worker_profiles set stripe_account_id='acct_FAKE_CHANGED', stripe_payouts_enabled=true, stripe_onboarding_complete=true, rating_avg=5, rating_count=100 where id='${U.W1}' returning stripe_account_id, rating_count`);
  PRE.workerRepoint = tryAs('W1', `update public.shift_worker_profiles set id='${U.W4}' where id='${U.W1}' returning id, user_id`);
  PRE.workerRepointUser = tryAs('W1', `update public.shift_worker_profiles set user_id='${U.W4}' where id='${U.W1}' returning id, user_id`);
  PRE.workerOtherIdentity = tryAs('W3', `insert into public.shift_worker_profiles (id, user_id) values ('${U.W4}','${U.W3}') returning id, user_id`);
  PRE.employerInsert = tryAs('E3', `insert into public.shift_employer_profiles (id, business_name, is_verified, rating_avg, rating_count) values ('${U.E3}','E3 Co',true,5,500) returning is_verified, rating_avg, rating_count`);
  PRE.employerSelfVerify = tryAs('E1', `update public.shift_employer_profiles set is_verified = true where id = '${U.E1}' returning is_verified`);
  PRE.employerRating = tryAs('E1', `update public.shift_employer_profiles set rating_avg = 5, rating_count = 9999 where id = '${U.E1}' returning rating_avg, rating_count`);
  PRE.verifiedEmployerEdits = tryAs('E2', BUILD147_EMPLOYER_PROFILE(U.E2));
  PRE.guards = JSON.stringify({ account: accountGuard(guardQuery).violations, customer: customerGuard(guardQuery).violations });

  DRIVER_BEFORE = driverFingerprint(); EMPLOYER_POLICIES_BEFORE = employerPolicies(); OTHER_BEFORE = otherCatalogue();

  // ── apply the REAL migration ──
  PRE.apply = rawFile(FIX);
  PRE.driverApprovedByAdmin = tryAs('AD', `update public.driver_profiles set driver_status='approved' where id='${U.D1}' returning driver_status`);
});

after(() => { psql(DSN_PROOF, ['-c', `drop database if exists ${DB}`]); });

describe('0 · before the fix the problems are real (controls)', () => {
  test('anon reads a worker\'s connected-account id', () => assert.match(PRE.anonReadsAcct, /acct_FAKE_WORKER_1/));
  test('an unrelated signed-in user reads it', () => assert.match(PRE.otherReadsAcct, /acct_FAKE_WORKER_1/));
  test('a worker inserts an arbitrary account id, payouts-enabled and a 999-review rating', () => assert.match(PRE.workerInsert, /acct_FAKE_ATTACKER\|t\|5\|999/));
  test('a worker changes their account id, flags and rating later', () => assert.match(PRE.workerUpdate, /acct_FAKE_CHANGED\|100/));
  test('a worker re-points id at another user', () => assert.match(PRE.workerRepoint, new RegExp(U.W4)));
  test('a worker re-points user_id at another user', () => assert.match(PRE.workerRepointUser, new RegExp(U.W4)));
  test('a worker creates a row whose id is another user\'s (user_id = self satisfies the OR policy)', () => assert.ok(ok(PRE.workerOtherIdentity), PRE.workerOtherIdentity));
  test('an employer inserts itself as verified with a 500-review rating', () => assert.match(PRE.employerInsert, /t\|5\|500/));
  test('an unverified employer verifies itself', () => assert.equal(lastRow(PRE.employerSelfVerify), 't'));
  test('an employer sets its own rating', () => assert.match(PRE.employerRating, /5\|9999/));
  test('the apps\' own profile save un-verifies a verified employer (is_verified:false on every save)', () => assert.match(PRE.verifiedEmployerEdits, /^f\|/m));
  test('the account-id guard reports the six worker exposures; the customer guard is clean', () => {
    const g = JSON.parse(PRE.guards);
    assert.deepEqual(g.account.sort(), [
      'direct public.shift_worker_profiles.stripe_account_id INSERT ← anon', 'direct public.shift_worker_profiles.stripe_account_id INSERT ← authenticated',
      'direct public.shift_worker_profiles.stripe_account_id SELECT ← anon', 'direct public.shift_worker_profiles.stripe_account_id SELECT ← authenticated',
      'direct public.shift_worker_profiles.stripe_account_id UPDATE ← anon', 'direct public.shift_worker_profiles.stripe_account_id UPDATE ← authenticated',
    ]);
    assert.deepEqual(g.customer, []);
  });
});

describe('1 · apply the REAL migration', () => {
  test('it runs clean and its own end-state assertions pass', () => assert.doesNotMatch(PRE.apply, /ERROR/i, PRE.apply));
  test('it is re-runnable', () => assert.doesNotMatch(rawFile(FIX), /ERROR/i));
});

describe('2 · shift_worker_profiles — payment fields', () => {
  test('1. anon cannot read the account id', () => assert.ok(denied(tryAs('anon', `select stripe_account_id from public.shift_worker_profiles where id='${U.W1}'`))));
  test('2. an unrelated authenticated user cannot read it', () => assert.ok(denied(tryAs('W2', `select stripe_account_id from public.shift_worker_profiles where id='${U.W1}'`))));
  test('3. the worker cannot explicitly select any protected field (and not by select *, whole-row, WHERE oracle or RETURNING)', () => {
    for (const who of ['anon', 'W1', 'W2'] as Who[]) {
      for (const c of PROTECTED_W) assert.ok(denied(tryAs(who, `select ${c} from public.shift_worker_profiles`)), `${who} read ${c}`);
      for (const sql of [
        'select * from public.shift_worker_profiles', 'select to_jsonb(t) from public.shift_worker_profiles t', 'select t from public.shift_worker_profiles t',
        `select id from public.shift_worker_profiles where stripe_account_id = 'acct_FAKE_WORKER_1'`, `select id from public.shift_worker_profiles order by rating_avg`,
      ]) assert.ok(denied(tryAs(who, sql)), `${who} could run: ${sql}`);
    }
    assert.ok(denied(tryAs('W1', `update public.shift_worker_profiles set bio = 'x' where id='${U.W1}' returning stripe_account_id`)), 'RETURNING leaked it');
  });
  test('4. the worker cannot insert an arbitrary account id (denied at privilege level, and when copying a victim\'s)', () => {
    assert.ok(denied(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id) values ('${U.W3}','${U.W3}','acct_FAKE_ATTACKER')`)));
    assert.ok(denied(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id) values ('${U.W3}','${U.W3}','acct_FAKE_WORKER_1')`)));
    assert.ok(denied(tryAs('anon', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id) values ('${U.W3}','${U.W3}','acct_X')`)));
  });
  test('5. the worker cannot update the account id (value, NULL, self-assignment, and through an upsert)', () => {
    for (const set of [`'acct_FAKE_CHANGED'`, 'null', 'stripe_account_id']) assert.ok(denied(tryAs('W1', `update public.shift_worker_profiles set stripe_account_id = ${set} where id='${U.W1}'`)), set);
    assert.ok(denied(tryAs('W1', upsertSql('shift_worker_profiles', U.W1, { bio: 'x', stripe_account_id: 'acct_X' }))));
  });
  test('6-9. onboarding_complete, payouts_enabled, rating_avg and rating_count cannot be set', () => {
    for (const set of ['stripe_onboarding_complete = true', 'stripe_payouts_enabled = true', 'rating_avg = 5', 'rating_count = 100']) {
      assert.ok(denied(tryAs('W1', `update public.shift_worker_profiles set ${set} where id='${U.W1}'`)), set);
      assert.ok(denied(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, ${set.split(' = ')[0]}) values ('${U.W3}','${U.W3}', ${set.split(' = ')[1]})`)), `insert ${set}`);
    }
  });
  test('column privileges: no client SELECT / INSERT / UPDATE on the five protected columns; every other column keeps all three', () => {
    for (const role of ['anon', 'authenticated']) for (const priv of ['SELECT', 'INSERT', 'UPDATE']) {
      for (const c of PROTECTED_W) assert.equal(has(role, 'shift_worker_profiles', c, priv), false, `${role} ${priv} ${c}`);
      for (const c of SAFE_W) assert.equal(has(role, 'shift_worker_profiles', c, priv), true, `${role} lost ${priv} on ${c}`);
    }
  });
  test('10. ordinary public profile reads still work (anon, unrelated user, owner)', () => {
    for (const who of ['anon', 'W2', 'W1'] as Who[]) {
      assert.match(tryAs(who, `select id, user_id, tagline, skills, is_open_to_work, open_to_categories, min_hourly_pay, bio, experience_summary, hourly_rate_min, hourly_rate_max, qualifications from public.shift_worker_profiles where id='${U.W1}'`), /welder/, who);
      assert.equal(lastRow(tryAs(who, 'select count(*) from public.shift_worker_profiles')), '2', who);
    }
  });
  test('11. ordinary worker writes still work: insert, upsert, update of bio / skills / rates / availability', () => {
    assert.ok(ok(tryAs('W3', `insert into public.shift_worker_profiles (id, tagline, skills, bio, hourly_rate_min, hourly_rate_max, is_open_to_work) values ('${U.W3}','plumber','{pipes}','bio',12,20,true) returning id, user_id`)));
    assert.match(tryAs('W3', `insert into public.shift_worker_profiles (id, tagline) values ('${U.W3}','plumber') returning id, user_id`), new RegExp(`${U.W3}\\|${U.W3}`), 'the sync trigger still fills user_id');
    assert.ok(ok(tryAs('W1', upsertSql('shift_worker_profiles', U.W1, { tagline: 'master welder', bio: 'new', is_open_to_work: true }))));
    assert.ok(ok(tryAs('W1', `update public.shift_worker_profiles set tagline='t', skills='{a,b}', bio='b', hourly_rate_min=10, hourly_rate_max=30, qualifications='{x}', is_open_to_work=true, open_to_categories='{y}', min_hourly_pay=9, experience_summary='e' where id='${U.W1}' returning 1`)));
    assert.equal(touched('W2', `update public.shift_worker_profiles set bio = 'hijack' where id = '${U.W1}'`), 0, 'another user\'s row is still out of reach');
  });
  test('12. service_role can set every protected worker field (insert and update)', () => {
    assert.match(tryAs('service', `update public.shift_worker_profiles set stripe_account_id='acct_FAKE_SERVER', stripe_onboarding_complete=true, stripe_payouts_enabled=true, rating_avg=4.5, rating_count=7 where id='${U.W1}' returning stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled, rating_avg, rating_count`), /acct_FAKE_SERVER\|t\|t\|4\.5\|7/);
    assert.match(tryAs('service', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id, rating_avg, rating_count) values ('${U.W4}','${U.W4}','acct_FAKE_NEW',3,2) returning stripe_account_id, rating_avg, rating_count`), /acct_FAKE_NEW\|3\|2/);
    assert.match(tryAs('service', 'select stripe_account_id from public.shift_worker_profiles limit 1'), /acct_FAKE_/);
  });
  test('a platform admin (trusted writer) can set protected fields on their OWN worker row; RLS still keeps them out of other rows', () => {
    assert.match(tryAs('AD', `insert into public.shift_worker_profiles (id, user_id) values ('${U.AD}','${U.AD}') returning 1`), /1/);
    assert.equal(touched('AD', `update public.shift_worker_profiles set bio = 'x' where id = '${U.W1}'`), 0, 'the admin has no policy over other workers\' rows (unchanged)');
  });
});

describe('3 · shift_worker_profiles — defence in depth and identity', () => {
  /** the trigger alone, with the column privileges put back: it must still neutralise a write */
  test('with the column grants restored, the trigger still resets a client INSERT and preserves on UPDATE', () => {
    raw(`grant insert (${PROTECTED_W.join(',')}), update (${PROTECTED_W.join(',')}), select (${PROTECTED_W.join(',')}) on public.shift_worker_profiles to anon, authenticated`);
    try {
      assert.match(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled, rating_avg, rating_count) values ('${U.W3}','${U.W3}','acct_FAKE_ATTACKER',true,true,5,999) returning stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled, rating_avg, rating_count`), /\|f\|f\|0\|0$/m);
      assert.equal(lastRow(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id, stripe_account_id) values ('${U.W3}','${U.W3}','acct_FAKE_ATTACKER') returning stripe_account_id is null`)), 't');
      assert.match(tryAs('W1', `update public.shift_worker_profiles set stripe_account_id='acct_FAKE_CHANGED', stripe_onboarding_complete=false, stripe_payouts_enabled=false, rating_avg=1, rating_count=1 where id='${U.W1}' returning stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled, rating_avg, rating_count`), /acct_FAKE_WORKER_1\|f\|f\|0\|0/, 'the stored values are preserved');
    } finally {
      raw(`revoke select (${PROTECTED_W.join(',')}), insert (${PROTECTED_W.join(',')}), update (${PROTECTED_W.join(',')}) on public.shift_worker_profiles from anon, authenticated`);
    }
    assert.equal(has('anon', 'shift_worker_profiles', 'stripe_account_id', 'SELECT'), false);
  });
  test('13. a worker cannot re-point id', () => {
    const out = tryAs('W1', `update public.shift_worker_profiles set id='${U.W4}' where id='${U.W1}' returning id, user_id`);
    assert.doesNotMatch(out, new RegExp(U.W4), out);
    assert.equal(scalar(`select count(*) from public.shift_worker_profiles where id = '${U.W4}' and user_id <> '${U.W4}'`), '0');
  });
  test('14. a worker cannot re-point user_id', () => {
    const out = tryAs('W1', `update public.shift_worker_profiles set user_id='${U.W4}' where id='${U.W1}' returning id, user_id`);
    assert.doesNotMatch(out, new RegExp(U.W4), out);
    assert.equal(touched('W1', `update public.shift_worker_profiles set user_id = '${U.W1}' where id = '${U.W1}'`), 1, 'a no-op identity update is fine');
  });
  test('15. a worker cannot create a profile attributed to another user (any id / user_id combination)', () => {
    for (const [id, uid] of [[U.W4, U.W3], [U.W3, U.W4], [U.W4, U.W4]]) {
      assert.ok(rlsRefused(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id) values ('${id}','${uid}')`)), `id=${id} user_id=${uid}`);
    }
    assert.ok(rlsRefused(tryAs('W3', `insert into public.shift_worker_profiles (id) values ('${U.W4}')`)), 'the sync trigger copies id into user_id, so this is also refused');
    assert.ok(rlsRefused(tryAs('W3', `insert into public.shift_worker_profiles (user_id) values ('${U.W4}')`)));
    assert.ok(rlsRefused(tryAs('anon', `insert into public.shift_worker_profiles (id, user_id) values ('${U.W4}','${U.W4}')`)));
  });
  test('the worker policy now needs BOTH id and user_id to be the caller', () => {
    const p = scalar(`select qual || ' // ' || with_check from pg_policies where tablename='shift_worker_profiles' and policyname='worker manages own profile'`);
    assert.match(p, /auth\.uid\(\) = id\) AND \(auth\.uid\(\) = user_id/);
    assert.doesNotMatch(p, /\bOR\b/);
    assert.equal(scalar(`select count(*) from pg_policies where tablename='shift_worker_profiles'`), '2', 'the public read policy is untouched');
  });
  test('16. service / definer identity management still works (move id and user_id, create a row for a user)', () => {
    assert.ok(ok(tryAs('service', `update public.shift_worker_profiles set user_id = '${U.W4}', id = '${U.W4}' where id = '${U.W2}' returning id`)));
    assert.ok(ok(tryAs('service', `insert into public.shift_worker_profiles (user_id) values ('${U.W3}') returning id, user_id`)));
    assert.ok(ok(raw(`begin; update public.shift_worker_profiles set user_id = '${U.W4}', id = '${U.W4}' where id = '${U.W2}'; rollback;`)), 'a direct (superuser / migration) session too');
  });
});

describe('4 · shift_employer_profiles — trust fields', () => {
  const defaultsRow = () => lastRow(tryAs('service', `insert into public.shift_employer_profiles (id, business_name) values ('${U.E4}','defaults') returning is_verified, rating_avg, rating_count`));
  test('the guard resets to the SCHEMA defaults (compared with a row that supplies nothing)', () => assert.equal(defaultsRow(), 'f|0|0'));
  test('17. a client INSERT with is_verified = true and a rating becomes the defaults', () => {
    assert.equal(lastRow(tryAs('E3', `insert into public.shift_employer_profiles (id, business_name, is_verified, rating_avg, rating_count) values ('${U.E3}','E3 Co',true,5,500) returning is_verified, rating_avg, rating_count`)), defaultsRow());
    assert.equal(lastRow(tryAs('E3', upsertSql('shift_employer_profiles', U.E3, { business_name: 'E3 Co', is_verified: true }, 'update', 'returning is_verified'))), 'f');
  });
  test('18. false → true is ignored', () => {
    assert.equal(lastRow(tryAs('E1', `update public.shift_employer_profiles set is_verified = true where id='${U.E1}' returning is_verified`)), 'f');
    assert.equal(lastRow(tryAs('E1', upsertSql('shift_employer_profiles', U.E1, { business_name: 'E1', is_verified: true }, 'update', 'returning is_verified'))), 'f');
  });
  test('19. a verified employer editing with is_verified = false STAYS verified (and true → false is also ignored)', () => {
    assert.match(tryAs('E2', BUILD147_EMPLOYER_PROFILE(U.E2)), /^t\|E Renamed$/m);
    assert.equal(lastRow(tryAs('E2', `update public.shift_employer_profiles set is_verified = false where id='${U.E2}' returning is_verified`)), 't');
    assert.equal(lastRow(tryAs('E2', `update public.shift_employer_profiles set is_verified = null where id='${U.E2}' returning is_verified`)), 't');
  });
  test('20-21. rating_avg and rating_count cannot be changed by the employer', () => {
    assert.equal(lastRow(tryAs('E1', `update public.shift_employer_profiles set rating_avg = 5 where id='${U.E1}' returning rating_avg`)), '0');
    assert.equal(lastRow(tryAs('E1', `update public.shift_employer_profiles set rating_count = 9999 where id='${U.E1}' returning rating_count`)), '0');
  });
  test('22. legitimate edits still work: business_name, description, logo_url, website', () => {
    assert.match(tryAs('E1', `update public.shift_employer_profiles set business_name='E1 Ltd', description='d', logo_url='https://x/y.png', website='https://e1.example' where id='${U.E1}' returning business_name, description, logo_url, website`), /E1 Ltd\|d\|https:\/\/x\/y\.png\|https:\/\/e1\.example/);
    doAs('E1', `update public.shift_employer_profiles set business_name='E1 Ltd' where id='${U.E1}'`);
    assert.equal(scalar(`select business_name from public.shift_employer_profiles where id='${U.E1}'`), 'E1 Ltd');
  });
  test('23. build 147\'s exact upserts work unchanged (employer-profile.tsx and ShiftPostForm.tsx)', () => {
    assert.ok(ok(tryAs('E1', BUILD147_EMPLOYER_PROFILE(U.E1))));
    assert.ok(ok(tryAs('E3', BUILD147_EMPLOYER_PROFILE(U.E3, 'New Employer'))));            // first save by a new employer
    assert.ok(ok(tryAs('E3', BUILD147_SHIFT_POST_EMPLOYER(U.E3))));                         // ignoreDuplicates
    assert.ok(ok(tryAs('E2', BUILD147_SHIFT_POST_EMPLOYER(U.E2))));
    assert.equal(lastRow(tryAs('E3', BUILD147_EMPLOYER_PROFILE(U.E3, 'New Employer'))), 'f|New Employer');
    // the shapes build 147 reads
    assert.match(tryAs('anon', `select id, business_name, logo_url, is_verified from public.shift_employer_profiles where id in ('${U.E1}','${U.E2}')`), /E2 verified/);
    assert.match(tryAs('W1', `select business_name, logo_url, is_verified from public.shift_employer_profiles where id='${U.E2}'`), /E2 verified\|\|t/);
    assert.match(tryAs('E1', `select business_name, description from public.shift_employer_profiles where id='${U.E1}'`), /E1/);
  });
  test('24. the web\'s exact upserts and reads work unchanged (EmployerProfileForm, ShiftPostForm, jobs-data)', () => {
    assert.match(tryAs('E2', WEB_EMPLOYER_PROFILE(U.E2)), /^t\|E Renamed$/m);
    assert.equal(lastRow(tryAs('E2', WEB_SHIFT_POST_EMPLOYER(U.E2))), 't');
    assert.equal(lastRow(tryAs('E1', WEB_SHIFT_POST_EMPLOYER(U.E1))), 'f');
    assert.match(tryAs('anon', `select business_name, description, is_verified, logo_url from public.shift_employer_profiles where id='${U.E2}'`), /E2 verified\|\|t\|/);
  });
  test('25. service_role can verify and rate; the public badge then reflects it', () => {
    assert.match(tryAs('service', `update public.shift_employer_profiles set is_verified = true, rating_avg = 4.8, rating_count = 12 where id='${U.E1}' returning is_verified, rating_avg, rating_count`), /t\|4\.8\|12/);
    doAs('service', `update public.shift_employer_profiles set is_verified = true where id='${U.E1}'`);
    assert.match(tryAs('anon', `select is_verified from public.shift_employer_profiles where id='${U.E1}'`), /^t$/m, 'the web / app badge reads the server-controlled value');
    assert.equal(lastRow(tryAs('E1', WEB_EMPLOYER_PROFILE(U.E1, 'E1 again'))).split('|')[0], 't', 'and survives the employer\'s next save');
  });
  test('26. a platform admin is a trusted writer on their own employer row; RLS keeps them out of other employers\' rows (existing model, unchanged)', () => {
    assert.match(tryAs('AD', `insert into public.shift_employer_profiles (id, business_name, is_verified, rating_count) values ('${U.AD}','Admin Co',true,3) returning is_verified, rating_count`), /t\|3/);
    assert.equal(touched('AD', `update public.shift_employer_profiles set is_verified = true where id = '${U.E2}'`), 0);
    assert.equal(touched('E1', `update public.shift_employer_profiles set is_verified = true where id = '${U.E2}'`), 0);
  });
  test('employer RLS policies are byte-identical, RLS still on, and stripe_customer_id is still closed', () => {
    assert.equal(employerPolicies(), EMPLOYER_POLICIES_BEFORE);
    assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.shift_employer_profiles'::regclass`), 't');
    assert.ok(denied(tryAs('E1', `select stripe_customer_id from public.shift_employer_profiles`)));
  });
});

describe('5 · driver_profiles is untouched', () => {
  test('its policies, triggers, privileges, lock function and data have the same fingerprint as before the migration (apart from the test\'s own committed edits)', () => {
    assert.equal(driverFingerprint(), DRIVER_BEFORE);
  });
  test('27. the lock still prevents account-id mutation on INSERT and UPDATE; ordinary fields still save', () => {
    assert.match(tryAs('D1', `update public.driver_profiles set stripe_account_id='acct_FAKE_CHANGED', driver_status='approved', stripe_payouts_enabled=true, dispute_count=-9, flagged_for_review=true where id='${U.D1}' returning driver_status, stripe_account_id, stripe_payouts_enabled, dispute_count, flagged_for_review`), /pending\|acct_FAKE_DRIVER_1\|f\|0\|f/);
    assert.match(tryAs('D3', `insert into public.driver_profiles (id, driver_status, stripe_account_id, stripe_payouts_enabled) values ('${U.D3}','approved','acct_FAKE_ATTACKER',true) returning driver_status, stripe_account_id is null, stripe_payouts_enabled`), /not_applied\|t\|f/);
    assert.match(tryAs('D1', `update public.driver_profiles set vehicle_type='lorry', notes='n' where id='${U.D1}' returning vehicle_type, notes`), /lorry\|n/);
    assert.match(PRE.driverApprovedByAdmin, /approved/, 'an admin still approves drivers (trusted writer)');
    assert.match(tryAs('service', `update public.driver_profiles set stripe_account_id='acct_FAKE_SERVER' where id='${U.D1}' returning stripe_account_id`), /acct_FAKE_SERVER/);
  });
  test('28. build 147 still reads its OWN row: select * (driver dashboard), the account screen, payment-state, create-run', () => {
    assert.match(tryAs('D1', `select * from public.driver_profiles where id='${U.D1}'`), /acct_FAKE_DRIVER_1/);
    assert.match(tryAs('D1', `select driver_status, vehicle_type, vehicle_reg, notes, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled from public.driver_profiles where id='${U.D1}'`), /acct_FAKE_DRIVER_1/);
    assert.match(tryAs('D1', `select stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled from public.driver_profiles where id='${U.D1}'`), /acct_FAKE_DRIVER_1/);
  });
  test('29. another user, and anon, still cannot read a driver\'s account id', () => {
    assert.equal(lastRow(tryAs('D2', `select count(*) from public.driver_profiles where id='${U.D1}'`)), '0');
    assert.equal(lastRow(tryAs('anon', `select count(*) from public.driver_profiles`)), '0');
    assert.equal(lastRow(tryAs('W1', `select count(stripe_account_id) from public.driver_profiles`)), '0');
  });
});

describe('6 · nothing else moved', () => {
  test('every other table\'s policies, grants, column grants and triggers are unchanged', () => assert.equal(otherCatalogue(), OTHER_BEFORE));
  test('the worker table keeps exactly its two policies and RLS', () => {
    assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.shift_worker_profiles'::regclass`), 't');
    assert.equal(scalar(`select string_agg(policyname, ',' order by policyname) from pg_policies where tablename='shift_worker_profiles'`), 'worker manages own profile,worker profile visible to all');
  });
  test('column definitions of both tables are unchanged', () => {
    assert.equal(scalar(`select string_agg(attname||':'||format_type(atttypid,atttypmod)||':'||attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''), ',' order by attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.shift_worker_profiles'::regclass and attnum>0 and not attisdropped`)
      .includes('rating_avg:numeric:false:0,rating_count:integer:false:0,stripe_account_id:text:false:,stripe_onboarding_complete:boolean:false:false,stripe_payouts_enabled:boolean:false:false'), true);
  });
  test('the apps\' parity: both clients really do send is_verified:false (the reason a column revoke is not an option)', () => {
    const mobile = join(REPO_ROOT, 'app/employer-profile.tsx');
    if (existsSync(mobile)) assert.match(readFileSync(mobile, 'utf8'), /is_verified:\s*false/);
    const post = join(REPO_ROOT, 'components/shifts/ShiftPostForm.tsx');
    if (existsSync(post)) assert.match(readFileSync(post, 'utf8'), /is_verified:\s*false/);
  });
});

describe('7 · the exposure guards over the whole real schema', () => {
  test('30. connected-account guard: no unjustified account-id column is reachable, every justification still holds, no stale entry', () => {
    const r = accountGuard(guardQuery);
    assert.deepEqual(r.violations, []); assert.deepEqual(r.stale, []);
    assert.equal(r.allowed.length, ACCOUNT_ALLOWED.length * 2, 'every allow-list entry is exercised, for both anon and authenticated');
    assert.ok(!r.allowed.some((l: string) => /shift_worker_profiles|shift_employer_profiles/.test(l)), 'neither shift table may be allow-listed');
  });
  test('31. customer-id guard still passes', () => assert.deepEqual(customerGuard(guardQuery).violations, []));
  test('the guard catches a NEW unprotected account-id column, a world-readable one and an unprotected client-writable one', () => {
    raw(`create table public.fx_acct (id uuid primary key, stripe_account_id text); grant select, insert, update on public.fx_acct to anon, authenticated;
         create table public.fx_acct_ro (id uuid primary key, connected_stripe_account text); alter table public.fx_acct_ro enable row level security;
         create policy visible on public.fx_acct_ro for select using (true); grant select on public.fx_acct_ro to anon, authenticated;`);
    try {
      const v = accountGuard(guardQuery).violations.join('\n');
      assert.match(v, /public\.fx_acct\.stripe_account_id SELECT ← anon/);
      assert.match(v, /public\.fx_acct\.stripe_account_id INSERT ← authenticated/);
      assert.match(v, /public\.fx_acct_ro\.connected_stripe_account SELECT ← anon/);
    } finally { raw('drop table public.fx_acct, public.fx_acct_ro'); }
  });
  test('an allow-listed justification that stops holding fails the guard: a "visible to all" policy on profiles, and a driver lock trigger that no longer mentions the column', () => {
    raw(`create policy fx_open on public.driver_profiles for select using (true)`);
    try { assert.match(accountGuard(guardQuery).violations.join('\n'), /driver_profiles\.stripe_account_id SELECT.*rls-own-row/); }
    finally { raw('drop policy fx_open on public.driver_profiles'); }
    raw(`create policy fx_open2 on public.profiles for select using (is_active is not null)`);
    try { assert.match(accountGuard(guardQuery).violations.join('\n'), /profiles\.stripe_account_id SELECT.*rls-own-row/, 'a policy not tied to the caller voids the own-row exception'); }
    finally { raw('drop policy fx_open2 on public.profiles'); }
    raw(`alter table public.driver_profiles disable trigger tg_zz_lock_driver_columns`);
    try { assert.match(accountGuard(guardQuery).violations.join('\n'), /driver_profiles\.stripe_account_id (INSERT|UPDATE).*trigger:tg_zz_lock_driver_columns/); }
    finally { raw('alter table public.driver_profiles enable trigger tg_zz_lock_driver_columns'); }
    assert.deepEqual(accountGuard(guardQuery).violations, []);
  });
});

describe('8 · mutation controls: each protection is load-bearing', () => {
  const restore = () => assert.doesNotMatch(rawFile(FIX), /ERROR/i, 'restoring the migration');
  test('32a. restoring the column grants reopens the READ leak (anon sees the account id) and the guard notices', () => {
    raw(`grant select (${PROTECTED_W.join(',')}) on public.shift_worker_profiles to anon, authenticated`);
    try {
      assert.match(tryAs('anon', `select stripe_account_id from public.shift_worker_profiles where id='${U.W1}'`), /acct_FAKE_/);
      assert.match(accountGuard(guardQuery).violations.join('\n'), /shift_worker_profiles\.stripe_account_id SELECT ← anon/);
    } finally { restore(); }
    assert.deepEqual(accountGuard(guardQuery).violations, []);
  });
  test('32b. removing the worker trigger AND restoring the grants reopens the WRITE leak', () => {
    raw(`drop trigger tg_zz_lock_shift_worker_columns on public.shift_worker_profiles; grant insert (${PROTECTED_W.join(',')}), update (${PROTECTED_W.join(',')}), select (${PROTECTED_W.join(',')}) on public.shift_worker_profiles to anon, authenticated`);
    try {
      assert.match(tryAs('W1', `update public.shift_worker_profiles set stripe_account_id='acct_FAKE_ATTACKER', rating_avg=5 where id='${U.W1}' returning stripe_account_id, rating_avg`), /acct_FAKE_ATTACKER\|5/);
      assert.match(accountGuard(guardQuery).violations.join('\n'), /stripe_account_id UPDATE ← authenticated/);
    } finally { restore(); }
    assert.ok(denied(tryAs('W1', `update public.shift_worker_profiles set stripe_account_id='acct_X' where id='${U.W1}'`)));
  });
  test('33. removing the employer trigger restores self-verification and the un-verify-on-save behaviour', () => {
    raw('drop trigger tg_zz_lock_shift_employer_trust on public.shift_employer_profiles');
    try {
      assert.equal(lastRow(tryAs('E3', `insert into public.shift_employer_profiles (id, business_name, is_verified) values ('${U.E3}','x',true) on conflict (id) do update set is_verified = excluded.is_verified returning is_verified`)), 't');
      assert.match(tryAs('E2', BUILD147_EMPLOYER_PROFILE(U.E2)), /^f\|/m);
    } finally { restore(); }
    assert.equal(lastRow(tryAs('E1', `update public.shift_employer_profiles set is_verified = false where id='${U.E1}' returning is_verified`)), 't', 'the protection is back: a verified employer cannot un-verify');
  });
  test('34. removing the identity protection (old OR policy, no trigger) restores worker id re-pointing; the new policy alone already refuses it', () => {
    // new policy only, trigger gone: the WITH CHECK refuses a re-point
    raw('drop trigger tg_zz_lock_shift_worker_columns on public.shift_worker_profiles');
    try { assert.ok(rlsRefused(tryAs('W1', `update public.shift_worker_profiles set id='${U.W4}' where id='${U.W1}'`)), 'policy layer alone refuses'); }
    finally { restore(); }
    // the ORIGINAL policy and no trigger: re-pointing works
    raw(`drop trigger tg_zz_lock_shift_worker_columns on public.shift_worker_profiles; drop policy "worker manages own profile" on public.shift_worker_profiles;
         create policy "worker manages own profile" on public.shift_worker_profiles using ((auth.uid() = id) or (auth.uid() = user_id)) with check ((auth.uid() = id) or (auth.uid() = user_id))`);
    try {
      assert.match(tryAs('W1', `update public.shift_worker_profiles set id='${U.W4}' where id='${U.W1}' returning id, user_id`), new RegExp(U.W4));
      assert.ok(ok(tryAs('W3', `insert into public.shift_worker_profiles (id, user_id) values ('${U.W4}','${U.W3}')`)), 'and a row attributed to another id can be created');
    } finally { restore(); }
    assert.doesNotMatch(tryAs('W1', `update public.shift_worker_profiles set id='${U.W4}' where id='${U.W1}' returning id`), new RegExp(U.W4));
  });
});

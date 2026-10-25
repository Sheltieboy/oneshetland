/**
 * stripe-customer-exposure.node.test.ts — Stripe CUSTOMER identifiers must not be reachable by anon / authenticated.
 *
 * WHAT WAS WRONG
 *
 * public.shift_employer_profiles.stripe_customer_id was readable by anyone holding the public anon key and writable by every
 * signed-in user: the baseline gave anon and authenticated table-level SELECT / INSERT / UPDATE, and the policy "employer
 * profile visible to all" (USING true) lets every row through. The column is an unused legacy field (no client selects it, no
 * Edge Function or SQL function reads it, production held no value in it), so nothing was leaked — but the first value anyone
 * stored there would have been public, and a later server path that trusted it would have acted on whatever customer a user wrote.
 * Migration 20261122000000 withdraws SELECT / INSERT / UPDATE at table level from the two client roles and grants every OTHER
 * column back, so the ordinary employer-profile reads and upserts of builds ≤147 and the web keep working unchanged.
 *
 * HOW IT PROVES IT
 *
 * The fixture is rebuilt from the BASELINE's own CREATE TABLE and CREATE POLICY text, with the production privilege state
 * (anon / authenticated: arwdxtm, service_role: everything). The attacks are run first and must SUCCEED (a control: a test that
 * cannot fail proves nothing), the generic guard (scripts/lib/stripe-customer-exposure.mjs) must report the six exposures, then the
 * REAL migration file is applied and the same attacks must be refused — while the exact query shapes the apps send keep working.
 * Finally the protected grant is put back and the guard and the attack must both notice.
 *
 * The guard itself is also exercised here on decoys (brand-new tables, other column names, a view, the allow-list), and runs
 * against the whole schema in scripts/migration-replay/replay.mjs.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. Fake ids (cus_FIXTURE…) only.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — plain ESM helper shared with the migration replay
import { evaluate, ALLOWED, NAME_PATTERN } from '../../scripts/lib/stripe-customer-exposure.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const FIX = join(MIG, '20261122000000_shift_employer_stripe_customer_lock.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

/** Runs SQL and returns everything psql said — stdout AND stderr — so a refusal is visible. Never throws. */
function raw(body: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
function rawFile(path: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-f', path], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
/** the guard's own read-only query runner: superuser, tab-separated rows */
function guardQuery(sql: string): string[][] {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `guard query failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

const A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';   // employer with a profile (fake customer id)
const B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';   // unrelated signed-in user, no profile
const C = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';   // a second employer
const FAKE_A = 'cus_FIXTURE_EMPLOYER_A';
const FAKE_C = 'cus_FIXTURE_EMPLOYER_C';

type Who = 'anon' | 'a' | 'b' | 'service';
const roleSql = (who: Who) =>
  who === 'anon' ? 'set local role anon;'
  : who === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${who === 'a' ? A : B}'; set local role authenticated;`;
/** one statement as `who`, in a transaction that is ROLLED BACK — so a write that succeeds leaves nothing behind */
const tryAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
/** as `who`, committed */
const doAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; commit;`);
const denied = (out: string) => /permission denied/i.test(out);
const blockedByRls = (out: string) => /row-level security/i.test(out);
const ok = (out: string) => !/ERROR|permission denied|row-level security/i.test(out);

const PROTECTED = 'stripe_customer_id';
const SAFE_COLS = ['id', 'business_name', 'description', 'logo_url', 'website', 'is_verified', 'rating_avg', 'rating_count', 'created_at', 'updated_at'];

function policies(table: string): string[] {
  return [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);
}
function createTable(opener: string): string {
  const s = src(BASELINE); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}

/** Production's PRE-FIX state, from the baseline's own text. Idempotent: drops and rebuilds the whole fixture. */
function buildPreFixFixture() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'alter role service_role bypassrls;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    createTable('CREATE TABLE public.shift_employer_profiles ('),
    'alter table public.shift_employer_profiles add constraint shift_employer_profiles_pkey primary key (id);',
    'alter table public.shift_employer_profiles add constraint shift_employer_profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;',
    'alter table public.shift_employer_profiles enable row level security;',
    ...policies('shift_employer_profiles'),
    // a table this migration must NOT touch
    `create table public.control_t (id int primary key, note text, stripe_account_id text); alter table public.control_t enable row level security;
     create policy control_read on public.control_t for select to anon, authenticated using (true);
     grant select, insert, update, delete on public.control_t to anon, authenticated;`,
    // production's table privileges: anon / authenticated arwdxtm (no TRUNCATE), service_role everything
    'revoke all on public.shift_employer_profiles from anon, authenticated, service_role;',
    'grant select, insert, update, delete, references, trigger, maintain on public.shift_employer_profiles to anon, authenticated;',
    'grant all on public.shift_employer_profiles to service_role;',
    'grant all on public.control_t to service_role;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1500)}`);
  const seed = raw(`
    insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
    insert into public.shift_employer_profiles (id, business_name, description, stripe_customer_id) values
      ('${A}', 'A Fishing', 'boats', '${FAKE_A}'), ('${C}', 'C Knitwear', 'wool', '${FAKE_C}');
    insert into public.control_t values (1, 'x', 'acct_FIXTURE');`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed}`);
}

const policySnapshot = () => scalar(`select string_agg(format('%s|%s|%s|%s|%s', policyname, cmd, roles, qual, with_check), E'\\n' order by policyname)
  from pg_policies where schemaname='public' and tablename='shift_employer_profiles'`);
const dataFingerprint = () => scalar(`select md5(string_agg(t::text, '|' order by id)) from public.shift_employer_profiles t where id in ('${A}','${C}')`);
const columnDef = () => scalar(`select string_agg(format('%s|%s|%s|%s', attname, format_type(atttypid, atttypmod), attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid),'')), ';' order by attnum)
  from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.shift_employer_profiles'::regclass and attnum>0 and not attisdropped`);
const controlGrants = () => scalar(`select string_agg(grantee||':'||privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_name='control_t'`);
const has = (role: string, col: string, priv: string) => scalar(`select has_column_privilege('${role}','public.shift_employer_profiles','${col}','${priv}')`) === 't';

let POLICIES_BEFORE = '', DATA_BEFORE = '', COLUMNS_BEFORE = '', CONTROL_BEFORE = '';
let BEFORE_GUARD: { violations: string[]; allowed: string[]; stale: string[] };
const PRE: Record<string, string> = {};

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  buildPreFixFixture();
  POLICIES_BEFORE = policySnapshot(); DATA_BEFORE = dataFingerprint(); COLUMNS_BEFORE = columnDef(); CONTROL_BEFORE = controlGrants();

  // ── the attacks, against the PRE-FIX database: every one must SUCCEED ──
  PRE.anonSelect = tryAs('anon', `select stripe_customer_id from public.shift_employer_profiles where id = '${A}'`);
  PRE.otherSelect = tryAs('b', `select stripe_customer_id from public.shift_employer_profiles where id = '${C}'`);
  PRE.oracle = tryAs('anon', `select count(*) from public.shift_employer_profiles where stripe_customer_id = '${FAKE_A}'`);
  PRE.ownerUpdate = tryAs('a', `update public.shift_employer_profiles set stripe_customer_id = 'cus_ATTACKER' where id = '${A}'`);
  PRE.ownerInsert = tryAs('b', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${B}', 'B Co', '${FAKE_A}')`);
  BEFORE_GUARD = evaluate(guardQuery, ALLOWED_FIXTURE());
});

/** the guard's allow-list is for production's profiles / local_businesses; the fixture has neither, so it runs with none */
function ALLOWED_FIXTURE(): typeof ALLOWED { return []; }

describe('0 · before the fix the exposure is real (controls)', () => {
  test('anon reads another employer\'s customer id', () => assert.match(PRE.anonSelect, new RegExp(FAKE_A)));
  test('an unrelated signed-in user reads an employer\'s customer id', () => assert.match(PRE.otherSelect, new RegExp(FAKE_C)));
  test('the value can be tested without selecting it (WHERE … = guess)', () => assert.equal(rowsOf(PRE.oracle).pop(), '1'));
  test('an owner can overwrite their own row\'s customer id', () => assert.ok(ok(PRE.ownerUpdate), PRE.ownerUpdate));
  test('a user can create a profile carrying someone else\'s customer id', () => assert.ok(ok(PRE.ownerInsert), PRE.ownerInsert));
  test('the guard reports exactly the six exposures (SELECT / INSERT / UPDATE × anon / authenticated)', () => {
    assert.deepEqual([...BEFORE_GUARD.violations].sort(), [
      'direct public.shift_employer_profiles.stripe_customer_id INSERT ← anon',
      'direct public.shift_employer_profiles.stripe_customer_id INSERT ← authenticated',
      'direct public.shift_employer_profiles.stripe_customer_id SELECT ← anon',
      'direct public.shift_employer_profiles.stripe_customer_id SELECT ← authenticated',
      'direct public.shift_employer_profiles.stripe_customer_id UPDATE ← anon',
      'direct public.shift_employer_profiles.stripe_customer_id UPDATE ← authenticated',
    ]);
  });
});

describe('1 · apply the REAL migration', () => {
  test('it runs clean, and its own end-state assertions pass', () => {
    const out = rawFile(FIX);
    assert.doesNotMatch(out, /ERROR/i, out);
  });
  test('it is re-runnable (grants are idempotent)', () => {
    const out = rawFile(FIX);
    assert.doesNotMatch(out, /ERROR/i, out);
  });
});

describe('2 · the protected column is closed to anon and authenticated', () => {
  test('1. anon SELECT is denied', () => assert.ok(denied(tryAs('anon', `select stripe_customer_id from public.shift_employer_profiles`)), 'anon read it'));
  test('2. the owner SELECT is denied', () => assert.ok(denied(tryAs('a', `select stripe_customer_id from public.shift_employer_profiles where id = '${A}'`))));
  test('3. an unrelated authenticated user\'s SELECT is denied', () => assert.ok(denied(tryAs('b', `select stripe_customer_id from public.shift_employer_profiles where id = '${C}'`))));

  test('no other way to read it works: select *, whole-row, WHERE oracle, RETURNING, ORDER BY, aggregate', () => {
    for (const who of ['anon', 'a', 'b'] as Who[]) {
      for (const sql of [
        `select * from public.shift_employer_profiles`,
        `select to_jsonb(t) from public.shift_employer_profiles t`,
        `select t from public.shift_employer_profiles t`,
        `select id from public.shift_employer_profiles where stripe_customer_id = '${FAKE_A}'`,
        `select id from public.shift_employer_profiles where stripe_customer_id is not null`,
        `select id from public.shift_employer_profiles order by stripe_customer_id`,
        `select max(stripe_customer_id) from public.shift_employer_profiles`,
        `select length(stripe_customer_id) from public.shift_employer_profiles`,
      ]) assert.ok(denied(tryAs(who, sql)), `${who} could run: ${sql}`);
    }
    assert.ok(denied(tryAs('a', `update public.shift_employer_profiles set description = 'x' where id = '${A}' returning stripe_customer_id`)), 'RETURNING leaked it');
    assert.ok(denied(tryAs('a', `update public.shift_employer_profiles set description = 'x' where id = '${A}' returning *`)), 'RETURNING * leaked it');
  });

  test('4. anon INSERT setting stripe_customer_id is denied (at privilege level, before RLS)', () => {
    const out = tryAs('anon', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${B}', 'x', 'cus_X')`);
    assert.ok(denied(out), out);
  });
  test('5. an authenticated INSERT setting stripe_customer_id is denied — for their own id, and copying a victim\'s', () => {
    assert.ok(denied(tryAs('b', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${B}', 'B Co', '${FAKE_A}')`)));
    assert.ok(denied(tryAs('b', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${B}', 'B Co', null)`)), 'even writing NULL is a write to the column');
  });
  test('6. the owner UPDATE setting stripe_customer_id is denied (value, NULL, and self-assignment)', () => {
    for (const set of [`'cus_ATTACKER'`, 'null', 'stripe_customer_id']) {
      assert.ok(denied(tryAs('a', `update public.shift_employer_profiles set stripe_customer_id = ${set} where id = '${A}'`)), `set ${set}`);
    }
  });
  test('an upsert that carries the column is denied, whichever way it is written', () => {
    assert.ok(denied(tryAs('a', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${A}', 'A', 'cus_X')
      on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id`)));
    assert.ok(denied(tryAs('a', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id)
      select id, business_name, stripe_customer_id from json_populate_recordset(null::public.shift_employer_profiles, '[{"id":"${A}","business_name":"A","stripe_customer_id":"cus_X"}]'::json)
      on conflict (id) do update set stripe_customer_id = excluded.stripe_customer_id`)));
  });
  test('another user\'s row still cannot be written (RLS unchanged)', () => {
    assert.equal(rowsOf(tryAs('b', `with w as (update public.shift_employer_profiles set description = 'hijack' where id = '${A}' returning 1) select count(*) from w`)).pop(), '0');
  });
  test('column privilege state: neither client role holds SELECT, INSERT or UPDATE on it; every other column keeps all three', () => {
    for (const role of ['anon', 'authenticated']) for (const priv of ['SELECT', 'INSERT', 'UPDATE']) {
      assert.equal(has(role, PROTECTED, priv), false, `${role} still has ${priv}`);
      for (const c of SAFE_COLS) assert.equal(has(role, c, priv), true, `${role} lost ${priv} on ${c}`);
    }
  });
  test('table-level DELETE / REFERENCES / TRIGGER are untouched', () => {
    for (const role of ['anon', 'authenticated']) for (const priv of ['DELETE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(scalar(`select has_table_privilege('${role}','public.shift_employer_profiles','${priv}')`), 't', `${role} ${priv}`);
    }
  });
});

describe('3 · service_role keeps the whole row', () => {
  test('10. service_role can SELECT the protected column (and select *)', () => {
    assert.match(tryAs('service', `select stripe_customer_id from public.shift_employer_profiles where id = '${A}'`), new RegExp(`${FAKE_A}|cus_ATTACKER`));
    assert.ok(ok(tryAs('service', `select * from public.shift_employer_profiles`)));
  });
  test('11. service_role can INSERT and UPDATE it', () => {
    assert.ok(ok(tryAs('service', `insert into public.shift_employer_profiles (id, business_name, stripe_customer_id) values ('${B}', 'B Co', 'cus_FIXTURE_B')`)));
    assert.ok(ok(tryAs('service', `update public.shift_employer_profiles set stripe_customer_id = 'cus_FIXTURE_NEW' where id = '${C}'`)));
    assert.equal(has('service_role', PROTECTED, 'SELECT') && has('service_role', PROTECTED, 'INSERT') && has('service_role', PROTECTED, 'UPDATE'), true);
  });
});

/** The exact statements the apps send, written the way PostgREST turns them into SQL. */
describe('4 · ordinary employer-profile traffic keeps working', () => {
  const upsertSql = (id: string, cols: Record<string, string | boolean | null>, ignoreDuplicates = false, returning = '') => {
    const names = Object.keys(cols);
    const json = JSON.stringify([{ id, ...cols }]).replace(/'/g, "''");
    const list = ['id', ...names].map((n) => `"${n}"`).join(', ');
    return `insert into public.shift_employer_profiles (${list}) select ${list} from json_populate_recordset(null::public.shift_employer_profiles, '${json}'::json) _
      on conflict ("id") ${ignoreDuplicates ? 'do nothing' : `do update set ${['id', ...names].map((n) => `"${n}" = excluded."${n}"`).join(', ')}`} ${returning}`;
  };

  test('7. SELECT of the legitimate columns works for the owner, an unrelated user and anon (build 147 / web shapes)', () => {
    for (const who of ['a', 'b', 'anon'] as Who[]) {
      // mobile app/employer-profile.tsx
      assert.match(tryAs(who, `select business_name, description from public.shift_employer_profiles where id = '${A}'`), /A Fishing/, who);
      // mobile lib/shifts-api.ts (list) and web lib/jobs-data.ts
      assert.match(tryAs(who, `select id, business_name, logo_url, is_verified from public.shift_employer_profiles where id in ('${A}','${C}')`), /C Knitwear/, who);
      // mobile lib/shifts-api.ts (detail, matching)
      assert.match(tryAs(who, `select business_name, logo_url, is_verified from public.shift_employer_profiles where id = '${C}'`), /C Knitwear/, who);
      // web lib/jobs-data.server.ts
      assert.match(tryAs(who, `select business_name, description, is_verified, logo_url from public.shift_employer_profiles where id = '${A}'`), /A Fishing/, who);
      // every safe column, and count(*)
      assert.ok(ok(tryAs(who, `select ${SAFE_COLS.join(', ')} from public.shift_employer_profiles`)), who);
      assert.equal(rowsOf(tryAs(who, 'select count(*) from public.shift_employer_profiles')).pop(), '2', who);
    }
  });

  test('8. INSERT / upsert of the legitimate columns works (mobile employer-profile + ShiftPostForm, web EmployerProfileForm + ShiftPostForm)', () => {
    // mobile ShiftPostForm: { id, business_name, is_verified:false, logo_url:null } with ignoreDuplicates (ON CONFLICT DO NOTHING)
    const mobileShift = tryAs('b', upsertSql(B, { business_name: 'B Co', is_verified: false, logo_url: null }, true));
    assert.ok(ok(mobileShift), mobileShift);
    // mobile employer-profile.tsx / web EmployerProfileForm: { id, business_name, description, is_verified:false, logo_url:null } onConflict id
    const profileForm = tryAs('b', upsertSql(B, { business_name: 'B Co', description: 'knits', is_verified: false, logo_url: null }));
    assert.ok(ok(profileForm), profileForm);
    // web ShiftPostForm: { id, business_name, is_verified:false } onConflict id
    const webShift = tryAs('b', upsertSql(B, { business_name: 'B Co', is_verified: false }));
    assert.ok(ok(webShift), webShift);
    // the json_to_recordset form of the same statement (newer PostgREST)
    const recordset = tryAs('b', `insert into public.shift_employer_profiles (id, business_name, is_verified)
      select id, business_name, is_verified from json_to_recordset('[{"id":"${B}","business_name":"B Co","is_verified":false}]'::json) as _(id uuid, business_name text, is_verified boolean)
      on conflict (id) do update set id = excluded.id, business_name = excluded.business_name, is_verified = excluded.is_verified`);
    assert.ok(ok(recordset), recordset);
    // Prefer: return=representation with an explicit column list (upsert().select('id, business_name'))
    assert.match(tryAs('b', upsertSql(B, { business_name: 'B Co' }, false, 'returning id, business_name')), /B Co/);
    // …and the row really persisted when committed
    doAs('b', upsertSql(B, { business_name: 'B Co', description: 'knits' }));
    assert.equal(scalar(`select business_name from public.shift_employer_profiles where id = '${B}'`), 'B Co');
    // a user still cannot create or take over someone else's profile
    assert.ok(blockedByRls(tryAs('b', upsertSql(A, { business_name: 'taken over' }))), 'RLS must still refuse another user\'s id');
    assert.ok(blockedByRls(tryAs('anon', upsertSql(B, { business_name: 'anon' }))), 'anon INSERT still reaches RLS, which refuses it');
  });

  test('9. UPDATE of the legitimate columns works (owner), and RLS still scopes it', () => {
    const out = tryAs('a', `update public.shift_employer_profiles set business_name = 'A Fishing Ltd', description = 'more boats', logo_url = 'https://x/y.png', website = 'https://a.example' where id = '${A}'`);
    assert.ok(ok(out), out);
    assert.equal(rowsOf(tryAs('a', `with w as (update public.shift_employer_profiles set description = 'd' where id = '${A}' returning 1) select count(*) from w`)).pop(), '1');
    assert.equal(rowsOf(tryAs('b', `with w as (update public.shift_employer_profiles set description = 'd' where id = '${A}' returning 1) select count(*) from w`)).pop(), '0');
  });

  test('the one thing that changes: a wildcard read or a bare returning-representation upsert is now refused', () => {
    // No current caller does either (section 5 proves it for the mobile source). Recorded so the behaviour is deliberate, not accidental.
    assert.ok(denied(tryAs('a', 'select * from public.shift_employer_profiles')));
    assert.ok(denied(tryAs('b', upsertSql(B, { business_name: 'B Co' }, false, 'returning *'))));
  });
});

describe('5 · nothing else moved', () => {
  test('RLS policies are byte-identical', () => assert.equal(policySnapshot(), POLICIES_BEFORE));
  test('RLS is still enabled', () => assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.shift_employer_profiles'::regclass`), 't'));
  test('column definitions (type, default, nullability) are unchanged and the column still exists', () => assert.equal(columnDef(), COLUMNS_BEFORE));
  test('stored data is unchanged: the two seeded employer rows, protected value included, are byte-identical', () => {
    assert.equal(dataFingerprint(), DATA_BEFORE);
    assert.equal(scalar(`select stripe_customer_id from public.shift_employer_profiles where id = '${A}'`), FAKE_A);
    assert.equal(scalar(`select stripe_customer_id from public.shift_employer_profiles where id = '${C}'`), FAKE_C);
  });
  test('a neighbouring table\'s privileges are untouched', () => assert.equal(controlGrants(), CONTROL_BEFORE));
});

describe('6 · the mobile source never asks for the protected column or for a wildcard', () => {
  /** every place the app source mentions the table */
  const roots = ['app', 'components', 'lib', 'hooks', 'context'].map((d) => join(REPO_ROOT, d));
  const files: string[] = [];
  const walk = (d: string) => { let names: string[] = []; try { names = readdirSync(d); } catch { return; }
    for (const n of names) { if (n === 'node_modules') continue; const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(n)) files.push(p); } };
  roots.forEach(walk);

  test('the app source is present to be scanned', () => assert.ok(files.length > 50, `only ${files.length} files found`));

  test('every mention is a .from(\'shift_employer_profiles\') chain with an explicit column list, no wildcard, no returning, no embed', () => {
    let chains = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/shift_employer_profiles/g)) {
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const line = text.slice(lineStart, text.indexOf('\n', m.index));
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;                         // a comment
        const before = text.slice(Math.max(0, m.index! - 8), m.index);
        assert.match(before, /from\(['"`]$/, `${f}: "shift_employer_profiles" used other than as .from('…') — an embed or string query? → ${line.trim()}`);
        chains++;
        const stmt = text.slice(m.index!, text.indexOf(';', m.index));
        const own = stmt.split(/local_businesses|Promise\.resolve/)[0];            // this chain only, not the sibling query in the same Promise.all
        assert.doesNotMatch(own, /\.select\(\s*(['"`]\*['"`])?\s*\)/, `${f}: wildcard / bare select on shift_employer_profiles`);
        assert.doesNotMatch(own, /stripe_customer/, `${f}: reads or writes the protected column`);
        assert.doesNotMatch(own, /returning/i, `${f}: returning on shift_employer_profiles`);
      }
    }
    assert.ok(chains >= 6, `expected the known call sites, found ${chains}`);
  });
});

describe('7 · the generic Stripe-customer exposure guard', () => {
  test('12. after the fix, no Stripe customer-id column is exposed to anon / authenticated', () => {
    const r = evaluate(guardQuery, ALLOWED_FIXTURE());
    assert.deepEqual(r.violations, []);
  });

  test('it counts account, PaymentIntent, SetupIntent and plain customer_id columns as NOT customer ids', () => {
    raw(`create table public.fx_other (id uuid primary key, stripe_account_id text, stripe_payment_intent_id text, stripe_setup_intent_id text,
           stripe_subscription_id text, customer_id uuid, customer_confirmed boolean);
         grant select, insert, update on public.fx_other to anon, authenticated;`);
    try {
      assert.deepEqual(evaluate(guardQuery, []).violations, [], 'a readable account / intent / app-user id must not be reported as a customer id');
    } finally { raw('drop table public.fx_other'); }
  });

  test('it is generic: a brand-new table, other spellings, and a view over the column are all caught', () => {
    raw(`create table public.fx_new (id uuid primary key, business_stripe_customer_id text, stripe_customer text, customer_stripe_id text);
         grant select on public.fx_new to authenticated;
         grant insert (stripe_customer) on public.fx_new to anon;
         create table public.fx_base (id uuid primary key, stripe_customer_id text);
         create view public.fx_view as select id, stripe_customer_id as hidden_name from public.fx_base;
         grant select on public.fx_view to anon;`);
    try {
      const v = evaluate(guardQuery, []).violations.sort();
      assert.deepEqual(v, [
        'derived public.fx_view.stripe_customer_id SELECT ← anon',
        'direct public.fx_new.business_stripe_customer_id SELECT ← authenticated',
        'direct public.fx_new.customer_stripe_id SELECT ← authenticated',
        'direct public.fx_new.stripe_customer INSERT ← anon',
        'direct public.fx_new.stripe_customer SELECT ← authenticated',
      ].sort());
    } finally { raw('drop view public.fx_view; drop table public.fx_base; drop table public.fx_new'); }
  });

  test('an allow-list entry is honoured only while its stated reason still holds, and a stale entry fails', () => {
    const entry = { relation: 'public.fx_p', column: 'stripe_customer_id', access: 'SELECT', requires: ['rls-confined'], why: 'owner row only' };
    raw(`create table public.fx_p (id uuid primary key, stripe_customer_id text); alter table public.fx_p enable row level security;
         create policy own on public.fx_p for select to authenticated using (auth.uid() = id);
         grant select (id, stripe_customer_id) on public.fx_p to authenticated;`);
    try {
      let r = evaluate(guardQuery, [entry]);
      assert.deepEqual(r.violations, []); assert.deepEqual(r.stale, []); assert.equal(r.allowed.length, 1);
      raw(`create policy open_read on public.fx_p for select to anon, authenticated using (true)`);
      r = evaluate(guardQuery, [entry]);
      assert.match(r.violations.join('\n'), /allow-list requirement no longer holds: rls-confined/, 'USING (true) must void the exception');
      raw(`drop policy open_read on public.fx_p; alter table public.fx_p disable row level security`);
      assert.match(evaluate(guardQuery, [entry]).violations.join('\n'), /rls-confined/, 'RLS off must void the exception');
      raw('revoke select on public.fx_p from authenticated');
      assert.deepEqual(evaluate(guardQuery, [entry]).stale, ['public.fx_p.stripe_customer_id SELECT'], 'an entry that matches nothing is stale');
    } finally { raw('drop table public.fx_p'); }
  });

  test('the production allow-list is small, documented and only names columns that exist in production', () => {
    for (const e of ALLOWED) {
      assert.ok(e.why.length > 30, `${e.relation}.${e.column} needs a real justification`);
      assert.ok(e.requires.length >= 1, `${e.relation}.${e.column} needs a machine-checked requirement`);
      assert.match(e.column, new RegExp(NAME_PATTERN, 'i'));
    }
    assert.ok(!ALLOWED.some((e: { relation: string }) => e.relation === 'public.shift_employer_profiles'), 'shift_employer_profiles must never be allow-listed');
    assert.ok(!ALLOWED.some((e: { access: string; relation: string; column: string }) => e.access === 'SELECT' && e.relation === 'public.local_businesses'), 'local_businesses customer ids are not client-readable');
  });
});

describe('8 · mutation controls: the protection is load-bearing', () => {
  test('13a. re-granting the column to anon reopens the leak, and the guard and the attack both notice', () => {
    raw(`grant select (stripe_customer_id) on public.shift_employer_profiles to anon`);
    try {
      assert.match(evaluate(guardQuery, []).violations.join('\n'), /shift_employer_profiles\.stripe_customer_id SELECT ← anon/);
      assert.match(tryAs('anon', `select stripe_customer_id from public.shift_employer_profiles where id = '${C}'`), /cus_FIXTURE/);
    } finally { raw(`revoke select (stripe_customer_id) on public.shift_employer_profiles from anon`); }
    assert.deepEqual(evaluate(guardQuery, []).violations, []);
  });
  test('13b. re-granting table-level UPDATE to authenticated reopens the write, and the guard notices', () => {
    raw(`grant update on public.shift_employer_profiles to authenticated`);
    try {
      assert.match(evaluate(guardQuery, []).violations.join('\n'), /UPDATE ← authenticated/);
      assert.ok(ok(tryAs('a', `update public.shift_employer_profiles set stripe_customer_id = 'cus_ATTACKER' where id = '${A}'`)), 'the write is possible again');
    } finally { raw(`revoke update on public.shift_employer_profiles from authenticated; grant update (${SAFE_COLS.join(', ')}) on public.shift_employer_profiles to authenticated`); }
    assert.deepEqual(evaluate(guardQuery, []).violations, []);
  });
  test('13c. a table-level SELECT grant (the original mistake) is caught', () => {
    raw(`grant select on public.shift_employer_profiles to authenticated`);
    try { assert.match(evaluate(guardQuery, []).violations.join('\n'), /SELECT ← authenticated/); }
    finally { raw(`revoke select on public.shift_employer_profiles from authenticated; grant select (${SAFE_COLS.join(', ')}) on public.shift_employer_profiles to authenticated`); }
    assert.deepEqual(evaluate(guardQuery, []).violations, []);
  });
  test('13d. a migration whose REVOKE is missing refuses to commit (its own end-state assertion fires)', () => {
    buildPreFixFixture();
    const mutated = src(FIX).replace(/^revoke select, insert, update on table public\.shift_employer_profiles from anon, authenticated;$/m, '-- (revoke removed)');
    assert.notEqual(mutated, src(FIX), 'the revoke statement was not found to remove');
    const tmp = join(REPO_ROOT, 'node_modules', '.cache', 'stripe-customer-exposure-mutated.sql');
    spawnSync('mkdir', ['-p', dirname(tmp)]);
    spawnSync('sh', ['-c', `cat > '${tmp}'`], { input: mutated });
    const out = rawFile(tmp);
    assert.match(out, /still has|lost/, out);
    assert.equal(has('anon', PROTECTED, 'SELECT'), true, 'rolled back: the exposure is still there, i.e. the broken migration did nothing');
    // restore the fixed state for anything that runs after
    assert.doesNotMatch(rawFile(FIX), /ERROR/i);
    assert.equal(has('anon', PROTECTED, 'SELECT'), false);
  });
});

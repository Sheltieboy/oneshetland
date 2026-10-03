/**
 * launch-plan-grants.node.test.ts — the launch-partner plan grant, against the real SQL.
 *
 * WHAT THIS PROVES
 *
 * Real directory businesses are all Free, and offers (Pro), products and passes (Premium) and bookings (Pro) are
 * plan-gated in the database. Plan columns are locked against every client, and the old "Grant discount" tool wrote
 * rows nothing reads. admin_grant_launch_plan / admin_revoke_launch_plan (migration 20261103000000) put a real
 * business on a plan WITHOUT Stripe, with an expiry, an audit row, and no way to hurt a paying customer.
 *
 * WHAT IS ASSERTED — against the real function, policies, triggers and the real subscription writer, executed
 *   A  Pro grant: entitled to pro (not premium); the audit row records who/why/when; a public offer appears
 *   B  Premium grant: entitled to both
 *   C  expiry: past the date the business stops meeting the tier by itself; public content disappears; nothing to revert
 *   D  revoke: back to Free, audit closed with a reason, repeat is a harmless no-op
 *   E  wrong business: unknown/null id refused; other businesses untouched
 *   F  invalid tier refused
 *   G  past / too-soon / too-far / missing expiry, missing reason, missing operator — refused, nothing written
 *   H  ordinary users denied (customer, the OWNER, anon, authenticated-without-uid); owner cannot write the tier
 *      or the audit table; owner can read their own grant
 *   I  admin, service role and a direct session are allowed
 *   J  a genuine Stripe subscription is protected (refused, untouched); so is a live paid boost; an expired one is fine
 *   K  a later genuine subscription supersedes the grant through the real writer, revoke cannot touch the paid plan,
 *      and a later cancel behaves exactly as for any business
 *   L  idempotent: same grant twice records once; a change replaces the previous grant; one open grant per business
 *   M  owner / public / admin entitlement agree in every state; no Stripe object or money row is created
 *   N  the dead "Grant discount" write is refused with a pointer to the real tool
 *   O  the admin screen's business lookup: admin-only, finds inactive listings, reports facts (subscription? grant?)
 *      without leaking any Stripe identifier
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const LOCKS = join(MIG, '20260819180000_lock_server_managed_columns.sql');
const MEETS = join(MIG, '20260916120000_business_meets_tier.sql');
const FRESH = join(MIG, '20260902120000_subscription_event_freshness.sql');
const RECON = join(MIG, '20260903120000_subscription_same_second_reconcile.sql');
const BINDING = join(MIG, '20260904120000_subscription_business_binding.sql');
const GRANTS = join(MIG, '20261103000000_launch_plan_grants.sql');
const LOOKUP = join(MIG, '20261103010000_admin_launch_business_lookup.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const as = (uid: string | null, role: 'authenticated' | 'anon' | 'service_role', sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${role}; ${sql}; commit;`);
const asUser = (uid: string, sql: string) => as(uid, 'authenticated', sql);
const asService = (sql: string) => as(null, 'service_role', sql);

function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start + opener.length); assert.notEqual(end, -1, `${closer} after ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
const policies = (table: string) =>
  [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);

const ADMIN = 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0';
const CUSTOMER = 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0';
const OWNER_A = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const OWNER_B = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const biz = (n: number) => `d${n}d${n}d${n}d${n}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAFE = biz(1), SHOP = biz(2), KILN = biz(3), BOOSTY = biz(4), SUBBED = biz(5), LAPSED = biz(6), BAKERY = biz(7), FERRY = biz(8);
const NOBODY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REASON = 'Launch partner: first real listing for the Shop';
const IN = (days: number) => `now() + interval '${days} days'`;

const grant = (biz_: string, tier: string, expiry: string, reason = REASON, operator = '') =>
  `select public.admin_grant_launch_plan('${biz_}', ${tier === 'NULL' ? 'null' : `'${tier}'`}, ${expiry}, ${reason === 'NULL' ? 'null' : `'${reason}'`}${operator ? `, '${operator}'` : ''})`;
const revoke = (biz_: string, reason = 'Partner asked to pause', operator = '') =>
  `select public.admin_revoke_launch_plan('${biz_}', '${reason}'${operator ? `, '${operator}'` : ''})`;
const tierOf = (id: string) => scalar(`select subscription_tier || '|' || coalesce(subscription_until::text, 'null') from public.local_businesses where id='${id}'`);
const meets = (id: string, tier: string) => scalar(`select public.business_meets_tier('${id}', '${tier}')`);
const statusOf = (id: string) => scalar(`select status from public.admin_list_launch_plans() where business_id='${id}' order by created_at desc limit 1`);
const grantRows = (id: string) => Number(scalar(`select count(*) from public.launch_plan_grants where business_id='${id}'`));
const OK = /ERROR|denied|violates|must|required|refus/i;

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
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
    'create table public.profiles (id uuid primary key, role text default \'customer\');',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    'alter table public.local_businesses enable row level security;',
    ...policies('local_businesses'),
    slice(BASELINE, 'CREATE FUNCTION public.is_admin()', '$$;'),
    // Production's own helpers, as deployed (read from the live database 3 Oct 2026).
    `create function public.is_business_owner(p_business uuid, p_user uuid) returns boolean language sql stable security definer
       set search_path to 'public', 'pg_temp' as $$ select exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = p_user) $$;`,
    slice(MEETS, 'create or replace function public.business_meets_tier(', '$$;'),
    // The REAL column lock: the thing that makes "an owner cannot set their own plan" true.
    slice(LOCKS, 'create or replace function public.tg_is_trusted_writer()', '$$;'),
    slice(LOCKS, 'create or replace function public.tg_lock_business_columns()', '$$;'),
    `create trigger tg_zz_lock_business_columns before insert or update on public.local_businesses
       for each row execute function public.tg_lock_business_columns();`,
    // A plan-gated public table, with the production read policy.
    `create table public.local_offers (id uuid primary key default gen_random_uuid(), business_id uuid not null references public.local_businesses(id), title text, is_active boolean default true);`,
    'alter table public.local_offers enable row level security;',
    `create policy "Anyone can read active offers" on public.local_offers for select
       using (((is_active = true) AND public.business_meets_tier(business_id, 'pro'::text)) OR public.is_business_owner(business_id, auth.uid()));`,
    // The REAL subscription writer and its collaborators — so "a later genuine subscription supersedes" is measured.
    createTable(FRESH, 'create table if not exists public.stripe_subscription_watermarks'),
    `create table public.local_subscription_attempts (id uuid primary key default gen_random_uuid(), business_id uuid, stripe_subscription_id text, created_at timestamptz default now());`,
    slice(RECON, 'create or replace function public.claim_subscription_event(', '$function$;'),
    slice(BINDING, 'create or replace function public.resolve_subscription_business(', '$function$;'),
    slice(BINDING, 'create or replace function public.apply_subscription_state(', '$function$;'),
    slice(RECON, 'create or replace function public.retire_subscription(', '$function$;'),
    // The dead tool's table, as production has it.
    createTable(BASELINE, 'CREATE TABLE public.business_discount_grants ('),
    'alter table public.business_discount_grants enable row level security;',
    'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on function public.is_admin(), public.is_business_owner(uuid, uuid), public.business_meets_tier(uuid, text) to anon, authenticated, service_role;',
    src(GRANTS),
    src(LOOKUP),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 2000)}`);
  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${CUSTOMER}', 'customer'), ('${OWNER_A}', 'customer'), ('${OWNER_B}', 'customer');
    ${[[CAFE, 'Harbour Café', OWNER_A], [SHOP, 'Voe Gift Shop', OWNER_B], [KILN, 'Kiln Pottery', null], [BOOSTY, 'Boosted Bakers', null],
        [SUBBED, 'Paying Joiners', null], [LAPSED, 'Lapsed Boost', null], [BAKERY, 'Bakery', null], [FERRY, 'Ferry Tours', null]]
      .map(([id, name, owner]) => `insert into public.local_businesses (id, name, category, address, owner_id) values ('${id}', '${name}', 'retail', 'Lerwick', ${owner ? `'${owner}'` : 'null'});`).join('\n')}
    insert into public.local_offers (business_id, title) values ('${CAFE}', 'Soup of the day'), ('${SHOP}', 'Free wrap');
    -- a LIVE paid boost (pro, future end, no subscription, no grant) and an EXPIRED one
    update public.local_businesses set subscription_tier='pro', subscription_until=${IN(10)} where id='${BOOSTY}';
    update public.local_businesses set subscription_tier='pro', subscription_until=now() - interval '3 days' where id='${LAPSED}';`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 800)}`);
});

describe('A — Pro grant', () => {
  test('an admin grants Pro with an expiry: entitled to pro, not premium, nothing else changed', () => {
    const out = asUser(ADMIN, grant(CAFE, 'pro', IN(180)));
    assert.doesNotMatch(out, OK, out);
    assert.match(out, /"applied": true/);
    assert.match(tierOf(CAFE), /^pro\|/);
    assert.equal(meets(CAFE, 'pro'), 't');
    assert.equal(meets(CAFE, 'premium'), 'f');
  });
  test('the audit row records business, tier, start, expiry, reason, who, when; not revoked', () => {
    const r = scalar(`select tier || '|' || (expires_at > now() + interval '170 days') || '|' || (starts_at <= now()) || '|' || reason || '|' || granted_by || '|' || granted_via || '|' || (created_at is not null) || '|' || coalesce(revoked_at::text, 'open') from public.launch_plan_grants where business_id='${CAFE}'`);
    assert.equal(r, `pro|true|true|${REASON}|${ADMIN}|admin|true|open`);
  });
  test('the grant opens the public gate: an anonymous visitor now sees the café\'s offer, and not the shop\'s', () => {
    assert.deepEqual(rowsOf(as(null, 'anon', `select title from public.local_offers order by title`)), ['Soup of the day']);
  });
});

describe('B — Premium grant', () => {
  test('Premium meets both tiers', () => {
    const out = asUser(ADMIN, grant(SHOP, 'premium', IN(365)));
    assert.doesNotMatch(out, OK, out);
    assert.equal(meets(SHOP, 'pro'), 't');
    assert.equal(meets(SHOP, 'premium'), 't');
    assert.deepEqual(rowsOf(as(null, 'anon', `select title from public.local_offers order by title`)), ['Free wrap', 'Soup of the day']);
  });
});

describe('C — expiry ends it by itself', () => {
  test('past subscription_until the business stops meeting the tier and public content goes; no job, no revert', () => {
    // time passes: the grant's window and the plan's end both lie in the past (they are written equal)
    raw(`update public.launch_plan_grants set starts_at = now() - interval '200 days', expires_at = now() - interval '1 minute' where business_id='${CAFE}';
         update public.local_businesses set subscription_until = now() - interval '1 minute' where id='${CAFE}'`);
    assert.equal(meets(CAFE, 'pro'), 'f');
  });
  test('the admin list reports it as expired, and the audit row is untouched', () => {
    assert.equal(rowsOf(asUser(ADMIN, `select status from public.admin_list_launch_plans() where business_id='${CAFE}'`)).pop(), 'expired');
    assert.deepEqual(rowsOf(as(null, 'anon', `select title from public.local_offers order by title`)), ['Free wrap']);
    assert.equal(scalar(`select count(*) from public.launch_plan_grants where business_id='${CAFE}' and revoked_at is null`), '1');
  });
  test('a fresh grant after expiry replaces the old row and works again', () => {
    const out = asUser(ADMIN, grant(CAFE, 'pro', IN(90)));
    assert.match(out, /replaced_previous_grant/);
    assert.equal(meets(CAFE, 'pro'), 't');
    assert.equal(scalar(`select count(*) from public.launch_plan_grants where business_id='${CAFE}' and revoked_at is null and superseded_at is null`), '1');
  });
});

describe('D — revoke', () => {
  test('revoke returns the business to Free, closes the audit row with a reason, and hides the content', () => {
    asUser(ADMIN, grant(KILN, 'premium', IN(60)));
    const out = asUser(ADMIN, revoke(KILN, 'Partner asked to pause'));
    assert.match(out, /"applied": true/);
    assert.equal(tierOf(KILN), 'free|null');
    assert.equal(meets(KILN, 'premium'), 'f');
    assert.equal(scalar(`select (revoked_at is not null) || '|' || revoke_reason || '|' || revoked_by from public.launch_plan_grants where business_id='${KILN}'`), `true|Partner asked to pause|${ADMIN}`);
    assert.equal(rowsOf(asUser(ADMIN, `select status from public.admin_list_launch_plans() where business_id='${KILN}'`)).pop(), 'revoked');
  });
  test('revoking again is a harmless no-op, and revoking a never-granted business changes nothing', () => {
    assert.match(asUser(ADMIN, revoke(KILN)), /no_open_grant/);
    assert.match(asUser(ADMIN, revoke(BAKERY)), /no_open_grant/);
    assert.equal(tierOf(BAKERY), 'free|null');
  });
});

describe('E — wrong business', () => {
  test('an unknown business id and a null id are refused', () => {
    assert.match(asUser(ADMIN, grant(NOBODY, 'pro', IN(30))), /No such business/);
    assert.match(asUser(ADMIN, `select public.admin_grant_launch_plan(null, 'pro', ${IN(30)}, '${REASON}')`), /business is required/);
    assert.match(asUser(ADMIN, revoke(NOBODY)), /No such business/);
  });
  test('granting one business touches no other; the audit table names only the one', () => {
    const before_ = scalar(`select string_agg(id::text || subscription_tier || coalesce(subscription_until::text,''), ',' order by id) from public.local_businesses where id not in ('${FERRY}')`);
    asUser(ADMIN, grant(FERRY, 'pro', IN(45)));
    assert.equal(scalar(`select string_agg(id::text || subscription_tier || coalesce(subscription_until::text,''), ',' order by id) from public.local_businesses where id not in ('${FERRY}')`), before_);
    assert.equal(grantRows(FERRY), 1);
    asUser(ADMIN, revoke(FERRY));
  });
});

describe('F — invalid tier', () => {
  for (const t of ['free', 'gold', 'PRO', 'premium ', '']) {
    test(`tier '${t}' is refused and nothing is written`, () => {
      const n = grantRows(BAKERY);
      assert.match(asUser(ADMIN, grant(BAKERY, t, IN(30))), /Tier must be pro or premium/);
      assert.equal(grantRows(BAKERY), n);
      assert.equal(tierOf(BAKERY), 'free|null');
    });
  }
  test('a null tier is refused', () => {
    assert.match(asUser(ADMIN, grant(BAKERY, 'NULL', IN(30))), /Tier must be pro or premium/);
  });
});

describe('G — expiry, reason and operator are mandatory', () => {
  const cases: [string, string, RegExp][] = [
    ['an expiry in the past', "now() - interval '1 day'", /at least a day/],
    ['an expiry in 12 hours', "now() + interval '12 hours'", /at least a day/],
    ['an expiry beyond 24 months', "now() + interval '25 months'", /more than 24 months/],
    ['a missing expiry', 'null', /expiry date is required/],
  ];
  for (const [name, expr, re] of cases) {
    test(`${name} is refused`, () => {
      assert.match(asUser(ADMIN, `select public.admin_grant_launch_plan('${BAKERY}', 'pro', ${expr}, '${REASON}')`), re);
      assert.equal(tierOf(BAKERY), 'free|null');
      assert.equal(grantRows(BAKERY), 0);
    });
  }
  test('23 months is accepted (the cap is a ceiling, not a wall)', () => {
    assert.match(asUser(ADMIN, `select public.admin_grant_launch_plan('${BAKERY}', 'pro', now() + interval '23 months', '${REASON}')`), /"applied": true/);
    asUser(ADMIN, revoke(BAKERY));
  });
  test('a missing or token reason is refused', () => {
    assert.match(asUser(ADMIN, grant(BAKERY, 'pro', IN(30), 'NULL')), /reason of at least 10/);
    assert.match(asUser(ADMIN, grant(BAKERY, 'pro', IN(30), 'because')), /reason of at least 10/);
    assert.equal(grantRows(BAKERY), 1);   // only the revoked 23-month row from the test above
  });
  test('outside an admin session an operator name is required; with one it is recorded', () => {
    assert.match(raw(`${grant(BAKERY, 'pro', IN(30))}`), /Say who is granting this/);
    assert.match(raw(`${grant(BAKERY, 'pro', IN(30), REASON, 'Darren')}`), /"applied": true/);
    assert.equal(scalar(`select granted_by_label || '|' || granted_via from public.launch_plan_grants where business_id='${BAKERY}' and revoked_at is null`), 'Darren|direct_sql');
    raw(revoke(BAKERY, 'cleanup after test', 'Darren'));
  });
});

describe('H — ordinary users are denied', () => {
  const callers: [string, () => string][] = [
    ['a customer', () => asUser(CUSTOMER, grant(BAKERY, 'premium', IN(30)))],
    ['the business owner themselves', () => asUser(OWNER_B, grant(SHOP, 'premium', IN(500)))],
    ['a signed-out visitor', () => as(null, 'anon', grant(BAKERY, 'premium', IN(30)))],
    ['authenticated with no user id', () => as(null, 'authenticated', grant(BAKERY, 'premium', IN(30)))],
  ];
  for (const [who, run] of callers) {
    test(`${who} cannot grant`, () => {
      const out = run();
      assert.match(out, /Only an administrator|permission denied/i, out);
      assert.equal(tierOf(BAKERY), 'free|null');
    });
  }
  test('nor revoke, nor list', () => {
    assert.match(asUser(OWNER_A, revoke(CAFE)), /Only an administrator/);
    assert.match(asUser(CUSTOMER, `select * from public.admin_list_launch_plans()`), /Only an administrator/);
    assert.match(as(null, 'anon', `select * from public.admin_list_launch_plans()`), /permission denied/i);
    assert.equal(meets(CAFE, 'pro'), 't');
  });
  test('an owner cannot write their own plan: the column lock silently restores it', () => {
    asUser(OWNER_A, `update public.local_businesses set subscription_tier='premium', subscription_until=${IN(900)}, name='Harbour Café' where id='${CAFE}'`);
    assert.match(tierOf(CAFE), /^pro\|/);
    assert.equal(meets(CAFE, 'premium'), 'f');
  });
  test('nobody but the service role can write the audit table; the owner reads only their own grant', () => {
    assert.match(asUser(OWNER_A, `insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${CAFE}', 'premium', ${IN(30)}, 'forged forged forged', 'admin')`), /permission denied/i);
    assert.match(asUser(ADMIN, `update public.launch_plan_grants set tier='premium'`), /permission denied/i);
    assert.equal(rowsOf(asUser(OWNER_A, `select count(*) from public.launch_plan_grants`)).pop(), String(grantRows(CAFE)));
    assert.equal(rowsOf(asUser(OWNER_A, `select tier from public.launch_plan_grants where business_id='${CAFE}' and superseded_at is null`)).pop(), 'pro');
    assert.equal(rowsOf(asUser(CUSTOMER, `select count(*) from public.launch_plan_grants`)).pop(), '0');
    assert.ok(Number(rowsOf(asUser(ADMIN, `select count(*) from public.launch_plan_grants`)).pop()) >= 3);
  });
});

describe('I — admin, service role and a direct session are allowed', () => {
  test('the service role may grant and revoke, and is recorded as such', () => {
    assert.match(asService(`${grant(BAKERY, 'pro', IN(30), REASON, 'launch script')}`), /"applied": true/);
    assert.equal(scalar(`select granted_via || '|' || granted_by_label from public.launch_plan_grants where business_id='${BAKERY}' and revoked_at is null`), 'service_role|launch script');
    assert.match(asService(`${revoke(BAKERY, 'cleanup after test', 'launch script')}`), /"applied": true/);
  });
  test('the admin list works for an admin and for a direct session', () => {
    assert.ok(rowsOf(asUser(ADMIN, `select * from public.admin_list_launch_plans()`)).length >= 3);
    assert.ok(rowsOf(raw(`select * from public.admin_list_launch_plans()`)).length >= 3);
  });
});

describe('J — a genuine paid plan is protected', () => {
  test('a business with a genuine subscription is refused, byte-for-byte unchanged, with no audit row', () => {
    raw(`insert into public.local_subscription_attempts (business_id, stripe_subscription_id) values ('${SUBBED}', 'sub_paying');
         select public.apply_subscription_state('sub_paying', 'cus_paying', 'active', 'premium', ${IN(20)}, false, 1000, false, '${SUBBED}')`);
    const before_ = scalar(`select subscription_tier || subscription_until || stripe_subscription_id || stripe_customer_id from public.local_businesses where id='${SUBBED}'`);
    assert.match(asUser(ADMIN, grant(SUBBED, 'premium', IN(300))), /already has a genuine subscription/);
    assert.match(asUser(ADMIN, grant(SUBBED, 'pro', IN(300))), /already has a genuine subscription/);
    assert.equal(scalar(`select subscription_tier || subscription_until || stripe_subscription_id || stripe_customer_id from public.local_businesses where id='${SUBBED}'`), before_);
    assert.equal(grantRows(SUBBED), 0);
  });
  test('a live paid boost is refused too; an EXPIRED one is fine', () => {
    const before_ = tierOf(BOOSTY);
    assert.match(asUser(ADMIN, grant(BOOSTY, 'premium', IN(60))), /already holds a live pro plan/);
    assert.equal(tierOf(BOOSTY), before_);
    assert.equal(grantRows(BOOSTY), 0);
    assert.match(asUser(ADMIN, grant(LAPSED, 'pro', IN(60))), /"applied": true/);
    asUser(ADMIN, revoke(LAPSED, 'cleanup after test'));
  });
});

describe('K — a later genuine subscription supersedes the grant', () => {
  test('the real subscription writer takes over; the grant reports replaced_by_subscription', () => {
    asUser(ADMIN, grant(KILN, 'premium', IN(200)));
    assert.equal(meets(KILN, 'premium'), 't');
    raw(`insert into public.local_subscription_attempts (business_id, stripe_subscription_id) values ('${KILN}', 'sub_kiln');
         select public.apply_subscription_state('sub_kiln', 'cus_kiln', 'active', 'pro', ${IN(30)}, false, 2000, false, '${KILN}')`);
    assert.equal(scalar(`select subscription_tier || '|' || stripe_subscription_id from public.local_businesses where id='${KILN}'`), 'pro|sub_kiln');
    assert.equal(rowsOf(asUser(ADMIN, `select status from public.admin_list_launch_plans() where business_id='${KILN}' and revoked_at is null`)).pop(), 'replaced_by_subscription');
  });
  test('revoking the grant now cannot touch the paid plan; the row is closed as superseded', () => {
    const before_ = tierOf(KILN);
    assert.match(asUser(ADMIN, revoke(KILN, 'tidy up')), /replaced_by_subscription/);
    assert.equal(tierOf(KILN), before_);
    assert.equal(scalar(`select stripe_subscription_id from public.local_businesses where id='${KILN}'`), 'sub_kiln');
    assert.equal(scalar(`select (superseded_at is not null) from public.launch_plan_grants where business_id='${KILN}' order by created_at desc limit 1`), 't');
    // and a grant on it is refused from here on
    assert.match(asUser(ADMIN, grant(KILN, 'premium', IN(30))), /already has a genuine subscription/);
  });
  test('a later cancellation behaves exactly as for any business: back to Free (the grant does not resurrect)', () => {
    raw(`select public.retire_subscription('sub_kiln', 3000)`);
    assert.equal(tierOf(KILN), 'free|null');
    assert.equal(meets(KILN, 'pro'), 'f');
  });
  test('after the subscription is gone a fresh grant can be made again, deliberately', () => {
    assert.match(asUser(ADMIN, grant(KILN, 'pro', IN(30))), /"applied": true/);
    asUser(ADMIN, revoke(KILN, 'cleanup after test'));
  });
});

describe('L — idempotent, and one open grant per business', () => {
  test('the same grant twice records once', () => {
    // freeze one future instant so the second call is textually identical
    const fixed = scalar(`select (now() + interval '120 days')::timestamptz::text`);
    asUser(ADMIN, grant(FERRY, 'pro', `'${fixed}'::timestamptz`));
    const n = grantRows(FERRY);
    assert.match(asUser(ADMIN, grant(FERRY, 'pro', `'${fixed}'::timestamptz`)), /unchanged/);
    assert.equal(grantRows(FERRY), n);
  });
  test('changing the tier or the date replaces the previous grant; only one stays open', () => {
    assert.match(asUser(ADMIN, grant(FERRY, 'premium', IN(150))), /replaced_previous_grant/);
    assert.equal(scalar(`select count(*) from public.launch_plan_grants where business_id='${FERRY}' and revoked_at is null and superseded_at is null`), '1');
    assert.equal(scalar(`select count(*) from public.launch_plan_grants where business_id='${FERRY}' and superseded_at is not null`), '1');
    assert.equal(scalar(`select count(*) from public.launch_plan_grants where business_id='${FERRY}' and revoked_at is not null`), '1');   // the E-section revoke is kept
    assert.match(tierOf(FERRY), /^premium\|/);
    assert.match(raw(`insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${FERRY}', 'pro', ${IN(30)}, 'a second open grant', 'direct_sql')`), /uq_launch_plan_grants_one_open|duplicate key/i);
  });
});

describe('M — entitlement agrees everywhere; no Stripe or money rows', () => {
  test('owner, public and admin all read the same answer in every state', () => {
    for (const id of [CAFE, SHOP, FERRY, BAKERY, KILN]) {
      const server = meets(id, 'pro');
      const ownerSees = (owner: string | null) => owner ? rowsOf(asUser(owner, `select public.business_meets_tier('${id}', 'pro')`)).pop() : server;
      assert.equal(ownerSees(OWNER_A), server);
      assert.equal(rowsOf(asUser(ADMIN, `select public.business_meets_tier('${id}', 'pro')`)).pop(), server);
      assert.equal(rowsOf(as(null, 'anon', `select public.business_meets_tier('${id}', 'pro')`)).pop(), server);
    }
    // the public gate and the predicate agree for the two seeded offers
    const publicTitles = rowsOf(as(null, 'anon', `select title from public.local_offers order by title`));
    assert.deepEqual(publicTitles, [meets(CAFE, 'pro') === 't' ? 'Soup of the day' : null, meets(SHOP, 'pro') === 't' ? 'Free wrap' : null].filter(Boolean).sort());
  });
  test('no grant ever touches a Stripe column, and the grant path wrote no Stripe-side row', () => {
    assert.equal(scalar(`select count(*) from public.local_businesses where id in ('${CAFE}','${SHOP}','${FERRY}','${BAKERY}') and (stripe_customer_id is not null or stripe_subscription_id is not null or business_stripe_customer_id is not null or stripe_account_id is not null)`), '0');
    assert.equal(scalar(`select count(*) from public.local_subscription_attempts where business_id in ('${CAFE}','${SHOP}','${FERRY}','${BAKERY}')`), '0');
    assert.equal(scalar(`select count(*) from public.stripe_subscription_watermarks where stripe_subscription_id not in ('sub_paying','sub_kiln')`), '0');
  });
  test('the migration writes only launch_plan_grants and the two plan columns; it names no payment, wallet or ledger object', () => {
    const code = src(GRANTS).split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    const targets = new Set([...code.matchAll(/\b(?:insert\s+into|update)\s+(public\.\w+)/gi)].map((m) => m[1]));
    assert.deepEqual([...targets].sort(), ['public.launch_plan_grants', 'public.local_businesses']);
    assert.doesNotMatch(code, /wallet|ledger|payment|invoice|refund|topup|_orders|coupon_id|stripe_customer|stripe_account/i);
    assert.doesNotMatch(code, /stripe_subscription_id\s*(=|:=)/i, 'the grant must never write the subscription id');
  });
});

describe('N — the dead "Grant discount" write is refused', () => {
  test('inserting a discount grant fails with a pointer to the real tool, for every writer', () => {
    const ins = `insert into public.business_discount_grants (business_id, tier, percent_off, applicable_from, expires_at) values ('${CAFE}', 'pro', 100, now(), ${IN(365)})`;
    for (const out of [raw(ins), asService(ins), asUser(ADMIN, ins)]) assert.match(out, /Discount grants are not active.*admin_grant_launch_plan/s, out);
    assert.equal(scalar('select count(*) from public.business_discount_grants'), '0');
  });
});

describe('O — the admin screen\'s business lookup', () => {
  const look = (q: string) => `select business_id, name, is_active, tier, plan_live, has_subscription, grant_tier from public.admin_launch_business_lookup('${q}')`;
  test('an admin finds a business by a piece of its name, case-insensitively, and by its id — including an INACTIVE one', () => {
    raw(`update public.local_businesses set is_active=false where id='${KILN}'`);
    assert.match(asUser(ADMIN, look('kiln pot')), new RegExp(`${KILN}\\|Kiln Pottery\\|f\\|`));
    assert.match(asUser(ADMIN, look(KILN)), new RegExp(`${KILN}\\|Kiln Pottery`));
    assert.match(asUser(ADMIN, look(KILN.toUpperCase())), new RegExp(`${KILN}`));
  });
  test('it reports facts: a real subscription, a live open grant, a plain Free listing', () => {
    assert.match(asUser(ADMIN, look(SUBBED)), /Paying Joiners\|t\|(pro|premium)\|t\|t\|/);   // has_subscription = t
    assert.match(asUser(ADMIN, look(FERRY)), /Ferry Tours\|t\|premium\|t\|f\|premium$/m);   // open grant, no subscription
    assert.match(asUser(ADMIN, look(BAKERY)), /Bakery\|t\|free\|f\|f\|$/m);
  });
  test('LIKE wildcards in the query are literal, and a too-short query is refused', () => {
    assert.deepEqual(rowsOf(asUser(ADMIN, look('%%%'))), []);
    assert.match(asUser(ADMIN, look('ab')), /at least 3 letters/);
  });
  test('only an administrator may look: customer, owner, anon and uid-less callers are refused', () => {
    assert.match(asUser(CUSTOMER, look('Harbour')), /Only an administrator/);
    assert.match(asUser(OWNER_A, look('Harbour')), /Only an administrator/);
    assert.match(as(null, 'anon', look('Harbour')), /permission denied/i);
    assert.match(as(null, 'authenticated', look('Harbour')), /Only an administrator/);
  });
  test('it names no Stripe identifier: the result has only the documented columns', () => {
    const out = raw(`select * from public.admin_launch_business_lookup('${SUBBED}')`);
    assert.doesNotMatch(out, /cus_|sub_|acct_/);
  });
});

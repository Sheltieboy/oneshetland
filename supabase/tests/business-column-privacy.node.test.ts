/**
 * business-column-privacy.node.test.ts — the directory publishes a listing, not
 * a Stripe account.
 *
 * WHY THIS TEST EXISTS
 *
 * local_businesses granted arwdDxtm to anon and authenticated, and its RLS
 * policy filters ROWS only: "is_active = true OR owner_id = auth.uid()". RLS
 * has no column dimension, so every column of every active business was
 * readable by anybody holding the public anon key.
 *
 * Verified against production before the fix. An anonymous caller could list:
 *
 *   owner_id                  the business → person mapping, as real account uuids
 *   stripe_account_id         a live Connect account id
 *   stripe_customer_id
 *   stripe_subscription_id
 *   nfc_token                 the token behind a physical tile
 *
 * Only two businesses were claimed at the time, which is exactly why it
 * mattered: the mechanism was fully open and the exposure grows with every
 * business that signs up.
 *
 * WHAT IS ASSERTED
 *   · anon can read the public directory columns, and only those
 *   · `select *` is denied — which is what stops a new column leaking silently
 *   · a signed-in NON-owner is refused the same columns
 *   · the owner gets their private fields, as booleans, never as identifiers
 *   · service_role still reads everything the webhook and Connect need
 *   · the identifiers a webhook resolves on are UNIQUE, so lookups are
 *     deterministic
 *   · a newly added column is private by default — the whitelist property
 *   · no client in either repository selects a private column
 *
 * SAFETY
 * Everything is rolled back. No identifier value is ever printed.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

/** Columns no client role may ever select. A new one belongs here, not in a grant. */
const PRIVATE_COLUMNS = [
  'stripe_account_id', 'stripe_customer_id', 'stripe_subscription_id',
  'business_stripe_account_id', 'business_stripe_customer_id',
  'nfc_token', 'nfc_status', 'nfc_dispatched_at', 'nfc_activated_at',
  'subscription_cancel_at_period_end', 'use_business_payment',
  'has_business_payment_method', 'use_business_payout',
  'business_stripe_onboarding_complete', 'business_stripe_payouts_enabled',
  'source', 'place_id', 'source_ref',
];

/** The public directory surface. Asserting the exact set makes a silent addition fail. */
const PUBLIC_COLUMNS = [
  'accepts_bookings', 'accepts_wallet', 'address', 'brand_color', 'can_publish_urgent',
  'cashback_percent', 'category', 'claimed_at', 'cover_url', 'created_at',
  'description', 'email', 'id', 'is_active', 'is_claimed', 'is_verified',
  'lat', 'lng', 'logo_url', 'name', 'opening_hours', 'opening_hours_until',
  'payout_enabled', 'phone', 'planner_booking', 'planner_context_source',
  'planner_dwell_minutes', 'planner_good_for', 'planner_note', 'planner_setting',
  'planner_visitor_ready', 'slug', 'subscription_tier', 'subscription_until',
  'tags', 'trade_availability', 'trade_availability_set_at', 'trade_categories',
  'trade_credentials', 'trade_min_job_pence', 'verified_at', 'website',
].sort();

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

function runSql(sql: string): string {
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}

function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}
const query = (sql: string) => lastRow(runSql(sql));

type Case = { area: string; case_name: string; expected: string; actual: string; verdict: string };

function assertAllPass(rows: Case[], area: string) {
  const mine = rows.filter((r) => r.area === area);
  assert.ok(mine.length > 0, `no cases ran for "${area}"`);
  const failed = mine.filter((r) => r.verdict !== 'PASS');
  if (failed.length) {
    assert.fail(`BUSINESS PRIVACY REGRESSION in ${area}:\n` +
      failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
  }
}

// ── 1. The grants themselves ────────────────────────────────────────────────

describe('the public column whitelist', () => {
  test('anon and authenticated hold no table-wide SELECT', () => {
    const r = query(`select
      has_table_privilege('anon','public.local_businesses','SELECT')::text          as anon_table,
      has_table_privilege('authenticated','public.local_businesses','SELECT')::text as auth_table,
      has_table_privilege('service_role','public.local_businesses','SELECT')::text  as svc_table;`);
    assert.equal(r.anon_table, 'false', 'anon still has table-wide SELECT — every column is readable');
    assert.equal(r.auth_table, 'false', 'authenticated still has table-wide SELECT');
    assert.equal(r.svc_table, 'true', 'service_role lost its access — the webhook needs it');
  });

  test('every private column is unreadable by anon and authenticated', () => {
    const checks = PRIVATE_COLUMNS.map((c) =>
      `select '${c}' as col,
        has_column_privilege('anon','public.local_businesses','${c}','SELECT')::text as a,
        has_column_privilege('authenticated','public.local_businesses','${c}','SELECT')::text as u`).join(' union all ');
    const out = JSON.parse(runSql(`${checks};`)) as { rows: { col: string; a: string; u: string }[] };
    const leaked = out.rows.filter((r) => r.a === 'true' || r.u === 'true');
    assert.deepEqual(leaked, [], `these columns are still client-readable: ${leaked.map((l) => l.col).join(', ')}`);
  });

  test('the public surface is exactly the intended list', () => {
    // If this fails because a column was ADDED to the grants, that is the test
    // working: publishing a column should be a deliberate, reviewed act.
    const out = JSON.parse(runSql(`
      select column_name from information_schema.columns c
       where c.table_schema='public' and c.table_name='local_businesses'
         and has_column_privilege('anon','public.local_businesses', c.column_name, 'SELECT')
       order by column_name;`)) as { rows: { column_name: string }[] };
    assert.deepEqual(out.rows.map((r) => r.column_name), PUBLIC_COLUMNS,
      'the set of publicly readable business columns changed');
  });

  test('owner_id is readable by signed-in users but never by anon', () => {
    // Several signed-in flows check "is this mine?". A stranger on the internet
    // enumerating the business → person mapping is a different thing entirely.
    const r = query(`select
      has_column_privilege('anon','public.local_businesses','owner_id','SELECT')::text          as a,
      has_column_privilege('authenticated','public.local_businesses','owner_id','SELECT')::text as u;`);
    assert.equal(r.a, 'false', 'anon can read owner_id');
    assert.equal(r.u, 'true', 'signed-in ownership checks would break');
  });
});

// ── 2. Behaviour, by role ───────────────────────────────────────────────────

describe('reads by role', () => {
  let rows: Case[] = [];

  before(() => {
    const out = runSql(`begin;
create or replace function public.h7_try(q text) returns text
language plpgsql security invoker as $f$
begin execute q; return 'ALLOWED';
exception when others then return 'DENIED'; end $f$;
grant execute on function public.h7_try(text) to anon, authenticated;

create temp table who as select
  (select id from public.local_businesses where owner_id is not null order by id limit 1) biz,
  (select owner_id from public.local_businesses where owner_id is not null order by id limit 1) owner,
  (select p.id from public.profiles p
     where p.id <> (select owner_id from public.local_businesses where owner_id is not null order by id limit 1)
       and coalesce(p.role,'') <> 'admin' order by p.id limit 1) stranger,
  -- The derived-Stripe-state case needs a business that IS connected, chosen on
  -- that fact rather than on whichever UUID happens to sort first. Pinning
  -- 'true' to the lowest id passed only until a new unconnected business was
  -- created, then failed while nothing about the code had changed.
  (select id from public.local_businesses
     where owner_id is not null and stripe_account_id is not null order by id limit 1) conn_biz,
  (select owner_id from public.local_businesses
     where owner_id is not null and stripe_account_id is not null order by id limit 1) conn_owner;
create temp table res (n int generated always as identity, area text, case_name text, expected text, actual text);

create or replace function pg_temp.as_anon(q text) returns text language plpgsql as $f$
declare r text; begin set local role anon; r := public.h7_try(q); reset role; return r; end $f$;
create or replace function pg_temp.as_user(p_user uuid, q text) returns text language plpgsql as $f$
declare r text; begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',p_user::text,'role','authenticated')::text, true);
  r := public.h7_try(q); reset role; return r; end $f$;
create or replace function pg_temp.as_service(q text) returns text language plpgsql as $f$
declare r text; begin set local role service_role; r := public.h7_try(q); reset role; return r; end $f$;

insert into res(area,case_name,expected,actual)
select 'anon', c.n, c.e, pg_temp.as_anon(c.q) from (values
  ('safe directory columns','ALLOWED','select id, name, category, slug, address, logo_url, is_verified, accepts_wallet, subscription_tier, payout_enabled from public.local_businesses limit 1'),
  ('published contact details','ALLOWED','select phone, email, website from public.local_businesses limit 1'),
  ('select *','DENIED','select * from public.local_businesses limit 1'),
  ('owner_id','DENIED','select owner_id from public.local_businesses limit 1'),
  ('stripe_account_id','DENIED','select stripe_account_id from public.local_businesses limit 1'),
  ('stripe_customer_id','DENIED','select stripe_customer_id from public.local_businesses limit 1'),
  ('stripe_subscription_id','DENIED','select stripe_subscription_id from public.local_businesses limit 1'),
  ('business_stripe_account_id','DENIED','select business_stripe_account_id from public.local_businesses limit 1'),
  ('nfc_token','DENIED','select nfc_token from public.local_businesses limit 1'),
  ('nfc_status','DENIED','select nfc_status from public.local_businesses limit 1'),
  ('internal provenance','DENIED','select place_id from public.local_businesses limit 1')
) c(n,e,q);

insert into res(area,case_name,expected,actual)
select 'non-owner', c.n, c.e, pg_temp.as_user((select stranger from who), c.q) from (values
  ('safe columns still readable','ALLOWED','select id, name, slug from public.local_businesses limit 1'),
  ('owner_id for ownership checks','ALLOWED','select owner_id from public.local_businesses limit 1'),
  ('stripe_account_id','DENIED','select stripe_account_id from public.local_businesses limit 1'),
  ('stripe_subscription_id','DENIED','select stripe_subscription_id from public.local_businesses limit 1'),
  ('business_stripe_account_id','DENIED','select business_stripe_account_id from public.local_businesses limit 1'),
  ('nfc_token','DENIED','select nfc_token from public.local_businesses limit 1'),
  ('select *','DENIED','select * from public.local_businesses limit 1')
) c(n,e,q);

create or replace function pg_temp.priv_as(p_user uuid, p_biz uuid) returns text language plpgsql as $f$
declare n int; begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',p_user::text,'role','authenticated')::text, true);
  select count(*) into n from public.business_private_fields(p_biz);
  reset role; return 'ALLOWED:'||n;
exception when others then reset role; return 'DENIED'; end $f$;

insert into res(area,case_name,expected,actual)
select 'non-owner','private fields of a business they do not own','DENIED',
  pg_temp.priv_as((select stranger from who),(select biz from who));

insert into res(area,case_name,expected,actual)
select 'owner','can read their own private fields','ALLOWED:1',
  pg_temp.priv_as((select owner from who),(select biz from who));

create or replace function pg_temp.owner_derived(p_user uuid, p_biz uuid) returns text language plpgsql as $f$
declare v boolean; begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',p_user::text,'role','authenticated')::text, true);
  select stripe_connected into v from public.business_private_fields(p_biz);
  reset role; return coalesce(v::text,'null');
exception when others then reset role; return 'ERROR'; end $f$;

insert into res(area,case_name,expected,actual)
select 'owner','gets derived Stripe state','true',
  pg_temp.owner_derived((select conn_owner from who),(select conn_biz from who));
insert into res(area,case_name,expected,actual)
select 'owner','the RPC returns no raw Stripe identifier','0',
  (select count(*)::text from information_schema.columns
    where table_schema='public' and table_name='business_private_fields' and column_name like '%stripe%id%');

insert into res(area,case_name,expected,actual)
select 'service_role', c.n, 'ALLOWED', pg_temp.as_service(c.q) from (values
  ('full row','select * from public.local_businesses limit 1'),
  ('stripe_account_id','select stripe_account_id from public.local_businesses limit 1'),
  ('business_stripe_account_id','select business_stripe_account_id from public.local_businesses limit 1'),
  ('nfc_token lookup','select id from public.local_businesses where nfc_token is not null limit 1'),
  ('subscription lookup','select id from public.local_businesses where stripe_subscription_id is not null limit 1')
) c(n,q);

alter table public.local_businesses add column h7_probe_column text;
insert into res(area,case_name,expected,actual)
select 'whitelist','a newly added column is private by default','DENIED',
  pg_temp.as_anon('select h7_probe_column from public.local_businesses limit 1');

select n, area, case_name, expected, actual,
  case when expected is not distinct from actual then 'PASS' else 'FAIL' end verdict from res order by n;
rollback;`);
    const parsed = JSON.parse(out) as { rows?: Case[]; _tag?: string; error?: unknown };
    if (parsed._tag === 'Error' || parsed.error) {
      throw new Error(`role matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    }
    rows = (parsed.rows ?? []).filter((r) => r.verdict);
    assert.ok(rows.length >= 25, `expected the full role matrix, got ${rows.length} cases`);
  });

  test('anonymous callers see the directory and nothing else', () => assertAllPass(rows, 'anon'));
  test('a signed-in non-owner is refused the same columns', () => assertAllPass(rows, 'non-owner'));
  test('the owner keeps what their dashboard needs', () => assertAllPass(rows, 'owner'));
  test('service_role still reads everything the backend needs', () => assertAllPass(rows, 'service_role'));
  test('a new column is private until deliberately published', () => assertAllPass(rows, 'whitelist'));
});

// ── 3. Identifiers a webhook resolves on ────────────────────────────────────

describe('identifier determinism', () => {
  test('every identifier used as a lookup key is unique', () => {
    const out = JSON.parse(runSql(`
      select indexname from pg_indexes
       where schemaname='public' and tablename='local_businesses' and indexdef like '%UNIQUE%'
       order by indexname;`)) as { rows: { indexname: string }[] };
    const names = out.rows.map((r) => r.indexname);
    for (const expected of [
      'local_businesses_stripe_account_uniq',
      'local_businesses_biz_stripe_account_uniq',
      'local_businesses_stripe_subscription_uniq',
      'local_businesses_stripe_customer_uniq',
      'local_businesses_nfc_token_key',
    ]) {
      assert.ok(names.includes(expected), `${expected} is missing — that lookup can match two businesses`);
    }
  });

  test('and no duplicates exist in the live data', () => {
    const r = query(`select
      (select count(*) from (select stripe_account_id from public.local_businesses where stripe_account_id is not null group by 1 having count(*)>1) a)::int          as dup_acct,
      (select count(*) from (select business_stripe_account_id from public.local_businesses where business_stripe_account_id is not null group by 1 having count(*)>1) b)::int as dup_bacct,
      (select count(*) from (select stripe_subscription_id from public.local_businesses where stripe_subscription_id is not null group by 1 having count(*)>1) c)::int as dup_sub,
      (select count(*) from (select stripe_customer_id from public.local_businesses where stripe_customer_id is not null group by 1 having count(*)>1) d)::int        as dup_cust,
      (select count(*) from (select nfc_token from public.local_businesses where nfc_token is not null group by 1 having count(*)>1) e)::int                          as dup_nfc;`);
    for (const [k, v] of Object.entries(r)) assert.equal(v, 0, `${k}: duplicate identifiers found`);
  });
});

// ── 4. No client asks for a private column ──────────────────────────────────

describe('no client selects a private column', () => {
  const scan = (root: string, dirs: string[]) => {
    const found: string[] = [];
    let files: string[] = [];
    try {
      files = execFileSync('grep', ['-rl', '--include=*.ts', '--include=*.tsx', 'local_businesses', ...dirs],
        { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch (e) {
      // grep exits 1 when nothing matches, which is not a failure here.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    for (const f of files) {
      if (f.includes('node_modules') || f.includes('.next/')) continue;
      const src = readFileSync(join(root, f), 'utf8');
      for (const m of src.matchAll(/from\(["']local_businesses["']\)([\s\S]{0,400})/g)) {
        const sel = /\.select\(\s*(["'`])([\s\S]*?)\1/.exec(m[1]);
        if (!sel) continue;
        const cols = sel[2].replace(/\n/g, ' ').split(',').map((c) => c.trim());
        const bad = cols.filter((c) => PRIVATE_COLUMNS.includes(c));
        if (cols.includes('*')) found.push(`${f}: select('*')`);
        if (bad.length) found.push(`${f}: ${bad.join(', ')}`);
      }
    }
    return found;
  };

  test('the mobile app names only safe columns', () => {
    const bad = scan(REPO_ROOT, ['app', 'lib', 'components']);
    assert.deepEqual(bad, [], `mobile callers reading private business columns:\n  ${bad.join('\n  ')}`);
  });

  test('the website names only safe columns', () => {
    if (!existsSync(WEB_ROOT)) return;   // sibling checkout not present
    const bad = scan(WEB_ROOT, ['app', 'lib', 'components']);
    assert.deepEqual(bad, [], `web callers reading private business columns:\n  ${bad.join('\n  ')}`);
  });
});

// ── 5. The live boundary ────────────────────────────────────────────────────

describe('the live directory', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const get = (select: string) =>
    fetch(`${cfg!.url}/rest/v1/local_businesses?select=${encodeURIComponent(select)}&limit=1`, {
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}` },
    });

  test('anon cannot select *', async () => {
    assert.equal((await get('*')).status, 401, 'select=* is still permitted for anon');
  });

  for (const c of ['stripe_account_id', 'stripe_customer_id', 'stripe_subscription_id',
                   'business_stripe_account_id', 'nfc_token', 'owner_id']) {
    test(`anon cannot select ${c}`, async () => {
      assert.equal((await get(c)).status, 401, `${c} is still readable with the public anon key`);
    });
  }

  test('the public directory still works', async () => {
    const res = await get('id,name,category,slug,address,logo_url,is_verified,accepts_wallet,subscription_tier,payout_enabled');
    assert.equal(res.status, 200, 'the directory broke — public browsing must not require signing in');
    const rows = await res.json() as unknown[];
    assert.ok(Array.isArray(rows) && rows.length > 0, 'the directory returned nothing');
  });

  test('published contact details are still public', async () => {
    assert.equal((await get('phone,email,website')).status, 200,
      'contact details a business chooses to publish should stay published');
  });
});

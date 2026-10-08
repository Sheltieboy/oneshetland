/**
 * discovery-fixtures-locality.node.test.ts — build-144 server-side compatibility, against the real SQL.
 *
 * Migration 20261104000000  local_businesses_public gains `locality`
 * Migration 20261104010000  known test fixtures leave public discovery (and only discovery)
 *
 * THE BUILD-144 CONTRACTS ASSERTED (the shipped app, commit 8563e1a, cannot be changed)
 *   • Local grid:        from local_businesses_public  .eq is_active .ilike('locality', '%<area>%')  order verified, newest  limit 20
 *   • Home Around Shetland / Featured:  the same view, pro/premium first, then backfill
 *   • Fresh in the shops: products where active, unsold, business active -- embedded business
 *   • Notices:           notices public/unhidden/unexpired, embedded hub, ordered pinned then newest
 * Each is re-expressed as the SQL PostgREST would run for the anonymous role, with the policies production has.
 *
 *   A  locality: area chips return real businesses; an area with none is empty (not an error); nothing rewritten
 *   B  fixtures: invisible to the public in every list and by direct id; visible to admin and owner; rows untouched;
 *      selection is by explicit id (a name that merely looks like a fixture stays visible); reversible
 *   C  the genuine OneShetland notice is what build 144 reads, labelled OneShetland
 *   D  scope: read policies only
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
const MEETS = join(MIG, '20260916120000_business_meets_tier.sql');
const LOCALITY = join(MIG, '20261104000000_public_business_locality.sql');
const FIXTURES = join(MIG, '20261104010000_discovery_fixtures.sql');
const FIXTURE_IDS = join(MIG, '20261104020000_admin_discovery_fixture_ids.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const as = (uid: string | null, role: 'authenticated' | 'anon' | 'service_role', sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${role}; ${sql}; commit;`);
const anon = (sql: string) => as(null, 'anon', sql);
const user = (uid: string, sql: string) => as(uid, 'authenticated', sql);
const svc = (sql: string) => as(null, 'service_role', sql);
function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start + opener.length); assert.notEqual(end, -1);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
const policiesOf = (table: string) =>
  [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);

// The fixtures, by their real production ids.
const ZZ = '52f68630-c6aa-4bbf-9cda-4a63b08e94d4';
const ANDERSON = '8e3ff71c-1442-405e-84c3-0de4eff64c99';
const ZZ_HUB = 'bad36349-ed55-4907-ad71-d2a2d5f4108c';
const ADMIN = 'eb599396-6e9c-4c49-ae67-cb60fbc02bac';       // the acceptance tester: an administrator
const ZZ_OWNER = 'efb83e4b-6331-4c00-a019-ae0734b36db5';
const CUSTOMER = 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0';
const REAL_OWNER = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const CAFE = 'd1d1d1d1-0000-4000-8000-000000000001';       // Lerwick, premium
const FISH = 'd2d2d2d2-0000-4000-8000-000000000002';       // Scalloway, free
const SHOP = 'd3d3d3d3-0000-4000-8000-000000000003';       // Brae, pro
const NOADDR = 'd4d4d4d4-0000-4000-8000-000000000004';     // blank address
const LOOKALIKE = 'd5d5d5d5-0000-4000-8000-000000000005';  // named "ZZ TEST …" but NOT a listed fixture
const OS_HUB = 'e1e1e1e1-0000-4000-8000-000000000001';

const FUTURE = "now() + interval '90 days'";
const COLS144 = 'id, name, category, address, is_verified, is_active, subscription_tier, subscription_until, wallet_live';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  // The view as it was BEFORE this change = the migration's own definition minus the appended column.
  const viewSql = slice(LOCALITY, 'create or replace view public.local_businesses_public', ';\n');
  const oldView = viewSql.replace(/,\s*business_locality\(b\.address\) AS locality/, '');
  assert.notEqual(oldView, viewSql, 'the migration no longer appends locality last');
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
    // columns the production view reads that arrived after the baseline
    `alter table public.local_businesses
       add column if not exists opening_hours_until timestamptz, add column if not exists planner_visitor_ready boolean,
       add column if not exists planner_dwell_minutes int, add column if not exists planner_setting text,
       add column if not exists planner_good_for text[], add column if not exists planner_booking text,
       add column if not exists planner_note text, add column if not exists planner_context_source text,
       add column if not exists trade_categories text[], add column if not exists trade_availability text,
       add column if not exists trade_availability_set_at timestamptz, add column if not exists trade_min_job_pence int,
       add column if not exists trade_credentials text[];`,
    'alter table public.local_businesses enable row level security;',
    ...policiesOf('local_businesses'),                 // PRE-change policies, exactly as production had them
    slice(BASELINE, 'CREATE FUNCTION public.is_admin()', '$$;'),
    `create function public.is_business_owner(p_business uuid, p_user uuid) returns boolean language sql stable security definer
       set search_path to 'public','pg_temp' as $$ select exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = p_user) $$;`,
    `create function public.is_business_active(p_business uuid) returns boolean language sql stable security definer
       set search_path to 'public','pg_temp' as $$ select exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active) $$;`,
    slice(MEETS, 'create or replace function public.business_meets_tier(', '$$;'),
    // hubs and what hangs off them
    `create table public.hubs (id uuid primary key default gen_random_uuid(), owner_id uuid, name text not null, slug text, logo_url text, brand_color text, is_active boolean default true);
     alter table public.hubs enable row level security;
     create policy "hubs read" on public.hubs for select using (((is_active = true) OR (owner_id = auth.uid())));
     create function public.is_hub_admin(p_hub uuid, p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.hubs h where h.id = p_hub and h.owner_id = p_user) $$;
     create table public.hub_campaigns (id uuid primary key default gen_random_uuid(), hub_id uuid not null, title text, status text default 'active');
     alter table public.hub_campaigns enable row level security;
     create policy "hub_campaigns read" on public.hub_campaigns for select using (true);
     create table public.hub_membership_types (id uuid primary key default gen_random_uuid(), hub_id uuid not null, name text, is_active boolean default true);
     alter table public.hub_membership_types enable row level security;
     create policy "hub_membership_types read" on public.hub_membership_types for select using ((is_active OR is_hub_admin(hub_id, auth.uid())));`,
    // the plan-gated public tables, with production's policy text
    `create table public.products (id uuid primary key default gen_random_uuid(), business_id uuid not null, title text, is_active boolean default true, sold_at timestamptz, created_at timestamptz default now());
     alter table public.products enable row level security;
     create policy "public reads live products" on public.products for select using ((is_active AND is_business_active(business_id) AND business_meets_tier(business_id, 'premium'::text)));
     create table public.book_unit_items (id uuid primary key default gen_random_uuid(), business_id uuid not null, name text, is_active boolean default true);
     alter table public.book_unit_items enable row level security;
     create policy "Anyone can read active unit items" on public.book_unit_items for select using ((((is_active = true) AND business_meets_tier(business_id, 'premium'::text)) OR is_business_owner(business_id, auth.uid())));
     create table public.book_services (id uuid primary key default gen_random_uuid(), business_id uuid not null, name text, is_active boolean default true);
     alter table public.book_services enable row level security;
     create policy "Anyone can read active services" on public.book_services for select using (((is_active = true) OR is_business_owner(business_id, auth.uid())));
     create table public.local_offers (id uuid primary key default gen_random_uuid(), business_id uuid not null, title text, is_active boolean default true);
     alter table public.local_offers enable row level security;
     create policy "Anyone can read active offers" on public.local_offers for select using ((((is_active = true) AND business_meets_tier(business_id, 'pro'::text)) OR is_business_owner(business_id, auth.uid())));
     create table public.notices (id uuid primary key default gen_random_uuid(), publisher_hub_id uuid, publisher_business_id uuid, publisher_user_id uuid,
       severity text not null default 'community', title text not null, body text, visibility text not null default 'public',
       is_hidden boolean not null default false, is_pinned boolean not null default false, expires_at timestamptz, published_at timestamptz not null default now());
     alter table public.notices enable row level security;
     create policy "notices read" on public.notices for select using (((NOT is_hidden) AND ((expires_at IS NULL) OR (expires_at > now())) AND (visibility = 'public'::text)));`,
    'grant select on all tables in schema public to anon, authenticated, service_role;',
    'grant insert, update, delete on all tables in schema public to service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role;',
    oldView,
    'grant select on public.local_businesses_public to anon, authenticated, service_role;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 2500)}`);

  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${CUSTOMER}', 'customer'), ('${REAL_OWNER}', 'customer'), ('${ZZ_OWNER}', 'customer');
    insert into public.local_businesses (id, name, category, address, owner_id, is_verified, subscription_tier, subscription_until, created_at) values
      ('${CAFE}',  'Harbour Café',     'food_drink', 'Lerwick, Shetland',                  '${REAL_OWNER}', true,  'premium', ${FUTURE}, now() - interval '3 days'),
      ('${FISH}',  'Scalloway Fish',   'retail',     'Main Street, Scalloway, Shetland',   null,            false, 'free',    null,      now() - interval '2 days'),
      ('${SHOP}',  'Brae Gifts',       'retail',     'Brae, Shetland',                     null,            false, 'pro',     ${FUTURE}, now() - interval '1 day'),
      ('${NOADDR}','Mystery Mill',     'other',      '   ',                                null,            false, 'free',    null,      now()),
      ('${ZZ}',       'ZZ TEST — OneShetland Acceptance Fixture', 'retail', 'Lerwick, Shetland', '${ZZ_OWNER}', true, 'premium', ${FUTURE}, now()),
      ('${ANDERSON}', 'Anderson & Co', 'services', 'Lerwick, Shetland', null, false, 'premium', ${FUTURE}, now()),
      ('${LOOKALIKE}','ZZ TEST — merely named like a fixture', 'retail', 'Lerwick, Shetland', null, false, 'premium', ${FUTURE}, now());
    insert into public.products (business_id, title) values ('${CAFE}', 'Real Fudge'), ('${ZZ}', 'Hamnavoe Lighthouse Print'), ('${ANDERSON}', 'DEMO — Launch Test Product'), ('${LOOKALIKE}', 'Lookalike product');
    insert into public.book_unit_items (business_id, name) values ('${CAFE}', 'Real Pass'), ('${ZZ}', 'ZZ TEST — Wallet Pass'), ('${ZZ}', 'ZZ - Demo Pass'), ('${ANDERSON}', 'DEMO pass');
    insert into public.book_services (business_id, name) values ('${SHOP}', 'Real Fitting'), ('${ZZ}', 'ZZ - Test booking');
    insert into public.local_offers (business_id, title) values ('${SHOP}', 'Real Offer'), ('${ZZ}', 'ZZ offer');
    insert into public.hubs (id, owner_id, name, slug) values ('${ZZ_HUB}', '${ZZ_OWNER}', 'ZZ TEST — Wallet Acceptance Hub', 'zz-hub');
    insert into public.hub_campaigns (hub_id, title) values ('${ZZ_HUB}', 'ZZ campaign');
    insert into public.hub_membership_types (hub_id, name) values ('${ZZ_HUB}', 'ZZ tier');`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 800)}`);
});

// Fingerprint the fixture rows so "nothing about the fixtures changed" is a measurement, not a hope.
const fingerprint = () => scalar(`select md5(
   (select coalesce(string_agg(b::text, '|' order by id), '') from public.local_businesses b where id in ('${ZZ}','${ANDERSON}')) ||
   (select coalesce(string_agg(p::text, '|' order by id), '') from public.products p where business_id in ('${ZZ}','${ANDERSON}')) ||
   (select coalesce(string_agg(u::text, '|' order by id), '') from public.book_unit_items u where business_id in ('${ZZ}','${ANDERSON}')) ||
   (select coalesce(string_agg(s::text, '|' order by id), '') from public.book_services s where business_id = '${ZZ}') ||
   (select coalesce(string_agg(h::text, '|' order by id), '') from public.hubs h where id = '${ZZ_HUB}') ||
   (select coalesce(string_agg(c::text, '|' order by id), '') from public.hub_campaigns c where hub_id = '${ZZ_HUB}'))`);
let baseline = '';
let allBusinesses = '';
const baseFingerprint = () => (baseline ||= fingerprint());

describe('A — locality, the build-144 area-chip contract', () => {
  test('BEFORE: build 144\'s exact query fails (the defect, reproduced)', () => {
    baseFingerprint();
    allBusinesses = scalar(`select md5(coalesce(string_agg(b::text, '|' order by id), '')) from public.local_businesses b`);
    // the view as it stood: no locality column
    const old = raw(`begin; set local role anon; select ${COLS144} from public.local_businesses_public where is_active = true and locality ilike '%lerwick%' limit 20; commit;`);
    assert.match(old, /column "?locality"? does not exist|locality/i);
  });
  test('apply the migration', () => {
    const out = raw(src(LOCALITY));
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.match(scalar(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='local_businesses_public' and table_schema='public'`), /wallet_live,locality$/);
  });
  const grid = (area: string) => rowsOf(anon(
    `select name from public.local_businesses_public where is_active = true ${area ? `and locality ilike '%${area}%'` : ''} order by is_verified desc, created_at desc limit 20`));
  test('Lerwick returns real Lerwick businesses; Scalloway returns Scalloway; Brae returns Brae', () => {
    assert.ok(grid('lerwick').includes('Harbour Café'));
    assert.deepEqual(grid('scalloway'), ['Scalloway Fish']);
    assert.deepEqual(grid('brae'), ['Brae Gifts']);
  });
  test('an area no address mentions is an honest empty list, with no error', () => {
    const out = anon(`select name from public.local_businesses_public where is_active = true and locality ilike '%south mainland%' limit 20`);
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.deepEqual(rowsOf(out), []);
  });
  test('"All Shetland" (no area) is unchanged: every public business, verified first', () => {
    const all = grid('');
    assert.ok(all.includes('Harbour Café') && all.includes('Scalloway Fish') && all.includes('Brae Gifts'));
    assert.ok(all.indexOf('Harbour Café') < all.indexOf('Scalloway Fish'), 'verified businesses still come first');
  });
  test('a blank address gives NULL, never an empty string or a guess', () => {
    assert.equal(scalar(`select coalesce(locality, 'NULL') from public.local_businesses_public where id='${NOADDR}'`), 'NULL');
    assert.equal(scalar(`select locality from public.local_businesses_public where id='${CAFE}'`), 'Lerwick, Shetland');
  });
  test('no business row was rewritten to make this work', () => {
    assert.ok(allBusinesses, 'the before-fingerprint was taken');
    assert.equal(scalar(`select md5(coalesce(string_agg(b::text, '|' order by id), '')) from public.local_businesses b`), allBusinesses);
    assert.equal(scalar(`select length(address) from public.local_businesses where id='${NOADDR}'`), '3');   // still the original blank
  });
  test('the view stays security_invoker, and its grants are intact', () => {
    assert.match(scalar(`select reloptions::text from pg_class where relname='local_businesses_public'`), /security_invoker=true/);
    assert.equal(scalar(`select has_table_privilege('anon','public.local_businesses_public','select')`), 't');
  });
});

describe('B — fixtures leave discovery, nothing else changes', () => {
  test('apply the migration', () => {
    const out = raw(src(FIXTURES));
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(scalar(`select count(*) from public.discovery_fixtures`), '3');
  });

  const names = (out: string) => rowsOf(out).sort();
  const PUBLIC_LISTS: [string, string][] = [
    ['the business view (Local grid, Featured, Directory, Home)', `select name from public.local_businesses_public where is_active`],
    ['the business table (web Home Featured, sitemap)', `select name from public.local_businesses where is_active`],
    ['products (Fresh in the shops, Shop)', `select title from public.products`],
    ['passes (Marketplace feed, Local passes)', `select name from public.book_unit_items`],
    ['services (Book now)', `select name from public.book_services`],
    ['offers', `select title from public.local_offers`],
    ['hubs list', `select name from public.hubs`],
    ['hub campaigns (Chip in)', `select title from public.hub_campaigns`],
    ['hub membership tiers', `select name from public.hub_membership_types`],
  ];
  const FIXTURE_WORDS = /ZZ TEST — OneShetland|Anderson|DEMO|Hamnavoe Lighthouse|ZZ - |ZZ TEST — Wallet|ZZ offer|ZZ campaign|ZZ tier/;
  for (const [what, sql] of PUBLIC_LISTS) {
    test(`the public never receives a fixture from ${what}`, () => {
      for (const out of [anon(sql), user(CUSTOMER, sql), user(REAL_OWNER, sql)]) {
        assert.doesNotMatch(out, /ERROR/i, out);
        assert.doesNotMatch(names(out).join('\n'), FIXTURE_WORDS, `${what}: ${names(out)}`);
      }
    });
  }
  test('genuine content is untouched: the real business, product, pass, service and offer still list', () => {
    assert.ok(names(anon(`select name from public.local_businesses_public where is_active`)).includes('Harbour Café'));
    assert.deepEqual(names(anon(`select title from public.products where title !~ 'Lookalike'`)), ['Real Fudge']);
    assert.deepEqual(names(anon(`select name from public.book_unit_items`)), ['Real Pass']);
    assert.deepEqual(names(anon(`select name from public.book_services`)), ['Real Fitting']);
    assert.deepEqual(names(anon(`select title from public.local_offers`)), ['Real Offer']);
  });
  test('a direct lookup by id gives the public nothing (404), not a half-shown fixture', () => {
    assert.deepEqual(rowsOf(anon(`select name from public.local_businesses_public where id='${ZZ}'`)), []);
    assert.deepEqual(rowsOf(user(CUSTOMER, `select name from public.hubs where id='${ZZ_HUB}'`)), []);
  });
  test('the explicit list is what decides: a business merely NAMED like a fixture stays public', () => {
    assert.ok(names(anon(`select name from public.local_businesses_public where is_active`)).some((n) => /merely named like a fixture/.test(n)));
    assert.ok(names(anon(`select title from public.products`)).includes('Lookalike product'));
  });
  test('the acceptance tester (an administrator) still sees every fixture, in every list', () => {
    const all = (sql: string) => names(user(ADMIN, sql)).join('\n');
    assert.match(all(`select name from public.local_businesses_public where is_active`), /ZZ TEST — OneShetland Acceptance Fixture/);
    assert.match(all(`select name from public.local_businesses_public where is_active`), /Anderson & Co/);
    assert.match(all(`select title from public.products`), /Hamnavoe Lighthouse Print/);
    assert.match(all(`select name from public.book_unit_items`), /ZZ TEST — Wallet Pass/);
    assert.match(all(`select name from public.book_services`), /ZZ - Test booking/);
    assert.match(all(`select name from public.hubs`), /ZZ TEST — Wallet Acceptance Hub/);
    assert.match(all(`select title from public.hub_campaigns`), /ZZ campaign/);
    assert.match(all(`select name from public.hub_membership_types`), /ZZ tier/);
    assert.deepEqual(rowsOf(user(ADMIN, `select name from public.local_businesses_public where id='${ZZ}'`)).length, 1);   // direct id
  });
  test('the fixtures\' own owner still sees them; another business\'s owner does not', () => {
    assert.equal(rowsOf(user(ZZ_OWNER, `select name from public.local_businesses_public where id='${ZZ}'`)).length, 1);
    assert.equal(rowsOf(user(ZZ_OWNER, `select name from public.hubs where id='${ZZ_HUB}'`)).length, 1);
    assert.equal(rowsOf(user(REAL_OWNER, `select name from public.local_businesses_public where id='${ZZ}'`)).length, 0);
  });
  test('server-side flows (the service role used by payment functions) see everything, unchanged', () => {
    assert.equal(rowsOf(svc(`select name from public.book_unit_items`)).length, 4);
    assert.equal(rowsOf(svc(`select title from public.products`)).length, 4);
    assert.equal(rowsOf(svc(`select name from public.hubs`)).length, 1);
  });
  test('NOTHING about any fixture row changed (businesses, products, passes, services, hub, campaign)', () => {
    assert.equal(fingerprint(), baseFingerprint());
  });
  test('it is reversible: remove the list entry and the fixture is public again; put it back and it is hidden', () => {
    raw(`delete from public.discovery_fixtures where entity_id='${ANDERSON}'`);
    assert.ok(names(anon(`select name from public.local_businesses_public where is_active`)).includes('Anderson & Co'));
    raw(`insert into public.discovery_fixtures (entity, entity_id, reason) values ('business', '${ANDERSON}', 'restored')`);
    assert.ok(!names(anon(`select name from public.local_businesses_public where is_active`)).includes('Anderson & Co'));
    assert.equal(fingerprint(), baseFingerprint());
  });
  test('the list itself is private: nobody but the service role can read or edit it', () => {
    assert.match(anon('select * from public.discovery_fixtures'), /permission denied/i);
    assert.match(user(ADMIN, 'select * from public.discovery_fixtures'), /permission denied/i);
    assert.match(user(ADMIN, `insert into public.discovery_fixtures values ('business', '${CAFE}', 'x')`), /permission denied/i);
  });
});

describe('B2 — the build-144 Home contracts, as the anonymous role runs them', () => {
  const run = (sql: string) => rowsOf(anon(sql));
  test('fetchFeaturedBusinesses: premium/pro first, then backfill — no fixture in either step', () => {
    const subs = run(`select name from public.local_businesses_public where is_active = true and subscription_tier in ('pro','premium') and (subscription_until is null or subscription_until > now()) order by subscription_tier desc, created_at desc limit 12`);
    const rest = run(`select name from public.local_businesses_public where is_active = true order by is_verified desc, created_at desc limit 36`);
    for (const n of [...subs, ...rest]) assert.doesNotMatch(n, /ZZ TEST — OneShetland|Anderson/);
    assert.ok(subs.includes('Harbour Café'));
  });
  test('fetchFreshProducts: active, unsold, active business — only genuine products', () => {
    const out = run(`select p.title from public.products p join public.local_businesses_public b on b.id = p.business_id where p.is_active and p.sold_at is null and b.is_active order by p.created_at desc limit 10`);
    assert.ok(out.includes('Real Fudge'));
    for (const n of out) assert.doesNotMatch(n, /Hamnavoe|DEMO/);
  });
});

describe('B3 — the people who can see fixtures can label them; nobody else can learn which they are', () => {
  test('apply the migration', () => {
    const out = raw(src(FIXTURE_IDS));
    assert.doesNotMatch(out, /ERROR/i, out);
  });
  const ids = (out: string) => rowsOf(out).sort();
  test('an administrator receives exactly the listed fixtures (the explicit list, not a name pattern)', () => {
    const got = ids(user(ADMIN, `select entity || ':' || entity_id from public.admin_discovery_fixture_ids()`));
    assert.deepEqual(got, [`business:${ANDERSON}`, `business:${ZZ}`, `hub:${ZZ_HUB}`].sort());
  });
  test('a lookalike named "ZZ TEST" that is not listed is NOT returned', () => {
    const got = user(ADMIN, `select entity_id from public.admin_discovery_fixture_ids()`);
    assert.doesNotMatch(got, new RegExp(LOOKALIKE));
  });
  test('an ordinary signed-in user gets nothing, and neither does the owner of a genuine business', () => {
    assert.deepEqual(ids(user(CUSTOMER, `select entity_id from public.admin_discovery_fixture_ids()`)), []);
    assert.deepEqual(ids(user(REAL_OWNER, `select entity_id from public.admin_discovery_fixture_ids()`)), []);
  });
  test('a fixture\'s own owner (who can see it through the owner policies) gets exactly their own — the business, not the others', () => {
    assert.deepEqual(ids(user(ZZ_OWNER, `select entity || ':' || entity_id from public.admin_discovery_fixture_ids()`)), [`business:${ZZ}`, `hub:${ZZ_HUB}`].sort());
  });
  test('a signed-out caller is refused outright', () => {
    assert.match(anon(`select * from public.admin_discovery_fixture_ids()`), /permission denied/i);
  });
  test('it writes nothing: the fixture rows are byte-identical afterwards', () => {
    assert.equal(fingerprint(), baseFingerprint());
  });
});

describe('C — the genuine OneShetland notice replaces the invented fallback', () => {
  test('before: no public notice at all (this is what triggers build 144\'s sample fallback)', () => {
    assert.equal(scalar(`select count(*) from public.notices`), '0');
  });
  test('publish it exactly as production will: a OneShetland hub as publisher, info severity, public, no expiry', () => {
    const out = raw(`
      insert into public.hubs (id, owner_id, name, slug, is_active) values ('${OS_HUB}', '${ADMIN}', 'OneShetland', 'oneshetland', true);
      insert into public.notices (publisher_hub_id, severity, title, body, visibility, is_pinned)
        values ('${OS_HUB}', 'info', 'OneShetland is getting ready to launch',
                'We’re putting the final touches to OneShetland and adding local businesses, events and useful information. Thanks for taking an early look.', 'public', false)`);
    assert.doesNotMatch(out, /ERROR/i, out);
  });
  test('build 144\'s notices query (public, unhidden, unexpired, pinned then newest, hub embedded) returns it, labelled OneShetland', () => {
    const rows = rowsOf(anon(`select n.title || '|' || n.severity || '|' || coalesce(h.name, '(no publisher)') from public.notices n left join public.hubs h on h.id = n.publisher_hub_id
       where n.is_hidden = false and n.visibility = 'public' and (n.expires_at is null or n.expires_at > now()) order by n.is_pinned desc, n.published_at desc limit 40`));
    assert.deepEqual(rows, ['OneShetland is getting ready to launch|info|OneShetland']);   // length > 0  ==>  the client never reaches SAMPLE_NOTICES
  });
  test('it names no other organisation and promises nothing: the copy is exactly the approved wording', () => {
    const body = scalar(`select body from public.notices`);
    assert.equal(body, 'We’re putting the final touches to OneShetland and adding local businesses, events and useful information. Thanks for taking an early look.');
    assert.doesNotMatch(`${scalar('select title from public.notices')} ${body}`, /SIC|ferry|ferries|council|police|coastguard|NHS|library|urgent/i);
  });
});

describe('D — scope: read visibility only', () => {
  test('the fixtures migration alters only SELECT policies, adds one private table, touches no write policy, trigger, payment or ledger object', () => {
    const code = src(FIXTURES).split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').replace(/'(?:[^']|'')*'/g, "''");   // comments and string literals aside
    const altered = [...code.matchAll(/alter policy "([^"]+)" on public\.(\w+)/gi)].map((m) => `${m[2]}:${m[1]}`).sort();
    assert.deepEqual(altered, [
      'book_services:Anyone can read active services', 'book_unit_items:Anyone can read active unit items',
      'hub_campaigns:hub_campaigns read', 'hub_membership_types:hub_membership_types read', 'hubs:hubs read',
      'local_businesses:Anyone can read active businesses', 'local_offers:Anyone can read active offers', 'products:public reads live products',
    ]);
    assert.doesNotMatch(code, /create trigger|drop (policy|trigger|table)|wallet|ledger|payment|stripe|refund|transfer|_orders|_purchases|donations/i);
    const writes = [...code.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+(public\.\w+)/gi)].map((m) => m[1]);
    assert.deepEqual([...new Set(writes)], ['public.discovery_fixtures']);
  });
  test('the locality migration writes no data', () => {
    const code = src(LOCALITY).split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    assert.doesNotMatch(code, /\b(insert\s+into|update\s+public|delete\s+from)\b/i);
  });
});

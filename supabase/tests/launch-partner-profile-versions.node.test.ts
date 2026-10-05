/**
 * launch-partner-profile-versions.node.test.ts — the audit trail for promoting a prepared profile, against real SQL.
 *
 * Migration 20261107000000. Only the PROFILE layer of a prepared page (hero, story, useful, emphasis, layout) may
 * move prepared -> owner-edited -> approved. Commerce (products, productsTitle, experience, booking, rewards, notes)
 * never does. This proves the whitelist, who may do what, that history is immutable, that approval publishes nothing,
 * and that nothing else in the database changes.
 *
 *   A  privacy of the table, grants, function hygiene, table CHECKs
 *   B  record_prepared: admin only, profile layer only, de-duplicated
 *   C  owner_save_profile: owner only (not admins), every commerce key refused, shape and size
 *   D  owner_approve: owner only, kind and campaign checks, snapshot, re-approval, reserved columns untouched
 *   E  readers: admin-or-owner matrix, bodies kept out of the list, approved snapshot is stable
 *   F  immutability: UPDATE, DELETE, TRUNCATE
 *   G  nothing else changed (row hashes), update whitelist, admin get keeps every field, events hold ids only
 *   H  no outbound calls; the migration touches nothing it should not
 *   K  mutations: whitelist, owner predicate, immutability trigger, approve kind check, approve campaign check
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
const MEETS = join(MIG, '20260916120000_business_meets_tier.sql');
const FIX = join(MIG, '20261031030000_business_claims_claimants_submit_only.sql');
const DECIDER = join(MIG, '20261031040000_business_claims_record_the_decider.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const GRANTS = join(MIG, '20261103000000_launch_plan_grants.sql');
const LOCALITY = join(MIG, '20261104000000_public_business_locality.sql');
const CLAIMS = join(MIG, '20261104030000_launch_partner_claims.sql');
const IMPORT = join(MIG, '20261105000000_product_import_foundation.sql');
const CAMPAIGNS = join(MIG, '20261106000000_launch_partner_campaigns.sql');
const FEATURE = join(MIG, '20261107000000_launch_partner_profile_versions.sql');
// 20261108000000 re-issues admin_launch_partner_get (adds email_opening). Anything that re-installs FEATURE must re-apply it after.
const OPENING = join(MIG, '20261108000000_launch_partner_email_opening.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

/** VERBOSITY=verbose so an error line carries its SQLSTATE: "ERROR:  42501: message". */
function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|TRUNCATE.*|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${uid ? 'authenticated' : 'anon'}; ${sql}; commit;`);
const asService = (sql: string) => raw(`begin; set local role service_role; ${sql}; commit;`);
/** An expression, as a role; the JSON value it returns, null for SQL NULL, or the raw error text. */
const fn = (uid: string | null, expr: string): any => {
  const l = rowsOf(asUser(uid, `select coalesce((${expr})::text, 'null')`));
  const last = l[l.length - 1];
  try { return JSON.parse(last); } catch { return l.join('\n'); }
};
const isErr = (v: unknown, code?: string) => typeof v === 'string' && /ERROR/.test(v) && (!code || v.includes(code));

function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start); assert.notEqual(end, -1);
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
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';   // the invited owner of SHOP
const BOB = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';     // owned PREV before any launch claim
const EVE = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';     // an ordinary user
const CAROL = 'ca0a0a0a-4444-4444-8444-ca0a0a0a0a0a';   // owner of OTHERBIZ, which has its own campaign and launch claim
const SHOP = 'c2c2c2c2-bbbb-4bbb-8bbb-c2c2c2c2c2c2';
const CAFE = 'c1c1c1c1-aaaa-4aaa-8aaa-c1c1c1c1c1c1';
const PREV = 'c3c3c3c3-cccc-4ccc-8ccc-c3c3c3c3c3c3';    // owned by BOB, no launch claim
const FRESH = 'c4c4c4c4-dddd-4ddd-8ddd-c4c4c4c4c4c4';
const OTHERBIZ = 'c5c5c5c5-eeee-4eee-8eee-c5c5c5c5c5c5'; // owned by CAROL
const NOPE = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const SLUG = 'voe-gift-shop';
const OSLUG = 'carol-knitwear';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const jb = (o: unknown) => `${q(JSON.stringify(o))}::jsonb`;
const A = (expr: string) => fn(ADMIN, expr);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildSchema(): string {
  return raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'alter role service_role bypassrls;',
    'alter default privileges in schema public grant all on tables to anon, authenticated, service_role;',
    'alter default privileges in schema public grant all on functions to anon, authenticated, service_role;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    `create table public.profiles (id uuid primary key, role text default 'customer', full_name text, is_platform_owner boolean default false);`,
    `create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
       select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)) $$;`,
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    'alter table public.local_businesses enable row level security;',
    ...policies('local_businesses'),
    createTable(BASELINE, 'CREATE TABLE public.business_claims ('),
    'alter table public.business_claims add primary key (id);',
    'alter table public.business_claims add foreign key (business_id) references public.local_businesses(id) on delete cascade;',
    'alter table public.business_claims add foreign key (user_id) references public.profiles(id) on delete cascade;',
    'CREATE UNIQUE INDEX uq_business_claims_open ON public.business_claims USING btree (business_id, user_id) WHERE (status = \'pending\'::text);',
    'alter table public.business_claims enable row level security;',
    ...policies('business_claims'),
    slice(BASELINE, 'CREATE FUNCTION public.approve_business_claim', '$$;'),
    slice(REFUNDFIX, 'create or replace function public.tg_is_server_write', '$$;'),
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(BASELINE, 'CREATE TABLE public.book_services ('),
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    createTable(BASELINE, 'CREATE TABLE public.local_offers ('),
    createTable(IMPORT, 'create table if not exists public.import_batches ('),
    slice(MEETS, 'create or replace function public.business_meets_tier(', '$$;'),
    slice(LOCALITY, 'create or replace function public.business_locality(', '$$;'),
    createTable(GRANTS, 'create table if not exists public.launch_plan_grants ('),
    slice(GRANTS, 'create or replace function public.launch_plan_authorised()', '$$;'),
    src(FIX),
    src(DECIDER),
    src(CLAIMS),
    src(CAMPAIGNS),
    src(FEATURE),
    src(OPENING),
  ].join('\n'));
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const out = buildSchema();
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1800)}`);
  const seed = raw(`
    insert into public.profiles (id, role, full_name) values
      ('${ADMIN}', 'admin', 'Ada Admin'), ('${ALICE}', 'customer', 'Alice Owner'), ('${BOB}', 'customer', 'Bob Previous'),
      ('${EVE}', 'customer', 'Eve Ordinary'), ('${CAROL}', 'customer', 'Carol Elsewhere');
    insert into public.local_businesses (id, name, category, address, description) values
      ('${SHOP}', 'Voe Gift Shop', 'retail', ' Voe, Shetland ', 'Soap and gifts'),
      ('${CAFE}', 'Harbour Cafe', 'food_drink', 'Lerwick', 'Coffee'),
      ('${PREV}', 'Previously Owned Croft', 'other', 'Walls', 'Croft'),
      ('${FRESH}', 'Fresh Listing', 'other', 'Unst', 'Fresh'),
      ('${OTHERBIZ}', 'Carol Knitwear', 'retail', 'Whalsay', 'Knit');`);
  assert.doesNotMatch(seed, /ERROR/i, seed);
});

// ── fixtures ────────────────────────────────────────────────────────────────
/** The versions table is immutable by trigger; the harness (a superuser) switches the user triggers off just to sweep. */
const reset = () => raw(`
  update public.launch_partner_campaigns set approved_version_id = null, published_version_id = null;
  alter table public.launch_partner_page_versions disable trigger user;
  delete from public.launch_partner_page_versions;
  alter table public.launch_partner_page_versions enable trigger user;
  delete from public.launch_partner_events; delete from public.launch_partner_campaigns;
  delete from public.launch_invites; delete from public.business_claims; delete from public.launch_plan_grants;
  delete from public.import_batches; delete from public.products; delete from public.book_services;
  delete from public.book_unit_items; delete from public.local_offers;
  update public.local_businesses set owner_id=null, is_claimed=false, subscription_tier='free', subscription_until=null;
  update public.local_businesses set owner_id='${BOB}', is_claimed=true where id='${PREV}';`);

const HERO_OK = { headline: 'Gifts from Voe', tagline: 'Soap, candles and more', eyebrow: 'Voe, Shetland', locality: 'Voe',
  image: 'https://img.example/voe.jpg', treatment: 'dark', gallery: ['https://img.example/a.jpg', 'https://img.example/b.jpg'] };
const PROFILE_PART = {
  story: { title: 'Our story', body: 'Made in Voe since 1998 ☕' },
  useful: { hours: 'Mon-Sat 10-5' },
  emphasis: { lead: 'story' },
  layout: { order: ['hero', 'story'] },
};
/** The prepared page as Darren builds it: a profile layer AND every kind of commerce, plus noise. */
const RICH = {
  hero: { ...HERO_OK, price: 'SECRET-HERO-PRICE', products: [{ title: 'SECRET-HERO-PRODUCT' }], notes: 'SECRET-HERO-NOTE' },
  ...PROFILE_PART,
  products: [{ title: 'SECRET-EXAMPLE-SOAP', price_pence: 500 }], productsTitle: 'SECRET-SHOP-TITLE',
  experience: { title: 'SECRET-EXAMPLE-EXPERIENCE' }, booking: { slots: 'SECRET-BOOKING-ILLUSTRATION' },
  rewards: [{ name: 'SECRET-SUGGESTED-REWARD' }], notes: 'SECRET-INTERNAL-NOTE', mystery: 'SECRET-UNKNOWN-KEY',
};
const EXPECTED = { hero: HERO_OK, ...PROFILE_PART };
const COMMERCE_KEYS = ['products', 'productsTitle', 'experience', 'booking', 'rewards', 'notes'];
const SECRET = /SECRET-/;
const PROFILE_OK = { hero: { headline: 'Owner headline', tagline: 'Owner tagline' }, story: { body: 'Owner story' } };

const PREVIEW = { headline: 'Gifts from Voe', sections: [{ kind: 'hero', text: 'Soap' }] };
function mk(biz = SHOP, slug = SLUG, args = ''): string {
  const out = A(`public.admin_launch_partner_create('${biz}', '${slug}'${args})`);
  assert.match(String(out), UUID, `create failed: ${out}`);
  return out as string;
}
const issue = (slug = SLUG, biz = SHOP) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}', now() + interval '30 days')::jsonb`) as { token: string };
const submit = (uid: string, tok: string, slug = SLUG) =>
  fn(uid, `public.submit_launch_partner_claim('${slug}', '${tok}', 'Esther', 'esther@example.com', null, 'Owner', 'I run it')`);
const approveClaim = (biz: string) => {
  const id = scalar(`select id from public.business_claims where business_id='${biz}' and status='pending' limit 1`);
  assert.match(id, UUID);
  return asUser(ADMIN, `select public.approve_business_claim('${id}')`);
};
const setPage = (id: string, page: unknown) => A(`public.admin_launch_partner_update('${id}', ${jb({ page_config: page })})`);
const campaignRow = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const versionRow = (id: string) => JSON.parse(scalar(`select to_jsonb(v)::text from public.launch_partner_page_versions v where id='${id}'`));
const versionCount = () => Number(scalar(`select count(*) from public.launch_partner_page_versions`));
const eventKinds = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by created_at, id), '') from public.launch_partner_events where campaign_id='${id}'`);
const hashOf = (table: string) => scalar(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.${table} t`);
const PROTECTED = ['local_businesses', 'products', 'book_services', 'book_unit_items', 'local_offers', 'launch_invites', 'business_claims', 'launch_plan_grants'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));
/** The whole campaigns table, optionally without the columns a given step is ALLOWED to change. */
const campaignsHash = (without: string[] = []) =>
  scalar(`select md5(coalesce(string_agg((to_jsonb(c)${without.map((w) => ` - '${w}'`).join('')})::text, '|' order by c.id), '')) from public.launch_partner_campaigns c`);
const APPROVED_COLS = ['approved_version_id', 'approved_at', 'approved_by'];

const draft = (uid: string | null, biz: string) => fn(uid, `public.launch_partner_page_draft('${biz}')`);
const prepare = (id: string, note = '') => A(`public.admin_launch_partner_record_prepared('${id}'${note ? `, ${q(note)}` : ''})`);
const save = (uid: string | null, biz: string, profile: unknown, note = '') =>
  fn(uid, `public.launch_partner_owner_save_profile('${biz}', ${jb(profile)}${note ? `, ${q(note)}` : ''})`);
const approve = (uid: string | null, biz: string, ver: string) => fn(uid, `public.launch_partner_owner_approve('${biz}', '${ver}')`);
const versions = (uid: string | null, biz: string) => fn(uid, `public.launch_partner_profile_versions('${biz}')`);
const versionProfile = (uid: string | null, biz: string, ver: string) => fn(uid, `public.launch_partner_version_profile('${biz}', '${ver}')`);
const approvedProfile = (uid: string | null, biz: string) => fn(uid, `public.launch_partner_approved_profile('${biz}')`);

/** SHOP: a rich prepared page and ALICE as its owner through an APPROVED launch-partner claim.
 *  OTHERBIZ: a campaign of its own whose owner CAROL also has an approved launch-partner claim. PREV: BOB, no claim. */
function ownerWorld() {
  reset();
  const id = mk(SHOP, SLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(id, RICH);
  const oid = mk(OTHERBIZ, OSLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(oid, { hero: { headline: 'Carol hero' }, products: [{ title: 'SECRET-CAROL' }] });
  const pid = mk(PREV, 'prev-croft'); setPage(pid, { hero: { headline: 'Prev hero' } });
  const tok = issue().token; assert.equal(submit(ALICE, tok).state, 'pending'); approveClaim(SHOP);
  const otok = issue(OSLUG, OTHERBIZ).token; assert.equal(submit(CAROL, otok, OSLUG).state, 'pending'); approveClaim(OTHERBIZ);
  assert.equal(draft(ALICE, SHOP).slug, SLUG);
  return { id, oid, pid };
}

const OWNER_WRITES = (biz: string, ver: string) => [
  `public.launch_partner_owner_save_profile('${biz}', '{"hero":{"headline":"x"}}'::jsonb)`,
  `public.launch_partner_owner_approve('${biz}', '${ver}')`,
];
const READERS = (biz: string, ver: string) => [
  `public.launch_partner_profile_versions('${biz}')`,
  `public.launch_partner_version_profile('${biz}', '${ver}')`,
  `public.launch_partner_approved_profile('${biz}')`,
];

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · private table, grants, function hygiene, table CHECKs', () => {
  let id = ''; let ver = '';
  before(() => { const w = ownerWorld(); id = w.id; ver = prepare(id) as string; });

  test('nobody on the client side can read or write the table; the service role can only read and insert', () => {
    for (const uid of [null, ALICE, ADMIN] as const) {
      assert.match(asUser(uid, `select * from public.launch_partner_page_versions`), /permission denied/, `${uid} select`);
      assert.match(asUser(uid, `insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile) values ('${id}', '${SHOP}', 'owner_edit', '{"hero":{}}')`), /permission denied/);
      assert.match(asUser(uid, `update public.launch_partner_page_versions set note = 'x'`), /permission denied/);
      assert.match(asUser(uid, `delete from public.launch_partner_page_versions`), /permission denied/);
      assert.match(asUser(uid, `truncate public.launch_partner_page_versions`), /permission denied/);
    }
    assert.equal(scalar(`select relrowsecurity from pg_class where oid = 'public.launch_partner_page_versions'::regclass`), 't');
    assert.equal(scalar(`select count(*) from pg_policies where schemaname='public' and tablename='launch_partner_page_versions'`), '0');
    assert.match(rowsOf(asService(`select count(*) from public.launch_partner_page_versions`)).pop() ?? '', /^1$/);
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal(scalar(`select has_table_privilege('service_role', 'public.launch_partner_page_versions', '${priv}')`), 'f', `service_role ${priv}`);
    }
    for (const r of ['anon', 'authenticated', 'public']) {
      assert.equal(scalar(`select has_table_privilege('${r}', 'public.launch_partner_page_versions', 'SELECT')`), 'f', r);
    }
    assert.equal(scalar(`select count(*) from pg_views where schemaname='public' and definition ilike '%launch_partner_page_versions%'`), '0');
  });

  test('anon cannot execute any of the new functions; authenticated can; the helpers are closed to both', () => {
    const rpc = ['admin_launch_partner_record_prepared(uuid,text)', 'launch_partner_owner_save_profile(uuid,jsonb,text)',
      'launch_partner_owner_approve(uuid,uuid)', 'launch_partner_profile_versions(uuid)', 'launch_partner_version_profile(uuid,uuid)',
      'launch_partner_approved_profile(uuid)', 'admin_launch_partner_get(uuid)'];
    for (const f of rpc) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', `anon can run ${f}`);
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't', `authenticated cannot run ${f}`);
      assert.equal(scalar(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), 't', `service_role cannot run ${f}`);
    }
    for (const f of ['_launch_partner_is_owner(uuid)', '_launch_partner_can_read(uuid)', '_launch_partner_versions_list(uuid)',
      '_launch_partner_profile_extract(jsonb)', '_launch_partner_profile_keys()', '_launch_partner_hero_keys()', '_launch_partner_versions_immutable()']) {
      for (const r of ['anon', 'authenticated']) assert.equal(scalar(`select has_function_privilege('${r}', 'public.${f}', 'execute')`), 'f', `${r} can run helper ${f}`);
    }
  });

  test('every RPC and definer helper is SECURITY DEFINER with a pinned search_path', () => {
    const out = rowsOf(raw(`select p.proname || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('admin_launch_partner_record_prepared','launch_partner_owner_save_profile',
        'launch_partner_owner_approve','launch_partner_profile_versions','launch_partner_version_profile','launch_partner_approved_profile',
        'admin_launch_partner_get','_launch_partner_is_owner','_launch_partner_can_read','_launch_partner_versions_list')`)).filter((l) => l.includes('|'));
    assert.equal(out.length, 10);
    for (const l of out) assert.match(l, /\|true\|search_path=public, pg_temp$/, l);
    const pure = rowsOf(raw(`select p.proname || '|' || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('_launch_partner_profile_extract','_launch_partner_profile_keys','_launch_partner_hero_keys','_launch_partner_versions_immutable')`)).filter((l) => l.includes('|'));
    assert.equal(pure.length, 4);
    for (const l of pure) assert.match(l, /\|search_path=public, pg_temp$/, l);
  });

  test('the table refuses a bad kind, a commerce or unknown key, a bad hero, a non-object, an oversize body, a long note and a wrong business', () => {
    const ins = (kind: string, profile: string, extra = '', biz = SHOP) =>
      raw(`insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile${extra ? ', note' : ''}) values ('${id}', '${biz}', ${q(kind)}, ${profile}${extra ? `, ${extra}` : ''})`);
    const before = versionCount();
    assert.match(ins('live', `'{"hero":{}}'::jsonb`), /violates check constraint/);
    for (const k of [...COMMERCE_KEYS, 'mystery', 'Hero']) assert.match(ins('owner_edit', `jsonb_build_object('hero', '{}'::jsonb, ${q(k)}, 1)`), /violates check constraint/, k);
    assert.match(ins('owner_edit', `'{"hero":{"products":[]}}'::jsonb`), /violates check constraint/);
    assert.match(ins('owner_edit', `'{"hero":"text"}'::jsonb`), /violates check constraint/);
    assert.match(ins('owner_edit', `'[1]'::jsonb`), /violates check constraint/);
    assert.match(ins('owner_edit', `jsonb_build_object('story', repeat('a', 262200))`), /violates check constraint/);
    assert.match(ins('owner_edit', `'{"hero":{}}'::jsonb`, `repeat('n', 501)`), /violates check constraint/);
    assert.match(ins('owner_edit', `'{"hero":{}}'::jsonb`, '', CAFE), /violates foreign key constraint/, 'the business must be the campaign\'s own');
    assert.match(ins('owner_edit', `'{"hero":{}}'::jsonb`, '', NOPE), /violates foreign key constraint/);
    assert.equal(versionCount(), before);
    assert.ok(ver);
  });

  test('a campaign cannot be deleted while it has versions, and a version cannot be orphaned', () => {
    assert.match(raw(`delete from public.launch_partner_campaigns where id='${id}'`), /violates foreign key constraint/);
    assert.equal(scalar(`select count(*) from pg_indexes where tablename='launch_partner_page_versions' and indexdef ilike '%(campaign_id, created_at desc)%'`), '1');
  });

  test('the whitelist helper itself: only the profile layer survives, whatever is thrown at it', () => {
    const ex = (v: unknown) => JSON.parse(scalar(`select public._launch_partner_profile_extract(${jb(v)})::text`));
    assert.deepEqual(ex(RICH), EXPECTED);
    assert.deepEqual(ex({ hero: 'text', story: 1 }), { story: 1 }, 'a non-object hero is dropped whole');
    assert.deepEqual(ex({ products: [], notes: 'x', mystery: 1 }), {});
    assert.deepEqual(ex([1, 2]), {}); assert.deepEqual(ex('x'), {}); assert.deepEqual(ex(null), {});
    assert.equal(scalar(`select public._launch_partner_profile_extract(null)::text`), '{}');
    assert.deepEqual(ex({ hero: { headline: 'h', 'Headline': 'case', booking: 1 } }), { hero: { headline: 'h' } }, 'case-sensitive');
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · record_prepared', () => {
  let id = '';
  before(() => { ({ id } = ownerWorld()); });

  test('admin only: anon denied, everyone else 42501, nothing written', () => {
    const n = versionCount(); const ev = eventKinds(id);
    assert.match(asUser(null, `select public.admin_launch_partner_record_prepared('${id}')`), /permission denied/);
    for (const uid of [EVE, BOB, CAROL, ALICE]) {
      const out = fn(uid, `public.admin_launch_partner_record_prepared('${id}')`);
      assert.ok(isErr(out, '42501'), `${uid}: ${out}`); assert.match(out, /Only an administrator/);
    }
    assert.equal(versionCount(), n); assert.equal(eventKinds(id), ev);
  });

  test('it records ONLY the profile layer of a page_config that is full of commerce', () => {
    const v = prepare(id, 'first pass');
    assert.match(String(v), UUID);
    const r = versionRow(v);
    assert.deepEqual(r.profile, EXPECTED);
    assert.equal(r.kind, 'prepared'); assert.equal(r.actor_role, 'admin'); assert.equal(r.actor, ADMIN);
    assert.equal(r.parent_id, null); assert.equal(r.note, 'first pass'); assert.equal(r.campaign_id, id); assert.equal(r.business_id, SHOP);
    const body = JSON.stringify(r.profile);
    assert.doesNotMatch(body, SECRET);
    for (const k of [...COMMERCE_KEYS, 'mystery']) assert.equal(scalar(`select count(*) from public.launch_partner_page_versions where profile ? '${k}'`), '0', k);
    assert.equal(scalar(`select count(*) from public.launch_partner_page_versions where profile -> 'hero' ?| array['price','products','notes']`), '0');
    assert.doesNotMatch(scalar(`select coalesce(string_agg(to_jsonb(v)::text, ' '), '') from public.launch_partner_page_versions v`), SECRET);
  });

  test('the same profile again returns the SAME id and writes nothing; commerce-only edits do not count as a change', () => {
    const n = versionCount(); const ev = eventKinds(id);
    const first = scalar(`select id from public.launch_partner_page_versions where campaign_id='${id}' and kind='prepared'`);
    assert.equal(prepare(id), first);
    setPage(id, { ...RICH, products: [{ title: 'SECRET-OTHER' }], notes: 'SECRET-OTHER-NOTE', rewards: [] });
    const ev2 = eventKinds(id);                                  // setPage itself audits an 'updated' event; record_prepared must add none
    assert.equal(prepare(id), first, 'only commerce changed');
    assert.equal(versionCount(), n); assert.equal(eventKinds(id), ev2); assert.equal(ev2, `${ev},updated`);
  });

  test('a changed profile makes a NEW prepared row with no parent; the old row stays', () => {
    const first = scalar(`select id from public.launch_partner_page_versions where campaign_id='${id}' and kind='prepared'`);
    setPage(id, { ...RICH, hero: { ...RICH.hero, headline: 'Gifts from Voe, v2' } });
    const second = prepare(id) as string;
    assert.match(second, UUID); assert.notEqual(second, first);
    assert.equal(versionRow(second).parent_id, null);
    assert.equal(versionRow(second).profile.hero.headline, 'Gifts from Voe, v2');
    assert.equal(versionRow(first).profile.hero.headline, 'Gifts from Voe');
    setPage(id, RICH);
    const third = prepare(id) as string;      // back to v1 content: differs from the LATEST prepared row, so it is recorded
    assert.notEqual(third, first); assert.notEqual(third, second);
    assert.deepEqual(versionRow(third).profile, EXPECTED);
  });

  test('a page_config with no hero (empty, commerce only, hero not an object) is refused; unknown id P0002; long note 22023', () => {
    const empty = mk(CAFE, 'harbour-cafe'); const n = versionCount();
    assert.ok(isErr(prepare(empty), '22023'));
    setPage(empty, { products: [{ title: 'x' }], notes: 'n' }); assert.ok(isErr(prepare(empty), '22023'));
    setPage(empty, { hero: 'just text', story: { a: 1 } }); assert.ok(isErr(prepare(empty), '22023'));
    assert.ok(isErr(prepare(NOPE), 'P0002'));
    assert.ok(isErr(A(`public.admin_launch_partner_record_prepared('${id}', repeat('n', 501))`), '22023'));
    assert.equal(versionCount(), n);
  });

  test('the service role and a direct SQL session may record; the actor is the admin role either way', () => {
    const c = mk(FRESH, 'fresh-listing'); setPage(c, { hero: { headline: 'Fresh' } });
    const v = rowsOf(asService(`select public.admin_launch_partner_record_prepared('${c}')::text`)).pop() ?? '';
    assert.match(v, UUID); assert.equal(versionRow(v).actor_role, 'admin'); assert.equal(versionRow(v).actor, null);
    setPage(c, { hero: { headline: 'Fresh 2' } });
    assert.match(scalar(`select public.admin_launch_partner_record_prepared('${c}')::text`), UUID);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · owner_save_profile', () => {
  let id = ''; let prep = '';
  before(() => { ({ id } = ownerWorld()); prep = prepare(id) as string; });
  const snap = () => JSON.stringify([versionCount(), eventKinds(id), campaignsHash()]);

  test('only the approved owner may call it: anon denied; a random user, a previous owner, another business\'s owner and an ADMIN get 42501', () => {
    const s = snap();
    assert.match(asUser(null, `select public.launch_partner_owner_save_profile('${SHOP}', '{"hero":{}}'::jsonb)`), /permission denied/);
    for (const [uid, biz] of [[EVE, SHOP], [BOB, SHOP], [BOB, PREV], [CAROL, SHOP], [ADMIN, SHOP], [ADMIN, PREV], [ALICE, OTHERBIZ], [ALICE, PREV], [ALICE, NOPE]] as const) {
      const out = save(uid, biz, PROFILE_OK);
      assert.ok(isErr(out, '42501'), `${uid} on ${biz}: ${out}`);
    }
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile(null, '{"hero":{}}'::jsonb)`), '42501'));
    assert.equal(snap(), s, 'nothing written, nothing audited');
    // service role / direct SQL have no auth.uid(), so they are not "the owner" either
    assert.match(asService(`select public.launch_partner_owner_save_profile('${SHOP}', '{"hero":{}}'::jsonb)`), /42501/);
    assert.match(raw(`select public.launch_partner_owner_save_profile('${SHOP}', '{"hero":{}}'::jsonb)`), /42501/);
    assert.equal(snap(), s);
  });

  test('a pending or rejected launch claimant, or an owner without a launch claim, is refused', () => {
    reset(); const c = mk(SHOP, SLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(c, RICH); const tok = issue().token;
    assert.equal(submit(ALICE, tok).state, 'pending');
    raw(`update public.local_businesses set owner_id='${ALICE}' where id='${SHOP}'`);   // an owner by some other route, claim still pending
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501'), 'pending');
    raw(`update public.business_claims set status='rejected' where user_id='${ALICE}'`);
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501'), 'rejected');
    raw(`update public.business_claims set status='approved', source=null, source_ref=null where user_id='${ALICE}'`);
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501'), 'an ordinary approved claim is not a launch claim');
    raw(`update public.business_claims set source='launch_partner_invitation', source_ref='${SLUG}' where user_id='${ALICE}'`);
    raw(`update public.local_businesses set owner_id='${EVE}' where id='${SHOP}'`);
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501'), 'approved claim but no longer the owner');
    assert.equal(versionCount(), 0);
    ({ id } = ownerWorld()); prep = prepare(id) as string;
  });

  test('EVERY commerce key (and any unknown key) is refused with 22023 naming the key, and nothing is written', () => {
    const s = snap();
    for (const k of [...COMMERCE_KEYS, 'mystery', 'Hero', 'html', 'price_pence']) {
      const out = save(ALICE, SHOP, { ...PROFILE_OK, [k]: [{ title: 'x' }] });
      assert.ok(isErr(out, '22023'), `${k}: ${out}`);
      assert.ok(out.includes(`"${k}"`), `message names ${k}: ${out}`);
      const only = save(ALICE, SHOP, { [k]: 'x' });
      assert.ok(isErr(only, '22023') && only.includes(`"${k}"`), `${k} alone: ${only}`);
    }
    assert.equal(snap(), s);
  });

  test('hero sub-keys are held to their whitelist too, and hero must be an object', () => {
    const s = snap();
    for (const k of [...COMMERCE_KEYS, 'price', 'cta', 'mystery']) {
      const out = save(ALICE, SHOP, { hero: { headline: 'x', [k]: 1 } });
      assert.ok(isErr(out, '22023'), `hero.${k}: ${out}`); assert.ok(out.includes(`hero.${k}`), out);
    }
    for (const bad of ['text', 5, ['a'], null, true]) assert.ok(isErr(save(ALICE, SHOP, { hero: bad }), '22023'), JSON.stringify(bad));
    assert.equal(snap(), s);
  });

  test('shape and size: non-object, empty, null, oversize, over-long text, over-long note', () => {
    const s = snap();
    for (const bad of [[1], 'text', 5, {}, null]) assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', ${bad === null ? 'null::jsonb' : jb(bad)})`), '22023'), JSON.stringify(bad));
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', jsonb_build_object('story', jsonb_build_object('body', repeat('a', 262200))))`), '22023'));
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', jsonb_build_object('story', jsonb_build_object('body', repeat('a', 20001))))`), '22023'));
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', jsonb_build_object('hero', jsonb_build_object('gallery', jsonb_build_array(repeat('a', 20001)))))`), '22023'), 'deep strings are bounded too');
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', ${jb(PROFILE_OK)}, repeat('n', 501))`), '22023'));
    assert.equal(snap(), s);
    assert.match(String(fn(ALICE, `public.launch_partner_owner_save_profile('${SHOP}', jsonb_build_object('story', jsonb_build_object('body', repeat('a', 20000))), repeat('n', 500))`)), UUID, 'the limits themselves are allowed');
  });

  test('a valid save is an owner_edit whose parent is the latest version; the chain follows; page_config is untouched', () => {
    const pc = campaignRow(id).page_config;
    const latestBefore = scalar(`select id from public.launch_partner_page_versions where campaign_id='${id}' order by seq desc limit 1`);
    const v1 = save(ALICE, SHOP, PROFILE_OK, '  my first edit ') as string;
    assert.match(v1, UUID);
    const r1 = versionRow(v1);
    assert.equal(r1.kind, 'owner_edit'); assert.equal(r1.actor_role, 'owner'); assert.equal(r1.actor, ALICE);
    assert.equal(r1.parent_id, latestBefore); assert.notEqual(latestBefore, ''); assert.equal(r1.note, 'my first edit');
    assert.deepEqual(r1.profile, PROFILE_OK); assert.equal(r1.business_id, SHOP);
    const v2 = save(ALICE, SHOP, { ...PROFILE_OK, hero: { headline: 'Second' } }) as string;
    assert.equal(versionRow(v2).parent_id, v1);
    assert.deepEqual(campaignRow(id).page_config, pc, 'page_config is exactly as Darren left it');
    assert.equal(prep, scalar(`select id from public.launch_partner_page_versions where kind='prepared' and campaign_id='${id}'`));
  });

  test('the first version of a campaign has no parent (the owner saves before anything was recorded)', () => {
    const w = ownerWorld();
    const v = save(ALICE, SHOP, PROFILE_OK) as string;
    assert.equal(versionRow(v).parent_id, null); assert.equal(versionRow(v).campaign_id, w.id);
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · owner_approve', () => {
  let id = ''; let oid = ''; let prep = ''; let edit = ''; let carolVer = '';
  before(() => {
    ({ id, oid } = ownerWorld());
    prep = prepare(id) as string; edit = save(ALICE, SHOP, PROFILE_OK) as string;
    setPage(oid, { hero: { headline: 'Carol hero' } }); carolVer = prepare(oid) as string;
  });

  test('only the approved owner may approve: anon denied; random, previous owner, other business\'s owner and an ADMIN get 42501', () => {
    const n = versionCount(); const row = campaignRow(id);
    assert.match(asUser(null, `select public.launch_partner_owner_approve('${SHOP}', '${prep}')`), /permission denied/);
    for (const [uid, biz] of [[EVE, SHOP], [BOB, SHOP], [BOB, PREV], [CAROL, SHOP], [ADMIN, SHOP], [ALICE, OTHERBIZ], [ALICE, NOPE]] as const) {
      const out = approve(uid, biz, prep); assert.ok(isErr(out, '42501'), `${uid} on ${biz}: ${out}`);
    }
    assert.match(asService(`select public.launch_partner_owner_approve('${SHOP}', '${prep}')`), /42501/);
    assert.equal(versionCount(), n); assert.deepEqual(campaignRow(id), row);
  });

  test('a version of ANOTHER campaign, an unknown id and a null id all fail; nothing changes', () => {
    const n = versionCount(); const row = campaignRow(id);
    assert.ok(isErr(approve(ALICE, SHOP, carolVer), 'P0002'), 'CAROL\'s version');
    assert.ok(isErr(approve(ALICE, SHOP, NOPE), 'P0002'));
    assert.ok(isErr(fn(ALICE, `public.launch_partner_owner_approve('${SHOP}', null)`), 'P0002'));
    assert.ok(isErr(approve(CAROL, OTHERBIZ, prep), 'P0002'), 'and the reverse');
    assert.equal(versionCount(), n); assert.deepEqual(campaignRow(id), row);
  });

  test('only a prepared or owner_edit version can be approved: approving an approved or a published one is refused', () => {
    const r = approve(ALICE, SHOP, prep); assert.match(String(r.approved_version_id), UUID);
    const approvedRow = r.approved_version_id as string;
    const n = versionCount();
    assert.ok(isErr(approve(ALICE, SHOP, approvedRow), '22023'), 'an approved version');
    // a 'published' row cannot be produced by any function here; plant one as the harness to prove the check refuses it
    raw(`insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, actor_role) values ('${id}', '${SHOP}', 'published', '{"hero":{"headline":"p"}}', 'system')`);
    const pub = scalar(`select id from public.launch_partner_page_versions where kind='published' and campaign_id='${id}'`);
    assert.ok(isErr(approve(ALICE, SHOP, pub), '22023'), 'a published version');
    assert.equal(versionCount(), n + 1);
  });

  test('approval inserts a snapshot copy (parent = approved version), sets exactly approved_*, returns {approved_version_id, approved_at}', () => {
    ownerWorld(); id = scalar(`select id from public.launch_partner_campaigns where business_id='${SHOP}'`);
    prep = prepare(id) as string; edit = save(ALICE, SHOP, PROFILE_OK, 'edited') as string;
    const h = hashes(); const before = campaignRow(id);
    const r = approve(ALICE, SHOP, edit);
    assert.deepEqual(Object.keys(r).sort(), ['approved_at', 'approved_version_id']);
    const a = versionRow(r.approved_version_id);
    assert.equal(a.kind, 'approved'); assert.equal(a.parent_id, edit); assert.equal(a.actor_role, 'owner'); assert.equal(a.actor, ALICE);
    assert.deepEqual(a.profile, PROFILE_OK); assert.equal(a.campaign_id, id); assert.equal(a.business_id, SHOP);
    const after = campaignRow(id);
    assert.equal(after.approved_version_id, r.approved_version_id); assert.equal(after.approved_by, ALICE);
    assert.equal(new Date(after.approved_at).getTime(), new Date(r.approved_at).getTime());
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
    assert.deepEqual(changed, ['approved_at', 'approved_by', 'approved_version_id'], 'nothing else on the campaign moved');
    for (const k of ['live_at', 'setup_ready_at', 'published_version_id']) assert.equal(after[k], null, k);
    assert.deepEqual(hashes(), h, 'listing, products, invitations, claims and grants are byte-identical');
    // the original rows are untouched
    assert.equal(versionRow(edit).kind, 'owner_edit'); assert.equal(versionRow(prep).kind, 'prepared');
  });

  test('approving a prepared version directly works; re-approval adds rows, moves the pointer, and keeps all history', () => {
    const n = versionCount();
    const r1 = approve(ALICE, SHOP, prep);
    const r2 = approve(ALICE, SHOP, edit);
    assert.notEqual(r1.approved_version_id, r2.approved_version_id);
    assert.equal(versionCount(), n + 2);
    assert.equal(campaignRow(id).approved_version_id, r2.approved_version_id);
    assert.equal(versionRow(r1.approved_version_id).kind, 'approved');
    assert.deepEqual(versionRow(r1.approved_version_id).profile, EXPECTED);
    assert.equal(scalar(`select count(*) from public.launch_partner_page_versions where kind='approved' and campaign_id='${id}'`), '3');
    assert.equal(versionRow(r2.approved_version_id).parent_id, edit);
    assert.equal(campaignRow(id).published_version_id, null); assert.equal(campaignRow(id).live_at, null); assert.equal(campaignRow(id).setup_ready_at, null);
  });

  test('the version list marks exactly one row as the current approval', () => {
    const l = versions(ALICE, SHOP);
    assert.equal(l.filter((x: any) => x.is_approved_current).length, 1);
    assert.equal(l.find((x: any) => x.is_approved_current).id, campaignRow(id).approved_version_id);
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · readers', () => {
  let id = ''; let oid = ''; let prep = ''; let edit = ''; let appr = ''; let carolVer = '';
  before(() => {
    ({ id, oid } = ownerWorld());
    prep = prepare(id, 'seed') as string; edit = save(ALICE, SHOP, PROFILE_OK, 'owner note') as string;
    appr = approve(ALICE, SHOP, edit).approved_version_id;
    setPage(oid, { hero: { headline: 'Carol hero' } }); carolVer = prepare(oid) as string;
  });

  test('anon cannot call any reader; a random user, a previous owner, another business\'s owner, pending and rejected claimants get NULL', () => {
    for (const expr of READERS(SHOP, edit)) assert.match(asUser(null, `select ${expr}`), /permission denied/, expr);
    for (const [uid, biz, ver] of [[EVE, SHOP, edit], [BOB, SHOP, edit], [BOB, PREV, edit], [CAROL, SHOP, edit], [ALICE, OTHERBIZ, carolVer], [ALICE, PREV, edit], [EVE, NOPE, edit]] as const) {
      for (const expr of READERS(biz, ver)) assert.equal(fn(uid, expr), null, `${uid}: ${expr}`);
    }
    raw(`update public.business_claims set status='pending' where user_id='${ALICE}'`);
    for (const expr of READERS(SHOP, edit)) assert.equal(fn(ALICE, expr), null, `pending: ${expr}`);
    raw(`update public.business_claims set status='rejected' where user_id='${ALICE}'`);
    for (const expr of READERS(SHOP, edit)) assert.equal(fn(ALICE, expr), null, `rejected: ${expr}`);
    raw(`update public.business_claims set status='approved' where user_id='${ALICE}'`);
    assert.notEqual(versions(ALICE, SHOP), null, 'and the owner is back');
  });

  test('the reader predicate agrees with launch_partner_page_draft for every user and state', () => {
    const states: Array<[string, () => void]> = [
      ['approved owner', () => {}],
      ['pending claim', () => raw(`update public.business_claims set status='pending' where user_id='${ALICE}'`)],
      ['rejected claim', () => raw(`update public.business_claims set status='rejected' where user_id='${ALICE}'`)],
      ['claim without launch label', () => raw(`update public.business_claims set status='approved', source=null, source_ref=null where user_id='${ALICE}'`)],
      ['owner changed', () => { raw(`update public.business_claims set status='approved', source='launch_partner_invitation', source_ref='${SLUG}' where user_id='${ALICE}'`); raw(`update public.local_businesses set owner_id='${EVE}' where id='${SHOP}'`); }],
      ['restored', () => raw(`update public.local_businesses set owner_id='${ALICE}' where id='${SHOP}'`)],
    ];
    for (const [name, apply] of states) {
      apply();
      for (const uid of [EVE, BOB, CAROL, ALICE]) {
        assert.equal(versions(uid, SHOP) !== null, draft(uid, SHOP) !== null, `${name} / ${uid}`);
      }
    }
  });

  test('an administrator, the service role and direct SQL can read; a business with no campaign gives NULL to everyone', () => {
    assert.equal(versions(ADMIN, SHOP).length, 3);
    assert.deepEqual(versionProfile(ADMIN, SHOP, prep), EXPECTED);
    assert.equal(approvedProfile(ADMIN, SHOP).version_id, appr);
    assert.match(rowsOf(asService(`select public.launch_partner_profile_versions('${SHOP}')::text`)).pop() ?? '', /is_approved_current/);
    assert.match(scalar(`select public.launch_partner_approved_profile('${SHOP}')::text`), /version_id/);
    for (const uid of [ADMIN, ALICE]) for (const expr of READERS(FRESH, prep)) assert.equal(fn(uid, expr), null, `${uid}: ${expr}`);
    assert.equal(versions(ADMIN, NOPE), null);
  });

  test('the list is newest first with the documented shape and NO bodies', () => {
    const l = versions(ALICE, SHOP);
    assert.deepEqual(l.map((x: any) => x.kind), ['approved', 'owner_edit', 'prepared']);
    for (const x of l) assert.deepEqual(Object.keys(x).sort(), ['actor_role', 'created_at', 'id', 'is_approved_current', 'kind', 'note', 'parent_id']);
    assert.deepEqual(l.map((x: any) => x.is_approved_current), [true, false, false]);
    assert.equal(l[0].parent_id, edit); assert.equal(l[1].parent_id, prep); assert.equal(l[2].parent_id, null);
    assert.deepEqual(l.map((x: any) => x.actor_role), ['owner', 'owner', 'admin']);
    assert.equal(l[1].note, 'owner note'); assert.equal(l[2].note, 'seed');
    assert.doesNotMatch(JSON.stringify(l), /Owner story|Gifts from Voe|"profile"/);
    // an authorised caller with no versions gets an empty array, not NULL
    const empty = mk(CAFE, 'harbour-cafe'); assert.ok(empty);
    assert.deepEqual(versions(ADMIN, CAFE), []);
  });

  test('version_profile returns that version\'s body, only for a version of THIS business', () => {
    assert.deepEqual(versionProfile(ALICE, SHOP, edit), PROFILE_OK);
    assert.deepEqual(versionProfile(ALICE, SHOP, prep), EXPECTED);
    assert.equal(versionProfile(ALICE, SHOP, carolVer), null, 'a version of another business');
    assert.equal(versionProfile(CAROL, OTHERBIZ, edit), null);
    assert.equal(versionProfile(ALICE, SHOP, NOPE), null);
    assert.equal(fn(ALICE, `public.launch_partner_version_profile('${SHOP}', null)`), null);
  });

  test('approved_profile is the approved snapshot and is NOT moved by later owner edits or later page_config changes', () => {
    const a = approvedProfile(ALICE, SHOP);
    assert.deepEqual(Object.keys(a).sort(), ['approved_at', 'profile', 'version_id']);
    assert.equal(a.version_id, appr); assert.deepEqual(a.profile, PROFILE_OK);
    assert.equal(new Date(a.approved_at).getTime(), new Date(campaignRow(id).approved_at).getTime());
    save(ALICE, SHOP, { hero: { headline: 'A later, unapproved edit' } });
    setPage(id, { ...RICH, hero: { ...RICH.hero, headline: 'Darren changed the page' } }); prepare(id);
    const b = approvedProfile(ALICE, SHOP);
    assert.deepEqual(b, a);
    assert.doesNotMatch(JSON.stringify(b), SECRET);
  });

  test('before any approval there is nothing to read', () => {
    const w = ownerWorld(); prepare(w.id);
    assert.equal(approvedProfile(ALICE, SHOP), null); assert.equal(approvedProfile(ADMIN, SHOP), null);
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · immutability', () => {
  let ver = ''; let appr = '';
  before(() => {
    const { id } = ownerWorld(); ver = prepare(id) as string; appr = approve(ALICE, SHOP, ver).approved_version_id;
  });
  test('UPDATE is refused for any column, on any kind of row, even for the table owner', () => {
    for (const row of [ver, appr]) {
      for (const set of [`note = 'tampered'`, `profile = '{"hero":{"headline":"x"}}'`, `kind = 'owner_edit'`, `parent_id = null`, `campaign_id = campaign_id`, `created_at = now()`, `actor_role = 'system'`]) {
        const out = raw(`update public.launch_partner_page_versions set ${set} where id='${row}'`);
        assert.match(out, /append-only/, set); assert.match(out, /55000/);
      }
    }
    assert.match(raw(`update public.launch_partner_page_versions set note = 'x'`), /append-only/, 'a bulk update too');
    assert.equal(versionRow(ver).note, null); assert.deepEqual(versionRow(ver).profile, EXPECTED);
  });
  test('DELETE is refused, row by row and in bulk; so is a delete through the FK cascade path', () => {
    assert.match(raw(`delete from public.launch_partner_page_versions where id='${ver}'`), /append-only/);
    assert.match(raw(`delete from public.launch_partner_page_versions`), /append-only/);
    assert.match(raw(`delete from public.launch_partner_page_versions where kind = 'approved'`), /append-only/);
    assert.equal(versionCount(), 2);
  });
  test('TRUNCATE is refused (plain and CASCADE) and revoked from every client role', () => {
    assert.match(raw(`truncate public.launch_partner_page_versions`), /ERROR/, 'plain: also stopped by the campaigns foreign key');
    assert.match(raw(`truncate public.launch_partner_page_versions cascade`), /append-only/);
    assert.match(raw(`truncate public.launch_partner_campaigns cascade`), /append-only/, 'truncating the campaigns cascades to the versions and is stopped there');
    assert.equal(versionCount(), 2);
    assert.equal(scalar(`select count(*) from pg_trigger where tgrelid='public.launch_partner_page_versions'::regclass and not tgisinternal`), '2');
  });
  test('nothing the owner can call can change an existing row: after save + approve + re-approve the old rows are identical', () => {
    const before = scalar(`select md5(string_agg(to_jsonb(v)::text, '|' order by seq)) from public.launch_partner_page_versions v`);
    const e = save(ALICE, SHOP, PROFILE_OK) as string; approve(ALICE, SHOP, e); approve(ALICE, SHOP, ver);
    const after = scalar(`select md5(string_agg(to_jsonb(v)::text, '|' order by seq)) from (select * from public.launch_partner_page_versions order by seq limit 2) v`);
    assert.equal(after, before);
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · nothing else changes; update whitelist; admin get; events', () => {
  let id = '';
  before(() => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Real Soap', 500);
      insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'pro', now() + interval '30 days', 'launch partner trial', 'admin');
      update public.local_businesses set subscription_tier='pro', subscription_until=now() + interval '30 days' where id='${SHOP}';`);
    id = mk(SHOP, SLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(id, RICH);
    const tok = issue().token; submit(ALICE, tok); approveClaim(SHOP);
  });

  test('record_prepared, owner_save and every reader change NOTHING: not one byte of any protected table or of the campaigns', () => {
    const h = hashes(); const c = campaignsHash();
    const p = prepare(id, 'n') as string;
    assert.deepEqual(hashes(), h); assert.equal(campaignsHash(), c, 'record_prepared leaves the campaign byte-identical');
    const e = save(ALICE, SHOP, PROFILE_OK, 'n') as string;
    assert.deepEqual(hashes(), h); assert.equal(campaignsHash(), c, 'owner_save leaves the campaign byte-identical');
    versions(ALICE, SHOP); versions(ADMIN, SHOP); versionProfile(ALICE, SHOP, e); approvedProfile(ALICE, SHOP); A(`public.admin_launch_partner_get('${id}')`);
    assert.deepEqual(hashes(), h); assert.equal(campaignsHash(), c);
    assert.ok(p);
  });

  test('owner_approve changes the protected tables not at all, and the campaign only in approved_version_id / approved_at / approved_by', () => {
    // EXCLUDED from the comparison: exactly approved_version_id, approved_at and approved_by on launch_partner_campaigns.
    // updated_at is NOT excluded (approve does not touch it), and the other eight protected tables are compared whole.
    const h = hashes(); const c = campaignsHash(APPROVED_COLS);
    const e = scalar(`select id from public.launch_partner_page_versions where kind='owner_edit' order by seq desc limit 1`);
    const r = approve(ALICE, SHOP, e); assert.match(String(r.approved_version_id), UUID);
    assert.deepEqual(hashes(), h); assert.equal(campaignsHash(APPROVED_COLS), c);
    assert.notEqual(campaignsHash(), c, 'sanity: the approved_* columns did change');
    const row = campaignRow(id);
    for (const k of ['live_at', 'setup_ready_at', 'published_version_id', 'page_config', 'preview_config', 'stage', 'sent_at', 'updated_at']) {
      assert.ok(k in row, k);
    }
    assert.equal(row.live_at, null); assert.equal(row.setup_ready_at, null); assert.equal(row.published_version_id, null);
    assert.deepEqual(row.page_config, RICH, 'page_config, commerce and all, is exactly as prepared');
  });

  test('admin_launch_partner_update still cannot set approved_* or published_version_id (nor anything else outside its whitelist)', () => {
    const c = campaignsHash();
    for (const k of ['approved_version_id', 'approved_at', 'approved_by', 'published_version_id', 'live_at', 'setup_ready_at']) {
      const out = A(`public.admin_launch_partner_update('${id}', ${jb({ notes: 'valid', [k]: k === 'approved_at' ? '2026-01-01T00:00:00Z' : NOPE })})`);
      assert.ok(isErr(out, '22023'), `${k}: ${out}`); assert.ok(out.includes(`"${k}"`), out);
    }
    assert.equal(campaignsHash(), c);
    // and there is no direct write path
    for (const uid of [ADMIN, ALICE]) assert.match(asUser(uid, `update public.launch_partner_campaigns set approved_version_id = null`), /permission denied/);
  });

  test('admin_launch_partner_get still returns every previous field (same values) and adds the new ones; list is unchanged', () => {
    const g = A(`public.admin_launch_partner_get('${id}')`);
    const previous = ['id', 'business_id', 'slug', 'stage', 'is_test', 'positioning', 'contact_name', 'has_contact_email', 'has_email_draft',
      'has_preview', 'has_page_draft', 'sent_at', 'first_viewed_at', 'last_viewed_at', 'view_count', 'setup_ready_at', 'live_at', 'created_at',
      'updated_at', 'business', 'tier', 'plan_live', 'grant', 'invitation', 'claim', 'product_count', 'active_product_count', 'import_batch_count',
      'last_activity', 'preview_config', 'page_config', 'contact_email', 'email_subject', 'email_body', 'email_opening', 'notes', 'events'];
    for (const k of previous) assert.ok(k in g, `get lost ${k}`);
    const added = ['approved_version_id', 'approved_at', 'approved_by', 'published_version_id', 'versions'];
    for (const k of added) assert.ok(k in g, `get is missing ${k}`);
    assert.deepEqual(Object.keys(g).sort(), [...previous, ...added].sort(), 'and nothing else');
    assert.equal(g.id, id); assert.equal(g.slug, SLUG); assert.deepEqual(g.page_config, RICH); assert.deepEqual(g.preview_config, PREVIEW);
    assert.equal(g.business.name, 'Voe Gift Shop'); assert.equal(g.product_count, 1); assert.equal(g.grant.tier, 'pro'); assert.equal(g.invitation.status, 'claimed');
    assert.ok(Array.isArray(g.events) && g.events.length >= 3);
    assert.equal(g.approved_version_id, campaignRow(id).approved_version_id); assert.equal(g.approved_by, ALICE); assert.ok(g.approved_at);
    assert.equal(g.published_version_id, null);
    assert.deepEqual(g.versions.map((x: any) => x.kind), ['approved', 'owner_edit', 'prepared']);
    assert.deepEqual(g.versions, versions(ADMIN, SHOP));
    assert.doesNotMatch(JSON.stringify(g.versions), /"profile"/);
    assert.equal(A(`public.admin_launch_partner_get('${NOPE}')`), null);
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_get('${id}')`), '42501'));
    const l = A(`public.admin_launch_partner_list()`)[0];
    assert.ok(!('versions' in l) && !('approved_version_id' in l) && !('published_version_id' in l), 'list is unchanged');
    // a campaign with no versions reports an empty list and null approvals
    const bare = mk(CAFE, 'harbour-cafe'); const gb = A(`public.admin_launch_partner_get('${bare}')`);
    assert.deepEqual(gb.versions, []); assert.equal(gb.approved_version_id, null);
  });

  test('events carry version ids only — never profile text, notes or emails — and are labelled', () => {
    reset(); const c = mk(SHOP, SLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(c, RICH);
    const tok = issue().token; submit(ALICE, tok); approveClaim(SHOP);
    const p = prepare(c, 'NOTE-TEXT-SECRET-ADMIN') as string;
    const e = save(ALICE, SHOP, PROFILE_OK, 'NOTE-TEXT-SECRET-OWNER') as string;
    const a = approve(ALICE, SHOP, e).approved_version_id;
    const kinds = eventKinds(c).split(',').filter((k) => k.startsWith('version_') || k === 'profile_approved');
    assert.deepEqual(kinds, ['version_prepared', 'version_owner_edit', 'profile_approved']);
    const evs = rowsOf(raw(`select kind || '|' || detail::text || '|' || actor_label || '|' || coalesce(actor::text, '') from public.launch_partner_events
        where kind in ('version_prepared','version_owner_edit','profile_approved') order by created_at, id`)).map((l) => l.split('|'));
    assert.deepEqual(evs.map((x) => x[2]), ['admin', 'owner', 'owner']);
    assert.deepEqual(evs.map((x) => x[3]), [ADMIN, ALICE, ALICE]);
    assert.deepEqual(JSON.parse(evs[0][1]), { version_id: p });
    assert.deepEqual(JSON.parse(evs[1][1]), { version_id: e, parent_id: p });
    assert.deepEqual(JSON.parse(evs[2][1]), { version_id: a, source_version_id: e });
    const all = scalar(`select coalesce(string_agg(to_jsonb(e)::text, ' '), '') from public.launch_partner_events e`);
    for (const secret of ['NOTE-TEXT-SECRET', 'Owner story', 'Gifts from Voe', 'Owner headline', 'esther@example.com', 'SECRET-']) assert.ok(!all.includes(secret), `an event holds ${secret}`);
    // a refused or de-duplicated call writes no event
    const n = eventKinds(c); prepare(c); save(ALICE, SHOP, { products: [] }); approve(EVE, SHOP, e);
    assert.equal(eventKinds(c), n);
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · no outbound calls; nothing touched that should not be', () => {
  test('no function in the migration, and none installed from it, calls out to the network', () => {
    const code = src(FEATURE).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(code, /net\.http|http_post|http_get|http_request|pg_net|\bhttp\s*\(|extensions\.http|dblink|\bcopy\b[^;]*program/i);
    assert.equal(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and (p.proname like '%launch_partner%' or p.proname like 'launch_invite_%')
         and p.prosrc ~* '(net\\.http|http_post|http_get|pg_net|dblink)'`), '0');
  });
  test('the migration writes only its own tables and the three approved_* columns; it never inserts a published row or sets a reserved column', () => {
    const code = src(FEATURE).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(code, /(insert into|update|delete from)\s+public\.(local_businesses|products|launch_invites|launch_plan_grants|business_claims|book_services|book_unit_items|local_offers|import_batches)\b/i);
    assert.doesNotMatch(code, /(live_at|setup_ready_at|published_version_id)\s*=/i, 'no assignment to a reserved column');
    assert.doesNotMatch(code, /values\s*\([^)]*'published'/i, 'no function inserts kind published');
    const updates = [...code.matchAll(/update\s+public\.launch_partner_campaigns\s+set\s+([^;]*?)\s+where/gis)].map((m) => m[1].replace(/\s+/g, ' '));
    assert.deepEqual(updates, ['approved_version_id = v_id, approved_at = v_at, approved_by = auth.uid()']);
  });
  test('it redefines no existing function except admin_launch_partner_get', () => {
    const code = src(FEATURE);
    const created = [...code.matchAll(/create (?:or replace )?function public\.(\w+)/gi)].map((m) => m[1]);
    const old = [...src(CAMPAIGNS).matchAll(/create (?:or replace )?function public\.(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(created.filter((f) => old.includes(f)), ['admin_launch_partner_get']);
    assert.doesNotMatch(code, /create (or replace )?function public\.(launch_partner_page_draft|admin_launch_partner_update|admin_launch_partner_list|_launch_partner_summary|_launch_partner_event|launch_plan_authorised)/i);
  });
  test('the design-contract go_live function is documented but not implemented', () => {
    assert.match(src(FEATURE), /launch_partner_owner_go_live/);
    assert.equal(scalar(`select count(*) from pg_proc where proname = 'launch_partner_owner_go_live'`), '0');
  });
  test('the migration can be applied twice (idempotent), and history survives it', () => {
    ownerWorld(); const id = scalar(`select id from public.launch_partner_campaigns where business_id='${SHOP}'`); prepare(id);
    const n = versionCount();
    assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i);
    assert.doesNotMatch(raw(src(OPENING)), /ERROR/i);   // 20261108 re-issues get; put it back on top
    assert.equal(versionCount(), n);
    assert.ok(isErr(raw(`update public.launch_partner_page_versions set note='x'`), '55000') || /append-only/.test(raw(`update public.launch_partner_page_versions set note='x'`)));
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
// Each protection must be load-bearing: install the migration with it removed and watch the proof break, then put the
// real migration back.
describe('K · mutations', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to));
    assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => {
    const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800));
    const o2 = raw(src(OPENING)); assert.doesNotMatch(o2, /ERROR/i, o2.slice(0, 800));   // get() gains email_opening again
  };
  after(restore);

  test('M1 without the whitelist, commerce reaches a version both from page_config and from an owner', () => {
    const { id } = ownerWorld(); const p = prepare(id) as string;
    assert.doesNotMatch(JSON.stringify(versionRow(p).profile), SECRET, 'baseline: stripped');
    assert.ok(isErr(save(ALICE, SHOP, { ...PROFILE_OK, products: [{ title: 'x' }] }), '22023'), 'baseline: refused');
    mutate(`as $$ select array['hero', 'story', 'useful', 'emphasis', 'layout']::text[] $$;`,
           `as $$ select array['hero', 'story', 'useful', 'emphasis', 'layout', 'products', 'productsTitle', 'experience', 'booking', 'rewards', 'notes', 'mystery']::text[] $$;`);
    try {
      setPage(id, { ...RICH, hero: { ...RICH.hero, headline: 'changed for M1' } });
      const leaked = prepare(id) as string; assert.match(leaked, UUID);
      assert.match(JSON.stringify(versionRow(leaked).profile), SECRET, 'the mutation lets example commerce into the audit trail');
      assert.match(String(save(ALICE, SHOP, { ...PROFILE_OK, products: [{ title: 'x' }] })), UUID, 'and lets the owner submit it');
    } finally { restore(); }
    assert.ok(isErr(save(ALICE, SHOP, { ...PROFILE_OK, products: [{ title: 'x' }] }), '22023'), 'restored');
  });

  test('M2 without the approved-claim test, a merely pending claimant can save and approve', () => {
    reset(); const c = mk(SHOP, SLUG, `, p_preview => ${jb(PREVIEW)}`); setPage(c, RICH); const tok = issue().token;
    submit(ALICE, tok); raw(`update public.local_businesses set owner_id='${ALICE}' where id='${SHOP}'`);
    const p = prepare(c) as string;
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501'), 'baseline: pending claimant refused');
    assert.equal(versions(ALICE, SHOP), null);
    mutate(`and cl.source = 'launch_partner_invitation' and cl.status = 'approved');`, `and cl.source = 'launch_partner_invitation');`);
    try {
      assert.match(String(save(ALICE, SHOP, PROFILE_OK)), UUID, 'the mutation lets a pending claimant write');
      assert.match(String(approve(ALICE, SHOP, p).approved_version_id), UUID);
      assert.notEqual(versions(ALICE, SHOP), null, 'and read');
    } finally { restore(); }
    assert.ok(isErr(save(ALICE, SHOP, PROFILE_OK), '42501')); assert.equal(versions(ALICE, SHOP), null);
  });

  test('M3 without the immutability trigger, history can be rewritten and deleted', () => {
    const { id } = ownerWorld(); const p = prepare(id) as string;
    assert.match(raw(`update public.launch_partner_page_versions set note='x' where id='${p}'`), /append-only/, 'baseline');
    mutate(`  raise exception 'launch_partner_page_versions is append-only: % is not allowed', tg_op using errcode = '55000';`,
           `  return coalesce(new, old);`);
    try {
      assert.doesNotMatch(raw(`update public.launch_partner_page_versions set note='rewritten', profile='{"hero":{"headline":"forged"}}' where id='${p}'`), /ERROR|append-only/);
      assert.equal(versionRow(p).note, 'rewritten');
      assert.doesNotMatch(raw(`delete from public.launch_partner_page_versions where id='${p}'`), /ERROR|append-only/);
      assert.equal(versionCount(), 0, 'the mutation lets history be deleted');
    } finally { restore(); }
    const { id: id2 } = ownerWorld(); const p2 = prepare(id2) as string;
    assert.match(raw(`delete from public.launch_partner_page_versions where id='${p2}'`), /append-only/, 'restored');
  });

  test('M4 without the kind check, an already-approved version can be approved again', () => {
    const { id } = ownerWorld(); const p = prepare(id) as string; const a = approve(ALICE, SHOP, p).approved_version_id;
    assert.ok(isErr(approve(ALICE, SHOP, a), '22023'), 'baseline: refused');
    mutate(`if v.kind not in ('prepared', 'owner_edit') then`, `if false then`);
    try {
      const n = versionCount();
      assert.match(String(approve(ALICE, SHOP, a).approved_version_id), UUID, 'the mutation approves an approved row');
      assert.equal(versionCount(), n + 1);
    } finally { restore(); }
    assert.ok(isErr(approve(ALICE, SHOP, a), '22023'), 'restored');
  });

  test('M5 without the campaign check, an owner can approve another business\'s version', () => {
    const { oid } = ownerWorld(); setPage(oid, { hero: { headline: 'Carol hero' } }); const cv = prepare(oid) as string;
    assert.ok(isErr(approve(ALICE, SHOP, cv), 'P0002'), 'baseline: refused');
    mutate(`where x.id = p_version_id and x.campaign_id = c.id;`, `where x.id = p_version_id;`);
    try {
      const r = approve(ALICE, SHOP, cv);
      assert.match(String(r.approved_version_id), UUID, 'the mutation approves a version of another campaign');
    } finally { restore(); }
    assert.ok(isErr(approve(ALICE, SHOP, cv), 'P0002'), 'restored');
  });
});

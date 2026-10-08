/**
 * launch-partner-go-live.node.test.ts — the owner publishes the exact setup they approved, proved against the real SQL.
 *
 * Migration 20261111000000:
 *   launch_partner_owner_go_live(business, version)   OWNER only: publishes the campaign's CURRENT approved version, atomically,
 *                                                      idempotently; writes nothing to the business record
 *   launch_partner_published_profile(business)        callable signed out: the published profile layer only, or NULL
 *
 *   A  shape: signatures, grants (anon may read, may not publish), no http, no write to commerce / business / claims / grants
 *   B  who may publish: the approved owner only (admins, other owners, a previous owner, strangers and visitors are refused)
 *   C  gates: no approval, the wrong version, a newer unapproved edit, an inactive listing, no plan, an expired/removed grant
 *   D  success: a 'published' version (parent = the approved one, profile verbatim), published_version_id, live_at, setup_ready_at, audit
 *   E  idempotent: a repeat, a retry and a concurrent double-click publish once
 *   F  the approved version — never a newer draft — goes live; republishing a newer approval keeps live_at
 *   G  all or nothing: an audit failure leaves nothing published
 *   H  nothing else changes: the business record, products, services, offers, passes, claims, invitations and grants are byte-identical
 *   I  the public reader: NULL before, the profile after, NULL for an inactive or hidden business, never commerce or notes
 *   K  mutations: the owner gate, the approved-version check, idempotency and the plan gate are each load-bearing
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
const VERSIONS = join(MIG, '20261107000000_launch_partner_profile_versions.sql');
const EMAILOPEN = join(MIG, '20261108000000_launch_partner_email_opening.sql');
const DISC = join(MIG, '20261104010000_discovery_fixtures.sql');
const FEATURE = join(MIG, '20261111000000_launch_partner_go_live.sql');
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
    createTable(DISC, 'create table if not exists public.discovery_fixtures ('),
    slice(DISC, 'create or replace function public.is_discovery_hidden', '$$;'),
    slice(LOCALITY, 'create or replace function public.business_locality(', '$$;'),
    createTable(GRANTS, 'create table if not exists public.launch_plan_grants ('),
    slice(GRANTS, 'create or replace function public.launch_plan_authorised()', '$$;'),
    src(FIX),
    src(DECIDER),
    src(CLAIMS),
    src(CAMPAIGNS),
    src(VERSIONS),
    src(EMAILOPEN),
    src(FEATURE),
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
  update public.local_businesses set owner_id='${BOB}', is_claimed=true where id='${PREV}';
  update public.local_businesses set owner_id='${CAROL}', is_claimed=true where id='${OTHERBIZ}';`);

const OPENING_TEXT = 'I saw your soap stall at the Voe show and loved it.';
const MARKER = 'OPENING-MARKER-9f3b71c2';
const issue = (slug = SLUG, biz = SHOP) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}', now() + interval '30 days')::jsonb`) as { token: string };
const submit = (uid: string, tok: string, slug = SLUG) =>
  fn(uid, `public.submit_launch_partner_claim('${slug}', '${tok}', 'Esther', 'esther@example.com', null, 'Owner', 'I run it')`);
const approve = (biz: string) => {
  const id = scalar(`select id from public.business_claims where business_id='${biz}' and status='pending' limit 1`);
  assert.match(id, UUID);
  return asUser(ADMIN, `select public.approve_business_claim('${id}')`);
};
const mk = (biz = SHOP, slug = SLUG): string => {
  const out = A(`public.admin_launch_partner_create('${biz}', '${slug}')`);
  assert.match(String(out), UUID, `create failed: ${out}`);
  return out as string;
};
const upd = (id: string, patch: unknown) => A(`public.admin_launch_partner_update('${id}', ${jb(patch)})`);
const get = (id: string) => A(`public.admin_launch_partner_get('${id}')`);
const campaignRow = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const eventKinds = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by created_at, id), '') from public.launch_partner_events where campaign_id='${id}'`);
const hashOf = (table: string) => scalar(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.${table} t`);
const PROTECTED = ['local_businesses', 'products', 'launch_invites', 'business_claims', 'launch_plan_grants', 'book_services', 'book_unit_items', 'local_offers'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));


// ── helpers specific to this suite ──────────────────────────────────────────
const profile = (tag: string) => ({ hero: { tagline: `Tagline ${tag}`, image: { src: 'https://s.example/logo.png', alt: 'x' }, headline: `Name ${tag}` }, story: { title: `Story ${tag}`, body: ['One.'] }, useful: [{ title: 'Offer', body: ['Originals'] }] });
const MARK_NOTE = 'ADMIN-NOTE-MARKER-77c1-never-public';
const save = (uid: string, biz: string, p: unknown) => fn(uid, `public.launch_partner_owner_save_profile('${biz}', ${jb(p)})`);
const approveV = (uid: string, biz: string, v: string) => fn(uid, `public.launch_partner_owner_approve('${biz}', '${v}')`);
const golive = (uid: string | null, biz: string, v: string | null) => fn(uid, `public.launch_partner_owner_go_live('${biz}', ${v ? `'${v}'` : 'null'})`);
const published = (biz: string) => asUser(null, `select public.launch_partner_published_profile('${biz}')::text`);
const pubRead = (biz: string): any => { const l = rowsOf(published(biz)); const last = l[l.length - 1]; if (last === undefined) return null; try { return JSON.parse(last); } catch { return l.join('\n'); } };
const versionsOf = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by seq), '') from public.launch_partner_page_versions where campaign_id='${id}'`);
const camp = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const events = (id: string, kind: string) => scalar(`select count(*) from public.launch_partner_events where campaign_id='${id}' and kind='${kind}'`);

/** An owner (ALICE) of SHOP with an APPROVED launch-partner claim, Pro through an active launch grant, a campaign and an approved version. */
function ready(opts: { approve?: boolean; plan?: boolean } = {}) {
  reset();
  raw(`update public.local_businesses set is_active=true where id='${SHOP}'`);
  const id = mk(); upd(id, { page_config: { version: 1, hero: { tagline: 'prepared', image: { src: 'https://s.example/p.png', alt: 'p' } }, notes: MARK_NOTE, products: [{ id: 'x', title: 'Example', price: 1, image: 'https://s.example/e.png', blurb: '' }] } });
  A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
  const tok = issue().token; assert.equal(submit(ALICE, tok).state, 'pending'); approve(SHOP);
  if (opts.plan !== false) raw(`insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'premium', now() + interval '60 days', 'launch partner', 'admin'); update public.local_businesses set subscription_tier='premium', subscription_until=now() + interval '60 days' where id='${SHOP}'`);
  let vApproved: string | null = null, vEdit: string | null = null;
  if (opts.approve !== false) { vEdit = save(ALICE, SHOP, profile('A')) as string; assert.match(String(vEdit), UUID); vApproved = (approveV(ALICE, SHOP, vEdit) as any).approved_version_id; assert.match(String(vApproved), UUID); }
  return { id, vEdit, vApproved };
}

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · shape', () => {
  before(() => reset());
  test('signatures, SECURITY DEFINER, pinned search_path; the publisher is VOLATILE, the reader STABLE', () => {
    const out = rowsOf(raw(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('launch_partner_owner_go_live','launch_partner_published_profile') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, [
      'launch_partner_owner_go_live|p_business_id uuid, p_version_id uuid|jsonb|true|v|search_path=public, pg_temp',
      'launch_partner_published_profile|p_business_id uuid|jsonb|true|s|search_path=public, pg_temp',
    ]);
  });
  test('grants: only signed-in owners (and service_role) may publish; the public reader is open to anon', () => {
    assert.equal(scalar(`select has_function_privilege('anon', 'public.launch_partner_owner_go_live(uuid, uuid)', 'execute')`), 'f');
    assert.equal(scalar(`select has_function_privilege('authenticated', 'public.launch_partner_owner_go_live(uuid, uuid)', 'execute')`), 't');
    assert.equal(scalar(`select has_function_privilege('anon', 'public.launch_partner_published_profile(uuid)', 'execute')`), 't');
    assert.equal(scalar(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid in ('public.launch_partner_owner_go_live(uuid,uuid)'::regprocedure, 'public.launch_partner_published_profile(uuid)'::regprocedure) and a.grantee = 0`), '0', 'no PUBLIC grant');
  });
  test('the migration writes only the campaign\'s three go-live columns and one version row; no network; no commerce, business, claim or grant write; no other function changed', () => {
    const text = src(FEATURE).replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /pg_net|http_|net\.http|\bcurl\b/i);
    assert.doesNotMatch(text, /\b(insert\s+into|update|delete\s+from)\s+public\.(local_businesses|products|book_services|book_unit_items|local_offers|business_claims|launch_invites|launch_plan_grants)\b/i);
    assert.equal((text.match(/\bupdate\s+public\.launch_partner_campaigns\b/gi) ?? []).length, 1);
    assert.match(text, /set published_version_id = v_id,\s*live_at\s*=\s*coalesce\(c\.live_at, v_now\),\s*setup_ready_at\s*=\s*coalesce\(c\.setup_ready_at, v_now\),\s*updated_at\s*=\s*v_now/);
    assert.doesNotMatch(text, /create\s+or\s+replace\s+function\s+public\.(admin_launch_partner_update|admin_launch_partner_get|launch_partner_owner_approve|launch_partner_owner_save_profile)\b/i);
  });
  test('an admin still cannot set live_at, setup_ready_at or published_version_id through admin_launch_partner_update', () => {
    reset(); const id = mk();
    for (const k of ['live_at', 'setup_ready_at', 'published_version_id', 'approved_version_id']) assert.ok(isErr(upd(id, { [k]: null }), '22023'), k);
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · only the approved owner may publish', () => {
  test('an administrator, an ordinary user, another business\'s owner, a previous owner and a visitor are all refused; nothing is written', () => {
    const { id, vApproved } = ready();
    const before = camp(id);
    for (const u of [ADMIN, EVE, CAROL, BOB]) assert.ok(isErr(golive(u, SHOP, vApproved), '42501'), u);
    assert.ok(isErr(golive(null, SHOP, vApproved)), 'visitor');
    assert.ok(isErr(golive(ALICE, OTHERBIZ, vApproved), '42501'), 'the right user, another business');
    assert.deepEqual(camp(id), before); assert.equal(versionsOf(id), 'owner_edit,approved'); assert.equal(events(id, 'went_live'), '0');
  });
  test('an owner without an APPROVED launch-partner claim for the business cannot, even if they own it', () => {
    const { id, vApproved } = ready();
    raw(`update public.business_claims set status='pending' where business_id='${SHOP}'`);
    assert.ok(isErr(golive(ALICE, SHOP, vApproved), '42501')); assert.equal(camp(id).published_version_id, null);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · gates', () => {
  test('no approved version → refused with a plain sentence', () => {
    const { id, vEdit } = ready({ approve: false });
    for (const v of [null, vEdit, '00000000-0000-4000-8000-000000000000']) { const r = golive(ALICE, SHOP, v); assert.ok(isErr(r, '55000'), String(v)); assert.match(r, /Only the setup you approved can go live/); }
    assert.equal(versionsOf(id), '', 'nothing was written');
  });
  test('only the CURRENT approved version: an older approval, an owner_edit, a prepared draft and a newer UNAPPROVED edit are all refused', () => {
    const { id, vEdit, vApproved } = ready();
    const newer = save(ALICE, SHOP, profile('B')) as string;                       // a newer edit, NOT approved
    assert.ok(isErr(golive(ALICE, SHOP, newer), '55000'), 'newer unapproved edit');
    assert.ok(isErr(golive(ALICE, SHOP, vEdit), '55000'), 'the edit that was approved is not the approval');
    const second = (approveV(ALICE, SHOP, newer) as any).approved_version_id;      // approve the newer: now the FIRST approval is stale
    assert.ok(isErr(golive(ALICE, SHOP, vApproved), '55000'), 'an older approval can no longer go live');
    assert.ok(!isErr(golive(ALICE, SHOP, second)), 'the current approval can');
    assert.equal(versionsOf(id).split(',').filter((k) => k === 'published').length, 1);
  });
  test('the business must be listed (active)', () => {
    const { id, vApproved } = ready(); raw(`update public.local_businesses set is_active=false where id='${SHOP}'`);
    const r = golive(ALICE, SHOP, vApproved); assert.ok(isErr(r, '55000')); assert.match(r, /listed in the Directory/); assert.equal(camp(id).published_version_id, null);
  });
  test('the business must have Pro or better: no plan, an expired grant and a removed grant all refuse; a genuine paid plan is fine', () => {
    let s = ready({ plan: false }); assert.match(golive(ALICE, SHOP, s.vApproved), /Launch Partner access is not active/); assert.equal(camp(s.id).live_at, null);
    s = ready(); raw(`update public.launch_plan_grants set starts_at = now() - interval '60 days', expires_at = now() - interval '1 day' where business_id='${SHOP}'; update public.local_businesses set subscription_tier='free', subscription_until=null where id='${SHOP}'`);
    assert.ok(isErr(golive(ALICE, SHOP, s.vApproved), '55000'), 'expired');
    s = ready(); raw(`update public.launch_plan_grants set revoked_at = now(), revoke_reason = 'test' where business_id='${SHOP}'; update public.local_businesses set subscription_tier='free', subscription_until=null where id='${SHOP}'`);
    assert.ok(isErr(golive(ALICE, SHOP, s.vApproved), '55000'), 'removed');
    s = ready(); raw(`update public.launch_plan_grants set revoked_at = now(), revoke_reason = 'test' where business_id='${SHOP}'; update public.local_businesses set subscription_tier='pro', subscription_until=now() + interval '30 days' where id='${SHOP}'`);
    assert.ok(!isErr(golive(ALICE, SHOP, s.vApproved)), 'a paid plan stands in for the grant');
  });
  test('NOT gates: no products, services, offers, passes, bookings or map pin', () => {
    const { id, vApproved } = ready();
    for (const t of ['products', 'book_services', 'local_offers', 'book_unit_items']) assert.equal(scalar(`select count(*) from public.${t} where business_id='${SHOP}'`), '0');
    assert.equal(scalar(`select (lat is null)::text from public.local_businesses where id='${SHOP}'`), 'true');
    const r = golive(ALICE, SHOP, vApproved); assert.equal(r.already_live, false); assert.equal(camp(id).published_version_id, r.published_version_id);
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · success', () => {
  test('a published version is recorded verbatim from the approved one; the campaign gets published_version_id, live_at, setup_ready_at; one audit event with ids only', () => {
    const { id, vApproved } = ready();
    const approvedProfile = scalar(`select profile::text from public.launch_partner_page_versions where id='${vApproved}'`);
    const r = golive(ALICE, SHOP, vApproved);
    assert.equal(r.already_live, false); assert.match(r.published_version_id, UUID);
    assert.equal(versionsOf(id), 'owner_edit,approved,published');
    const row = JSON.parse(scalar(`select to_jsonb(v)::text from public.launch_partner_page_versions v where id='${r.published_version_id}'`));
    assert.equal(row.kind, 'published'); assert.equal(row.parent_id, vApproved); assert.equal(row.actor, ALICE); assert.equal(row.actor_role, 'owner'); assert.equal(row.business_id, SHOP);
    assert.equal(scalar(`select (v.profile = a.profile)::text from public.launch_partner_page_versions v, public.launch_partner_page_versions a where v.id='${r.published_version_id}' and a.id='${vApproved}'`), 'true', 'the profile is the approved profile, exactly');
    assert.equal(JSON.stringify(JSON.parse(approvedProfile)), JSON.stringify(JSON.parse(scalar(`select profile::text from public.launch_partner_page_versions where id='${r.published_version_id}'`))));
    const c = camp(id); assert.equal(c.published_version_id, r.published_version_id); assert.ok(c.live_at && c.setup_ready_at); assert.equal(c.approved_version_id, vApproved, 'the approval is untouched');
    assert.equal(events(id, 'went_live'), '1');
    const ev = scalar(`select detail::text from public.launch_partner_events where campaign_id='${id}' and kind='went_live'`); assert.match(ev, /version_id/); assert.doesNotMatch(ev, /Tagline|Story|Offer|Originals/);
  });
  test('the owner and the admin both read it from the real records', () => {
    const { id, vApproved } = ready(); const r = golive(ALICE, SHOP, vApproved);
    const list = fn(ALICE, `public.launch_partner_profile_versions('${SHOP}')`) as any[]; assert.ok(list.some((v) => v.kind === 'published' && v.id === r.published_version_id));
    const g = get(id); assert.equal(g.published_version_id, r.published_version_id); assert.ok(g.live_at);
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · idempotent', () => {
  test('a repeat or a retry returns already_live and writes nothing', () => {
    const { id, vApproved } = ready(); const a = golive(ALICE, SHOP, vApproved); const before = JSON.stringify(camp(id));
    for (let i = 0; i < 3; i++) { const r = golive(ALICE, SHOP, vApproved); assert.equal(r.already_live, true); assert.equal(r.published_version_id, a.published_version_id); }
    assert.equal(JSON.stringify(camp(id)), before); assert.equal(versionsOf(id), 'owner_edit,approved,published'); assert.equal(events(id, 'went_live'), '1');
  });
  test('two simultaneous clicks (two connections) publish exactly once', async () => {
    const { id, vApproved } = ready();
    const run = () => new Promise<string>((res) => {
      const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', `begin; set local request.jwt.claim.sub = '${ALICE}'; set local role authenticated; select (public.launch_partner_owner_go_live('${SHOP}', '${vApproved}'))::text; commit;`]);
      let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', () => res(out));
    });
    const [x, y] = await Promise.all([run(), run()]);
    const results = [x, y].map((o) => rowsOf(o).pop() ?? ''); assert.ok(results.every((r) => /published_version_id/.test(r)), results.join(' || '));
    assert.equal(results.filter((r) => /"already_live": false/.test(r)).length, 1, 'exactly one of the two actually published');
    assert.equal(versionsOf(id), 'owner_edit,approved,published'); assert.equal(events(id, 'went_live'), '1');
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · the approved version goes live, never a newer draft', () => {
  test('an unapproved newer edit exists: the approved one is what is published; the public sees the approved profile', () => {
    const { id, vApproved } = ready(); save(ALICE, SHOP, profile('NEWER-UNAPPROVED'));
    golive(ALICE, SHOP, vApproved);
    const pub = pubRead(SHOP); assert.equal(pub.profile.hero.tagline, 'Tagline A'); assert.doesNotMatch(JSON.stringify(pub), /NEWER-UNAPPROVED/);
    assert.equal(versionsOf(id), 'owner_edit,approved,owner_edit,published');
  });
  test('republishing: a newer APPROVAL goes live as a new published row; live_at is kept; the old rows remain', () => {
    const { id, vApproved } = ready(); const first = golive(ALICE, SHOP, vApproved); const liveAt = camp(id).live_at;
    const e2 = save(ALICE, SHOP, profile('B')) as string; const a2 = (approveV(ALICE, SHOP, e2) as any).approved_version_id;
    const second = golive(ALICE, SHOP, a2); assert.equal(second.already_live, false); assert.notEqual(second.published_version_id, first.published_version_id);
    assert.equal(camp(id).live_at, liveAt); assert.equal(camp(id).published_version_id, second.published_version_id);
    assert.equal(versionsOf(id), 'owner_edit,approved,published,owner_edit,approved,published'); assert.equal(pubRead(SHOP).profile.hero.tagline, 'Tagline B');
    assert.equal(events(id, 'went_live'), '2'); assert.match(scalar(`select string_agg(detail->>'republish', ',' order by created_at, id) from public.launch_partner_events where campaign_id='${id}' and kind='went_live'`), /false,true/);
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · all or nothing', () => {
  test('if the audit write fails, NOTHING is published: no version, no columns, no event', () => {
    const { id, vApproved } = ready();
    raw(`create or replace function public._launch_partner_event(p_campaign_id uuid, p_kind text, p_detail jsonb, p_label text) returns void language plpgsql as $$ begin if p_kind = 'went_live' then raise exception 'simulated audit failure'; end if; insert into public.launch_partner_events (campaign_id, kind, detail, actor, actor_label) values (p_campaign_id, p_kind, coalesce(p_detail, '{}'::jsonb), auth.uid(), p_label); end $$;`);
    try {
      const r = golive(ALICE, SHOP, vApproved); assert.match(String(r), /simulated audit failure/);
      assert.equal(versionsOf(id), 'owner_edit,approved'); const c = camp(id); assert.equal(c.published_version_id, null); assert.equal(c.live_at, null); assert.equal(c.setup_ready_at, null); assert.equal(events(id, 'went_live'), '0');
      assert.equal(pubRead(SHOP), null);
    } finally {
      raw(`create or replace function public._launch_partner_event(p_campaign_id uuid, p_kind text, p_detail jsonb, p_label text) returns void language sql security definer set search_path = public, pg_temp as $$ insert into public.launch_partner_events (campaign_id, kind, detail, actor, actor_label) values (p_campaign_id, p_kind, coalesce(p_detail, '{}'::jsonb), auth.uid(), p_label); $$;`);
    }
    assert.ok(!isErr(golive(ALICE, SHOP, vApproved)), 'and a retry after the failure simply works');
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · nothing else changes', () => {
  test('going live leaves the business record, products, services, offers, passes, claims, invitations and grants byte-identical — and the example products are not created', () => {
    const { vApproved } = ready();
    raw(`insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Real soap', 500);
         insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
         insert into public.book_unit_items (business_id, name, price_pence) values ('${SHOP}', 'Ten-visit pass', 4000);
         insert into public.local_offers (business_id, title, valid_until) values ('${SHOP}', 'Winter 10%', now() + interval '10 days');`);
    const h = hashes(); for (const t of PROTECTED) assert.notEqual(scalar(`select count(*) from public.${t}`), '0', `${t} has a row to protect`);
    golive(ALICE, SHOP, vApproved); golive(ALICE, SHOP, vApproved);
    assert.deepEqual(hashes(), h);
    assert.equal(scalar(`select count(*) from public.products where title='Example'`), '0', 'the prepared example product never became a product');
    assert.equal(scalar(`select count(*) from public.products where business_id='${SHOP}'`), '1', 'the real product is preserved');
  });
  test('a business with no launch campaign, and another business\'s campaign, are untouched', () => {
    const { id, vApproved } = ready(); const other = mk(CAFE, 'harbour-cafe'); const before = JSON.stringify(camp(other));
    golive(ALICE, SHOP, vApproved); assert.equal(JSON.stringify(camp(other)), before); assert.equal(versionsOf(other), '');
    assert.equal(pubRead(CAFE), null); assert.equal(pubRead(FRESH), null);
  });
});

// ═══ I ═════════════════════════════════════════════════════════════════════
describe('I · the public reader', () => {
  test('NULL before go-live; after it, only the approved profile layer — never the notes, examples or commerce', () => {
    const { id, vApproved } = ready(); assert.equal(pubRead(SHOP), null, 'before: nothing public');
    golive(ALICE, SHOP, vApproved); const pub = pubRead(SHOP);
    assert.deepEqual(Object.keys(pub).sort(), ['profile', 'published_at', 'version_id']); assert.deepEqual(Object.keys(pub.profile).sort(), ['hero', 'story', 'useful']);
    const flat = JSON.stringify(pub); assert.doesNotMatch(flat, new RegExp(MARK_NOTE)); assert.doesNotMatch(flat, /Example|products|notes/);
    assert.equal(pub.version_id, camp(id).published_version_id);
  });
  test('NULL for an inactive business and for a fixture hidden from the public (but an admin can see a hidden fixture\'s page)', () => {
    const { vApproved } = ready(); golive(ALICE, SHOP, vApproved);
    raw(`update public.local_businesses set is_active=false where id='${SHOP}'`); assert.equal(pubRead(SHOP), null, 'inactive');
    raw(`update public.local_businesses set is_active=true where id='${SHOP}'; insert into public.discovery_fixtures (entity, entity_id, reason) values ('business','${SHOP}','test')`);
    assert.equal(pubRead(SHOP), null, 'hidden fixture, signed out');
    assert.ok(fn(ADMIN, `public.launch_partner_published_profile('${SHOP}')`)?.profile, 'an administrator still sees it');
    raw(`delete from public.discovery_fixtures`);
  });
});

// ═══ J ═════════════════════════════════════════════════════════════════════
describe('J · idempotent migration', () => {
  test('applying it twice changes nothing: the published state survives', () => {
    const { id, vApproved } = ready(); golive(ALICE, SHOP, vApproved); const before = JSON.stringify(camp(id));
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
    assert.equal(JSON.stringify(camp(id)), before); assert.equal(pubRead(SHOP)?.profile.hero.tagline, 'Tagline A');
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
describe('K · mutations', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to)); assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without the owner gate, an administrator could publish someone else\'s setup', () => {
    const { vApproved } = ready(); assert.ok(isErr(golive(ADMIN, SHOP, vApproved), '42501'), 'baseline');
    mutate(`  if not public._launch_partner_is_owner(p_business_id) then
    raise exception 'Only the approved owner of this launch-partner business can go live' using errcode = '42501';
  end if;
  select * into c`, `  select * into c`);
    try { assert.ok(!isErr(golive(ADMIN, SHOP, vApproved)) || /already/.test(JSON.stringify(golive(ADMIN, SHOP, vApproved))), 'the mutation lets a non-owner through'); } finally { restore(); }
  });
  test('M2 without the approved-version check, a newer unapproved edit could be published', () => {
    const { id, vApproved } = ready(); const newer = save(ALICE, SHOP, profile('B')) as string; assert.ok(isErr(golive(ALICE, SHOP, newer), '55000'), 'baseline');
    mutate(`  if p_version_id is null or c.approved_version_id is null or c.approved_version_id is distinct from p_version_id then
    raise exception 'Only the setup you approved can go live. Approve your latest setup first.' using errcode = '55000';
  end if;
  select * into a from public.launch_partner_page_versions where id = p_version_id and campaign_id = c.id and kind = 'approved';`, `  select * into a from public.launch_partner_page_versions where id = p_version_id and campaign_id = c.id;`);
    try { golive(ALICE, SHOP, newer); assert.equal(pubRead(SHOP)?.profile.hero.tagline, 'Tagline B', 'the mutation publishes the unapproved edit'); } finally { restore(); }
    assert.ok(vApproved && id);
  });
  test('M3 without the idempotency branch, a repeat click publishes a second time', () => {
    const { id, vApproved } = ready(); golive(ALICE, SHOP, vApproved); assert.equal(golive(ALICE, SHOP, vApproved).already_live, true, 'baseline');
    mutate(`    if found and cur.parent_id = a.id then
      return jsonb_build_object('already_live', true, 'published_version_id', cur.id, 'live_at', c.live_at);
    end if;`, `    null;`);
    try { golive(ALICE, SHOP, vApproved); assert.equal(versionsOf(id), 'owner_edit,approved,published,published', 'the mutation double-publishes'); } finally { restore(); }
  });
  test('M4 without the plan gate, a business with no active access could go live', () => {
    const s = ready({ plan: false }); assert.ok(isErr(golive(ALICE, SHOP, s.vApproved), '55000'), 'baseline');
    mutate(`  if not public.business_meets_tier(p_business_id, 'pro') then
    raise exception 'Your Launch Partner access is not active, so your setup cannot go live right now.' using errcode = '55000';
  end if;
`, ``);
    try { assert.ok(!isErr(golive(ALICE, SHOP, s.vApproved)), 'the mutation lets it through'); } finally { restore(); }
  });
});

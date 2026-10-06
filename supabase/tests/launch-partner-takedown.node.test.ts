/**
 * launch-partner-takedown.node.test.ts — an administrator can take a published launch-partner page offline: audited, reversible,
 * and destructive of nothing. Proved against the real SQL.
 *
 * Migration 20261112000000:
 *   admin_launch_partner_take_offline(campaign, reason)   ADMINISTRATORS only; a reason is required; unpublishes, idempotently
 *   admin_launch_partner_allow_republish(campaign)        ADMINISTRATORS only; lifts the hold; publishes nothing
 *   launch_partner_publication_hold(business)             administrator or approved owner: {held, offline_at}; never the reason
 *   launch_partner_owner_go_live                          now refuses while an administrator's takedown is in force
 *   _launch_partner_summary                               gains is_published and offline_at
 *
 *   A  shape: signatures, grants (anon may not call anything here; the owner may call only go-live and the hold reader)
 *   B  who may take a page offline: administrators only; owners, other owners, ordinary users and visitors are refused, nothing written
 *   C  the reason is required (null, blank, too short, too long are refused)
 *   D  what taking it offline does: an 'unpublished' version, published_version_id cleared, live_at / setup_ready_at / approval kept, one event
 *   E  what it does NOT do: the business, owner, claim, grant, products, services, offers, passes, invitations and every earlier version
 *   F  idempotent: a repeat and a concurrent double-click write once; a page that was never live is refused plainly
 *   G  the public page: the reader returns nothing; the ordinary listing is what is left
 *   H  the hold: the owner cannot go live again by themselves; they can still read; they never see the reason
 *   I  republishing: an administrator allows it (publishing nothing); the owner goes live through the normal step; a new audit trail
 *   J  other businesses are unaffected
 *   K  the admin summary tells the truth (is_published / offline_at); an admin cannot set offline_at through the generic update
 *   L  mutations: the admin gate, the reason, the hold and idempotency are each load-bearing
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
const GOLIVE = join(MIG, '20261111000000_launch_partner_go_live.sql');
const FEATURE = join(MIG, '20261112000000_launch_partner_takedown.sql');
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
const CAROL = 'ca0a0a0a-4444-4444-8444-ca0a0a0a0a0a';   // owner of OTHERBIZ, which has its own live launch page
const SHOP = 'c2c2c2c2-bbbb-4bbb-8bbb-c2c2c2c2c2c2';
const CAFE = 'c1c1c1c1-aaaa-4aaa-8aaa-c1c1c1c1c1c1';
const PREV = 'c3c3c3c3-cccc-4ccc-8ccc-c3c3c3c3c3c3';
const FRESH = 'c4c4c4c4-dddd-4ddd-8ddd-c4c4c4c4c4c4';
const OTHERBIZ = 'c5c5c5c5-eeee-4eee-8eee-c5c5c5c5c5c5';
const SLUG = 'voe-gift-shop';
const SLUG2 = 'carol-knitwear';

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
    src(GOLIVE),
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

const issue = (slug: string, biz: string) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}', now() + interval '30 days')::jsonb`) as { token: string };
const submit = (uid: string, tok: string, slug: string) =>
  fn(uid, `public.submit_launch_partner_claim('${slug}', '${tok}', 'Esther', 'esther@example.com', null, 'Owner', 'I run it')`);
const approveClaim = (biz: string) => {
  const id = scalar(`select id from public.business_claims where business_id='${biz}' and status='pending' limit 1`);
  assert.match(id, UUID);
  return asUser(ADMIN, `select public.approve_business_claim('${id}')`);
};
const mk = (biz: string, slug: string): string => {
  const out = A(`public.admin_launch_partner_create('${biz}', '${slug}')`);
  assert.match(String(out), UUID, `create failed: ${out}`);
  return out as string;
};
const upd = (id: string, patch: unknown) => A(`public.admin_launch_partner_update('${id}', ${jb(patch)})`);
const get = (id: string) => A(`public.admin_launch_partner_get('${id}')`);
const hashOf = (table: string) => scalar(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.${table} t`);
const PROTECTED = ['local_businesses', 'products', 'launch_invites', 'business_claims', 'launch_plan_grants', 'book_services', 'book_unit_items', 'local_offers'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));

const profile = (tag: string) => ({ hero: { tagline: `Tagline ${tag}`, image: { src: 'https://s.example/logo.png', alt: 'x' }, headline: `Name ${tag}` }, story: { title: `Story ${tag}`, body: ['One.'] }, useful: [{ title: 'Offer', body: ['Originals'] }] });
const save = (uid: string, biz: string, p: unknown) => fn(uid, `public.launch_partner_owner_save_profile('${biz}', ${jb(p)})`);
const approveV = (uid: string, biz: string, v: string) => fn(uid, `public.launch_partner_owner_approve('${biz}', '${v}')`);
const golive = (uid: string | null, biz: string, v: string | null) => fn(uid, `public.launch_partner_owner_go_live('${biz}', ${v ? `'${v}'` : 'null'})`);
const offline = (uid: string | null, id: string, reason: string | null) => fn(uid, `public.admin_launch_partner_take_offline('${id}', ${reason === null ? 'null' : q(reason)})`);
const allow = (uid: string | null, id: string) => fn(uid, `public.admin_launch_partner_allow_republish('${id}')`);
const hold = (uid: string | null, biz: string) => fn(uid, `public.launch_partner_publication_hold('${biz}')`);
const pubRead = (biz: string): any => { const l = rowsOf(asUser(null, `select public.launch_partner_published_profile('${biz}')::text`)); const last = l[l.length - 1]; if (last === undefined) return null; try { return JSON.parse(last); } catch { return l.join('\n'); } };
const versionsOf = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by seq), '') from public.launch_partner_page_versions where campaign_id='${id}'`);
const camp = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const events = (id: string, kind: string) => Number(scalar(`select count(*) from public.launch_partner_events where campaign_id='${id}' and kind='${kind}'`));
const eventKinds = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by created_at, id), '') from public.launch_partner_events where campaign_id='${id}'`);
const versionRows = (id: string) => scalar(`select md5(coalesce(string_agg(v::text, '|' order by seq), '')) from public.launch_partner_page_versions v where campaign_id='${id}' and kind <> 'unpublished'`);

const REASON = 'REASON-MARKER-5e2a-do-not-show-the-owner: disputed ownership';

/** Make one business a launch partner with an approved version, plan and (optionally) a LIVE page. Does NOT reset. */
function partner(biz: string, slug: string, uid: string, o: { live?: boolean; tag?: string } = {}) {
  raw(`update public.local_businesses set is_active=true where id='${biz}'`);
  const id = mk(biz, slug);
  upd(id, { page_config: { version: 1, hero: { tagline: 'prepared', image: { src: 'https://s.example/p.png', alt: 'p' } }, notes: 'private', products: [{ id: 'x', title: 'Example', price: 1, image: 'https://s.example/e.png', blurb: '' }] } });
  A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
  const tok = issue(slug, biz).token; assert.equal(submit(uid, tok, slug).state, 'pending'); approveClaim(biz);
  raw(`insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${biz}', 'premium', now() + interval '60 days', 'launch partner', 'admin'); update public.local_businesses set subscription_tier='premium', subscription_until=now() + interval '60 days' where id='${biz}'`);
  const vEdit = save(uid, biz, profile(o.tag ?? 'A')) as string; assert.match(String(vEdit), UUID);
  const vApproved = (approveV(uid, biz, vEdit) as any).approved_version_id as string; assert.match(String(vApproved), UUID);
  let vPublished: string | null = null;
  if (o.live) { const r = golive(uid, biz, vApproved); assert.equal(r.already_live, false, JSON.stringify(r)); vPublished = r.published_version_id; }
  return { id, vEdit, vApproved, vPublished };
}
/** SHOP with a LIVE page (the page an administrator will take offline), plus real commerce and a second, untouched live partner. */
function live() {
  reset();
  const s = partner(SHOP, SLUG, ALICE, { live: true });
  raw(`insert into public.products (business_id, title, price_pence, is_active) values ('${SHOP}', 'Real Soap', 500, true)`);
  return s;
}

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · shape', () => {
  test('signatures, SECURITY DEFINER, pinned search_path; the two admin functions are VOLATILE, the hold reader STABLE', () => {
    const out = rowsOf(raw(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('admin_launch_partner_take_offline','admin_launch_partner_allow_republish','launch_partner_publication_hold') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, [
      'admin_launch_partner_allow_republish|p_id uuid|jsonb|true|v|search_path=public, pg_temp',
      'admin_launch_partner_take_offline|p_id uuid, p_reason text|jsonb|true|v|search_path=public, pg_temp',
      'launch_partner_publication_hold|p_business_id uuid|jsonb|true|s|search_path=public, pg_temp',
    ]);
  });
  test('grants: anon can call none of them; signed-in users may (each one refuses a non-admin itself); no PUBLIC grant', () => {
    for (const f of ['admin_launch_partner_take_offline(uuid, text)', 'admin_launch_partner_allow_republish(uuid)', 'launch_partner_publication_hold(uuid)', 'launch_partner_owner_go_live(uuid, uuid)']) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', `anon ${f}`);
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't', `authenticated ${f}`);
    }
    assert.equal(scalar(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.proname in ('admin_launch_partner_take_offline','admin_launch_partner_allow_republish','launch_partner_publication_hold','launch_partner_owner_go_live') and a.grantee = 0`), '0');
  });
  test('the migration deletes nothing, writes no business / commerce / claim / grant / invitation, makes no network call, and changes only the campaign columns it names', () => {
    const text = src(FEATURE).replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /pg_net|http_|net\.http|\bcurl\b/i);
    assert.doesNotMatch(text, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b|\bdrop\s+column\b/i);
    assert.doesNotMatch(text, /\b(insert\s+into|update|delete\s+from)\s+public\.(local_businesses|products|book_services|book_unit_items|local_offers|business_claims|launch_invites|launch_plan_grants|launch_partner_events)\b/i);
    const updates = [...text.matchAll(/\bupdate\s+public\.launch_partner_campaigns\b[\s\S]*?;/gi)].map((m) => m[0].replace(/\s+/g, ' '));
    assert.equal(updates.length, 3, updates.join('\n'));      // go-live (its three columns, as before), take-offline, allow-republish — and nothing else
    assert.ok(updates.some((u) => /set published_version_id = null, offline_at = v_at, updated_at = v_at/.test(u)));
    assert.ok(updates.some((u) => /set offline_at = null, updated_at = now\(\)/.test(u)));
    assert.doesNotMatch(updates.filter((u) => /offline_at/.test(u)).join('\n'), /\b(approved_version_id|approved_at|setup_ready_at|live_at)\b/, 'the takedown never touches the approval or the go-live history');
  });
  test('the owner can still not change admin-only columns through the generic admin update (offline_at is not a whitelisted field)', () => {
    reset(); const id = mk(SHOP, SLUG);
    for (const k of ['offline_at', 'live_at', 'setup_ready_at', 'published_version_id']) assert.ok(isErr(upd(id, { [k]: null }), '22023'), k);
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · only an administrator may take a page offline', () => {
  test('the owner, another owner, an ordinary user, a previous owner and a visitor are all refused; nothing is written', () => {
    const { id } = live();
    const before = camp(id); const h = hashes();
    for (const u of [ALICE, CAROL, EVE, BOB]) assert.ok(isErr(offline(u, id, 'please'), '42501'), u);
    assert.ok(isErr(offline(null, id, 'please')), 'visitor');
    assert.deepEqual(camp(id), before); assert.deepEqual(hashes(), h);
    assert.equal(versionsOf(id), 'owner_edit,approved,published'); assert.equal(events(id, 'went_offline'), 0);
    assert.notEqual(pubRead(SHOP), null, 'the page is still public');
  });
  test('the owner and a visitor cannot lift a hold either', () => {
    const { id } = live(); offline(ADMIN, id, 'testing the hold');
    for (const u of [ALICE, EVE, CAROL]) assert.ok(isErr(allow(u, id), '42501'), u);
    assert.ok(isErr(allow(null, id)), 'visitor');
    assert.equal(hold(ADMIN, SHOP).held, true, 'still held');
  });
  test('an administrator is accepted (is_platform_owner counts as the same admin gate the other launch functions use)', () => {
    const { id } = live(); const r = offline(ADMIN, id, 'accidental publication'); assert.equal(r.already_offline, false);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · a reason is required', () => {
  test('null, empty, blank, two characters and 501 characters are refused with nothing written; 3 and 500 are accepted', () => {
    const { id } = live(); const before = camp(id);
    for (const r of [null, '', '   ', '\n\t', 'ab', ' a ']) { const out = offline(ADMIN, id, r); assert.ok(isErr(out, '22023'), JSON.stringify(r)); assert.match(out, /reason/i); }
    assert.ok(isErr(offline(ADMIN, id, 'x'.repeat(501)), '22023'));
    assert.deepEqual(camp(id), before); assert.equal(versionsOf(id), 'owner_edit,approved,published'); assert.equal(events(id, 'went_offline'), 0);
    assert.equal(offline(ADMIN, id, 'x'.repeat(500)).already_offline, false);
  });
  test('the reason is trimmed and kept in the audit event — and only there', () => {
    const { id } = live(); offline(ADMIN, id, `   ${REASON}   `);
    assert.equal(scalar(`select detail->>'reason' from public.launch_partner_events where campaign_id='${id}' and kind='went_offline'`), REASON);
    assert.equal(scalar(`select count(*) from public.launch_partner_page_versions where campaign_id='${id}' and (note is not null or profile::text like '%REASON-MARKER%')`), '0', 'not on any version');
    assert.equal(scalar(`select count(*) from public.launch_partner_campaigns where id='${id}' and (notes::text like '%REASON-MARKER%' or page_config::text like '%REASON-MARKER%' or preview_config::text like '%REASON-MARKER%')`), '0', 'not on the campaign');
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · what taking a page offline does', () => {
  test('one append-only unpublished version (parent = the published one, same profile, admin); published_version_id cleared; offline_at set', () => {
    const { id, vPublished, vApproved } = live(); const c0 = camp(id);
    const r = offline(ADMIN, id, REASON); assert.equal(r.already_offline, false); assert.match(r.version_id, UUID);
    const c = camp(id);
    assert.equal(c.published_version_id, null); assert.ok(c.offline_at);
    assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished');
    assert.equal(scalar(`select (u.parent_id = '${vPublished}')::text || '|' || (u.profile = p.profile)::text || '|' || u.actor_role || '|' || (u.actor = '${ADMIN}')::text || '|' || coalesce(u.note, '-') from public.launch_partner_page_versions u join public.launch_partner_page_versions p on p.id = u.parent_id where u.id = '${r.version_id}'`), 'true|true|admin|true|-');
    assert.equal(c.approved_version_id, vApproved, 'the approval is not lost');
    assert.equal(c.live_at, c0.live_at, 'live_at is history and stays'); assert.equal(c.setup_ready_at, c0.setup_ready_at);
    assert.equal(c.stage, c0.stage); assert.equal(c.approved_at, c0.approved_at);
  });
  test('one audit event: who (actor and label), when, the reason and the version ids', () => {
    const { id, vPublished } = live(); const r = offline(ADMIN, id, REASON);
    assert.equal(events(id, 'went_offline'), 1);
    const e = JSON.parse(scalar(`select jsonb_build_object('actor', actor, 'label', actor_label, 'at', created_at, 'detail', detail)::text from public.launch_partner_events where campaign_id='${id}' and kind='went_offline'`));
    assert.equal(e.actor, ADMIN); assert.ok(e.label); assert.ok(e.at);
    assert.deepEqual(e.detail, { reason: REASON, version_id: r.version_id, unpublished_version_id: vPublished, actor_name: 'Ada Admin' });
    const log = (get(id).events as any[]).find((x) => x.kind === 'went_offline');
    assert.equal(log.detail.reason, REASON); assert.equal(log.actor, ADMIN); assert.ok(log.created_at);
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · what taking a page offline does NOT do', () => {
  test('the business row, ownership, claim, grant, products, services, offers, passes and invitations are byte-identical', () => {
    const { id } = live();
    raw(`insert into public.book_services (business_id, name, duration_minutes, price_pence, is_active) values ('${SHOP}', 'Tasting', 30, 1000, true)`);
    const h = hashes(); offline(ADMIN, id, REASON); assert.deepEqual(hashes(), h);
    assert.equal(scalar(`select owner_id from public.local_businesses where id='${SHOP}'`), ALICE);
    assert.equal(scalar(`select (is_claimed and subscription_tier = 'premium')::text from public.local_businesses where id='${SHOP}'`), 'true');
    assert.equal(scalar(`select status from public.business_claims where business_id='${SHOP}'`), 'approved');
    assert.equal(scalar(`select (revoked_at is null and superseded_at is null and expires_at > now())::text from public.launch_plan_grants where business_id='${SHOP}'`), 'true', 'the grant is intact');
    assert.equal(scalar(`select count(*) from public.products where business_id='${SHOP}'`), '1');
    assert.equal(scalar(`select count(*) from public.book_services where business_id='${SHOP}'`), '1');
  });
  test('every earlier version is byte-identical; none is deleted or edited; the version table stays append-only', () => {
    const { id } = live(); const before = versionRows(id);
    offline(ADMIN, id, REASON); assert.equal(versionRows(id), before);
    assert.ok(isErr(raw(`update public.launch_partner_page_versions set note = 'x' where campaign_id='${id}'`), '55000'));
    assert.ok(isErr(raw(`delete from public.launch_partner_page_versions where campaign_id='${id}'`), '55000'));
  });
  test('it sends nothing: no email function, no network, and the campaign keeps its invitation, contact and send record', () => {
    const { id } = live(); const c0 = camp(id);
    offline(ADMIN, id, REASON); const c = camp(id);
    for (const k of ['stage', 'sent_at', 'contact_email', 'contact_name', 'email_subject', 'email_body', 'preview_config', 'page_config', 'approved_version_id', 'live_at', 'setup_ready_at']) assert.deepEqual(c[k], c0[k], k);
    assert.equal(scalar(`select count(*) from public.launch_invites where slug='${SLUG}' and revoked_at is not null`), '0', 'the invitation is not revoked');
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · idempotent and safe', () => {
  test('a repeat writes nothing and answers already_offline', () => {
    const { id } = live(); const first = offline(ADMIN, id, 'first reason'); const c = camp(id);
    const again = offline(ADMIN, id, 'a different reason'); assert.equal(again.already_offline, true);
    assert.deepEqual(camp(id), c); assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished');
    assert.equal(events(id, 'went_offline'), 1, 'one event, with the FIRST reason');
    assert.equal(scalar(`select detail->>'reason' from public.launch_partner_events where campaign_id='${id}' and kind='went_offline'`), 'first reason');
    assert.ok(first.version_id);
  });
  test('two concurrent clicks take it offline once', async () => {
    const { id } = live();
    const one = () => new Promise<string>((res) => {
      const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; select (public.admin_launch_partner_take_offline('${id}', 'double click'))::text; commit;`]);
      let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', () => res(out));
    });
    const [a, b] = await Promise.all([one(), one()]);
    assert.equal([a, b].filter((x) => /"already_offline": false/.test(x)).length, 1, `${a}|${b}`);
    assert.equal([a, b].filter((x) => /"already_offline": true/.test(x)).length, 1);
    assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished'); assert.equal(events(id, 'went_offline'), 1);
  });
  test('a page that was never live cannot be "taken offline", plainly; an unknown campaign is not found; nothing is written either way', () => {
    reset(); const s = partner(SHOP, SLUG, ALICE, { live: false });
    const out = offline(ADMIN, s.id, 'nothing to remove'); assert.ok(isErr(out, '55000')); assert.match(out, /not live/);
    assert.ok(isErr(offline(ADMIN, '00000000-0000-4000-8000-000000000000', 'x y z'), 'P0002'));
    assert.equal(versionsOf(s.id), 'owner_edit,approved'); assert.equal(camp(s.id).offline_at, null); assert.equal(events(s.id, 'went_offline'), 0);
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · the public page', () => {
  test('the published profile is public before; after the takedown the reader returns nothing, so the ordinary listing is what remains', () => {
    const { id } = live();
    assert.ok(pubRead(SHOP)?.profile?.hero?.tagline === 'Tagline A', 'public before');
    offline(ADMIN, id, REASON);
    assert.equal(pubRead(SHOP), null, 'the rich page is gone');
    assert.equal(scalar(`select (is_active and name = 'Voe Gift Shop' and description = 'Soap and gifts')::text from public.local_businesses where id='${SHOP}'`), 'true', 'the business and its ordinary listing are untouched');
  });
  test('nothing about the takedown (no reason, no actor) is readable by a visitor', () => {
    const { id } = live(); offline(ADMIN, id, REASON);
    const out = asUser(null, `select public.launch_partner_published_profile('${SHOP}')::text`) + raw('select 1');
    assert.doesNotMatch(out, /REASON-MARKER|went_offline|unpublished/);
    assert.ok(isErr(asUser(null, `select public.launch_partner_publication_hold('${SHOP}')`)), 'anon cannot call the hold reader');
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · the hold: the owner cannot undo a takedown', () => {
  test('while held, the owner cannot go live again — with the old approval, a new approval, or a repeat — and nothing is written', () => {
    const { id, vApproved } = live(); offline(ADMIN, id, REASON);
    const r = golive(ALICE, SHOP, vApproved); assert.ok(isErr(r, '55000')); assert.match(r, /currently offline.*contact OneShetland/i);
    const vNew = save(ALICE, SHOP, profile('B')) as string; const vNewApproved = (approveV(ALICE, SHOP, vNew) as any).approved_version_id;
    assert.ok(isErr(golive(ALICE, SHOP, vNewApproved), '55000'), 'even a brand-new approval cannot bypass the hold');
    assert.equal(camp(id).published_version_id, null); assert.equal(events(id, 'went_live'), 1, 'only the original go-live'); assert.equal(pubRead(SHOP), null);
    assert.ok(isErr(golive(ADMIN, SHOP, vApproved), '42501'), 'and the administrator cannot publish for them');
  });
  test('the owner can still READ their versions, the approved profile and the hold; the hold reader gives {held, offline_at} and never the reason', () => {
    const { id, vApproved } = live(); offline(ADMIN, id, REASON);
    const versions = fn(ALICE, `public.launch_partner_profile_versions('${SHOP}')`) as any[];
    assert.deepEqual(versions.map((v) => v.kind), ['unpublished', 'published', 'approved', 'owner_edit']);
    assert.ok(versions.every((v) => v.note === null || v.note === undefined));
    assert.equal(fn(ALICE, `public.launch_partner_approved_profile('${SHOP}')`).version_id, vApproved);
    const h = hold(ALICE, SHOP); assert.equal(h.held, true); assert.ok(h.offline_at); assert.deepEqual(Object.keys(h).sort(), ['held', 'offline_at']);
    const everything = JSON.stringify([versions, h, fn(ALICE, `public.launch_partner_page_draft('${SHOP}')`), fn(ALICE, `public.launch_partner_approved_profile('${SHOP}')`)]);
    assert.doesNotMatch(everything, /REASON-MARKER/, 'the reason never reaches an owner-readable function');
  });
  test('strangers get nothing from the hold reader; a business with no campaign gets null', () => {
    const { id } = live(); offline(ADMIN, id, REASON);
    for (const u of [EVE, CAROL, BOB]) assert.equal(hold(u, SHOP), null, u);
    assert.equal(hold(ADMIN, SHOP).held, true); assert.equal(hold(ADMIN, CAFE), null);
  });
});

// ═══ I ═════════════════════════════════════════════════════════════════════
describe('I · republishing — controlled, audited, never silent', () => {
  test('allowing it lifts the hold and publishes NOTHING; repeating it is harmless; the owner now has the Go live path again', () => {
    const { id, vApproved } = live(); offline(ADMIN, id, REASON);
    const r = allow(ADMIN, id); assert.equal(r.already_allowed, false);
    const c = camp(id); assert.equal(c.offline_at, null); assert.equal(c.published_version_id, null, 'nothing was restored');
    assert.equal(pubRead(SHOP), null, 'still not public'); assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished');
    assert.equal(events(id, 'republish_allowed'), 1);
    assert.equal(allow(ADMIN, id).already_allowed, true); assert.equal(events(id, 'republish_allowed'), 1, 'a repeat writes nothing');
    assert.equal(hold(ALICE, SHOP).held, false);
    assert.ok(vApproved);
  });
  test('the owner goes live through the NORMAL step: a new published version and a new went_live event; live_at is the FIRST go-live', () => {
    const { id, vApproved, vPublished } = live(); const first = camp(id).live_at;
    offline(ADMIN, id, REASON); allow(ADMIN, id);
    const r = golive(ALICE, SHOP, vApproved); assert.equal(r.already_live, false, JSON.stringify(r));
    assert.notEqual(r.published_version_id, vPublished, 'a NEW publication, not the old one restored');
    assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished,published');
    assert.equal(events(id, 'went_live'), 2);
    assert.equal(eventKinds(id).replace(/(^|,)(created|updated|stage|enriched)(?=,|$)/g, '').replace(/^,/, ''), 'version_owner_edit,profile_approved,went_live,went_offline,republish_allowed,went_live');
    const c = camp(id); assert.equal(c.published_version_id, r.published_version_id); assert.equal(c.live_at, first); assert.equal(c.offline_at, null);
    const second = JSON.parse(scalar(`select detail::text from public.launch_partner_events where campaign_id='${id}' and kind='went_live' order by created_at desc, id desc limit 1`));
    assert.equal(second.republish, true, 'recorded as a republication'); assert.equal(second.approved_version_id, vApproved);
    assert.equal(pubRead(SHOP)?.profile.hero.tagline, 'Tagline A', 'public again');
    assert.equal(golive(ALICE, SHOP, vApproved).already_live, true, 'and a second click is harmless');
  });
  test('a newer approval made while the page was offline is what goes live; the older approval is refused', () => {
    const { id, vApproved } = live(); offline(ADMIN, id, REASON);
    const vNew = save(ALICE, SHOP, profile('B')) as string; const vNewApproved = (approveV(ALICE, SHOP, vNew) as any).approved_version_id;
    allow(ADMIN, id);
    assert.ok(isErr(golive(ALICE, SHOP, vApproved), '55000'), 'the older approval is no longer the current one');
    assert.equal(golive(ALICE, SHOP, vNewApproved).already_live, false);
    assert.equal(pubRead(SHOP)?.profile.hero.tagline, 'Tagline B');
  });
  test('it can be taken offline again after a republication, and again allowed — every step is its own audited row', () => {
    const { id, vApproved } = live();
    offline(ADMIN, id, 'first'); allow(ADMIN, id); golive(ALICE, SHOP, vApproved);
    assert.equal(offline(ADMIN, id, 'second').already_offline, false);
    assert.equal(versionsOf(id), 'owner_edit,approved,published,unpublished,published,unpublished');
    assert.equal(events(id, 'went_offline'), 2);
  });
  test('allow_republish on a page that was never taken offline is a no-op', () => {
    const { id } = live(); assert.equal(allow(ADMIN, id).already_allowed, true); assert.equal(events(id, 'republish_allowed'), 0);
  });
});

// ═══ J ═════════════════════════════════════════════════════════════════════
describe('J · other businesses are unaffected', () => {
  test('another live partner, an ordinary business and an unrelated campaign keep every byte', () => {
    reset();
    const a = partner(SHOP, SLUG, ALICE, { live: true });
    const b = partner(OTHERBIZ, SLUG2, CAROL, { live: true, tag: 'C' });
    const bCampaign = camp(b.id); const bVersions = versionRows(b.id); const bEvents = eventKinds(b.id);
    const cafe = scalar(`select md5(t::text) from public.local_businesses t where id='${CAFE}'`);
    const otherBiz = scalar(`select md5(t::text) from public.local_businesses t where id='${OTHERBIZ}'`);
    offline(ADMIN, a.id, REASON);
    assert.deepEqual(camp(b.id), bCampaign); assert.equal(versionRows(b.id), bVersions); assert.equal(eventKinds(b.id), bEvents);
    assert.equal(scalar(`select md5(t::text) from public.local_businesses t where id='${CAFE}'`), cafe);
    assert.equal(scalar(`select md5(t::text) from public.local_businesses t where id='${OTHERBIZ}'`), otherBiz);
    assert.equal(pubRead(OTHERBIZ)?.profile.hero.tagline, 'Tagline C', 'the other partner is still public');
    assert.equal(pubRead(SHOP), null);
    assert.equal(golive(CAROL, OTHERBIZ, b.vApproved).already_live, true, 'and its owner is not held');
    assert.equal(hold(CAROL, OTHERBIZ).held, false);
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
describe('K · the admin summary tells the truth', () => {
  test('live → is_published true, offline_at null; offline → is_published false, offline_at set, live_at kept; allowed → both clear, live_at still kept', () => {
    const { id } = live();
    const s1 = get(id); assert.equal(s1.is_published, true); assert.equal(s1.offline_at, null); assert.ok(s1.live_at);
    offline(ADMIN, id, REASON);
    const s2 = get(id); assert.equal(s2.is_published, false); assert.ok(s2.offline_at); assert.equal(s2.live_at, s1.live_at); assert.equal(s2.published_version_id, null);
    assert.deepEqual((s2.versions as any[]).map((v) => v.kind), ['unpublished', 'published', 'approved', 'owner_edit']);
    allow(ADMIN, id);
    const s3 = get(id); assert.equal(s3.is_published, false); assert.equal(s3.offline_at, null); assert.equal(s3.live_at, s1.live_at);
    const row = (A(`public.admin_launch_partner_list()`) as any[]).find((r) => r.id === id);
    assert.equal(row.is_published, false); assert.equal(row.offline_at, null);
  });
  test('every field the summary already had is still there', () => {
    const { id } = live(); const s = get(id);
    for (const k of ['id', 'business_id', 'slug', 'stage', 'is_test', 'positioning', 'contact_name', 'has_contact_email', 'has_email_draft', 'has_preview', 'has_page_draft', 'sent_at', 'first_viewed_at', 'last_viewed_at', 'view_count', 'setup_ready_at', 'live_at', 'created_at', 'updated_at', 'business', 'tier', 'plan_live', 'grant', 'invitation', 'claim', 'product_count', 'active_product_count', 'import_batch_count', 'last_activity', 'approved_version_id', 'published_version_id', 'versions', 'events', 'preview_config', 'page_config']) assert.ok(k in s, k);
  });
  test('the takedown bubbles into last_activity', () => {
    const { id } = live(); const before = get(id).last_activity; offline(ADMIN, id, REASON);
    assert.ok(new Date(get(id).last_activity) >= new Date(before));
  });
});

// ═══ L ═════════════════════════════════════════════════════════════════════
describe('L · mutations — each protection is load-bearing', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to)); assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without the admin gate, the owner could take their own (or anyone\'s) page offline', () => {
    const { id } = live(); assert.ok(isErr(offline(ALICE, id, 'sneaky'), '42501'), 'baseline');
    mutate(`  if v_via is null then
    raise exception 'Only an administrator can take a launch-partner page offline' using errcode = '42501';
  end if;`, ``);
    try { assert.ok(!isErr(offline(ALICE, id, 'sneaky')), 'the mutation lets a non-admin through'); } finally { restore(); }
  });
  test('M2 without the reason check, a page could be taken offline with no explanation', () => {
    const { id } = live(); assert.ok(isErr(offline(ADMIN, id, null), '22023'), 'baseline');
    mutate(`  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for taking the page offline' using errcode = '22023';
  end if;`, ``);
    try { const r = offline(ADMIN, id, null); assert.ok(!(isErr(r, '22023') && /reason/i.test(r)), 'the mutation accepts no reason'); } finally { restore(); }
  });
  test('M3 without the hold, the owner could simply publish again and undo the takedown', () => {
    const { id, vApproved } = live(); offline(ADMIN, id, REASON); assert.ok(isErr(golive(ALICE, SHOP, vApproved), '55000'), 'baseline');
    mutate(`  if c.offline_at is not null then
    raise exception 'Your page is currently offline. Please contact OneShetland.' using errcode = '55000';
  end if;
`, ``);
    try { assert.ok(!isErr(golive(ALICE, SHOP, vApproved)), 'the mutation lets the owner override an administrator'); assert.ok(camp(id).published_version_id); } finally { restore(); }
  });
  test('M4 without the idempotency branch, a repeat takedown would add a second unpublished version', () => {
    const { id } = live(); offline(ADMIN, id, 'first'); assert.equal(offline(ADMIN, id, 'again').already_offline, true, 'baseline');
    mutate(`    if c.offline_at is not null then
      return jsonb_build_object('already_offline', true, 'offline_at', c.offline_at);      -- a repeat: nothing is written
    end if;
    raise exception 'This page is not live, so there is nothing to take offline.' using errcode = '55000';`, `    raise exception 'This page is not live, so there is nothing to take offline.' using errcode = '55000';`);
    try { const r = offline(ADMIN, id, 'again'); assert.ok(isErr(r), 'the mutation turns a safe repeat into an error'); } finally { restore(); }
  });
  test('M5 if the takedown cleared live_at, the history of having gone live would be lost', () => {
    const { id } = live(); const first = camp(id).live_at;
    mutate(`set published_version_id = null, offline_at = v_at, updated_at = v_at`, `set published_version_id = null, live_at = null, offline_at = v_at, updated_at = v_at`);
    try { offline(ADMIN, id, REASON); assert.equal(camp(id).live_at, null, 'the mutation loses it'); } finally { restore(); }
    assert.ok(first);
  });
});

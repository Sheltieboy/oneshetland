/**
 * launch-outreach-suppression.node.test.ts — a durable Launch Partner "do not contact", enforced where the send is reserved. Proved against the real SQL.
 *
 * Migration 20261113000000:
 *   launch_outreach_suppressions                          the list: business-level, plus the address that was on file; append-only; admin-only
 *   admin_launch_partner_stop_outreach(campaign, reason, note)    record "do not contact" (administrators only)
 *   admin_launch_partner_resume_outreach(campaign, reason)        lift it, deliberately (a reason is required; administrators only)
 *   admin_launch_partner_claim_send                       now refuses with 'do_not_contact' BEFORE reserving anything
 *   _launch_partner_summary                               gains `outreach` (admin-only: scope, reason code, internal note, who, when)
 *
 *   A  shape and grants: nothing here is callable by anon; no client can read or write the table
 *   B  who may record or lift one: administrators only
 *   C  recording one: a reason from the list, an optional internal note, the address on file; idempotent; the audit event carries no note and no address
 *   D  THE GATE: an unsuppressed business may send; a suppressed one is refused server-side, nothing reserved, nothing recorded as sent
 *   E  scope: changing the contact email does not re-open a business; a suppressed address is blocked for another business too
 *   F  lifting: deliberate, reasoned, audited, idempotent; the row stays as history
 *   G  append-only: nothing deletes or rewrites a suppression
 *   H  privacy: owners, visitors and other users cannot read it; the internal note never leaves the administrator functions
 *   I  other flows unaffected: claims, grants, go-live, takedown and the business record are untouched by a suppression
 *   J  no transactional path reads it; no existing campaign was suppressed by the migration
 *   K  mutations: the gate, the admin check, the note's privacy and business-level scope are each load-bearing
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
const SENDCLAIM = join(MIG, '20261109000000_launch_partner_send_claim.sql');
const GOLIVE = join(MIG, '20261111000000_launch_partner_go_live.sql');
const TAKEDOWN = join(MIG, '20261112000000_launch_partner_takedown.sql');
const FEATURE = join(MIG, '20261113000000_launch_outreach_suppression.sql');
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
    src(SENDCLAIM),
    src(GOLIVE),
    src(TAKEDOWN),
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


// ── helpers specific to this suite ──────────────────────────────────────────
const NOTE = 'INTERNAL-NOTE-MARKER-31b9-never-public: replied by phone, wants no further contact';
const stop = (uid: string | null, id: string, reason: string | null, note: string | null = null) =>
  fn(uid, `public.admin_launch_partner_stop_outreach('${id}', ${reason === null ? 'null' : q(reason)}, ${note === null ? 'null' : q(note)})`);
const resume = (uid: string | null, id: string, reason: string | null) =>
  fn(uid, `public.admin_launch_partner_resume_outreach('${id}', ${reason === null ? 'null' : q(reason)})`);
const claimSend = (uid: string | null, id: string) => fn(uid, `public.admin_launch_partner_claim_send('${id}')`);
const release = (id: string) => A(`public.admin_launch_partner_release_send('${id}')`);
const rowsOfSupp = (biz: string) => JSON.parse(scalar(`select coalesce(jsonb_agg(to_jsonb(s) order by created_at, id), '[]'::jsonb)::text from public.launch_outreach_suppressions s where business_id='${biz}'`)) as any[];
const activeCount = () => Number(scalar(`select count(*) from public.launch_outreach_suppressions where lifted_at is null`));

/** A campaign that is ready to send: contact, saved draft, Ready to invite. Does NOT reset. */
function sendable(biz: string, slug: string, email = 'Hello@Example.test') {
  raw(`update public.local_businesses set is_active=true where id='${biz}'`);
  const id = mk(biz, slug);
  const u0 = upd(id, { contact_email: email, email_subject: 'Subject', email_body: 'Body {{INVITATION_CTA}}', email_opening: 'Opening', preview_config: { slug }, page_config: { version: 1, hero: { tagline: 'prepared', image: { src: 'https://s.example/p.png', alt: 'p' } } } }); assert.ok(!isErr(u0), `update failed: ${u0}`);
  const st = A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`); assert.ok(!isErr(st), `set_stage failed: ${st}`);
  return id;
}
/** The suppression table is append-only by trigger; the harness (a superuser) switches the user triggers off just to sweep it. */
const sweep = () => raw(`alter table public.launch_outreach_suppressions disable trigger user; delete from public.launch_outreach_suppressions; alter table public.launch_outreach_suppressions enable trigger user;`);
const fresh = () => { reset(); sweep(); };
const sendState = (id: string) => JSON.parse(scalar(`select jsonb_build_object('claimed', send_claimed_at, 'sent', sent_at, 'stage', stage)::text from public.launch_partner_campaigns where id='${id}'`));

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · shape and grants', () => {
  test('signatures: SECURITY DEFINER with a pinned search_path; the admin functions are VOLATILE', () => {
    const out = rowsOf(raw(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('admin_launch_partner_stop_outreach','admin_launch_partner_resume_outreach','_launch_partner_outreach_block') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, [
      '_launch_partner_outreach_block|p_business_id uuid, p_email text|true|s|search_path=public, pg_temp',
      'admin_launch_partner_resume_outreach|p_id uuid, p_reason text|true|v|search_path=public, pg_temp',
      'admin_launch_partner_stop_outreach|p_id uuid, p_reason text, p_note text|true|v|search_path=public, pg_temp',
    ]);
  });
  test('grants: anon cannot call any of them; signed-in users may call the two admin functions (each refuses a non-admin itself); the internal helper is for nobody', () => {
    for (const f of ['admin_launch_partner_stop_outreach(uuid, text, text)', 'admin_launch_partner_resume_outreach(uuid, text)', 'admin_launch_partner_claim_send(uuid)']) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', `anon ${f}`);
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't', f);
    }
    for (const r of ['anon', 'authenticated']) assert.equal(scalar(`select has_function_privilege('${r}', 'public._launch_partner_outreach_block(uuid, text)', 'execute')`), 'f', `${r} helper`);
    assert.equal(scalar(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.proname in ('admin_launch_partner_stop_outreach','admin_launch_partner_resume_outreach','_launch_partner_outreach_block','admin_launch_partner_claim_send') and a.grantee = 0`), '0');
  });
  test('the table: RLS on, no policy, and no client can read or write it', () => {
    assert.equal(scalar(`select relrowsecurity::text from pg_class where relname='launch_outreach_suppressions'`), 'true');
    assert.equal(scalar(`select count(*) from pg_policies where tablename='launch_outreach_suppressions'`), '0');
    for (const r of ['anon', 'authenticated']) assert.equal(scalar(`select has_table_privilege('${r}', 'public.launch_outreach_suppressions', 'select,insert,update,delete')`), 'f', r);
    assert.ok(isErr(asUser(ALICE, `select count(*) from public.launch_outreach_suppressions`), '42501'), 'a signed-in user cannot read it');
    assert.ok(isErr(asUser(null, `select count(*) from public.launch_outreach_suppressions`), '42501'), 'a visitor cannot read it');
  });
  test('the migration deletes nothing, makes no network call, writes no business / claim / grant / invitation / commerce row, and inserts no suppression of its own', () => {
    const text = src(FEATURE).replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /pg_net|http_|net\.http|\bcurl\b/i);
    assert.doesNotMatch(text, /\bdelete\s+from\b|\btruncate\s+table\b|\bdrop\s+table\b|\bdrop\s+column\b/i);
    assert.doesNotMatch(text, /\b(insert\s+into|update|delete\s+from)\s+public\.(local_businesses|products|book_services|book_unit_items|local_offers|business_claims|launch_invites|launch_plan_grants|launch_partner_page_versions)\b/i);
    const campaignUpdates = [...text.matchAll(/\bupdate\s+public\.launch_partner_campaigns\b[\s\S]*?;/gi)].map((m) => m[0].replace(/\s+/g, ' '));
    assert.deepEqual(campaignUpdates, ['update public.launch_partner_campaigns set send_claimed_at = now() where id = p_id;'], 'the only campaign write is the existing send reservation, unchanged');
    assert.equal((text.match(/\binsert\s+into\s+public\.launch_outreach_suppressions\b/gi) ?? []).length, 1, 'only the admin function inserts');
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · only an administrator may record or lift a suppression', () => {
  test('the owner, another owner, an ordinary user, a previous owner and a visitor are all refused; nothing is written', () => {
    fresh(); const id = sendable(SHOP, SLUG);
    for (const u of [ALICE, CAROL, EVE, BOB]) assert.ok(isErr(stop(u, id, 'requested'), '42501'), u);
    assert.ok(isErr(stop(null, id, 'requested')), 'visitor');
    assert.equal(activeCount(), 0); assert.equal(rowsOfSupp(SHOP).length, 0); assert.equal(eventKinds(id).includes('outreach_stopped'), false);
  });
  test('only an administrator can lift one; nobody else can, and the suppression stays in force', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested');
    for (const u of [ALICE, CAROL, EVE, BOB]) assert.ok(isErr(resume(u, id, 'please remove it'), '42501'), u);
    assert.ok(isErr(resume(null, id, 'please remove it')));
    assert.equal(activeCount(), 1); assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
  });
  test('an owner who OWNS the suppressed business still cannot alter its suppression (there is no owner-facing opt-out mechanism)', () => {
    fresh(); const s = partner(SHOP, SLUG, ALICE, { live: true }); stop(ADMIN, s.id, 'requested');
    assert.ok(isErr(resume(ALICE, s.id, 'I changed my mind'), '42501')); assert.ok(isErr(stop(ALICE, s.id, 'admin'), '42501'));
    assert.equal(activeCount(), 1);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · recording "do not contact"', () => {
  test('a reason from the list is required; free-text reasons, blanks and a 501-character note are refused; nothing is written', () => {
    fresh(); const id = sendable(SHOP, SLUG);
    for (const r of [null, '', '   ', 'because', 'REQUESTED']) assert.ok(isErr(stop(ADMIN, id, r), '22023'), String(r));
    assert.ok(isErr(stop(ADMIN, id, 'requested', 'x'.repeat(501)), '22023'));
    assert.equal(activeCount(), 0);
    for (const r of ['requested', 'bounced', 'complaint', 'incorrect_contact', 'admin']) { fresh(); const i = sendable(SHOP, SLUG); assert.equal(stop(ADMIN, i, r).already_stopped, false, r); }
  });
  test('it records the business, the contact address on file (lower-cased), the reason, the internal note, who and when', () => {
    fresh(); const id = sendable(SHOP, SLUG, 'Hello@Example.test');
    const r = stop(ADMIN, id, 'requested', NOTE); assert.equal(r.already_stopped, false); assert.match(r.id, UUID);
    const [row] = rowsOfSupp(SHOP);
    assert.equal(row.business_id, SHOP); assert.equal(row.contact_email, 'hello@example.test'); assert.equal(row.reason, 'requested'); assert.equal(row.note, NOTE);
    assert.equal(row.created_by, ADMIN); assert.equal(row.created_by_label, 'Ada Admin'); assert.ok(row.created_at); assert.equal(row.lifted_at, null);
  });
  test('a campaign with no contact yet is still suppressed at business level (no address recorded)', () => {
    fresh(); raw(`update public.local_businesses set is_active=true where id='${SHOP}'`); const id = mk(SHOP, SLUG);
    stop(ADMIN, id, 'admin'); assert.equal(rowsOfSupp(SHOP)[0].contact_email, null); assert.equal(get(id).outreach.scope, 'business');
  });
  test('the audit event carries the reason code, who and whether an address was recorded — never the internal note and never the address', () => {
    fresh(); const id = sendable(SHOP, SLUG); const r = stop(ADMIN, id, 'complaint', NOTE);
    const e = JSON.parse(scalar(`select jsonb_build_object('actor', actor, 'detail', detail)::text from public.launch_partner_events where campaign_id='${id}' and kind='outreach_stopped'`));
    assert.equal(e.actor, ADMIN); assert.deepEqual(e.detail, { suppression_id: r.id, reason: 'complaint', address_recorded: true, actor_name: 'Ada Admin' });
    assert.doesNotMatch(JSON.stringify(get(id).events), /INTERNAL-NOTE-MARKER|hello@example/i, 'neither the note nor the address is in the history');
  });
  test('idempotent: a repeat writes nothing and keeps the FIRST reason', () => {
    fresh(); const id = sendable(SHOP, SLUG); const a = stop(ADMIN, id, 'requested', NOTE); const b = stop(ADMIN, id, 'admin', 'second');
    assert.equal(b.already_stopped, true); assert.equal(b.id, a.id); assert.equal(rowsOfSupp(SHOP).length, 1); assert.equal(rowsOfSupp(SHOP)[0].reason, 'requested');
    assert.equal(scalar(`select count(*) from public.launch_partner_events where campaign_id='${id}' and kind='outreach_stopped'`), '1');
  });
  test('two concurrent clicks record it once', async () => {
    fresh(); const id = sendable(SHOP, SLUG);
    const one = () => new Promise<string>((res) => {
      const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; select (public.admin_launch_partner_stop_outreach('${id}', 'requested', null))::text; commit;`]);
      let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', () => res(out));
    });
    const [a, b] = await Promise.all([one(), one()]);
    assert.equal([a, b].filter((x) => /"already_stopped": false/.test(x)).length, 1, `${a}|${b}`); assert.equal(rowsOfSupp(SHOP).length, 1);
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · THE GATE — the send is refused on the server', () => {
  test('1 · a normal, unsuppressed business: the send may be reserved (and released)', () => {
    fresh(); const id = sendable(SHOP, SLUG);
    assert.equal(claimSend(ADMIN, id).ok, true); assert.ok(sendState(id).claimed); release(id);
  });
  test('2 · a suppressed business: refused with do_not_contact; NOTHING is reserved, recorded as sent, or written', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested', NOTE);
    const before = sendState(id); const events0 = eventKinds(id);
    const r = claimSend(ADMIN, id); assert.deepEqual(r, { ok: false, reason: 'do_not_contact' });
    assert.deepEqual(sendState(id), before); assert.equal(sendState(id).claimed, null); assert.equal(sendState(id).sent, null); assert.equal(eventKinds(id), events0, 'no send_claimed event');
    assert.doesNotMatch(JSON.stringify(r), /INTERNAL-NOTE|requested/, 'the answer never reveals the note or the reason');
  });
  test('4 · a STALE page (it loaded before the suppression and clicks Send afterwards) is refused all the same — the gate is in the database, not the page', () => {
    fresh(); const id = sendable(SHOP, SLUG);
    const staleFacts = get(id); assert.equal(staleFacts.outreach, null, 'the stale page believed outreach was open');
    stop(ADMIN, id, 'requested');
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact', 'and again');
    assert.equal(sendState(id).claimed, null);
  });
  test('the gate outranks every other refusal and does not depend on the stage: a campaign already sent, or not ready, is still reported as do-not-contact', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested');
    A(`public.admin_launch_partner_set_stage('${id}', 'preparing')`); assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`); raw(`update public.launch_partner_campaigns set sent_at = now(), stage = 'sent' where id='${id}'`);
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
  });
  test('a reservation cannot be won by racing the suppression: once recorded, every later claim is refused', async () => {
    fresh(); const id = sendable(SHOP, SLUG);
    const run = (sql: string) => new Promise<string>((res) => { const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-c', `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; ${sql}; commit;`]); let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', () => res(o)); });
    await Promise.all([run(`select public.admin_launch_partner_stop_outreach('${id}', 'requested', null)`), run(`select public.admin_launch_partner_claim_send('${id}')`)]);
    if (sendState(id).claimed) release(id);                                  // either order is legitimate; what matters is the next claim
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
  });
  test('a non-admin cannot use the reservation function at all (unchanged)', () => {
    fresh(); const id = sendable(SHOP, SLUG); for (const u of [ALICE, EVE, null]) assert.ok(isErr(claimSend(u, id)), String(u));
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · scope — business-level, plus the address on file', () => {
  test('changing the contact email does NOT re-open a suppressed business', () => {
    fresh(); const id = sendable(SHOP, SLUG, 'old@example.test'); stop(ADMIN, id, 'requested');
    assert.ok(!isErr(upd(id, { contact_email: 'brand-new@example.test' })));
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact'); assert.equal(get(id).outreach.scope, 'business');
  });
  test('a suppressed ADDRESS is blocked for another business as well (the same person is not approached about a different one)', () => {
    fresh(); const a = sendable(SHOP, SLUG, 'Owner@Example.test'); const b = sendable(CAFE, 'harbour-cafe', 'owner@example.test'); const c = sendable(OTHERBIZ, SLUG2, 'someone-else@example.test');
    stop(ADMIN, a, 'requested');
    assert.equal(claimSend(ADMIN, b).reason, 'do_not_contact', 'same address (case-insensitive), another business');
    assert.equal(get(b).outreach.scope, 'address');
    assert.equal(claimSend(ADMIN, c).ok, true, 'a different business with a different address is unaffected'); release(c);
  });
  test('moving the other business to a different address frees it (its own business is not suppressed)', () => {
    fresh(); const a = sendable(SHOP, SLUG, 'owner@example.test'); const b = sendable(CAFE, 'harbour-cafe', 'owner@example.test'); stop(ADMIN, a, 'requested');
    assert.equal(claimSend(ADMIN, b).reason, 'do_not_contact'); upd(b, { contact_email: 'cafe-manager@example.test' });
    assert.equal(claimSend(ADMIN, b).ok, true); release(b);
  });
  test('the suppression is scoped to ONE business: a second business with no connection is unaffected', () => {
    fresh(); const a = sendable(SHOP, SLUG, 'a@example.test'); const b = sendable(CAFE, 'harbour-cafe', 'b@example.test'); stop(ADMIN, a, 'requested');
    assert.equal(get(b).outreach, null); assert.equal(claimSend(ADMIN, b).ok, true); release(b);
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · lifting a suppression is deliberate, reasoned and audited', () => {
  test('a reason is required (blank, two characters, 501 characters are refused); with one, the send is possible again', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'incorrect_contact', NOTE);
    for (const r of [null, '', '   ', 'ok']) assert.ok(isErr(resume(ADMIN, id, r), '22023'), String(r));
    assert.ok(isErr(resume(ADMIN, id, 'x'.repeat(501)), '22023')); assert.equal(activeCount(), 1);
    assert.equal(resume(ADMIN, id, 'Added in error — wrong business').not_stopped, false);
    assert.equal(activeCount(), 0); assert.equal(claimSend(ADMIN, id).ok, true); release(id);
  });
  test('the row is KEPT as history with who, when and why it was lifted; the audit event records it', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested', NOTE); resume(ADMIN, id, 'Added in error — wrong business');
    const [row] = rowsOfSupp(SHOP);
    assert.equal(row.reason, 'requested'); assert.equal(row.note, NOTE); assert.ok(row.lifted_at); assert.equal(row.lifted_by, ADMIN); assert.equal(row.lifted_by_label, 'Ada Admin'); assert.equal(row.lift_reason, 'Added in error — wrong business');
    assert.equal(eventKinds(id).replace(/(^|,)(created|updated|stage)(?=,|$)/g, '').replace(/^,/, ''), 'outreach_stopped,outreach_resumed');
    assert.equal(scalar(`select detail->>'reason' from public.launch_partner_events where campaign_id='${id}' and kind='outreach_resumed'`), 'Added in error — wrong business');
  });
  test('idempotent: lifting when nothing is suppressed writes nothing', () => {
    fresh(); const id = sendable(SHOP, SLUG); assert.equal(resume(ADMIN, id, 'nothing to lift').not_stopped, true); assert.equal(rowsOfSupp(SHOP).length, 0);
    stop(ADMIN, id, 'requested'); resume(ADMIN, id, 'first lift'); assert.equal(resume(ADMIN, id, 'second lift').not_stopped, true); assert.equal(scalar(`select count(*) from public.launch_partner_events where campaign_id='${id}' and kind='outreach_resumed'`), '1');
  });
  test('after a lift the business can be suppressed again: a NEW row, and the old one stays as history', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested'); resume(ADMIN, id, 'lifted for a conversation'); stop(ADMIN, id, 'complaint');
    const rows = rowsOfSupp(SHOP); assert.equal(rows.length, 2); assert.deepEqual(rows.map((r) => r.lifted_at !== null), [true, false]); assert.equal(activeCount(), 1);
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact');
  });
  test('lifting one business leaves another business\'s suppression in force', () => {
    fresh(); const a = sendable(SHOP, SLUG, 'a@example.test'); const b = sendable(CAFE, 'harbour-cafe', 'b@example.test'); stop(ADMIN, a, 'requested'); stop(ADMIN, b, 'requested'); resume(ADMIN, a, 'only this one');
    assert.equal(claimSend(ADMIN, a).ok, true); release(a); assert.equal(claimSend(ADMIN, b).reason, 'do_not_contact');
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · append-only', () => {
  test('a suppression cannot be deleted, truncated or rewritten, even by a superuser session; only lifting an active row is allowed', () => {
    fresh(); const id = sendable(SHOP, SLUG); const r = stop(ADMIN, id, 'requested', NOTE);
    assert.ok(isErr(raw(`delete from public.launch_outreach_suppressions where id='${r.id}'`), '55000'), 'delete');
    assert.ok(isErr(raw(`truncate public.launch_outreach_suppressions`), '55000'), 'truncate');
    assert.ok(isErr(raw(`update public.launch_outreach_suppressions set note='edited' where id='${r.id}'`), '55000'), 'edit the note');
    assert.ok(isErr(raw(`update public.launch_outreach_suppressions set reason='admin' where id='${r.id}'`), '55000'), 'edit the reason');
    assert.ok(isErr(raw(`update public.launch_outreach_suppressions set business_id='${CAFE}' where id='${r.id}'`), '55000'), 'move it');
    assert.equal(rowsOfSupp(SHOP)[0].note, NOTE);
    resume(ADMIN, id, 'lifted properly');
    assert.ok(isErr(raw(`update public.launch_outreach_suppressions set lifted_at=null, lift_reason=null where id='${r.id}'`), '55000'), 'a lifted row cannot be re-opened by editing it');
    assert.ok(isErr(raw(`update public.launch_outreach_suppressions set lift_reason='rewritten history' where id='${r.id}'`), '55000'), 'nor rewritten');
  });
  test('there is at most one ACTIVE suppression per business (the database enforces it, not just the function)', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested');
    assert.ok(isErr(raw(`insert into public.launch_outreach_suppressions (business_id, reason) values ('${SHOP}', 'admin')`), '23505'));
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · privacy — the internal note never leaves the administrator functions', () => {
  test('an administrator sees the scope, reason code, internal note, who and when in the campaign summary; nobody else can call it', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested', NOTE);
    const o = get(id).outreach; assert.equal(o.scope, 'business'); assert.equal(o.reason, 'requested'); assert.equal(o.note, NOTE); assert.equal(o.by, 'Ada Admin'); assert.ok(o.since);
    const list = (A(`public.admin_launch_partner_list()`) as any[]).find((r) => r.id === id); assert.equal(list.outreach.reason, 'requested');
    for (const u of [ALICE, EVE, null]) assert.ok(isErr(fn(u, `public.admin_launch_partner_get('${id}')`)), String(u));
  });
  test('the owner of the suppressed business can read nothing about it through any owner-facing function', () => {
    fresh(); const s = partner(SHOP, SLUG, ALICE, { live: true }); raw(`update public.launch_partner_campaigns set contact_email='hello@example.test' where id='${s.id}'`); stop(ADMIN, s.id, 'requested', NOTE);
    const everything = JSON.stringify([
      fn(ALICE, `public.launch_partner_page_draft('${SHOP}')`), fn(ALICE, `public.launch_partner_profile_versions('${SHOP}')`), fn(ALICE, `public.launch_partner_publication_hold('${SHOP}')`),
      fn(ALICE, `public.launch_partner_approved_profile('${SHOP}')`), pubRead(SHOP),
    ]);
    assert.doesNotMatch(everything, /INTERNAL-NOTE-MARKER|outreach|do_not_contact|suppress/i);
    assert.ok(isErr(asUser(ALICE, `select * from public.launch_outreach_suppressions`), '42501'));
  });
  test('the answer a refused send gives reveals neither the reason nor the note', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'complaint', NOTE);
    assert.doesNotMatch(JSON.stringify(claimSend(ADMIN, id)), /complaint|INTERNAL-NOTE/);
  });
});

// ═══ I ═════════════════════════════════════════════════════════════════════
describe('I · nothing else changes', () => {
  test('recording and lifting a suppression leaves the business, claim, grant, products, services, offers, passes and invitations byte-identical', () => {
    fresh(); const s = partner(SHOP, SLUG, ALICE, { live: true }); raw(`insert into public.products (business_id, title, price_pence, is_active) values ('${SHOP}', 'Real Soap', 500, true)`);
    const h = hashes(); stop(ADMIN, s.id, 'requested', NOTE); assert.deepEqual(hashes(), h); resume(ADMIN, s.id, 'checking nothing else moved'); assert.deepEqual(hashes(), h);
  });
  test('a suppressed business can still be claimed, granted, go live, be taken offline and republished — suppression is about outreach email only', () => {
    fresh(); raw(`update public.local_businesses set is_active=true where id='${SHOP}'`);
    const id = mk(SHOP, SLUG); stop(ADMIN, id, 'requested');                       // suppressed BEFORE any claim
    upd(id, { page_config: { version: 1, hero: { tagline: 'prepared', image: { src: 'https://s.example/p.png', alt: 'p' } } } });
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
    const tok = issue(SLUG, SHOP).token; assert.equal(submit(ALICE, tok, SLUG).state, 'pending'); approveClaim(SHOP);
    raw(`insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'premium', now() + interval '60 days', 'launch partner', 'admin'); update public.local_businesses set subscription_tier='premium', subscription_until=now() + interval '60 days' where id='${SHOP}'`);
    const v = save(ALICE, SHOP, profile('A')) as string; const ap = (approveV(ALICE, SHOP, v) as any).approved_version_id;
    assert.equal(golive(ALICE, SHOP, ap).already_live, false); assert.notEqual(pubRead(SHOP), null);
    assert.equal(offline(ADMIN, id, 'taking it down as a test').already_offline, false); allow(ADMIN, id); assert.equal(golive(ALICE, SHOP, ap).already_live, false);
    assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact', 'and outreach is STILL stopped');
  });
  test('the existing send-claim behaviour is unchanged for everyone not suppressed: already_sent, not_ready, send_in_progress, release', () => {
    fresh(); const id = sendable(SHOP, SLUG);
    assert.equal(claimSend(ADMIN, id).ok, true); assert.equal(claimSend(ADMIN, id).reason, 'send_in_progress'); release(id);
    raw(`update public.launch_partner_campaigns set sent_at = now(), stage = 'sent' where id='${id}'`); assert.equal(claimSend(ADMIN, id).reason, 'already_sent');
    fresh(); const id2 = mk(SHOP, SLUG); assert.equal(claimSend(ADMIN, id2).reason, 'not_ready');
  });
});

// ═══ J ═════════════════════════════════════════════════════════════════════
describe('J · scope of the feature', () => {
  test('only the suppression functions read the table; no other function (and so no transactional email path) can see it', () => {
    const readers = rowsOf(raw(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.prosrc ilike '%launch_outreach_suppressions%' and p.proname <> '_launch_outreach_suppressions_guard' order by 1`));   // the trigger guard only names the table in its error text
    assert.deepEqual(readers, ['_launch_partner_outreach_block', 'admin_launch_partner_resume_outreach', 'admin_launch_partner_stop_outreach']);
    const callers = rowsOf(raw(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.prosrc ilike '%_launch_partner_outreach_block%' order by 1`));
    assert.deepEqual(callers, ['_launch_partner_summary', 'admin_launch_partner_claim_send'], 'only the admin summary and the send reservation ask whether outreach is stopped');
  });
  test('applying the migration suppresses nobody: the list is empty on a fresh build, and the migration contains no insert but the admin function\'s', () => {
    assert.equal(scalar(`select count(*) from public.launch_outreach_suppressions where created_at < now() - interval '1 second' and false`), '0');
    const fresh0 = buildSchema(); assert.doesNotMatch(fresh0, /ERROR/i);
    assert.equal(scalar(`select count(*) from public.launch_outreach_suppressions`), '0');
    raw(`insert into public.profiles (id, role, full_name) values ('${ADMIN}', 'admin', 'Ada Admin'), ('${ALICE}', 'customer', 'Alice Owner'), ('${BOB}', 'customer', 'Bob Previous'), ('${EVE}', 'customer', 'Eve Ordinary'), ('${CAROL}', 'customer', 'Carol Elsewhere'); insert into public.local_businesses (id, name, category, address, description) values ('${SHOP}', 'Voe Gift Shop', 'retail', ' Voe, Shetland ', 'Soap and gifts'), ('${CAFE}', 'Harbour Cafe', 'food_drink', 'Lerwick', 'Coffee'), ('${PREV}', 'Previously Owned Croft', 'other', 'Walls', 'Croft'), ('${FRESH}', 'Fresh Listing', 'other', 'Unst', 'Fresh'), ('${OTHERBIZ}', 'Carol Knitwear', 'retail', 'Whalsay', 'Knit');`);
  });
  test('idempotent: the migration can be applied twice', () => {
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
describe('K · mutations — each protection is load-bearing', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to)); assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without the gate in the reservation step, a suppressed business could be emailed', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested'); assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact', 'baseline');
    mutate(`  if public._launch_partner_outreach_block(c.business_id, c.contact_email) is not null then
    return jsonb_build_object('ok', false, 'reason', 'do_not_contact');
  end if;
`, ``);
    try { assert.equal(claimSend(ADMIN, id).ok, true, 'the mutation lets the send through'); } finally { restore(); }
  });
  test('M2 without the admin check, an owner could record or lift a suppression', () => {
    fresh(); const id = sendable(SHOP, SLUG); assert.ok(isErr(stop(ALICE, id, 'admin'), '42501'), 'baseline');
    mutate(`  if v_via is null then
    raise exception 'Only an administrator can stop Launch Partner outreach' using errcode = '42501';
  end if;`, ``);
    try { assert.ok(!isErr(stop(ALICE, id, 'admin')), 'the mutation lets a non-admin through'); } finally { restore(); }
  });
  test('M3 if the audit event copied the internal note, administrators-only text would sit in the history', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested', NOTE); assert.doesNotMatch(JSON.stringify(get(id).events), /INTERNAL-NOTE/, 'baseline');
    reset(); sweep();
    mutate(`jsonb_build_object('suppression_id', v_id, 'reason', v_reason, 'address_recorded', v_addr is not null, 'actor_name', v_name), v_via);`, `jsonb_build_object('suppression_id', v_id, 'reason', v_reason, 'address_recorded', v_addr is not null, 'actor_name', v_name, 'note', v_note), v_via);`);
    try { const id2 = sendable(SHOP, SLUG); stop(ADMIN, id2, 'requested', NOTE); assert.match(JSON.stringify(get(id2).events), /INTERNAL-NOTE/, 'the mutation leaks it'); } finally { restore(); }
  });
  test('M4 without the business-level match (address only), changing the contact email would re-open outreach', () => {
    fresh(); const id = sendable(SHOP, SLUG, 'old@example.test'); stop(ADMIN, id, 'requested'); upd(id, { contact_email: 'new@example.test' }); assert.equal(claimSend(ADMIN, id).reason, 'do_not_contact', 'baseline');
    mutate(`   and (s.business_id = p_business_id
          or (s.contact_email is not null`, `   and ((false)
          or (s.contact_email is not null`);
    try { assert.equal(claimSend(ADMIN, id).ok, true, 'the mutation re-opens the business'); release(id); } finally { restore(); }
  });
  test('M5 even without the function\'s own reason check, the database constraint refuses a lift that has no reason (defence in depth)', () => {
    fresh(); const id = sendable(SHOP, SLUG); stop(ADMIN, id, 'requested'); assert.ok(isErr(resume(ADMIN, id, null), '22023'), 'baseline: the function refuses');
    mutate(`  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for removing the suppression' using errcode = '22023';
  end if;`, ``);
    try { const r = resume(ADMIN, id, null); assert.ok(isErr(r, '23514'), `the table's own check still refuses: ${r}`); assert.equal(activeCount(), 1, 'still suppressed'); } finally { restore(); }
  });
});

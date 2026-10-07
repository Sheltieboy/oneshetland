/**
 * launch-invite-lifecycle.node.test.ts — what happens to a private Launch Partner invitation link over its life, proved against the real SQL.
 *
 * Migration 20261114000000 changes ONE thing: the default lifetime of admin_issue_launch_invite is 30 days (it was 45, while the Admin screen and the email
 * said 30). Everything else here is the existing security model, pinned so that making the dead-link page friendlier cannot weaken it.
 *
 *   A  ONE canonical lifetime: 30 days by default; the bounds (1 hour to 120 days) and the body are otherwise an exact copy
 *   B  every dead link is INDISTINGUISHABLE: expired, revoked, replaced, random, malformed, wrong slug, unknown slug all give the same nothing from every public function
 *   C  nothing leaks: no business name or id, no slug, no campaign content, no newer token, in any answer to a dead link
 *   D  replacing: the old link dies at once, exactly one invitation is live, and the old one is KEPT as history ('superseded')
 *   E  expiring and re-issuing: an expired invitation stays as history; a fresh one works
 *   F  the uniqueness protections are intact (one live invitation per preview; one hash per token)
 *   G  who may call what is unchanged: anon may resolve / preview / record a view and nothing administrative
 *   H  the admin list tells the states apart from existing columns (open / expired / revoked / replaced / claim pending / claimed)
 *   I  claims, preview content and view recording behave as before for a VALID link
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
const OUTREACH = join(MIG, '20261113000000_launch_outreach_suppression.sql');
const FEATURE = join(MIG, '20261114000000_launch_invite_default_30_days.sql');
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
    src(OUTREACH),
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
const fresh = () => { reset(); raw(`alter table public.launch_outreach_suppressions disable trigger user; delete from public.launch_outreach_suppressions; alter table public.launch_outreach_suppressions enable trigger user; delete from public.launch_invites; delete from public.business_claims;`); };
const issueFor = (slug: string, biz: string, expires?: string) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}'${expires ? `, ${expires}` : ''})::jsonb`) as { token: string; expires_at: string; slug: string; business_id: string };
const resolveTok = (slug: string, tok: string | null) => rowsOf(asUser(null, `select coalesce(public.launch_invite_resolve(${tok === null ? 'null' : q(slug)}, ${tok === null ? 'null' : q(tok)})::text, 'NULL')`)).pop();
const resolveAs = (uid: string | null, slug: string, tok: string) => rowsOf(asUser(uid, `select coalesce(public.launch_invite_resolve('${slug}', ${q(tok)})::text, 'NULL')`)).pop();
const previewCfg = (slug: string, tok: string) => rowsOf(asUser(null, `select coalesce(public.launch_invite_preview_config('${slug}', ${q(tok)})::text, 'NULL')`)).pop();
const recordView = (slug: string, tok: string) => rowsOf(asUser(null, `select public.launch_invite_record_view('${slug}', ${q(tok)})::text`)).pop();
const claimState = (uid: string, slug: string, tok: string) => rowsOf(asUser(uid, `select coalesce(public.launch_invite_claim_state('${slug}', ${q(tok)})::text, 'NULL')`)).pop();
const submitClaim = (uid: string, slug: string, tok: string) => fn(uid, `public.submit_launch_partner_claim('${slug}', ${q(tok)}, 'Esther', 'esther@example.com', null, 'Owner', 'I run it')`);
const liveCount = (slug: string) => Number(scalar(`select count(*) from public.launch_invites where slug='${slug}' and revoked_at is null`));
const invRows = (slug: string) => JSON.parse(scalar(`select coalesce(jsonb_agg(jsonb_build_object('revoked', revoked_at is not null, 'reason', revoked_reason, 'expired', expires_at <= now()) order by created_at, id), '[]'::jsonb)::text from public.launch_invites where slug='${slug}'`)) as { revoked: boolean; reason: string | null; expired: boolean }[];
const expireNow = (slug: string) => raw(`update public.launch_invites set expires_at = now() - interval '1 minute', created_at = least(created_at, now() - interval '2 minutes') where slug='${slug}' and revoked_at is null`);
/** admin_list_launch_invites returns a TABLE; read it as JSON, as the administrator. */
const listInv = (): any[] => { const l = rowsOf(asUser(ADMIN, `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from public.admin_list_launch_invites() t`)); return JSON.parse(l[l.length - 1]); };
const days = (slug: string) => Number(scalar(`select round(extract(epoch from (expires_at - created_at)) / 86400.0, 2) from public.launch_invites where slug='${slug}' and revoked_at is null`));
/** 30 CALENDAR days can be 30 days plus an hour across a clock change; the lifetime is checked to the hour. */
const about = (n: number, target: number) => Math.abs(n - target) < 0.05;
const NOTE_BIZ = 'Voe Gift Shop';

/** A sendable campaign with a stored preview, so preview_config / record_view have something real to guard. */
function campaign(biz = SHOP, slug = SLUG) {
  raw(`update public.local_businesses set is_active=true where id='${biz}'`);
  const id = mk(biz, slug);
  assert.ok(!isErr(upd(id, { preview_config: { slug, businessName: NOTE_BIZ, tagline: 'SECRET-CAMPAIGN-CONTENT-4d1a' }, page_config: { version: 1, hero: { tagline: 'prepared', image: { src: 'https://s.example/p.png', alt: 'p' } } } })));
  A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
  return id;
}
/** Every public-function answer for one (slug, token): the thing an attacker or a stale link would see. */
const publicAnswers = (slug: string, tok: string | null) => JSON.stringify({
  resolve: resolveTok(slug, tok), preview: tok === null ? 'NULL' : previewCfg(slug, tok), view: tok === null ? 'false' : recordView(slug, tok), state: tok === null ? 'NULL' : claimState(EVE, slug, tok),
});

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · one canonical lifetime: 30 days', () => {
  test('with no expiry given, an invitation lasts 30 days (it was 45)', () => {
    fresh(); campaign(); const inv = issueFor(SLUG, SHOP);
    assert.ok(about(days(SLUG), 30), `lifetime was ${days(SLUG)} days`); assert.ok(inv.token);
    assert.match(scalar(`select (regexp_match(pg_get_functiondef('public.admin_issue_launch_invite(text,uuid,timestamptz)'::regprocedure), 'DEFAULT \\(now\\(\\) \\+ ''(\\d+) days''::interval\\)'))[1]`), /^30$/);
  });
  test('an explicit expiry is still honoured, and the bounds are unchanged: under an hour and over 120 days are refused', () => {
    fresh(); campaign();
    const inv = issueFor(SLUG, SHOP, `now() + interval '10 days'`); assert.ok(Math.abs((new Date(inv.expires_at).getTime() - Date.now()) / 864e5 - 10) < 0.05);
    for (const bad of [`now() + interval '30 minutes'`, `now() + interval '121 days'`, 'null']) assert.ok(isErr(A(`public.admin_issue_launch_invite('${SLUG}', '${SHOP}', ${bad})::jsonb`), '22023'), bad);
    assert.equal(issueFor(SLUG, SHOP, `now() + interval '120 days'`).slug, SLUG);
  });
  test('the new function is an EXACT copy of the old one apart from the default (same checks, same revocation rule, same token handling)', () => {
    const fnText = (file: string) => { const t = src(file); const a = t.indexOf('create or replace function public.admin_issue_launch_invite('); const b = t.indexOf('$$;', t.indexOf('as $$', a)) + 3; return t.slice(a, b).replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim(); };
    assert.equal(fnText(FEATURE), fnText(CLAIMS).replace("interval '45 days'", "interval '30 days'"));
    assert.ok(fnText(CLAIMS).includes("interval '45 days'"), 'the old default really was 45');
  });
  test('the migration changes nothing but that function: no table, no other function, no data outside the invitation it manages, and it can be applied twice', () => {
    const text = src(FEATURE).replace(/--.*$/gm, '');
    assert.equal((text.match(/create or replace function/gi) ?? []).length, 1); assert.doesNotMatch(text, /\b(create|alter|drop)\s+(table|index|trigger|policy)\b|\bdelete\b|\btruncate\b/i);
    const dml = [...text.matchAll(/\b(insert\s+into|update)\s+(public\.[a-z_]+)/gi)].map((m) => `${m[1].toLowerCase().replace(/\s+/g, ' ')} ${m[2]}`).sort();
    assert.deepEqual(dml, ['insert into public.launch_invites', 'update public.launch_invites'], 'only the invitation it issues (and the one it replaces)');
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
  });
  test('the function is still administrators-only and anon cannot execute it', () => {
    fresh(); campaign();
    for (const u of [ALICE, EVE, BOB, CAROL]) assert.ok(isErr(fn(u, `public.admin_issue_launch_invite('${SLUG}', '${SHOP}')`), '42501'), u);
    assert.equal(scalar(`select has_function_privilege('anon', 'public.admin_issue_launch_invite(text,uuid,timestamptz)', 'execute')`), 'f');
    assert.equal(liveCount(SLUG), 0);
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · every dead link is indistinguishable', () => {
  test('1 · a valid active link opens: the business id, the preview content, a recorded view', () => {
    fresh(); campaign(); const inv = issueFor(SLUG, SHOP);
    assert.equal(resolveTok(SLUG, inv.token), SHOP); assert.match(previewCfg(SLUG, inv.token), /SECRET-CAMPAIGN-CONTENT-4d1a/); assert.equal(recordView(SLUG, inv.token), 'true');
  });
  test('2–6 · expired, revoked, replaced, random, malformed and wrong-slug tokens ALL give exactly the same answers from every public function', () => {
    fresh(); campaign(); campaign(CAFE, 'harbour-cafe');
    const expired = issueFor(SLUG, SHOP); expireNow(SLUG);
    const revoked = issueFor('harbour-cafe', CAFE); A(`public.admin_revoke_launch_invite('harbour-cafe', 'because')`);
    const replacedOld = issueFor(SLUG, SHOP); issueFor(SLUG, SHOP);                                  // the first of these is replaced by the second
    const cases: [string, string, string | null][] = [
      ['expired', SLUG, expired.token], ['revoked', 'harbour-cafe', revoked.token], ['replaced', SLUG, replacedOld.token],
      ['random 64-hex', SLUG, 'ab'.repeat(32)], ['random base64url', SLUG, 'Q'.repeat(60)],
      ['too short', SLUG, 'abc'], ['bad characters', SLUG, 'x'.repeat(39) + '!'], ['SQL-ish', SLUG, `' or 1=1 --${'a'.repeat(40)}`], ['too long', SLUG, 'a'.repeat(200)], ['empty', SLUG, ''], ['null', SLUG, null],
      ['right token, wrong slug', 'harbour-cafe', replacedOld.token], ['unknown slug', 'no-such-preview', 'ab'.repeat(32)], ['malformed slug', 'BAD SLUG!!', 'ab'.repeat(32)],
    ];
    const answers = cases.map(([name, slug, tok]) => [name, publicAnswers(slug, tok)] as const);
    const nothing = JSON.stringify({ resolve: 'NULL', preview: 'NULL', view: 'false', state: 'NULL' });
    for (const [name, a] of answers) assert.equal(a, nothing, `${name} must look exactly like "nothing"`);
    assert.equal(new Set(answers.map(([, a]) => a)).size, 1, 'all dead links are indistinguishable');
  });
  test('7 · a dead link cannot be used to claim: the claim is refused with the same plain error, whatever the reason it is dead', () => {
    fresh(); campaign();
    const expired = issueFor(SLUG, SHOP); expireNow(SLUG); const old = issueFor(SLUG, SHOP); const newer = issueFor(SLUG, SHOP); void newer;
    const errs = [expired.token, old.token, 'ab'.repeat(32), 'short'].map((t) => String(submitClaim(ALICE, SLUG, t)).replace(/\s+/g, ' '));
    assert.equal(new Set(errs).size, 1, errs.join(' | ')); assert.ok(isErr(errs[0]));
    assert.equal(Number(scalar(`select count(*) from public.business_claims`)), 0, 'no claim was created');
  });
  test('a dead link leaves no trace: no view is recorded and nothing is written', () => {
    fresh(); const id = campaign(); const inv = issueFor(SLUG, SHOP); expireNow(SLUG);
    const before = scalar(`select md5(to_jsonb(c)::text) from public.launch_partner_campaigns c where id='${id}'`); const events = eventKinds(id);
    for (const t of [inv.token, 'ab'.repeat(32), 'x']) { recordView(SLUG, t); previewCfg(SLUG, t); resolveTok(SLUG, t); }
    assert.equal(scalar(`select md5(to_jsonb(c)::text) from public.launch_partner_campaigns c where id='${id}'`), before); assert.equal(eventKinds(id), events);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · nothing leaks to a dead link', () => {
  test('8–10 · no business name or id, no slug, no campaign content, and no newer token or hash appears in any answer to a dead link', () => {
    fresh(); campaign(); const old = issueFor(SLUG, SHOP); const newer = issueFor(SLUG, SHOP);
    const hashOfNew = scalar(`select token_hash from public.launch_invites where slug='${SLUG}' and revoked_at is null`);
    const text = [publicAnswers(SLUG, old.token), publicAnswers(SLUG, 'ab'.repeat(32)), publicAnswers('harbour-cafe', old.token), asUser(null, `select public.launch_invite_resolve('${SLUG}', '${old.token}')`), asUser(EVE, `select public.launch_invite_claim_state('${SLUG}', '${old.token}')`)].join('\n');
    for (const secret of [NOTE_BIZ, SHOP, 'SECRET-CAMPAIGN-CONTENT-4d1a', newer.token, hashOfNew, 'superseded', 'revoked', 'expired']) assert.ok(!text.includes(secret), `leaked: ${secret}`);
    assert.doesNotMatch(text, /ERROR/, 'and no error text that could be told apart');
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · replacing an invitation', () => {
  test('22 · the old link dies the moment a new one is issued; exactly one invitation is live', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP); assert.equal(resolveTok(SLUG, a.token), SHOP); const b = issueFor(SLUG, SHOP);
    assert.equal(resolveTok(SLUG, a.token), 'NULL'); assert.equal(resolveTok(SLUG, b.token), SHOP); assert.equal(liveCount(SLUG), 1); assert.notEqual(a.token, b.token);
  });
  test('the replaced invitation is KEPT as history, marked superseded — never deleted or reused', () => {
    fresh(); campaign(); issueFor(SLUG, SHOP); issueFor(SLUG, SHOP); issueFor(SLUG, SHOP);
    const rows = invRows(SLUG); assert.equal(rows.length, 3); assert.deepEqual(rows.map((r) => r.revoked), [true, true, false]); assert.deepEqual(rows.map((r) => r.reason), ['superseded by a new invitation', 'superseded by a new invitation', null]);
  });
  test('a replaced link does not point at the new one: the old token resolves to nothing, not to the new business link or a redirect hint', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP); issueFor(SLUG, SHOP);
    assert.equal(publicAnswers(SLUG, a.token), JSON.stringify({ resolve: 'NULL', preview: 'NULL', view: 'false', state: 'NULL' }));
  });
  test('a claim already bound to the old invitation is not affected by its replacement (the claim is the claimant\'s, the link was only the door)', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP); assert.equal(submitClaim(ALICE, SLUG, a.token).state, 'pending'); issueFor(SLUG, SHOP);
    assert.equal(scalar(`select count(*) from public.business_claims where business_id='${SHOP}' and status='pending'`), '1');
  });
  test('two concurrent issues leave exactly one live invitation', async () => {
    fresh(); campaign();
    const one = () => new Promise<string>((res) => { const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-c', `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; select (public.admin_issue_launch_invite('${SLUG}', '${SHOP}'))::text; commit;`]); let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', () => res(o)); });
    await Promise.all([one(), one()]); assert.equal(liveCount(SLUG), 1);
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · expiry', () => {
  test('an expired link is dead; the expired row stays as history; issuing again creates a fresh working invitation', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP); expireNow(SLUG); assert.equal(resolveTok(SLUG, a.token), 'NULL');
    const b = issueFor(SLUG, SHOP); assert.equal(resolveTok(SLUG, b.token), SHOP); assert.equal(resolveTok(SLUG, a.token), 'NULL');
    const rows = invRows(SLUG); assert.equal(rows.length, 2); assert.equal(rows[0].expired, true); assert.equal(rows[0].revoked, true, 'the old one is closed out, not left dangling'); assert.equal(rows[1].revoked, false);
  });
  test('a link is alive right up to its expiry and dead after it', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP, `now() + interval '2 hours'`);
    assert.equal(resolveTok(SLUG, a.token), SHOP); raw(`update public.launch_invites set expires_at = now() - interval '1 second', created_at = now() - interval '3 hours' where slug='${SLUG}'`); assert.equal(resolveTok(SLUG, a.token), 'NULL');
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · the uniqueness protections are intact', () => {
  test('23 · the database refuses a second LIVE invitation for a preview, and a repeated token hash', () => {
    fresh(); campaign(); issueFor(SLUG, SHOP);
    const hash = scalar(`select token_hash from public.launch_invites where slug='${SLUG}' and revoked_at is null`);
    assert.ok(isErr(raw(`insert into public.launch_invites (slug, business_id, token_hash) values ('${SLUG}', '${SHOP}', '${'c'.repeat(64)}')`), '23505'), 'one live per slug');
    assert.ok(isErr(raw(`insert into public.launch_invites (slug, business_id, token_hash, revoked_at) values ('${SLUG}', '${SHOP}', '${hash}', now())`), '23505'), 'one hash per token');
    assert.equal(scalar(`select count(*) from pg_indexes where indexname in ('launch_invites_live_slug_uq','launch_invites_token_uq')`), '2');
  });
  test('only a hash is stored; the token appears nowhere in the table', () => {
    fresh(); campaign(); const a = issueFor(SLUG, SHOP);
    assert.equal(scalar(`select count(*) from public.launch_invites where to_jsonb(launch_invites)::text like '%${a.token}%'`), '0');
    assert.equal(scalar(`select count(*) from public.launch_invites where token_hash = encode(sha256(convert_to('${a.token}','utf8')),'hex')`), '1');
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · who may call what is unchanged', () => {
  test('anon may resolve, read a preview and record a view — and nothing administrative; the internal finder is for nobody', () => {
    const can = (r: string, f: string) => scalar(`select has_function_privilege('${r}', '${f}', 'execute')`);
    for (const f of ['public.launch_invite_resolve(text,text)', 'public.launch_invite_preview_config(text,text)', 'public.launch_invite_record_view(text,text)']) assert.equal(can('anon', f), 't', f);
    for (const f of ['public.admin_issue_launch_invite(text,uuid,timestamptz)', 'public.admin_revoke_launch_invite(text,text)', 'public.admin_list_launch_invites()', 'public.launch_invite_claim_state(text,text)', 'public.submit_launch_partner_claim(text,text,text,text,text,text,text)']) assert.equal(can('anon', f), 'f', f);
    for (const r of ['anon', 'authenticated']) assert.equal(can(r, 'public._launch_invite_find(text,text,boolean)'), 'f', `${r} finder`);
    assert.ok(isErr(asUser(null, `select * from public.launch_invites`), '42501'));
    for (const u of [ALICE, EVE]) assert.ok(isErr(asUser(u, `select * from public.admin_list_launch_invites()`), '42501'), `${u} list`);
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · the admin list tells the states apart, from existing columns', () => {
  test('open · expired · revoked · replaced (revoked with the "superseded" reason) · claim pending · claimed', () => {
    fresh(); campaign(); campaign(CAFE, 'harbour-cafe'); campaign(OTHERBIZ, SLUG2);
    issueFor(SLUG, SHOP); issueFor(SLUG, SHOP);                                              // one replaced, one open
    issueFor('harbour-cafe', CAFE); A(`public.admin_revoke_launch_invite('harbour-cafe', 'sent to the wrong person')`);   // revoked by hand
    const c = issueFor(SLUG2, OTHERBIZ); expireNow(SLUG2); void c;                           // expired
    const rows = listInv();
    const find = (slug: string) => rows.filter((r) => r.slug === slug).map((r) => ({ status: r.status, reason: r.revoked_reason }));
    assert.deepEqual(find(SLUG), [{ status: 'open', reason: null }, { status: 'revoked', reason: 'superseded by a new invitation' }]);
    assert.deepEqual(find('harbour-cafe'), [{ status: 'revoked', reason: 'sent to the wrong person' }]);
    assert.deepEqual(find(SLUG2), [{ status: 'expired', reason: null }]);
    const live = issueFor(SLUG, SHOP); assert.equal(submitClaim(ALICE, SLUG, live.token).state, 'pending');
    assert.equal(listInv().find((r) => r.slug === SLUG && !r.revoked_at).status, 'claim pending');
    approveClaim(SHOP); assert.equal(listInv().find((r) => r.slug === SLUG && !r.revoked_at).status, 'claimed');
  });
  test('an administrator can still see exactly why an old invitation is dead; nobody else can see any of it', () => {
    fresh(); campaign(); issueFor(SLUG, SHOP); issueFor(SLUG, SHOP);
    assert.equal(listInv().filter((r) => r.slug === SLUG && r.revoked_reason).length, 1);
    for (const u of [ALICE, EVE]) assert.ok(isErr(asUser(u, `select * from public.admin_list_launch_invites()`), '42501'), String(u));
    assert.equal(scalar(`select has_function_privilege('anon', 'public.admin_list_launch_invites()', 'execute')`), 'f');
  });
});

// ═══ I ═════════════════════════════════════════════════════════════════════
describe('I · a VALID link behaves exactly as before', () => {
  test('a valid link: preview, view recorded, claim state, claim submitted, bound to its first account; a second account sees invite_used', () => {
    fresh(); const id = campaign(); const a = issueFor(SLUG, SHOP);
    assert.equal(recordView(SLUG, a.token), 'true'); assert.equal(JSON.parse(claimState(ALICE, SLUG, a.token)).state, 'open');
    assert.equal(submitClaim(ALICE, SLUG, a.token).state, 'pending'); assert.equal(JSON.parse(claimState(ALICE, SLUG, a.token)).state, 'pending');
    assert.equal(JSON.parse(claimState(BOB, SLUG, a.token)).state, 'invite_used');
    assert.ok(Number(scalar(`select view_count from public.launch_partner_campaigns where id='${id}'`)) >= 1);
  });
  test('19–21/16 · the I3 safeguards are untouched by this migration: the do-not-contact gate still refuses, and the send reservation is the same function', () => {
    fresh(); const id = campaign(); A(`public.admin_launch_partner_update('${id}', ${jb({ contact_email: 'a@b.test', email_subject: 's', email_body: 'b {{INVITATION_CTA}}', email_opening: 'o' })})`);
    A(`public.admin_launch_partner_stop_outreach('${id}', 'requested', null)`);
    assert.equal(fn(ADMIN, `public.admin_launch_partner_claim_send('${id}')`).reason, 'do_not_contact');
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
describe('K · mutation — the canonical default is load-bearing', () => {
  const original = src(FEATURE);
  after(() => { assert.doesNotMatch(raw(original), /ERROR/i); });
  test('if the default drifted back to 45 days, the lifetime test would catch it', () => {
    fresh(); campaign(); issueFor(SLUG, SHOP); assert.ok(about(days(SLUG), 30), 'baseline');
    assert.doesNotMatch(raw(original.replace("interval '30 days'", "interval '45 days'")), /ERROR/i);
    try { fresh(); campaign(); issueFor(SLUG, SHOP); assert.ok(about(days(SLUG), 45), 'the mutation really changes the lifetime'); assert.ok(!about(days(SLUG), 30)); } finally { raw(original); }
  });
});

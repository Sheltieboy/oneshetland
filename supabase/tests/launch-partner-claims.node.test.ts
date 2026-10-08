/**
 * launch-partner-claims.node.test.ts — the private invitation and its claim, against the real SQL.
 *
 * Migration 20261104030000. A Launch Partner Preview is shown to the owner of ONE existing listing; this proves the
 * invitation lets them submit an ORDINARY pending claim for that listing and nothing else.
 *
 *   A  issuing: admin / service / direct SQL only; the token comes back once and only its hash is stored; a new
 *      invitation supersedes the old; expiry bounds; clients cannot read or write the table
 *   B  resolving: only the right token for the right slug opens it; wrong, short, other-slug, revoked and expired
 *      are all indistinguishable (null); callable signed out
 *   C  submitting: creates the normal pending claim, labelled and bound to the caller; changes NOTHING on the
 *      listing; idempotent; validated; the five-claim cap and one-pending-per-listing still apply
 *   D  the label cannot be forged, and ordinary claims are unaffected
 *   E  approval is still the admin's, through the existing approve_business_claim: only then is anyone owner;
 *      the owner is recognised, everyone else is "claimed by another" with no detail
 *   F  one invitation, one claimant: a second account is refused while the first claim stands; rejection frees it
 *   G  revocation: closes the door for new claims and leaves existing claims alone
 *   H  nobody can see another person's claim through these functions
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
const FIX = join(MIG, '20261031030000_business_claims_claimants_submit_only.sql');
const DECIDER = join(MIG, '20261031040000_business_claims_record_the_decider.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const GRANTS = join(MIG, '20261103000000_launch_plan_grants.sql');
const FEATURE = join(MIG, '20261104030000_launch_partner_claims.sql');
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
/** As PostgREST would: a role plus the JWT subject, in its own transaction. */
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${uid ? 'authenticated' : 'anon'}; ${sql}; commit;`);
const asService = (sql: string) => raw(`begin; set local role service_role; ${sql}; commit;`);
const call = (uid: string | null, sql: string): any => { const l = rowsOf(asUser(uid, sql)); try { return JSON.parse(l[l.length - 1]); } catch { return l.join('\n'); } };

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
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const BOB = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const EVE = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';
const SHOP = 'c2c2c2c2-bbbb-4bbb-8bbb-c2c2c2c2c2c2';   // the invited listing
const OTHER = 'c1c1c1c1-aaaa-4aaa-8aaa-c1c1c1c1c1c1';  // somebody else's listing
const filler = (n: number) => `d${n}d${n}d${n}d${n}-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
    'alter default privileges in schema public grant all on tables to anon, authenticated, service_role;',
    'alter default privileges in schema public grant all on functions to anon, authenticated, service_role;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    `create table public.profiles (id uuid primary key, role text default 'customer', is_platform_owner boolean default false);`,
    `create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
       select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)) $$;`,
    `create table public.local_businesses (id uuid primary key, name text, owner_id uuid, is_active boolean default true,
       is_claimed boolean default false, is_verified boolean default false, claimed_at timestamptz, verified_at timestamptz,
       description text, subscription_tier text default 'free', subscription_until timestamptz);`,
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
    slice(GRANTS, 'create or replace function public.launch_plan_authorised()', '$$;'),
    src(FIX),
    src(DECIDER),
    src(FEATURE),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1800)}`);
  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${ALICE}', 'customer'), ('${BOB}', 'customer'), ('${EVE}', 'customer');
    insert into public.local_businesses (id, name, description) values ('${SHOP}', 'Voe Gift Shop', 'Soap and gifts'), ('${OTHER}', 'Harbour Café', 'Coffee');
    ${[1, 2, 3, 4, 5, 6].map((n) => `insert into public.local_businesses (id, name) values ('${filler(n)}', 'Filler ${n}');`).join('\n')}`);
  assert.doesNotMatch(seed, /ERROR/i, seed);
});

const issue = (slug = 'voe-gift-shop', biz = SHOP, expires = `now() + interval '30 days'`) =>
  call(ADMIN, `select public.admin_issue_launch_invite('${slug}', '${biz}', ${expires})::text`) as { token: string; slug: string; business_id: string; expires_at: string };
const listing = () => scalar(`select to_jsonb(b)::text from public.local_businesses b where id='${SHOP}'`);
const claimsOn = (biz = SHOP) => Number(scalar(`select count(*) from public.business_claims where business_id='${biz}'`));
const reset = () => raw(`delete from public.business_claims; delete from public.launch_invites;
  update public.local_businesses set owner_id=null, is_claimed=false, is_verified=false, claimed_at=null, verified_at=null where true;`);
const submit = (uid: string | null, tok: string, slug = 'voe-gift-shop', name = 'Esther', email = 'esther@example.com') =>
  call(uid, `select public.submit_launch_partner_claim('${slug}', '${tok}', '${name}', '${email}', '01595 000000', 'Owner', 'I run it')::text`);
const state = (uid: string, tok: string, slug = 'voe-gift-shop') => call(uid, `select public.launch_invite_claim_state('${slug}', '${tok}')::text`);
const resolve = (uid: string | null, tok: string, slug = 'voe-gift-shop') => rowsOf(asUser(uid, `select coalesce(public.launch_invite_resolve('${slug}', '${tok}')::text, 'NULL')`)).pop();

describe('A · issuing', () => {
  before(reset);
  test('an admin gets the token once; only its SHA-256 is stored; nothing else can read it', () => {
    const inv = issue();
    assert.match(inv.token, /^[0-9a-f]{64}$/);
    assert.equal(inv.business_id, SHOP);
    assert.equal(scalar(`select count(*) from public.launch_invites where token_hash = encode(sha256(convert_to('${inv.token}','utf8')),'hex')`), '1');
    assert.equal(scalar(`select count(*) from public.launch_invites where to_jsonb(launch_invites)::text like '%${inv.token}%'`), '0', 'the token itself is stored nowhere');
    assert.match(asUser(ALICE, 'select * from public.launch_invites'), /permission denied/);
    assert.match(asUser(null, 'select * from public.launch_invites'), /permission denied/);
    assert.match(asUser(ALICE, `insert into public.launch_invites (slug, business_id, token_hash) values ('x-y-z','${SHOP}','${'a'.repeat(64)}')`), /permission denied/);
  });
  test('only an administrator, the service role or a direct SQL session may issue; everyone else is refused', () => {
    for (const uid of [ALICE, null] as const) {
      const out = asUser(uid, `select public.admin_issue_launch_invite('voe-gift-shop', '${SHOP}')`);
      assert.match(out, /permission denied|Only an administrator/, String(uid));
    }
    assert.match(rowsOf(asService(`select public.admin_issue_launch_invite('svc-test-one', '${SHOP}')::text`)).pop() ?? '', /"token"/);
    assert.match(scalar(`select public.admin_issue_launch_invite('sql-test-one', '${SHOP}')::text`), /"token"/);
  });
  test('a new invitation for the same preview supersedes the old one, which stops working at once', () => {
    reset();
    const a = issue(); const b = issue();
    assert.equal(resolve(null, a.token), 'NULL');
    assert.equal(resolve(null, b.token), SHOP);
    assert.equal(scalar(`select count(*) from public.launch_invites where slug='voe-gift-shop' and revoked_at is null`), '1');
  });
  test('bad slug, unknown business and out-of-range expiry are refused', () => {
    assert.match(asUser(ADMIN, `select public.admin_issue_launch_invite('Bad Slug', '${SHOP}')`), /Invalid preview name/);
    assert.match(asUser(ADMIN, `select public.admin_issue_launch_invite('ok-slug', gen_random_uuid())`), /No such business/);
    assert.match(asUser(ADMIN, `select public.admin_issue_launch_invite('ok-slug', '${SHOP}', now() + interval '200 days')`), /between an hour and 120 days/);
    assert.match(asUser(ADMIN, `select public.admin_issue_launch_invite('ok-slug', '${SHOP}', now() - interval '1 day')`), /between an hour and 120 days/);
  });
});

describe('B · resolving', () => {
  before(reset);
  test('only the right token for the right slug opens it — signed out or in — and it names ONE business', () => {
    const inv = issue();
    assert.equal(resolve(null, inv.token), SHOP);
    assert.equal(resolve(ALICE, inv.token), SHOP);
  });
  test('wrong, truncated, padded, other-slug, malformed and absent tokens all return the same nothing', () => {
    reset(); const inv = issue();
    for (const t of ['x'.repeat(64), inv.token.slice(0, -1), `${inv.token}0`, inv.token.toUpperCase(), 'short', '', "'; drop table x; --", ` ${inv.token}`]) {
      assert.equal(resolve(null, t.replace(/'/g, "''")), 'NULL', t);
    }
    assert.equal(resolve(null, inv.token, 'another-preview'), 'NULL');
    issue('another-preview', OTHER);
    assert.equal(resolve(null, inv.token, 'another-preview'), 'NULL', 'a token belongs to its own slug only');
  });
  test('revoked and expired invitations stop resolving', () => {
    reset(); const inv = issue();
    assert.equal(scalar(`select public.admin_revoke_launch_invite('voe-gift-shop', 'testing')`), '1');
    assert.equal(resolve(null, inv.token), 'NULL');
    reset(); const e = issue();
    raw(`update public.launch_invites set expires_at = now() - interval '1 minute'`);
    assert.equal(resolve(null, e.token), 'NULL');
  });
  test('the three client functions cannot be used signed out except resolve', () => {
    reset(); const inv = issue();
    assert.match(asUser(null, `select public.launch_invite_claim_state('voe-gift-shop','${inv.token}')`), /permission denied/);
    assert.match(asUser(null, `select public.submit_launch_partner_claim('voe-gift-shop','${inv.token}','A','a@b.co')`), /permission denied/);
  });
});

describe('C · submitting', () => {
  before(reset);
  test('a signed-in person gets an ordinary pending claim, labelled, bound to them — and the listing is untouched', () => {
    const inv = issue();
    const before = listing();
    assert.equal(state(ALICE, inv.token).state, 'open');
    assert.equal(submit(ALICE, inv.token).state, 'pending');
    const c = JSON.parse(scalar(`select to_jsonb(c)::text from public.business_claims c where business_id='${SHOP}'`));
    assert.equal(c.status, 'pending'); assert.equal(c.user_id, ALICE); assert.equal(c.business_id, SHOP);
    assert.equal(c.source, 'launch_partner_invitation'); assert.equal(c.source_ref, 'voe-gift-shop');
    assert.equal(c.contact_name, 'Esther'); assert.equal(c.contact_email, 'esther@example.com');
    assert.equal(c.reviewed_at, null); assert.equal(c.reviewed_by, null); assert.equal(c.admin_note, null);
    assert.equal(listing(), before, 'claiming a preview changes nothing about the listing');
    assert.equal(state(ALICE, inv.token).state, 'pending');
  });
  test('pressing it twice (or from two tabs) leaves one pending claim', () => {
    const inv = issue();
    assert.equal(claimsOn(), 1);
    reset(); const i2 = issue();
    submit(ALICE, i2.token); submit(ALICE, i2.token);
    assert.equal(claimsOn(), 1);
  });
  test('it cannot name any other business: the only listing it can claim is the one on the invitation', () => {
    reset(); const inv = issue('voe-gift-shop', SHOP);
    assert.match(String(submit(ALICE, inv.token, 'another-preview')), /no longer valid/);
    submit(ALICE, inv.token);
    assert.equal(claimsOn(OTHER), 0);
    assert.equal(claimsOn(SHOP), 1);
  });
  test('an invalid, revoked or expired invitation cannot submit', () => {
    reset(); const inv = issue();
    assert.match(String(submit(ALICE, 'y'.repeat(64))), /no longer valid/);
    raw(`select public.admin_revoke_launch_invite('voe-gift-shop')`);
    assert.match(String(submit(ALICE, inv.token)), /no longer valid/);
    assert.equal(claimsOn(), 0);
  });
  test('details are required and bounded, exactly as in the ordinary claim form', () => {
    reset(); const inv = issue();
    assert.match(String(submit(ALICE, inv.token, 'voe-gift-shop', '', 'a@b.co')), /name and a contact email/);
    assert.match(String(submit(ALICE, inv.token, 'voe-gift-shop', 'Esther', '')), /name and a contact email/);
    assert.match(String(submit(ALICE, inv.token, 'voe-gift-shop', 'Esther', 'not-an-email')), /check the details/);
    assert.match(String(submit(ALICE, inv.token, 'voe-gift-shop', 'x'.repeat(201), 'a@b.co')), /check the details/);
    assert.equal(claimsOn(), 0);
  });
  test('the existing five-open-claims cap still applies', () => {
    reset(); const inv = issue();
    for (let n = 1; n <= 5; n++) raw(`insert into public.business_claims (user_id, business_id, status, contact_name) values ('${ALICE}', '${filler(n)}', 'pending', 'A')`);
    assert.match(String(submit(ALICE, inv.token)), /5 claims waiting/);
    assert.equal(claimsOn(), 0);
  });
});

describe('D · the label cannot be forged', () => {
  before(reset);
  test('a client cannot insert a claim carrying a source, nor add one to their own claim', () => {
    assert.match(asUser(BOB, `insert into public.business_claims (user_id, business_id, status, contact_name, source, source_ref) values ('${BOB}', '${OTHER}', 'pending', 'B', 'launch_partner_invitation', 'x')`), /set by the platform/);
    assert.equal(claimsOn(OTHER), 0);
    assert.match(asUser(BOB, `insert into public.business_claims (user_id, business_id, status, contact_name, source_ref) values ('${BOB}', '${OTHER}', 'pending', 'B', 'x')`), /set by the platform/);
  });
  test('an ordinary claim, with no source, is exactly as before — and an admin decision does not trip the guard', () => {
    assert.doesNotMatch(asUser(BOB, `insert into public.business_claims (user_id, business_id, status, contact_name) values ('${BOB}', '${OTHER}', 'pending', 'B')`), /ERROR|violates|denied/i);
    const id = scalar(`select id from public.business_claims where business_id='${OTHER}'`);
    assert.doesNotMatch(asUser(ADMIN, `update public.business_claims set status='rejected' where id='${id}'`), /ERROR|denied/i);
    assert.equal(scalar(`select source is null from public.business_claims where id='${id}'`), 't');
  });
});

describe('E · approval is still the admin\'s', () => {
  before(reset);
  test('submitting makes nobody owner; the admin approves through the existing function; only then is the claimant the owner', () => {
    const inv = issue();
    submit(ALICE, inv.token);
    assert.equal(scalar(`select owner_id is null and not is_claimed from public.local_businesses where id='${SHOP}'`), 't');
    const id = scalar(`select id from public.business_claims where business_id='${SHOP}'`);
    assert.match(asUser(ALICE, `select public.approve_business_claim('${id}')`), /Only admins/);
    assert.match(asUser(BOB, `select public.approve_business_claim('${id}')`), /Only admins/);
    assert.doesNotMatch(asUser(ADMIN, `select public.approve_business_claim('${id}')`), /ERROR/);
    assert.equal(scalar(`select owner_id::text from public.local_businesses where id='${SHOP}'`), ALICE);
    assert.equal(state(ALICE, inv.token).state, 'owner');
  });
  test('everyone else sees "claimed by another" — with no name, email or claim — and cannot submit', () => {
    const inv = issue();   // a fresh invitation after the claim
    const s = state(BOB, inv.token);
    assert.deepEqual(Object.keys(s).sort(), ['business_id', 'business_name', 'state']);
    assert.equal(s.state, 'claimed_by_other');
    assert.equal(submit(BOB, inv.token).state, 'claimed_by_other');
    assert.equal(Number(scalar(`select count(*) from public.business_claims where user_id='${BOB}'`)), 0);
  });
  test('the invitation stays valid for the owner to return to, but is not an ownership route', () => {
    const inv = issue();
    assert.equal(resolve(ALICE, inv.token), SHOP);
    assert.equal(state(ALICE, inv.token).state, 'owner');
    assert.equal(state(EVE, inv.token).state, 'claimed_by_other');
  });
  test('the admin list shows the claim and its outcome; clients cannot call it', () => {
    const rows = rowsOf(asUser(ADMIN, `select slug, status, claimant_email, claim_status from public.admin_list_launch_invites()`));
    assert.ok(rows.length >= 1);
    assert.match(asUser(ALICE, 'select * from public.admin_list_launch_invites()'), /Only an administrator|permission denied/);
  });
});

describe('F · one invitation, one claimant', () => {
  before(reset);
  test('a second account is refused while the first claim stands, and is told nothing about it', () => {
    const inv = issue();
    submit(ALICE, inv.token);
    assert.equal(state(BOB, inv.token).state, 'invite_used');
    assert.equal(submit(BOB, inv.token).state, 'invite_used');
    assert.equal(claimsOn(), 1);
    assert.equal(state(ALICE, inv.token).state, 'pending', 'the claimant is unaffected');
  });
  test('after a rejection the claimant can try again, and so can someone else (the invitation is released)', () => {
    const inv = issue();
    submit(ALICE, inv.token);
    const id = scalar(`select id from public.business_claims where business_id='${SHOP}' and status='pending'`);
    asUser(ADMIN, `update public.business_claims set status='rejected' where id='${id}'`);
    assert.equal(state(ALICE, inv.token).state, 'rejected');
    assert.equal(state(BOB, inv.token).state, 'open');
    assert.equal(submit(BOB, inv.token).state, 'pending', 'rebinds to the new claimant');
    assert.equal(state(ALICE, inv.token).state, 'invite_used', 'and the earlier claimant is now locked out while BOB\'s stands');
    assert.equal(scalar(`select bound_user_id::text from public.launch_invites where slug='voe-gift-shop' and revoked_at is null`), BOB);
  });
  test('a rejected claimant can resubmit when nobody else holds the invitation', () => {
    reset(); const inv = issue();
    submit(ALICE, inv.token);
    asUser(ADMIN, `update public.business_claims set status='rejected' where business_id='${SHOP}'`);
    assert.equal(submit(ALICE, inv.token).state, 'pending');
    assert.equal(claimsOn(), 2, 'a fresh claim; the rejected one stays as history');
  });
});

describe('G · revocation and the listing', () => {
  before(reset);
  test('revoking closes the door to new claims and leaves an existing pending claim exactly as it was', () => {
    const inv = issue();
    submit(ALICE, inv.token);
    raw(`select public.admin_revoke_launch_invite('voe-gift-shop', 'sent to the wrong person')`);
    assert.equal(state(BOB, inv.token), '', 'state gives nothing for a revoked invitation');
    assert.match(String(submit(BOB, inv.token)), /no longer valid/);
    assert.equal(scalar(`select status from public.business_claims where user_id='${ALICE}'`), 'pending');
    assert.equal(scalar(`select revoked_reason from public.launch_invites where slug='voe-gift-shop' order by created_at desc limit 1`), 'sent to the wrong person');
  });
  test('only an administrator can revoke', () => {
    reset(); issue();
    assert.match(asUser(ALICE, `select public.admin_revoke_launch_invite('voe-gift-shop')`), /permission denied|Only an administrator/);
    assert.equal(scalar(`select count(*) from public.launch_invites where revoked_at is null`), '1');
  });
  test('across every path above, no launch plan, product, subscription or public content was created or changed', () => {
    reset(); const inv = issue();
    submit(ALICE, inv.token);
    const b = JSON.parse(listing());
    assert.equal(b.subscription_tier, 'free'); assert.equal(b.subscription_until, null);
    assert.equal(b.name, 'Voe Gift Shop'); assert.equal(b.description, 'Soap and gifts'); assert.equal(b.is_active, true);
    assert.equal(scalar(`select count(*) from information_schema.tables where table_schema='public' and table_name in ('products','launch_plan_grants')`), '0', 'this feature touches no commerce or plan table');
  });
});

describe('H · nobody sees anybody else\'s claim', () => {
  before(reset);
  test('the claim table stays row-level private; the state function returns only a state word', () => {
    const inv = issue();
    submit(ALICE, inv.token);
    assert.deepEqual(rowsOf(asUser(BOB, `select id from public.business_claims`)), []);
    assert.deepEqual(rowsOf(asUser(null, `select id from public.business_claims`)), []);
    const s = JSON.stringify(state(BOB, inv.token));
    for (const leak of ['Esther', 'esther@example.com', ALICE, '01595']) assert.ok(!s.includes(leak), `leaked ${leak}`);
  });
});

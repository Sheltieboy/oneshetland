/**
 * hub-campaign-payout-ready.node.test.ts — a hub cannot publish a donation campaign it cannot be paid for (migration 20261201000000).
 *
 * PROVES (isolated Postgres, synthetic rows, no Stripe object, no payment):
 *  - creating an ACTIVE campaign is refused for a hub with no connected account, with payouts off, or with the flag set but no account — through the same
 *    hub_payout_ready() the membership screens and donation routes use (NOT a second definition);
 *  - a ready hub can publish; a campaign created CLOSED is allowed for any hub; edits to title/story/goal/cover/end date need no readiness;
 *  - REOPENING a closed campaign (and moving a campaign to another hub) needs readiness; CLOSING never does;
 *  - a live campaign whose hub LOSES readiness keeps its row, its history and its donations, can still be edited and closed, is reported by
 *    campaign_payout_ready() as not ready, and recovers when the hub is ready again;
 *  - the donation-side counters (record_hub_donation style updates) are not blocked;
 *  - the check holds for a hub ADMIN writing directly as `authenticated` (the real client path), not only for the owner or service role;
 *  - campaign_payout_ready() is callable signed-out, returns a bare boolean, and is false for an unknown campaign;
 *  - card and wallet routes still carry their own server-side payout checks and the shared eligibility call (source contract; the Edge Functions are
 *    deliberately NOT edited by this change), and the campaign eligibility function itself is unchanged.
 * ISOLATED DATABASE ONLY.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSN = process.env.PASS_PROOF_DSN ?? '', PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only): run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const MIG = read('supabase/migrations/20261201000000_hub_campaign_requires_payout_ready.sql');
const READY_FN = read('supabase/migrations/20260928120000_hub_payout_ready_function.sql');
const sql = (q: string) => { try { return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim(); } catch (e) { return `ERROR ${(e as any).stderr ?? e}`; } };
const file = (q: string) => execFileSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' });
const as = (uid: string | null, role: 'authenticated' | 'anon', q: string) =>
  sql(`begin; select set_config('request.jwt.claim.sub','${uid ?? ''}',true); set local role ${role}; ${q}; commit;`);
const REFUSED = /Finish setting up payouts before publishing a campaign/;

const H = { ready: '10000000-0000-4000-8000-000000000001', noAcct: '10000000-0000-4000-8000-000000000002', off: '10000000-0000-4000-8000-000000000003', flagOnly: '10000000-0000-4000-8000-000000000004', lapses: '10000000-0000-4000-8000-000000000005' };
const U = { owner: 'a0000000-0000-4000-8000-000000000001', admin: 'a0000000-0000-4000-8000-000000000002', stranger: 'a0000000-0000-4000-8000-000000000003' };
const camp = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;

before(() => {
  file(`
    drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth;
    do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;
    grant usage on schema public, auth to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.hubs (id uuid primary key, owner_id uuid, stripe_account_id text, payout_enabled boolean not null default false);
    create table public.hub_admins (hub_id uuid, user_id uuid);
    create function public.is_hub_admin(h uuid, u uuid) returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.hubs where id = h and owner_id = u) or exists (select 1 from public.hub_admins where hub_id = h and user_id = u) $$;
    create table public.hub_campaigns (
      id uuid default gen_random_uuid() not null primary key, hub_id uuid not null references public.hubs(id) on delete cascade, title text not null, story text,
      goal_pence integer not null, raised_pence integer default 0 not null, donor_count integer default 0 not null, cover_url text, status text default 'active' not null,
      ends_at timestamptz, created_by uuid, created_at timestamptz default now() not null,
      constraint hub_campaigns_goal_pence_check check (goal_pence > 0), constraint hub_campaigns_status_check check (status = any (array['active','closed'])));
    create table public.hub_donations (id uuid primary key default gen_random_uuid(), campaign_id uuid references public.hub_campaigns(id), hub_id uuid, amount_pence int);
    alter table public.hub_campaigns enable row level security;
    create policy "hub_campaigns manage" on public.hub_campaigns using (public.is_hub_admin(hub_id, auth.uid())) with check (public.is_hub_admin(hub_id, auth.uid()));
    create policy "hub_campaigns read" on public.hub_campaigns for select using (true);
    grant select, insert, update, delete on public.hub_campaigns to authenticated; grant select on public.hub_campaigns to anon;
    grant select on public.hubs, public.hub_admins to authenticated;`);
  file(READY_FN);          // the REAL production function, not a stand-in
  file(MIG);
  file(`
    insert into hubs (id, owner_id, stripe_account_id, payout_enabled) values
      ('${H.ready}','${U.owner}','acct_synthetic_1',true), ('${H.noAcct}','${U.owner}',null,false), ('${H.off}','${U.owner}','acct_synthetic_3',false),
      ('${H.flagOnly}','${U.owner}',null,true), ('${H.lapses}','${U.owner}','acct_synthetic_5',true);
    insert into hub_admins values ('${H.noAcct}','${U.admin}'), ('${H.ready}','${U.admin}'), ('${H.lapses}','${U.admin}');`);
});

describe('creating a campaign', () => {
  test('refused for a hub with no connected account', () => {
    assert.match(as(U.owner, 'authenticated', `insert into hub_campaigns (hub_id,title,goal_pence) values ('${H.noAcct}','x',1000)`), REFUSED);
  });
  test('refused when the account exists but payouts are not enabled', () => {
    assert.match(as(U.owner, 'authenticated', `insert into hub_campaigns (hub_id,title,goal_pence) values ('${H.off}','x',1000)`), REFUSED);
  });
  test('refused when payout_enabled is true but there is no account (the flag alone is not readiness)', () => {
    assert.match(as(U.owner, 'authenticated', `insert into hub_campaigns (hub_id,title,goal_pence) values ('${H.flagOnly}','x',1000)`), REFUSED);
  });
  test('refused for a hub ADMIN writing directly as the client does, and nothing is stored', () => {
    assert.match(as(U.admin, 'authenticated', `insert into hub_campaigns (hub_id,title,goal_pence) values ('${H.noAcct}','x',1000)`), REFUSED);
    assert.equal(sql(`select count(*) from hub_campaigns where hub_id in ('${H.noAcct}','${H.off}','${H.flagOnly}')`), '0');
  });
  test('the refusal carries a stable hint and check-violation code the screens can key on', () => {
    assert.equal(sql(`create function pg_temp.probe() returns text language plpgsql as $f$ declare h text; begin
      insert into hub_campaigns (hub_id,title,goal_pence) values ('${H.noAcct}','x',1000); return 'inserted';
      exception when others then get stacked diagnostics h = pg_exception_hint; return h || '|' || sqlstate; end $f$; select pg_temp.probe()`), 'hub_payout_not_ready|23514');
  });
  test('a payout-ready hub can publish; an ordinary admin can too', () => {
    assert.doesNotMatch(as(U.owner, 'authenticated', `insert into hub_campaigns (id,hub_id,title,goal_pence) values ('${camp(1)}','${H.ready}','ok',1000)`), /ERROR/);
    assert.equal(sql(`select status from hub_campaigns where id='${camp(1)}'`), 'active');
    assert.doesNotMatch(as(U.admin, 'authenticated', `insert into hub_campaigns (id,hub_id,title,goal_pence) values ('${camp(2)}','${H.ready}','ok2',1000)`), /ERROR/);
  });
  test('a campaign created CLOSED (not published) is allowed for a hub that is not ready', () => {
    assert.doesNotMatch(as(U.owner, 'authenticated', `insert into hub_campaigns (id,hub_id,title,goal_pence,status) values ('${camp(3)}','${H.noAcct}','draft-ish',1000,'closed')`), /ERROR/);
    assert.equal(sql(`select status from hub_campaigns where id='${camp(3)}'`), 'closed');
  });
});

describe('editing, closing and reopening', () => {
  test('ordinary edits to a closed campaign of a not-ready hub need no readiness', () => {
    assert.doesNotMatch(as(U.owner, 'authenticated', `update hub_campaigns set title='renamed', story='s', goal_pence=2500, cover_url='c', ends_at=now()+interval '30 days' where id='${camp(3)}'`), /ERROR/);
    assert.equal(sql(`select title||goal_pence from hub_campaigns where id='${camp(3)}'`), 'renamed2500');
  });
  test('REOPENING it is refused while the hub is not ready, and the row stays closed', () => {
    assert.match(as(U.owner, 'authenticated', `update hub_campaigns set status='active' where id='${camp(3)}'`), REFUSED);
    assert.equal(sql(`select status from hub_campaigns where id='${camp(3)}'`), 'closed');
  });
  test('reopening is allowed once the hub is ready', () => {
    sql(`update hubs set stripe_account_id='acct_synthetic_2', payout_enabled=true where id='${H.noAcct}'`);
    assert.doesNotMatch(as(U.owner, 'authenticated', `update hub_campaigns set status='active' where id='${camp(3)}'`), /ERROR/);
    assert.equal(sql(`select status from hub_campaigns where id='${camp(3)}'`), 'active');
    sql(`update hubs set stripe_account_id=null, payout_enabled=false where id='${H.noAcct}'`);   // back to not-ready
  });
  test('moving a live campaign to a hub that is not ready is refused', () => {
    assert.match(as(U.owner, 'authenticated', `update hub_campaigns set hub_id='${H.off}' where id='${camp(1)}'`), REFUSED);
    assert.equal(sql(`select hub_id from hub_campaigns where id='${camp(1)}'`), H.ready);
  });
});

describe('a published campaign whose hub loses readiness', () => {
  const live = camp(4);
  before(() => {
    sql(`insert into hub_campaigns (id,hub_id,title,goal_pence,raised_pence,donor_count) values ('${live}','${H.lapses}','live',5000,1500,2)`);
    sql(`insert into hub_donations (campaign_id,hub_id,amount_pence) values ('${live}','${H.lapses}',1000), ('${live}','${H.lapses}',500)`);
  });
  test('while ready it reports ready', () => {
    assert.equal(sql(`select campaign_payout_ready('${live}')`), 't');
  });
  test('after payouts are lost: row, history and counters are intact, and it reports NOT ready', () => {
    sql(`update hubs set payout_enabled=false where id='${H.lapses}'`);
    assert.equal(sql(`select status||raised_pence||donor_count from hub_campaigns where id='${live}'`), 'active15002');
    assert.equal(sql(`select count(*)::text||sum(amount_pence)::text from hub_donations where campaign_id='${live}'`), '21500');
    assert.equal(sql(`select campaign_payout_ready('${live}')`), 'f');
  });
  test('it can still be edited and closed by its admin (no readiness needed)', () => {
    assert.doesNotMatch(as(U.admin, 'authenticated', `update hub_campaigns set story='we are sorting our payouts' where id='${live}'`), /ERROR/);
    assert.doesNotMatch(as(U.admin, 'authenticated', `update hub_campaigns set status='closed' where id='${live}'`), /ERROR/);
    assert.equal(sql(`select status from hub_campaigns where id='${live}'`), 'closed');
  });
  test('donation counters (what record_hub_donation updates) are never blocked', () => {
    // put it back to 'active' with the trigger deliberately bypassed (test setup only), so the counter update runs against a LIVE campaign of a not-ready hub
    sql(`set session_replication_role = replica; update hub_campaigns set status='active' where id='${live}'`);
    assert.doesNotMatch(sql(`update hub_campaigns set raised_pence = raised_pence + 500, donor_count = donor_count + 1 where id='${live}'; select 1`), /ERROR/);
    assert.equal(sql(`select raised_pence||'/'||donor_count from hub_campaigns where id='${live}'`), '2000/3');
  });
  test('it recovers on its own when payouts are restored', () => {
    sql(`update hubs set payout_enabled=true where id='${H.lapses}'`);
    assert.equal(sql(`select campaign_payout_ready('${live}')`), 't');
  });
});

describe('campaign_payout_ready()', () => {
  test('is callable signed-out and returns only a boolean', () => {
    assert.equal(as(null, 'anon', `select campaign_payout_ready('${camp(1)}')`), 't');
    assert.equal(as(null, 'anon', `select campaign_payout_ready('${camp(3)}')`), 'f');
    assert.equal(as(null, 'anon', `select pg_typeof(campaign_payout_ready('${camp(1)}'))`), 'boolean');
  });
  test('is false for an unknown campaign and for NULL', () => {
    assert.equal(sql(`select campaign_payout_ready('c9999999-0000-4000-8000-000000000000')`), 'f');
    assert.equal(sql(`select campaign_payout_ready(null)`), 'f');
  });
  test('the trigger function is not directly callable by clients', () => {
    assert.match(as(U.owner, 'authenticated', `select public.hub_campaigns_require_payout_ready()`), /permission denied/);
  });
});

describe('card and wallet donation routes are unchanged and still check the hub server-side', () => {
  const card = read('supabase/functions/create-hub-donation-intent/index.ts');
  const wallet = read('supabase/functions/wallet-checkout/index.ts');
  test('both ask the one shared eligibility function before anything else', () => {
    assert.match(card, /rpc\('campaign_donation_eligibility'/);
    assert.match(wallet, /rpc\('campaign_donation_eligibility'/);
  });
  test('card refuses a hub without a connected account and enabled payouts (demo slug aside)', () => {
    assert.match(card, /hubHasAccount = !!\(hub\.stripe_account_id && hub\.payout_enabled\)/);
    assert.match(card, /!isDemoHub && !hubHasAccount[\s\S]{0,120}has not finished setting up payouts/);
  });
  test('wallet refuses it before the wallet is debited', () => {
    const i = wallet.indexOf("campaign_donation_eligibility");
    const j = wallet.indexOf('!hub.stripe_account_id || !hub.payout_enabled', i);
    assert.ok(j > i, 'hub readiness check follows eligibility');
    assert.match(wallet.slice(j, j + 160), /has not finished setting up payouts/);
  });
  test('the eligibility function does not (and need not) consider payouts: that stays a separate server-side check', () => {
    const elig = read('supabase/migrations/20260825230000_hub_donation_attempts_and_eligibility.sql');
    assert.doesNotMatch(elig, /payout/i);
  });
  test('this migration changes no donation function', () => {
    assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /campaign_donation_eligibility|record_hub_donation|create or replace function public\.(confirm|fulfil)/i);
  });
});

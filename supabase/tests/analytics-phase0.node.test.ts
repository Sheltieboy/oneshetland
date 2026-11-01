/**
 * analytics-phase0.node.test.ts — the owner analytics RPCs (migration 20261130000000) on a synthetic database in the ISOLATED Postgres.
 *
 * PROVES: registrations come from the account system in the window and exclude internal/test accounts; signed-in users are counted by user_id whatever the stored
 * user_type says; anonymous visitors exclude anyone who signed in; administrator/test events (by user_type, by account, and by an anonymous id an administrator once
 * used) are excluded at READ time and never deleted; server-recorded ledger events whose order no longer exists are excluded; repeats collapse to one; wallet top-ups
 * never enter sales; refunds are netted; platform revenue is separated from gross; shop orders and subscriptions are reported; internal purchases are excluded and
 * counted; only administrators may call the RPCs. ALL data is fictional. ISOLATED DATABASE ONLY.
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
const MIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '20261130000000_analytics_phase0_accuracy.sql');
const sql = (q: string) => { try { return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim(); } catch (e) { return `ERROR ${(e as any).stderr ?? e}`; } };
const file = (q: string) => execFileSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' });
const U = { admin: 'a0000000-0000-4000-8000-000000000001', m1: 'b0000000-0000-4000-8000-000000000001', m2: 'b0000000-0000-4000-8000-000000000002', m3: 'b0000000-0000-4000-8000-000000000003', test: 'b0000000-0000-4000-8000-000000000004', bot: 'b0000000-0000-4000-8000-000000000005', old: 'b0000000-0000-4000-8000-000000000006' };
const as = (uid: string, q: string) => sql(`begin; select set_config('request.jwt.claim.sub','${uid}',true); set local role authenticated; ${q}; commit;`);
const json = (fn: string, days = 30) => { const o = as(U.admin, `select ${fn}(${days})::text`); const l = o.split('\n').find((x) => x.startsWith('{')); if (!l) throw new Error(o); return JSON.parse(l); };
const D = (d: number) => `now() - interval '${d} days'`;

before(() => {
  file(`
    drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth;
    do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
    grant usage on schema public, auth to authenticated, anon;
    create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles (id uuid primary key, role text default 'customer', is_platform_owner boolean default false, display_name text, full_name text);
    create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)) $$;
    create table public.analytics_events (id bigint generated always as identity primary key, occurred_at timestamptz not null default now(), received_at timestamptz not null default now(), event_name text not null,
      user_id uuid, anon_id text, session_id text, platform text not null default 'app', user_type text, app_version text, object_type text, object_id text, business_id uuid, hub_id uuid, order_id uuid,
      is_conversion boolean not null default false, category text, props jsonb not null default '{}', consent boolean);
    create table public.event_ticket_orders (id uuid primary key default gen_random_uuid(), buyer_id uuid, status text, total_pence int, platform_fee_pence int, paid_at timestamptz, created_at timestamptz default now());
    create table public.product_orders (id uuid primary key default gen_random_uuid(), buyer_id uuid, status text, total_pence int, commission_pence int, refund_state text default 'none', paid_at timestamptz, created_at timestamptz default now());
    create table public.book_unit_purchases (id uuid primary key default gen_random_uuid(), owner_id uuid, paid_amount_pence int, refund_state text default 'none', created_at timestamptz default now());
    create table public.book_bookings (id uuid primary key default gen_random_uuid(), customer_id uuid, deposit_pence int, deposit_paid_at timestamptz);
    create table public.book_gifts (id uuid primary key default gen_random_uuid(), purchaser_id uuid, status text, price_paid_pence int, created_at timestamptz default now());
    create table public.hub_donations (id uuid primary key default gen_random_uuid(), donor_user_id uuid, amount_pence int, fee_pence int, created_at timestamptz default now());
    create table public.hub_members (id uuid primary key default gen_random_uuid(), user_id uuid, last_payment_pence int, joined_at timestamptz default now());
    create table public.delivery_requests (id uuid primary key default gen_random_uuid(), customer_id uuid, payment_status text, total_fee_pence int, created_at timestamptz default now());
    create table public.local_boost_purchases (id uuid primary key default gen_random_uuid(), owner_id uuid, status text, amount_pence int, refunded_pence int default 0, created_at timestamptz default now());
    create table public.shift_boost_purchases (id uuid primary key default gen_random_uuid(), employer_id uuid, status text, amount_pence int, purchased_at timestamptz default now());
    create table public.local_wallet_transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, amount_pence int, platform_fee_pence int, created_at timestamptz default now());
    create table public.local_businesses (id uuid primary key default gen_random_uuid(), stripe_subscription_id text, subscription_tier text, subscription_until timestamptz);
    grant select on all tables in schema public, auth to authenticated;`);
  file(readFileSync(MIG, 'utf8'));
  file(`
    insert into profiles (id, role, display_name) values ('${U.admin}','admin','Staff'), ('${U.m1}','customer','Ann'), ('${U.m2}','customer','Bea'), ('${U.m3}','customer','Cal'), ('${U.test}','customer','ZZ TEST Fixture'), ('${U.bot}','customer','Bot'), ('${U.old}','customer','Old');
    insert into auth.users (id, email, created_at, email_confirmed_at) values
      ('${U.admin}','staff@darrenfullerton.com', ${D(100)}, now()), ('${U.m1}','ann@example-real.co.uk', ${D(5)}, now()), ('${U.m2}','bea@example-real.co.uk', ${D(3)}, null), ('${U.m3}','cal@example-real.co.uk', ${D(2)}, now()),
      ('${U.test}','zz.fixture@probe.invalid', ${D(2)}, now()), ('${U.bot}','bot@yahoo.com', ${D(1)}, null), ('${U.old}','old@example-real.co.uk', ${D(60)}, now());
    -- events: m1 mislabelled 'visitor' on web (the historical bug) but with a user_id; anon browsers; an admin who browsed anonymously first then signed in; a test account; unlabelled server events
    insert into analytics_events (event_name, user_id, anon_id, session_id, platform, user_type, object_type, object_id, is_conversion, category, occurred_at) values
      ('screen_viewed','${U.m1}','anon-m1','s1','web','visitor',null,null,false,'content_interaction', now()),
      ('content_viewed','${U.m1}','anon-m1','s1','web','visitor','job','j1',false,'content_interaction', now()),
      ('screen_viewed',null,'anon-m1','s0','web','visitor',null,null,false,'content_interaction', now()),
      ('screen_viewed',null,'anon-x','s2','web','visitor',null,null,false,'content_interaction', now()),
      ('screen_viewed',null,'anon-y','s3','app','visitor',null,null,false,'content_interaction', now()),
      ('screen_viewed',null,'anon-admin','s4','web','visitor',null,null,false,'content_interaction', now()),
      ('screen_viewed','${U.admin}','anon-admin','s4','web','visitor',null,null,false,'content_interaction', now()),
      ('screen_viewed','${U.admin}','anon-adm2','s5','app','admin',null,null,false,'content_interaction', now()),
      ('screen_viewed','${U.test}','anon-test','s6','app','user',null,null,false,'content_interaction', now()),
      ('job_applied','${U.m3}','anon-m3','s7','app','user','job','j2',true,'lead', now()),
      ('screen_viewed','${U.m1}','anon-m1','s1','web','visitor',null,null,false,'content_interaction', ${D(45)});`);
  // ledger rows + server events: one real booking (confirmed twice = status toggling), one deleted booking (orphan), one real ticket order
  file(`
    insert into book_bookings (id, customer_id) values ('c0000000-0000-4000-8000-000000000001','${U.m3}');
    insert into event_ticket_orders (id, buyer_id, status, total_pence, platform_fee_pence, paid_at) values ('c1000000-0000-4000-8000-000000000001','${U.m2}','paid',1000,100, now()), ('c1000000-0000-4000-8000-000000000002','${U.m1}','refunded',500,50, now()), ('c1000000-0000-4000-8000-000000000003','${U.test}','paid',700,70, now());
    insert into analytics_events (event_name, user_id, platform, user_type, order_id, is_conversion, category) values
      ('booking_confirmed','${U.m3}','app','user','c0000000-0000-4000-8000-000000000001', true, 'lead'),
      ('booking_confirmed','${U.m3}','app','user','c0000000-0000-4000-8000-000000000001', true, 'lead'),
      ('booking_confirmed','${U.bot}','app','user','c0000000-0000-4000-8000-0000000000dd', true, 'lead'),
      ('booking_confirmed','${U.bot}','app','user','c0000000-0000-4000-8000-0000000000de', true, 'lead'),
      ('event_ticket_purchased','${U.m2}','app','user','c1000000-0000-4000-8000-000000000001', true, 'transaction');
    insert into product_orders (buyer_id, status, total_pence, commission_pence, paid_at) values ('${U.m1}','paid',2000,200, now()), ('${U.m2}','completed',1000,100, now()), ('${U.m3}','paid',900,90, now()), ('${U.m2}','pending',5000,500, null);
    update product_orders set refund_state='refunded', status='refunded' where total_pence = 900;
    insert into book_unit_purchases (owner_id, paid_amount_pence) values ('${U.m1}', 1500);
    insert into hub_donations (donor_user_id, amount_pence, fee_pence) values ('${U.m2}', 400, 20);
    insert into local_boost_purchases (owner_id, status, amount_pence, refunded_pence) values ('${U.m1}','succeeded',500,0), ('${U.m2}','succeeded',500,500);
    insert into local_wallet_transactions (user_id, type, amount_pence, platform_fee_pence) values ('${U.m1}','topup',5000,0), ('${U.m1}','spend',-1500,15), ('${U.test}','topup',9999,0), ('${U.m2}','refund',300,0);
    insert into local_businesses (stripe_subscription_id, subscription_tier, subscription_until) values ('sub_1','pro', now() + interval '10 days'), ('sub_2','premium', now() + interval '10 days'), (null,'premium', now() + interval '10 days'), (null,'free', null);`);
});

describe('overview', () => {
  test('1 registrations are real new accounts in the window; internal/test accounts excluded; confirmed counted separately', () => {
    const t = json('analytics_overview').totals; assert.equal(t.signups, 4, 'm1, m2, m3 and the bot account (the admin, the ZZ/probe account and the 60-day-old account are not new registrations)'); assert.equal(t.signups_confirmed, 2);
    assert.equal(json('analytics_overview', 90).totals.signups, 5, 'the 60-day-old account joins a longer window');
  });
  test('2 signed-in members are counted by user_id (a "visitor" label does not hide them); admin and test accounts are not members', () => {
    const t = json('analytics_overview').totals; assert.equal(t.unique_users, 3, 'm1 (labelled visitor), m3 and m2 (whose ticket purchase was recorded); not the admin, not the ZZ account');
  });
  test('3 anonymous visitors exclude anyone who signed in and anyone who is internal', () => {
    const t = json('analytics_overview').totals; assert.equal(t.unique_visitors, 2, 'anon-x and anon-y only: anon-m1 signed in, anon-admin belongs to an administrator');
  });
  test('4 exclusion is at read time: nothing is deleted, and the numbers reconcile (raw = reportable + excluded)', () => {
    const o = json('analytics_overview'); const raw = Number(sql(`select count(*) from analytics_events where occurred_at >= ${D(30)}`));
    assert.equal(o.excluded.raw_events, raw); assert.equal(o.totals.events + o.excluded.internal_or_test + o.excluded.unmatched_ledger + o.excluded.duplicate_ledger, raw);
    assert.equal(Number(sql(`select count(*) from analytics_events`)), 16, 'every row still stored');
  });
  test('5 internal = admin user_type, admin/test account, or an anonymous id an administrator used', () => { assert.equal(json('analytics_overview').excluded.internal_or_test, 4, 'anon-admin x2, admin, ZZ account (the user_type admin row shares the admin account)'); });
  test('6 ledger events: a booking recorded twice counts once; events whose booking no longer exists are excluded', () => {
    const o = json('analytics_overview'); assert.equal(o.excluded.duplicate_ledger, 1); assert.equal(o.excluded.unmatched_ledger, 2);
    const t = o.by_category.find((c: any) => c.category === 'lead'); assert.equal(t.conversions, 2, 'one job application + one real booking');
  });
  test('7 the window is honoured (the 45-day-old event is outside 30 days and inside 90)', () => { assert.equal(json('analytics_overview', 90).totals.events - json('analytics_overview', 30).totals.events, 1); });
});

describe('revenue', () => {
  test('8 sales streams: gross, refunded, net and what OneShetland keeps; internal/test purchases excluded and counted', () => {
    const r = json('analytics_revenue'); const by = Object.fromEntries(r.streams.map((s: any) => [s.stream, s]));
    assert.deepEqual([by['Event tickets'].orders, by['Event tickets'].gross_pence, by['Event tickets'].platform_pence], [2, 1500, 100], 'the paid ticket and the refunded one; the ZZ ticket is excluded; a refunded order keeps no fee');
    assert.equal(by['Event tickets'].refunded_pence, 500); assert.equal(by['Event tickets'].net_pence, 1000);
    assert.deepEqual([by['Shop orders'].orders, by['Shop orders'].gross_pence, by['Shop orders'].refunded_pence, by['Shop orders'].platform_pence], [3, 3900, 900, 300], 'paid + completed + refunded; the pending order is not a sale');
    assert.equal(by['Business boosts'].net_pence, 500); assert.equal(by['Business boosts'].platform_pence, 500);
    assert.equal(by['Hub donations'].platform_pence, 20); assert.equal(by['Passes & units'].platform_pence, null, 'not recorded -> null, never a made-up 0');
    assert.equal(r.totals.excluded_internal_orders, 1); assert.equal(r.totals.excluded_internal_gross_pence, 700);
  });
  test('9 wallet funds are reported separately and never added to sales', () => {
    const r = json('analytics_revenue'); assert.ok(!r.streams.some((s: any) => /wallet/i.test(s.stream)));
    assert.deepEqual([r.wallet.topups_pence, r.wallet.spent_pence, r.wallet.refunded_to_wallet_pence], [5000, 1500, 300], 'the ZZ top-up of 9999 is excluded');
    const sum = r.streams.reduce((a: number, s: any) => a + s.gross_pence, 0); assert.equal(r.totals.gross_pence, sum); assert.ok(r.totals.gross_pence < 5000 + sum, 'the £50 top-up is not in gross');
  });
  test('10 totals are consistent: net = gross - refunded; platform = the sum of recorded shares', () => {
    const t = json('analytics_revenue').totals; assert.equal(t.net_pence, t.gross_pence - t.refunded_pence); assert.equal(t.platform_pence, 100 + 300 + 500 + 20);
  });
  test('11 subscriptions: paying plans (live Stripe subscription) are estimated at list price; complimentary access is separate and is not income', () => {
    const s = json('analytics_revenue').subscriptions; assert.deepEqual([s.paying, s.paying_pro, s.paying_premium, s.complimentary, s.est_mrr_pence], [2, 1, 1, 1, 1200 + 2900]);
  });
});

describe('access', () => {
  test('12 only administrators may call the RPCs; the helpers are not callable by clients', () => {
    assert.match(as(U.m1, `select analytics_overview(30)`), /admin only/); assert.match(as(U.m1, `select analytics_revenue(30)`), /admin only/);
    assert.match(sql(`begin; set local role authenticated; select * from analytics_classified_events(now() - interval '1 day', now()); commit;`), /permission denied/);
    assert.match(sql(`begin; set local role authenticated; select analytics_internal_users(); commit;`), /permission denied/);
    assert.match(sql(`begin; set local role anon; select analytics_overview(30); commit;`), /permission denied/);
  });
});

/**
 * production-concurrency-proofs.node.test.ts — the races that used to be run
 * against production.
 *
 * A concurrency proof needs two genuinely separate connections, and separate
 * connections cannot see each other's uncommitted work. So these proofs cannot
 * roll themselves back: they COMMIT. Run against production that means seeding
 * real tables, racing, and tidying up afterwards — and on 2026-09-08 the tidying
 * did not happen. A wallet fixture died mid-run during a Supabase CLI auth
 * failure and left a real customer account holding £38.00 that had never been
 * paid in.
 *
 * The wallet proofs moved first (wallet-concurrency.node.test.ts). These are the
 * rest of the same shape, moved for the same reason. Each was seeding real
 * production rows and depending on an `after()` hook to remove them:
 *
 *   AI quota        rewrote a REAL profile's hourly AI counter to 29/30
 *   booking metering created a business, a service and 20 bookings for a REAL owner
 *   ticket check-in  created events, ticket types, orders, tickets and check-ins
 *   Stripe delivery  claimed a webhook event id in the idempotency ledger
 *   rate limiting    claimed against a synthetic subject in the limiter
 *
 * The last two are mild — synthetic identifiers, no customer row — but they
 * commit and they depend on cleanup, which is the property that failed. They are
 * here too rather than being argued about individually.
 *
 * The proofs themselves are unchanged: same primitives, same 6s/3s lock-holding
 * interleave, same assertions.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');

const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const AIQUOTA = join(MIG, '20260820200000_ai_request_quota.sql');
const RATELIMITS = join(MIG, '20260821280000_rate_limits.sql');
const STRIPEIDEM = join(MIG, '20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');
const METERING = join(MIG, '20260821180000_booking_metering_claims.sql');
// The cap only counts work in flight from this migration onwards; installing the
// earlier definition would prove a rule production no longer has.
const METERINGCAP = join(MIG, '20260821190000_metering_cap_counts_inflight.sql');
const METERINGHEALTH = join(MIG, '20260821200000_metering_health_and_reclaim_window.sql');
const METERED = join(MIG, '20260816140000_metered_pro_bookings.sql');
const TICKETS = join(MIG, '20260820120000_atomic_ticket_redemption.sql');
const TICKETIDEM = join(MIG, '20260819260000_ticket_checkout_idempotency.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');
const args = (b: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', b];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const clean = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const value = (out: string) => clean(out).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * One psql session, so temp tables survive between statements, returning the
 * final row's columns. `-A -t` prints them pipe-separated.
 */
const row = (sql: string): string[] => value(raw(sql)).split('|');

function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let d = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

/** Invented. No account, no business, no event belongs to any of these. */
const U_AI = 'bb000000-0000-4000-8000-0000000000b1';
const U_OWN = 'bb000000-0000-4000-8000-0000000000b2';
const BIZ   = 'bb000000-0000-4000-8000-0000000000b3';
const SVC   = 'bb000000-0000-4000-8000-0000000000b4';
const U_SCAN_A = 'bb000000-0000-4000-8000-0000000000b5';
const U_SCAN_B = 'bb000000-0000-4000-8000-0000000000b6';
const EV_A  = 'bb000000-0000-4000-8000-0000000000c1';
const EV_R  = 'bb000000-0000-4000-8000-0000000000d1';
const TT_R  = 'bb000000-0000-4000-8000-0000000000d2';
const OR_R  = 'bb000000-0000-4000-8000-0000000000d3';
const TT_A  = 'bb000000-0000-4000-8000-0000000000c2';
const OR_A  = 'bb000000-0000-4000-8000-0000000000c3';

/**
 * A holds its transaction open for 6s; B arrives 3s in, while A still holds the
 * row, and must re-test against A's COMMITTED result. Remove the sleeps and both
 * callers read the same stale row and both pass — which is the bug these proofs
 * exist to catch.
 */
async function race(first: string, second: string): Promise<string[]> {
  const a = rawAsync(`begin;\n${first}\nselect pg_sleep(6);\nselect r from _out;\ncommit;`);
  await sleep(150);
  const b = rawAsync(`select pg_sleep(3);\n${second}`);
  const [ra, rb] = await Promise.all([a, b]);
  return [value(ra), value(rb)];
}

function base() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    'create table public.profiles (id uuid primary key, role text, is_platform_owner boolean default false);',
    // Supabase's auth.uid(), faithfully: the subject of the caller's JWT, from
    // either the flattened claim or the whole claims object.
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select coalesce(
         nullif(current_setting('request.jwt.claim.sub', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
       )::uuid $$;`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `base schema failed:\n${out.slice(0, 900)}`);
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is required — run via `npm run test:isolated`');
  assert.ok(!/supabase/i.test(DSN), 'refusing to run against anything that looks like Supabase');
});

// ── 1. The AI hourly ceiling ────────────────────────────────────────────────
//
// Was: rewrite a REAL profile's ai_usage row to 29/30 and race two claims. If
// that died mid-run, a real person lost their AI allowance for the hour.

describe('two AI requests at the last slot', () => {
  before(() => {
    base();
    const out = raw([
      createTable(AIQUOTA, 'create table if not exists public.ai_usage ('),
      slice(AIQUOTA, 'create or replace function public.claim_ai_request', '$$;'),
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `ai schema failed:\n${out.slice(0, 900)}`);
    const f = raw(`insert into auth.users(id) values ('${U_AI}');
      insert into public.profiles(id) values ('${U_AI}');
      insert into public.ai_usage (user_id, bucket, total, per_route)
        values ('${U_AI}', date_trunc('hour', now()), 29, '{"parse-job": 1}'::jsonb);`);
    assert.doesNotMatch(f, /ERROR/i, `ai fixtures failed:\n${f.slice(0, 700)}`);
  });

  test('only one of them gets it', async () => {
    // The claim reads auth.uid(), so both connections must adopt the same
    // identity the way PostgREST does.
    const claimAs = `create or replace function pg_temp.claim_as() returns text language plpgsql as $f$
declare v boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub','${U_AI}','role','authenticated')::text, true);
  select allowed into v from public.claim_ai_request('parse-job');
  return case when v then 'allowed' else 'refused' end;
end $f$;`;

    const [ra, rb] = await race(
      `${claimAs}\ncreate temp table _out as select pg_temp.claim_as() r;`,
      `${claimAs}\nselect pg_temp.claim_as() as r;`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'allowed').length, 1,
      `both concurrent requests took the last slot. Got ${JSON.stringify(results)}`);
    assert.equal(num(`select total::text from public.ai_usage where user_id='${U_AI}' and bucket=date_trunc('hour', now());`), 30,
      'the ceiling was exceeded');
  });
});

// ── 2. The limiter ceiling ──────────────────────────────────────────────────
//
// Was: ten parallel CLI processes claiming against production's limiter under a
// synthetic subject. Mild, but it committed and it leaned on cleanup — and ten
// simultaneous CLI logins is exactly what the auth layer could not survive.

describe('the ceiling holds when callers arrive together', () => {
  const SUBJECT = 'user:rl-concurrency-probe';

  before(() => {
    base();
    const out = raw([
      createTable(RATELIMITS, 'create table if not exists public.rate_limit_policies ('),
      createTable(RATELIMITS, 'create table if not exists public.rate_limits ('),
      slice(RATELIMITS, 'create or replace function public.claim_rate_limits', '$$;'),
      `insert into public.rate_limit_policies (action, window_seconds, max_count, note)
         values ('notify_broadcast', 3600, 6, 'moved concurrency proof') on conflict (action) do nothing;`,
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `limiter schema failed:\n${out.slice(0, 900)}`);
  });

  test('ten simultaneous connections cannot exceed a ceiling of six', async () => {
    raw(`delete from public.rate_limits where subject = '${SUBJECT}';`);
    const attempts = await Promise.all(Array.from({ length: 10 }, () =>
      rawAsync(`select allowed from public.claim_rate_limits('${SUBJECT}', array['notify_broadcast']);`)
        .then((o) => ({ ok: true as const, allowed: /^(t|true)$/i.test(value(o)) }))
        .catch(() => ({ ok: false as const, allowed: false }))));

    const reached = attempts.filter((a) => a.ok);
    const allowed = reached.filter((a) => a.allowed).length;

    // Ten real connections into a throwaway cluster: all ten should arrive.
    assert.equal(reached.length, 10, `only ${reached.length} of 10 connections reached the database`);
    assert.ok(allowed <= 6, `${allowed} claims were granted against a ceiling of 6`);
    assert.equal(num(`select count::text from public.rate_limits where subject='${SUBJECT}' and action='notify_broadcast';`), allowed,
      'the stored count must match the number of granted claims');
  });
});

// ── 3. One Stripe delivery ──────────────────────────────────────────────────
//
// Was: claim a webhook event id in production's idempotency ledger. Synthetic
// id, but a committed row that only cleanup removed.

describe('two deliveries of one event arriving together', () => {
  const EVT = 'evt_t_concurrent';

  before(() => {
    base();
    const out = raw([
      createTable(STRIPEIDEM, 'create table if not exists public.stripe_webhook_events ('),
      slice(STRIPEIDEM, 'create or replace function public.claim_stripe_event', '$$;'),
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `stripe schema failed:\n${out.slice(0, 900)}`);
  });

  test('exactly one delivery may proceed', async () => {
    raw(`delete from public.stripe_webhook_events where stripe_event_id like 'evt_t_%';`);
    const [ra, rb] = await race(
      `create temp table _out as select public.claim_stripe_event('${EVT}','payment_intent.succeeded','pi_x') r;`,
      `select public.claim_stripe_event('${EVT}','payment_intent.succeeded','pi_x') as r;`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'claimed').length, 1,
      `${results.filter((x) => x === 'claimed').length} deliveries were allowed to fulfil the same Stripe event. Got ${JSON.stringify(results)}`);
    assert.ok(results.includes('in_progress'),
      `the losing delivery should be told to retry, got ${JSON.stringify(results)}`);
    assert.equal(num(`select count(*)::text from public.stripe_webhook_events where stripe_event_id='${EVT}';`), 1,
      'the ledger holds more than one row for a single event id');
  });
});

// ── 4. Two metering workers ─────────────────────────────────────────────────
//
// Was: create a business, a service and 20 bookings under a REAL owner's
// profile, race two claim workers, then delete it all by slug. An interrupted
// run left a whole fake business, with bookings, attached to a real account.

describe('claiming is atomic and cap-aware', () => {
  const CAP = 17;
  let monthStart = '';

  before(() => {
    base();
    const out = raw([
      createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
      'alter table public.local_businesses add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.book_services ('),
      'alter table public.book_services add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.book_bookings ('),
      'alter table public.book_bookings add primary key (id);',
      // settle_booking_metering stamps metered_at, which arrived in its own
      // earlier migration rather than the baseline.
      slice(METERED, 'alter table public.book_bookings\n  add column if not exists metered_at', ';'),
      slice(METERING, 'alter table public.book_bookings\n  add column if not exists metering_state', ';'),
      slice(METERING, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint', 'end $$;'),
      slice(METERINGCAP, 'alter table public.book_bookings\n  add column if not exists metering_claimed_at', ';'),
      // Only the four-argument definition, or a three-argument call silently
      // resolves to the older overload and proves a rule production has replaced.
      slice(METERINGCAP, 'create or replace function public.claim_bookings_for_metering', '$$;'),
      slice(METERING, 'create or replace function public.settle_booking_metering', '$$;'),
      slice(METERINGHEALTH, 'create or replace function public.reclaim_unresolved_metering', '$$;'),
      slice(METERINGHEALTH, 'create or replace function public.metering_backlog_health', '$$;'),
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `metering schema failed:\n${out.slice(0, 1100)}`);

    const f = raw(`
      insert into auth.users(id) values ('${U_OWN}');
      insert into public.profiles(id) values ('${U_OWN}');
      insert into public.local_businesses (id,owner_id,name,category,address,is_active,subscription_tier,stripe_subscription_id)
        values ('${BIZ}','${U_OWN}','S11 Metering Test','other','fixture',false,'pro','sub_S11_TEST');
      insert into public.book_services (id,business_id,name,duration_minutes,price_pence,is_active)
        values ('${SVC}','${BIZ}','S11 test service',30,1000,false);
      insert into public.book_bookings
        (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence, created_at)
      select '${BIZ}','${SVC}','${U_OWN}',
             now() + (g || ' hours')::interval, now() + ((g+1) || ' hours')::interval,
             'confirmed', 1000, date_trunc('month', now()) + (g || ' minutes')::interval
        from generate_series(1, 20) g;`);
    assert.doesNotMatch(f, /ERROR/i, `metering fixtures failed:\n${f.slice(0, 900)}`);
    monthStart = scalar(`select date_trunc('month', now())::text;`);
    assert.equal(num(`select count(*)::text from public.book_bookings where business_id='${BIZ}';`), 20,
      'fixture did not create 20 bookings');
  });

  const reset = () => raw(`update public.book_bookings
       set metering_state='pending', metering_attempt_id=null,
           metering_attempts=0, metered_at=null, metering_reported_at=null, metering_error=null
     where business_id='${BIZ}'::uuid;`);

  test('two concurrent workers never claim the same booking, and honour the cap', async () => {
    reset();
    // Two separate processes, therefore two separate connections, claiming the
    // same month at the same time. The advisory lock inside the RPC is what
    // stops them handing out the same booking twice.
    const claim = () => rawAsync(
      `select string_agg(booking_id::text, ',') from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, ${CAP}, interval '15 minutes');`);
    const [a, b] = await Promise.all([claim(), claim()]);
    const ids = (o: string) => new Set(value(o).split(',').filter(Boolean));
    const sa = ids(a), sb = ids(b);
    const overlap = [...sa].filter((x) => sb.has(x));

    assert.deepEqual(overlap, [],
      `${overlap.length} booking(s) were claimed by BOTH workers — each would be billed twice`);
    assert.equal(sa.size + sb.size, CAP,
      `workers claimed ${sa.size + sb.size} bookings between them; the monthly cap is ${CAP}`);
  });

  test('the cap counts work in flight, not just work finished', () => {
    // The bug the concurrency proof found first time round: counting only
    // 'reported' let a second worker spend an allowance the first was using.
    reset();
    raw(`select 1 from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, ${CAP}, interval '15 minutes');`);
    assert.equal(num(`select count(*)::text from public.book_bookings where business_id='${BIZ}'::uuid and metering_state='reporting';`), CAP);
    assert.equal(num(`select count(*)::text from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, ${CAP}, interval '15 minutes');`), 0,
      'a second claim handed out more bookings while the first batch was still in flight');
  });

  test('a definite failure returns the booking to the queue with the SAME identity', () => {
    reset();
    const [ok, state, sameIdentity, unstamped] = row(`
      create temp table pick as
        select booking_id, attempt_id
          from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, 1, interval '15 minutes') limit 1;
      create temp table settled as
        select public.settle_booking_metering(booking_id, attempt_id, 'failed', 'card_declined') as ok from pick;
      select (select ok::text from settled) as ok,
             b.metering_state as state,
             (b.metering_attempt_id = (select attempt_id from pick))::text as same_identity,
             (b.metered_at is null)::text as unstamped
        from public.book_bookings b where b.id = (select booking_id from pick);`);
    assert.equal(ok, 'true');
    assert.equal(state, 'pending', 'a definite failure must return the booking to the queue');
    assert.equal(sameIdentity, 'true', 'the retry would use a NEW identity — Stripe could then bill twice');
    assert.equal(unstamped, 'true', 'a failed report must not stamp the booking as metered');
  });

  test('an ambiguous outcome is never recorded as success', () => {
    reset();
    // Read through a row that always exists and assert the claim first: an empty
    // pick otherwise surfaces as an undefined state, which reads as the opposite
    // of the truth — a booking wrongly stamped, rather than no booking at all.
    const [claimed, ok, state, unstamped] = row(`
      create temp table pick as
        select booking_id, attempt_id
          from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, 1, interval '15 minutes') limit 1;
      create temp table settled as
        select public.settle_booking_metering(booking_id, attempt_id, 'unresolved', 'timeout') as ok from pick;
      select (select count(*)::text from pick) as claimed,
             (select ok::text from settled) as ok,
             (select b.metering_state from public.book_bookings b where b.id = (select booking_id from pick)) as state,
             (select (b.metered_at is null)::text from public.book_bookings b where b.id = (select booking_id from pick)) as unstamped;`);
    assert.equal(claimed, '1', 'the claim handed out no booking, so this test exercised nothing');
    assert.equal(ok, 'true', 'the ambiguous settlement did not match a claimed booking');
    assert.equal(state, 'unresolved');
    assert.equal(unstamped, 'true', 'an unknown Stripe outcome was stamped as billed');
  });

  test('a reported booking is terminal, and a foreign attempt cannot settle it', () => {
    reset();
    const [firstOk, secondOk, foreignOk, state] = row(`
      create temp table pick as
        select booking_id, attempt_id
          from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, 1, interval '15 minutes') limit 1;
      create temp table s1 as select public.settle_booking_metering(booking_id, attempt_id, 'reported') as ok from pick;
      create temp table s2 as select public.settle_booking_metering(booking_id, attempt_id, 'reported') as ok from pick;
      create temp table s3 as select public.settle_booking_metering(booking_id, gen_random_uuid(), 'reported') as ok from pick;
      select (select ok::text from s1) as first_ok,
             (select ok::text from s2) as second_ok,
             (select ok::text from s3) as foreign_ok,
             b.metering_state as state
        from public.book_bookings b where b.id = (select booking_id from pick);`);
    assert.equal(firstOk, 'true');
    assert.equal(secondOk, 'false', 'a reported booking was re-settled — it could be billed again');
    assert.equal(foreignOk, 'false', 'a worker with the wrong attempt id settled someone else’s claim');
    assert.equal(state, 'reported');
  });

  test('an already-reported booking is never claimed again', () => {
    reset();
    const [settled, reclaimed] = row(`
      with claimed as (
        select booking_id, attempt_id
          from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, ${CAP}, interval '15 minutes')),
      done as (select public.settle_booking_metering(c.booking_id, c.attempt_id, 'reported') from claimed c)
      select (select count(*) from done)::text as settled,
             (select count(*)::text from public.claim_bookings_for_metering(
               '${BIZ}'::uuid, '${monthStart}'::timestamptz, ${CAP}, interval '15 minutes')) as reclaimed;`);
    assert.equal(settled, String(CAP));
    assert.equal(reclaimed, '0', 'bookings already billed were claimed again');
  });

  test('ambiguous attempts retry inside Stripe’s window and escalate outside it', () => {
    reset();
    const [inside, identityKept, outside, flagged] = row(`
      create temp table pick as
        select booking_id, attempt_id
          from public.claim_bookings_for_metering('${BIZ}'::uuid, '${monthStart}'::timestamptz, 1, interval '15 minutes') limit 1;

      -- an ambiguous outcome, attempted just now
      select public.settle_booking_metering(booking_id, attempt_id, 'unresolved', 'timeout') from pick;
      create temp table inside as
        select count(*)::int as n from public.reclaim_unresolved_metering('${BIZ}'::uuid, interval '12 hours');
      create temp table identity as
        select (b.metering_attempt_id = (select attempt_id from pick)) as kept
          from public.book_bookings b where b.id = (select booking_id from pick);

      -- the same attempt, now older than Stripe would remember
      select public.settle_booking_metering(booking_id, attempt_id, 'unresolved', 'timeout') from pick;
      update public.book_bookings
         set metering_claimed_at = now() - interval '30 hours',
             created_at          = now() - interval '3 days'
       where id = (select booking_id from pick);
      create temp table outside_window as
        select count(*)::int as n from public.reclaim_unresolved_metering('${BIZ}'::uuid, interval '12 hours');

      select (select n::text from inside)         as reclaimed_inside,
             (select kept::text from identity)    as identity_kept,
             (select n::text from outside_window) as reclaimed_outside,
             unresolved_needing_review::text      as flagged
        from public.metering_backlog_health();`);

    assert.equal(inside, '1', 'an ambiguous attempt inside the window was not retried');
    assert.equal(identityKept, 'true', 'the retry changed the external identity — Stripe could bill again');
    assert.equal(outside, '0',
      'an attempt older than Stripe’s dedupe window was retried automatically — that can double-bill');
    assert.ok(Number(flagged) >= 1, 'the health check did not flag the stale unresolved attempt for review');
  });

  test('the health check detects a stopped pipeline', () => {
    // Falsification: with bookings sitting pending and old, it must go red.
    reset();
    const [healthy, stuck, ...problem] = row(`
      update public.book_bookings set created_at = now() - interval '3 days'
       where business_id='${BIZ}'::uuid;
      select healthy::text as healthy, stuck_pending::text as stuck, problem
        from public.metering_backlog_health();`);
    assert.equal(healthy, 'false', 'the health check stayed green with a stalled backlog');
    assert.ok(Number(stuck) >= 1, `expected stuck pending bookings, got ${stuck}`);
    assert.match(problem.join('|'), /stopped|stuck|NEEDS A HUMAN/i);
  });
});

// ── 5. Two scans of one ticket ──────────────────────────────────────────────
//
// Was: create events, ticket types, orders and tickets under REAL profiles, race
// two entrances, then delete it all by tag. An interrupted run left whole fake
// events and tickets in production, organised by a real account.

describe('two simultaneous scans of one ticket', () => {
  const TOKEN = '__S4TEST__race';
  let ticketId = '';

  before(() => {
    base();
    const out = raw([
      createTable(BASELINE, 'CREATE TABLE public.events ('),
      'alter table public.events add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.event_ticket_types ('),
      'alter table public.event_ticket_types add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.event_ticket_orders ('),
      'alter table public.event_ticket_orders add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.event_tickets ('),
      'alter table public.event_tickets add primary key (id);',
      createTable(BASELINE, 'CREATE TABLE public.event_checkins ('),
      'alter table public.event_checkins add primary key (id);',
      slice(TICKETIDEM, 'alter table public.event_ticket_orders\n  add column if not exists client_request_id', ';'),
      // can_scan_event falls through to branches that reference these two.
      // plpgsql plans each statement on first execution, so a scanner who is
      // not the organiser reaches them and the missing tables raise.
      createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
      createTable(BASELINE, 'CREATE TABLE public.hub_members ('),
      'create extension if not exists pgcrypto;',
      // The entry point delegates: install the whole chain, not just the door.
      slice(TICKETS, 'create or replace function public.can_scan_event', '$$;'),
      slice(TICKETS, 'create or replace function public.redeem_ticket_atomic', '$$;'),
      slice(TICKETS, 'create or replace function public.validate_and_checkin_ticket(', '$$;'),
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `ticket schema failed:\n${out.slice(0, 1200)}`);

    const f = raw(`
      insert into auth.users(id) values ('${U_SCAN_A}'),('${U_SCAN_B}');
      insert into public.profiles(id, role) values ('${U_SCAN_A}', null),('${U_SCAN_B}', 'admin');
      insert into public.events (id, title, starts_at, organiser_user_id)
        values ('${EV_A}','__S4TEST__ A', now()+interval '7 days','${U_SCAN_A}');
      insert into public.event_ticket_types (id, event_id, name, price_pence, quantity_available, quantity_sold, is_active, per_order_max)
        values ('${TT_A}','${EV_A}','__S4TEST__ tt',1000,500,0,true,10);
      insert into public.event_ticket_orders (id, event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, client_request_id)
        values ('${OR_A}','${EV_A}','${U_SCAN_A}','paid',1000,0,1,'__S4TEST__a');
      insert into public.event_tickets (order_id, event_id, ticket_type_id, holder_id, validation_token_hash, backup_code, status, price_pence)
        values ('${OR_A}','${EV_A}','${TT_A}','${U_SCAN_A}', encode(sha256('${TOKEN}'::bytea),'hex'), 'S4T-race', 'valid', 1000);`);
    assert.doesNotMatch(f, /ERROR/i, `ticket fixtures failed:\n${f.slice(0, 900)}`);
    ticketId = scalar(`select id::text from public.event_tickets where backup_code='S4T-race';`);
    assert.match(ticketId, /^[0-9a-f-]{36}$/, 'fixture ticket was not created');
  });

  test('exactly one entrance admits the attendee', async () => {
    // A redeems and holds its transaction open. B starts while A is still
    // uncommitted, so B is GUARANTEED to read the pre-commit row — the exact
    // interleaving the old code lost. B's conditional UPDATE blocks on A's row
    // lock and, once released, re-tests status against the committed row.
    const [ra, rb] = await race(
      `create temp table _out as select public.validate_and_checkin_ticket('${TOKEN}','${EV_A}','${U_SCAN_A}') ->> 'result' r;`,
      `select public.validate_and_checkin_ticket('${TOKEN}','${EV_A}','${U_SCAN_B}')->>'result' as res;`);

    const results = [ra, rb];
    const wins = results.filter((x) => x === 'valid').length;
    assert.equal(wins, 1,
      `TICKET REDEEMED ${wins} TIMES by simultaneous scans — expected exactly one. Got ${JSON.stringify(results)}`);
    assert.ok(results.includes('already_used'),
      `the losing entrance must be told the ticket is already used, got ${JSON.stringify(results)}`);

    assert.equal(scalar(`select status from public.event_tickets where id='${ticketId}';`), 'used');
    assert.equal(num(`select count(*)::text from public.event_checkins where ticket_id='${ticketId}' and result='valid';`), 1,
      'more than one entrance recorded a valid admission');
    assert.equal(num(`select count(distinct scanner_id)::text from public.event_checkins where ticket_id='${ticketId}' and result='valid';`), 1,
      'two different scanners both recorded a valid admission');
  });
});

// ── 6. A refund racing a scan ───────────────────────────────────────────────
//
// Was: create an event, a ticket type, a paid order and tickets under a REAL
// profile, race a refund against a door scan, then delete it all by tag. Two
// committed connections and a cleanup hook, on production.

describe('a refund and a scan arriving together', () => {
  const ticketSchema = () => [
    createTable(BASELINE, 'CREATE TABLE public.events ('),
    'alter table public.events add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.event_ticket_types ('),
    'alter table public.event_ticket_types add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.event_ticket_orders ('),
    'alter table public.event_ticket_orders add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.event_tickets ('),
    'alter table public.event_tickets add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.event_checkins ('),
    'alter table public.event_checkins add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    createTable(BASELINE, 'CREATE TABLE public.hub_members ('),
    slice(TICKETIDEM, 'alter table public.event_ticket_orders\n  add column if not exists client_request_id', ';'),
    'create extension if not exists pgcrypto;',
    slice(TICKETS, 'create or replace function public.can_scan_event', '$$;'),
    slice(TICKETS, 'create or replace function public.redeem_ticket_atomic', '$$;'),
    slice(TICKETS, 'create or replace function public.validate_and_checkin_ticket(', '$$;'),
  ];

  before(() => {
    base();
    const out = raw([
      ...ticketSchema(),
      slice(STRIPEIDEM, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at', ';'),
      slice(STRIPEIDEM, 'create or replace function public.refund_event_tickets_for_payment', '$$;'),
    ].join('\n'));
    assert.doesNotMatch(out, /ERROR/i, `refund-race schema failed:\n${out.slice(0, 1200)}`);

    const f = raw(`
      insert into auth.users(id) values ('${U_SCAN_A}');
      insert into public.profiles(id, role) values ('${U_SCAN_A}', null);
      insert into public.events (id,title,starts_at,organiser_user_id)
        values ('${EV_R}','__T5R__ race', now()+interval '7 days','${U_SCAN_A}');
      insert into public.event_ticket_types (id,event_id,name,price_pence,quantity_available,quantity_sold,is_active,per_order_max)
        values ('${TT_R}','${EV_R}','__T5R__ tt',1000,100,1,true,10);
      insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,tickets_count,stripe_payment_intent_id,client_request_id,paid_at)
        values ('${OR_R}','${EV_R}','${U_SCAN_A}','paid',1000,0,1,'pi_t_race_seed','__T5R__seed',now());`);
    assert.doesNotMatch(f, /ERROR/i, `refund-race fixtures failed:\n${f.slice(0, 900)}`);
  });

  const seed = (suffix: string) => {
    const o = raw(`
      delete from public.event_checkins where ticket_id in (select id from public.event_tickets where backup_code like 'T5R-%');
      delete from public.event_tickets where backup_code like 'T5R-%';
      update public.event_ticket_orders set status='paid', refunded_at=null,
             stripe_payment_intent_id='pi_t_race_${suffix}' where id='${OR_R}';
      update public.event_ticket_types set quantity_sold=1 where id='${TT_R}';
      insert into public.event_tickets (order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence)
        values ('${OR_R}','${EV_R}','${TT_R}','${U_SCAN_A}',
                encode(sha256('__T5R__tok${suffix}'::bytea),'hex'),'T5R-${suffix}','valid',1000);`);
    assert.doesNotMatch(o, /ERROR/i, `seed ${suffix} failed:\n${o.slice(0, 700)}`);
  };

  test('when the door wins, attendance stands and nothing is voided', async () => {
    seed('A');
    const [sc, rf] = await race(
      `create temp table _out as select public.validate_and_checkin_ticket('__T5R__tokA','${EV_R}','${U_SCAN_A}')->>'result' r;`,
      `select public.refund_event_tickets_for_payment('pi_t_race_A', true)::text as r;`);

    assert.equal(sc, 'valid', 'the scan that started first should have admitted the holder');
    const res = JSON.parse(rf) as Record<string, unknown>;
    assert.equal(res.tickets_voided, 0, 'the refund voided a ticket that had already been used');
    assert.equal(res.tickets_kept_used, 1, 'the refund did not notice the ticket had been used');
    assert.equal(scalar(`select status from public.event_tickets where backup_code='T5R-A';`), 'used',
      'the admitted ticket should stay used');
  });

  test('when the refund wins, the door is closed', async () => {
    seed('B');
    const [rf, sc] = await race(
      `create temp table _out as select public.refund_event_tickets_for_payment('pi_t_race_B', true)::text r;`,
      `select public.validate_and_checkin_ticket('__T5R__tokB','${EV_R}','${U_SCAN_A}')->>'result' as r;`);

    const res = JSON.parse(rf) as Record<string, unknown>;
    assert.equal(res.tickets_voided, 1, 'the refund should have voided the unused ticket');
    assert.equal(sc, 'refunded', `SPLIT BRAIN: the refund voided the ticket but the scanner answered "${sc}"`);
    assert.equal(scalar(`select status from public.event_tickets where backup_code='T5R-B';`), 'refunded');
    assert.equal(num(`select count(*)::text from public.event_checkins c join public.event_tickets t on t.id=c.ticket_id
                        where t.backup_code='T5R-B' and c.result='valid';`), 0,
      'a refunded ticket was recorded as having been admitted');
  });
});

// ── 7. Why these live here ──────────────────────────────────────────────────

describe('the moved proofs cannot reach production', () => {
  test('the lane refuses a Supabase DSN outright', () => {
    assert.ok(!/supabase/i.test(DSN));
  });

  test('every identity they touch is invented', () => {
    assert.match(U_AI, /^bb000000-/);
  });
});

/**
 * gift-funded-booking-status-sync.node.test.ts
 *
 * A gift-funded BOOKING relied on a client-side update, after createBooking()
 * succeeded, to move book_gifts.status from 'claimed' to 'used'. book_gifts
 * has SELECT RLS policies only — no UPDATE policy for the claiming customer
 * — so that update always affected zero rows. Production confirms it: gift
 * abb19ac7-18d4-48d5-810f-3c504e9c7bf0 has a real, fully-reconciled
 * gift-funded booking against it and has sat at status='claimed' ever since
 * it was claimed.
 *
 * 20261025020000_gift_funded_booking_status_sync.sql replaces that dead
 * client update with a server-side trigger, sync_gift_status_with_booking,
 * that runs in the SAME transaction as the booking write — so the flip is
 * atomic with booking creation, not a separate best-effort follow-up call.
 *
 * enforce_gift_funded_booking's own comment already promises the rebooking
 * rule: "A cancelled one does not count, so a cancelled gift booking can be
 * rebooked." Before this fix that promise was accidentally true only because
 * the status update never worked, so the gift never left 'claimed' either.
 * Fixing the atomic 'used' flip without ALSO reverting on cancellation would
 * have broken that promise for real — a gift, once genuinely spent, would
 * never show 'claimed' again even after its one live booking was cancelled.
 * This suite proves creation and cancellation are both covered, and that a
 * REFUSED booking (enforce_gift_funded_booking still raises) leaves the
 * gift's status exactly where it was.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. Schema and every function are read from the real
 * migrations at run time. Nothing in production is ever touched.
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
const VERIFY   = join(MIG, '20260824100000_gift_recipient_verification.sql');
const GIFTLOCK = join(MIG, '20261001120000_gift_booking_lock.sql');
const CAPACITY = join(MIG, '20260926120000_booking_capacity_guard.sql');
const SYNC     = join(MIG, '20261025020000_gift_funded_booking_status_sync.sql');

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
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));

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

const BIZ = 'b1b1b1b1-0000-4000-8000-000000000001';
const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';
const SVC = '5c5c5c5c-0000-4000-8000-000000000005';
const A = 'aaaa0000-0000-4000-8000-00000000000a';   // the claimant
const BGIFT = '22220000-0000-4000-8000-000000000022';
const OTHER_GIFT = '44440000-0000-4000-8000-000000000044';
const TO = 'gift@example.com';

function baseSchema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'create table public.local_businesses (id uuid primary key, owner_id uuid, name text, slug text);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    'alter table public.book_unit_items add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_services ('),
    'alter table public.book_services add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_gifts ('),
    'alter table public.book_gifts add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases ('),
    'alter table public.book_unit_purchases add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_bookings ('),
    'alter table public.book_bookings add primary key (id);',
    createTable(VERIFY, 'create table if not exists public.gift_recipient_verifications'),
    slice(VERIFY, 'create or replace function public.gift_recipient_ok', '$$;'),
    // The hardened, currently-live guard (advisory-locked, one-live-booking-
    // per-gift). Installed in every case below — this suite is about the
    // status sync layered ON TOP of it, not a re-proof of the guard itself
    // (see gift-claim-concurrency.node.test.ts for that).
    slice(GIFTLOCK, 'create or replace function public.enforce_gift_funded_booking', '$$;'),
    slice(GIFTLOCK, 'drop trigger if exists enforce_gift_funded_booking', ';'),
    slice(GIFTLOCK, 'create trigger enforce_gift_funded_booking', ';'),
    slice(CAPACITY, 'create or replace function public.book_capacity_guard', '$$;'),
    slice(CAPACITY, 'drop trigger if exists book_capacity_guard', ';'),
    slice(CAPACITY, 'create trigger book_capacity_guard', ';'),
    // The change under test.
    slice(SYNC, 'create or replace function public.sync_gift_status_with_booking', '$function$;'),
    slice(SYNC, 'drop trigger if exists sync_gift_status_with_booking', ';'),
    slice(SYNC, 'create trigger sync_gift_status_with_booking', ';'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `base schema failed:\n${out.slice(0, 900)}`);
}

function seed() {
  const out = raw(`
    delete from public.book_bookings; delete from public.book_unit_purchases;
    delete from public.gift_recipient_verifications; delete from public.book_gifts;
    delete from public.book_services; delete from public.book_unit_items;
    delete from public.local_businesses; delete from auth.users;
    insert into auth.users (id, email, email_confirmed_at) values
      ('${OWNER}','owner@example.com', now()),
      ('${A}','${TO}', now());
    insert into public.local_businesses (id, owner_id, name, slug)
      values ('${BIZ}','${OWNER}','ZZ Gift Co','zz-gift-co');
    insert into public.book_services (id, business_id, name, duration_minutes, buffer_minutes,
                                      price_pence, deposit_pence, requires_deposit, capacity, is_active)
      values ('${SVC}','${BIZ}','ZZ Service',30,0,4500,0,false,2,true);
    insert into public.book_gifts (id, code, kind, status, business_id, service_id, purchaser_id,
                                   recipient_email, price_paid_pence, claimed_at, claimed_by_user_id)
      values ('${BGIFT}','ZZBOOK-0001','booking','claimed','${BIZ}','${SVC}','${OWNER}','${TO}',4500, now(), '${A}'),
             ('${OTHER_GIFT}','ZZBOOK-0002','booking','claimed','${BIZ}','${SVC}','${OWNER}','${TO}',4500, now(), '${A}');`);
  assert.doesNotMatch(out, /ERROR/i, `seed failed:\n${out.slice(0, 700)}`);
}

const book = (uid: string, gift: string, startsAt: string) => `
  begin; set local request.jwt.claim.sub = '${uid}';
  insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
    values ('${BIZ}','${SVC}','${uid}','${gift}','${startsAt}'::timestamptz, ('${startsAt}'::timestamptz + interval '30 min'), 'confirmed', 0);
  commit;`;

const giftStatus = (gift: string) => scalar(`select status from public.book_gifts where id='${gift}'`);
const giftUsedAt = (gift: string) => scalar(`select coalesce(used_at::text,'') from public.book_gifts where id='${gift}'`);
const liveBookings = (gift: string) =>
  Number(scalar(`select count(*)::text from public.book_bookings where gift_id='${gift}' and status <> 'cancelled'`));

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
});

describe('creating a gift-funded booking atomically marks the gift used', () => {
  before(() => { baseSchema(); seed(); });

  test('gift starts claimed, not used', () => {
    assert.equal(giftStatus(BGIFT), 'claimed');
  });

  test('a successful booking flips the gift to used, with used_at set — no client call needed', () => {
    const out = raw(book(A, BGIFT, '2026-12-01 10:00+00'));
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(giftStatus(BGIFT), 'used');
    assert.notEqual(giftUsedAt(BGIFT), '');
  });

  test('an unrelated gift is untouched by that booking', () => {
    assert.equal(giftStatus(OTHER_GIFT), 'claimed');
  });
});

describe('a REFUSED booking leaves the gift exactly where it was', () => {
  before(() => { baseSchema(); seed(); });

  test('wrong claimant is refused, and the gift stays claimed', () => {
    const STRANGER = 'cccc0000-0000-4000-8000-00000000000c';
    raw(`insert into auth.users (id, email, email_confirmed_at) values ('${STRANGER}','stranger@example.com', now());`);
    const out = raw(book(STRANGER, BGIFT, '2026-12-01 10:00+00'));
    assert.match(out, /gift_not_yours/, out);
    assert.equal(giftStatus(BGIFT), 'claimed', 'a refused booking must not have consumed the gift');
    assert.equal(liveBookings(BGIFT), 0);
  });

  test('a second attempt against an already-booked gift is refused, and the first booking’s "used" status is unchanged', () => {
    raw(book(A, BGIFT, '2026-12-01 10:00+00'));
    assert.equal(giftStatus(BGIFT), 'used');
    const out = raw(book(A, BGIFT, '2026-12-01 11:00+00'));
    assert.match(out, /gift_already_booked/, out);
    assert.equal(giftStatus(BGIFT), 'used', 'the refused second attempt must not have reset or re-dated the gift');
    assert.equal(liveBookings(BGIFT), 1);
  });
});

describe('cancelling the one live booking a gift funds frees the gift for a real rebooking', () => {
  before(() => { baseSchema(); seed(); raw(book(A, BGIFT, '2026-12-02 10:00+00')); });

  test('gift is used while the booking is live', () => {
    assert.equal(giftStatus(BGIFT), 'used');
  });

  test('cancelling the booking reverts the gift to claimed and clears used_at', () => {
    const out = raw(`update public.book_bookings set status='cancelled' where gift_id='${BGIFT}'`);
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(giftStatus(BGIFT), 'claimed');
    assert.equal(giftUsedAt(BGIFT), '');
    assert.equal(liveBookings(BGIFT), 0);
  });

  test('the freed gift can genuinely fund a second, real booking — not just pass validation', () => {
    const out = raw(book(A, BGIFT, '2026-12-02 14:00+00'));
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(giftStatus(BGIFT), 'used', 'the rebooking must re-consume the gift, atomically, same as the first time');
    assert.notEqual(giftUsedAt(BGIFT), '');
    assert.equal(liveBookings(BGIFT), 1);
  });
});

describe('a completed (not cancelled) booking still holds the gift used — only cancellation frees it', () => {
  before(() => { baseSchema(); seed(); raw(book(A, BGIFT, '2026-12-03 10:00+00')); });

  test('marking the booking completed leaves the gift used, not reverted', () => {
    const out = raw(`update public.book_bookings set status='completed' where gift_id='${BGIFT}' and status='confirmed'`);
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(giftStatus(BGIFT), 'used');
  });

  test('and enforce_gift_funded_booking still refuses a second booking against it', () => {
    const out = raw(book(A, BGIFT, '2026-12-04 10:00+00'));
    assert.match(out, /gift_already_booked/, out);
  });
});

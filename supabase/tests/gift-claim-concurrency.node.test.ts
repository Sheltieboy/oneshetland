/**
 * gift-claim-concurrency.node.test.ts — one gift, two hands.
 *
 * TWO QUESTIONS, BOTH ANSWERED BY EXECUTION
 *
 * 1. UNIT GIFT. claim_gift takes SELECT ... FOR UPDATE on the gift row, so two
 *    simultaneous claims should leave exactly one owner and exactly one pass.
 *    Argued in the source since it was written; never run.
 *
 * 2. BOOKING GIFT. enforce_gift_funded_booking allows one live booking per gift
 *    with a check-then-act:
 *
 *        if exists (select 1 from book_bookings
 *                    where gift_id = new.gift_id and status <> 'cancelled')
 *          then raise 'gift_already_booked';
 *
 *    That EXISTS takes no lock, and the trigger locks neither the gift nor the
 *    bookings it counts. On its own that is the same TOCTOU shape as the
 *    booking capacity defect. The preflight flagged it as a candidate; this
 *    settles it rather than assuming either way.
 *
 *    The answer turns on a lock in a DIFFERENT trigger. book_capacity_guard
 *    fires first (triggers run alphabetically: book_booking_transition_guard,
 *    book_capacity_guard, enforce_gift_funded_booking) and takes
 *    pg_advisory_xact_lock on 'book_capacity:' || service_id. A gift is bound to
 *    ONE service — enforce_gift_funded_booking refuses gift_service_mismatch
 *    otherwise — so two bookings funded by one gift are always for the same
 *    service, and always queue behind that lock.
 *
 *    So the suite proves it BOTH ways: with the capacity guard present (real
 *    production), and with it removed. The second is not hypothetical tidiness
 *    — it says whether the gift rule can stand on its own, and therefore
 *    whether re-keying an unrelated lock would silently open this one.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. Schema and every function are read from the real
 * migrations at run time. The live DEMO gift and pass are never touched.
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
const VERIFY = join(MIG, '20260824100000_gift_recipient_verification.sql');
const GIFTGUARD = join(MIG, '20260824140000_gift_funded_booking_guard.sql');
const CAPACITY = join(MIG, '20260926120000_booking_capacity_guard.sql');
const GIFTLOCK = join(MIG, '20261001120000_gift_booking_lock.sql');

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
const ITEM = '17e17e17-0000-4000-8000-000000000017';
const A = 'aaaa0000-0000-4000-8000-00000000000a';   // recipient by confirmed email
const B = 'bbbb0000-0000-4000-8000-00000000000b';   // recipient by consumed challenge
const C = 'cccc0000-0000-4000-8000-00000000000c';   // nobody
const UGIFT = '11110000-0000-4000-8000-000000000011';
const BGIFT = '22220000-0000-4000-8000-000000000022';
const TO = 'gift@example.com';

/** Everything except the guards, which each case installs as it needs. */
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
    slice(VERIFY, 'create or replace function public.claim_gift(', '$$;'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `base schema failed:\n${out.slice(0, 900)}`);
}

const giftGuard = () =>
  slice(GIFTGUARD, 'create or replace function public.enforce_gift_funded_booking', '$$;') + '\n' +
  slice(GIFTGUARD, 'drop trigger if exists enforce_gift_funded_booking', ';') + '\n' +
  slice(GIFTGUARD, 'create trigger enforce_gift_funded_booking', ';');
/** The hardened guard: same rule, now holding its own lock. */
const giftGuardLocked = () =>
  slice(GIFTLOCK, 'create or replace function public.enforce_gift_funded_booking', '$$;') + '\n' +
  slice(GIFTLOCK, 'drop trigger if exists enforce_gift_funded_booking', ';') + '\n' +
  slice(GIFTLOCK, 'create trigger enforce_gift_funded_booking', ';');
const capacityGuard = () =>
  slice(CAPACITY, 'create or replace function public.book_capacity_guard', '$$;') + '\n' +
  slice(CAPACITY, 'drop trigger if exists book_capacity_guard', ';') + '\n' +
  slice(CAPACITY, 'create trigger book_capacity_guard', ';');

function seed(capacity: number) {
  const out = raw(`
    delete from public.book_bookings; delete from public.book_unit_purchases;
    delete from public.gift_recipient_verifications; delete from public.book_gifts;
    delete from public.book_services; delete from public.book_unit_items;
    delete from public.local_businesses; delete from auth.users;
    insert into auth.users (id, email, email_confirmed_at) values
      ('${OWNER}','owner@example.com', now()),
      ('${A}','${TO}', now()),
      ('${B}','someone.b@example.com', now()),
      ('${C}','nobody@example.com', now());
    insert into public.local_businesses (id, owner_id, name, slug)
      values ('${BIZ}','${OWNER}','ZZ Gift Co','zz-gift-co');
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase, valid_days)
      values ('${ITEM}','${BIZ}','ZZ 3 Session Pass',300,3,30);
    insert into public.book_services (id, business_id, name, duration_minutes, buffer_minutes,
                                      price_pence, deposit_pence, requires_deposit, capacity, is_active)
      values ('${SVC}','${BIZ}','ZZ Service',30,0,4500,0,false,${capacity},true);
    insert into public.book_gifts (id, code, kind, status, business_id, unit_item_id, purchaser_id,
                                   recipient_email, price_paid_pence)
      values ('${UGIFT}','ZZUNIT-0001','unit','sent','${BIZ}','${ITEM}','${OWNER}','${TO}',300);
    insert into public.book_gifts (id, code, kind, status, business_id, service_id, purchaser_id,
                                   recipient_email, price_paid_pence, claimed_at, claimed_by_user_id)
      values ('${BGIFT}','ZZBOOK-0001','booking','claimed','${BIZ}','${SVC}','${OWNER}','${TO}',4500, now(), '${A}');
    -- B is authorised for the UNIT gift too, by a consumed challenge, so the
    -- race has two genuinely entitled claimers rather than one and a stranger.
    insert into public.gift_recipient_verifications (gift_id, user_id, email, token_hash, expires_at, consumed_at)
      values ('${UGIFT}','${B}','${TO}','x', now() + interval '1 hour', now());`);
  assert.doesNotMatch(out, /ERROR/i, `seed failed:\n${out.slice(0, 700)}`);
}

const claim = (uid: string, code: string) =>
  `begin; set local request.jwt.claim.sub = '${uid}'; select public.claim_gift('${code}'); commit;`;
const claimHolding = (uid: string, code: string, secs: number) =>
  `begin; set local request.jwt.claim.sub = '${uid}'; select public.claim_gift('${code}'); select pg_sleep(${secs}); commit;`;

const book = (uid: string, startsAt: string) => `
  begin; set local request.jwt.claim.sub = '${uid}';
  insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
    values ('${BIZ}','${SVC}','${uid}','${BGIFT}','${startsAt}'::timestamptz, ('${startsAt}'::timestamptz + interval '30 min'), 'confirmed', 0);
  commit;`;
const bookHolding = (uid: string, startsAt: string, secs: number) => `
  begin; set local request.jwt.claim.sub = '${uid}';
  insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
    values ('${BIZ}','${SVC}','${uid}','${BGIFT}','${startsAt}'::timestamptz, ('${startsAt}'::timestamptz + interval '30 min'), 'confirmed', 0);
  select pg_sleep(${secs}); commit;`;

/** Winner opens and holds its locks; loser starts a beat later and must contend. */
async function race(a: string, b: string) {
  const pa = rawAsync(a);
  await new Promise((r) => setTimeout(r, 800));
  const pb = rawAsync(b);
  return Promise.all([pa, pb]);
}

const liveBookings = () =>
  Number(scalar(`select count(*)::text from public.book_bookings where gift_id='${BGIFT}' and status <> 'cancelled'`));
const passes = () =>
  Number(scalar(`select count(*)::text from public.book_unit_purchases where gift_id='${UGIFT}'`));

let unitRace: string[] = [];
let bothGuards: string[] = [];
let giftGuardAlone: string[] = [];
/* Each stage rebuilds the schema, so its state must be READ while it exists.
   Querying afterwards would ask the last stage's database about the first. */
const unit = { status: '', owner: '', passes: 0, retryPasses: 0, thirdParty: '', passesAfterThirdParty: 0 };
const booking = { withBothGuards: 0, capacity: '', giftGuardOnly: 0, giftGuardOnlyRefusals: 0 };
/* The hardened guard, standing entirely on its own: no capacity guard at all. */
const hardened = { alone: 0, aloneRefusals: 0, refusal: '', differentGiftsBoth: 0, rekeyed: 0, def: '' };

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // ── 1. Unit gift: two entitled claimers, at once ──────────────────────────
  baseSchema();
  seed(2);
  unitRace = await race(claimHolding(A, 'ZZUNIT-0001', 3), claim(B, 'ZZUNIT-0001'));
  unit.status = scalar(`select status from public.book_gifts where id='${UGIFT}'`);
  unit.owner = scalar(`select claimed_by_user_id::text from public.book_gifts where id='${UGIFT}'`);
  unit.passes = passes();
  raw(claim(unit.owner, 'ZZUNIT-0001'));            // the winner, retrying
  unit.retryPasses = passes();
  unit.thirdParty = raw(claim(C, 'ZZUNIT-0001'));   // somebody with no claim on it
  unit.passesAfterThirdParty = passes();

  // ── 2. Booking gift, production as it stands: both guards installed ───────
  baseSchema();
  assert.doesNotMatch(raw(capacityGuard()), /ERROR/i, 'capacity guard did not install');
  assert.doesNotMatch(raw(giftGuard()), /ERROR/i, 'gift guard did not install');
  seed(2);   // capacity 2: capacity alone cannot refuse the second booking
  bothGuards = await race(bookHolding(A, '2026-12-01 10:00+00', 3), book(A, '2026-12-01 11:00+00'));
  booking.withBothGuards = liveBookings();
  booking.capacity = scalar(`select capacity::text from public.book_services where id='${SVC}'`);

  // ── 3. The same race with ONLY the gift guard ─────────────────────────────
  baseSchema();
  assert.doesNotMatch(raw(giftGuard()), /ERROR/i, 'gift guard did not install');
  seed(2);
  giftGuardAlone = await race(bookHolding(A, '2026-12-01 10:00+00', 3), book(A, '2026-12-01 11:00+00'));
  booking.giftGuardOnly = liveBookings();
  booking.giftGuardOnlyRefusals = giftGuardAlone.filter((o) => /ERROR/i.test(o)).length;

  // ── 4. The hardened guard, with NO capacity guard behind it at all ────────
  baseSchema();
  assert.doesNotMatch(raw(giftGuardLocked()), /ERROR/i, 'the hardened guard did not install');
  seed(2);
  const hardRace = await race(bookHolding(A, '2026-12-01 10:00+00', 3), book(A, '2026-12-01 11:00+00'));
  hardened.alone = liveBookings();
  // Read while it is installed. A later test rebuilds the schema with the plain
  // guard, and asking afterwards would describe that one instead.
  hardened.def = raw(`select pg_get_functiondef('public.enforce_gift_funded_booking'::regproc)`);
  const hardRefusals = hardRace.filter((o) => /ERROR/i.test(o));
  hardened.aloneRefusals = hardRefusals.length;
  hardened.refusal = hardRefusals[0] ?? '';

  // ── 5. And with the capacity lock deliberately re-keyed, which used to be
  //       the thing that broke it ───────────────────────────────────────────
  baseSchema();
  raw(capacityGuard().replace(
    "hashtextextended('book_capacity:' || new.service_id::text, 0)",
    "hashtextextended('book_capacity:' || new.service_id::text || new.starts_at::text, 0)"));
  assert.doesNotMatch(raw(giftGuardLocked()), /ERROR/i, 'the hardened guard did not install');
  seed(2);
  await race(bookHolding(A, '2026-12-01 10:00+00', 3), book(A, '2026-12-01 11:00+00'));
  hardened.rekeyed = liveBookings();

  // ── 6. Two DIFFERENT gifts must not wait on each other ────────────────────
  baseSchema();
  assert.doesNotMatch(raw(giftGuardLocked()), /ERROR/i, 'the hardened guard did not install');
  seed(2);
  const GIFT2 = '33330000-0000-4000-8000-000000000033';
  raw(`insert into public.book_gifts (id, code, kind, status, business_id, service_id, purchaser_id,
                                      recipient_email, price_paid_pence, claimed_at, claimed_by_user_id)
       values ('${GIFT2}','ZZBOOK-0002','booking','claimed','${BIZ}','${SVC}','${OWNER}','${TO}',4500, now(), '${B}');`);
  const two = await Promise.all([
    rawAsync(`begin; insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
                values ('${BIZ}','${SVC}','${A}','${BGIFT}','2026-12-08 10:00+00'::timestamptz,'2026-12-08 10:30+00'::timestamptz,'confirmed',0); commit;`),
    rawAsync(`begin; insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
                values ('${BIZ}','${SVC}','${B}','${GIFT2}','2026-12-08 11:00+00'::timestamptz,'2026-12-08 11:30+00'::timestamptz,'confirmed',0); commit;`),
  ]);
  void two;
  hardened.differentGiftsBoth = Number(scalar(
    `select count(*)::text from public.book_bookings where gift_id in ('${BGIFT}','${GIFT2}') and status <> 'cancelled'`));
});

describe('CASE 1 — one unit gift, two entitled claimers, at the same moment', () => {
  test('exactly one claim succeeded', () => {
    const failures = unitRace.filter((o) => /ERROR/i.test(o)).length;
    assert.equal(failures, 1, `expected one refusal; outputs:\n${unitRace.join('\n---\n')}`);
  });

  test('the loser is told it is already claimed', () => {
    const loser = unitRace.find((o) => /ERROR/i.test(o)) ?? '';
    assert.match(loser, /gift_already_claimed/, 'the second claimer was refused for the wrong reason');
  });

  test('one owner holds it, and the gift is used', () => {
    assert.equal(unit.status, 'used');
    assert.ok([A, B].includes(unit.owner), `unexpected owner ${unit.owner}`);
  });

  test('EXACTLY ONE pass was created', () => {
    assert.equal(unit.passes, 1, 'a second pass was spawned by the losing claim');
  });

  test('a retry by the same winner is idempotent — still one pass', () => {
    assert.equal(unit.retryPasses, 1, 'a retry minted a second pass');
  });

  test('an unauthorised third party is refused outright', () => {
    assert.match(unit.thirdParty, /gift_already_claimed|gift_recipient_verification_required/);
    assert.equal(unit.passesAfterThirdParty, 1);
  });
});

describe('CASE 2 — booking gift, production as it stands', () => {
  test('only one booking survives', () => {
    assert.equal(booking.withBothGuards, 1,
      'one gift funded two live bookings — the race is real in production');
  });

  test('and the second was refused, not silently dropped', () => {
    const refusals = bothGuards.filter((o) => /ERROR/i.test(o));
    assert.equal(refusals.length, 1, `expected exactly one refusal:\n${bothGuards.join('\n---\n')}`);
    assert.match(refusals[0], /gift_already_booked/, 'refused for something other than the gift rule');
  });

  test('capacity was NOT what refused it — the service had room for two', () => {
    assert.equal(booking.capacity, '2');
    const refusals = bothGuards.filter((o) => /ERROR/i.test(o));
    assert.doesNotMatch(refusals[0] ?? '', /slot_full/, 'the capacity guard refused it, so this proves nothing about the gift rule');
  });
});

describe('CASE 3 — the same race with the gift guard ALONE', () => {
  // This is the mutation that matters: remove the lock that is doing the work
  // and the rule underneath fails. It says the gift guard cannot stand alone,
  // and therefore exactly what is protecting production.
  test('BOTH bookings succeed — the gift rule cannot stand on its own', () => {
    assert.equal(booking.giftGuardOnly, 2,
      'if this is 1, the gift guard now protects itself and this suite is out of date');
    assert.equal(booking.giftGuardOnlyRefusals, 0, 'nothing was refused, as expected of a check-then-act');
  });

  test('so the capacity guard must fire BEFORE it — the order is load-bearing', () => {
    // Triggers fire alphabetically. If the gift guard ever sorted first, its
    // EXISTS would run before the capacity lock was taken and the race reopens.
    assert.ok('book_capacity_guard' < 'enforce_gift_funded_booking',
      'the two trigger names no longer sort in the order this protection needs');
  });

  test('the ORIGINAL guard is a check-then-act with no lock of its own', () => {
    // Asserted against the migration that shipped it, not the installed
    // function: 20261001120000 now hardens it, and this records what it was.
    const original = slice(GIFTGUARD, 'create or replace function public.enforce_gift_funded_booking', '$$;');
    assert.match(original, /if exists \(/i, 'the one-live-booking rule is no longer an EXISTS');
    assert.doesNotMatch(original, /pg_advisory_xact_lock/, 'the original already locked — this suite needs updating');
  });

  test('the capacity guard is what serialises them, keyed on the service', () => {
    const def = src(CAPACITY);
    assert.match(def, /pg_advisory_xact_lock\(\s*hashtextextended\('book_capacity:' \|\| new\.service_id::text, 0\)\)/,
      'the lock that protects the gift rule has moved or been re-keyed');
  });

  // Asserted by behaviour, not by the name of an exception: renaming the error
  // string left an earlier version of this test passing, which proved nothing.
  test('and a gift can only ever fund bookings for its own service', () => {
    baseSchema();
    raw(capacityGuard()); raw(giftGuard());
    seed(2);
    const OTHER_SVC = '9d9d9d9d-0000-4000-8000-000000000009';
    raw(`insert into public.book_services (id, business_id, name, duration_minutes, buffer_minutes,
                                           price_pence, deposit_pence, requires_deposit, capacity, is_active)
         values ('${OTHER_SVC}','${BIZ}','ZZ Other Service',30,0,4500,0,false,2,true);`);
    const out = raw(`
      begin; set local request.jwt.claim.sub = '${A}';
      insert into public.book_bookings (business_id, service_id, customer_id, gift_id, starts_at, ends_at, status, price_pence)
        values ('${BIZ}','${OTHER_SVC}','${A}','${BGIFT}','2026-12-05 10:00+00'::timestamptz,
                '2026-12-05 10:30+00'::timestamptz,'confirmed',0);
      commit;`);
    assert.match(out, /ERROR/i,
      'a gift funded a booking for a service it was not bought for — and would never share that service\'s capacity lock');
    assert.equal(Number(scalar(`select count(*)::text from public.book_bookings where gift_id='${BGIFT}'`)), 0);
  });
});

describe('cancelled bookings still release the gift', () => {
  before(() => {
    baseSchema();
    raw(capacityGuard()); raw(giftGuard());
    seed(2);
    raw(book(A, '2026-12-02 10:00+00'));
    raw(`update public.book_bookings set status='cancelled' where gift_id='${BGIFT}'`);
  });

  test('a cancelled booking does not hold the gift', () => {
    assert.equal(liveBookings(), 0);
    const out = raw(book(A, '2026-12-02 14:00+00'));
    assert.doesNotMatch(out, /gift_already_booked/, 'a cancelled booking still blocked a rebooking');
    assert.equal(liveBookings(), 1);
  });

  test('but a completed or no-show one does', () => {
    raw(`update public.book_bookings set status='completed' where gift_id='${BGIFT}' and status='confirmed'`);
    const out = raw(book(A, '2026-12-03 10:00+00'));
    assert.match(out, /gift_already_booked/, 'a completed appointment released the gift for a second booking');
  });
});

describe('CASE 4 — the hardened guard, standing on its own', () => {
  test('with NO capacity guard at all, only one booking survives', () => {
    assert.equal(hardened.alone, 1,
      'the gift-scoped lock did not serialise two attempts to spend one gift');
  });

  test('and the second is refused by the gift rule itself', () => {
    assert.equal(hardened.aloneRefusals, 1);
    assert.match(hardened.refusal, /gift_already_booked/);
    assert.doesNotMatch(hardened.refusal, /slot_full/, 'capacity cannot be what refused it — there is no capacity guard');
  });

  test('it still holds when the capacity lock is re-keyed', () => {
    // This is the exact change that broke the old arrangement.
    assert.equal(hardened.rekeyed, 1,
      're-keying an unrelated lock still decides whether a gift can be spent twice');
  });

  test('service capacity was 2, so capacity could not have refused anything', () => {
    assert.equal(booking.capacity, '2');
  });

  test('the lock is keyed on the gift, not the service', () => {
    assert.match(hardened.def, /pg_advisory_xact_lock\(\s*hashtextextended\('gift_booking:' \|\| new\.gift_id::text, 0\)\)/);
    assert.doesNotMatch(hardened.def, /gift_booking:' \|\| new\.service_id/, 'the lock must not be service-scoped');
  });

  test('and it is taken before the count it protects', () => {
    const lock = hardened.def.indexOf('pg_advisory_xact_lock');
    const exists = hardened.def.indexOf('gift_already_booked');
    assert.ok(lock !== -1 && exists !== -1, 'the hardened function was not installed');
    assert.ok(lock < exists, 'the lock must come before the EXISTS, or it protects nothing');
  });
});

describe('CASE 5 — unrelated gifts do not wait on each other', () => {
  test('two different gifts both book, concurrently', () => {
    assert.equal(hardened.differentGiftsBoth, 2,
      'the gift lock is serialising unrelated gifts — it is keyed too widely');
  });
});

describe('CASE 6 — cancellation still releases the gift, with the lock in place', () => {
  before(() => {
    baseSchema();
    raw(giftGuardLocked());
    seed(2);
    raw(book(A, '2026-12-09 10:00+00'));
    raw(`update public.book_bookings set status='cancelled' where gift_id='${BGIFT}'`);
  });

  test('a cancelled booking frees the gift for rebooking', () => {
    assert.equal(liveBookings(), 0);
    const out = raw(book(A, '2026-12-09 14:00+00'));
    assert.doesNotMatch(out, /gift_already_booked/, 'a cancelled booking still blocked a rebooking');
    assert.equal(liveBookings(), 1);
  });

  test('and a completed one still holds it', () => {
    raw(`update public.book_bookings set status='completed' where gift_id='${BGIFT}' and status='confirmed'`);
    const out = raw(book(A, '2026-12-10 10:00+00'));
    assert.match(out, /gift_already_booked/, 'a completed appointment released the gift');
  });
});

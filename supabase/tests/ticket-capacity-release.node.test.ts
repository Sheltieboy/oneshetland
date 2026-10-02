/**
 * ticket-capacity-release.node.test.ts
 *
 * A refunded ticket kept its seat. refund_event_tickets_for_payment voided the
 * ticket but never touched event_ticket_types.quantity_sold — the counter
 * reserve_ticket_basket gates every sale on — nor events.tickets_sold. On a
 * capacity-limited event a customer who had been refunded in full still held a
 * seat and the next customer was turned away. Live, after a Wallet-funded refund:
 * "TEST — Paid Entry" read 1 of 2 sold with no live ticket, and two events showed
 * 3 sold against 2 live tickets.
 *
 * This runs the REAL migrated functions (20261030000000_refund_releases_capacity.sql)
 * plus the real reserve/release functions they work with, in an isolated Postgres, and
 * proves:
 *
 *   · a full refund releases its seats once — and a refunded ticket no longer blocks
 *     a replacement sale
 *   · card and Wallet refunds behave identically (both reach the same function)
 *   · a duplicate or retried refund releases nothing more, and the count can never
 *     go negative
 *   · a CHECKED-IN ticket keeps its seat, and checking in releases nothing
 *   · free and paid ticket types in one order are each released correctly
 *   · the counters cannot stay wrong: the recount heals historical drift, touches
 *     nothing it should not, and is idempotent
 *   · the capacity CHECK does not trust the counter: a stale one cannot refuse a
 *     sale it should accept or accept one it should refuse
 *   · the statements other suites pin in reserve_ticket_basket are still there
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written, no auth user is
 * created, no service key is used.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const BASKET = join(MIG, '20260819220000_atomic_ticket_basket.sql');
const TICKETIDEM = join(MIG, '20260819260000_ticket_checkout_idempotency.sql');
const STRIPEIDEM = join(MIG, '20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');
const TICKETS = join(MIG, '20260820120000_atomic_ticket_redemption.sql');
const UNDER_TEST = join(MIG, '20261030000000_refund_releases_capacity.sql');

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
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));

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

const EV = '71710000-0000-4000-8000-000000000071';
const EV_OTHER = '71710000-0000-4000-8000-000000000072';
const TT_PAID = '81810000-0000-4000-8000-000000000081';     // capacity 1
const TT_FREE = '81810000-0000-4000-8000-000000000082';     // capacity 5
const TT_OPEN = '81810000-0000-4000-8000-000000000083';     // unlimited
const TT_OTHER = '81810000-0000-4000-8000-000000000084';
const B1 = 'd0000000-0000-4000-8000-0000000000d1';
const B2 = 'd0000000-0000-4000-8000-0000000000d2';
const B3 = 'd0000000-0000-4000-8000-0000000000d3';

function schema() {
  // The migration under test, minus its cron line (no pg_cron here); the one-off
  // heal at its end is exercised explicitly below.
  const migration = src(UNDER_TEST);
  const upto = migration.indexOf('-- Self-heal.');
  assert.notEqual(upto, -1, 'the migration lost its self-heal section');
  assert.match(migration.slice(upto), /cron\.schedule\(\s*'ticket-counter-selfheal',\s*'\*\/15 \* \* \* \*'/);

  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'grant usage on schema public to anon, authenticated, service_role;',
    ...['events', 'event_ticket_types', 'event_ticket_orders', 'event_tickets']
      .flatMap((t) => [createTable(BASELINE, `CREATE TABLE public.${t} (`), `alter table public.${t} add primary key (id);`]),
    slice(TICKETIDEM, 'alter table public.event_ticket_orders\n  add column if not exists client_request_id', ';'),
    slice(TICKETIDEM, 'create unique index if not exists event_ticket_orders_buyer_request_key', ';'),
    slice(STRIPEIDEM, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at', ';'),
    slice(BASELINE, 'CREATE FUNCTION public.generate_ticket_backup_code', '$$;'),
    slice(BASKET, 'create or replace function public.release_ticket_order', '$$;'),
    migration.slice(0, upto),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1800)}`);
}

const reset = () => {
  const o = raw(`
    delete from public.event_tickets; delete from public.event_ticket_orders;
    delete from public.event_ticket_types; delete from public.events;
    insert into public.events (id, title, starts_at, status, tickets_sold, capacity) values
      ('${EV}','Gig', now() + interval '10 days','published', 0, null),
      ('${EV_OTHER}','Other gig', now() + interval '10 days','published', 0, 50);
    insert into public.event_ticket_types (id, event_id, name, price_pence, quantity_available, quantity_sold, is_active, per_order_max) values
      ('${TT_PAID}','${EV}','Paid',100, 1, 0, true, 10),
      ('${TT_FREE}','${EV}','Free',0, 5, 0, true, 10),
      ('${TT_OPEN}','${EV}','Open',100, null, 0, true, 10),
      ('${TT_OTHER}','${EV_OTHER}','Other',100, 10, 0, true, 10);`);
  assert.doesNotMatch(o, /ERROR/i, `reset failed:\n${o.slice(0, 800)}`);
};

let seq = 0;
/** Reserve a basket through the real function. Returns the order id, or the error text. */
function reserve(buyer: string, lines: Record<string, number>, event = EV): { ok: true; order: string } | { ok: false; error: string } {
  seq += 1;
  const tickets = Object.entries(lines).flatMap(([tt, n]) =>
    Array.from({ length: n }, (_, i) => `{"ticket_type_id":"${tt}","token_hash":"${'a'.repeat(40)}${seq}${i}${tt.slice(-3)}"}`));
  const out = raw(`select public.reserve_ticket_basket('${event}','${buyer}','[${tickets.join(',')}]'::jsonb,196,96,'{}'::jsonb,'req-${seq}-abcdefgh')->>'order_id';`);
  const v = value(out);
  return /^[0-9a-f-]{36}$/.test(v) ? { ok: true, order: v } : { ok: false, error: out };
}
/** What the payment handlers do once the money is in: order paid, tickets valid, counter nudged. */
function pay(order: string, ref: string, event = EV) {
  const o = raw(`
    update public.event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='${ref}' where id='${order}';
    update public.event_tickets set status='valid' where order_id='${order}';
    select public.increment_event_tickets_sold('${event}', 1);`);
  assert.doesNotMatch(o, /ERROR/i, `pay failed:\n${o.slice(0, 500)}`);
}
const refund = (ref: string, full = true) => JSON.parse(scalar(`select public.refund_event_tickets_for_payment('${ref}', ${full})::text;`)) as Record<string, unknown>;
const sold = (tt: string) => num(`select quantity_sold from public.event_ticket_types where id='${tt}';`);
const evSold = (ev = EV) => num(`select tickets_sold from public.events where id='${ev}';`);
const buy = (buyer: string, lines: Record<string, number>, ref: string) => {
  const r = reserve(buyer, lines);
  assert.ok(r.ok, `reserve failed: ${(r as { error?: string }).error}`);
  pay((r as { order: string }).order, ref);
  return (r as { order: string }).order;
};

describe('a refund gives its seat back', () => {
  before(schema);
  beforeEach(reset);

  test('a sold-out type refuses the next buyer; a full refund releases the seat; the replacement sale then goes through', () => {
    const a = buy(B1, { [TT_PAID]: 1 }, 'pi_a');
    assert.equal(sold(TT_PAID), 1);
    const refusedBefore = reserve(B2, { [TT_PAID]: 1 });
    assert.ok(!refusedBefore.ok && /SOLD_OUT/.test(refusedBefore.error), 'the type was full but the sale was not refused');

    const r = refund('pi_a');
    assert.equal(r.action, 'refunded');
    assert.equal(r.capacity_changed, true);
    assert.equal(r.capacity_released, 1);
    assert.equal(sold(TT_PAID), 0, 'the refunded seat stayed taken');
    assert.equal(evSold(), 0);
    assert.equal(scalar(`select status from public.event_tickets where order_id='${a}';`), 'refunded');

    const replacement = reserve(B2, { [TT_PAID]: 1 });
    assert.ok(replacement.ok, `the released seat could not be resold: ${(replacement as { error?: string }).error}`);
    assert.equal(sold(TT_PAID), 1, 'the resale did not take the seat');
  });

  test('card and Wallet refunds behave identically: both release, both reach the same function', () => {
    buy(B1, { [TT_FREE]: 1 }, 'pi_card');
    buy(B2, { [TT_FREE]: 1 }, 'wallet_8423a6e9-708d-4482-834e-7ba56609d88b');
    assert.equal(sold(TT_FREE), 2);
    const card = refund('pi_card');
    const wallet = refund('wallet_8423a6e9-708d-4482-834e-7ba56609d88b');
    for (const r of [card, wallet]) assert.deepEqual([r.action, r.capacity_released], ['refunded', 1]);
    assert.equal(sold(TT_FREE), 0);
    assert.equal(evSold(), 0);
  });

  test('a DUPLICATE or retried refund releases nothing more — however many times it arrives', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_dup');
    buy(B2, { [TT_FREE]: 2 }, 'pi_keep');
    assert.equal(sold(TT_PAID), 1);
    refund('pi_dup');
    for (let i = 0; i < 4; i++) {
      const again = refund('pi_dup');
      assert.equal(again.action, 'already_refunded');
      assert.equal(again.capacity_changed, undefined);
    }
    assert.equal(sold(TT_PAID), 0);
    assert.equal(sold(TT_FREE), 2, 'another order\'s seats were released by a repeat');
    assert.equal(evSold(), 2);
  });

  test('the count can never go negative, even from a counter that was already too low', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_low');
    raw(`update public.event_ticket_types set quantity_sold = 0 where id='${TT_PAID}'; update public.events set tickets_sold = 0 where id='${EV}';`);
    refund('pi_low');
    refund('pi_low');
    assert.equal(sold(TT_PAID), 0);
    assert.ok(evSold() >= 0 && sold(TT_PAID) >= 0);
    // and even when something wrote a negative
    raw(`update public.event_ticket_types set quantity_sold = -3 where id='${TT_FREE}';`);
    raw(`select public.refresh_event_ticket_counters();`);
    assert.equal(sold(TT_FREE), 0);
  });

  test('a CHECKED-IN ticket keeps its seat: refunding the order voids only the unused ticket', () => {
    const o = buy(B1, { [TT_FREE]: 2 }, 'pi_mixed');
    assert.equal(sold(TT_FREE), 2);
    raw(`update public.event_tickets set status='used', checked_in_at=now()
          where id = (select id from public.event_tickets where order_id='${o}' order by created_at, id limit 1);`);
    assert.equal(sold(TT_FREE), 2, 'checking a ticket in released a seat');
    assert.equal(evSold(), 2, 'checking a ticket in changed the sold count');

    const r = refund('pi_mixed');
    assert.equal(r.tickets_voided, 1);
    assert.equal(r.tickets_kept_used, 1);
    assert.equal(r.capacity_released, 1);
    assert.equal(sold(TT_FREE), 1, 'the person who attended lost their sale');
    assert.equal(evSold(), 1);
    assert.equal(num(`select count(*) from public.event_tickets where order_id='${o}' and status='used';`), 1);
  });

  test('a refund where every ticket was already checked in releases nothing', () => {
    const o = buy(B1, { [TT_PAID]: 1 }, 'pi_allused');
    raw(`update public.event_tickets set status='used', checked_in_at=now() where order_id='${o}';`);
    const r = refund('pi_allused');
    assert.equal(r.tickets_voided, 0);
    assert.equal(r.capacity_changed, false);
    assert.equal(sold(TT_PAID), 1);
  });

  test('free and paid types in ONE order are each released by their own count', () => {
    buy(B1, { [TT_PAID]: 1, [TT_FREE]: 3, [TT_OPEN]: 2 }, 'pi_basket');
    buy(B2, { [TT_FREE]: 1 }, 'pi_other');
    assert.deepEqual([sold(TT_PAID), sold(TT_FREE), sold(TT_OPEN)], [1, 4, 2]);
    const r = refund('pi_basket');
    assert.equal(r.capacity_released, 6);
    assert.deepEqual([sold(TT_PAID), sold(TT_FREE), sold(TT_OPEN)], [0, 1, 0], 'the other buyer\'s seat must be untouched');
    assert.equal(evSold(), 1);
  });

  test('a PARTIAL refund releases nothing — the schema cannot say which tickets it covers', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_partial');
    const r = refund('pi_partial', false);
    assert.equal(r.action, 'partial_refund_not_mapped');
    assert.equal(sold(TT_PAID), 1);
    assert.equal(scalar(`select status from public.event_tickets where backup_code is not null and ticket_type_id='${TT_PAID}';`), 'valid');
  });

  test('a refund of one event never touches another event\'s counters', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_here');
    const other = reserve(B3, { [TT_OTHER]: 2 }, EV_OTHER);
    assert.ok(other.ok);
    pay((other as { order: string }).order, 'pi_there', EV_OTHER);
    refund('pi_here');
    assert.equal(sold(TT_OTHER), 2);
    assert.equal(evSold(EV_OTHER), 2, 'the other event still has its two live tickets');
  });
});

describe('abandoned reservations still behave as they did', () => {
  before(schema);
  beforeEach(reset);

  test('a pending reservation holds its seat, and releasing it gives the seat back exactly once', () => {
    const r = reserve(B1, { [TT_PAID]: 1 });
    assert.ok(r.ok);
    assert.equal(sold(TT_PAID), 1);
    const full = reserve(B2, { [TT_PAID]: 1 });
    assert.ok(!full.ok && /SOLD_OUT/.test(full.error));
    assert.equal(scalar(`select public.release_ticket_order('${(r as { order: string }).order}')::text;`), 'true');
    assert.equal(sold(TT_PAID), 0);
    assert.equal(scalar(`select public.release_ticket_order('${(r as { order: string }).order}')::text;`), 'false');
    assert.equal(sold(TT_PAID), 0);
    assert.ok(reserve(B2, { [TT_PAID]: 1 }).ok);
  });
});

describe('the counters cannot stay wrong', () => {
  before(schema);
  beforeEach(reset);

  test('the recount heals historical drift — the live pattern: one refunded ticket still counted — and nothing else', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_hist');
    // Reproduce the old behaviour: the ticket was voided, the counters were left alone.
    raw(`update public.event_tickets set status='refunded' where ticket_type_id='${TT_PAID}';
         update public.event_ticket_orders set status='refunded' where stripe_payment_intent_id='pi_hist';`);
    assert.equal(sold(TT_PAID), 1);
    assert.equal(evSold(), 1);
    // an unrelated event with correct figures, and unrelated columns that must not move
    raw(`update public.events set tickets_sold=7, capacity=50, title='Keep me' where id='${EV_OTHER}';`);
    const before = scalar(`select md5(row(title, capacity, status, starts_at)::text) from public.events where id='${EV_OTHER}';`);
    const otherTypeBefore = scalar(`select md5(t::text) from public.event_ticket_types t where id='${TT_OTHER}';`);

    const out = JSON.parse(scalar(`select public.refresh_event_ticket_counters()::text;`)) as Record<string, number>;
    assert.equal(out.types_corrected, 1);
    assert.equal(sold(TT_PAID), 0);
    assert.equal(evSold(), 0);
    assert.equal(scalar(`select md5(row(title, capacity, status, starts_at)::text) from public.events where id='${EV_OTHER}';`), before, 'an unrelated event column moved');
    assert.equal(scalar(`select md5(t::text) from public.event_ticket_types t where id='${TT_OTHER}';`), otherTypeBefore, 'an unrelated ticket type moved');
    // (the other event had 7 sold with NO tickets: it has a ticket type, so it is corrected to the truth, 0)
    assert.equal(evSold(EV_OTHER), 0);
  });

  test('it is idempotent: a second run corrects nothing', () => {
    buy(B1, { [TT_FREE]: 2 }, 'pi_x');
    raw(`update public.event_ticket_types set quantity_sold = 9;`);
    const first = JSON.parse(scalar(`select public.refresh_event_ticket_counters()::text;`)) as Record<string, number>;
    assert.ok(first.types_corrected >= 1);
    const second = JSON.parse(scalar(`select public.refresh_event_ticket_counters()::text;`)) as Record<string, number>;
    assert.deepEqual(second, { types_corrected: 0, events_corrected: 0 });
  });

  test('it can be scoped to one event', () => {
    raw(`update public.event_ticket_types set quantity_sold = 9;`);
    raw(`select public.refresh_event_ticket_counters('${EV}');`);
    assert.equal(sold(TT_PAID), 0);
    assert.equal(sold(TT_OTHER), 9, 'an event it was not asked about was touched');
  });

  test('events without ticket types are not touched at all', () => {
    raw(`insert into public.events (id,title,starts_at,status,tickets_sold) values ('71710000-0000-4000-8000-000000000099','No tickets',now(),'published', 12);`);
    raw(`select public.refresh_event_ticket_counters();`);
    assert.equal(evSold('71710000-0000-4000-8000-000000000099'), 12);
  });

  test('increment_event_tickets_sold recounts instead of adding: calling it again and again cannot inflate the figure', () => {
    buy(B1, { [TT_FREE]: 2 }, 'pi_inc');
    assert.equal(evSold(), 2);
    for (let i = 0; i < 5; i++) raw(`select public.increment_event_tickets_sold('${EV}', 2);`);
    assert.equal(evSold(), 2);
  });

  test('the self-heal and the held-seat definition are not callable by anon or signed-in users', () => {
    for (const fn of ['public.refresh_event_ticket_counters(uuid)', 'public.ticket_type_held(uuid)']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(scalar(`select has_function_privilege('${role}', '${fn}', 'execute')::text;`), 'false', `${role} can run ${fn}`);
      }
      assert.equal(scalar(`select has_function_privilege('service_role', '${fn}', 'execute')::text;`), 'true');
    }
  });
});

describe('the capacity check does not trust the counter', () => {
  before(schema);
  beforeEach(reset);

  test('a counter that is too HIGH (the live defect) does not refuse a sale the rows allow', () => {
    raw(`update public.event_ticket_types set quantity_sold = 1 where id='${TT_PAID}';`);   // no live ticket holds it
    const r = reserve(B1, { [TT_PAID]: 1 });
    assert.ok(r.ok, `a stale counter blocked a sale: ${(r as { error?: string }).error}`);
    assert.equal(sold(TT_PAID), 1);
  });

  test('a counter that is too LOW cannot oversell: the seat the rows hold is still held', () => {
    buy(B1, { [TT_PAID]: 1 }, 'pi_held');
    raw(`update public.event_ticket_types set quantity_sold = 0 where id='${TT_PAID}';`);
    const r = reserve(B2, { [TT_PAID]: 1 });
    assert.ok(!r.ok && /SOLD_OUT/.test(r.error), 'a drifted-low counter sold a seat that was already sold');
    // A refused sale is an aborted transaction, so the correction it made is rolled back with it:
    // the refusal is right regardless, and the recount (every 15 minutes) puts the figure right.
    raw(`select public.refresh_event_ticket_counters();`);
    assert.equal(sold(TT_PAID), 1);
  });

  test('an unlimited type is unaffected by all of it', () => {
    for (let i = 0; i < 4; i++) assert.ok(reserve(B1, { [TT_OPEN]: 3 }).ok);
    assert.equal(sold(TT_OPEN), 12);
  });

  test('the statements other suites pin in reserve_ticket_basket are still in place, in order', () => {
    const body = scalar(`select replace(prosrc, E'\\n', ' ') from pg_proc where proname='reserve_ticket_basket';`);
    const heal = body.indexOf('set quantity_sold = public.ticket_type_held(tt.id)');
    const check = body.indexOf('(l.quantity_available - l.quantity_sold) < w.qty');
    const claim = body.indexOf('insert into public.event_ticket_orders');
    const commit = body.indexOf('set quantity_sold = tt.quantity_sold + w.qty');
    assert.ok(heal !== -1 && check !== -1 && claim !== -1 && commit !== -1, 'a pinned statement is missing');
    assert.ok(heal < check, 'the counter must be made true BEFORE it is judged');
    assert.ok(check < claim && claim < commit, 'the order is claimed before any counter moves');
  });
});

describe('the migration, as written', () => {
  const sql = src(UNDER_TEST);
  const refundFn = sql.slice(sql.toLowerCase().indexOf('create or replace function public.refund_event_tickets_for_payment')).toLowerCase();

  test('the old "capacity is deliberately NOT returned" policy is gone from the refund function', () => {
    assert.doesNotMatch(refundFn, /capacity is deliberately not returned/);
    assert.match(refundFn, /'capacity_changed', v_voided > 0/);
  });

  test('the ticket types are locked before the tickets, in id order — the order a sale uses', () => {
    const lock = refundFn.indexOf('for update;');
    const voidAt = refundFn.search(/set status = 'refunded'\s+where order_id = v_order\.id\s+and status\s+= 'valid'/);
    assert.ok(lock !== -1 && voidAt !== -1 && lock < voidAt, 'the type lock must precede the ticket update');
    assert.match(refundFn.slice(0, lock + 12), /order by tt\.id\s+for update/);
  });

  test('the self-heal is scheduled in-database every 15 minutes and the one-off heal runs at the end', () => {
    assert.match(sql, /cron\.schedule\(\s*'ticket-counter-selfheal',\s*'\*\/15 \* \* \* \*',\s*\$cron\$ select public\.refresh_event_ticket_counters\(\); \$cron\$\s*\);/);
    assert.match(sql.trimEnd(), /select public\.refresh_event_ticket_counters\(\);$/);
  });
});

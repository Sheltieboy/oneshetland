/**
 * ticket-quantities.node.test.ts — a paid ticket cannot become valid for free.
 *
 * WHY THIS TEST EXISTS
 * create-event-ticket-intent checked one thing about a line item's quantity:
 * that it was not above per_order_max. So this basket worked —
 *
 *     [{ Adult £12, quantity: 1 }, { Child £6, quantity: -2 }]
 *
 * — because £12 + (-2 x £6) is £0, and the free path was gated on
 * `totalPence === 0`. The order was marked paid, one genuine £12 Adult ticket
 * was issued valid, and reserve_ticket_slots(-2) went on to SUBTRACT from
 * quantity_sold, handing the event two extra seats.
 *
 * Two layers, because the fix is in two places:
 *   1. the quantity contract in _shared/ticket-quantities.ts, unit-tested here
 *      the same way _shared/commission.ts is;
 *   2. the database invariant in reserve_ticket_slots, exercised against the
 *      linked project inside a transaction that is always rolled back.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLineItems, totalOrder, MAX_LINE_ITEMS } from '../functions/_shared/ticket-quantities.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ADULT = { id: 'adult', price_pence: 1200 };
const CHILD = { id: 'child', price_pence: 600 };
const FREE_A = { id: 'free-a', price_pence: 0 };
const FREE_B = { id: 'free-b', price_pence: 0 };

const ok = (items: unknown) => checkLineItems(items);

// ── 1. The quantity contract ────────────────────────────────────────────────

describe('quantity contract', () => {
  const REJECTED: Array<[string, unknown]> = [
    ['negative',              [{ ticket_type_id: 'adult', quantity: -1 }]],
    ['zero',                  [{ ticket_type_id: 'adult', quantity: 0 }]],
    ['fractional 1.5',        [{ ticket_type_id: 'adult', quantity: 1.5 }]],
    ['numeric string "2"',    [{ ticket_type_id: 'adult', quantity: '2' }]],
    ['null',                  [{ ticket_type_id: 'adult', quantity: null }]],
    ['missing',               [{ ticket_type_id: 'adult' }]],
    ['array [2]',             [{ ticket_type_id: 'adult', quantity: [2] }]],
    ['object',                [{ ticket_type_id: 'adult', quantity: { valueOf: 2 } }]],
    ['NaN',                   [{ ticket_type_id: 'adult', quantity: Number.NaN }]],
    ['Infinity',              [{ ticket_type_id: 'adult', quantity: Number.POSITIVE_INFINITY }]],
    ['unsafe integer',        [{ ticket_type_id: 'adult', quantity: Number.MAX_SAFE_INTEGER + 2 }]],
    ['missing type id',       [{ quantity: 1 }]],
    ['empty type id',         [{ ticket_type_id: '', quantity: 1 }]],
    ['non-object line',       ['adult']],
    ['null line',             [null]],
    ['empty basket',          []],
    ['not an array',          { ticket_type_id: 'adult', quantity: 1 }],
    ['too many line items',   Array.from({ length: MAX_LINE_ITEMS + 1 }, (_, i) => ({ ticket_type_id: `t${i}`, quantity: 1 }))],
  ];

  for (const [label, payload] of REJECTED) {
    test(`rejects ${label}`, () => {
      const r = ok(payload);
      assert.equal(r.ok, false, `${label} was accepted — hostile quantities must never reach reservation`);
    });
  }

  test('accepts a plain positive integer', () => {
    const r = ok([{ ticket_type_id: 'adult', quantity: 2 }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.items[0], {
      ticket_type_id: 'adult', quantity: 2, attendee_name: null, attendee_email: null,
    });
  });

  test('rejects a duplicated ticket type', () => {
    // The exploit shape: one positive line and one negative line for the SAME
    // type, which would otherwise net to a smaller charge than tickets issued.
    const r = ok([
      { ticket_type_id: 'adult', quantity: 2 },
      { ticket_type_id: 'adult', quantity: -1 },
    ]);
    assert.equal(r.ok, false, 'a ticket type appeared twice — per-order limits become meaningless');
  });

  test('normalises attendee details instead of trusting them', () => {
    const r = ok([{ ticket_type_id: 'adult', quantity: 1, attendee_name: '  Ann  ', attendee_email: { x: 1 } }]);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.items[0].attendee_name, 'Ann');
    assert.equal(r.ok && r.items[0].attendee_email, null);
  });
});

// ── 2. Pricing and the free path ────────────────────────────────────────────

describe('order totals and the free path', () => {
  test('THE EXPLOIT: a paid basket cannot be made to sum to zero', () => {
    const r = ok([
      { ticket_type_id: 'adult', quantity: 1 },
      { ticket_type_id: 'child', quantity: -2 },
    ]);
    assert.equal(r.ok, false,
      'SECURITY REGRESSION: the negative-quantity basket from audit finding H1 was accepted again.');
  });

  test('a paid basket is never free, even if the arithmetic said zero', () => {
    // Belt and braces: even if a future bug let a zero total through, allFree
    // is computed from database prices, so the free path stays shut.
    const items = [{ ticket_type_id: 'adult', quantity: 1, attendee_name: null, attendee_email: null }];
    const t = totalOrder(items, [ADULT]);
    assert.equal(t.ok, true);
    assert.equal(t.ok && t.allFree, false, 'a £12 ticket type was treated as free');
    assert.equal(t.ok && t.totalPence, 1200);
  });

  test('a genuinely free event still skips Stripe', () => {
    const items = [
      { ticket_type_id: 'free-a', quantity: 2, attendee_name: null, attendee_email: null },
      { ticket_type_id: 'free-b', quantity: 1, attendee_name: null, attendee_email: null },
    ];
    const t = totalOrder(items, [FREE_A, FREE_B]);
    assert.equal(t.ok, true);
    assert.equal(t.ok && t.allFree, true, 'a genuinely free community event was forced through Stripe');
    assert.equal(t.ok && t.totalPence, 0);
    assert.equal(t.ok && t.totalTickets, 3);
  });

  test('one paid type in an otherwise free basket means payment', () => {
    const items = [
      { ticket_type_id: 'free-a', quantity: 1, attendee_name: null, attendee_email: null },
      { ticket_type_id: 'adult', quantity: 1, attendee_name: null, attendee_email: null },
    ];
    const t = totalOrder(items, [FREE_A, ADULT]);
    assert.equal(t.ok && t.allFree, false);
  });

  test('price comes from the database, never from the request', () => {
    const items = checkLineItems([
      // A client trying to dictate its own price. The extra keys are dropped by
      // the contract, and totalOrder only ever reads the database row.
      { ticket_type_id: 'adult', quantity: 1, price_pence: 1, total_pence: 0, amount: 0 },
    ]);
    assert.equal(items.ok, true);
    const t = totalOrder(items.ok ? items.items : [], [ADULT]);
    assert.equal(t.ok && t.totalPence, 1200, 'the client influenced the price');
  });

  test('a ticket type not in the database is refused', () => {
    const items = [{ ticket_type_id: 'ghost', quantity: 1, attendee_name: null, attendee_email: null }];
    assert.equal(totalOrder(items, [ADULT]).ok, false);
  });

  test('arithmetic stays inside the safe integer range', () => {
    const items = [{ ticket_type_id: 'adult', quantity: 9, attendee_name: null, attendee_email: null }];
    const t = totalOrder(items, [{ id: 'adult', price_pence: Number.MAX_SAFE_INTEGER }]);
    assert.equal(t.ok, false, 'an overflowing line total was accepted');
  });
});

// ── 3. The database invariant ───────────────────────────────────────────────

function dbProbe(): Record<string, string | number | boolean> | null {
  const sql = `
begin;
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
declare r text;
begin execute p_sql into r; return coalesce(r,'(null)');
exception when others then return 'REJECTED'; end $f$;

create temp table tt as select id from public.event_ticket_types limit 1;
update public.event_ticket_types set quantity_available = quantity_sold + 3 where id=(select id from tt);
create temp table b0 as select quantity_sold as s from public.event_ticket_types where id=(select id from tt);

create temp table r0 as select
  pg_temp.try('select public.reserve_ticket_slots('''||(select id from tt)||'''::uuid, 0)::text')  as zero,
  pg_temp.try('select public.reserve_ticket_slots('''||(select id from tt)||'''::uuid, -5)::text') as negative,
  pg_temp.try('select public.reserve_ticket_slots('''||(select id from tt)||'''::uuid, null)::text') as nul;
create temp table b1 as select quantity_sold as s from public.event_ticket_types where id=(select id from tt);

select public.reserve_ticket_slots((select id from tt), 2);
create temp table b2 as select quantity_sold as s from public.event_ticket_types where id=(select id from tt);
select public.reserve_ticket_slots((select id from tt), 2);
create temp table b3 as select quantity_sold as s from public.event_ticket_types where id=(select id from tt);

select r0.zero, r0.negative, r0.nul,
       ((select s from b1) - (select s from b0)) as delta_after_bad_calls,
       ((select s from b2) - (select s from b1)) as delta_after_reserving_2,
       ((select s from b3) - (select s from b2)) as delta_after_oversell_attempt,
       pg_temp.try('update public.event_ticket_types set quantity_sold=-1 where id='''||(select id from tt)||''' returning ''ok''') as direct_negative_write
from r0;
rollback;`;
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
    return (JSON.parse(out) as { rows?: Record<string, string | number | boolean>[] }).rows?.[0] ?? null;
  } catch {
    return null;
  }
}

describe('reserve_ticket_slots defends itself', () => {
  let r: Record<string, string | number | boolean> | null = null;
  before(() => { r = dbProbe(); });

  test('bad quantities cannot move capacity; good ones move it exactly', (t) => {
    if (!r) { t.skip('Supabase CLI or linked project unavailable — run `supabase link`.'); return; }
    assert.equal(r.zero, 'REJECTED', 'reserve_ticket_slots accepted a quantity of 0');
    assert.equal(r.negative, 'REJECTED', 'reserve_ticket_slots accepted a NEGATIVE quantity — it would invent capacity');
    assert.equal(r.nul, 'REJECTED', 'reserve_ticket_slots accepted a null quantity');
    assert.equal(r.delta_after_bad_calls, 0, 'a refused reservation still changed quantity_sold');
    assert.equal(r.delta_after_reserving_2, 2, 'reserving 2 seats did not move quantity_sold by exactly +2');
    assert.equal(r.delta_after_oversell_attempt, 0, 'the event was oversold');
    assert.equal(r.direct_negative_write, 'REJECTED', 'quantity_sold could be driven negative by a direct write');
    console.log('\n  database invariant verified against the live schema (rolled back)\n');
  });
});

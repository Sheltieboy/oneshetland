/**
 * Tests for calculateCommission().
 *
 * Run with:
 *   deno test supabase/functions/_shared/commission.test.ts
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { calculateCommission } from './commission.ts';

// Silence the expected console.warn from money-losing assertions so test
// output stays readable. The tests assert loss_warning is set instead.
const origWarn = console.warn;
console.warn = () => {};
addEventListener('unload', () => { console.warn = origWarn; });

// ── Normal cases ─────────────────────────────────────────────────────────────

Deno.test('normal: 2% + 25p on £20 = 65p (40p + 25p)', () => {
  const r = calculateCommission(2000, { percent_bps: 200, fixed_pence: 25 });
  assertEquals(r.fee_pence, 65);
  assertEquals(r.loss_warning, null);
});

// ── Fetch flat fee across varying fares ──────────────────────────────────────

Deno.test('fetch flat: £1.50 stays £1.50 across all fares', () => {
  const cfg = { percent_bps: 0, fixed_pence: 150 };
  for (const fare of [450, 500, 1000, 2000, 5000, 20_000]) {
    const r = calculateCommission(fare, cfg, 'fetch');
    assertEquals(r.fee_pence, 150, `fare ${fare}p should produce 150p fee`);
  }
});

Deno.test('fetch flat on the actual £4.50 base: customer 450p → driver 300p, platform 150p', () => {
  const r = calculateCommission(450, { percent_bps: 0, fixed_pence: 150 }, 'fetch');
  assertEquals(r.fee_pence, 150);
  // Transfer = amount − fee
  assertEquals(450 - r.fee_pence, 300);
});

// ── Percentage-only ──────────────────────────────────────────────────────────

Deno.test('percentage-only: 200 bps on £10 = 20p', () => {
  const r = calculateCommission(1000, { percent_bps: 200, fixed_pence: 0 });
  assertEquals(r.fee_pence, 20);
});

Deno.test('percentage-only: 400 bps on £100 = 400p (future product rail default)', () => {
  const r = calculateCommission(10_000, { percent_bps: 400, fixed_pence: 0 });
  assertEquals(r.fee_pence, 400);
});

// ── Rounding (floor in platform's disfavour) ─────────────────────────────────

Deno.test('rounding: 200 bps on 333p = 6p (floor of 6.66)', () => {
  const r = calculateCommission(333, { percent_bps: 200, fixed_pence: 0 });
  assertEquals(r.fee_pence, 6);
});

Deno.test('rounding: 150 bps on 199p = 2p (floor of 2.985)', () => {
  const r = calculateCommission(199, { percent_bps: 150, fixed_pence: 0 });
  assertEquals(r.fee_pence, 2);
});

// ── Fee equals or exceeds amount: no clamp, just returned as-is ─────────────
// Stripe will reject the API call; admin sees a clear error and fixes config.

Deno.test('no clamp: flat 150p on 100p fare returns 150 (Stripe will reject)', () => {
  const r = calculateCommission(100, { percent_bps: 0, fixed_pence: 150 });
  assertEquals(r.fee_pence, 150);
});

// ── Money-losing warning ─────────────────────────────────────────────────────
// Estimate is ceil(amount * 0.015) + 20p.

Deno.test('warn: free config (0p fee) on £20 triggers loss_warning', () => {
  const r = calculateCommission(2000, { percent_bps: 0, fixed_pence: 0 });
  assertEquals(r.fee_pence, 0);
  // estimate = ceil(2000 * 0.015) + 20 = 30 + 20 = 50; 0 < 50 → warn
  if (r.loss_warning === null) throw new Error('expected loss_warning to be set');
});

Deno.test('warn boundary: fee exactly equals estimate → no warn', () => {
  // £20 estimate = 50p. Fee = 50p exactly (0 bps + 50 fixed).
  const r = calculateCommission(2000, { percent_bps: 0, fixed_pence: 50 });
  assertEquals(r.fee_pence, 50);
  assertEquals(r.loss_warning, null);
});

Deno.test('warn boundary: fee one pence below estimate → warn', () => {
  // £20 estimate = 50p. Fee = 49p.
  const r = calculateCommission(2000, { percent_bps: 0, fixed_pence: 49 });
  assertEquals(r.fee_pence, 49);
  if (r.loss_warning === null) throw new Error('expected loss_warning to be set');
});

Deno.test('no warn: fetch flat £1.50 on £4.50 base is profitable', () => {
  // estimate = ceil(450 * 0.015) + 20 = 7 + 20 = 27p. Fee 150p ≫ 27p.
  const r = calculateCommission(450, { percent_bps: 0, fixed_pence: 150 }, 'fetch');
  assertEquals(r.fee_pence, 150);
  assertEquals(r.loss_warning, null);
});

Deno.test('no warn: wallet 2%+25p on £20 = 65p, above 50p estimate', () => {
  const r = calculateCommission(2000, { percent_bps: 200, fixed_pence: 25 }, 'wallet');
  assertEquals(r.fee_pence, 65);
  assertEquals(r.loss_warning, null);
});

// ── Input validation ─────────────────────────────────────────────────────────

Deno.test('throws: negative amount', () => {
  assertThrows(
    () => calculateCommission(-1, { percent_bps: 200, fixed_pence: 25 }),
    Error,
    'amount_pence',
  );
});

Deno.test('throws: negative percent_bps', () => {
  assertThrows(
    () => calculateCommission(1000, { percent_bps: -1, fixed_pence: 0 }),
    Error,
    'percent_bps',
  );
});

Deno.test('throws: negative fixed_pence', () => {
  assertThrows(
    () => calculateCommission(1000, { percent_bps: 0, fixed_pence: -1 }),
    Error,
    'fixed_pence',
  );
});

Deno.test('throws: NaN amount', () => {
  assertThrows(
    () => calculateCommission(NaN, { percent_bps: 0, fixed_pence: 150 }),
    Error,
    'amount_pence',
  );
});

// ── Zero amount edge case ────────────────────────────────────────────────────

Deno.test('zero amount with fixed fee: returns fixed (Stripe will reject downstream)', () => {
  // Don't try to be clever — return what the formula says; downstream rejects.
  const r = calculateCommission(0, { percent_bps: 0, fixed_pence: 150 });
  assertEquals(r.fee_pence, 150);
});

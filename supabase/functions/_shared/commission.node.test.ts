/**
 * commission.node.test.ts — runnable platform-commission tests.
 *
 * Runs under Node's built-in test runner (no jest/deno needed):
 *     npm test
 *
 * commission.ts is a pure module with no Deno/esm.sh imports, so Node 24's
 * native TypeScript type-stripping runs it directly. This is the safety net for
 * the money maths flagged in QA (H4): every vendor-sale rail computes its
 * platform fee here, so a regression here silently mis-pays drivers/businesses.
 *
 * (A separate commission.test.ts exists for Deno; this one needs no extra tools.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCommission } from './commission.ts';

// Defaults mirror commission-config.ts DEFAULTS (kept in sync deliberately).
const FETCH   = { percent_bps:   0, fixed_pence: 150 };
const WALLET  = { percent_bps: 200, fixed_pence:  25 };
const PRODUCT = { percent_bps: 400, fixed_pence:   0 };

test('fetch rail is a flat £1.50 regardless of amount', () => {
  assert.equal(calculateCommission(500,  FETCH).fee_pence, 150);
  assert.equal(calculateCommission(5000, FETCH).fee_pence, 150);
});

test('wallet rail is 2% + 25p', () => {
  // £10.00 → 200bps of 1000 = 20p, + 25p fixed = 45p
  assert.equal(calculateCommission(1000, WALLET).fee_pence, 45);
});

test('product rail is 4%', () => {
  assert.equal(calculateCommission(1000, PRODUCT).fee_pence, 40);
});

test('percent part is floored (never overcharges the connected account)', () => {
  // 199p * 200bps = 3.98p → floor 3p, + 25p = 28p (not 29p)
  assert.equal(calculateCommission(199, WALLET).fee_pence, 28);
});

test('zero amount yields just the fixed fee', () => {
  assert.equal(calculateCommission(0, WALLET).fee_pence, 25);
  assert.equal(calculateCommission(0, FETCH).fee_pence, 150);
});

test('negative or non-finite inputs throw rather than silently mis-charging', () => {
  assert.throws(() => calculateCommission(-1, WALLET));
  assert.throws(() => calculateCommission(NaN, WALLET));
  assert.throws(() => calculateCommission(1000, { percent_bps: -1, fixed_pence: 0 }));
  assert.throws(() => calculateCommission(1000, { percent_bps: 0, fixed_pence: -5 }));
});

test('loss_warning is set when the fee is below estimated Stripe cost', () => {
  // £50 charge: estimated stripe cost = ceil(5000*0.015)+20 = 75+20 = 95p.
  // Fetch flat fee is 150p > 95p → no warning.
  assert.equal(calculateCommission(5000, FETCH).loss_warning, null);
  // £100 charge on the flat £1.50 fee: estimated = ceil(10000*0.015)+20 = 170p.
  // 150p < 170p → money-losing, warning present.
  assert.notEqual(calculateCommission(10000, FETCH).loss_warning, null);
});

test('fee is always a non-negative integer', () => {
  for (const amt of [0, 1, 7, 99, 333, 9999, 123456]) {
    const { fee_pence } = calculateCommission(amt, WALLET);
    assert.ok(Number.isInteger(fee_pence) && fee_pence >= 0, `bad fee for ${amt}: ${fee_pence}`);
  }
});

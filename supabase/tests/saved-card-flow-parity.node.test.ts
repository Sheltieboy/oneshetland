/**
 * saved-card-flow-parity.node.test.ts
 *
 * The paid-ticket saved-card fix was released on its own. Separately, the raw
 * first-card lookup (`payment_methods?type=card&limit=1`) was replaced by the
 * canonical chargeableCardFor() in seven other flows — boost, hub donation, hub
 * membership, product orders, unit purchases (passes), gifts and now wallet
 * top-up. Nothing left on the raw lookup.
 *
 * DEPLOYMENT STATUS (29 Sep 2026): create-product-order-intent, create-boost-intent,
 * create-hub-donation-intent and create-hub-membership-intent are all committed and
 * deployed (readiness item commerce-products). create-unit-purchase-intent's
 * canonical fix is committed and deployed here too (readiness item
 * commerce-passes) — its file also carries an unrelated, already-deployed
 * business_payout_destination change, reconciled into this same commit rather
 * than blended silently.
 *
 * create-gift-intent's canonical fix (commerce-gifts audit) is reconciled the
 * same way — its file also carries an unrelated, already-deployed
 * business_payout_destination change, untouched by this fix.
 *
 * local-wallet-topup-intent's canonical fix (commerce-local-wallet audit, 1 Oct)
 * closes the saved-card-consistency readiness item for good — gift and unit-
 * purchase were the other two named on it, both already done.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

/* ── 4. parity across flows ────────────────────────────────────────────── */

describe('one interpretation of "has a usable saved card" across flows', () => {
  const MIGRATED = ['create-boost-intent', 'create-hub-donation-intent', 'create-hub-membership-intent', 'create-product-order-intent', 'create-unit-purchase-intent', 'create-gift-intent', 'local-wallet-topup-intent'];
  // Nothing left here deliberately — any flow using the raw pattern fails
  // this test, migrated or new.
  const AUDIT_ONLY: string[] = [];

  test('the migrated flows pick the card by the canonical rule and keep "outage ≠ no card"', () => {
    for (const fn of MIGRATED) {
      const src = code(read(`supabase/functions/${fn}/index.ts`));
      assert.match(src, /import \{ chargeableCardFor \} from '\.\.\/_shared\/saved-card\.ts';/, fn);
      assert.match(src, /return chargeableCardFor\(Deno\.env\.get\('STRIPE_SECRET_KEY'\) \?\? '', customerId\);/, fn);
      assert.doesNotMatch(src, /payment_methods\?type=card&limit=1/, fn);
    }
  });

  test('raw first-card lookups exist ONLY in the documented audit-only list', () => {
    const dirs = readdirSync(join(REPO, 'supabase/functions'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_'));
    const raw = dirs
      .filter((d) => /payment_methods\?type=card&limit=1/.test(readFileSync(join(REPO, 'supabase/functions', d.name, 'index.ts'), 'utf8')))
      .map((d) => d.name).sort();
    assert.deepEqual(raw, [...AUDIT_ONLY].sort());
  });

  test('the flows whose card handling changed still confirm on-session, never off-session', () => {
    for (const fn of MIGRATED) {
      const src = code(read(`supabase/functions/${fn}/index.ts`));
      assert.match(src, /onSessionConfirm\(/, fn);
      assert.doesNotMatch(src, /off_session/, fn);
    }
  });
});

/* ── 5. wallet top-up specifically — the fix must not touch anything else ── */

describe('local-wallet-topup-intent: canonical card, everything else untouched', () => {
  const src = code(read('supabase/functions/local-wallet-topup-intent/index.ts'));

  test('no trace of the old "whatever Stripe listed first" access pattern remains', () => {
    assert.doesNotMatch(src, /\.data\?\.\[0\]\?\.id/, 'the raw first-card array index is gone');
    assert.doesNotMatch(src, /payment_methods\?type=card&limit=1/);
  });

  test('client_request_id is still required and still shapes both idempotency keys', () => {
    assert.match(src, /client_request_id required/);
    assert.match(src, /`topup-\$\{user\.id\}-\$\{client_request_id\}`/, 'off-session Idempotency-Key unchanged');
    assert.match(src, /`topup-form-\$\{user\.id\}-\$\{client_request_id\}`/, 'PaymentSheet Idempotency-Key unchanged');
  });

  test('PaymentIntent metadata used by local-wallet-confirm-topup is unchanged', () => {
    assert.match(src, /'metadata\[type\]':\s*'local_wallet_topup'/);
    assert.match(src, /'metadata\[user_id\]':\s*user\.id/);
  });

  test('the amount bounds (£5–£500) are unchanged', () => {
    assert.match(src, /amount_pence < 500 \|\| amount_pence > 50_000/);
  });

  test('Mode 2 — the PaymentSheet fallback for a customer with no saved card — is untouched', () => {
    assert.match(src, /automatic_payment_methods\[enabled\]/);
  });

  test('server-side confirmation, wallet crediting and deficit repayment live elsewhere and were not duplicated here', () => {
    // This function only ever creates a PaymentIntent. Crediting happens in
    // local-wallet-confirm-topup → the wallet_topup RPC, neither touched by
    // this fix — it is a different file, not a code path to be found here.
    assert.doesNotMatch(src, /rpc\('wallet_topup'/);
    assert.doesNotMatch(src, /local-wallet-confirm-topup/);
  });
});


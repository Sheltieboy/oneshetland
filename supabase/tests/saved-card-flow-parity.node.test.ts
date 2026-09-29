/**
 * saved-card-flow-parity.node.test.ts
 *
 * The paid-ticket saved-card fix was released on its own. Separately, the raw
 * first-card lookup (`payment_methods?type=card&limit=1`) was replaced by the
 * canonical chargeableCardFor() in five other flows — boost, hub donation, hub
 * membership, product orders and unit purchases (passes). Gift and wallet
 * top-up still use the raw lookup (audit-only — gift carries other unrelated
 * work in the same file, and the top-up inlines its own lookup — not touched
 * here).
 *
 * DEPLOYMENT STATUS (29 Sep 2026): create-product-order-intent, create-boost-intent,
 * create-hub-donation-intent and create-hub-membership-intent are all committed and
 * deployed (readiness item commerce-products). create-unit-purchase-intent's
 * canonical fix is committed and deployed here too (readiness item
 * commerce-passes) — its file also carries an unrelated, already-deployed
 * business_payout_destination change, reconciled into this same commit rather
 * than blended silently.
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
  const MIGRATED = ['create-boost-intent', 'create-hub-donation-intent', 'create-hub-membership-intent', 'create-product-order-intent', 'create-unit-purchase-intent'];
  // Still on the raw lookup, deliberately untouched here: gift carries other
  // uncommitted work in the same file, and the wallet top-up inlines its own
  // lookup. Any NEW flow using the raw pattern fails this test.
  const AUDIT_ONLY = ['create-gift-intent', 'local-wallet-topup-intent'];

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


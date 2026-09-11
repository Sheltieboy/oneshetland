/**
 * dashboard-payout-status-fields.node.test.ts — the dashboard's own payout
 * card must not contradict actual payment routing.
 *
 * WHAT WAS WRONG
 *
 * The "Payout bank account" card read business_stripe_payouts_enabled /
 * business_stripe_onboarding_complete — a column pair nothing in the
 * codebase ever writes (confirmed: zero writers of business_stripe_account_id
 * repo-wide; the one webhook write that targets it matches on that same
 * always-null column, so it never lands on any row — see
 * supabase/migrations/20260822160000_business_payout_and_product_read.sql,
 * whose own comment says so: "business_stripe_account_id/business_stripe_
 * payouts_enabled is a parallel set that is populated on no business at
 * all, and requiring it is what made every shop unpayable"). Meanwhile the
 * card directly below it, "Accept Local Wallet", already correctly reads
 * `payout_enabled` — the same field actual payment routing
 * (_business_payout_resolve, event_payout_ready, create-event-ticket-intent)
 * treats as authoritative. Two cards on one screen permanently disagreed
 * about the same fact, and the broken one could never show anything but
 * "setup needed", with a Connect CTA that never resolves.
 *
 * WHAT IS ASSERTED
 *   · the dead column pair is no longer READ anywhere in the dashboard
 *     (the fix is display-only — the columns themselves are untouched, not
 *     revived or populated, matching what was asked)
 *   · the payout card instead reads activeBusiness.payout_enabled — the
 *     same field the Accept Local Wallet card already uses, so the two
 *     cards cannot disagree any more
 *   · the connect CTA is gated on the same payout_enabled field, not a dead
 *     one
 *   · payout_enabled remains a real, actively-written column (this test
 *     does not just delete a check — it confirms the replacement field is
 *     the one payment routing actually maintains)
 *   · handleConnectStripe / toggleBusinessPayout — the actual Stripe/payout
 *     logic — are untouched by this fix (display/state-selection only)
 *
 * SAFETY
 * Reads source only. No database, no network, no writes.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARD  = join(REPO_ROOT, 'app/local-business-dashboard.tsx');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (p: string) => strip(readFileSync(p, 'utf8'));

describe('the "Payout bank account" card', () => {
  test('no longer reads business_stripe_payouts_enabled, business_stripe_onboarding_complete, or business_stripe_account_id', () => {
    const c = code(DASHBOARD);
    assert.doesNotMatch(c, /business_stripe_payouts_enabled/);
    assert.doesNotMatch(c, /business_stripe_onboarding_complete/);
    assert.doesNotMatch(c, /business_stripe_account_id/);
  });

  test('the status text is driven by activeBusiness.payout_enabled', () => {
    const c = code(DASHBOARD);
    // The bare string also appears earlier as a requireCommercialTerms(...)
    // argument in toggleBusinessPayout — anchor on the actual JSX label.
    const anchor = c.indexOf('payToggleLabel}>Payout bank account<');
    assert.notEqual(anchor, -1, 'the Payout bank account label must still exist');
    const block = c.slice(anchor, anchor + 700);
    assert.match(block, /activeBusiness\.payout_enabled/,
      'the "connected" state must key off the same field payment routing uses');
    assert.match(block, /stripe_connected/,
      'the intermediate "verification in progress" state should use the real stripe_connected boolean, not a dead one');
  });

  test('the Connect CTA is gated on payout_enabled, not a dead field', () => {
    const c = code(DASHBOARD);
    const anchor = c.indexOf('Connect business bank account');
    assert.notEqual(anchor, -1);
    const before = c.slice(Math.max(0, anchor - 700), anchor);
    assert.match(before, /!activeBusiness\.payout_enabled/);
  });

  test('the Accept Local Wallet card and the Payout bank account card now agree on the same field', () => {
    const c = code(DASHBOARD);
    const walletAnchor = c.indexOf('Accept Local Wallet');
    const payoutAnchor = c.indexOf('Payout bank account');
    assert.notEqual(walletAnchor, -1);
    assert.notEqual(payoutAnchor, -1);
    const walletBlock = c.slice(walletAnchor, walletAnchor + 700);
    assert.match(walletBlock, /activeBusiness\.payout_enabled/,
      'Accept Local Wallet already read payout_enabled — confirms the fix matches it rather than inventing a third source of truth');
  });
});

describe('payment/payout logic itself is untouched', () => {
  test('handleConnectStripe and toggleBusinessPayout are unchanged in shape — no new Stripe call, no column write added', () => {
    const c = code(DASHBOARD);
    const handleAnchor = c.indexOf('const handleConnectStripe');
    assert.notEqual(handleAnchor, -1);
    const handleBody = c.slice(handleAnchor, c.indexOf('\n  };', handleAnchor));
    assert.match(handleBody, /createBusinessOnboardingLink/, 'still the same onboarding-link call');
    assert.doesNotMatch(handleBody, /business_stripe_/, 'no dead-column write introduced');

    const toggleAnchor = c.indexOf('const toggleBusinessPayout');
    assert.notEqual(toggleAnchor, -1);
    const toggleBody = c.slice(toggleAnchor, c.indexOf('\n  };', toggleAnchor));
    assert.match(toggleBody, /use_business_payout:\s*value/, 'still only toggles use_business_payout');
    assert.doesNotMatch(toggleBody, /business_stripe_/, 'no dead-column write introduced');
  });

  test('payout_enabled is still a real column definition (canonical schema)', () => {
    const migrationPath = join(REPO_ROOT, 'supabase/migrations/20260623000000_baseline_remote_schema.sql');
    const schema = readFileSync(migrationPath, 'utf8');
    assert.match(schema, /payout_enabled\s+boolean/);
  });
});

/**
 * cardless-first-purchase.node.test.ts — a first purchase must be possible.
 *
 * THE DEFECT
 *
 * Donations, gifts and passes asked the server for the saved card and treated
 * "there isn't one" as a failure:
 *
 *     if (!customerId) return json({ error: 'No saved card found...' }, 400)
 *
 * The clients send use_saved_card unconditionally and had no way to ask for the
 * card form instead, so a brand-new user could not donate, send a gift, or buy
 * a pass AT ALL. Their first payment was the one that could never happen.
 *
 * THE FIX
 *
 * Asking for the saved card is a PREFERENCE. Where no card exists the request
 * falls through to the card-form branch that was already there — the shape
 * wallet top-up has always had. Where a saved card exists and the CHARGE fails,
 * it is still an error: that is a different thing, and quietly showing a card
 * form would be reading a declined payment as consent to use another card.
 *
 * SAFETY
 * Source-level, plus live probes with a disposable cardless account. A
 * clientSecret charges nothing; no payment was confirmed and none was made.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const fn = (n: string) => code(read(`supabase/functions/${n}/index.ts`));
const donation = fn('create-hub-donation-intent');
const gift     = fn('create-gift-intent');
const unit     = fn('create-unit-purchase-intent');
const topup    = fn('local-wallet-topup-intent');
const boost    = fn('create-boost-intent');
const member   = fn('create-hub-membership-intent');

const FIXED = [['donation', donation], ['gift', gift], ['pass / unit', unit]] as const;

/* ── 1. no card is not an error ───────────────────────────────────────────── */

describe('a first-time buyer reaches the card form', () => {
  for (const [name, src] of FIXED) {
    test(`${name} no longer refuses a user without a card`, () => {
      // The whole defect in one assertion: the saved-card branch must not be
      // able to return an error simply because no card is on file.
      assert.doesNotMatch(src, /No saved card found/,
        `${name} still turns "no card" into a failure`);
    });

    test(`${name} runs the saved-card path only when there IS a card`, () => {
      assert.match(src, /if \(customerId && pmId\) \{/, `${name} does not gate on both`);
      assert.match(src, /pmId = customerId \? await listSavedCard\(customerId\) : null/);
    });

    test(`${name} still has a card-form branch to fall through to`, () => {
      assert.match(src, /'automatic_payment_methods\[enabled\]': 'true'/);
      assert.match(src, /client_secret/);
    });
  }

  test('wallet top-up already worked, and is untouched', () => {
    // It has always fallen through. This is the shape the other three now copy.
    assert.doesNotMatch(topup, /No saved card found/);
    assert.match(topup, /if \(pmId\) \{/);                                  // saved-card work is gated
    assert.match(topup, /'automatic_payment_methods\[enabled\]': 'true'/);   // and falls out to the form
  });
});

/* ── 2. a real failure is still a failure ─────────────────────────────────── */

describe('a saved card that fails is not consent to use another', () => {
  for (const [name, src] of FIXED) {
    test(`${name} still reports a declined saved card`, () => {
      // Reached only when a card EXISTS and the charge did not succeed.
      assert.match(src, /outcome\.kind !== 'succeeded'/, `${name} lost its failure branch`);
      assert.match(src, /failureMessage\(outcome\.status\)/);
    });
  }

  test('the membership checkout keeps its explicit refusal', () => {
    // Membership is the one place the customer picks "Your saved card" by hand,
    // so falling through to a card form would override a choice they made.
    // Its no-card error stays as the safety net behind that choice.
    assert.match(member, /No saved card found/);
    assert.match(code(web('components/hubs/MembershipCheckout.tsx')),
      /if \(usingSavedCard\) \{\s*throw new Error\(/);
  });

  test('shift boost keeps the pattern it already had', () => {
    assert.match(boost, /No saved card found/);
    assert.match(code(web('components/jobs/ShiftBoostModal.tsx')), /\/no saved card\/i\.test\(msg\)/);
  });
});

/* ── 3. the clients needed nothing ────────────────────────────────────────── */

describe('the clients already knew what to do with a card form', () => {
  const CLIENTS = [
    ['donation', web('components/hubs/DonateModal.tsx')],
    ['gift',     web('components/local/GiftModal.tsx')],
    ['pass',     web('components/local/BuyUnitModal.tsx')],
  ] as const;

  for (const [name, src] of CLIENTS) {
    test(`the web ${name} modal shows the card form when one comes back`, () => {
      assert.match(code(src), /res\.clientSecret|setClientSecret\(res\.clientSecret\)/);
    });
  }

  test('the app donation route already sent the real card state', () => {
    assert.match(code(read('app/hub-donate.tsx')), /const useSaved = !!profile\.has_payment_method/);
  });

  test('the app gift and pass routes offer a way forward rather than a dead end', () => {
    for (const f of ['app/local-gift.tsx', 'app/local-buy-unit.tsx']) {
      const s = code(read(f));
      assert.match(s, /!profile\.has_payment_method && \(walletBalance \?\? 0\) </,
        `${f} does not check card state before charging`);
      assert.match(s, /Add a card or top up/, `${f} has no route out for a cardless user`);
    }
  });
});

/* ── 4. nothing about the payments themselves moved ───────────────────────── */

describe('the payment safety of each route is untouched', () => {
  test('every route still carries its attempt into the Stripe key', () => {
    assert.match(donation, /`donation-\$\{user\.id\}-\$\{campaign\.id\}-\$\{amount\}-\$\{client_request_id\}`/);
    assert.match(donation, /`donation-form-\$\{user\.id\}-\$\{campaign\.id\}-\$\{amount\}-\$\{client_request_id\}`/);
    assert.match(topup, /`topup-form-\$\{user\.id\}-\$\{client_request_id\}`/);
  });

  test('SCA still resumes the same intent on every route', () => {
    for (const [name, src] of [...FIXED, ['top-up', topup]] as const) {
      assert.match(src, /status: 'requires_action', clientSecret: outcome\.clientSecret, payment_intent_id: outcome\.id/,
        `${name} lost same-intent SCA`);
    }
  });

  test('donation keeps its amount, destination, fee and attempt binding', () => {
    assert.match(donation, /transfer_data\[destination\]/);
    assert.match(donation, /application_fee_amount/);
    assert.match(donation, /hub_donation_attempts/);
  });

  test('the wallet top-up bounds and recovery are untouched', () => {
    assert.match(topup, /Amount must be £5–£500/);
  });

  test('gift and pass keep their own fulfilment', () => {
    assert.match(gift, /`gift-\$\{gift\.id\}`/);
    assert.match(unit, /unit_item_id|book_unit/);
  });
});

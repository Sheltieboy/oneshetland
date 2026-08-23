/**
 * web-saved-card-checkout.node.test.ts — the web basket uses the card you
 * already saved.
 *
 * WHAT WAS WRONG
 *
 * The web basket's request body carried business_id, items, fulfilment,
 * delivery, note and pay_with — and no use_saved_card at all. The backend reads
 * `if (body.use_saved_card)`, saw undefined, took its card-form branch and
 * returned a clientSecret, so a buyer with a perfectly good saved card was asked
 * to type it in again. The app had always sent the flag, which is why the same
 * backend behaved correctly there.
 *
 * The same shape as the mobile ticket bug: not a wrong value, a missing field.
 *
 * WHAT IS ASSERTED
 *   · the web sends the flag, derived from the buyer's real card state
 *   · a buyer with no card still gets the card form
 *   · both web screens derive card state from one place, so the account page and
 *     the checkout cannot disagree
 *   · the backend re-resolves the Customer and payment method from the
 *     AUTHENTICATED buyer, so the flag is a preference and never a claim
 *   · the SCA path still resumes the same PaymentIntent
 *   · the app path is untouched
 *
 * SAFETY
 * Source inspection only. No network, no Stripe call, no payment, no stock.
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
const app = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

// ── 1. The missing field ───────────────────────────────────────────────────

describe('the web basket asks for the saved card', () => {
  const basket = () => web('app/basket/page.tsx');

  test('use_saved_card is sent', () => {
    assert.match(basket(), /use_saved_card:/,
      'without this the backend takes its card-form branch every time');
  });

  test('it is derived from the buyer’s real card state, not hardcoded', () => {
    const src = basket();
    assert.match(src, /use_saved_card: payWith === "card" && cardOnFile === true && !useNewCard/);
    assert.match(src, /fetchCardOnFile\(sb, uid\)/, 'the state must be read for the signed-in user');
  });

  test('a buyer with no card still gets the card form', () => {
    // cardOnFile resolves false when signed out or when the column is false, so
    // the flag is false and the backend returns a clientSecret as before.
    const src = basket();
    assert.match(src, /setCardOnFile\(uid \? await fetchCardOnFile\(sb, uid\) : false\)/);
    assert.match(src, /clientSecret \?/, 'the Elements path must still render');
    assert.match(src, /<PaymentCheckout/, 'the new-card component must still be mounted');
  });

  test('the buyer can choose a different card without losing the saved one', () => {
    const src = basket();
    assert.match(src, /setUseNewCard\(true\)/);
    assert.match(src, /setUseNewCard\(false\)/, 'and change their mind back');
  });

  test('no card details are rendered by the basket', () => {
    const src = basket();
    for (const leak of ['last4', 'brand', 'exp_month', 'card_number', 'pm_']) {
      assert.ok(!src.includes(leak), `the basket must not handle ${leak}`);
    }
  });
});

// ── 2. One source of card state ────────────────────────────────────────────

describe('card state cannot differ between screens', () => {
  test('both derivations live in one file and read the same column', () => {
    const src = web('lib/payment-state.ts');
    assert.match(src, /export async function getPaymentState/, 'the server derivation');
    assert.match(src, /export async function fetchCardOnFile/, 'the client one');
    // Both answer from profiles.has_payment_method.
    const occurrences = src.split('has_payment_method').length - 1;
    assert.ok(occurrences >= 2, 'both must read the same column');
  });

  test('the account page and the checkout use those, not their own rule', () => {
    assert.match(web('app/account/page.tsx'), /getPaymentState/);
    assert.match(web('app/account/payments/page.tsx'), /getPaymentState/);
    assert.match(web('app/basket/page.tsx'), /fetchCardOnFile/);
  });

  test('the state is read per session, so it cannot go stale in a module', () => {
    const src = web('lib/payment-state.ts');
    const fn = src.slice(src.indexOf('export async function fetchCardOnFile'));
    assert.ok(!/let cached|const cache|memo/i.test(fn), 'a cached answer would survive card removal');
    assert.match(fn, /\.eq\("id", userId\)/, 'it must be read for the user being asked about');
  });
});

// ── 3. The server stays in charge ──────────────────────────────────────────

describe('the flag is a preference, not a claim', () => {
  const fn = () => app('supabase/functions/create-product-order-intent/index.ts');

  test('the Customer comes from the authenticated buyer’s own profile', () => {
    assert.match(fn(), /const customerId = profile\?\.stripe_customer_id \?\? null;/);
  });

  test('the payment method is re-resolved from Stripe for that Customer', () => {
    const src = fn();
    assert.match(src, /const pm = await listSavedCard\(customerId\)/);
    assert.match(src, /if \(!pm\) \{ await releaseAll\(\); return json\(\{ error: 'No saved card on file' \}, 400\)/,
      'a client claiming a card it does not have must be refused, not served someone else’s');
  });

  test('no payment method or customer is ever taken from the request body', () => {
    const src = fn();
    assert.ok(!/body\.(payment_method|customer|stripe_customer_id)/.test(src));
  });
});

// ── 4. Nothing else moved ──────────────────────────────────────────────────

describe('the rest of the checkout is unchanged', () => {
  test('the saved-card charge is still on-session, and SCA resumes the same intent', () => {
    const src = app('supabase/functions/create-product-order-intent/index.ts');
    assert.match(src, /onSessionConfirm\(customerId, pm\)/);
    assert.ok(!/off_session/.test(src), 'the buyer is present — this must not become an off-session charge');
    assert.match(src, /outcome\.kind === 'requires_action'/);
    assert.match(web('app/basket/page.tsx'), /settleSavedCardPayment/,
      'the web must complete a challenge on THAT intent, not start another');
  });

  test('one attempt is still one order and one Stripe key', () => {
    const src = app('supabase/functions/create-product-order-intent/index.ts');
    assert.match(src, /`product-order-\$\{order\.id\}`/,
      'the idempotency key is per order, so switching card choice cannot double-charge');
  });

  test('the app marketplace path is untouched', () => {
    const src = app('app/product-checkout.tsx');
    assert.match(src, /const useSaved = !!profile\?\.has_payment_method;/);
    assert.match(src, /use_saved_card: useSaved,/);
  });
});

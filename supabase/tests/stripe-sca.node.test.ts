/**
 * stripe-sca.node.test.ts — saved-card charges are on-session, and a bank
 * challenge is resumable rather than fatal.
 *
 * WHAT WAS WRONG
 *
 * Every saved-card flow confirmed with `off_session: 'true'` while the customer
 * was standing there having just tapped Buy. One comment said the quiet part out
 * loud: "off_session means no 3DS prompt for small amounts."
 *
 * That misdeclares the transaction to Stripe and the card networks, and it asks
 * for an SCA exemption — standing down the one control that independently stops
 * a stolen-session purchase.
 *
 * It also broke the payment. Off-session confirmation cannot prompt anybody, so
 * when an issuer demanded authentication Stripe returned an
 * `authentication_required` ERROR, and every flow reported "Payment did not
 * succeed" with no way forward. Test cards rarely challenge; live UK/EEA cards
 * under PSD2 do, so a good share of real first payments would simply have died.
 *
 * Two flows were worse than that. create-event-ticket-intent and
 * local-boost-checkout FELL THROUGH to their card-form branch on any
 * non-success, which creates a SECOND PaymentIntent while the first is already
 * confirmed and possibly holding the customer's money.
 *
 * WHAT IS ASSERTED
 *   · no user-present flow sends off_session
 *   · the SetupIntent's usage:'off_session' is untouched — it means something
 *     different and correct
 *   · every PaymentIntent status maps to the right action, and requires_action
 *     is never treated as failure
 *   · requires_action without a client secret is a failure, not a hang
 *   · both mid-flight states stop the fall-through to a second PaymentIntent
 *   · genuinely automatic billing is unchanged
 *   · both clients complete the challenge on the SAME intent via handleNextAction
 *
 * SAFETY
 * Pure functions and source inspection. No Stripe call, no PaymentIntent, no
 * card, no money, no production row. Belongs in the routine suite.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onSessionConfirm, classifyIntent, failureMessage } from '../functions/_shared/stripe-sca.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const FN_DIR = join(REPO_ROOT, 'supabase', 'functions');

const read = (p: string) => readFileSync(p, 'utf8');
const fn = (name: string) => read(join(FN_DIR, name, 'index.ts'));

/** Every flow where a person deliberately initiated the purchase. */
const USER_PRESENT = [
  'create-boost-intent', 'create-event-ticket-intent', 'create-product-order-intent',
  'create-gift-intent', 'create-unit-purchase-intent', 'create-hub-donation-intent',
  'create-hub-membership-intent', 'local-wallet-topup-intent', 'local-boost-checkout',
  'local-subscription-intent',
];

// ── 1. On-session semantics ────────────────────────────────────────────────

describe('a customer who is present is declared present', () => {
  test('onSessionConfirm never sets off_session, and asks for an SDK-completable challenge', () => {
    const p = onSessionConfirm('cus_x', 'pm_y');
    assert.ok(!('off_session' in p), 'off_session must not appear on a user-present confirmation');
    assert.equal(p.confirm, 'true');
    assert.equal(p.use_stripe_sdk, 'true',
      'without use_stripe_sdk Stripe may answer with a redirect needing a return_url');
    assert.equal(p.customer, 'cus_x');
    assert.equal(p.payment_method, 'pm_y');
  });

  test('no user-present flow sends off_session', () => {
    const offenders = USER_PRESENT.filter((name) => /off_session/.test(fn(name)));
    assert.deepEqual(offenders, [],
      `these still declare the customer absent while they are standing there: ${offenders.join(', ')}`);
  });

  test('every user-present flow that charges a saved card uses the shared helper', () => {
    // local-subscription-intent confirms through the Stripe SDK object rather
    // than the shared param builder, so it is checked by the off_session test
    // above instead.
    const viaHelper = USER_PRESENT.filter((n) => n !== 'local-subscription-intent');
    for (const name of viaHelper) {
      assert.match(fn(name), /_shared\/stripe-sca\.ts/, `${name} does not use the SCA helper`);
    }
  });

  test('the SetupIntent still declares the card usable off-session later', () => {
    // Different meaning, and correct: it is what allows a future genuinely
    // absent charge. Breaking this would break card saving.
    assert.match(fn('create-setup-intent'), /usage:\s*'off_session'/);
  });
});

// ── 2. Every PaymentIntent state ───────────────────────────────────────────

describe('PaymentIntent states map to the right action', () => {
  test('succeeded', () => {
    assert.deepEqual(classifyIntent({ id: 'pi_1', status: 'succeeded' }), { kind: 'succeeded', id: 'pi_1' });
  });

  test('requires_action is resumable, not a failure', () => {
    const o = classifyIntent({ id: 'pi_2', status: 'requires_action', client_secret: 'pi_2_secret' });
    assert.equal(o.kind, 'requires_action');
    assert.equal((o as { clientSecret: string }).clientSecret, 'pi_2_secret');
  });

  test('requires_action without a client secret is a failure, not a hang', () => {
    // Nothing can be presented to the customer, so saying "authenticate" would
    // strand them. Fail honestly instead.
    assert.equal(classifyIntent({ id: 'pi_3', status: 'requires_action' }).kind, 'failed');
  });

  test('processing does not mean fulfilled', () => {
    assert.equal(classifyIntent({ id: 'pi_4', status: 'processing' }).kind, 'processing');
  });

  test('requires_payment_method is a decline', () => {
    const o = classifyIntent({ id: 'pi_5', status: 'requires_payment_method' });
    assert.equal(o.kind, 'failed');
    assert.match(failureMessage((o as { status: string }).status), /declined/i);
  });

  test('canceled is over', () => {
    const o = classifyIntent({ id: 'pi_6', status: 'canceled' });
    assert.equal(o.kind, 'failed');
    assert.match(failureMessage((o as { status: string }).status), /cancelled/i);
  });

  test('an unknown status is never treated as success', () => {
    assert.equal(classifyIntent({ id: 'pi_7', status: 'something_new' }).kind, 'failed');
    assert.equal(classifyIntent({}).kind, 'failed');
  });

  test('no failure message leaks Stripe internals', () => {
    for (const s of ['requires_payment_method', 'canceled', 'weird']) {
      const m = failureMessage(s);
      assert.ok(!/pi_|cus_|pm_|sk_|stripe/i.test(m), `"${m}" exposes provider detail`);
    }
  });
});

// ── 3. The same PaymentIntent, never a second one ──────────────────────────

describe('a challenge never becomes a second charge', () => {
  test('event tickets stop before the branch that creates another PaymentIntent', () => {
    const src = fn('create-event-ticket-intent');
    assert.match(src, /outcome\.kind === 'requires_action' \|\| outcome\.kind === 'processing'/,
      'both mid-flight states must return early');
    // The early return must come before the PaymentSheet branch that would
    // create a second intent.
    assert.ok(src.indexOf("outcome.kind === 'requires_action'") < src.indexOf('// Standard PaymentSheet'),
      'the mid-flight return must precede the second-intent branch');
  });

  test('local boost stops falling through on a challenge', () => {
    const src = fn('local-boost-checkout');
    assert.match(src, /classifyIntent/);
    assert.match(src, /requires_action' \|\| outcome\.kind === 'processing'/);
    assert.ok(!/needs auth → fall through/.test(src), 'the old fall-through comment should be gone with the behaviour');
  });

  test('a resumed payment carries the original intent id back to the caller', () => {
    for (const name of ['create-event-ticket-intent', 'create-gift-intent', 'create-unit-purchase-intent',
                        'create-hub-donation-intent', 'create-hub-membership-intent',
                        'create-product-order-intent', 'local-wallet-topup-intent']) {
      const src = fn(name);
      assert.match(src, /payment_intent_id: outcome\.id/, `${name} does not return the resumed intent id`);
      // Either form is fine — a plain `clientSecret: outcome.clientSecret`, or the
      // conditional used where one branch also covers `processing`.
      assert.match(src, /outcome\.clientSecret/, `${name} does not return the resumed client secret`);
    }
  });
});

// ── 4. Automatic billing is untouched ──────────────────────────────────────

describe('genuinely automatic payments are unchanged', () => {
  test('metered booking billing still posts usage, and confirms no PaymentIntent', () => {
    const src = fn('meter-bookings');
    assert.ok(!/payment_intents/.test(src), 'meter-bookings must not create PaymentIntents');
    assert.ok(!/stripe-sca/.test(src), 'automatic billing must not acquire an interactive path');
  });

  test('webhook fulfilment gained no interactive step', () => {
    assert.ok(!/stripe-sca/.test(fn('stripe-webhook')), 'a webhook has no customer to challenge');
  });

  test('capture and refund gained no interactive step', () => {
    // Capture settles an authorisation the customer already authenticated, and
    // a driver triggers it. Refunds are ours. Neither may ever prompt anybody.
    for (const name of ['capture-payment', 'authorise-payment', 'refund-payment', 'cancel-payment']) {
      assert.ok(!/stripe-sca/.test(fn(name)), `${name} must not require interactive authentication`);
    }
  });

  test('no automatic flow was given off_session by accident, or had it removed', () => {
    // authorise-payment is a manual-capture pre-auth with the customer present;
    // it never set off_session and still must not.
    assert.ok(!/off_session/.test(fn('authorise-payment')));
  });
});

// ── 5. Both clients finish the same intent ─────────────────────────────────

describe('the clients complete the challenge, not a new payment', () => {
  test('mobile uses the Stripe SDK next-action API', () => {
    const p = join(REPO_ROOT, 'lib', 'stripe-sca.ts');
    assert.ok(existsSync(p), 'mobile SCA helper is missing');
    const src = read(p);
    assert.match(src, /from '@stripe\/stripe-react-native'/);
    assert.match(src, /handleNextAction\(/);
    assert.ok(!/initPaymentSheet|presentPaymentSheet/.test(src),
      'a confirmed intent needing authentication is finished with handleNextAction, not a new PaymentSheet');
  });

  test('web uses the Stripe.js next-action API', () => {
    const p = join(WEB_ROOT, 'lib', 'stripe-sca.ts');
    assert.ok(existsSync(p), 'web SCA helper is missing');
    const src = read(p);
    assert.match(src, /handleNextAction\(\{ clientSecret/);
    assert.ok(!/confirmCardPayment\(/.test(src), 'confirmCardPayment would re-confirm; handleNextAction resumes');
  });

  test('a cancelled challenge is not reported as a purchase', () => {
    for (const p of [join(REPO_ROOT, 'lib', 'stripe-sca.ts'), join(WEB_ROOT, 'lib', 'stripe-sca.ts')]) {
      const src = read(p);
      assert.match(src, /cancelled/, 'a dismissed challenge needs its own outcome');
      assert.ok(!/outcome: ['"]succeeded['"][^\n]*Cancel/i.test(src));
    }
  });

  test('every saved-card client entry point settles before reporting success', () => {
    const wired = [
      join(REPO_ROOT, 'lib', 'events-api.ts'), join(REPO_ROOT, 'lib', 'products-api.ts'),
      join(REPO_ROOT, 'lib', 'hubs-api.ts'), join(REPO_ROOT, 'lib', 'local-api.ts'),
      join(WEB_ROOT, 'lib', 'local-commerce-client.ts'), join(WEB_ROOT, 'lib', 'hubs-client.ts'),
      join(WEB_ROOT, 'lib', 'shift-boost-client.ts'), join(WEB_ROOT, 'lib', 'events-client.ts'),
      join(WEB_ROOT, 'lib', 'business-client.ts'),
    ];
    const missing = wired.filter((p) => !read(p).includes('settleSavedCardPayment'));
    assert.deepEqual(missing.map((p) => p.split('/').slice(-2).join('/')), [],
      'these start saved-card payments but never settle a challenge');
  });
});

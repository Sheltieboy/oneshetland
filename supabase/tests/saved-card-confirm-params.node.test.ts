/**
 * saved-card-confirm-params.node.test.ts — a saved-card charge is a CARD charge.
 *
 * WHAT WAS WRONG
 *
 * Every saved-card purchase failed after the basket was reserved. Stripe's own
 * words, captured by reproducing the call against test mode:
 *
 *   invalid_request_error — "This PaymentIntent is configured to accept payment
 *   methods enabled in your Dashboard. Because some of these payment methods
 *   might redirect your customer off of your page, you must provide a
 *   `return_url`. If you don't want to accept redirect-based payment methods,
 *   set `automatic_payment_methods[enabled]` to `true` and
 *   `automatic_payment_methods[allow_redirects]` to `never`…"
 *
 * This account has dynamic payment methods switched on in the Dashboard —
 * klarna, revolut_pay, amazon_pay, all of which redirect. Step 15 replaced
 * `off_session: true` with `use_stripe_sdk: true` on the server-side confirm but
 * never ruled those methods out, so Stripe applied the Dashboard default,
 * decided the buyer might be sent off-site, and refused the whole request for
 * want of a return_url.
 *
 * The buyer saw "The payment couldn't be completed" on both clients. It was
 * never the card, the customer, or the organiser's Connect account.
 *
 * WHAT IS ASSERTED
 *   · the confirm pins automatic_payment_methods to enabled + allow_redirects
 *     never, which is what makes a return_url unnecessary
 *   · off_session is still absent — the customer IS present
 *   · use_stripe_sdk is still set, so an issuer challenge comes back as
 *     requires_action rather than a redirect
 *   · every saved-card flow gets this, because they all share the helper
 *   · the ticket economics are unchanged: £11.10 buyer, £1.10 platform fee
 *
 * SAFETY
 * Pure functions and source inspection. No Stripe call, no payment, no
 * production row.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onSessionConfirm, classifyIntent } from '../functions/_shared/stripe-sca.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN_DIR = join(REPO_ROOT, 'supabase', 'functions');
const fn = (n: string) => readFileSync(join(FN_DIR, n, 'index.ts'), 'utf8');

// ── 1. The defect ──────────────────────────────────────────────────────────

describe('a server-side confirm rules out redirect payment methods', () => {
  const p = onSessionConfirm('cus_x', 'pm_y');

  test('automatic_payment_methods is pinned so no return_url is needed', () => {
    assert.equal(p['automatic_payment_methods[enabled]'], 'true');
    assert.equal(p['automatic_payment_methods[allow_redirects]'], 'never',
      'without this Stripe refuses the whole call for want of a return_url');
  });

  test('the customer is still declared present', () => {
    assert.ok(!('off_session' in p), 'the buyer just tapped Pay — they are present');
    assert.equal(p.confirm, 'true');
  });

  test('an issuer challenge still comes back to the SDK, not as a redirect', () => {
    assert.equal(p.use_stripe_sdk, 'true');
    const o = classifyIntent({ id: 'pi_1', status: 'requires_action', client_secret: 'pi_1_secret' });
    assert.equal(o.kind, 'requires_action', 'SCA must remain reachable');
  });

  test('every saved-card flow inherits the fix through the shared helper', () => {
    const users = readdirSync(FN_DIR)
      .filter((n) => n !== '_shared' && existsSync(join(FN_DIR, n, 'index.ts')))
      .filter((n) => fn(n).includes('onSessionConfirm'));
    assert.ok(users.length >= 8, `expected the helper to be shared, found ${users.length} users`);
    for (const n of users) {
      assert.ok(!/automatic_payment_methods/.test(fn(n).split('onSessionConfirm')[0].slice(-400)),
        `${n} should not hand-roll the parameter the helper now sets`);
    }
  });

  test('the SDK-based flow that does not use the helper is pinned too', () => {
    // local-boost-checkout confirms through the Stripe SDK object rather than
    // the shared param builder, so it needed the same two lines.
    const src = fn('local-boost-checkout');
    assert.match(src, /automatic_payment_methods: \{ enabled: true, allow_redirects: 'never' \}/);
  });
});

// ── 2. Nothing else moved ──────────────────────────────────────────────────

describe('the rest of the checkout is unchanged', () => {
  const src = () => fn('create-event-ticket-intent');

  test('the fee model is still 95p plus 1.5% of face value', () => {
    const s = src();
    assert.match(s, /BOOKING_FEE_PENCE = 95/);
    assert.match(s, /BOOKING_FEE_BPS = 150/);
    // £10 ticket → 95 + floor(1000 * 150 / 10000) = 110p, buyer pays 1110p.
    const fee = 95 * 1 + Math.floor((1000 * 150) / 10_000);
    assert.equal(fee, 110);
    assert.equal(1000 + fee, 1110);
  });

  test('the platform fee is still taken as an application fee on the transfer', () => {
    const s = src();
    assert.match(s, /baseParams\['transfer_data\[destination\]'\] = stripeAccountId;/);
    assert.match(s, /baseParams\['application_fee_amount'\] = String\(platformFeePence\)/);
  });

  test('the destination still comes from the shared resolver', () => {
    assert.match(src(), /rpc\('event_payout_destination'/);
  });

  test('idempotency is untouched', () => {
    assert.match(src(), /`evt-order-\$\{order\.id\}`/);
  });

  test('requires_action still resumes the same intent and does not fall through', () => {
    const s = src();
    assert.match(s, /outcome\.kind === 'requires_action' \|\| outcome\.kind === 'processing'/);
    assert.ok(s.indexOf("outcome.kind === 'requires_action'") < s.indexOf('// Standard PaymentSheet'),
      'a mid-flight payment must not reach the branch that creates a second intent');
  });

  test('the new-card PaymentSheet branch is unchanged', () => {
    assert.match(src(), /'automatic_payment_methods\[enabled\]': 'true',\n\s*\}\);/);
  });
});

// ── 3. The buyer wording ───────────────────────────────────────────────────

describe('what the buyer was told', () => {
  test('an invalid_request_error stays generic — it was our bug, not theirs', () => {
    const src = readFileSync(join(FN_DIR, '_shared', 'stripe-errors.ts'), 'utf8');
    // Deliberately NOT given a friendlier message: once the parameters are
    // right this cannot happen, and inventing copy for it would only make a
    // future recurrence look like an expected outcome.
    assert.ok(!/invalid_request_error/.test(src),
      'a parameter bug must not be dressed up as an operational error');
    assert.match(src, /payment_failed:\s+'The payment couldn’t be completed/);
  });

  test('the provider message is still logged with its parameter', () => {
    const src = readFileSync(join(FN_DIR, '_shared', 'stripe-errors.ts'), 'utf8');
    assert.match(src, /param=\$\{err\.param \?\? '-'\}/,
      'Stripe names the offending parameter — that is what found this bug');
  });

  test('no temporary diagnostic survived into the deployed helper', () => {
    const src = readFileSync(join(FN_DIR, '_shared', 'stripe-errors.ts'), 'utf8');
    for (const leak of ['TEMP-DIAG', '_pm:', '_param:', '_diag']) {
      assert.ok(!src.includes(leak), `${leak} must not ship`);
    }
  });
});

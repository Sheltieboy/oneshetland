/**
 * saved-card-decline.node.test.ts — a refused card is an answer, not a silence.
 *
 * Confirming the first subscription invoice against a saved card had one branch
 * for four different outcomes:
 *
 *     catch (_e) { /* needs auth / declined → fall through to card form *\/ }
 *
 * A 3DS challenge, a declined card and a Stripe outage all landed there, and
 * the owner was shown an empty Payment Element with nothing explaining where
 * their saved card had gone — as though they had never saved one. That is the
 * behaviour Paygate 8 already ruled out: a saved-card failure is an error to
 * show, never a reason to put a card form in front of somebody who did not ask
 * for one.
 *
 * The classifier is pure, so every branch is exercised for real.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySavedCardConfirm } from '../functions/_shared/saved-card-outcome.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');
const fn      = code(readFileSync(join(REPO_ROOT, 'supabase/functions/local-subscription-intent/index.ts'), 'utf8'));
const billing = code(readFileSync(join(WEB_ROOT, 'components/business/BillingManager.tsx'), 'utf8'));
const client  = code(readFileSync(join(WEB_ROOT, 'lib/business-client.ts'), 'utf8'));

const cardError = (message: string, decline = 'generic_decline') =>
  ({ type: 'StripeCardError', raw: { type: 'card_error', decline_code: decline, message }, message });

/* ── 1. four outcomes, not one ────────────────────────────────────────────── */

describe('a decline, a challenge and an outage are different answers', () => {
  test('a genuine decline is a decline', () => {
    const o = classifySavedCardConfirm(null, cardError('Your card was declined.'));
    assert.equal(o.kind, 'declined');
    assert.equal((o as { message: string }).message, 'Your card was declined.');
  });

  test('requires_payment_method after confirming is a decline', () => {
    const o = classifySavedCardConfirm('requires_payment_method', null);
    assert.equal(o.kind, 'declined');
  });

  test('requires_action is SCA, and must NOT read as a decline', () =>
    // It continues on the SAME PaymentIntent; calling it a decline would put a
    // card form in front of somebody who only needed to approve their bank.
    assert.equal(classifySavedCardConfirm('requires_action', null).kind, 'sca'));

  test('processing and requires_confirmation also stay on the same intent', () => {
    assert.equal(classifySavedCardConfirm('processing', null).kind, 'sca');
    assert.equal(classifySavedCardConfirm('requires_confirmation', null).kind, 'sca');
  });

  test('succeeded is activation', () =>
    assert.equal(classifySavedCardConfirm('succeeded', null).kind, 'activated'));

  test('a Stripe outage is NOT a card decline', () => {
    for (const e of [
      { type: 'StripeAPIError', message: 'Stripe is temporarily unavailable' },
      { type: 'StripeConnectionError', message: 'network timeout' },
      new Error('fetch failed'),
    ]) {
      const o = classifySavedCardConfirm(null, e);
      assert.equal(o.kind, 'infrastructure', `${JSON.stringify(e)} was called a decline`);
    }
  });

  test('an unrecognised status is not silently turned into a card form', () =>
    assert.equal(classifySavedCardConfirm('something_new', null).kind, 'infrastructure'));
});

/* ── 2. what the owner is allowed to read ─────────────────────────────────── */

describe('the message is safe to show', () => {
  test("Stripe's own decline wording is used when it is customer-facing", () => {
    const o = classifySavedCardConfirm(null, cardError('Your card has insufficient funds.'));
    assert.equal((o as { message: string }).message, 'Your card has insufficient funds.');
  });

  test('anything that reads like configuration is replaced', () => {
    for (const leak of ['Invalid API Key provided: sk_test_123',
                        'No such payment_method: pm_x',
                        'Invalid request: customer required']) {
      const o = classifySavedCardConfirm(null, cardError(leak));
      assert.equal((o as { message: string }).message, 'Your saved card was declined.',
        `"${leak}" reached the customer`);
    }
  });

  test('an empty message still says something useful', () =>
    assert.equal((classifySavedCardConfirm(null, cardError('')) as { message: string }).message,
      'Your saved card was declined.'));
});

/* ── 3. the function acts on the classification ───────────────────────────── */

describe('local-subscription-intent stops on a decline', () => {
  test('the silent catch is gone', () => {
    assert.ok(!/catch \(_e\) \{ \/\* needs auth \/ declined/.test(fn));
    assert.match(fn, /classifySavedCardConfirm/);
  });

  test('a decline returns CARD_DECLINED and NO client secret', () => {
    const block = fn.slice(fn.indexOf("outcome.kind === 'declined'"), fn.indexOf("outcome.kind === 'infrastructure'"));
    assert.match(block, /code:\s*'CARD_DECLINED'/);
    assert.ok(!/client_secret|paymentIntent:/.test(block),
      'a decline still hands back the card form');
  });

  test('an infrastructure failure is not reported as a decline', () => {
    const block = fn.slice(fn.indexOf("outcome.kind === 'infrastructure'"));
    assert.match(block.slice(0, 400), /could not take the payment just now/);
    assert.ok(!/CARD_DECLINED/.test(block.slice(0, 400)));
  });

  test('SCA still falls through to the SAME PaymentIntent', () => {
    // Asserted on code, not on a comment: only 'activated', 'declined' and
    // 'infrastructure' return early, so 'sca' reaches the existing
    // client-secret response and completes the intent already created.
    const block = fn.slice(fn.indexOf('const outcome = await confirmSavedCard'),
                           fn.indexOf('if (!paymentIntent?.client_secret)'));
    for (const kind of ['activated', 'declined', 'infrastructure']) {
      assert.match(block, new RegExp(`outcome\\.kind === '${kind}'`), `${kind} is not handled`);
    }
    assert.ok(!/outcome\.kind === 'sca'/.test(block), 'sca must simply fall through');
    assert.match(fn, /paymentIntent:\s*paymentIntent\.client_secret/);
  });

  test('a decline does NOT settle the attempt', () => {
    // Ending it would mint a new reference and a second subscription for what
    // is still one purchase.
    const block = fn.slice(fn.indexOf("outcome.kind === 'declined'"), fn.indexOf("outcome.kind === 'infrastructure'"));
    assert.ok(!/settle_subscription_attempt/.test(block));
  });

  test('the saved card is only tried when the caller wants it', () => {
    assert.match(fn, /use_saved_card = true \} = await req\.json\(\)/);
    assert.match(fn, /if \(use_saved_card && paymentMethodId && paymentIntent\?\.id\)/);
  });

  test('resuming with the saved card retries the card, not the form', () => {
    // Otherwise every retry after a decline quietly became a card form again.
    const resume = fn.slice(fn.indexOf('async function resumeExisting'));
    assert.match(resume, /if \(useSavedCard\)/);
    assert.match(resume, /confirmSavedCard/);
    assert.match(resume, /CARD_DECLINED/);
  });

  test('resume reuses the same subscription and its first intent', () => {
    const resume = fn.slice(fn.indexOf('async function resumeExisting'));
    assert.match(resume, /subscriptions\.retrieve\(subscriptionId/);
    assert.match(resume, /latest_invoice\.payment_intent/);
    assert.ok(!/subscriptions\.create/.test(resume),
      'resuming created another subscription');
  });

  test('nothing creates a second subscription after a decline', () => {
    const creates = fn.match(/stripe\.subscriptions\.create/g) ?? [];
    assert.equal(creates.length, 1, 'there is more than one place a subscription can be created');
  });
});

/* ── 4. what the owner sees and must choose ───────────────────────────────── */

describe('the card form opens only when asked for', () => {
  test('a decline shows the reason and does not open the form', () => {
    assert.match(billing, /else if \(intent\.declined\)/);
    const block = billing.slice(billing.indexOf('intent.declined'), billing.indexOf('else if (intent.paymentIntent)'));
    assert.ok(!/setPay\(/.test(block), 'a decline still opens the Payment Element automatically');
    assert.match(block, /setDeclined\(/);
  });

  test('the notice offers a deliberate choice', () => {
    assert.match(billing, /Try that card again/);
    assert.match(billing, /Use another card/);
    assert.match(billing, /Nothing has been charged/);
  });

  test('"use another card" is the only route to the form after a decline', () => {
    assert.match(billing, /upgrade\(declined\.target, declined\.period, false\)/);
    assert.match(billing, /upgrade\(declined\.target, declined\.period, true\)/);
    assert.match(client, /use_saved_card: useSavedCard/);
  });

  test('a decline does not end the attempt', () => {
    // Same reference → the server resumes the SAME subscription, invoice and
    // PaymentIntent when another card is chosen.
    const block = billing.slice(billing.indexOf('intent.declined'), billing.indexOf('else if (intent.paymentIntent)'));
    assert.ok(!/endSubAttempt\(\)/.test(block));
    assert.match(billing, /if \(intent\.activated\) \{ endSubAttempt\(\)/);
  });

  test('a cardless owner still goes straight to the form', () => {
    // No saved card means no confirm, so no decline and no extra click.
    assert.match(fn, /if \(!customerId\) \{/);
    assert.match(billing, /else if \(intent\.paymentIntent\) \{/);
  });

  test('the decline clears once something else happens', () => {
    assert.match(billing, /setDeclined\(null\)/);
  });
});

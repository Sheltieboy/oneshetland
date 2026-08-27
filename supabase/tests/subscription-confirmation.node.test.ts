/**
 * subscription-confirmation.node.test.ts — nobody starts paying £12 a month
 * because a page loaded.
 *
 * There were two ways into a first subscription and neither asked.
 *
 *   Route A: /business → "Choose Pro" → /directory/new?plan=pro → create the
 *            listing → …/manage/billing?plan=pro → a useEffect called
 *            upgrade("pro") on mount. With a saved card that took £12. The
 *            only button pressed said "Create listing".
 *
 *   Route B: the billing page's own "Upgrade to Pro · £12/mo" went straight to
 *            stripe.paymentIntents.confirm. Priced and deliberate, but a
 *            single click began a recurring charge with no chance to stop.
 *
 * Both now converge on one boundary: the owner reads the plan, the price and
 * the fact that it repeats, and presses "Subscribe for £12/month". Nothing
 * before that button touches Stripe or mints an attempt reference.
 *
 * The copy is imported and executed for every plan and period. The ordering is
 * proven against the real component source, by brace-matched function body
 * rather than by hopeful regex.
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

const { subscriptionConfirmCopy, isAnnual } = await import(
  join(WEB_ROOT, 'lib/subscription-confirm.ts')
) as typeof import('../../../oneshetland-web/lib/subscription-confirm.ts');

/** Comments stripped, so an assertion can never pass on a promise in prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const billingRaw = readFileSync(join(WEB_ROOT, 'components/business/BillingManager.tsx'), 'utf8');
const billing    = code(billingRaw);
const billingPage = code(readFileSync(join(WEB_ROOT, 'app/business/[id]/manage/billing/page.tsx'), 'utf8'));
const createForm  = code(readFileSync(join(WEB_ROOT, 'components/directory/BusinessCreateForm.tsx'), 'utf8'));
const tierPrice   = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/tier-price.ts'), 'utf8');

/**
 * The body of a named function, by matching braces from its opening one.
 * Regex cannot tell where a function ends; this can, and the ordering claims
 * below are only worth anything if they are scoped to the right function.
 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced braces in ${signature}`);
}

const upgradeBody = bodyOf(billing, 'async function upgrade(');

/* ── 1. what the owner is told, for every plan we sell ────────────────────── */
describe('the confirmation says the plan, the price and that it repeats', () => {
  test('Pro monthly', () => {
    const c = subscriptionConfirmCopy('pro', 'monthly');
    assert.equal(c.plan, 'Pro');
    assert.equal(c.amount, '£12');
    assert.equal(c.interval, 'month');
    assert.equal(c.price, '£12 a month');
    assert.equal(c.title, 'Subscribe to Pro?');
    assert.equal(c.confirmLabel, 'Subscribe for £12/month');
    assert.equal(c.amountPence, 1200);
  });

  test('Premium monthly', () => {
    const c = subscriptionConfirmCopy('premium', 'monthly');
    assert.equal(c.plan, 'Premium');
    assert.equal(c.price, '£29 a month');
    assert.equal(c.confirmLabel, 'Subscribe for £29/month');
    assert.equal(c.amountPence, 2900);
  });

  test('Premium annual', () => {
    const c = subscriptionConfirmCopy('premium', 'annual');
    assert.equal(c.price, '£290 a year');
    assert.equal(c.interval, 'year');
    assert.equal(c.confirmLabel, 'Subscribe for £290/year');
    assert.equal(c.amountPence, 29000);
  });

  test('annual Pro is monthly Pro, exactly as the server resolves it', () => {
    // resolveTierPrice: annual is Premium-only, and a caller nudging an
    // unsupported combination gets the sensible plan rather than an error. The
    // dialog must not promise a yearly Pro that Stripe would never sell.
    assert.equal(isAnnual('pro', 'annual'), false);
    assert.deepEqual(subscriptionConfirmCopy('pro', 'annual'), subscriptionConfirmCopy('pro', 'monthly'));
  });

  test('every plan states the recurrence, the interval and the way out', () => {
    for (const [tier, period] of [['pro', 'monthly'], ['premium', 'monthly'], ['premium', 'annual']] as const) {
      const c = subscriptionConfirmCopy(tier, period);
      assert.match(c.recurrence, /subscription/i, `${tier}/${period} never says it is a subscription`);
      assert.ok(c.recurrence.includes(c.amount), `${tier}/${period} recurrence omits the amount`);
      assert.ok(c.recurrence.includes(c.interval), `${tier}/${period} recurrence omits the interval`);
      assert.match(c.recurrence, /cancel/i, `${tier}/${period} never says it can be cancelled`);
      assert.ok(c.confirmLabel.includes(c.amount), `${tier}/${period} final action omits the price`);
      assert.equal(c.cancelLabel, 'Not now');
    }
  });

  test('the figures quoted are the figures the server will enforce', () => {
    // tier-price.ts refuses to charge a Stripe Price that is not this number.
    // If the two ever drift, the dialog is quoting something nobody will be
    // charged — which is the failure assertPriceMatches exists to catch, and
    // it should be caught here first.
    for (const [key, tier, period] of [
      ['pro:monthly', 'pro', 'monthly'],
      ['premium:monthly', 'premium', 'monthly'],
      ['premium:annual', 'premium', 'annual'],
    ] as const) {
      const m = tierPrice.match(new RegExp(`'${key}':\\s*(\\d+)`));
      assert.ok(m, `tier-price.ts no longer states ${key}`);
      assert.equal(subscriptionConfirmCopy(tier, period).amountPence, Number(m![1]),
        `${key}: the dialog and the server disagree about the price`);
    }
  });
});

/* ── 2. a page load is not a purchase ─────────────────────────────────────── */
describe('the plan query parameter cannot buy anything', () => {
  test('no effect calls upgrade()', () => {
    // The defect exactly: useEffect(() => { … upgrade(intentTier) }, [...]).
    for (const m of billing.matchAll(/useEffect\(/g)) {
      const body = bodyOf(billing.slice(m.index!), 'useEffect(');
      assert.ok(!/\bupgrade\(/.test(body), 'a useEffect still starts an upgrade on mount');
    }
  });

  test('nothing starts a subscription outside a handler', () => {
    for (const call of ['createSubscriptionIntent(', 'applySubscriptionChange(']) {
      for (const m of billing.matchAll(new RegExp(call.replace('(', '\\('), 'g'))) {
        const before = billing.slice(0, m.index!);
        assert.ok(before.lastIndexOf('async function upgrade(') > before.lastIndexOf('useEffect('),
          `${call} is reachable from an effect`);
      }
    }
  });

  test('the mount-time auto-start is gone, by name', () => {
    assert.ok(!/autoStarted/.test(billingRaw), 'the auto-start ref is still there');
  });

  test('the deep link still means something — it selects, it does not buy', () => {
    // Deleting the parameter would have been the lazy fix. It carries real
    // intent ("I came here for Pro"), so it still does — visibly, and inertly.
    assert.match(billingPage, /plan === "pro" \|\| plan === "premium" \? plan : undefined/);
    assert.match(billing, /const highlightTier = intentTier/);
    assert.match(billing, /highlightTier &&/);
    // An invalid ?plan= resolves to undefined at the page, so no tier is
    // highlighted and no control changes behaviour.
    assert.ok(!/intentTier\s*\)/.test(bodyOf(billing, 'async function upgrade(')),
      'upgrade() reads the deep-link tier directly');
  });

  test('creating a listing still routes to billing, and still charges nothing', () => {
    assert.match(createForm, /router\.push\(`\/business\/\$\{data\.id\}\/manage\/billing\?plan=\$\{plan\}`\)/);
    assert.ok(!/createSubscriptionIntent|paymentIntent/i.test(createForm),
      'the create-listing form itself touches payment');
  });
});

/* ── 3. the boundary: confirm, then and only then, pay ────────────────────── */
describe('no first subscription without an explicit confirmation', () => {
  const confirmAt = upgradeBody.indexOf('subscriptionConfirmCopy(');
  const dialogAt  = upgradeBody.indexOf('await confirm({', confirmAt);
  const intentAt  = upgradeBody.indexOf('createSubscriptionIntent(');
  const attemptAt = upgradeBody.indexOf('subAttemptId(');

  test('the confirmation is built and shown before the server is called', () => {
    assert.ok(confirmAt !== -1, 'no confirmation copy is used');
    assert.ok(dialogAt !== -1, 'the copy is never shown');
    assert.ok(intentAt !== -1, 'the purchase call has vanished');
    assert.ok(dialogAt < intentAt, 'the subscription is created before the owner agrees');
  });

  test('declining it returns before anything is created', () => {
    const between = upgradeBody.slice(dialogAt, intentAt);
    assert.match(between, /if \(!agreed\) \{[^}]*return;/,
      'nothing stops the purchase when the dialog is dismissed');
  });

  test('cancelling consumes no attempt reference', () => {
    // The reference is minted inside the call itself, so backing out costs
    // nothing — no row in local_subscription_attempts, no id spent.
    assert.ok(attemptAt > dialogAt, 'the attempt id is minted before the owner agrees');
  });

  test('a saved card does not skip the question', () => {
    const preamble = upgradeBody.slice(0, dialogAt);
    assert.ok(!/useSavedCard/.test(preamble),
      'the confirmation is conditional on how they intend to pay');
  });

  test('the final action names the money', () => {
    assert.match(upgradeBody, /confirmLabel:\s*copy\.confirmLabel/);
    assert.match(upgradeBody, /cancelLabel:\s*copy\.cancelLabel/);
  });

  test('the dialog shows the plan, the price and the recurrence', () => {
    const dialog = upgradeBody.slice(dialogAt, intentAt);
    for (const field of ['copy.plan', 'copy.price', 'copy.recurrence']) {
      assert.ok(dialog.includes(field), `the dialog never shows ${field}`);
    }
  });

  test('changing an existing plan still confirms too', () => {
    // The pre-existing prorated-change confirmation is untouched.
    assert.match(upgradeBody, /confirmLabel: "Switch plan"/);
  });
});

/* ── 4. everything downstream is the flow Paygate 10 already proved ───────── */
describe('the confirmed purchase is the unchanged Paygate 10 flow', () => {
  test('one deliberate purchase still means one attempt reference', () => {
    assert.match(billing, /subAttempt\.current\.key !== key/);
    assert.match(billing, /newCheckoutAttemptId\(\)/);
    const body = bodyOf(billing, 'function subAttemptId(');
    assert.ok(!/useEffect|setState/.test(body), 'the reference is no longer minted synchronously');
  });

  test('the reference survives a retry and is ended only on a terminal answer', () => {
    assert.match(billing, /if \(intent\.activated\) \{ endSubAttempt\(\)/);
    assert.match(billing, /code === 'ATTEMPT_TERMINAL' \|\| code === 'ATTEMPT_CONFLICT'\) endSubAttempt\(\)/);
  });

  test('a refused saved card still says so, and still opens no card form', () => {
    assert.match(billing, /intent\.declined/);
    assert.match(billing, /setDeclined\(\{ message: intent\.error/);
    assert.match(billingRaw, /Try that card again/);
    assert.match(billingRaw, /Use another card/);
    assert.match(billingRaw, /Nothing has been charged\. You can try again, or pay with another card\./);
  });

  test('a retry after a decline re-attempts the card, or deliberately does not', () => {
    assert.match(billing, /upgrade\(declined\.target, declined\.period, true\)/);
    assert.match(billing, /upgrade\(declined\.target, declined\.period, false\)/);
  });

  test('SCA still completes the same PaymentIntent, with no second confirmation', () => {
    const afterIntent = upgradeBody.slice(upgradeBody.indexOf('createSubscriptionIntent('));
    assert.match(afterIntent, /intent\.paymentIntent/);
    assert.match(afterIntent, /setPay\(\{ clientSecret: intent\.paymentIntent/);
    assert.ok(!/await confirm\(/.test(afterIntent),
      'the card form is gated behind a second confirmation');
  });

  test('the cardless owner reaches the Payment Element and pays there', () => {
    assert.match(billing, /<PaymentCheckout clientSecret=\{pay\.clientSecret\}/);
    assert.match(billing, /onPaid=\{\(\) => \{ endSubAttempt\(\); setPay\(null\); pollTier\(\); \}\}/);
  });

  test('the tier still lands from the webhook, not from this screen', () => {
    assert.ok(!/subscription_tier:\s*"(pro|premium)"/.test(billing),
      'the browser writes the entitlement');
    assert.match(billing, /pollTier\(/);
  });
});

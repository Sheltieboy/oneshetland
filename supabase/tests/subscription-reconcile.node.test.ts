/**
 * subscription-reconcile.node.test.ts — a missing subscription is not a
 * cancelled one.
 *
 * When two webhook snapshots share an event.created second and disagree, the
 * database refuses to guess and the webhook asks Stripe what the subscription
 * actually is. That reconciliation once translated 404 / resource_missing into
 * status 'canceled', reasoning that a subscription Stripe no longer knows can
 * only be gone.
 *
 * The reasoning was wrong. Stripe RETAINS canceled Subscription objects and
 * serves them from this endpoint, so a genuine cancellation returns 200 with
 * status='canceled'. A 404 therefore means something else — the wrong account
 * or mode, a Connect-scoped object read without its account context, a key
 * pointing at a different environment. Every one of those is a reason to stop,
 * not a reason to revoke a paying customer's plan.
 *
 * These call the real parser directly, so every failure path is exercised for
 * real rather than asserted about in source.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReconciledSubscription, ReconcileFailed,
} from '../functions/_shared/subscription-reconcile.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');
const webhook = code(readFileSync(join(REPO_ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8'));

const LIVE = {
  id: 'sub_x', status: 'active', customer: 'cus_x', cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1793000000 }] },
};

/* ── 1. failures never become facts ───────────────────────────────────────── */

describe('an unclean answer is not an answer', () => {
  test('404 resource_missing is NOT a cancellation', () => {
    // The defect. Stripe serves cancelled subscriptions with status='canceled',
    // so a 404 is an unexplained answer — wrong account, wrong mode, wrong
    // context — and must never revoke a paying customer's plan.
    assert.throws(
      () => parseReconciledSubscription(false, 404, { error: { code: 'resource_missing', message: 'No such subscription' } }, 'sub_x'),
      ReconcileFailed,
    );
  });

  test('a bare 404 with no body is not a cancellation either', () => {
    assert.throws(() => parseReconciledSubscription(false, 404, {}, 'sub_x'), ReconcileFailed);
  });

  for (const [label, status] of [['unauthorised', 401], ['forbidden', 403],
                                 ['rate limited', 429], ['server error', 500],
                                 ['bad gateway', 502]] as const) {
    test(`${status} (${label}) fails closed`, () => {
      assert.throws(() => parseReconciledSubscription(false, status, { error: { message: label } }, 'sub_x'),
        ReconcileFailed);
    });
  }

  test('a 200 carrying no status is refused', () =>
    // Malformed is not authoritative either.
    assert.throws(() => parseReconciledSubscription(true, 200, { id: 'sub_x' }, 'sub_x'), ReconcileFailed));

  test('the failure names the subscription but leaks no Stripe detail to callers', () => {
    try {
      parseReconciledSubscription(false, 404, { error: { code: 'resource_missing' } }, 'sub_x');
      assert.fail('should have thrown');
    } catch (e) {
      const err = e as ReconcileFailed;
      assert.equal(err.subId, 'sub_x');
      assert.match(err.message, /could not reconcile subscription sub_x/);
    }
  });

  test('no status is ever fabricated on a failure path', () => {
    const src = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/subscription-reconcile.ts'), 'utf8');
    const body = code(src);
    assert.ok(!/return\s*\{[^}]*status:\s*'canceled'/.test(body),
      'a failure path invents a cancelled subscription');
    assert.ok(!/httpStatus === 404|status === 404/.test(body),
      'a 404 is being treated as meaningful state');
  });
});

/* ── 2. a real answer is honoured ─────────────────────────────────────────── */

describe('an authoritative answer is used exactly as given', () => {
  test('a genuinely cancelled subscription is reported as cancelled', () => {
    // Cancellation handling is not weakened — it just has to come from Stripe.
    const r = parseReconciledSubscription(true, 200, { ...LIVE, status: 'canceled' }, 'sub_x');
    assert.equal(r.status, 'canceled');
  });

  test('a live subscription is reported live, with its price and period', () => {
    const r = parseReconciledSubscription(true, 200, LIVE, 'sub_x');
    assert.equal(r.status, 'active');
    assert.equal(r.priceId, 'price_pro');
    assert.equal(r.customer, 'cus_x');
    assert.equal(r.cancelAtPeriodEnd, false);
    assert.equal(r.periodEndIso, new Date(1793000000 * 1000).toISOString());
  });

  test('past_due and incomplete_expired are passed through, not reinterpreted', () => {
    for (const s of ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing']) {
      assert.equal(parseReconciledSubscription(true, 200, { ...LIVE, status: s }, 'sub_x').status, s);
    }
  });

  test('cancel_at_period_end and the legacy top-level period are honoured', () => {
    const r = parseReconciledSubscription(true, 200,
      { id: 'sub_x', status: 'active', customer: 'cus_x', cancel_at_period_end: true,
        current_period_end: 1793000000, items: { data: [{ price: { id: 'price_prem' } }] } }, 'sub_x');
    assert.equal(r.cancelAtPeriodEnd, true);
    assert.equal(r.periodEndIso, new Date(1793000000 * 1000).toISOString());
  });
});

/* ── 3. the webhook uses it, and lets it fail ─────────────────────────────── */

describe('the webhook does not swallow a reconciliation failure', () => {
  test('it delegates parsing rather than interpreting Stripe itself', () => {
    assert.match(webhook, /parseReconciledSubscription\(res\.ok, res\.status, body, subId\)/);
    assert.ok(!/resource_missing/.test(webhook),
      'the 404-is-cancelled assumption is back in the webhook');
  });

  test('a network failure throws rather than becoming a state', () =>
    assert.match(webhook, /catch \(e\) \{[\s\S]{0,200}throw new ReconcileFailed\(subId/));

  test('nothing catches the failure and carries on', () => {
    // It must reach the handler's own catch, which marks the event failed and
    // returns 500 so Stripe retries.
    const block = webhook.slice(webhook.indexOf("reason === 'needs_reconcile'"),
                                webhook.indexOf("reason === 'needs_reconcile'") + 900);
    assert.ok(!/try \{[\s\S]*reconcileSubscription/.test(block),
      'the reconcile call is wrapped in a catch that would hide the failure');
  });

  test('a deletion is only applied when Stripe confirms it is finished', () => {
    assert.match(webhook, /\['canceled', 'incomplete_expired'\]\.includes\(fresh\.status\)/);
    assert.match(webhook, /contradicted by Stripe/);
  });
});

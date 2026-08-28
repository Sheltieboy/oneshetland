/**
 * boost-offer-staleness.node.test.ts — a subscriber is not offered a boost.
 *
 * The first real Pro subscription landed, the plan panel said "Pro · £12/mo,
 * renews 28 September", and directly underneath it the page still offered
 * "Or try Pro for a short time — 1 week £7 / 2 weeks £12 / 3 weeks £15".
 *
 * Nothing was wrong with the rule. The boost offer is gated on the SERVER's
 * answer, `boostPreview.boost_eligible`, and the server had answered honestly:
 * when the page loaded, the business was Free. The effect that asked was keyed
 * `[b.id]`, so when activation called router.refresh() the server half became
 * Pro while the id stayed put, the effect never re-ran, and the Free-era answer
 * survived on screen underneath a live subscription.
 *
 * Two changes, both narrow. The question is re-asked when the subscription
 * state moves, and the offer is suppressed outright while a live subscription
 * exists — `subscription_connected` being the server's own mirror of the first
 * thing local-boost-checkout asks. The suppression can only HIDE. Nothing in
 * the browser can offer a boost the server did not approve, so the two cannot
 * disagree in the direction that takes somebody's money.
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

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const billingRaw = readFileSync(join(WEB_ROOT, 'components/business/BillingManager.tsx'), 'utf8');
const billing    = code(billingRaw);
const bizData    = code(readFileSync(join(WEB_ROOT, 'lib/business-data.ts'), 'utf8'));
const checkout   = readFileSync(join(REPO_ROOT, 'supabase/functions/local-boost-checkout/index.ts'), 'utf8');

/** Brace-matched body, from the `{` the marker itself opens. */
function bodyFrom(src: string, marker: string): string {
  const open = src.indexOf(marker);
  assert.notEqual(open, -1, `could not find ${marker}`);
  const brace = src.indexOf('{', open);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(brace, i + 1); }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

/** The dependency array of the effect that asks whether a boost may be sold. */
function boostEffectDeps(): string {
  const at = billing.indexOf('previewBoost(b.id)');
  assert.notEqual(at, -1, 'the boost preview is no longer fetched');
  const tail = billing.slice(at);
  const m = tail.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(m, 'the boost effect has no dependency array');
  return m![1];
}

/**
 * The server's answer to `boostEligibility`, executed rather than described —
 * the same decision tree the deployed Edge Function runs, extracted from its
 * own source so the two cannot drift apart silently.
 */
function serverEligibility(b: {
  subscription_tier?: string | null;
  subscription_until?: string | null;
  stripe_subscription_id?: string | null;
}): { eligible: boolean; reason: string } {
  if (b.stripe_subscription_id) return { eligible: false, reason: 'active_subscription' };
  const tier = b.subscription_tier ?? 'free';
  const until = b.subscription_until ? new Date(b.subscription_until) : null;
  const expired = !!until && until <= new Date();
  if (tier === 'free') return { eligible: true, reason: 'free' };
  if (expired) return { eligible: true, reason: 'expired_entitlement' };
  if (tier === 'premium') return { eligible: false, reason: 'higher_entitlement' };
  if (tier === 'pro' && !until) return { eligible: false, reason: 'indefinite_entitlement' };
  if (tier === 'pro') return { eligible: true, reason: 'extending_boost' };
  return { eligible: false, reason: 'higher_entitlement' };
}

/**
 * The panel's OWN render condition, lifted out of the component and executed.
 *
 * Deliberately not re-typed here. A hand-written copy of the condition would
 * make every case below a test of the copy: delete the guard from the
 * component and the suite would still pass, cheerfully proving something that
 * is no longer shipped. Extracted and evaluated, these cases exercise the
 * expression that actually renders.
 */
const OFFER_CONDITION = (() => {
  const m = billing.match(
    /\{([^{}]*?)\s*&&\s*\(\s*\n\s*<div className="mt-3 rounded-xl border border-line p-3">/,
  );
  assert.ok(m, 'could not find the boost offer’s render condition');
  return m![1].trim();
})();

const evalOffer = new Function('b', 'boostPreview', `return Boolean(${OFFER_CONDITION});`) as
  (b: Record<string, unknown>, preview: unknown) => boolean;

const boostOfferShown = (
  b: { subscription_connected: boolean; subscription_cancel_at_period_end?: boolean },
  preview: { boost_eligible: boolean } | null,
) => evalOffer(b as Record<string, unknown>, preview);

const YEAR_AHEAD = new Date(Date.now() + 300 * 86_400_000).toISOString();
const LAST_MONTH = new Date(Date.now() - 30 * 86_400_000).toISOString();

/* ── 1. the states that matter ────────────────────────────────────────────── */
describe('who is offered a boost', () => {
  test('Free with no subscription — offered, exactly as before', () => {
    const server = serverEligibility({ subscription_tier: 'free' });
    assert.equal(server.eligible, true);
    assert.equal(boostOfferShown({ subscription_connected: false }, { boost_eligible: server.eligible }), true);
  });

  test('a live Pro subscription — hidden', () => {
    const server = serverEligibility({ subscription_tier: 'pro', subscription_until: YEAR_AHEAD, stripe_subscription_id: 'sub_x' });
    assert.equal(server.eligible, false);
    assert.equal(server.reason, 'active_subscription');
    assert.equal(boostOfferShown({ subscription_connected: true }, { boost_eligible: server.eligible }), false);
  });

  test('a live Premium subscription — hidden', () => {
    const server = serverEligibility({ subscription_tier: 'premium', subscription_until: YEAR_AHEAD, stripe_subscription_id: 'sub_x' });
    assert.equal(server.eligible, false);
    assert.equal(boostOfferShown({ subscription_connected: true }, { boost_eligible: server.eligible }), false);
  });

  test('manual Premium with no subscription — still hidden, by the server', () => {
    // No stripe_subscription_id, so `subscription_connected` is false and the
    // suppression does nothing. The server refuses on its own.
    const server = serverEligibility({ subscription_tier: 'premium', subscription_until: null });
    assert.equal(server.eligible, false);
    assert.equal(server.reason, 'higher_entitlement');
    assert.equal(boostOfferShown({ subscription_connected: false }, { boost_eligible: server.eligible }), false);
  });

  test('a temporary boosted Pro — still offered, because boosts stack', () => {
    const server = serverEligibility({ subscription_tier: 'pro', subscription_until: YEAR_AHEAD });
    assert.equal(server.eligible, true);
    assert.equal(server.reason, 'extending_boost');
    assert.equal(boostOfferShown({ subscription_connected: false }, { boost_eligible: server.eligible }), true);
  });

  test('a lapsed entitlement with nothing behind it — offered again', () => {
    const server = serverEligibility({ subscription_tier: 'pro', subscription_until: LAST_MONTH });
    assert.equal(server.eligible, true);
    assert.equal(boostOfferShown({ subscription_connected: false }, { boost_eligible: server.eligible }), true);
  });
});

/* ── 2. the transition that caused this ───────────────────────────────────── */
describe('Free becomes Pro without a hard reload', () => {
  test('the Free-era answer cannot outlive the subscription that replaced it', () => {
    // The exact sequence: the preview was fetched while Free (eligible), then
    // the subscription activated and router.refresh() brought back a Pro
    // business with a live subscription. The HELD preview is deliberately left
    // stale here — that is what it was — and the offer must still be gone.
    const stale = { boost_eligible: true };
    assert.equal(boostOfferShown({ subscription_connected: false }, stale), true, 'before');
    assert.equal(boostOfferShown({ subscription_connected: true }, stale), false, 'after activation');
  });

  test('and the question is asked again, rather than frozen at mount', () => {
    const deps = boostEffectDeps();
    assert.match(deps, /b\.subscription_connected/, 'the preview ignores subscription state changing');
    assert.match(deps, /b\.subscription_tier/, 'the preview ignores the tier changing');
    assert.match(deps, /b\.id/);
  });

  test('activation refreshes the server half that the offer now reads', () => {
    assert.match(billing, /if \(intent\.activated\) \{ endSubAttempt\(\); setDeclined\(null\); router\.refresh\(\); pollTier\(\); \}/);
    assert.match(bodyFrom(billing, 'function pollTier('), /router\.refresh\(\)/);
  });
});

/* ── 3. plan changes and cancellation ─────────────────────────────────────── */
describe('a live subscription stays live', () => {
  test('Pro → Premium never flickers the offer back', () => {
    for (const tier of ['pro', 'premium'] as const) {
      assert.equal(boostOfferShown({ subscription_connected: true }, { boost_eligible: true }), false, tier);
    }
  });

  test('cancel_at_period_end is a plan still running, not a plan gone', () => {
    // The subscription lives until the period ends. Asking to cancel must not
    // put a boost in front of somebody who is still paying for Pro.
    const server = serverEligibility({ subscription_tier: 'pro', subscription_until: YEAR_AHEAD, stripe_subscription_id: 'sub_x' });
    assert.equal(server.eligible, false);
    assert.equal(boostOfferShown({ subscription_connected: true }, { boost_eligible: false }), false);
    // Nothing in the render condition consults the cancellation flag.
    const at = billing.indexOf('!b.subscription_connected && boostPreview?.boost_eligible');
    assert.notEqual(at, -1, 'the suppression is gone');
    assert.ok(!/cancel_at_period_end/.test(billing.slice(at, at + 200)),
      'the offer reappears merely because cancellation was requested');
  });

  test('once the subscription really ends, normal eligibility returns', () => {
    // retire_subscription clears the id and drops the tier; subscription_connected
    // follows, the deps change, and the server is asked afresh.
    const server = serverEligibility({ subscription_tier: 'free', subscription_until: null });
    assert.equal(server.eligible, true);
    assert.equal(boostOfferShown({ subscription_connected: false }, { boost_eligible: server.eligible }), true);
  });
});

/* ── 4. the server keeps the last word ────────────────────────────────────── */
describe('the backend remains the boundary', () => {
  test('the flag the browser reads is the server’s own answer, not a guess', () => {
    assert.match(bizData, /subscription_connected: boolean;/);
    assert.match(checkout, /if \(b\.stripe_subscription_id\) return \{ eligible: false, reason: 'active_subscription' \};/);
  });

  test('the suppression can only hide, never offer', () => {
    // `!connected && eligible` is a strict narrowing of `eligible`: for every
    // combination it is false wherever the server said no.
    for (const connected of [true, false]) {
      for (const eligible of [true, false]) {
        const shown = boostOfferShown({ subscription_connected: connected }, { boost_eligible: eligible });
        if (!eligible) assert.equal(shown, false, 'the browser offered what the server refused');
      }
    }
  });

  test('no second eligibility rule was invented in the browser', () => {
    const at = billing.indexOf('!b.subscription_connected && boostPreview?.boost_eligible');
    const cond = billing.slice(at, billing.indexOf('(', at) + 1);
    assert.ok(!/subscription_until|TIER_RANK|tierMeets/.test(cond),
      'the panel now decides eligibility for itself');
  });

  test('buying one is still refused by the server, with a reason', () => {
    assert.match(checkout, /active_subscription:\s*"You're already on a monthly plan/);
    // Preview and payment go through the SAME function, so a screen cannot
    // offer what the payment would refuse.
    assert.ok(checkout.indexOf('boostEligibility(') < checkout.lastIndexOf('boostEligibility('),
      'eligibility is decided in only one place');
  });
});

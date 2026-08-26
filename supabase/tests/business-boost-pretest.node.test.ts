/**
 * business-boost-pretest.node.test.ts — three blockers before the first boost.
 *
 * A "boost" is a one-off block of Pro for a business: 1, 2 or 3 weeks, £7/£12/
 * £15, OneShetland's own revenue with no connected account involved. The
 * fulfilment behind it was already the strongest of any paygate — webhook
 * authoritative, conditional claim, unique payment-intent index. Three things
 * in front of it were not.
 *
 * A — NOTHING TIED A CHECKOUT TO ITS PAYMENT INTENT
 *
 * No client_request_id, and no Stripe idempotency key on either intent. A
 * double-click, a retry or a dropped response minted a second PaymentIntent for
 * one purchase, and exactly-once fulfilment cannot help: it guarantees one
 * extension per INTENT, so two intents meant two charges and two extensions.
 *
 * B — A SWALLOWED ERROR BECAME A SECOND CHARGE
 *
 *     } catch (_e) { /* declined → fall through to the card form *\/ }
 *
 * Every failure of the saved-card confirm was swallowed, and execution fell
 * through to create a card-form intent. A timeout where Stripe HAD charged the
 * card therefore produced a second intent for the same boost — the "unresolved"
 * case Paygate 7 exists to prevent. It also decided, on the buyer's behalf,
 * that a declined card means "use a different one".
 *
 * C — THE BUTTONS DID NOT SAY WHAT THEY COST
 *
 * They read "1 wk", "2 wk", "3 wk" and charged on the press. No amount anywhere
 * on the screen, no confirmation. The prices live in admin_config, which only a
 * platform admin may read, so the owner's own billing screen could not look
 * them up — it had to be told, and nothing told it.
 *
 * SAFETY
 * Source-level plus live fixture probes on a disposable business. No boost was
 * purchased and no payment confirmed — an unconfirmed PaymentIntent charges
 * nothing.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const boostFn  = code(read('supabase/functions/local-boost-checkout/index.ts'));
const webhook  = code(read('supabase/functions/stripe-webhook/index.ts'));
const bizClient = code(web('lib/business-client.ts'));
const billing  = code(web('components/business/BillingManager.tsx'));
const checkout = code(web('components/business/BoostCheckout.tsx'));
const appDash  = read('app/local-business-dashboard.tsx');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── A. one checkout, one intent ──────────────────────────────────────────── */

describe('a deliberate boost checkout reaches exactly one PaymentIntent', () => {
  test('the attempt reference is required and validated before Stripe', () => {
    assert.match(boostFn, /client_request_id required/);
    assert.match(boostFn, /client_request_id must be 8-100 characters/);
    // Nothing may reach Stripe on a malformed attempt.
    assert.ok(boostFn.indexOf('client_request_id must be 8-100') < boostFn.indexOf('new Stripe('));
  });

  test('the saved-card intent carries it in the Stripe key', () => {
    assert.match(boostFn, /idempotencyKey: `local-boost-\$\{user\.id\}-\$\{business_id\}-\$\{weeks\}-\$\{client_request_id\}`/);
  });

  test('the card-form intent carries it too, in its own namespace', () => {
    assert.match(boostFn, /idempotencyKey: `local-boost-form-\$\{user\.id\}-\$\{business_id\}-\$\{weeks\}-\$\{client_request_id\}`/);
  });

  test('the key includes the attempt, so a later extension is not deduplicated', () => {
    // business + weeks alone would collapse a genuine second purchase of the
    // same duration into the first one's intent.
    for (const m of boostFn.match(/idempotencyKey: `[^`]+`/g) ?? []) {
      assert.match(m, /client_request_id/, `${m} does not identify the attempt`);
    }
  });

  test('the web checkout mints one reference and holds it across retries', () => {
    assert.match(checkout, /const attemptId = useAttemptId\(option\.weeks\)/);
    assert.match(checkout, /createBoostIntent\(business\.id, option\.weeks, attemptId\(\), usingSavedCard\)/);
    assert.match(bizClient, /client_request_id: attemptId/);
  });
});

/* ── B. a failure is a failure ────────────────────────────────────────────── */

describe('a saved-card failure never becomes a second charge', () => {
  test('the catch-all fall-through is gone', () => {
    // The saved-card confirm must not swallow anything. (firstCard keeps its
    // own catch — "could not read the customer" genuinely means "no card", and
    // it creates no PaymentIntent.)
    const payPath = boostFn.slice(boostFn.indexOf('if (cardCustomer && cardPm)'),
                                  boostFn.indexOf('let customerId = business.stripe_customer_id'));
    assert.doesNotMatch(payPath, /catch \(_e\)/);
    assert.match(payPath, /catch \(err\) \{/);
    assert.match(payPath, /return json\(/);
  });

  test('a failed saved-card confirm returns an error instead', () => {
    assert.match(boostFn, /saved_card_failed: true/);
    assert.match(boostFn, /That card could not complete the payment/);
  });

  test('no card-form intent is created after a saved-card failure', () => {
    // The failure branch returns; it cannot reach the card-form create below.
    const idx = boostFn.indexOf('saved_card_failed');
    const formIdx = boostFn.indexOf('local-boost-form-');
    assert.ok(idx > 0 && formIdx > idx, 'the card-form intent is not after the failure return');
    assert.match(boostFn.slice(idx - 400, idx + 200), /return json\(/);
  });

  test('the browser does not silently switch method either', () => {
    assert.match(checkout, /const usingSavedCard = method === "saved"/);
    assert.match(checkout, /if \(!usingSavedCard && res\.paymentIntent\)/);
    assert.match(checkout, /if \(usingSavedCard\) throw new Error\(/);
  });

  test('a buyer with no saved card still gets the card form', () => {
    assert.match(boostFn, /if \(use_saved_card && business\.has_business_payment_method/);
    assert.match(checkout, /title=\{hasSavedCard \? "Use another card" : "Pay by card"\}/);
    assert.doesNotMatch(boostFn, /No saved card found/);
  });
});

/* ── C. the price is on the button ────────────────────────────────────────── */

describe('nothing charges without saying what it costs', () => {
  test('the durations are priced from the server, not hardcoded', () => {
    assert.match(billing, /previewBoost\(b\.id\)/);
    assert.match(billing, /\{o\.weeks\} week\{o\.weeks > 1 \? "s" : ""\} · \{gbp\(o\.amountPence\)\}/);
    assert.doesNotMatch(billing, /`\$\{w\} wk`/);
  });

  test('the preview creates no PaymentIntent at all', () => {
    const preview = boostFn.slice(boostFn.indexOf('if (preview) {'), boostFn.indexOf('const priceKey'));
    assert.doesNotMatch(preview, /paymentIntents\.create|new Stripe\(/);
    assert.match(preview, /options/);
  });

  test('choosing a duration opens a checkout rather than charging', () => {
    assert.match(billing, /function openBoost\(option: BoostOption\)/);
    const open = billing.slice(billing.indexOf('function openBoost'), billing.indexOf('function openBoost') + 200);
    assert.doesNotMatch(open, /createBoostIntent/);
  });

  test('the checkout states the price, the total and where Pro lands', () => {
    assert.match(checkout, /Boost price/);
    assert.match(checkout, /Total today/);
    assert.match(checkout, /Extends to \{fmt\(option\.newExpiry\)\}/);
    assert.match(checkout, /Pro until \{fmt\(option\.newExpiry\)\}/);
  });

  test('only the Pay button charges, and it carries the amount', () => {
    assert.match(checkout, /`Pay \$\{gbp\(option\.amountPence\)\}`/);
    assert.match(checkout, /onClick=\{pay\}/);
  });

  test('no fee is invented — the price is the total', () => {
    assert.doesNotMatch(checkout, /fee|Fee/);
  });
});

/* ── D. everything that was already right ─────────────────────────────────── */

describe('the strong parts are untouched', () => {
  test('price and duration are still server-authoritative', () => {
    assert.match(boostFn, /`boost\.price\.\$\{weeks\}_week_pence`/);
    assert.match(boostFn, /!\[1, 2, 3\]\.includes\(weeks\)/);
    assert.doesNotMatch(boostFn, /body\.amount|amount_pence:\s*amount\b/);
  });

  test('the prices in production are still £7 / £12 / £15', () => {
    const r = runSql(`select string_agg(key || '=' || value, ',' order by key) v
                        from public.admin_config where key like 'boost.price.%';`)[0];
    assert.equal(r.v, 'boost.price.1_week_pence=700,boost.price.2_week_pence=1200,boost.price.3_week_pence=1500');
  });

  test('it is still platform revenue — no connected account anywhere', () => {
    for (const re of [/transfer_data/, /application_fee_amount/, /on_behalf_of/, /selfPaymentBlock/]) {
      assert.doesNotMatch(boostFn, re, 'a Connect destination or self-payment guard appeared');
    }
  });

  test('only the owner may buy, and only without a live subscription', () => {
    assert.match(boostFn, /business\.owner_id !== user\.id\) return json\(\{ error: 'Forbidden' \}, 403\)/);
    // The subscription check moved into boostEligibility when the one rule was
    // unified; it is still the first thing that predicate asks.
    assert.match(boostFn, /if \(b\.stripe_subscription_id\) return \{ eligible: false, reason: 'active_subscription' \}/);
  });

  test('the webhook is still the authority, claiming before it grants', () => {
    assert.match(webhook, /\.update\(\{ status: 'succeeded' \}\)[\s\S]{0,120}\.neq\('status', 'succeeded'\)/);
    assert.match(webhook, /const startFrom = biz\?\.subscription_until && new Date\(biz\.subscription_until\) > now/);
    assert.match(webhook, /weeks \* 7 \* 24 \* 60 \* 60 \* 1000/);
  });

  test('one payment intent still buys exactly one extension', () => {
    const r = runSql(`select case when exists (select 1 from pg_indexes
                        where tablename = 'local_boost_purchases'
                          and indexdef ilike '%unique%stripe_payment_intent_id%')
                      then 'unique' else 'MISSING' end v;`)[0];
    assert.equal(r.v, 'unique');
  });

  test('an owner still cannot grant themselves Pro directly', () => {
    const r = runSql(`select case when prosrc ilike '%new.subscription_until%:=%old.subscription_until%'
                        then 'locked' else 'WRITABLE' end v
                        from pg_proc where proname = 'tg_lock_business_columns';`)[0];
    assert.equal(r.v, 'locked');
  });

  test('a payment that never succeeds grants nothing', () => {
    // The purchase row is written 'pending'; only the webhook's claim flips it.
    assert.match(boostFn, /status: 'pending'/);
    assert.match(webhook, /meta\.type === 'local_boost' && meta\.business_id/);
  });

  test('the app boost CTA stays deliberately absent', () => {
    assert.match(appDash, /boost CTA is no longer rendered/);
    assert.doesNotMatch(code(appDash), /createBoostIntent/);
  });

  test('the boost checkout is the only place the web starts one', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'components/business/BoostCheckout.tsx')));
    assert.doesNotMatch(billing, /createBoostIntent\(/);
  });
});

/* ── E. one eligibility rule, decided by the server ───────────────────────── */

/**
 * A boost writes subscription_tier='pro' and a calculated expiry. That is a
 * GRANT for a business with nothing and a REDUCTION for one that already has
 * more, so eligibility is not "may we take the money" but "does this leave
 * them better off".
 *
 * The two sides disagreed. The web gated on `tier === 'free'`, which hid the
 * panel from a business already on a boost — the one case the webhook's
 * stacking arithmetic exists for. The server gated only on a live Stripe
 * subscription, so it would have sold a Premium business a downgrade to Pro.
 */
describe('who may be sold a boost is decided in one place', () => {
  test('the predicate lives in the function, not in a screen', () => {
    assert.match(boostFn, /function boostEligibility\(/);
    assert.match(boostFn, /reason: 'active_subscription'/);
    assert.match(boostFn, /reason: 'higher_entitlement'/);
    assert.match(boostFn, /reason: 'indefinite_entitlement'/);
    assert.match(boostFn, /reason: 'extending_boost'/);
  });

  test('the purchase refuses an ineligible business before Stripe', () => {
    assert.match(boostFn, /const eligibility = boostEligibility\(business\)/);
    assert.match(boostFn, /if \(!preview && !eligibility\.eligible\)/);
    // Refused before the price is read and long before an intent is created.
    assert.ok(boostFn.indexOf('boostEligibility(business)') < boostFn.indexOf('const priceKey'));
    assert.ok(boostFn.indexOf('if (!preview && !eligibility.eligible)') < boostFn.indexOf('new Stripe('));
  });

  test('the preview answers with the same predicate, not its own', () => {
    // One call, one verdict — a screen cannot offer what the payment refuses.
    assert.equal((boostFn.match(/boostEligibility\(/g) ?? []).length, 2); // definition + single call
    assert.match(boostFn, /boost_eligible: false,\s*reason: eligibility\.reason/);
    assert.match(boostFn, /boost_eligible: true,\s*reason: eligibility\.reason/);
  });

  test('a current Premium entitlement is refused however it arose', () => {
    // Paid or seeded: 'pro' is less than what they hold.
    assert.match(boostFn, /if \(tier === 'premium'\) return \{ eligible: false, reason: 'higher_entitlement' \}/);
  });

  test('indefinite Pro is refused rather than given an expiry', () => {
    assert.match(boostFn, /if \(tier === 'pro' && !until\) return \{ eligible: false, reason: 'indefinite_entitlement' \}/);
  });

  test('an expired entitlement, and a running boost, are both eligible', () => {
    assert.match(boostFn, /if \(expired\) return \{ eligible: true, reason: 'expired_entitlement' \}/);
    assert.match(boostFn, /if \(tier === 'pro'\) return \{ eligible: true, reason: 'extending_boost' \}/);
  });

  test('an unknown tier that is still running is not reduced', () => {
    const tail = boostFn.slice(boostFn.indexOf("reason: 'extending_boost'"));
    assert.match(tail, /return \{ eligible: false, reason: 'higher_entitlement' \}/);
  });

  test('no Stripe identifier leaks in a refusal', () => {
    const msgs = boostFn.slice(boostFn.indexOf('INELIGIBLE_MESSAGE'), boostFn.indexOf('serve(async'));
    assert.doesNotMatch(msgs, /sub_|cus_|pi_|acct_/);
  });
});

describe('the billing screen asks rather than guesses', () => {
  test('the boost panel no longer rides on the free-tier gate', () => {
    assert.match(billing, /\{boostPreview\?\.boost_eligible && \(/);
    const freeBlock = billing.slice(billing.indexOf('{tier === "free" && ('));
    assert.doesNotMatch(freeBlock.slice(0, freeBlock.indexOf('</>')), /try Pro for a short time/,
      'the boost panel is still inside the free-tier gate');
  });

  test('it is not merely widened to pro, which would expose indefinite Pro', () => {
    assert.doesNotMatch(billing, /tier === "free" \|\| tier === "pro"/);
  });

  test('a business already on a boost is shown what it extends to', () => {
    assert.match(checkout, /const extending = !!currentUntil && new Date\(currentUntil\) > new Date\(\)/);
    assert.match(checkout, /Pro access until \{fmt\(currentUntil!\)\}/);
    assert.match(checkout, /Extends to \{fmt\(option\.newExpiry\)\}/);
  });

  test('the extension still uses the server duration rule', () => {
    assert.match(boostFn, /const startFrom = until && until > now \? until : now/);
    assert.match(webhook, /const startFrom = biz\?\.subscription_until && new Date\(biz\.subscription_until\) > now/);
  });
});

describe('a Premium business cannot be downgraded by buying a boost', () => {
  test('the refusal is in the payment path, not just the UI', () => {
    // Hiding the button protects nobody who calls the function directly.
    const gate = boostFn.slice(boostFn.indexOf('const eligibility'), boostFn.indexOf('const priceKey'));
    assert.match(gate, /return json\(/);
    assert.match(gate, /boost_eligible: false/);
  });

  test('the production business that prompted this stays ineligible', () => {
    // DEMO — Shetland Makkers: premium tier, no expiry, no subscription.
    const r = runSql(`select subscription_tier, coalesce(subscription_until::text,'null') until,
                             coalesce(stripe_subscription_id,'null') sub
                        from public.local_businesses where slug = 'demo-shetland-makkers';`)[0];
    assert.equal(r.subscription_tier, 'premium');
    assert.equal(r.until, 'null');
    assert.equal(r.sub, 'null');
    // premium + no expiry + no subscription -> higher_entitlement -> refused.
  });
});

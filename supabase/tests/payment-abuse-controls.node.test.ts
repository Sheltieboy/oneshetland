/**
 * payment-abuse-controls.node.test.ts — OneShetland must not be an efficient place to test stolen cards.
 *
 * THE THREAT
 *
 * A normal confirmed account, automated, calling the payment-start endpoints directly (ignoring the UI) and then trying card after
 * card against whatever Stripe objects came back. Money cannot be stolen this way; the harm is OneShetland's Stripe account being
 * used as a card-testing surface (dispute and fraud-rate exposure, Stripe scrutiny, clutter).
 *
 * WHAT THE AUDIT FOUND
 *
 *   · local-subscription-intent, local-boost-checkout, local-subscription-checkout had NO limiter — a loop of fresh client_request_ids
 *     created a fresh Subscription / PaymentIntent every time.
 *   · Even the routes that had one only counted CREATIONS. A client secret can be confirmed with a new card repeatedly, straight to
 *     Stripe, and no failed attempt was ever counted.
 *
 * WHAT RUNS
 *
 * The REAL handlers (local-subscription-intent, local-boost-checkout) and the real _shared/rate-limit.ts and payment-failure-brake.ts
 * are loaded as source and driven against: a fake Stripe that counts every object created (and honours idempotency keys like
 * Stripe does), an in-memory Supabase, and an in-memory limiter whose policy numbers are READ FROM THE MIGRATIONS (so the test
 * moves if the numbers do). Nothing leaves the process: any request to a host other than the fake Supabase fails the test.
 *
 * Each abuse is run first WITHOUT the control (the gate is stripped from the handler's own source, or the limiter is switched
 * off) and must succeed — a control that cannot fail proves nothing.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, readRepo, REPO_ROOT } from './_support/load-source.ts';

type Row = Record<string, any>;

/* ── the limiter, in memory, with the real numbers ─────────────────────────── */

const policyRows = (sql: string) => [...sql.matchAll(/\(\s*'([a-z_]+)',\s*(\d+),\s*(\d+),\s*'/g)].map((m) => [m[1], { window: Number(m[2]), max: Number(m[3]) }] as const);
const POLICIES = new Map(policyRows(readRepo('supabase/migrations/20260821280000_rate_limits.sql')).concat(policyRows(readRepo('supabase/migrations/20261118000000_payment_start_abuse_limits.sql'))));

class Limiter {
  mode: 'on' | 'off' | 'down' = 'on';
  offsetMs = 0;
  counts = new Map<string, number>();
  rpcCalls: string[] = [];
  private bucket(action: string) { const p = POLICIES.get(action)!; return Math.floor((Date.now() + this.offsetMs) / 1000 / p.window); }
  private key(subject: string, action: string) { return `${subject}|${action}|${this.bucket(action)}`; }
  count(subject: string, action: string) { return this.counts.get(this.key(subject, action)) ?? 0; }
  private retry(action: string) { const p = POLICIES.get(action)!; return Math.max(1, (this.bucket(action) + 1) * p.window - Math.floor((Date.now() + this.offsetMs) / 1000)); }
  claim(subject: string, actions: string[]) {
    const sorted = [...new Set(actions)].sort();
    if (this.mode === 'off') return [{ allowed: true, blocked_action: null, retry_after_secs: 0 }];
    for (const a of sorted) {
      if (!POLICIES.has(a)) return [{ allowed: false, blocked_action: a, retry_after_secs: 3600 }];
      if (this.count(subject, a) >= POLICIES.get(a)!.max) return [{ allowed: false, blocked_action: a, retry_after_secs: this.retry(a) }];
    }
    for (const a of sorted) this.counts.set(this.key(subject, a), this.count(subject, a) + 1);
    return [{ allowed: true, blocked_action: null, retry_after_secs: 0 }];
  }
  blocked(subject: string, actions: string[]) {
    if (this.mode === 'off') return [{ blocked: false, blocked_action: null, retry_after_secs: 0 }];
    for (const a of [...new Set(actions)].sort()) {
      if (!POLICIES.has(a)) return [{ blocked: true, blocked_action: a, retry_after_secs: 3600 }];
      if (this.count(subject, a) >= POLICIES.get(a)!.max) return [{ blocked: true, blocked_action: a, retry_after_secs: this.retry(a) }];
    }
    return [{ blocked: false, blocked_action: null, retry_after_secs: 0 }];
  }
}

/* ── a fake Stripe that counts what is created, and honours idempotency keys ── */

class FakeStripeAccount {
  created = { customers: 0, subscriptions: 0, paymentIntents: 0, setupIntents: 0, ephemeralKeys: 0, checkoutSessions: 0 };
  calls: string[] = [];
  paymentIntentArgs: Row[] = [];
  subscriptionArgs: Row[] = [];
  customerArgs: Row[] = [];
  private byKey = new Map<string, Row>();
  private n = 0;
  private once(key: string | undefined, make: () => Row) {
    if (key && this.byKey.has(key)) return this.byKey.get(key)!;
    const v = make(); if (key) this.byKey.set(key, v); return v;
  }
  get total() { return Object.values(this.created).reduce((a, b) => a + b, 0); }
  client() {
    const s = this;
    return class FakeStripe {
      static createFetchHttpClient() { return {}; }
      customers = {
        create: async (args: Row) => { s.calls.push('customers.create'); s.created.customers++; s.customerArgs.push(args); return { id: `cus_${++s.n}` }; },
        retrieve: async (id: string) => { s.calls.push('customers.retrieve'); return { id, invoice_settings: { default_payment_method: null } }; },
        update: async () => { s.calls.push('customers.update'); return {}; },
      };
      paymentMethods = { list: async () => { s.calls.push('paymentMethods.list'); return { data: [] }; } };
      ephemeralKeys = { create: async () => { s.calls.push('ephemeralKeys.create'); s.created.ephemeralKeys++; return { secret: 'ek_secret' }; } };
      paymentIntents = {
        create: async (args: Row, opts: Row = {}) => { s.calls.push('paymentIntents.create'); s.paymentIntentArgs.push({ ...args, __idem: opts.idempotencyKey });
          return s.once(opts.idempotencyKey, () => { s.created.paymentIntents++; return { id: `pi_${++s.n}`, status: 'requires_payment_method', client_secret: `pi_${s.n}_secret`, ...args }; }); },
        confirm: async () => { s.calls.push('paymentIntents.confirm'); return { status: 'requires_payment_method' }; },
      };
      subscriptions = {
        create: async (args: Row, opts: Row = {}) => { s.calls.push('subscriptions.create'); s.subscriptionArgs.push({ ...args, __idem: opts.idempotencyKey });
          return s.once(opts.idempotencyKey, () => { s.created.subscriptions++; s.created.paymentIntents++; const id = ++s.n;
            return { id: `sub_${id}`, status: 'incomplete', customer: args.customer, default_payment_method: null,
              latest_invoice: { payment_intent: { id: `pi_${id}`, status: 'requires_payment_method', client_secret: `pi_${id}_secret` } } }; }); },
        retrieve: async (id: string) => { s.calls.push('subscriptions.retrieve'); const found = [...s.byKey.values()].find((v) => v.id === id);
          if (!found) throw new Error('No such subscription'); return found; },
      };
    };
  }
}

/* ── fakes for the handlers' other collaborators ────────────────────────────── */

const SUPABASE = 'https://fake.supabase.co';
let limiter: Limiter;
let stripeAcct: FakeStripeAccount;
let tables: Record<string, Row>;
let attempts: Map<string, Row>;
let unexpectedHosts: string[];

const BOOST_PRICE = '500';
const ALICE = 'a1000000-0000-4000-8000-0000000000a1';
const BOB = 'b2000000-0000-4000-8000-0000000000b2';
const BIZ = 'c3000000-0000-4000-8000-0000000000c3';

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_fake' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    if (!url.startsWith(SUPABASE)) { unexpectedHosts.push(url); throw new Error(`a request left for ${url}`); }
    const body = init.body ? JSON.parse(init.body) : {};
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (limiter.mode === 'down') return { ok: false, status: 500, json: async () => ({}) };
    if (url.endsWith('/rpc/claim_rate_limits')) { limiter.rpcCalls.push('claim'); return ok(limiter.claim(body.p_subject, body.p_actions)); }
    if (url.endsWith('/rpc/rate_limit_blocked')) { limiter.rpcCalls.push('blocked'); return ok(limiter.blocked(body.p_subject, body.p_actions)); }
    throw new Error(`unscripted Supabase call ${url}`);
  };
}

function fakeSvc() {
  const chain = (table: string) => {
    const c: any = {}; let pendingUpdate: Row | null = null;
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'not', 'or']) c[m] = () => c;
    c.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
    c.single = async () => ({ data: tables[table] ?? null, error: tables[table] ? null : { message: 'nf' } });
    c.update = (v: Row) => { pendingUpdate = v; return c; };
    c.insert = async (v: Row) => { (tables as any).__inserts = [...((tables as any).__inserts ?? []), { table, v }]; return { error: null }; };
    c.then = (res: any, rej: any) => { if (pendingUpdate && tables[table]) Object.assign(tables[table], pendingUpdate); return Promise.resolve({ data: null, error: null }).then(res, rej); };
    return c;
  };
  return {
    from: chain,
    rpc: async (name: string, args: Row) => {
      if (name === 'claim_subscription_attempt') {
        const prior = attempts.get(args.p_request_id);
        if (!prior) { attempts.set(args.p_request_id, { fingerprint: args.p_fingerprint, sub: null }); return { data: [{ outcome: 'claimed', status: 'claimed', stripe_subscription_id: null }], error: null }; }
        if (prior.fingerprint !== args.p_fingerprint) return { data: [{ outcome: 'conflict' }], error: null };
        return { data: [{ outcome: prior.sub ? 'resume' : 'in_flight', status: 'in_flight', stripe_subscription_id: prior.sub }], error: null };
      }
      if (name === 'settle_subscription_attempt') { const a = attempts.get(args.p_request_id); if (a && args.p_sub_id) a.sub = args.p_sub_id; return { data: null, error: null }; }
      return { data: null, error: null };
    },
  };
}
/** createClient: the Authorization header names the caller, as the real gateway + getUser() would. */
const createClient = (_url: string, key: string, opts: Row = {}) => {
  if (key === 'anon-key') {
    const who = String(opts?.global?.headers?.Authorization ?? '').replace('Bearer user-', '');
    return { auth: { getUser: async () => ({ data: { user: who ? { id: who, email: `${who}@example.org` } : null }, error: null }) } };
  }
  return fakeSvc();
};

const rateLimitModule = () => loadModule('supabase/functions/_shared/rate-limit.ts', {});
const brakeModule = () => loadModule('supabase/functions/_shared/payment-failure-brake.ts', { './rate-limit.ts': rateLimitModule() });

/** Removes the payment gate from a handler's own source: the handler as it was before this fix. */
const withoutGate = (src: string) => src
  .replace(/\n\s*\/\/ Abuse ceiling[^\n]*\n\s*const limited = await enforcePaymentStart\([^\n]*\n\s*if \('denied' in limited\) return limited\.denied;\n/, '\n')
  .replace(/\n\s*if \(!preview\) \{\n\s*const limited = await enforcePaymentStart\([^\n]*\n[^\n]*\n\s*\}\n/, '\n');

let handler: (r: Request) => Promise<Response>;
function loadBoost(strip = false) {
  loadModule('supabase/functions/local-boost-checkout/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    'npm:stripe@17': stripeAcct.client(),
    '../_shared/admin-config.ts': { getConfig: async (_s: any, key: string) => (key.startsWith('boost.price.') ? BOOST_PRICE : null) },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
    '../_shared/rate-limit.ts': rateLimitModule(),
  }, strip ? withoutGate : undefined);
}
function loadSubscription(strip = false) {
  loadModule('supabase/functions/local-subscription-intent/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    'npm:stripe@17': stripeAcct.client(),
    '../_shared/admin-config.ts': { getConfig: async () => null },
    '../_shared/tier-price.ts': {
      subscriptionPricesFor: async () => ({ tierPrice: 'price_pro_server', meterPrice: null, configKey: 'k', annual: false }),
      missingPriceError: () => 'missing price', assertPriceMatches: async () => null,
    },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/saved-card-outcome.ts': { classifySavedCardConfirm: () => ({ kind: 'sca' }) },
    '../_shared/rate-limit.ts': rateLimitModule(),
  }, strip ? withoutGate : undefined);
}
const post = (fn: string, as: string, body: Row) => handler(new Request(`${SUPABASE}/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer user-${as}` }, body: JSON.stringify(body) }));
let seq = 0;
const rid = () => `req-${++seq}-abcdefgh`;
const boost = (as = ALICE, over: Row = {}) => post('local-boost-checkout', as, { business_id: BIZ, weeks: 2, client_request_id: rid(), use_saved_card: false, ...over });
const subscribe = (as = ALICE, over: Row = {}) => post('local-subscription-intent', as, { business_id: BIZ, tier: 'pro', period: 'monthly', client_request_id: rid(), use_saved_card: false, ...over });

beforeEach(() => {
  limiter = new Limiter(); stripeAcct = new FakeStripeAccount(); attempts = new Map(); unexpectedHosts = []; seq = 0;
  tables = {
    local_businesses: { id: BIZ, owner_id: ALICE, name: 'Voe Gift Shop', email: 'shop@example.org', stripe_customer_id: null, business_stripe_customer_id: null,
      has_business_payment_method: false, stripe_subscription_id: null, subscription_tier: 'free', subscription_until: null },
    profiles: { stripe_customer_id: null, has_payment_method: false },
  };
  installGlobals();
});

const statuses = async (n: number, send: () => Promise<Response>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
};
const count = (arr: number[], v: number) => arr.filter((x) => x === v).length;

/* ── 0. the policy numbers this all rests on ───────────────────────────────── */

describe('the budgets the controls rely on (read from the migrations)', () => {
  test('a payment start claims hourly, per-minute, daily and aggregate budgets', () => {
    const { PAYMENT_START_ACTIONS, PAYMENT_FAILURE_ACTIONS } = rateLimitModule();
    assert.deepEqual([...PAYMENT_START_ACTIONS].sort(), ['stripe_any', 'stripe_intent', 'stripe_intent_burst', 'stripe_intent_day']);
    assert.deepEqual([...PAYMENT_FAILURE_ACTIONS].sort(), ['payment_failed', 'payment_failed_day']);
    for (const a of [...PAYMENT_START_ACTIONS, ...PAYMENT_FAILURE_ACTIONS, 'pi_failed']) assert.ok(POLICIES.has(a), `no policy row for ${a} — an unclassified action is DENIED, so every payment would be refused`);
  });
  test('the ceilings are the designed ones', () => {
    assert.deepEqual(POLICIES.get('stripe_intent_burst'), { window: 60, max: 10 });
    assert.deepEqual(POLICIES.get('stripe_intent_day'), { window: 86400, max: 120 });
    assert.deepEqual(POLICIES.get('payment_failed'), { window: 3600, max: 10 });
    assert.deepEqual(POLICIES.get('pi_failed'), { window: 86400, max: 6 });
  });
});

/* ── 1–3, 9. local-boost-checkout (was unlimited) ──────────────────────────── */

describe('local-boost-checkout — a PaymentIntent per request, now limited', () => {
  test('1, 2, 3, 4, 5 — a legitimate purchase works, and amount, currency, customer and key are all server-decided', async () => {
    loadBoost();
    const res = await boost(ALICE, { amount: 1, amount_pence: 1, currency: 'usd', customer: 'cus_someone_elses', price: 'price_free', payment_intent: 'pi_x' });
    assert.equal(res.status, 200);
    assert.equal(stripeAcct.created.paymentIntents, 1);
    const pi = stripeAcct.paymentIntentArgs[0];
    assert.equal(pi.amount, 500, 'the amount is the configured boost price, not what the client sent');
    assert.equal(pi.currency, 'gbp');
    assert.notEqual(pi.customer, 'cus_someone_elses');
    assert.match(String(pi.customer), /^cus_\d+$/, 'the customer is the one OneShetland created / holds for this business');
    assert.match(pi.__idem, new RegExp(`^local-boost-form-${ALICE}-${BIZ}-2-req-1-`), 'the idempotency key is built by the server from authoritative ids');
  });

  test('CONTROL (the audit finding): with the gate removed, a loop of fresh request ids creates a PaymentIntent every time', async () => {
    loadBoost(true);
    const st = await statuses(30, () => boost());
    assert.equal(count(st, 200), 30);
    assert.equal(stripeAcct.created.paymentIntents, 30, 'thirty PaymentIntents from one account in a loop');
  });

  test('FIXED: the same loop is stopped — 10 get through, 20 are refused, and a refused request never reaches Stripe', async () => {
    loadBoost();
    const st = await statuses(30, () => boost());
    assert.equal(count(st, 200), 10);
    assert.equal(count(st, 429), 20);
    assert.equal(stripeAcct.created.paymentIntents, 10);
    const callsAtTenth = stripeAcct.calls.length;
    await boost();
    assert.equal(stripeAcct.calls.length, callsAtTenth, 'a rate-limited request called Stripe');
  });

  test('LOAD-BEARING: switch the limiter off and the very same test loop creates 30 again', async () => {
    limiter.mode = 'off';
    loadBoost();
    const st = await statuses(30, () => boost());
    assert.equal(count(st, 200), 30);
    assert.equal(stripeAcct.created.paymentIntents, 30);
  });

  test('9 — a direct API call gets exactly the protection the app gets (there is no other door), and the refusal is calm and says nothing about thresholds', async () => {
    loadBoost();
    await statuses(10, () => boost());
    const res = await boost();
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'Too many requests' });
    assert.ok(Number(res.headers.get('Retry-After')) >= 1);
  });

  test('6, 11 — a stale page re-sending the same checkout reference reaches ONE PaymentIntent, not five (the server-built idempotency key)', async () => {
    loadBoost();
    const same = rid();
    const st = await statuses(5, () => boost(ALICE, { client_request_id: same }));
    assert.equal(count(st, 200), 5);
    assert.equal(stripeAcct.created.paymentIntents, 1);
  });

  test('12 — the Stripe Customer is created once and reused, however many purchases are started', async () => {
    loadBoost();
    await statuses(8, () => boost());
    assert.equal(stripeAcct.created.customers, 1);
    assert.equal(tables.local_businesses.stripe_customer_id, 'cus_1', 'the customer is bound to the business and not client-supplied');
  });

  test('a PREVIEW makes no Stripe call and is not counted against the budget', async () => {
    loadBoost();
    for (let i = 0; i < 40; i++) assert.equal((await boost(ALICE, { preview: true })).status, 200);
    assert.equal(stripeAcct.total, 0);
    assert.equal(limiter.rpcCalls.length, 0);
  });

  test('10 — another account cannot spend this business’s checkout, and cannot use this account’s budget', async () => {
    loadBoost();
    const res = await boost(BOB);
    assert.equal(res.status, 403);
    assert.equal(stripeAcct.total, 0);
    assert.equal(limiter.count(`user:${ALICE}`, 'stripe_intent'), 0);
    assert.equal(limiter.count(`user:${BOB}`, 'stripe_intent'), 1, 'the attempt is charged to the account that made it');
  });

  test('accounts are independent: one account at its ceiling does not stop another from buying', async () => {
    loadBoost();
    await statuses(12, () => boost(ALICE));
    tables.local_businesses.owner_id = BOB;
    assert.equal((await boost(BOB)).status, 200);
  });
});

/* ── local-subscription-intent (was unlimited; the main finding) ───────────── */

describe('local-subscription-intent — a Subscription (and its PaymentIntent) per reference, now limited', () => {
  test('1, 2, 4, 5 — a legitimate start works; the price is the server’s, and no client customer, price or amount is read', async () => {
    loadSubscription();
    const res = await subscribe(ALICE, { price: 'price_FREE', price_id: 'price_FREE', amount: 1, customer: 'cus_evil', stripe_customer_id: 'cus_evil', items: [{ price: 'price_FREE' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.paymentIntent && body.ephemeralKey && body.subscriptionId);
    assert.equal(stripeAcct.created.subscriptions, 1);
    const sub = stripeAcct.subscriptionArgs[0];
    assert.deepEqual(sub.items, [{ price: 'price_pro_server' }]);
    assert.notEqual(sub.customer, 'cus_evil');
    assert.match(sub.__idem, new RegExp(`^local-sub-${ALICE}-${BIZ}-pro-monthly-req-1-`));
  });

  test('CONTROL (the audit finding): with the gate removed, fresh references create a Subscription + Invoice + PaymentIntent each time', async () => {
    loadSubscription(true);
    const st = await statuses(30, () => subscribe());
    assert.equal(count(st, 200), 30);
    assert.equal(stripeAcct.created.subscriptions, 30);
    assert.equal(stripeAcct.created.paymentIntents, 30, 'thirty live PaymentIntents, each a client secret a card can be tried against');
  });

  test('FIXED: 10 get through, the rest are refused before the registry or Stripe is touched', async () => {
    loadSubscription();
    const st = await statuses(30, () => subscribe());
    assert.equal(count(st, 200), 10);
    assert.equal(count(st, 429), 20);
    assert.equal(stripeAcct.created.subscriptions, 10);
    assert.equal(attempts.size, 10, 'a refused request left no attempt record behind');
  });

  test('LOAD-BEARING: switch the limiter off and the loop creates 30 again', async () => {
    limiter.mode = 'off';
    loadSubscription();
    await statuses(30, () => subscribe());
    assert.equal(stripeAcct.created.subscriptions, 30);
  });

  test('6, 11 — the same reference sent again (stale page, double tap, direct replay) resumes ONE subscription', async () => {
    loadSubscription();
    const same = rid();
    const st = await statuses(5, () => subscribe(ALICE, { client_request_id: same }));
    assert.ok(st.every((s) => s === 200 || s === 409), String(st));
    assert.equal(stripeAcct.created.subscriptions, 1);
  });

  test('12 — one Stripe Customer for the business across every attempt', async () => {
    loadSubscription();
    await statuses(10, () => subscribe());
    assert.equal(stripeAcct.created.customers, 1);
  });

  test('10 — a different account cannot start a subscription for this business', async () => {
    loadSubscription();
    assert.equal((await subscribe(BOB)).status, 403);
    assert.equal(stripeAcct.total, 0);
  });

  test('a malformed request is refused before it spends any allowance', async () => {
    loadSubscription();
    assert.equal((await subscribe(ALICE, { tier: 'enterprise' })).status, 400);
    assert.equal((await subscribe(ALICE, { client_request_id: 'x' })).status, 400);
    assert.equal(limiter.rpcCalls.length, 0);
  });
});

/* ── the failed-payment gate ───────────────────────────────────────────────── */

describe('an account that has just failed too many payments cannot start another', () => {
  const failed = (userId: string, n: number) => { for (let i = 0; i < n; i++) limiter.claim(`user:${userId}`, ['payment_failed', 'payment_failed_day']); };

  test('at the hourly failure ceiling, a new start is refused calmly, spends no allowance, and never reaches Stripe', async () => {
    failed(ALICE, 10);
    loadBoost();
    const res = await boost();
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.match(body.error, /payments have not gone through/);
    assert.doesNotMatch(JSON.stringify(body), /10|ceiling|limit|payment_failed/i, 'no threshold or internal name is leaked');
    assert.ok(Number(res.headers.get('Retry-After')) >= 1);
    assert.equal(stripeAcct.total, 0);
    assert.equal(limiter.count(`user:${ALICE}`, 'stripe_intent'), 0, 'the refusal cost no creation allowance');
  });

  test('below the failure ceiling, a customer who has had a few declines (normal) is not impeded', async () => {
    failed(ALICE, 9);
    loadBoost();
    assert.equal((await boost()).status, 200);
  });

  test('it is per account: another account is unaffected', async () => {
    failed(BOB, 10);
    loadBoost();
    assert.equal((await boost(ALICE)).status, 200);
  });

  test('the hourly window turning lets a normal customer back in', async () => {
    failed(ALICE, 10);
    loadBoost();
    assert.equal((await boost()).status, 429);
    limiter.offsetMs = 3600_000 + 1000;
    assert.equal((await boost()).status, 200);
  });

  test('same gate on the subscription route', async () => {
    failed(ALICE, 10);
    loadSubscription();
    assert.equal((await subscribe()).status, 429);
    assert.equal(stripeAcct.total, 0);
  });
});

/* ── fail closed ───────────────────────────────────────────────────────────── */

describe('if the limiter cannot be reached, no payment is started', () => {
  test('503, and Stripe is never called — on both formerly-unlimited routes', async () => {
    limiter.mode = 'down';
    loadBoost();
    assert.equal((await boost()).status, 503);
    loadSubscription();
    assert.equal((await subscribe()).status, 503);
    assert.equal(stripeAcct.total, 0);
  });
  test('missing service credentials also refuse', async () => {
    (globalThis as any).Deno = { env: { get: () => undefined } };
    const { enforcePaymentStart } = rateLimitModule();
    const r = await enforcePaymentStart('t', ALICE, {});
    assert.equal(r.denied.status, 503);
  });
});

/* ── the brake: what stripe-webhook does with a failed card ────────────────── */

describe('payment-failure-brake — a failed card is counted, and an intent that keeps failing is killed', () => {
  const PI = 'pi_3Lattacker';
  const make = (over: Row = {}) => {
    const cancelled: string[] = [];
    const deps = {
      userForCustomer: async (c: string) => (c === 'cus_alice' ? ALICE : null),
      claim: async (s: string, a: string[]) => limiter.claim(s, a)[0].allowed,
      cancel: async (kind: string, id: string) => { cancelled.push(`${kind}:${id}`); },
      ...over,
    };
    return { deps, cancelled };
  };

  test('attribution comes from what OUR checkout stamped on the payment, in each flow', () => {
    const { userFromMetadata } = brakeModule();
    for (const k of ['buyer_id', 'user_id', 'owner_id', 'customer_id']) assert.equal(userFromMetadata({ [k]: ALICE }), ALICE, k);
    assert.equal(userFromMetadata({ buyer_id: 'not-a-uuid', user_id: 'x' }), null, 'a non-uuid is ignored');
    assert.equal(userFromMetadata({}), null);
    assert.equal(userFromMetadata(null), null);
  });

  test('a failure is counted against the account, and against the intent', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps } = make();
    const r = await brakeAfterFailedPayment(deps, { id: PI, kind: 'payment_intent', metadata: { buyer_id: ALICE } });
    assert.deepEqual([r.userId, r.counted, r.cancelled], [ALICE, true, false]);
    assert.equal(limiter.count(`user:${ALICE}`, 'payment_failed'), 1);
    assert.equal(limiter.count(`pi:${PI}`, 'pi_failed'), 1);
  });

  test('a subscription invoice’s intent carries no metadata: the account is found through its Stripe Customer', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps } = make();
    const r = await brakeAfterFailedPayment(deps, { id: 'pi_inv', kind: 'payment_intent', customer: 'cus_alice', invoice: 'in_1', metadata: {} });
    assert.equal(r.userId, ALICE);
  });

  test('an unattributable failure is still counted against its intent (and never throws)', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps } = make();
    const r = await brakeAfterFailedPayment(deps, { id: PI, kind: 'payment_intent', customer: 'cus_unknown', metadata: {} });
    assert.deepEqual([r.userId, r.counted], [null, false]);
    assert.equal(limiter.count(`pi:${PI}`, 'pi_failed'), 1);
  });

  test('card testing against ONE intent: 6 failures are tolerated, the 7th cancels it — its client secret is dead', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps, cancelled } = make();
    for (let i = 1; i <= 6; i++) { const r = await brakeAfterFailedPayment(deps, { id: PI, kind: 'payment_intent', metadata: { buyer_id: ALICE } }); assert.equal(r.cancelled, false, `failure ${i}`); }
    assert.deepEqual(cancelled, []);
    const r = await brakeAfterFailedPayment(deps, { id: PI, kind: 'payment_intent', metadata: { buyer_id: ALICE } });
    assert.equal(r.cancelled, true);
    assert.deepEqual(cancelled, [`payment_intent:${PI}`]);
  });

  test('an intent that belongs to an invoice is never cancelled (Stripe manages it), but its failures still count against the account', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps, cancelled } = make();
    for (let i = 0; i < 9; i++) await brakeAfterFailedPayment(deps, { id: 'pi_inv', kind: 'payment_intent', invoice: 'in_1', metadata: { owner_id: ALICE } });
    assert.deepEqual(cancelled, []);
    assert.equal(limiter.count(`user:${ALICE}`, 'payment_failed'), 9);
  });

  test('a failed card SETUP is the same attack through another door: same brake, cancelled as a setup intent', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps, cancelled } = make();
    for (let i = 0; i < 7; i++) await brakeAfterFailedPayment(deps, { id: 'seti_1', kind: 'setup_intent', customer: 'cus_alice', metadata: {} });
    assert.deepEqual(cancelled, ['setup_intent:seti_1']);
  });

  test('THE WHOLE LOOP — create one intent, try cards against it: the account is cut off from starting more, without ever calling Stripe again', async () => {
    const { brakeAfterFailedPayment } = brakeModule(); const { deps, cancelled } = make();
    loadBoost();
    assert.equal((await boost()).status, 200);                       // one legitimate-looking start
    const created = stripeAcct.total;
    for (let card = 1; card <= 12; card++) await brakeAfterFailedPayment(deps, { id: 'pi_1', kind: 'payment_intent', metadata: { owner_id: ALICE } });  // twelve declines of one intent, via the webhook
    const retry = await boost();
    assert.equal(retry.status, 429, 'a new start is refused once the account has failed ten payments');
    assert.equal(stripeAcct.total, created, 'and Stripe was not called for it');
    assert.ok(cancelled.length >= 1, 'the intent that kept failing was cancelled, so its client secret cannot be tried again');
  });

  test('production wiring: counts through claim_rate_limits, finds owners by customer, and cancels with the right request', async () => {
    const { productionBrakeDeps } = brakeModule();
    const fetched: { url: string; init: Row }[] = [];
    (globalThis as any).fetch = async (url: string, init: Row) => { fetched.push({ url, init }); return { ok: false, status: 402 }; };   // a refusal must be tolerated
    const rpc: Row[] = [];
    const supabase = {
      rpc: async (n: string, a: Row) => { rpc.push({ n, a }); return { data: [{ allowed: false }], error: null }; },
      from: (t: string) => { const c: any = {}; for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c;
        c.maybeSingle = async () => ({ data: t === 'profiles' ? null : { owner_id: BOB } }); return c; },
    };
    const deps = productionBrakeDeps(supabase, 'sk_test_fake');
    assert.equal(await deps.userForCustomer('cus_x'), BOB, 'falls back from profiles to a business owner');
    assert.equal(await deps.claim('user:x', ['payment_failed']), false);
    assert.deepEqual(rpc[0], { n: 'claim_rate_limits', a: { p_subject: 'user:x', p_actions: ['payment_failed'] } });
    await deps.cancel('payment_intent', 'pi_abc');
    assert.equal(fetched[0].url, 'https://api.stripe.com/v1/payment_intents/pi_abc/cancel');
    assert.equal(fetched[0].init.method, 'POST');
    assert.equal(fetched[0].init.headers['Idempotency-Key'], 'payment-brake-cancel-pi_abc');
    await deps.cancel('setup_intent', 'seti_abc');
    assert.equal(fetched[1].url, 'https://api.stripe.com/v1/setup_intents/seti_abc/cancel');
  });

  test('a limiter error inside the brake throws to its caller (stripe-webhook fences it); it never changes money state', () => {
    const w = readRepo('supabase/functions/stripe-webhook/index.ts');
    const a = w.indexOf("case 'payment_intent.payment_failed'");
    const block = w.slice(a, w.indexOf("case 'setup_intent.setup_failed'"));
    assert.match(block, /try \{\s*await brakeAfterFailedPayment\(/);
    assert.match(block, /\} catch \(e\) \{ console\.error\('\[stripe-webhook\] failed-payment brake:'/);
    assert.ok(block.indexOf('brakeAfterFailedPayment') < block.indexOf('const requestId = meta.request_id'), 'the brake runs before, and independently of, the Fetch handling');
    assert.match(w.slice(w.indexOf("case 'setup_intent.setup_failed'"), w.indexOf("case 'account.updated'")), /brakeAfterFailedPayment[\s\S]*catch \(e\)[\s\S]*break;/);
    const brake = readRepo('supabase/functions/_shared/payment-failure-brake.ts');
    assert.doesNotMatch(brake, /event_ticket_orders|hub_members|product_orders|status:\s*'paid'|refund/i, 'the brake touches no order, ticket, membership or refund');
  });
});

/* ── every route that creates something a card is tried against ───────────── */

describe('no payment-starting route can be added without the gate', () => {
  const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
  const dirs = readdirSync(FUNCS).filter((d) => !d.startsWith('_') && existsSync(join(FUNCS, d, 'index.ts')));
  const CREATES = /paymentIntents\.create|subscriptions\.create|setupIntents\.create|checkout\.sessions\.create|createPaymentIntent\(|payment_intents['`]\s*,\s*\{\s*method|\/payment_intents`?\s*,\s*\{\s*method:\s*'POST'|\/setup_intents`?,\s*\{\s*method:\s*'POST'/;
  const STRIPE_TOUCH = /new Stripe\(|api\.stripe\.com|createPaymentIntent\(|stripeHeaders\(|STRIPE_SECRET_KEY|stripe\.(?:subscriptions|paymentIntents|customers|setupIntents|checkout|ephemeralKeys)/;

  /** Routes that create a Stripe payment object but are NOT started by an arbitrary account, each with the reason. */
  const EXEMPT: Record<string, string> = {
    'fetch-authorise': 'own, tighter limiter (fetch_authorise / fetch_authorise_day); acts on a delivery the caller is party to, on the customer’s saved card',
    'authorise-payment': 'driver-only: acts on an assigned delivery request, off the customer’s saved card; amount from the priced request',
    'wallet-checkout': 'wallet-funded: no card is involved, the wallet balance is the funding source',
    'stripe-webhook': 'inbound, signature-verified; creates nothing a user can start',
    'create-connect-account': 'creates a Connect account, not a payment: own stripe_account limiter',
    'hub-onboard': 'creates a Connect account, not a payment: own stripe_account limiter',
    'local-business-onboard': 'creates a Connect account, not a payment: own stripe_account limiter',
  };

  test('every route that creates a PaymentIntent / SetupIntent / Subscription / Checkout Session runs enforcePaymentStart (or is exempt for a stated reason)', () => {
    const missing: string[] = [];
    for (const d of dirs) {
      const code = readFileSync(join(FUNCS, d, 'index.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!CREATES.test(code)) continue;
      if (EXEMPT[d]) continue;
      if (!/enforcePaymentStart\(/.test(code)) missing.push(d);
    }
    assert.deepEqual(missing, [], `payment-creating routes without the gate: ${missing.join(', ')}`);
  });

  test('the gate runs BEFORE the route touches Stripe or records an attempt (inside the request handler)', () => {
    const late: string[] = [];
    for (const d of dirs) {
      const whole = readFileSync(join(FUNCS, d, 'index.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const h = whole.indexOf('serve(');
      const code = h === -1 ? whole : whole.slice(h);          // helper definitions above serve() only describe how to call Stripe; they call nothing
      const gate = code.indexOf('enforcePaymentStart(');
      if (gate === -1) continue;
      const before = [STRIPE_TOUCH, /\.rpc\('claim_\w*attempt'/, /\.rpc\('reserve_ticket_basket'/, /\.from\('local_boost_purchases'\)\.insert/]
        .some((re) => { const m = code.search(re); return m !== -1 && m < gate; });
      if (before) late.push(d);
    }
    assert.deepEqual(late, [], `routes that touch Stripe or record an attempt BEFORE the gate: ${late.join(', ')}`);
  });

  test('the routes that were unlimited are now covered, by name', () => {
    for (const d of ['local-subscription-intent', 'local-boost-checkout', 'local-subscription-checkout']) {
      assert.match(readFileSync(join(FUNCS, d, 'index.ts'), 'utf8'), /enforcePaymentStart\(/, d);
    }
    assert.match(readFileSync(join(FUNCS, 'local-subscription-change', 'index.ts'), 'utf8'), /\['stripe_any'\]/);
  });

  test('the nine routes that already had the limiter now use the shared gate, so the failure gate covers them too', () => {
    for (const d of ['create-event-ticket-intent', 'create-hub-membership-intent', 'create-hub-donation-intent', 'create-gift-intent', 'create-unit-purchase-intent',
      'create-product-order-intent', 'create-boost-intent', 'create-setup-intent', 'local-wallet-topup-intent']) {
      const code = readFileSync(join(FUNCS, d, 'index.ts'), 'utf8');
      assert.match(code, new RegExp(`enforcePaymentStart\\('${d}', user\\.id, corsHeaders\\)`), d);
      assert.doesNotMatch(code, /enforceRateLimit\(/, `${d} still names its own budgets`);
    }
  });
});

/* ── amounts and prices: the client supplies none of them ──────────────────── */

describe('amount, currency and price integrity of the payment-starting routes', () => {
  const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
  const code = (d: string) => readFileSync(join(FUNCS, d, 'index.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test('currency is the literal gbp in every route that sets it', () => {
    for (const d of ['create-event-ticket-intent', 'create-hub-membership-intent', 'create-hub-donation-intent', 'create-gift-intent', 'create-unit-purchase-intent',
      'create-product-order-intent', 'create-boost-intent', 'local-wallet-topup-intent', 'local-boost-checkout']) {
      assert.match(code(d), /currency:\s*'gbp'/, d);
      assert.doesNotMatch(code(d), /currency\s*[:=]\s*(?:body|req)\./, d);
    }
  });
  test('no route reads a Stripe price id, customer id or amount from the request body, except the two intentionally user-entered amounts (bounded)', () => {
    for (const d of ['create-event-ticket-intent', 'create-hub-membership-intent', 'create-gift-intent', 'create-unit-purchase-intent', 'create-product-order-intent',
      'create-boost-intent', 'local-boost-checkout', 'local-subscription-intent', 'local-subscription-checkout', 'local-subscription-change', 'create-setup-intent']) {
      const c = code(d);
      assert.doesNotMatch(c, /\b(?:body|payload)\??\.(?:price_id|price|amount|amount_pence|stripe_customer_id|customer_id|customer|currency)\b/, `${d} reads a money field from the client`);
      assert.doesNotMatch(c, /const \{[^}]*\b(?:price_id|stripe_price|stripe_customer_id|customer_id|currency)\b[^}]*\} = (?:await req\.json\(\)|body)/, `${d} destructures a money field from the client`);
    }
  });
  test('the two intentionally user-entered amounts are validated against hard bounds before Stripe', () => {
    assert.match(code('create-hub-donation-intent'), /amount < MIN_PENCE \|\| amount > MAX_PENCE/);
    assert.match(code('local-wallet-topup-intent'), /Number\.isInteger\(amount_pence\)/);
  });
  test('Stripe Customer ids are read from OUR rows (profiles / local_businesses), never from the request', () => {
    for (const d of ['create-hub-membership-intent', 'create-hub-donation-intent', 'create-gift-intent', 'create-unit-purchase-intent', 'local-wallet-topup-intent']) {
      assert.match(code(d), /from\('profiles'\)[\s\S]{0,80}stripe_customer_id/, d);
    }
  });
});

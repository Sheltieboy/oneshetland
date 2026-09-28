/**
 * event-ticket-saved-card.node.test.ts
 *
 * THE DEFECT (24 Sep 2026, first real paid-ticket acceptance purchase)
 *
 * The buyer's profile said has_payment_method = true but had NO Stripe Customer
 * bound (stripe_customer_id NULL, no claim-registry row). create-event-ticket-
 * intent only tried a saved card when profile.stripe_customer_id existed, so it
 * skipped the branch and SILENTLY made a bare PaymentIntent with no customer;
 * the web drawer (a bare Payment Element) then showed no saved card. 4 of the 6
 * profiles carrying the flag were in that state.
 *
 * WHAT THIS FILE PINS
 *
 *   - the flag never counts as a saved card; the canonical resolver decides
 *   - the card is chosen by the canonical rule (default if attached, else newest),
 *     described with brand + last4 only
 *   - a saved card the buyer chose but the server cannot honour is an EXPLICIT
 *     answer (saved_card_unavailable / saved_card_declined), never a silent switch
 *     to a different payment path, and never a second PaymentIntent
 *   - the new-card PaymentIntent carries the canonical Customer when one exists
 *   - it is still a platform-account destination charge (no Stripe-Account header,
 *     same transfer destination and application fee), and no Customer is created
 *   - the web modal makes the buyer press Pay for a saved card; mobile keeps its
 *     confirm sheet
 *   - a live-data invariant reports profiles whose flag has no Customer behind it
 *
 * Server tests EXECUTE the real Edge Function and shared-helper source under node
 * against a fake Stripe and a fake database (see _support/load-source.ts). Web and
 * mobile are pinned by source shape, plus the pure label helper, executed.
 *
 * SAFETY: no network to Stripe, no payment, no write to any real database. The
 * live-data tests run one read-only SELECT through the Supabase CLI and skip when
 * it is unavailable.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import * as SavedCard from '../functions/_shared/saved-card.ts';
import * as SavedCardState from '../functions/_shared/saved-card-state.ts';
import * as Sca from '../functions/_shared/stripe-sca.ts';
import * as SafeError from '../functions/_shared/safe-error.ts';
import * as TicketQuantities from '../functions/_shared/ticket-quantities.ts';
import { formatCardLabel as webLabel } from '../../../oneshetland-web/lib/card-label.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

/* ── fakes ─────────────────────────────────────────────────────────────── */

const USER = 'u-1111';
const CUS = 'cus_TEST1';
const EVENT = 'e-2222';
const TT = 'tt-3333';
const ORDER = 'ord-4444';
const DEST = 'acct_DEST99';

(globalThis as any).Deno = {
  env: {
    get: (k: string) => ({
      STRIPE_SECRET_KEY: 'sk_test_FAKE', SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'ANON', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE',
    } as Record<string, string>)[k],
  },
};

type StripeCfg = {
  attached?: { id: string; card?: Record<string, unknown> }[] | 'error';
  defaultPm?: string | null;
  intent?: Record<string, unknown>;
  existingIntent?: Record<string, unknown>;
};

/** A Stripe that records every request and answers only what we script. */
function fakeStripe(cfg: StripeCfg = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const impl = async (url: string, init: any = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = new URLSearchParams(init.body ? String(init.body) : '');
    calls.push({ method, url: String(url), headers, body });
    const respond = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
    const path = new URL(String(url)).pathname;
    if (method === 'GET' && /\/customers\/[^/]+\/payment_methods$/.test(path)) {
      if (cfg.attached === 'error') return respond(500, { error: { message: 'boom' } });
      return respond(200, { data: cfg.attached ?? [] });
    }
    if (method === 'GET' && /\/customers\/[^/]+$/.test(path)) {
      return respond(200, { invoice_settings: { default_payment_method: cfg.defaultPm ?? null } });
    }
    if (method === 'POST' && path.endsWith('/payment_intents')) {
      return respond(200, cfg.intent ?? { id: 'pi_test_1', status: 'requires_payment_method', client_secret: 'pi_test_1_secret_abc' });
    }
    if (method === 'GET' && /\/payment_intents\/[^/]+$/.test(path)) return respond(200, cfg.existingIntent ?? {});
    if (method === 'POST' && /\/customers$/.test(path)) return respond(200, { id: 'cus_CREATED' });
    return respond(404, { error: { message: `unexpected ${method} ${path}` } });
  };
  return {
    impl, calls,
    intentPosts: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/payment_intents')),
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}

async function withFetch<T>(stripe: ReturnType<typeof fakeStripe>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = stripe.impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

type Tables = Record<string, { single?: unknown; maybe?: unknown; list?: unknown[] }>;
/** A minimal supabase-js stand-in: reads answer from `tables`, writes are recorded. */
function fakeDb(tables: Tables, rpc: Record<string, (a: any) => { data: unknown; error?: unknown }> = {}) {
  const log = { updates: [] as { table: string; payload: any }[], rpcs: [] as { name: string; args: any }[] };
  const from = (table: string) => {
    let mode: 'select' | 'update' = 'select';
    let payload: any;
    const exec = () => {
      if (mode === 'update') { log.updates.push({ table, payload }); return { data: [{ id: 'x' }], error: null }; }
      return { data: tables[table]?.list ?? [], error: null };
    };
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      update: (p: any) => { mode = 'update'; payload = p; return q; },
      single: async () => ({ data: tables[table]?.single ?? null, error: null }),
      maybeSingle: async () => ({ data: tables[table]?.maybe ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  const rpcFn = async (name: string, args: any) => { log.rpcs.push({ name, args }); return rpc[name]?.(args) ?? { data: null, error: null }; };
  return { from, rpc: rpcFn, log };
}

/** Loads a Deno Edge Function's real source and returns its request handler. */
function loadHandler(rel: string, stubs: Record<string, unknown>) {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  loadModule(rel, {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: typeof handler) => { handler = h; } },
    ...stubs,
  });
  assert.ok(handler, `${rel} never called serve()`);
  return handler!;
}

const asUser = (db: ReturnType<typeof fakeDb>) => (_url: string, key: string) =>
  key === 'ANON' ? { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } } : db;
const noUser = () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } });

const post = (body: unknown, auth = true) => new Request('https://fn.test/x', {
  method: 'POST',
  headers: { ...(auth ? { Authorization: 'Bearer t' } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const VISA = { id: 'pm_VISA', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031, fingerprint: 'FP-SECRET', number: '4242424242424242' } };
const MC   = { id: 'pm_MC',   card: { brand: 'mastercard', last4: '4444' } };
const AMEX = { id: 'pm_AMEX', card: { brand: 'amex', last4: '0005' } };

/* ── 1. the resolver: the flag is not evidence ─────────────────────────── */

describe('canonical saved-card resolution', () => {
  test('1. flag true + no customer does NOT count as a saved card, and Stripe is not even asked', async () => {
    const stripe = fakeStripe({ attached: [VISA] });
    const db = fakeDb({ profiles: { maybe: { stripe_customer_id: null, has_payment_method: true } } });
    const r = await withFetch(stripe, () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.deepEqual(r, { kind: 'none', reason: 'no_customer', customerId: null });
    assert.equal(stripe.calls.length, 0, 'nothing to look up without a bound customer');
    assert.equal(db.log.updates.length, 0, 'and nothing is written');
  });

  test('1b. a customer with no attached card is `none/no_card`; an unreadable Stripe is `unknown`, not none', async () => {
    const db = fakeDb({ profiles: { maybe: { stripe_customer_id: CUS } } });
    const none = await withFetch(fakeStripe({ attached: [] }), () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.deepEqual(none, { kind: 'none', reason: 'no_card', customerId: CUS });
    const unknown = await withFetch(fakeStripe({ attached: 'error' }), () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.deepEqual(unknown, { kind: 'unknown', customerId: CUS });
  });

  test('1c. the durable claim registry is honoured read-only; an in-flight claim is not a binding', async () => {
    const stripe = fakeStripe({ attached: [VISA] });
    const bound = fakeDb({ profiles: { maybe: { stripe_customer_id: null } }, stripe_customer_claims: { maybe: { stripe_customer_id: 'cus_CLAIM', status: 'bound' } } });
    const r: any = await withFetch(stripe, () => SavedCardState.resolveSavedCard({ supabase: bound, stripeKey: 'k', userId: USER }));
    assert.equal(r.kind, 'card');
    assert.equal(r.customerId, 'cus_CLAIM');
    assert.equal(bound.log.updates.length, 0);
    const inflight = fakeDb({ profiles: { maybe: { stripe_customer_id: null } }, stripe_customer_claims: { maybe: { stripe_customer_id: 'cus_X', status: 'in_flight' } } });
    const r2 = await withFetch(fakeStripe({ attached: [VISA] }), () => SavedCardState.resolveSavedCard({ supabase: inflight, stripeKey: 'k', userId: USER }));
    assert.equal(r2.kind, 'none');
  });

  test('2. the customer’s DEFAULT card is chosen, not whichever Stripe listed first', async () => {
    const db = fakeDb({ profiles: { maybe: { stripe_customer_id: CUS } } });
    const first = await withFetch(fakeStripe({ attached: [AMEX, MC, VISA], defaultPm: 'pm_MC' }),
      () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.equal((first as any).paymentMethodId, 'pm_MC', 'the stored default wins over list order');
    // A default that is no longer attached is stale: fall back to the newest attached card.
    const stale = await withFetch(fakeStripe({ attached: [AMEX, MC], defaultPm: 'pm_DETACHED' }),
      () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.equal((stale as any).paymentMethodId, 'pm_AMEX');
    // The charge helper the other flows use follows exactly the same rule.
    assert.equal(await withFetch(fakeStripe({ attached: [AMEX, MC, VISA], defaultPm: 'pm_MC' }), () => SavedCard.chargeableCardFor('k', CUS)), 'pm_MC');
    assert.equal(await withFetch(fakeStripe({ attached: [] }), () => SavedCard.chargeableCardFor('k', CUS)), null);
    assert.deepEqual(SavedCard.pickDefaultCard([{ id: 'a' }, { id: 'b' }], 'b'), { id: 'b' });
    assert.deepEqual(SavedCard.pickDefaultCard([{ id: 'a' }, { id: 'b' }], 'zz'), { id: 'a' });
    assert.equal(SavedCard.pickDefaultCard([], 'a'), null);
  });

  test('2b. an outage is an error for a charge, never "no saved card on file"', async () => {
    await assert.rejects(withFetch(fakeStripe({ attached: 'error' }), () => SavedCard.chargeableCardFor('k', CUS)));
  });

  test('3. only brand and last4 are ever returned — nothing else about the card survives', async () => {
    const db = fakeDb({ profiles: { maybe: { stripe_customer_id: CUS } } });
    const r: any = await withFetch(fakeStripe({ attached: [VISA], defaultPm: 'pm_VISA' }),
      () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.equal(r.brand, 'visa');
    assert.equal(r.last4, '4242');
    const flat = JSON.stringify(r);
    for (const leak of ['FP-SECRET', '4242424242424242', 'exp_month', 'fingerprint', 'number']) assert.ok(!flat.includes(leak), `leaked ${leak}`);
    // Malformed metadata is dropped, not passed through.
    const odd: any = await withFetch(fakeStripe({ attached: [{ id: 'pm_ODD', card: { brand: 'VISA<script>', last4: '42424' } }] }),
      () => SavedCardState.resolveSavedCard({ supabase: db, stripeKey: 'k', userId: USER }));
    assert.equal(odd.brand, null);
    assert.equal(odd.last4, null);
  });
});

/* ── 2. the read-only state endpoint ───────────────────────────────────── */

describe('saved-card-state function', () => {
  function handlerFor(db: ReturnType<typeof fakeDb>, user = true) {
    return loadHandler('supabase/functions/saved-card-state/index.ts', {
      'https://esm.sh/@supabase/supabase-js@2': { createClient: user ? asUser(db) : noUser },
      '../_shared/safe-error.ts': SafeError,
      '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({ ok: true }), userSubject: (u: string) => `user:${u}` },
      '../_shared/saved-card-state.ts': SavedCardState,
    });
  }

  test('3b. answers with exactly {state, brand, last4} — no customer id, payment-method id or card extras', async () => {
    const db = fakeDb({ profiles: { maybe: { stripe_customer_id: CUS } } });
    const stripe = fakeStripe({ attached: [VISA], defaultPm: 'pm_VISA' });
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = ((...a: unknown[]) => logs.push(a.map(String).join(' '))) as never;
    let body: any; let text = '';
    try {
      const res = await withFetch(stripe, () => handlerFor(db)(post({})));
      text = await res.text(); body = JSON.parse(text);
    } finally { Object.assign(console, orig); }
    assert.deepEqual(body, { state: 'card', brand: 'visa', last4: '4242' });
    for (const leak of ['pm_VISA', CUS, 'FP-SECRET', '4242424242424242']) {
      assert.ok(!text.includes(leak) && !logs.join('\n').includes(leak), `leaked ${leak}`);
    }
    assert.equal(stripe.writes().length, 0, 'read-only: no Stripe write');
    assert.equal(db.log.updates.length, 0, 'read-only: no database write');
  });

  test('3c. none / unknown are reported honestly, and an unauthenticated caller is refused', async () => {
    const none: any = await (await withFetch(fakeStripe({}), () => handlerFor(fakeDb({ profiles: { maybe: { stripe_customer_id: null, has_payment_method: true } } }))(post({})))).json();
    assert.deepEqual(none, { state: 'none', reason: 'no_customer' });
    const unknown: any = await (await withFetch(fakeStripe({ attached: 'error' }), () => handlerFor(fakeDb({ profiles: { maybe: { stripe_customer_id: CUS } } }))(post({})))).json();
    assert.deepEqual(unknown, { state: 'unknown' });
    const denied = await handlerFor(fakeDb({}))(post({}, false));
    assert.equal(denied.status, 401);
    const noSession = await handlerFor(fakeDb({}), false)(post({}));
    assert.equal(noSession.status, 401);
  });
});

/* ── 3. the paid-ticket Edge Function ──────────────────────────────────── */

type Scenario = {
  stripe?: StripeCfg;
  customerId?: string | null;
  flag?: boolean;
  body?: Record<string, unknown>;
  basket?: Record<string, unknown>;
};

async function runTicket(sc: Scenario = {}) {
  const stripe = fakeStripe(sc.stripe);
  const db = fakeDb(
    {
      events: { single: { id: EVENT, title: 'ZZ TEST — Payout Gate Test', starts_at: '2026-10-01T10:00:00Z', venue: 'V', formatted_address: 'A', status: 'published', organiser_business_id: 'b1', organiser_hub_id: null } },
      event_ticket_types: { list: [{ id: TT, event_id: EVENT, name: 'Adult', price_pence: 100, per_order_max: 10, is_active: true, sale_starts_at: null, sale_ends_at: null }] },
      profiles: { maybe: { stripe_customer_id: sc.customerId === undefined ? CUS : sc.customerId, has_payment_method: sc.flag ?? true } },
    },
    {
      event_payout_destination: () => ({ data: [{ account_id: DEST, is_demo: false }] }),
      reserve_ticket_basket: () => ({ data: { order_id: ORDER, ticket_ids: ['tk1'], status: 'pending', already: false, stripe_payment_intent_id: null, ...(sc.basket ?? {}) } }),
    },
  );
  const handler = loadHandler('supabase/functions/create-event-ticket-intent/index.ts', {
    'https://esm.sh/@supabase/supabase-js@2': { createClient: asUser(db) },
    '../_shared/ticket-receipt.ts': { sendTicketReceipt: async () => {} },
    '../_shared/ticket-quantities.ts': TicketQuantities,
    '../_shared/wallet-ledger.ts': { debitAndTransfer: async () => ({ ok: false, reason: 'x', status: 500, error: 'x' }) },
    '../_shared/safe-error.ts': SafeError,
    '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({ ok: true }), userSubject: (u: string) => `user:${u}` },
    '../_shared/stripe-sca.ts': Sca,
    // stripe-errors.ts declares a class with a constructor parameter property, which node's
    // strip-only TypeScript cannot load. Nothing here exercises Stripe error mapping.
    '../_shared/stripe-errors.ts': {
      stripeError: (status: number, json: any) => Object.assign(new Error(json?.error?.message ?? 'stripe error'), { status }),
      checkoutFailure: () => null,
    },
    '../_shared/saved-card-state.ts': SavedCardState,
  });
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = ((...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))) as never;
  try {
    const res = await withFetch(stripe, () => handler(post({
      event_id: EVENT,
      line_items: [{ ticket_type_id: TT, quantity: 1 }],
      client_request_id: 'attempt-00000001',
      ...(sc.body ?? {}),
    })));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as any, text, stripe, db, logs };
  } finally { Object.assign(console, orig); }
}

const noStripeAccountHeader = (s: ReturnType<typeof fakeStripe>) =>
  assert.ok(s.calls.every((c) => !('stripe-account' in c.headers)), 'a Stripe-Account header would make this a direct charge');

describe('create-event-ticket-intent — saved card', () => {
  test('4/7. the buyer chose the saved card but the server cannot find one → explicit saved_card_unavailable, and NO PaymentIntent of any kind', async () => {
    for (const [label, sc, reason] of [
      ['flag true, no customer (the production defect)', { customerId: null, flag: true }, 'no_customer'],
      ['customer but no card attached', { stripe: { attached: [] } }, 'no_card'],
      ['stripe cannot be asked', { stripe: { attached: 'error' as const } }, 'unreadable'],
    ] as [string, Scenario, string][]) {
      const r = await runTicket({ ...sc, body: { use_saved_card: true } });
      assert.equal(r.status, 409, label);
      assert.equal(r.body.code, 'saved_card_unavailable', label);
      assert.equal(r.body.reason, reason, label);
      assert.equal(r.body.order_id, ORDER, 'the order stays pending so choosing another way resumes it');
      assert.equal(r.stripe.intentPosts().length, 0, `${label}: no silent fallback to a bare PaymentIntent`);
      assert.equal(r.stripe.writes().length, 0, `${label}: nothing written to Stripe`);
      assert.ok(!r.db.log.rpcs.some((x) => x.name === 'release_ticket_order'), 'the reservation is kept, not torn down');
    }
  });

  test('5/9/10/11. a chosen saved card is charged on-session with the canonical default — still a platform destination charge', async () => {
    const r = await runTicket({
      stripe: { attached: [AMEX, MC, VISA], defaultPm: 'pm_MC', intent: { id: 'pi_ok', status: 'succeeded' } },
      body: { use_saved_card: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.charged, true);
    const [pi] = r.stripe.intentPosts();
    assert.equal(pi.body.get('customer'), CUS);
    assert.equal(pi.body.get('payment_method'), 'pm_MC', 'the default card, not the first one listed');
    assert.equal(pi.body.get('confirm'), 'true');
    assert.equal(pi.body.get('off_session'), null, 'the buyer is present');
    assert.equal(pi.body.get('transfer_data[destination]'), DEST);
    assert.equal(pi.body.get('application_fee_amount'), '96');
    assert.equal(pi.body.get('amount'), '196');
    assert.equal(pi.body.get('on_behalf_of'), null);
    noStripeAccountHeader(r.stripe);
    assert.ok(r.db.log.updates.some((u) => u.table === 'event_ticket_orders' && u.payload.status === 'paid'));
  });

  test('7b. a saved card that is declined is an explicit answer — ONE PaymentIntent, recorded, no second one', async () => {
    const r = await runTicket({
      stripe: { attached: [VISA], defaultPm: 'pm_VISA', intent: { id: 'pi_dead', status: 'requires_payment_method', client_secret: 'pi_dead_secret_x' } },
      body: { use_saved_card: true },
    });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'saved_card_declined');
    assert.match(r.body.error, /declined/i);
    assert.equal(r.stripe.intentPosts().length, 1, 'no second PaymentIntent for a card form nobody chose');
    assert.ok(r.db.log.updates.some((u) => u.table === 'event_ticket_orders' && u.payload.stripe_payment_intent_id === 'pi_dead'),
      'the declined intent is recorded so choosing another card reuses it');
    assert.ok(!('clientSecret' in r.body));
  });

  test('13. a saved-card payment that needs 3DS is continued on the SAME intent — never a second one', async () => {
    const r = await runTicket({
      stripe: { attached: [VISA], defaultPm: 'pm_VISA', intent: { id: 'pi_sca', status: 'requires_action', client_secret: 'pi_sca_secret_x' } },
      body: { use_saved_card: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'requires_action');
    assert.equal(r.body.payment_intent_id, 'pi_sca');
    assert.equal(r.stripe.intentPosts().length, 1);
  });

  test('13b. choosing the saved card AGAIN after it was declined is refused, not turned into a card form', async () => {
    const r = await runTicket({
      basket: { already: true, stripe_payment_intent_id: 'pi_prev' },
      stripe: { attached: [VISA], existingIntent: { id: 'pi_prev', status: 'requires_payment_method', last_payment_error: { code: 'card_declined' }, client_secret: 'pi_prev_secret_x' } },
      body: { use_saved_card: true },
    });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'saved_card_declined');
    assert.equal(r.stripe.intentPosts().length, 0);
    // …while choosing a different card resumes that same intent, exactly as a replay always did.
    const other = await runTicket({
      basket: { already: true, stripe_payment_intent_id: 'pi_prev' },
      stripe: { existingIntent: { id: 'pi_prev', status: 'requires_payment_method', last_payment_error: { code: 'card_declined' }, client_secret: 'pi_prev_secret_x' } },
      body: { use_saved_card: false },
    });
    assert.equal(other.status, 200);
    assert.equal(other.body.clientSecret, 'pi_prev_secret_x');
    assert.equal(other.stripe.intentPosts().length, 0, 'no duplicate PaymentIntent');
  });
});

describe('create-event-ticket-intent — new card', () => {
  test('8. the new-card PaymentIntent carries the canonical customer when one exists', async () => {
    const r = await runTicket({ customerId: CUS, body: { use_saved_card: false } });
    assert.equal(r.status, 200);
    assert.equal(r.body.clientSecret, 'pi_test_1_secret_abc');
    const [pi] = r.stripe.intentPosts();
    assert.equal(pi.body.get('customer'), CUS);
    assert.equal(pi.body.get('automatic_payment_methods[enabled]'), 'true');
    assert.equal(pi.body.get('payment_method'), null, 'the buyer enters the card in the Payment Element');
    assert.equal(pi.body.get('confirm'), null, 'nothing is confirmed until they press Pay');
    assert.equal(r.stripe.intentPosts().length, 1);
  });

  test('9/10/11. …and it is still a platform destination charge: same transfer destination, same fee, no Stripe-Account header', async () => {
    for (const customerId of [CUS, null]) {
      const r = await runTicket({ customerId, body: { use_saved_card: false } });
      const [pi] = r.stripe.intentPosts();
      assert.equal(pi.body.get('transfer_data[destination]'), DEST);
      assert.equal(pi.body.get('application_fee_amount'), '96');
      assert.equal(pi.body.get('amount'), '196');
      assert.equal(pi.body.get('on_behalf_of'), null);
      assert.equal(pi.body.get('customer'), customerId, customerId ? 'attached' : 'a buyer with no customer simply has none');
      noStripeAccountHeader(r.stripe);
    }
  });

  test('12. no scenario ever creates a Stripe Customer, and the stale flag changes nothing', async () => {
    for (const sc of [
      { customerId: null, flag: true, body: { use_saved_card: true } },
      { customerId: null, flag: true, body: { use_saved_card: false } },
      { customerId: CUS, flag: false, body: { use_saved_card: false } },
      { customerId: CUS, stripe: { attached: [VISA] }, body: { use_saved_card: true } },
    ] as Scenario[]) {
      const r = await runTicket(sc);
      assert.ok(!r.stripe.calls.some((c) => /\/customers$/.test(new URL(c.url).pathname) && c.method === 'POST'), 'a customer was created');
      assert.ok(!r.db.log.updates.some((u) => u.table === 'profiles'), 'a profile was edited');
    }
    // The flag alone never causes a saved-card attempt: with no explicit choice there is no card lookup at all.
    const noChoice = await runTicket({ customerId: CUS, flag: true, stripe: { attached: [VISA] } });
    assert.ok(!noChoice.stripe.calls.some((c) => /payment_methods/.test(c.url)));
  });

  test('15. nothing card-shaped reaches a log or a response', async () => {
    const r = await runTicket({ stripe: { attached: [VISA], defaultPm: 'pm_VISA', intent: { id: 'pi_ok', status: 'succeeded' } }, body: { use_saved_card: true } });
    const seen = `${r.text}\n${r.logs.join('\n')}`;
    for (const leak of ['4242424242424242', 'FP-SECRET', 'sk_test_FAKE', 'pm_VISA']) assert.ok(!seen.includes(leak), `leaked ${leak}`);
  });

  test('the function source no longer trusts the flag or the first-card lookup, and never goes direct-charge', () => {
    const src = code(read('supabase/functions/create-event-ticket-intent/index.ts'));
    assert.doesNotMatch(src, /has_payment_method/);
    assert.doesNotMatch(src, /limit=1/);
    assert.doesNotMatch(src, /profile\?\.stripe_customer_id/);
    assert.match(src, /resolveSavedCard\(/);
    assert.match(src, /transfer_data\[destination\]/);
    assert.doesNotMatch(src, /Stripe-Account/i);
    assert.doesNotMatch(src, /on_behalf_of/);
    assert.doesNotMatch(src, /\/v1\/customers['"`]/, 'this function must not be able to create a customer');
  });
});

/* ── 5. web ────────────────────────────────────────────────────────────── */

describe('web ticket modal', () => {
  const modal = code(web('components/events/TicketModal.tsx'));
  const client = code(web('lib/events-client.ts'));

  test('4/14. a saved card is offered as a preselected choice, and Pay is the explicit action', () => {
    assert.match(modal, /setMethod\(s\.state === "card" \? "saved" : "new"\)/, 'preselected when the server confirms a card');
    assert.match(modal, /<p className="mb-2 text-sm font-semibold text-ink">Pay with<\/p>/);
    assert.match(modal, /formatCardLabel\(savedCard\.brand, savedCard\.last4\)/);
    assert.match(modal, /`Pay \$\{gbp\(totalPence\)\}`/, '"Pay £1.96" is the explicit final action for the saved card');
    // Nothing charges on selection or on load.
    const effects = [...modal.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
    assert.ok(effects.length >= 3, 'the modal\u2019s effects were found');
    for (const body of effects) assert.doesNotMatch(body, /proceed\(|startTicketPurchase\(/, 'an effect must never start a purchase');
    const selects = [...modal.matchAll(/onSelect=\{\(\) => (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(selects)], ['setMethod'], 'choosing a method only changes the method');
  });

  test('5. the buyer can choose another card, which opens the normal Payment Element', () => {
    assert.match(modal, /title=\{savedCard \? "Use a different card" : "Pay by card"\}/);
    assert.match(modal, /onSelect=\{\(\) => setMethod\("new"\)\}/);
    assert.match(modal, /useSavedCard: !viaWallet && usingSaved/);
    assert.match(modal, /const usingSaved = isPaid && savedCard != null && method === "saved";/);
    assert.match(modal, /<PaymentCheckout/);
  });

  test('the events client never charges a saved card by default', () => {
    assert.match(client, /useSavedCard = false/);
    assert.doesNotMatch(client, /useSavedCard = true/);
    assert.match(client, /use_saved_card: payWithWallet \? false : useSavedCard/);
  });

  test('6/7. when the server says the saved card is gone: refresh, offer another way, no second purchase attempt', () => {
    const catchBlock = modal.slice(modal.indexOf('} catch (e) {'), modal.indexOf('async function handlePaid'));
    assert.match(catchBlock, /code === "saved_card_unavailable"/);
    assert.match(catchBlock, /await refreshSavedCard\(\)/);
    assert.match(catchBlock, /setMethod\("new"\)/);
    assert.match(catchBlock, /setError\(/);
    assert.doesNotMatch(catchBlock, /startTicketPurchase|proceed\(/, 'the catch must not retry by another route');
  });

  test('a paid checkout waits for the server’s answer before it can say what it will charge', () => {
    assert.match(modal, /const cardLoading = isLoggedIn && isPaid && cardState === null;/);
    assert.equal((modal.match(/disabled=\{totalTickets === 0 \|\| busy \|\| cardLoading\}/g) ?? []).length, 3);
  });

  test('the saved-card client asks the server, never the profile flag, and holds brand + last4 only', () => {
    const sc = code(web('lib/saved-card-client.ts'));
    assert.match(sc, /functions\.invoke\("saved-card-state"\)/);
    assert.doesNotMatch(sc, /has_payment_method|stripe_customer_id|payment_method_id|pm_|cus_/);
    assert.match(sc, /card: \{\s*brand: typeof data\.brand === "string" \? data\.brand : null,\s*last4: typeof data\.last4 === "string" \? data\.last4 : null,\s*\}/);
    assert.doesNotMatch(modal, /has_payment_method|fetchCardOnFile/);
  });

  test('3d. the label shows brand and last four, and nothing else', () => {
    assert.equal(webLabel('visa', '4242'), 'Visa ending •••• 4242');
    assert.equal(webLabel('mastercard', '4444'), 'Mastercard ending •••• 4444');
    assert.equal(webLabel('amex', '0005'), 'American Express ending •••• 0005');
    assert.equal(webLabel('somenewbrand', '1111'), 'Card ending •••• 1111');
    assert.equal(webLabel(null, null), 'Card');
    assert.equal(webLabel('visa', '42424242'), 'Visa', 'anything that is not exactly four digits is refused');
    assert.equal(webLabel('visa', '<b>1</b>'), 'Visa');
  });
});

/* ── 6. mobile ─────────────────────────────────────────────────────────── */

describe('mobile event checkout', () => {
  const screen = code(read('app/event-ticket-checkout.tsx'));
  const api = code(read('lib/events-api.ts'));

  test('14. the confirm sheet is still shown before any paid purchase, and Confirm still runs the purchase', () => {
    assert.match(screen, /<ConfirmPaymentSheet/);
    assert.match(screen, /if \(grandTotalPence > 0\) \{ void refreshSavedCard\(\); setConfirming\(true\); \}/);
    assert.match(screen, /onConfirm=\{runPurchase\}/);
    assert.match(screen, /onConfirmWallet=\{runPurchaseWallet\}/);
  });

  test('it consumes the SAME canonical state: real card named on the sheet, flag no longer trusted', () => {
    assert.match(screen, /use_saved_card: cardState\?\.state === 'card'/);
    assert.match(screen, /payingWith=\{cardState\?\.state === 'card' \? formatCardLabel\(cardState\.brand, cardState\.last4\) : 'Card'\}/);
    assert.doesNotMatch(screen, /has_payment_method/);
    assert.doesNotMatch(screen, /payingWith="Saved card"/);
    assert.match(code(read('lib/saved-card-state.ts')), /functions\.invoke\('saved-card-state'\)/);
  });

  test('7. an unavailable saved card is surfaced, the state refreshed, and nothing else is tried', () => {
    const c = screen.slice(screen.indexOf("if (e?.code === 'saved_card_unavailable')"), screen.indexOf('const runPurchaseWallet'));
    assert.match(c, /await refreshSavedCard\(\)/);
    assert.match(c, /Saved card unavailable/);
    assert.doesNotMatch(c, /purchaseTickets|runPurchase\(/);
    assert.match(api, /throw withCode\(data\.error, data\.code\)/);
    assert.match(api, /throw withCode\(body\.error, body\.code\)/);
  });
});

/* ── 7. the live-data invariant ────────────────────────────────────────── */

/**
 * "This profile says it has a card, but nothing canonical backs that up": the
 * flag is true and there is no bound Customer — neither on the profile nor in
 * the durable claim registry. Parameterised over the table expressions so the
 * same statement can be proven against fixtures as well as the real tables.
 */
const staleFlagSql = (profiles: string, claims: string) => `
  select left(p.id::text, 8) as id8
  from ${profiles} p
  where p.has_payment_method
    and coalesce(p.stripe_customer_id, '') = ''
    and not exists (
      select 1 from ${claims} c
      where c.user_id = p.id and c.status = 'bound' and coalesce(c.stripe_customer_id, '') <> ''
    )
  order by 1`;

/**
 * Reported 24 Sep 2026 — the owner's own test accounts, to be reconciled in a
 * SEPARATE task (this one edits no production data). Shrink this list as they
 * are repaired; the test then guards against any NEW stale profile.
 */
const KNOWN_STALE_ID8 = ['493bd477', '7fe376c8', 'bd6276f0', 'efb83e4b'];

let sqlOk = false;
const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 200)}`);
  return p.rows ?? [];
};

describe('data invariant: has_payment_method must be backed by a canonical customer', () => {
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });

  test('16. the detector flags stale rows and only stale rows — proven on fixtures, no real data involved', (t) => {
    if (!sqlOk) return t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.');
    const u = (n: number) => `'0000000${n}-0000-0000-0000-000000000000'::uuid`;
    // 1 flag, no customer → STALE · 2 flag, empty customer → STALE · 3 flag + customer → fine
    // 4 no flag → fine · 5 flag, no customer, but a settled claim → fine
    const profiles = `(select * from (values
        (${u(1)}, true,  null::text),
        (${u(2)}, true,  ''::text),
        (${u(3)}, true,  'cus_a'::text),
        (${u(4)}, false, null::text),
        (${u(5)}, true,  null::text)
      ) as t(id, has_payment_method, stripe_customer_id))`;
    const claims = `(select * from (values
        (${u(5)}, 'bound'::text,     'cus_claim'::text),
        (${u(4)}, 'in_flight'::text, 'cus_x'::text)
      ) as t(user_id, status, stripe_customer_id))`;
    const ids = runSql(staleFlagSql(profiles, claims)).map((r) => r.id8);
    assert.deepEqual(ids, ['00000001', '00000002']);
    // An in-flight claim is not a binding.
    const inflightOnly = runSql(staleFlagSql(
      `(select * from (values (${u(9)}, true, null::text)) as t(id, has_payment_method, stripe_customer_id))`,
      `(select * from (values (${u(9)}, 'in_flight'::text, 'cus_z'::text)) as t(user_id, status, stripe_customer_id))`,
    )).map((r) => r.id8);
    assert.deepEqual(inflightOnly, ['00000009']);
  });

  test('16b. LIVE: no profile is newly flagged-without-a-customer beyond the reported list (read-only SELECT)', (t) => {
    if (!sqlOk) return t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.');
    const found = runSql(staleFlagSql('public.profiles', 'public.stripe_customer_claims')).map((r) => String(r.id8));
    const fresh = found.filter((id) => !KNOWN_STALE_ID8.includes(id));
    assert.deepEqual(fresh, [], `NEW profiles carry has_payment_method with no Stripe Customer: ${fresh.join(', ')}`);
  });
});

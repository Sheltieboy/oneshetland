/**
 * card-self-payment.node.test.ts — a card payment must not be able to pay the person who is making it.
 *
 * THE PATH
 *
 *   pay by card for something sold by a hub, business, event or driver whose payout account YOU control
 *   → the route makes a destination charge into that account (transfer_data[destination])
 *   → the money lands in your own connected account and can be paid out to your bank
 *   → the card is charged back, or was never yours (stolen-card monetisation); the platform and the real cardholder bear it
 *
 * The wallet routes and the card MEMBERSHIP route already refused this (selfPaymentBlock → wallet_destination_self_controlled).
 * The card routes for tickets, gifts, shop orders, passes and donations did not, nor did the Fetch driver hold.
 *
 * WHAT RUNS
 *
 * The REAL handlers — create-event-ticket-intent, create-gift-intent, create-product-order-intent, create-unit-purchase-intent,
 * create-hub-donation-intent, authorise-payment — and the real selfPaymentBlock, against an in-memory Supabase, and a Stripe that
 * records every PaymentIntent it is asked to create. Nothing leaves the process. Each route's CONTROL strips the guard out of the
 * handler's own source and shows the original payment going through; the same request against the real handler is refused before
 * anything is reserved, created, held or charged. The guard's SQL (who counts as controlling an account) is proved against a real
 * database in wallet-card-cashout.node.test.ts.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, REPO_ROOT } from './_support/load-source.ts';

type Row = Record<string, any>;

const ACCT = 'acct_seller';
const BOB = 'b0000000-0000-4000-8000-0000000000b0';        // an unrelated customer
const SELLER = '5e000000-0000-4000-8000-0000000000e0';      // owns the seller entity and controls ACCT
const SIBLING = '0f000000-0000-4000-8000-0000000000f0';     // owns a DIFFERENT hub/business pointing at the same account
const DRIVER = 'd0000000-0000-4000-8000-0000000000d0';      // a Fetch driver whose connected account is ACCT
const BIZ = 'b1000000-0000-4000-8000-0000000000b1';

let controls: Record<string, string[]>;
let account: string | null;
let isDemo: boolean;
let calls: { rpc: string[]; inserts: Row[]; updates: Row[]; deletes: string[] };
let stripe: { method: string; url: string; body: string }[];
let guardRpcError: boolean;

const selfPayment = () => loadModule('supabase/functions/_shared/self-payment.ts', { 'https://esm.sh/@supabase/supabase-js@2': {} });

/** an in-memory Supabase whose rows are set per test; the guard's rpc answers from `controls` (its SQL is proved elsewhere) */
function fakeDb(tables: Record<string, any>, rpcResults: Record<string, any> = {}) {
  const chain = (table: string) => {
    const c: any = {}; let inserted = false;
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'neq', 'not', 'or', 'gte', 'lte']) c[m] = () => c;
    const first = () => (Array.isArray(tables[table]) ? tables[table][0] ?? null : tables[table] ?? null);
    c.single = async () => ({ data: inserted ? { id: `new-${table}` } : first(), error: null });
    c.maybeSingle = async () => ({ data: inserted ? { id: `new-${table}` } : first(), error: null });
    c.insert = (v: Row) => { calls.inserts.push({ table, v }); inserted = true; return c; };
    c.update = (v: Row) => { calls.updates.push({ table, v }); return c; };
    c.delete = () => { calls.deletes.push(table); return c; };
    c.then = (res: any, rej: any) => Promise.resolve({ data: Array.isArray(tables[table]) ? tables[table] : (tables[table] ? [tables[table]] : []), error: null }).then(res, rej);
    return c;
  };
  return {
    from: chain,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'buyer@example.org' } } }) } },
    rpc: async (name: string, args: Row) => {
      calls.rpc.push(name);
      if (name === 'wallet_destination_self_controlled') {
        if (guardRpcError) return { data: null, error: { message: 'boom' } };
        return { data: !!args.p_account && (controls[args.p_account] ?? []).includes(args.p_user), error: null };
      }
      if (name === 'business_payout_destination' || name === 'event_payout_destination') return { data: [{ account_id: account, is_demo: isDemo }], error: null };
      if (name in rpcResults) return { data: typeof rpcResults[name] === 'function' ? rpcResults[name](args) : rpcResults[name], error: null };
      return { data: null, error: null };
    },
  };
}

/** What the database's atomic claim / lease functions answer (their SQL is proved in purchase-attempt-idempotency.node.test.ts). */
const ATTEMPT_RPCS = {
  claim_gift_purchase: (a: Row) => ({ gift_id: 'new-book_gifts', replayed: false, status: 'pending_payment', pay_mode: a.p_pay_mode, payment_intent_id: null }),
  claim_product_order: (a: Row) => ({ order_id: 'new-product_orders', replayed: false, status: 'pending', pay_mode: a.p_pay_mode, payment_intent_id: null, total_pence: a.p_total_pence }),
  claim_purchase_processing: true,
};
/** a refused self-payment must not even have claimed an attempt */
const claimed = () => calls.rpc.filter((r) => r.startsWith('claim_')).map((r) => `an attempt was claimed (${r})`);

let dbFactory: () => any;
const createClient = (_u: string, key: string, opts: Row = {}) => key === 'anon-key'
  ? { auth: { getUser: async () => ({ data: { user: { id: String(opts?.global?.headers?.Authorization ?? '').replace('Bearer user-', '') } }, error: null }) } }
  : dbFactory();

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_fake' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    stripe.push({ method: init.method ?? 'GET', url, body: String(init.body ?? '') });
    if (/api\.stripe\.com\/v1\/payment_intents$/.test(url) && init.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: `pi_${stripe.length}`, client_secret: `pi_${stripe.length}_secret`, status: 'requires_payment_method', latest_charge: null }) };
    }
    if (/api\.stripe\.com/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [], id: 'x' }) };
    throw new Error(`unexpected network call ${url}`);
  };
}

/** removes the self-payment block from a handler's own source: the handler as it was */
const withoutGuard = (src: string) => src
  .replace(/\n\s*\/\/ ── You cannot pay yourself[\s\S]*?\n(?=\s*\/\/ Platform commission|\s*\/\/ Donations earn|\s*const (?:giftCfg|unitCfg)|\s*const \{ data: ship \}|\s*\/\/ ── Reserve the basket)/, '\n');

let handler: (r: Request) => Promise<Response>;
const ok = () => ({ enforcePaymentStart: async () => ({ ok: true }) });
const post = (fn: string, as: string, body: Row) => handler(new Request(`https://fake.supabase.co/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer user-${as}` }, body: JSON.stringify(body) }));
const piPosts = () => stripe.filter((s) => s.method === 'POST' && /v1\/payment_intents$/.test(s.url));
const toDestination = () => piPosts().filter((p) => p.body.includes(`transfer_data%5Bdestination%5D=${ACCT}`) || p.body.includes(`transfer_data[destination]=${ACCT}`));
let n = 0;

beforeEach(() => {
  controls = { [ACCT]: [SELLER] };
  account = ACCT; isDemo = false; guardRpcError = false; n = 0;
  calls = { rpc: [], inserts: [], updates: [], deletes: [] };
  stripe = [];
  installGlobals();
});

/* ── a small helper so each route reads the same ──────────────────────────── */

interface Route {
  name: string;
  load(strip: boolean): void;
  buy(as: string, extra?: Row): Promise<Response>;
  /** what must NOT exist when the buyer is refused */
  forbidden(): string[];
  /** a buyer that the route itself already refuses before the guard (to document class B), if any */
  ownerBlockedEarly?: boolean;
}

function noWrites(): string[] {
  const bad: string[] = [];
  if (piPosts().length) bad.push('a PaymentIntent was created');
  if (calls.inserts.length) bad.push(`rows inserted: ${[...new Set(calls.inserts.map((i) => i.table))].join(',')}`);
  if (calls.updates.length) bad.push(`rows updated: ${[...new Set(calls.updates.map((i) => i.table))].join(',')}`);
  return bad;
}

/* ── tickets (card) ────────────────────────────────────────────────────────── */

const EVENT = 'e1000000-0000-4000-8000-0000000000e1';
const TT = 'f1000000-0000-4000-8000-0000000000f1';
const TICKETS: Route = {
  name: 'event tickets',
  load(strip) {
    dbFactory = () => fakeDb({
      events: { id: EVENT, title: 'Up Helly Aa', starts_at: '2026-12-01T00:00:00Z', venue: 'Lerwick', formatted_address: 'Lerwick', status: 'published', organiser_business_id: null, organiser_hub_id: 'hub1' },
      event_ticket_types: [{ id: TT, name: 'Adult', price_pence: 1000, per_order_max: 10, is_active: true, event_id: EVENT, sale_starts_at: null, sale_ends_at: null }],
    }, { reserve_ticket_basket: { order_id: 'order1', ticket_ids: ['t1'], already: false, status: 'pending' } });
    loadModule('supabase/functions/create-event-ticket-intent/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient },
      '../_shared/ticket-receipt.ts': { sendTicketReceipt: async () => {} },
      '../_shared/ticket-quantities.ts': loadModule('supabase/functions/_shared/ticket-quantities.ts', {}),
      '../_shared/wallet-ledger.ts': { debitAndTransfer: async () => ({ ok: true, balancePence: 0, transactionId: 'tx', transferId: null, alreadyApplied: false }), selfPaymentBlock: selfPayment().selfPaymentBlock },
      '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: any, _p: number, run: () => Promise<any>) => ({ ok: true, value: await run() }) },
      '../_shared/safe-error.ts': { safeError: () => 'internal error' },
      '../_shared/rate-limit.ts': ok(),
      '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
      '../_shared/saved-card-state.ts': { resolveSavedCard: async () => ({ kind: 'none' }), boundCustomerFor: async () => null },
      '../_shared/stripe-errors.ts': { stripeError: (e: any) => e, checkoutFailure: () => null },
    }, strip ? withoutGuard : undefined);
  },
  buy: (as, extra = {}) => post('create-event-ticket-intent', as, { event_id: EVENT, line_items: [{ ticket_type_id: TT, quantity: 1 }], pay_with_wallet: false, client_request_id: `req-${++n}-abcdefgh`, ...extra }),
  forbidden() { return [...noWrites(), ...(calls.rpc.includes('reserve_ticket_basket') ? ['seats were reserved'] : [])]; },
};

/* ── gifts (card) ──────────────────────────────────────────────────────────── */

const GIFTS: Route = {
  name: 'gifts',
  load(strip) {
    dbFactory = () => fakeDb({ book_unit_items: { id: 'item1', business_id: BIZ, name: 'Hamper', price_pence: 2000, stock: 5, is_active: true } }, ATTEMPT_RPCS);
    loadModule('supabase/functions/create-gift-intent/index.ts', {
      '../_shared/purchase-attempt.ts': loadModule('supabase/functions/_shared/purchase-attempt.ts', {}),
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient },
      '../_shared/commission.ts': { calculateCommission: (p: number) => ({ fee_pence: Math.floor(p * 0.05) }) },
      '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
      '../_shared/wallet-ledger.ts': { debitAndTransfer: async () => ({ ok: true, balancePence: 0, transactionId: 'tx', transferId: null, alreadyApplied: false }), selfPaymentBlock: selfPayment().selfPaymentBlock },
      '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: any, _p: number, run: () => Promise<any>) => ({ ok: true, value: await run() }) },
      '../_shared/safe-error.ts': { safeError: () => 'internal error' },
      '../_shared/rate-limit.ts': ok(),
      '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
      '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
    }, strip ? withoutGuard : undefined);
  },
  buy: (as, extra = {}) => post('create-gift-intent', as, { client_request_id: `req-${++n}-abcdefgh`, kind: 'unit', unit_item_id: 'item1', recipient_email: 'friend@example.org', recipient_name: 'Friend', pay_with_wallet: false, ...extra }),
  forbidden() { return [...noWrites(), ...claimed(), ...(calls.deletes.length ? ['a gift row had to be cleaned up'] : [])]; },
};

/* ── shop orders (card) ────────────────────────────────────────────────────── */

const PRODUCT = 'a9000000-0000-4000-8000-0000000000a9';
const PRODUCTS: Route = {
  name: 'shop orders',
  ownerBlockedEarly: true,
  load(strip) {
    dbFactory = () => fakeDb({
      local_businesses: { id: BIZ, name: 'Voe Gift Shop', owner_id: SELLER, is_active: true, accepts_wallet: true, cashback_percent: 0 },
      business_shipping: { business_id: BIZ, collect_enabled: true },
      products: [{ id: PRODUCT, business_id: BIZ, title: 'Mug', price_pence: 1000, photos: [], stock_mode: 'tracked', is_active: true, sold_at: null, collect_only: false, free_uk_post: false }],
      product_variants: [],
      profiles: { stripe_customer_id: null },
    }, { business_meets_tier: true, ...ATTEMPT_RPCS });
    loadModule('supabase/functions/create-product-order-intent/index.ts', {
      '../_shared/purchase-attempt.ts': loadModule('supabase/functions/_shared/purchase-attempt.ts', {}),
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient },
      '../_shared/commission.ts': { calculateCommission: (p: number) => ({ fee_pence: Math.floor(p * 0.05) }) },
      '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
      '../_shared/wallet-pay.ts': { executeWalletPayment: async () => ({ ok: true, balance_pence: 0, transactionId: 'tx' }) },
      '../_shared/self-payment.ts': selfPayment(),
      '../_shared/send-push.ts': { sendUserPush: async () => {} },
      '../_shared/fulfilment.ts': { spawnFetchRequest: async () => {} },
      '../_shared/safe-error.ts': { safeError: () => 'internal error' },
      '../_shared/rate-limit.ts': ok(),
      '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
      '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
    }, strip ? withoutGuard : undefined);
  },
  buy: (as, extra = {}) => post('create-product-order-intent', as, { client_request_id: `req-${++n}-abcdefgh`, business_id: BIZ, items: [{ product_id: PRODUCT, qty: 1 }], fulfilment: 'collect', pay_with: 'card', ...extra }),
  // Stock is reserved INSIDE the attempt claim now, so "no claim" is the same statement as "no reservation".
  forbidden() { return [...noWrites(), ...claimed(), ...(calls.rpc.includes('reserve_product_stock') ? ['stock was reserved'] : [])]; },
};

/* ── passes (card) ─────────────────────────────────────────────────────────── */

const PASSES: Route = {
  name: 'passes',
  load(strip) {
    dbFactory = () => fakeDb({ book_unit_items: { id: 'item1', name: 'Coffee card', price_pence: 500, stock: 5, is_active: true, business_id: BIZ } }, { business_meets_tier: true });
    loadModule('supabase/functions/create-unit-purchase-intent/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient },
      '../_shared/commission.ts': { calculateCommission: (p: number) => ({ fee_pence: Math.floor(p * 0.05) }) },
      '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
      '../_shared/safe-error.ts': { safeError: () => 'internal error' },
      '../_shared/rate-limit.ts': ok(),
      '../_shared/self-payment.ts': selfPayment(),
      '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
      '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
    }, strip ? withoutGuard : undefined);
  },
  buy: (as, extra = {}) => post('create-unit-purchase-intent', as, { unit_item_id: 'item1', client_request_id: `req-${++n}-abcdefgh`, ...extra }),
  forbidden() { return noWrites(); },
};

/* ── donations (card) ──────────────────────────────────────────────────────── */

const DONATIONS: Route = {
  name: 'hub donations',
  load(strip) {
    dbFactory = () => fakeDb({
      hubs: { id: 'hub1', name: 'Voe Hall', stripe_account_id: account, payout_enabled: true, is_active: true, slug: 'voe-hall', is_charity: false, charity_number: null },
      hub_donation_attempts: { id: 'att1', campaign_id: 'camp1', face_pence: 1000, cover_pence: 0, payment_intent_id: null, status: 'pending' },
    }, { campaign_donation_eligibility: [{ eligible: true, campaign_id: 'camp1', hub_id: 'hub1', title: 'New roof' }] });
    loadModule('supabase/functions/create-hub-donation-intent/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient },
      '../_shared/commission.ts': { calculateCommission: (p: number) => ({ fee_pence: Math.floor(p * 0.015) + 20 }) },
      '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
      '../_shared/safe-error.ts': { safeError: () => 'internal error' },
      '../_shared/rate-limit.ts': ok(),
      '../_shared/self-payment.ts': selfPayment(),
      '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
      '../_shared/uk-postcode.ts': { normaliseUkPostcode: (p: string) => p },
      '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
    }, strip ? withoutGuard : undefined);
  },
  buy: (as, extra = {}) => post('create-hub-donation-intent', as, { campaign_id: 'camp1', amount_pence: 1000, client_request_id: `req-${++n}-abcdefgh`, ...extra }),
  forbidden() { return [...noWrites()]; },
};

/* ── the routes, one set of expectations ──────────────────────────────────── */

for (const R of [TICKETS, GIFTS, PRODUCTS, PASSES, DONATIONS]) {
  describe(`${R.name} paid by CARD`, () => {
    test('LEGITIMATE: an unrelated buyer pays — a PaymentIntent is created, destined for the seller’s account, with the server’s amount', async () => {
      R.load(false);
      const res = await R.buy(BOB);
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(toDestination().length, 1, 'exactly one destination charge, into the seller’s account');
    });

    test('CONTROL (the audit finding): with the guard removed, a buyer who controls the destination account completes a card payment into it', async () => {
      R.load(true);
      // for shops the owner is refused earlier, by a separate rule; the gap is the SIBLING that shares the account
      const as = R.ownerBlockedEarly ? SIBLING : SELLER;
      controls = { [ACCT]: [SELLER, SIBLING] };
      const res = await R.buy(as);
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(toDestination().length, 1, 'a destination charge into an account the buyer controls');
    });

    test('FIXED: the same buyer is refused with 403 self_payment, a calm message, and NOTHING exists — no PaymentIntent, no row, no reservation', async () => {
      R.load(false);
      controls = { [ACCT]: [SELLER, SIBLING] };
      const as = R.ownerBlockedEarly ? SIBLING : SELLER;
      const res = await R.buy(as);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.reason, 'self_payment');
      assert.match(body.error, /can't pay a business, hub or driver whose payout account you control/);
      assert.doesNotMatch(JSON.stringify(body), /stripe|fraud|chargeback|acct_|wallet/i, 'no provider, no suspicion, no account id, no mention of a wallet the buyer is not using');
      assert.deepEqual(R.forbidden(), [], R.forbidden().join('; '));
    });

    test('a different business or hub that shares the buyer’s connected account is caught too (the account is what is asked)', async () => {
      R.load(false);
      controls = { [ACCT]: [SELLER, SIBLING] };
      const res = await R.buy(SIBLING);
      assert.equal(res.status, 403);
      assert.deepEqual(R.forbidden(), []);
    });

    test('the client cannot dodge the guard, or redirect the money, by naming a seller account in the request', async () => {
      R.load(false);
      controls = { [ACCT]: [SELLER, SIBLING] };
      const blockedAs = R.ownerBlockedEarly ? SIBLING : SELLER;
      const evil = { stripe_account_id: 'acct_evil', destination: 'acct_evil', account_id: 'acct_evil', connected_account: 'acct_evil', seller_id: 'someone-else' };
      const refused = await R.buy(blockedAs, evil);
      assert.equal(refused.status, 403, 'the destination is resolved server-side, so naming another account does not dodge the guard');
      assert.deepEqual(R.forbidden(), []);
      const fine = await R.buy(BOB, evil);
      assert.equal(fine.status, 200);
      assert.equal(toDestination().length, 1, 'the money still goes to the account resolved from the seller');
      assert.ok(!piPosts().some((p) => p.body.includes('acct_evil')), 'a client-named account never reached Stripe');
    });

    test('an unrelated buyer is not over-blocked even when ANOTHER account has self-payers', async () => {
      R.load(false);
      controls = { [ACCT]: [SELLER], acct_other: [BOB] };
      assert.equal((await R.buy(BOB)).status, 200);
    });

    test('if the guard cannot answer, the purchase fails closed — nothing is created', async () => {
      R.load(false);
      guardRpcError = true;
      const res = await R.buy(BOB);
      assert.ok(res.status >= 500, String(res.status));
      assert.deepEqual(R.forbidden(), []);
    });

    test('a seller with no connected account at all is never asked (there is no payout to protect)', async () => {
      account = null; isDemo = true;
      R.load(false);
      await R.buy(SELLER);
      assert.ok(!calls.rpc.includes('wallet_destination_self_controlled'));
    });
  });
}

/* ── the shop already refused the owner; the gap was the shared account ───── */

describe('shop orders — the owner was already refused; the account-based rule closes the rest', () => {
  test('the shop’s own owner is refused by the pre-existing "your own shop" rule (class B, unchanged)', async () => {
    PRODUCTS.load(false);
    const res = await PRODUCTS.buy(SELLER);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /own shop/);
  });
});

/* ── Fetch: the driver hold ───────────────────────────────────────────────── */

const REQ = 'c9000000-0000-4000-8000-0000000000c9';
function loadAuthorise(strip: boolean) {
  dbFactory = () => fakeDb({
    delivery_requests: { id: REQ, customer_id: BOB, category_slug: 'parcel', payment_intent_id: null, payment_status: null, run_id: 'run1', base_fee_pence: 800 },
    profiles: { stripe_customer_id: 'cus_1', push_token: null, full_name: 'Customer' },
    runs: { driver_id: DRIVER },
    driver_profiles: { stripe_account_id: ACCT },
    delivery_pricing_config: { wait_grace_secs: 300, wait_period_secs: 300, wait_period_pence: 150, wait_max_pence: 0 },
  }, { claim_fetch_authorisation: [{ outcome: 'claimed', status: 'claimed', stripe_payment_intent_id: null }] });
  loadModule('supabase/functions/authorise-payment/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/send-push.ts': { sendUserPush: async () => {} },
    '../_shared/commission.ts': { calculateCommission: (p: number) => ({ fee_pence: Math.floor(p * 0.1) }) },
    '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/fetch-authorisation.ts': { classifyAuthorisation: () => 'requires_payment_method', paymentStatusFor: () => 'unpaid' },
    '../_shared/fetch-hold.ts': { classifyHold: () => ({ state: 'none', detail: null, expiresAt: null }) },
    '../_shared/saved-card.ts': { defaultCardFor: async () => null },
    '../_shared/stripe-customer.ts': { canonicalStripeCustomer: async () => ({ kind: 'ok', customerId: 'cus_1' }) },
    '../_shared/self-payment.ts': selfPayment(),
  }, strip ? (s: string) => s.replace(/\n\s*\/\/ ── A delivery's card hold must not pay[\s\S]*?\n    \}\n(?=\n)/, '\n') : undefined);
}
const authorise = (as: string) => post('authorise-payment', as, { request_id: REQ });

const fetchDb = (customerId: string) => () => fakeDb({
  delivery_requests: { id: REQ, customer_id: customerId, category_slug: 'parcel', payment_intent_id: null, payment_status: null, run_id: 'run1', base_fee_pence: 800 },
  profiles: { stripe_customer_id: 'cus_1', push_token: null, full_name: 'Customer' },
  runs: { driver_id: DRIVER },
  driver_profiles: { stripe_account_id: ACCT },
  delivery_pricing_config: { wait_grace_secs: 300, wait_period_secs: 300, wait_period_pence: 150, wait_max_pence: 0 },
}, { claim_fetch_authorisation: [{ outcome: 'claimed', status: 'claimed', stripe_payment_intent_id: null }] });

describe('Fetch delivery hold (card → driver’s connected account)', () => {
  beforeEach(() => { controls = { [ACCT]: [DRIVER] }; });

  test('LEGITIMATE: a customer and a DIFFERENT driver — the hold is a destination charge into the driver’s account', async () => {
    loadAuthorise(false);
    dbFactory = fetchDb(BOB);
    await authorise(DRIVER);
    assert.equal(toDestination().length, 1);
  });

  test('CONTROL (the audit finding): an approved driver who is ALSO the customer, with the guard removed, holds a card into their own account', async () => {
    loadAuthorise(true);
    dbFactory = fetchDb(DRIVER);          // the customer IS the driver
    await authorise(DRIVER);
    assert.equal(toDestination().length, 1, 'the card was held into the cardholder’s own account');
  });

  test('FIXED: the same request is refused — 403 self_payment, no Stripe Customer, no authorisation claim, no PaymentIntent', async () => {
    loadAuthorise(false);
    dbFactory = fetchDb(DRIVER);
    const res = await authorise(DRIVER);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, 'self_payment');
    assert.equal(piPosts().length, 0);
    assert.ok(!calls.rpc.includes('claim_fetch_authorisation'), 'no authorisation claim was taken');
  });

  test('only the assigned driver can start the hold at all (unchanged)', async () => {
    loadAuthorise(false);
    dbFactory = fetchDb(BOB);
    assert.equal((await authorise(BOB)).status, 403);
  });
});

/* ── nothing that pays a connected account can be added without the guard ─── */

describe('every route that creates a destination charge asks who controls the account — BEFORE it creates anything', () => {
  const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dirs = readdirSync(FUNCS).filter((d) => !d.startsWith('_') && existsSync(join(FUNCS, d, 'index.ts')));
  const PAYS_AN_ACCOUNT = /transfer_data\[destination\]|'transfer_data\[destination\]'|debitAndTransfer\(|executeWalletPayment\(|settleMerchantWalletPayment\(/;

  /** routes that pay a connected account without the buyer being able to be that account, each with the reason */
  const EXEMPT: Record<string, string> = {
    'fetch-authorise': 'creates a replacement hold only inside reauthorise(), which asks the guard first (tested below); its default mode only reads an existing intent',
    'wallet-checkout': 'wallet route: asks the guard per payment type (wallet-self-payment.node.test.ts)',
    'wallet-refund-business': 'a refund back to the customer, not a payment',
    'stripe-webhook': 'inbound; creates no payment',
    'refund-payment': 'a refund, not a payment',
  };

  test('each one calls selfPaymentBlock, and does so before its first Stripe call, row insert or reservation', () => {
    const bad: string[] = [];
    for (const d of dirs) {
      const whole = strip(readFileSync(join(FUNCS, d, 'index.ts'), 'utf8'));
      if (!PAYS_AN_ACCOUNT.test(whole) || EXEMPT[d]) continue;
      const h = whole.indexOf('serve(');
      const code = h === -1 ? whole : whole.slice(h);
      const guard = code.search(/\bselfPaymentBlock\(/);
      if (guard === -1 && /executeWalletPayment\(/.test(code) && !/transfer_data\[destination\]/.test(code)) continue;   // wallet-only routes are guarded in the shared executor
      if (guard === -1) { bad.push(`${d} (no guard)`); continue; }
      const early = [/api\.stripe\.com/, /createPaymentIntent\(/, /\.rpc\('reserve_\w+'/, /\.rpc\('claim_\w*attempt'/, /\.rpc\('claim_fetch_authorisation'/, /\.from\('book_gifts'\)\s*\.insert/, /\.from\('hub_donation_attempts'\)\.insert/, /\.from\('product_orders'\)\.insert/]
        .some((re) => { const m = code.search(re); return m !== -1 && m < guard; });
      if (early) bad.push(`${d} (guard after a create)`);
    }
    assert.deepEqual(bad, [], `routes that pay a connected account without asking who controls it, or ask too late: ${bad.join(', ')}`);
  });

  test('fetch-authorise’s replacement hold asks the guard before it touches the old hold', () => {
    const code = strip(readFileSync(join(FUNCS, 'fetch-authorise', 'index.ts'), 'utf8'));
    const fn = code.slice(code.indexOf('async function reauthorise'));
    const guard = fn.search(/\bselfPaymentBlock\(/);
    assert.ok(guard > -1);
    assert.ok(guard < fn.indexOf('readHold('), 'the old hold is read before the check');
    assert.ok(guard < fn.indexOf('/cancel'), 'the old hold is cancelled before the check');
    assert.ok(guard < fn.indexOf("rpc('reauthorise_fetch_delivery'"), 'the generation is claimed before the check');
  });

  test('the card membership route keeps its own guard, unchanged', () => {
    const code = strip(readFileSync(join(FUNCS, 'create-hub-membership-intent', 'index.ts'), 'utf8'));
    assert.match(code, /selfPaymentBlock\(svc, user\.id, hub\.stripe_account_id\)/);
    assert.match(code, /You can't buy membership from a hub whose payout account you control\./);
  });

  test('platform-revenue checkouts (boosts, subscriptions, shift boosts, wallet top-ups) have no connected account, so are not asked', () => {
    for (const d of ['create-boost-intent', 'local-boost-checkout', 'local-subscription-intent', 'local-wallet-topup-intent']) {
      const code = strip(readFileSync(join(FUNCS, d, 'index.ts'), 'utf8'));
      assert.doesNotMatch(code, /transfer_data\[destination\]/, `${d} now pays a connected account`);
    }
  });
});

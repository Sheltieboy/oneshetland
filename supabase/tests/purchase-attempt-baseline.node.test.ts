/**
 * purchase-attempt-baseline.node.test.ts — the finding, reproduced: what the ORIGINAL handlers did with a repeated purchase.
 *
 * Runs create-product-order-intent and create-gift-intent exactly as they were before the attempt-id change (commit a670f1a),
 * through the same isolated database and Stripe simulator as purchase-attempt-handlers.node.test.ts, and MEASURES what one
 * logical purchase turns into when it is submitted more than once. These assertions document the original behaviour; they pass
 * because the original was broken, and they are what shows the harness can see the bug the fix removes.
 *
 * Skipped (not failed) if that commit is no longer in the repository.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync as git } from 'node:child_process';
import { loadModule } from './_support/load-source.ts';
import { assertIsolated, buildFixture, resetData, must, num, scalar, pgClient, REPO_ROOT, IDS, type PgClient } from './_support/purchase-fixture.ts';

const BASE = 'a670f1a';
const { ALICE, BIZ, P_TRACKED, UNIT } = IDS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const original = (rel: string) => git('git', ['show', `${BASE}:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8' });
const available = (() => { try { git('git', ['cat-file', '-e', `${BASE}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' }); return true; } catch { return false; } })();

let db: PgClient;
let handler: ((r: Request) => Promise<Response>) | null = null;
let piCreated: Record<string, any>[];
let piPosts: { key: string | null }[];
let debits: Map<string, number>;
let walletDelay = 0;
let delayMs = 0;
let loseResponseOnce = false;
let n = 0;
const sca = loadModule('supabase/functions/_shared/stripe-sca.ts');

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_sim' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const res = (status: number, json: any) => ({ ok: status < 300, status, json: async () => json });
    if (init.method === 'POST' && /payment_intents$/.test(url)) {
      const key = (init.headers ?? {})['Idempotency-Key'] ?? null;
      piPosts.push({ key });
      if (delayMs) await sleep(delayMs);
      const id = `pi_sim_${++n}`;
      const json = { id, client_secret: `${id}_secret`, status: 'requires_payment_method' };
      piCreated.push(json);
      if (loseResponseOnce) { loseResponseOnce = false; throw new TypeError('connection reset'); }
      return res(200, json);
    }
    throw new Error(`unexpected network call ${url}`);
  };
}
const createClient = (_u: string, key: string, opts: Record<string, any> = {}) => key === 'anon-key'
  ? { auth: { getUser: async () => ({ data: { user: { id: String(opts?.global?.headers?.Authorization ?? '').replace('Bearer user-', '') } }, error: null }) } }
  : db;
const stubs = (extra: Record<string, unknown>) => ({
  'https://deno.land/std@0.168.0/http/server.ts': { serve: (fn: any) => { handler = fn; } },
  'https://esm.sh/@supabase/supabase-js@2': { createClient },
  '../_shared/commission.ts': { calculateCommission: (amt: number) => ({ fee_pence: Math.round(amt * 0.05) }) },
  '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
  '../_shared/self-payment.ts': { selfPaymentBlock: async () => null },
  '../_shared/send-push.ts': { sendUserPush: async () => {} },
  '../_shared/fulfilment.ts': { spawnFetchRequest: async () => {} },
  '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
  '../_shared/rate-limit.ts': { enforcePaymentStart: async () => ({ ok: true }) },
  '../_shared/stripe-sca.ts': sca,
  '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
  '../_shared/wallet-pay.ts': {
    executeWalletPayment: async (_s: unknown, a: any) => {
      // a ledger keyed on the idempotency key, as the real one is: a repeat of the SAME key is applied once
      const repeat = debits.has(a.idempotencyKey); if (!repeat) debits.set(a.idempotencyKey, a.amountPence);
      if (walletDelay) await sleep(walletDelay);
      return { ok: true, balance_pence: 5000, cashback_pence: 0, transfer_id: 'tr', transactionId: '00000000-0000-4000-8000-000000000001', alreadyApplied: repeat };
    },
  },
  '../_shared/wallet-ledger.ts': {
    selfPaymentBlock: async () => null,
    debitAndTransfer: async (_s: unknown, a: any) => {
      const repeat = debits.has(a.idempotencyKey); if (!repeat) debits.set(a.idempotencyKey, a.spendPence);
      if (walletDelay) await sleep(walletDelay);
      return { ok: true, balancePence: 5000, transactionId: '00000000-0000-4000-8000-000000000001', alreadyApplied: repeat };
    },
  },
  '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: unknown, _n: number, fn: () => Promise<any>) => ({ ok: true, value: await fn() }) },
  ...extra,
});
const loadOriginal = (rel: string) => { handler = null; loadModule(rel, stubs({}), () => original(rel)); return handler!; };
const call = async (h: (r: Request) => Promise<Response>, body: Record<string, any>) => {
  const r = await h(new Request('https://fake.supabase.co/x', { method: 'POST', headers: { Authorization: `Bearer user-${ALICE}` }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() as Record<string, any> };
};
const basket = (extra: Record<string, any> = {}) => ({ client_request_id: 'same-attempt-id', business_id: BIZ, items: [{ product_id: P_TRACKED, qty: 2 }], fulfilment: 'collect', pay_with: 'card', ...extra });
const giftBody = (extra: Record<string, any> = {}) => ({ client_request_id: 'same-attempt-id', kind: 'unit', unit_item_id: UNIT, recipient_email: 'friend@example.org', ...extra });
const orders = () => num(`select count(*) from public.product_orders`);
const gifts = () => num(`select count(*) from public.book_gifts`);
const reserved = () => num(`select reserved from public.products where id = '${P_TRACKED}'`);

const measure = (label: string, row: Record<string, number | string>) => console.log(`BASELINE ${label.padEnd(44)} ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  ')}`);

before(() => { if (!available) return; assertIsolated(); buildFixture(); });
beforeEach(() => {
  if (!available) return;
  resetData(); must(`truncate public.business_shipping`);
  db = pgClient(); piCreated = []; piPosts = []; debits = new Map(); walletDelay = 0; delayMs = 0; loseResponseOnce = false; n = 0; installGlobals();
});
after(() => { delete (globalThis as any).Deno; });

describe('BEFORE the fix — one logical purchase submitted more than once', { skip: !available && `commit ${BASE} is not in this repository` }, () => {
  test('shop order, card: submitted twice in sequence → two orders, two PaymentIntents, stock reserved twice', async () => {
    const h = loadOriginal('supabase/functions/create-product-order-intent/index.ts');
    await call(h, basket()); await call(h, basket());
    measure('product, card, 2 sequential', { orders: orders(), paymentIntents: piCreated.length, reserved: reserved() });
    assert.equal(orders(), 2); assert.equal(piCreated.length, 2); assert.equal(reserved(), 4);
    assert.notEqual(piPosts[0].key, piPosts[1].key, 'the Stripe key was derived from a fresh row id, so it never matched');
  });

  test('shop order, card: five at once → five orders, five PaymentIntents, stock reserved five times', async () => {
    delayMs = 150;
    const h = loadOriginal('supabase/functions/create-product-order-intent/index.ts');
    await Promise.all([0, 1, 2, 3, 4].map(() => call(h, basket())));
    measure('product, card, 5 concurrent', { orders: orders(), paymentIntents: piCreated.length, reserved: reserved() });
    assert.equal(orders(), 5); assert.equal(piCreated.length, 5); assert.equal(reserved(), 10);
  });

  test('shop order, wallet: five at once → five orders, five wallet debits', async () => {
    walletDelay = 150;
    const h = loadOriginal('supabase/functions/create-product-order-intent/index.ts');
    await Promise.all([0, 1, 2, 3, 4].map(() => call(h, basket({ pay_with: 'wallet' }))));
    measure('product, wallet, 5 concurrent', { orders: orders(), walletDebits: debits.size, stockLeft: scalar(`select stock from public.products where id = '${P_TRACKED}'`) });
    assert.equal(orders(), 5); assert.equal(debits.size, 5);
  });

  test('shop order, card: the response is lost and the buyer retries → a second order and a second PaymentIntent', async () => {
    const h = loadOriginal('supabase/functions/create-product-order-intent/index.ts');
    loseResponseOnce = true;
    await call(h, basket()); await call(h, basket());
    measure('product, card, response lost + retry', { orders: orders(), paymentIntents: piCreated.length, reserved: reserved() });
    assert.equal(piCreated.length, 2, 'Stripe made one the client never saw, and the retry made another');
  });

  test('gift, card: submitted twice in sequence → two gift rows and two PaymentIntents (the PaymentSheet route sent NO Stripe key at all)', async () => {
    const h = loadOriginal('supabase/functions/create-gift-intent/index.ts');
    await call(h, giftBody()); await call(h, giftBody());
    measure('gift, card form, 2 sequential', { gifts: gifts(), paymentIntents: piCreated.length, stripeKeys: JSON.stringify(piPosts.map((p) => p.key)) });
    assert.equal(gifts(), 2); assert.equal(piCreated.length, 2); assert.deepEqual(piPosts.map((p) => p.key), [null, null]);
  });

  test('gift, card: five at once → five gifts and five PaymentIntents', async () => {
    delayMs = 150;
    const h = loadOriginal('supabase/functions/create-gift-intent/index.ts');
    await Promise.all([0, 1, 2, 3, 4].map(() => call(h, giftBody())));
    measure('gift, card form, 5 concurrent', { gifts: gifts(), paymentIntents: piCreated.length });
    assert.equal(gifts(), 5); assert.equal(piCreated.length, 5);
  });

  test('gift, wallet: five at once → five gifts and five wallet debits', async () => {
    walletDelay = 150;
    const h = loadOriginal('supabase/functions/create-gift-intent/index.ts');
    await Promise.all([0, 1, 2, 3, 4].map(() => call(h, giftBody({ pay_with_wallet: true }))));
    measure('gift, wallet, 5 concurrent', { gifts: gifts(), walletDebits: debits.size });
    assert.equal(gifts(), 5); assert.equal(debits.size, 5);
  });
});

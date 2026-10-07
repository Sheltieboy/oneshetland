/**
 * purchase-attempt-clients.node.test.ts — the mobile checkouts send one attempt id per deliberate purchase, and the server
 * functions treat it as an idempotency token only. No database, no network: source-level and pure.
 *
 * The behaviour of the server half is proved against a real database in purchase-attempt-idempotency.node.test.ts and
 * purchase-attempt-handlers.node.test.ts. The web half is pinned in oneshetland-web/tests/purchase-attempt-client.test.mjs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadModule, readRepo, REPO_ROOT } from './_support/load-source.ts';

const attempt = loadModule('lib/checkout-attempt.ts', { 'expo-crypto': { randomUUID } });

describe('the attempt holder', () => {
  test('one id per distinct purchase: reused for the same fingerprint, new for a different one, forgotten once spent', () => {
    const h = attempt.createAttemptHolder();
    const a = h.idFor('item-1|card');
    assert.ok(a.length >= 8 && a.length <= 100);
    assert.equal(h.idFor('item-1|card'), a);
    assert.notEqual(h.idFor('item-1|wallet'), a);
    const b = h.idFor('item-1|wallet'); h.spend();
    assert.notEqual(h.idFor('item-1|wallet'), b);
  });

  test('isFinalRefusal: a definitive 4xx ends the attempt; in_progress, 5xx and a dropped connection do not', () => {
    const e = (status?: number, code?: string) => Object.assign(new Error('x'), { status, code });
    for (const [s, c] of [[402, 'failed'], [409, 'checkout_expired'], [409, 'idempotency_conflict'], [409, 'sold_out'], [400, undefined]] as const)
      assert.equal(attempt.isFinalRefusal(e(s, c)), true, `${s} ${c}`);
    assert.equal(attempt.isFinalRefusal(e(409, 'in_progress')), false);
    for (const s of [500, 502, 503]) assert.equal(attempt.isFinalRefusal(e(s)), false);
    assert.equal(attempt.isFinalRefusal(new Error('Network request failed')), false);
    assert.equal(attempt.isFinalRefusal(null), false);
  });
});

describe('mobile checkouts', () => {
  test('the shop checkout sends the held id, never mints one per tap, and spends it on a final outcome', () => {
    const src = readRepo('app/product-checkout.tsx');
    assert.match(src, /client_request_id:\s*attempt\.idFor\(/);
    assert.match(src, /createAttemptHolder\(\)/);
    assert.doesNotMatch(src, /newCheckoutAttemptId\(/);
    assert.ok((src.match(/attempt\.spend\(\)/g) ?? []).length >= 4);
    const fp = src.slice(src.indexOf('client_request_id:'), src.indexOf('business_id: product!.business_id'));
    for (const part of ['business_id', 'product!.id', 'variant', 'qty', 'eff', 'address', 'postcode', 'regionSlug', 'note', 'payWith', 'useSaved'])
      assert.ok(fp.includes(part), `fingerprint is missing ${part}`);
    assert.match(src, /code === 'Canceled'\) return/, 'dismissing the card sheet leaves the attempt alive so paying again resumes it');
  });

  test('the product API requires the id in its type and keeps status + code on its errors', () => {
    const api = readRepo('lib/products-api.ts');
    assert.match(api, /client_request_id: string;/);
    assert.match(api, /e\.status = ctx\.status; e\.code = body\.code/);
    const create = api.slice(api.indexOf('export async function createProductOrder'), api.indexOf('The buyer\'s own view of an order'));
    assert.doesNotMatch(create, /newCheckoutAttemptId\(|randomUUID/, 'createProductOrder must not mint its own id');
  });

  test('the gift screen sends the held id with every request and spends it on a final outcome', () => {
    const src = readRepo('app/local-gift.tsx');
    assert.match(src, /client_request_id:\s*attempt\.idFor\(/);
    assert.match(src, /createAttemptHolder\(\)/);
    assert.doesNotMatch(src, /newCheckoutAttemptId\(/);
    assert.match(src, /isFinalRefusal\(e\)\) attempt\.spend\(\)/);
    assert.ok((src.match(/attempt\.spend\(\)/g) ?? []).length >= 3);
    assert.match(src, /Object\.assign\(new Error\(msg\), \{ status, code \}\)/);
  });
});

describe('the server treats the id as an idempotency token only', () => {
  const product = readRepo('supabase/functions/create-product-order-intent/index.ts');
  const giftFn = readRepo('supabase/functions/create-gift-intent/index.ts');
  const helper = readRepo('supabase/functions/_shared/purchase-attempt.ts');

  test('24/13. every Stripe idempotency key is built from a database-issued row id, and the client id appears in none', () => {
    assert.match(product, /const stripeKey = `product-order-\$\{orderId\}`/);
    assert.match(giftFn, /const stripeKey = `gift-\$\{giftId\}`/);
    for (const [name, src] of [['product', product], ['gift', giftFn]] as const) {
      const keys = [...src.matchAll(/(?:stripeKey|idempotencyKey)\s*[:=]\s*`([^`]*)`/g)].map((m) => m[1]);
      assert.ok(keys.length >= 1, name);
      for (const k of keys) assert.doesNotMatch(k, /clientRequestId|client_request_id|body\./, `${name}: ${k}`);
      assert.doesNotMatch(src, /Idempotency-Key.*body\.|headers\.get\(['"]idempotency/i, `${name} must not read a key from the request`);
    }
  });

  test('the id is validated (8-100 characters) before any database or Stripe work, in both functions', () => {
    for (const [name, src] of [['product', product], ['gift', giftFn]] as const) {
      const check = src.indexOf('attemptIdProblem(');
      assert.ok(check > 0, name);
      assert.ok(check < src.indexOf('.rpc('), `${name}: validated before the first rpc`);
      assert.ok(check < src.indexOf('claim_'), `${name}: validated before the claim`);
    }
    assert.match(helper, /raw\.length < 8 \|\| raw\.length > 100/);
  });

  test('there is no path that creates an order or gift row other than the atomic claim', () => {
    assert.doesNotMatch(product, /from\('product_orders'\)\s*\.insert|from\('product_order_items'\)\s*\.insert/);
    assert.doesNotMatch(giftFn, /from\('book_gifts'\)\s*\.insert/);
    assert.doesNotMatch(giftFn, /from\('book_gifts'\)\s*\.delete/, 'a failed gift is cancelled, never deleted: a concurrent repeat must not find its row gone');
    assert.match(product, /rpc\('claim_product_order'/); assert.match(giftFn, /rpc\('claim_gift_purchase'/);
  });

  test('no stock is reserved or released by JavaScript any more: it happens inside the claim / the status-guarded cancel', () => {
    assert.doesNotMatch(product, /rpc\('reserve_product_stock'|rpc\('release_product_stock'/);
    assert.match(product, /rpc\('cancel_pending_product_order'/);
    assert.match(product, /rpc\('commit_product_stock'/, 'committing the reservation on a wallet payment remains, behind the pending→paid flip');
    const flip = product.indexOf(".eq('status', 'pending').select('id').maybeSingle()");
    assert.ok(flip > 0 && flip < product.indexOf("rpc('commit_product_stock'"), 'stock is committed only by the request that flips pending → paid');
  });

  test('confirm-gift promotes the gift with an atomic claim and sends the email only if it won', () => {
    const confirm = readRepo('supabase/functions/confirm-gift/index.ts');
    assert.match(confirm, /\.not\('status', 'in', '\(sent,claimed,used\)'\)\s*\.select\('id'\)/);
    assert.ok(confirm.indexOf('promoted.length === 0') < confirm.indexOf('sendEmail('), 'the loser returns before sending');
  });

  test('the six new function names are defined by THIS migration only (no overload of an existing production function)', async () => {
    // Found the hard way: production already has claim_gift(p_code text), the RECIPIENT-side redemption RPC, executable by anon and
    // authenticated. A purchase-side function of the same name would have been created as an overload beside it.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(REPO_ROOT, 'supabase/migrations');
    const mine = '20261120010000_purchase_attempt_idempotency.sql';
    const names = ['claim_product_order', 'cancel_pending_product_order', 'claim_gift_purchase', 'cancel_pending_gift', 'claim_purchase_processing', 'release_purchase_processing'];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x !== mine)) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const n of names) assert.doesNotMatch(text, new RegExp(`function\\s+(public\\.)?${n}\\s*\\(`, 'i'), `${f} also defines ${n}`);
    }
    // and the recipient-side function keeps its own, different name
    assert.ok(readdirSync(dir).some((f) => /function\s+(public\.)?claim_gift\s*\(\s*p_code/i.test(readFileSync(join(dir, f), 'utf8'))), 'the recipient-side claim_gift(p_code) is still defined elsewhere');
    assert.doesNotMatch(readFileSync(join(dir, mine), 'utf8'), /function public\.claim_gift\(/);
  });

  test('the migration and the isolated runner include the new suites', () => {
    const runner = readRepo('scripts/isolated-pg.mjs');
    for (const s of ['purchase-attempt-idempotency', 'purchase-attempt-handlers', 'purchase-attempt-baseline']) assert.ok(runner.includes(s), s);
  });
});

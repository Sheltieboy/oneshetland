/**
 * buyer-order-history.node.test.ts — "I cannot see what I had bought."
 *
 * WHAT WAS WRONG
 *
 * Nothing in the data layer. Both clients already had a buyer order screen —
 * web app/account/orders/page.tsx and mobile app/my-orders.tsx — and the
 * "buyer reads own orders" RLS policy already scoped them correctly. The
 * screens were simply unreachable:
 *
 *   · web  — /account/orders was linked from ONE place, the basket's
 *            post-payment "Track your order" button. That screen is gone the
 *            moment the basket empties, so the route survived only as a URL
 *            the customer would have to have memorised. The account overview,
 *            which is the site's entire account navigation, never listed it.
 *   · app  — /my-orders was linked from the checkout success screen and from a
 *            push-notification deep link. Neither is navigation. The Account
 *            screen never offered it.
 *
 * So a buyer who completed a marketplace purchase and closed the tab had no
 * route back to it. That is what the user hit after paying £185.
 *
 * Two smaller gaps came out of the same read:
 *
 *   · the mobile buyer query was `select('*')`, which shipped
 *     payment_intent_id and commission_pence to the device. The TypeScript
 *     type never declared them, so nothing rendered them — but they were on
 *     the wire, and a buyer's Stripe PaymentIntent id is not the buyer's
 *     business. It is now an explicit column whitelist.
 *   · neither list showed the fulfilment method or a short order reference,
 *     and mobile did not show the seller at all, so "what's happening with my
 *     order?" was only half answerable.
 *
 * WHAT IS ASSERTED
 *   · the database, not the client, decides which orders a buyer can read
 *   · a buyer cannot reach another buyer's orders, and the seller's own
 *     order lane is untouched
 *   · both lists carry product, variant, seller, quantity, amount, fulfilment,
 *     status and a short reference
 *   · both clients are reachable from their account navigation
 *   · no Stripe or Connect identifier is selected or rendered on either
 *   · orders already in the table appear — nothing is gated on a new column
 *   · tracked stock decrements once, and a replayed webhook cannot decrement
 *     it twice
 *
 * The web repo has no component-test harness and the app has no render
 * harness, so these are structural checks of the same kind this suite already
 * makes against both repos. Behaviour was verified separately against the live
 * site and the production order rows.
 *
 * SAFETY
 * Source inspection only. No network, no database, no payment.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..', '..');
const WEB_ROOT = join(HERE, '..', '..', '..', 'oneshetland-web');

const app = (p: string) => readFileSync(join(APP_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const commerce = app('supabase/migrations/20260801130000_commerce_engine.sql');
const stockRpcs = app('supabase/migrations/20260801140000_product_stock_rpcs.sql');
const fulfilment = app('supabase/functions/_shared/fulfilment.ts');
const productsApi = app('lib/products-api.ts');
const mobileOrders = app('app/my-orders.tsx');
const mobileAccount = app('app/account.tsx');
const webOrders = web('app/account/orders/page.tsx');
const webAccount = web('app/account/page.tsx');

/** Collapse whitespace so an assertion is about SQL, not about line breaks. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

// ── 1. The boundary is the database ────────────────────────────────────────

describe('a buyer reads their own orders and nobody else’s', () => {
  test('the select policy is bound to auth.uid(), not to a client filter', () => {
    assert.match(
      flat(commerce),
      /create policy "buyer reads own orders" on public\.product_orders for select using \(buyer_id = auth\.uid\(\)\)/,
    );
  });

  test('order lines inherit that boundary rather than defining a looser one', () => {
    const policy = flat(commerce).match(
      /create policy "order items follow order".*?\)\)\);/,
    )?.[0];
    assert.ok(policy, 'order items policy not found');
    assert.match(policy, /o\.buyer_id = auth\.uid\(\)/);
    // The only other way in is owning the selling business.
    assert.match(policy, /b\.owner_id = auth\.uid\(\)/);
  });

  test('no policy on the order tables grants a blanket read', () => {
    for (const table of ['product_orders', 'product_order_items']) {
      const policies = flat(commerce).match(
        new RegExp(`create policy "[^"]+" on public\\.${table} for select using \\([^;]*`, 'g'),
      ) ?? [];
      assert.ok(policies.length > 0, `no select policy found on ${table}`);
      for (const p of policies) {
        assert.ok(
          p.includes('auth.uid()'),
          `select policy on ${table} does not mention auth.uid(): ${p}`,
        );
        assert.ok(!/using \(true\)/.test(p), `blanket select policy on ${table}`);
      }
    }
  });

  test('the policy still evaluates for a signed-in buyer who owns no business', () => {
    // Both select policies on product_orders are ORed, so the "business reads
    // its orders" one is evaluated for EVERY authenticated caller, buyer or
    // not — and it reads local_businesses.owner_id as the caller. Step 8's
    // column whitelist withheld owner_id from anon, which is why an anonymous
    // read of this table returns 42501 rather than an empty list. That is
    // correct (anon has no orders) but it makes the buyer screen depend on
    // owner_id still being granted to `authenticated`. Verified live: the full
    // buyer query returns 200 for a signed-in non-owner.
    const grants = app('supabase/migrations/20260820230000_business_column_grants.sql');
    assert.match(grants, /grant select \(owner_id\) on public\.local_businesses to authenticated/);
    assert.ok(
      !/grant select \(owner_id\) on public\.local_businesses to anon/.test(grants),
      'owner_id must never be granted to anon',
    );
    assert.match(flat(commerce), /b\.owner_id = auth\.uid\(\)\)\); drop policy if exists "business updates its orders"/);
  });

  test('neither client is trusted to do the scoping on its own', () => {
    // Mobile sends no buyer filter at all — RLS is the whole boundary.
    // Web adds .eq("buyer_id", ...) as belt-and-braces on top of the policy.
    assert.match(webOrders, /\.eq\("buyer_id", account\.id\)/);
    assert.match(productsApi, /RLS policy/);
  });
});

// ── 2. The seller lane is untouched ────────────────────────────────────────

describe('the seller’s own order workflow still works', () => {
  test('the business read policy survives', () => {
    assert.match(
      flat(commerce),
      /create policy "business reads its orders" on public\.product_orders for select using/,
    );
  });

  test('the seller query is still its own call and still business-scoped', () => {
    const fn = productsApi.match(/export async function fetchBusinessOrders[\s\S]*?\n}/)?.[0];
    assert.ok(fn, 'fetchBusinessOrders not found');
    assert.match(fn, /\.eq\('business_id', businessId\)/);
  });

  test('buyer access does not depend on owning a business', () => {
    const fn = productsApi.match(/export async function fetchMyOrders[\s\S]*?\n}/)?.[0];
    assert.ok(fn, 'fetchMyOrders not found');
    assert.ok(!/business_id.*eq|owner_id/.test(fn), 'buyer query is business-gated');
  });
});

// ── 3. What the buyer is actually shown ────────────────────────────────────

describe('the list answers "what did I buy?"', () => {
  const cases: [string, RegExp][] = [
    ['the product title', /it\.title/],
    ['the variant', /it\.variant_name/],
    ['the quantity', /it\.qty/],
  ];

  for (const [what, re] of cases) {
    test(`${what} is rendered on web and app`, () => {
      assert.match(webOrders, re, `web is missing ${what}`);
      assert.match(mobileOrders, re, `app is missing ${what}`);
    });
  }

  test('the amount paid is rendered on both', () => {
    assert.match(webOrders, /gbp\(o\.total_pence\)/);
    assert.match(mobileOrders, /formatPence\(o\.total_pence\)/);
  });

  test('the seller is named on both', () => {
    assert.match(webOrders, /o\.business\.name/);
    assert.match(mobileOrders, /o\.business\?\.name/);
    // and the app actually asks for it
    assert.match(productsApi, /business:local_businesses\(id, name, slug\)/);
  });

  test('the purchase date is rendered on both', () => {
    assert.match(webOrders, /o\.paid_at \?\? o\.created_at/);
    assert.match(mobileOrders, /o\.paid_at \?\? o\.created_at/);
  });
});

describe('the list answers "what’s happening with my order?"', () => {
  test('status is mapped into buyer wording, not shown raw', () => {
    assert.match(webOrders, /BUYER_STATUS\[o\.status\]/);
    assert.match(mobileOrders, /BUYER_STATUS_LABEL\[o\.status\]/);
  });

  test('every buyer-visible status the model can reach has wording', () => {
    // The lifecycle the CHECK constraint allows, minus the two the buyer
    // lists deliberately filter out (pending, expired).
    const allowed = flat(commerce)
      .match(/status text not null default 'pending' check \(status = any \(array\[([^\]]*)\]/)?.[1];
    assert.ok(allowed, 'status CHECK not found');
    const statuses = [...allowed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
      .filter((s) => s !== 'pending' && s !== 'expired');
    assert.ok(statuses.length >= 8, `expected the full lifecycle, got ${statuses.join(',')}`);
    const labels = productsApi.match(/BUYER_STATUS_LABEL[\s\S]*?\n};/)?.[0] ?? '';
    for (const s of statuses) {
      assert.ok(labels.includes(`${s}:`), `no buyer wording for status "${s}"`);
    }
  });

  test('no invented status is offered that a seller cannot set', () => {
    const allowed = flat(commerce)
      .match(/status text not null default 'pending' check \(status = any \(array\[([^\]]*)\]/)?.[1] ?? '';
    const labels = productsApi.match(/BUYER_STATUS_LABEL: Record<string, string> = \{([\s\S]*?)\n};/)?.[1] ?? '';
    for (const key of [...labels.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1])) {
      assert.ok(allowed.includes(`'${key}'`), `buyer label "${key}" is not a real order status`);
    }
  });

  test('the fulfilment method is spelled out on both', () => {
    assert.match(webOrders, /FULFILMENT_LABEL\[o\.fulfilment\]/);
    assert.match(mobileOrders, /FULFILMENT_LABEL\[o\.fulfilment\]/);
    for (const src of [webOrders, productsApi]) {
      assert.match(src, /collect:/);
      assert.match(src, /post:/);
      assert.match(src, /fetch:/);
    }
  });

  test('a short reference is shown, and it is not the raw row id', () => {
    assert.match(webOrders, /Ref \{orderRef\(o\.id\)\}/);
    assert.match(mobileOrders, /orderRef\(o\.id\)/);
    for (const src of [webOrders, productsApi]) {
      assert.match(src, /id\.slice\(0, 8\)\.toUpperCase\(\)/);
    }
  });
});

// ── 4. Reachability — the actual defect ────────────────────────────────────

describe('the buyer can find the screen without knowing a URL', () => {
  test('the web account navigation lists it', () => {
    const cards = webAccount.match(/const cards = \[[\s\S]*?\n  \];/)?.[0];
    assert.ok(cards, 'account cards array not found');
    assert.match(cards, /href: "\/account\/orders"/);
  });

  test('the app Account screen lists it', () => {
    assert.match(mobileAccount, /router\.push\('\/my-orders'\)/);
    assert.match(mobileAccount, /label="Your shop orders"/);
  });

  test('the post-checkout links survive as well, rather than being the only way in', () => {
    assert.match(web('app/basket/page.tsx'), /href="\/account\/orders"/);
    assert.match(app('app/product-checkout.tsx'), /'\/my-orders'/);
  });
});

// ── 5. Nothing sensitive rides along ───────────────────────────────────────

describe('no payment plumbing reaches the buyer', () => {
  test('the mobile buyer query names its columns instead of select(*)', () => {
    const fn = productsApi.match(/export async function fetchMyOrders[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(!fn.includes("'*,"), 'buyer query still uses select(*)');
    assert.match(productsApi, /const BUYER_ORDER_COLUMNS =/);
  });

  test('the whitelist excludes every Stripe and commission column', () => {
    const cols = productsApi.match(/const BUYER_ORDER_COLUMNS =\s*'([^']*)'/)?.[1];
    assert.ok(cols, 'BUYER_ORDER_COLUMNS not found');
    for (const banned of ['payment_intent_id', 'commission_pence', 'stripe']) {
      assert.ok(!cols.includes(banned), `buyer column whitelist leaks ${banned}`);
    }
  });

  test('the web query names its columns too, and names none of those', () => {
    const sel = webOrders.match(/\.select\(\s*"([^"]*)"\s*\)/)?.[1];
    assert.ok(sel, 'web select not found');
    for (const banned of ['payment_intent_id', 'commission_pence', 'stripe']) {
      assert.ok(!sel.includes(banned), `web buyer select leaks ${banned}`);
    }
  });

  test('neither screen renders a Stripe or Connect identifier', () => {
    for (const [name, src] of [['web', webOrders], ['app', mobileOrders]] as const) {
      for (const banned of ['payment_intent', 'stripe_account', 'stripe_customer', 'acct_', 'pi_']) {
        assert.ok(!src.includes(banned), `${name} order screen mentions ${banned}`);
      }
    }
  });

  test('the seller’s business id is not printed at the buyer', () => {
    // The web list links by slug, falling back to the public business id that
    // the directory already uses in its own URLs.
    assert.match(webOrders, /o\.business\.slug \|\| o\.business\.id/);
    assert.ok(!mobileOrders.includes('business_id'), 'app prints a raw business id');
  });
});

// ── 6. Orders that already exist ───────────────────────────────────────────

describe('history is history, not "orders placed after the fix"', () => {
  test('neither query has a date floor or a new-column gate', () => {
    for (const [name, fn] of [
      ['app', productsApi.match(/export async function fetchMyOrders[\s\S]*?\n}/)?.[0] ?? ''],
      ['web', webOrders.match(/\.from\("product_orders"\)[\s\S]*?\.limit\(50\);/)?.[0] ?? ''],
    ] as const) {
      assert.ok(fn.length > 0, `${name} query not found`);
      assert.ok(!/created_at.*gte|gte.*created_at/.test(fn), `${name} query has a date floor`);
    }
  });

  test('the only rows held back are the ones that were never bought', () => {
    for (const src of [productsApi, webOrders]) {
      assert.match(src, /'pending'|"pending"/);
      assert.match(src, /'expired'|"expired"/);
    }
    // …and they are excluded, not included.
    assert.match(productsApi, /\.neq\('status', 'pending'\)\.neq\('status', 'expired'\)/);
    assert.match(webOrders, /\.neq\("status", "pending"\)/);
    assert.match(webOrders, /\.neq\("status", "expired"\)/);
  });

  test('the embedded seller is optional, so a missing join cannot hide an order', () => {
    assert.match(productsApi, /business: \{ id: string; name: string; slug: string \| null \} \| null;/);
    assert.match(mobileOrders, /o\.business\?\.name \? /);
    assert.match(webOrders, /o\.business \? /);
  });
});

// ── 7. Stock moves exactly once ────────────────────────────────────────────

describe('a paid order commits its stock once and only once', () => {
  test('only tracked products decrement — made-to-order keeps a null stock', () => {
    const fn = flat(stockRpcs).match(/create or replace function public\.commit_product_stock[\s\S]*?\$\$;/)?.[0];
    assert.ok(fn, 'commit_product_stock not found');
    assert.match(fn, /stock = case when stock_mode = 'tracked' and stock is not null then greatest\(0, stock - p_qty\) else stock end/);
  });

  test('the commit is reached once per line, from the fulfilment path', () => {
    const fn = fulfilment.match(/export async function fulfilProductOrder[\s\S]*?\n}/)?.[0];
    assert.ok(fn, 'fulfilProductOrder not found');
    assert.equal((fn.match(/commit_product_stock/g) ?? []).length, 1);
  });

  test('a replayed webhook cannot decrement a second time', () => {
    const fn = fulfilment.match(/export async function fulfilProductOrder[\s\S]*?\n}/)?.[0] ?? '';
    // The pending -> paid flip is the guard: the second caller matches no row.
    assert.match(flat(fn), /\.eq\('id', orderId\) \.eq\('status', 'pending'\)/);
    const guardAt = fn.indexOf('if (!flipped) return');
    const commitAt = fn.indexOf('commit_product_stock');
    assert.ok(guardAt > -1, 'no early return on a non-pending order');
    assert.ok(guardAt < commitAt, 'stock is committed before the idempotency guard');
  });

  test('the RPCs stay off the client roles', () => {
    for (const rpc of ['reserve_product_stock', 'release_product_stock', 'commit_product_stock']) {
      assert.match(
        stockRpcs,
        new RegExp(`revoke all on function public\\.${rpc}\\(uuid, uuid, int\\) from public, anon, authenticated;`),
      );
    }
  });
});

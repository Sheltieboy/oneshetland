/**
 * boost-history.node.test.ts — the £7 a business paid stops vanishing.
 *
 * local_boost_purchases had been written by the checkout and the webhook since
 * the product existed, and read by nothing. A business paid for a boost and the
 * payment left no trace it could point at: the billing screen showed only
 * "Boost expires 2 September", which is the LAST boost's expiry and says
 * nothing about what was bought or paid. A boost is a one-off PaymentIntent,
 * not a subscription, so it also appears in no Stripe invoice and would never
 * have shown up in the invoice history below it.
 *
 * No columns were added. The row already held the duration, the amount, when it
 * was bought and the expiry it granted; only the reading of it was missing.
 *
 * SAFETY
 * Source-level plus read-only assertions on the real production purchase. No
 * boost bought, extended or refunded; the £7 row is untouched.
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

const billing   = code(web('components/business/BillingManager.tsx'));
const bizClient = code(web('lib/business-client.ts'));
const adminBoost = code(web('components/admin/BoostPurchases.tsx'));
const adminData = code(web('lib/admin-data.server.ts'));
const adminPage = code(web('app/admin/payments/page.tsx'));
const boostFn   = code(read('supabase/functions/local-boost-checkout/index.ts'));
const webhook   = code(read('supabase/functions/stripe-webhook/index.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── 1. the real purchase ─────────────────────────────────────────────────── */

describe('the £7 boost bought on 26 August is exactly one of everything', () => {
  test('one purchase row, one week, 700p, succeeded', () => {
    const r = runSql(`select count(*)::text c,
                             coalesce(max(weeks)::text,'-') weeks,
                             coalesce(max(amount_pence)::text,'-') amount,
                             coalesce(max(status),'-') status
                        from public.local_boost_purchases;`)[0];
    assert.equal(r.c, '1', 'the number of boost purchases changed');
    assert.equal(r.weeks, '1');
    assert.equal(r.amount, '700');
    assert.equal(r.status, 'succeeded');
  });

  test('one payment intent — a second could not share the row', () => {
    const r = runSql(`select count(distinct stripe_payment_intent_id)::text c,
                             case when exists (select 1 from pg_indexes
                                    where tablename='local_boost_purchases'
                                      and indexdef ilike '%unique%stripe_payment_intent_id%')
                                  then 'unique' else 'MISSING' end idx
                        from public.local_boost_purchases;`)[0];
    assert.equal(r.c, '1');
    assert.equal(r.idx, 'unique');
  });

  test('exactly one seven-day grant, and the business agrees with the receipt', () => {
    const r = runSql(`select p.expires_at = b.subscription_until as matches,
                             b.subscription_tier,
                             (p.expires_at between p.created_at + interval '6 days 23 hours'
                                              and p.created_at + interval '7 days 1 hour') as one_week,
                             (b.stripe_subscription_id is null) as no_subscription
                        from public.local_boost_purchases p
                        join public.local_businesses b on b.id = p.business_id;`)[0];
    assert.equal(String(r.matches), 'true', 'the granted expiry differs from the receipt');
    assert.equal(r.subscription_tier, 'pro');
    assert.equal(String(r.one_week), 'true', 'the grant was not one week');
    assert.equal(String(r.no_subscription), 'true', 'a recurring subscription was created');
  });
});

/* ── 2. the owner can see it ──────────────────────────────────────────────── */

describe('a business can see what it paid for', () => {
  test('history is read from the purchase rows, not from the current expiry', () => {
    assert.match(bizClient, /from\("local_boost_purchases"\)/);
    assert.match(bizClient, /\.eq\("business_id", businessId\)/);
    assert.match(billing, /getBoostHistory\(b\.id\)/);
  });

  test('only purchases that were actually paid for are shown', () => {
    // A row sits at 'pending' when a checkout is opened and abandoned. Showing
    // that as history would present something never charged as a purchase.
    assert.match(bizClient, /\.eq\("status", "succeeded"\)/);
  });

  test('each row states the duration, the date, the amount and the expiry', () => {
    assert.match(billing, /\{p\.weeks\} week\{p\.weeks > 1 \? "s" : ""\} of Pro/);
    assert.match(billing, /\{fmtDay\(p\.created_at\)\} · \{gbp\(p\.amount_pence\)\} · Paid by card/);
    assert.match(billing, /Pro until \{fmtDay\(p\.expires_at\)\}/);
  });

  test('a purchase is judged Active by its OWN expiry, not the business tier', () => {
    // Reading the current tier would mark an old, spent boost "Active" whenever
    // a newer one happened to be running. Refunds added a second reason a
    // purchase can stop being active, so the expiry test now sits behind one —
    // but it is still the purchase's OWN expiry that decides, never the
    // business's tier.
    assert.match(billing, /new Date\(p\.expires_at\) > new Date\(\)/);
    assert.ok(!/active = .*subscription_(tier|until)/.test(billing),
      'the pill must not read the business tier');
    assert.match(billing, /label: "Active"/);
    assert.match(billing, /label: "Expired"/);
  });

  test('it sits inside the plan screen, not a new dashboard', () => {
    assert.match(billing, /Boost history/);
    assert.ok(billing.indexOf('Boost history') < billing.indexOf('<InvoiceHistory'));
  });

  test('no payment identifier is rendered', () => {
    assert.doesNotMatch(billing, /stripe_payment_intent_id|payment_intent|stripe_customer_id|client_request_id/);
    assert.doesNotMatch(bizClient, /select\("id, weeks, amount_pence, expires_at, created_at, status"\)[\s\S]{0,40}payment_intent/);
  });
});

/* ── 3. platform admin ────────────────────────────────────────────────────── */

describe('OneShetland can see boosts for support', () => {
  test('the existing payments screen gained a boosts section', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'components/admin/BoostPurchases.tsx')));
    assert.match(adminPage, /getBoostPurchases/);
    assert.match(adminPage, /<BoostPurchases purchases=\{boosts\} \/>/);
  });

  test('it names the business, the buyer, the duration and the amount', () => {
    for (const f of ['businessName', 'ownerName', 'weeks', 'amount_pence', 'created_at', 'expires_at']) {
      assert.match(adminBoost, new RegExp(f), `${f} is not shown`);
    }
  });

  test('the refund control is the admin\'s alone', () => {
    // This test used to assert NO refund control existed anywhere, which was
    // right while a refund could not revoke anything. Paygate 9 made a refund
    // replay entitlement, so the control now exists — for the platform admin
    // only. The half that still matters is that the OWNER never gets one.
    assert.match(adminBoost, /Refund…/, 'the admin lost the refund control');
    assert.ok(!/Refund…/.test(billing), 'a refund control appeared on the owner screen');
  });

  test('no Stripe identifier reaches the admin screen either', () => {
    assert.doesNotMatch(adminBoost, /payment_intent|stripe_/);
    assert.doesNotMatch(adminData.slice(adminData.indexOf('getBoostPurchases')), /stripe_payment_intent_id/);
  });
});

/* ── 4. who may read it ───────────────────────────────────────────────────── */

describe('boost history is visible to the buyer and to OneShetland, nobody else', () => {
  test('the policies say exactly that', () => {
    const r = runSql(`select string_agg(policyname || '=' || qual, ' | ' order by policyname) v
                        from pg_policies where tablename = 'local_boost_purchases';`)[0];
    assert.match(String(r.v), /owner_id = auth\.uid\(\)/);
    assert.match(String(r.v), /is_admin\(\)/);
  });

  test('no client may write a boost purchase', () => {
    const r = runSql(`select case when has_table_privilege('authenticated','public.local_boost_purchases','INSERT')
                                or has_table_privilege('authenticated','public.local_boost_purchases','UPDATE')
                                or has_table_privilege('authenticated','public.local_boost_purchases','DELETE')
                           then 'WRITABLE' else 'read only' end v;`)[0];
    assert.equal(r.v, 'read only');
    const p = runSql(`select coalesce(string_agg(cmd, ','),'none') v from pg_policies
                       where tablename='local_boost_purchases' and cmd <> 'SELECT';`)[0];
    assert.equal(p.v, 'none', 'a write policy appeared on the purchase ledger');
  });
});

/* ── 5. nothing about the purchase moved ──────────────────────────────────── */

describe('the boost payment path is unchanged', () => {
  test('attempt identity and both Stripe keys remain', () => {
    assert.match(boostFn, /client_request_id must be 8-100 characters/);
    assert.match(boostFn, /idempotencyKey: `local-boost-\$\{user\.id\}-\$\{business_id\}-\$\{weeks\}-\$\{client_request_id\}`/);
    assert.match(boostFn, /idempotencyKey: `local-boost-form-\$\{user\.id\}-\$\{business_id\}-\$\{weeks\}-\$\{client_request_id\}`/);
  });

  test('a failed saved card is still an error, not a card form', () => {
    assert.match(boostFn, /saved_card_failed: true/);
  });

  test('price authority and the one eligibility rule remain', () => {
    assert.match(boostFn, /`boost\.price\.\$\{weeks\}_week_pence`/);
    assert.equal((boostFn.match(/boostEligibility\(/g) ?? []).length, 2);
  });

  test('the webhook still claims before it grants', () => {
    assert.match(webhook, /\.update\(\{ status: 'succeeded' \}\)[\s\S]{0,120}\.neq\('status', 'succeeded'\)/);
  });

  test('an active boost can still be extended from the screen', () => {
    assert.match(billing, /\{boostPreview\?\.boost_eligible && \(/);
    assert.match(boostFn, /reason: 'extending_boost'/);
  });
});

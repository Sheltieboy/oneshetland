/**
 * products-tier-entitlement.node.test.ts — selling is Premium, below the UI.
 *
 * Products were Premium by redirect on one page and a button the app declined
 * to draw. The public read policy asked only whether the row was active and the
 * business was active; create-product-order-intent asked the same. A business
 * could lapse and keep selling.
 *
 * Three boundaries, in the three places a product reaches a customer:
 * exposure (the read policy, so every loader is covered at once), activation
 * (a product may only BE active while entitled), and the purchase itself.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const ORDER_FN = readFileSync(join(REPO_ROOT, 'supabase/functions/create-product-order-intent/index.ts'), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'd1d10001-1111-1111-1111-111111111111';
const CUST  = 'd1d10009-9999-9999-9999-999999999999';
const B = {
  premium: 'd1d10002-2222-2222-2222-222222222222',
  pro:     'd1d10003-3333-3333-3333-333333333333',
  free:    'd1d10004-4444-4444-4444-444444444444',
  lapsing: 'd1d10005-5555-5555-5555-555555555555',
  premNull:'d1d10006-6666-6666-6666-666666666666',
};
const LIVE  = 'd1d1000a-0000-0000-0000-00000000000a';
const DRAFT = 'd1d1000b-0000-0000-0000-00000000000b';

const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','pr-o@probe.invalid'),('${CUST}','pr-c@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active) values
    ('${B.premium}','${OWNER}','PR PREM','other','P',true),
    ('${B.pro}','${OWNER}','PR PRO','other','P',true),
    ('${B.free}','${OWNER}','PR FREE','other','P',true),
    ('${B.lapsing}','${OWNER}','PR LAPSING','other','P',true),
    ('${B.premNull}','${OWNER}','PR PREM NULL','other','P',true);
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days'
    where id in ('${B.premium}','${B.lapsing}');
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '10 days' where id='${B.pro}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null where id='${B.premNull}';
  insert into public.products (id,business_id,title,price_pence,is_active) values
    ('${LIVE}','${B.lapsing}','LIVE ONE',500,true);
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;
const asOwnerRole = `reset role; select set_config('request.jwt.claims','',true);`;
const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;`;
const acceptAll = `
  select public.record_commercial_terms_acceptance('${B.premium}'::uuid);
  select public.record_commercial_terms_acceptance('${B.pro}'::uuid);
  select public.record_commercial_terms_acceptance('${B.free}'::uuid);
  select public.record_commercial_terms_acceptance('${B.lapsing}'::uuid);
  select public.record_commercial_terms_acceptance('${B.premNull}'::uuid);`;
const attempt = (step: string, stmt: string) => `
do $p$ begin ${stmt};
  insert into r values ('${step}','ALLOWED');
exception when others then insert into r values ('${step}','refused'); end $p$;`;
const END = `reset role; select * from r order by step; rollback;`;
const outcome = (rows: Record<string, unknown>[], step: string) =>
  rows.find((r) => r.step === step)?.outcome;

const newProduct = (biz: string, active: boolean, id?: string) =>
  `insert into public.products (${id ? 'id,' : ''}business_id,title,price_pence,is_active)
   values (${id ? `'${id}',` : ''}'${biz}','P',500,${active})`;

/* ── 1. A product may only be active while the business is entitled ─────── */

describe('publishing needs Premium', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
    attempt('premium creates active', newProduct(B.premium, true)) +
    attempt('pro creates active',     newProduct(B.pro, true)) +
    attempt('free creates active',    newProduct(B.free, true)) +
    attempt('premium-null creates active', newProduct(B.premNull, true)) +
    attempt('pro creates a draft',    newProduct(B.pro, false, DRAFT)) +
    attempt('pro edits the draft',    `update public.products set price_pence=600 where id='${DRAFT}'`) +
    attempt('pro publishes the draft',`update public.products set is_active=true where id='${DRAFT}'`) +
    END);

  test('effective Premium may publish', () => {
    assert.equal(outcome(rows, 'premium creates active'), 'ALLOWED');
  });

  test('Pro may not — Bookings is Pro, selling is not', () => {
    assert.equal(outcome(rows, 'pro creates active'), 'refused');
  });

  test('Free may not', () => {
    assert.equal(outcome(rows, 'free creates active'), 'refused');
  });

  test('a paid tier with no end date may not', () => {
    assert.equal(outcome(rows, 'premium-null creates active'), 'refused');
  });

  test('but a DRAFT is allowed below Premium — setup before upgrade', () => {
    assert.equal(outcome(rows, 'pro creates a draft'), 'ALLOWED');
    assert.equal(outcome(rows, 'pro edits the draft'), 'ALLOWED',
      'the later draft flow depends on this staying open');
  });

  test('publishing that draft is where the plan is asked for', () => {
    assert.equal(outcome(rows, 'pro publishes the draft'), 'refused');
  });
});

/* ── 2. Expiry, withdrawal, and what must survive ───────────────────────── */

describe('a business that lapses keeps its shop but stops selling', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
    asOwnerRole + `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';` +
    asUser(OWNER) +
    attempt('edit an active product', `update public.products set price_pence=999 where id='${LIVE}'`) +
    attempt('withdraw it',            `update public.products set is_active=false where id='${LIVE}'`) +
    attempt('reactivate it',          `update public.products set is_active=true where id='${LIVE}'`) +
    asOwnerRole +
    `insert into r select 'product still stored', count(*)::text from public.products where id='${LIVE}';
     update public.local_businesses set subscription_until=now()+interval '5 days' where id='${B.lapsing}';` +
    asUser(OWNER) +
    attempt('reactivate once Premium returns', `update public.products set is_active=true where id='${LIVE}'`) +
    END);

  test('an under-tier owner may not improve a publicly sellable product', () => {
    assert.equal(outcome(rows, 'edit an active product'), 'refused');
  });

  test('but may always withdraw it', () => {
    assert.equal(outcome(rows, 'withdraw it'), 'ALLOWED',
      'never trap an owner with something publicly for sale');
  });

  test('and may not put it back while under-tier', () => {
    assert.equal(outcome(rows, 'reactivate it'), 'refused');
  });

  test('the configuration is never destroyed', () => {
    assert.equal(outcome(rows, 'product still stored'), '1');
  });

  test('regaining Premium allows publishing again', () => {
    assert.equal(outcome(rows, 'reactivate once Premium returns'), 'ALLOWED');
  });

  test('withdrawal does not require current terms either', () => {
    // W3I's carve-out, unchanged: this owner never accepted for this business.
    const solo = sql(FIXTURE + asUser(OWNER) +
      attempt('withdraw without terms', `update public.products set is_active=false where id='${LIVE}'`) + END);
    assert.equal(outcome(solo, 'withdraw without terms'), 'ALLOWED');
  });
});

/* ── 3. Exposure: one policy, every reader ──────────────────────────────── */

describe('an unentitled shop is not on display', () => {
  const rows = sql(FIXTURE +
    asOwnerRole + `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';
      insert into public.products (business_id,title,price_pence,is_active) values ('${B.premium}','SOLD HERE',500,true);` +
    `set local role anon;
     insert into r select 'anon sees the lapsed product', count(*)::text from public.products where id='${LIVE}';
     insert into r select 'anon sees the entitled product', count(*)::text from public.products where business_id='${B.premium}' and is_active;` +
    asUser(OWNER) +
    `insert into r select 'owner still sees their own', count(*)::text from public.products where id='${LIVE}';` +
    END);

  test('a signed-out customer cannot see it — direct link, search or shelf', () => {
    assert.equal(outcome(rows, 'anon sees the lapsed product'), '0');
  });

  test('an entitled shop is unaffected', () => {
    assert.equal(outcome(rows, 'anon sees the entitled product'), '1');
  });

  test('the owner still sees their own product', () => {
    assert.equal(outcome(rows, 'owner still sees their own'), '1',
      'hidden from customers is not hidden from the person who owns it');
  });

  test('the filter lives in the read policy, so every loader inherits it', () => {
    // Six loaders read products on the website alone — shop browse, related,
    // the product page, the home shelf, the visiting planner, the OG image —
    // plus the app. Filtering in each would be six places to forget.
    const [row] = sql(`
      select pg_get_expr(p.polqual, p.polrelid) as expr
        from pg_policy p join pg_class c on c.oid=p.polrelid
       where c.relname='products' and p.polname='public reads live products';`);
    assert.match(String(row.expr), /business_meets_tier/);
    assert.match(String(row.expr), /is_active/);
    assert.match(String(row.expr), /is_business_active/);
  });

  test('signed-out readers can evaluate it', () => {
    const [row] = sql(`
      select has_function_privilege('anon','public.business_meets_tier(uuid,text)','execute') as anon;`);
    assert.equal(row.anon, true, 'the public read policy is evaluated as anon');
  });
});

/* ── 4. The purchase backstop ───────────────────────────────────────────── */

describe('the order refuses before Stripe', () => {
  test('the check sits after the business loads and before any side effect', () => {
    const check = ORDER_FN.indexOf("p_required_tier: 'premium'");
    const bizLoad = ORDER_FN.indexOf("if (!biz?.is_active)");
    const orderInsert = ORDER_FN.indexOf("from('product_orders').insert");
    const stripe = ORDER_FN.indexOf('await createPaymentIntent(');
    assert.ok(check > bizLoad, 'the business must be loaded first');
    assert.ok(orderInsert > check, 'no order row before the check');
    assert.ok(stripe > check, 'no Stripe call before the check');
  });

  test('it asks the shared predicate, not the configured tier', () => {
    assert.match(ORDER_FN, /rpc\('business_meets_tier'/);
    assert.ok(!/subscription_tier/.test(ORDER_FN), 'no second tier formula in the function');
  });

  test('an unreadable answer refuses rather than falling through', () => {
    assert.match(ORDER_FN, /if \(tierErr \|\| maySell !== true\)/);
  });

  test('the customer is told the item is unavailable, not that a shop has not paid', () => {
    const at = ORDER_FN.indexOf("p_required_tier: 'premium'");
    const block = ORDER_FN.slice(at, at + 400);
    assert.match(block, /An item in your basket is no longer available/);
    for (const leak of ['Premium', 'subscription', 'plan', 'tier', 'billing']) {
      assert.ok(!new RegExp(`error: '[^']*${leak}`, 'i').test(block), `must not leak: ${leak}`);
    }
  });

  test('the decision itself is right for both cases', () => {
    const rows = sql(FIXTURE +
      asOwnerRole + `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';
        insert into r select 'lapsed may sell', public.business_meets_tier('${B.lapsing}','premium')::text;
        insert into r select 'entitled may sell', public.business_meets_tier('${B.premium}','premium')::text;` +
      END);
    assert.equal(outcome(rows, 'lapsed may sell'), 'false');
    assert.equal(outcome(rows, 'entitled may sell'), 'true');
  });
});

/* ── 5. Bypass, isolation and composition ───────────────────────────────── */

describe('no way round, and nothing else disturbed', () => {
  test('direct PostgREST activation cannot bypass — the client is not the boundary', () => {
    // The same call a deep-linked mobile screen would make.
    const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
      attempt('direct activate', newProduct(B.free, true)) + END);
    assert.equal(outcome(rows, 'direct activate'), 'refused');
  });

  test("a stranger cannot touch another business's product", () => {
    const rows = sql(FIXTURE + asUser(CUST) +
      attempt('stranger edits', `update public.products set price_pence=1 where id='${LIVE}'`) +
      asOwnerRole +
      `insert into r select 'price after stranger', price_pence::text from public.products where id='${LIVE}';` +
      END);
    assert.equal(outcome(rows, 'price after stranger'), '500');
  });

  test('terms are still required independently — tier did not replace W3I', () => {
    const rows = sql(FIXTURE + asUser(OWNER) +
      attempt('premium business, no terms', newProduct(B.premium, true)) + END);
    assert.equal(outcome(rows, 'premium business, no terms'), 'refused',
      'an entitled business that has not accepted still cannot write');
  });

  test('W3I is intact and unmodified', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger where tgname='commercial_terms_guard' and not tgisinternal) as w3i,
             public.commercial_terms_version() as version,
             (position('business_meets_tier' in pg_get_functiondef('public.commercial_terms_write_guard'::regproc)) > 0) as polluted;`);
    assert.equal(row.w3i, 9);
    assert.equal(row.version, '1.0');
    assert.equal(row.polluted, false, 'the W3I guard was not modified by this work');
  });

  test('Bookings enforcement is exactly as deployed', () => {
    const rows = sql(`
      select tgname from pg_trigger
       where tgname in ('local_businesses_bookings_tier_guard','book_bookings_tier_guard')
         and not tgisinternal order by tgname;`);
    assert.deepEqual(rows.map((r) => r.tgname),
      ['book_bookings_tier_guard', 'local_businesses_bookings_tier_guard']);
  });

  test('the enforced set is exactly the six approved capabilities', () => {
    const rows = sql(`
      -- distinct: local_businesses carries more than one guard (Bookings and
      -- Wallet), and this asks which TABLES are enforced, not how many guards.
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal
         and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    // Passes and Wallet were the approved slices after this one; Wallet's
    // guard sits on local_businesses, which is already in the list.
    assert.deepEqual(rows.map((r) => r.tbl).sort(),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       'local_wallet_transactions', 'products'],
      'this is the complete set of tier-enforced tables');
  });

  test('the existing Premium navigation gates are untouched', () => {
    // Phase 2C replaced the blind redirect this used to pin. The web now opens
    // the manager and asks the deployed predicate, so the thing worth guarding
    // is that presentation follows EFFECTIVE entitlement and never the stored
    // column — the server enforcement below is unchanged either way.
    const page = readFileSync(join(WEB, 'app/business/[id]/manage/products/page.tsx'), 'utf8');
    assert.match(page, /getEffectiveTier\(business\.id\)/);
    assert.doesNotMatch(page, /tierUnlocks|subscription_tier/);
    const mgr = readFileSync(join(WEB, 'components/business/ProductsManager.tsx'), 'utf8');
    // The create default DID change, and had to: the guard's draft carve-out is
    // useless while the client publishes on save.
    assert.match(mgr, /is_active: canPublish/);
    for (const notYet of ['Draft', 'Publish', 'Preview']) {
      assert.ok(!new RegExp(`>\\s*${notYet}`).test(mgr), `the draft UX is a later slice: ${notYet}`);
    }
  });
});

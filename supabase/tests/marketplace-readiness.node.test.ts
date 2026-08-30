/**
 * marketplace-readiness.node.test.ts — the shop can be seen, and its sellers
 * can be paid.
 *
 * TWO FAULTS, BOTH ALREADY SEEN ELSEWHERE.
 *
 * 1. Anonymous reads of public.products and public.product_variants failed with
 *    42501: permission denied for table local_businesses — the events defect
 *    again. Their RLS policies check ownership and business activity by reading
 *    local_businesses AS THE CALLER, and Step 8 withheld owner_id from anon.
 *    lib/shop-data.ts swallows the error into [], so a hard refusal rendered as
 *    "No products yet".
 *
 * 2. create-product-order-intent refused EVERY basket with "This shop isn't
 *    quite ready to take payments yet." It demanded business_stripe_account_id
 *    AND business_stripe_payouts_enabled — a column pair set on ZERO businesses
 *    in production. Not one shop: the whole marketplace was unpurchasable. And
 *    it had no fallback to the owner's central account, which is the model
 *    already settled for event tickets.
 *
 * WHAT IS ASSERTED
 *   · anon can read products and variants at all, and sees the same published
 *     rows an authenticated visitor sees
 *   · inactive and sold products stay hidden
 *   · one payout rule: business's own if explicitly enabled, else the owner's
 *     central, else unavailable — shared by products AND events
 *   · the buyer's card has nothing to do with the seller's payout
 *   · no Stripe identifier is reachable by a client
 *   · a declined card gives the stock back
 *
 * SAFETY
 * Read-only, plus fixtures inside a transaction that is never committed. No
 * Stripe call, no payment, no production row.
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
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const one = (sql: string) => (rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }))[0] ?? {});

// ── 1. The catalogue is readable ───────────────────────────────────────────

describe('a signed-out visitor can see the shop', () => {
  test('anon reads products and variants without an error, and sees what authenticated sees', () => {
    // If this ever fails with 42501 again, the Shop renders "No products yet"
    // and never says why — lib/shop-data.ts returns [] on any error.
    const r = one(`
      begin;
      -- Its own catalogue, rolled back. This used to count whatever production
      -- happened to be publishing, so hiding the pre-launch demo shop made a
      -- passing RLS test fail — the test could not tell "anon is blocked" from
      -- "there is nothing to see". A fixture it created itself can.
      insert into auth.users (id, email) values
        ('faaaaaaa-1111-1111-1111-111111111111','shopfixture@probe.invalid');
      insert into public.local_businesses (id, owner_id, name, category, address, is_active)
        values ('faaaaaaa-2222-2222-2222-222222222222','faaaaaaa-1111-1111-1111-111111111111',
                'PROBE Shop','retail','PROBE',true);
      -- Selling is Premium, so a fixture shop has to be one. Without this the
      -- product is correctly invisible to anon and the test reads as "RLS
      -- blocks anon" when what it really shows is "a free business has no shop".
      update public.local_businesses set subscription_tier='premium',
             subscription_until = now() + interval '30 days'
       where id='faaaaaaa-2222-2222-2222-222222222222';
      insert into public.products (id, business_id, title, price_pence, is_active)
        values ('faaaaaaa-3333-3333-3333-333333333333','faaaaaaa-2222-2222-2222-222222222222',
                'PROBE gansey', 8500, true);
      insert into public.product_variants (product_id, name, is_active)
        values ('faaaaaaa-3333-3333-3333-333333333333','M', true);

      create temp table c(who text, n int);
      do $$
      declare n int;
      begin
        perform set_config('role','anon',true);
        select count(*) into n from public.products where is_active and sold_at is null;
        perform set_config('role','postgres',true); insert into c values ('anon_products', n);
        perform set_config('role','anon',true);
        select count(*) into n from public.product_variants where is_active;
        perform set_config('role','postgres',true); insert into c values ('anon_variants', n);
        perform set_config('role','authenticated',true);
        select count(*) into n from public.products where is_active and sold_at is null;
        perform set_config('role','postgres',true); insert into c values ('auth_products', n);
      end $$;
      select (select n from c where who='anon_products')::text as anon_products,
             (select n from c where who='anon_variants')::text  as anon_variants,
             (select n from c where who='auth_products')::text  as auth_products;`);
    assert.ok(Number(r.anon_products) > 0, 'a signed-out visitor must see live products');
    assert.ok(Number(r.anon_variants) > 0, 'variants power the size picker');
    assert.equal(r.anon_products, r.auth_products,
      'signing in must not change which published products exist');
  });

  test('no product policy reads local_businesses as the caller any more', () => {
    const r = one(`
      select count(*)::text as n from pg_policies
       where schemaname='public' and tablename in ('products','product_variants')
         and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%local_businesses%';`);
    assert.equal(r.n, '0');
  });

  test('inactive and sold products stay out of the catalogue', () => {
    const r = one(`
      begin;
      create temp table v(label text, ok boolean);
      do $$
      declare u uuid; b uuid; p_live uuid; p_off uuid; p_sold uuid; n int;
      begin
        select id into u from auth.users limit 1;
        b := gen_random_uuid();
        insert into public.local_businesses (id,name,category,address,slug,owner_id,is_active)
        values (b,'M Biz','other','Lerwick','m-biz-'||left(b::text,8),u,true);
        -- A shop that sells has a plan; selling is Premium.
        update public.local_businesses set subscription_tier='premium',
               subscription_until = now() + interval '30 days' where id = b;
        p_live := gen_random_uuid(); p_off := gen_random_uuid(); p_sold := gen_random_uuid();
        insert into public.products (id,business_id,title,price_pence,is_active,sold_at)
        values (p_live,b,'M live',1000,true,null),
               (p_off ,b,'M off' ,1000,false,null),
               (p_sold,b,'M sold',1000,true, now());
        perform set_config('role','anon',true);
        select count(*) into n from public.products where id=p_live; perform set_config('role','postgres',true);
        insert into v values ('live_visible', n>0);
        perform set_config('role','anon',true);
        select count(*) into n from public.products where id=p_off;  perform set_config('role','postgres',true);
        insert into v values ('inactive_hidden', n=0);
        perform set_config('role','anon',true);
        select count(*) into n from public.products where id=p_sold and sold_at is null; perform set_config('role','postgres',true);
        insert into v values ('sold_excluded', n=0);
      end $$;
      select (select ok from v where label='live_visible')::text    as live_visible,
             (select ok from v where label='inactive_hidden')::text as inactive_hidden,
             (select ok from v where label='sold_excluded')::text   as sold_excluded;`);
    const T = (x: unknown) => x === true || x === 't' || x === 'true';
    assert.ok(T(r.live_visible));
    assert.ok(T(r.inactive_hidden), 'an inactive product must not be public');
    assert.ok(T(r.sold_excluded), 'a sold one-off must drop out of the catalogue');
  });

  test('the existing older gansey record works without being recreated', () => {
    const r = one(`
      select p.title, p.price_pence::text as price,
             (select count(*)::text from public.product_variants v where v.product_id=p.id and v.is_active) as variants,
             public.business_payout_ready(p.business_id)::text as seller_ready
        from public.products p where p.title ilike 'Fair Isle gansey' limit 1;`);
    // Deliberately no assertion on is_active. This test is about the RECORD
    // still working without being recreated — its price, its variants and its
    // seller resolving. Whether it is currently PUBLISHED is a product
    // decision, and the pre-launch demo shop is unpublished on purpose.
    assert.equal(r.price, '8500', 'the £85 product must still price at £85');
    assert.ok(Number(r.variants) >= 1);
    assert.equal(r.seller_ready, 'true', 'its seller must be payable through the inherited central account');
  });
});

// ── 2. One payout rule ─────────────────────────────────────────────────────

describe('a business inherits its owner’s bank unless given its own', () => {
  test('inherit, override and neither all resolve correctly', () => {
    const r = one(`
      begin;
      create temp table t(label text, dest text, ready boolean);
      do $$
      declare u_own uuid; u_none uuid; b_inh uuid; b_own uuid; b_none uuid;
      begin
        select id into u_own  from auth.users order by created_at limit 1;
        select id into u_none from auth.users order by created_at desc limit 1;
        update public.profiles set stripe_account_id='acct_mk_central', stripe_payouts_enabled=true where id=u_own;
        update public.profiles set stripe_account_id=null, stripe_payouts_enabled=false where id=u_none;
        update public.driver_profiles set stripe_account_id=null, stripe_payouts_enabled=false where id=u_none;

        b_inh := gen_random_uuid(); b_own := gen_random_uuid(); b_none := gen_random_uuid();
        insert into public.local_businesses (id,name,category,address,slug,owner_id,use_business_payout,payout_enabled,stripe_account_id)
        values (b_inh ,'M Inherit' ,'other','Lerwick','m-inh-'||left(b_inh::text,8) ,u_own ,false,false,null),
               (b_own ,'M Own'     ,'other','Lerwick','m-own-'||left(b_own::text,8) ,u_own ,true ,true ,'acct_mk_business'),
               (b_none,'M None'    ,'other','Lerwick','m-non-'||left(b_none::text,8),u_none,false,false,null);

        insert into t select 'inherit',  d.account_id, public.business_payout_ready(b_inh)  from public.business_payout_destination(b_inh)  d;
        insert into t select 'override', d.account_id, public.business_payout_ready(b_own)  from public.business_payout_destination(b_own)  d;
        insert into t select 'none',     d.account_id, public.business_payout_ready(b_none) from public.business_payout_destination(b_none) d;
      end $$;
      select (select coalesce(dest,'(none)') from t where label='inherit')  as inherit,
             (select coalesce(dest,'(none)') from t where label='override') as override,
             (select coalesce(dest,'(none)') from t where label='none')     as none_dest,
             (select ready::text from t where label='none')                 as none_ready;`);
    assert.equal(r.inherit, 'acct_mk_central', 'a shop with no bank of its own is paid through its owner');
    assert.equal(r.override, 'acct_mk_business', 'a shop with its own bank keeps being paid into it');
    assert.equal(r.none_dest, '(none)');
    assert.equal(r.none_ready, 'false', 'with no payout anywhere the shop cannot sell');
  });

  test('events use the same rule, so a business is paid the same way for a ticket and a jumper', () => {
    const src = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', '20260822160000_business_payout_and_product_read.sql'), 'utf8');
    assert.match(src, /_business_payout_resolve\(v_event\.organiser_business_id\)/,
      'the event resolver must defer to the shared business rule');
  });

  test('the checkout asks the resolver, not a column pair nobody populates', () => {
    const fn = read('supabase/functions/create-product-order-intent/index.ts');
    assert.match(fn, /rpc\('business_payout_destination'/);
    assert.ok(!/!biz\.business_stripe_account_id/.test(fn),
      'the dead column pair must no longer gate the shop');
    assert.match(fn, /'transfer_data\[destination\]': sellerAccountId/,
      'the money must go to the resolved account');
  });

  test('clients get a boolean; the account id is server-only', () => {
    const r = one(`
      select
        (select case when has_function_privilege('anon', p.oid,'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='business_payout_ready')        as ready_anon,
        (select case when has_function_privilege('authenticated', p.oid,'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='business_payout_destination')  as dest_authd,
        (select coalesce(array_to_string(p.proconfig,','),'')
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='_business_payout_resolve')     as cfg;`);
    assert.equal(r.ready_anon, 'yes');
    assert.equal(r.dest_authd, 'no', 'a function returning acct_… must not be client-callable');
    assert.match(String(r.cfg), /search_path=/);
  });
});

// ── 3. Buyer and seller stay apart ─────────────────────────────────────────

describe('the buyer’s card is not the seller’s bank', () => {
  test('the shop-ready check looks only at the seller’s payout', () => {
    const fn = read('supabase/functions/create-product-order-intent/index.ts');
    const gate = fn.slice(fn.indexOf('business_payout_destination'), fn.indexOf('const { data: ship }'));
    assert.ok(!/has_payment_method|stripe_customer_id/.test(gate),
      'a seller does not need a saved purchasing card to be paid for a jumper');
  });

  test('the buyer’s customer still comes from the buyer', () => {
    const fn = read('supabase/functions/create-product-order-intent/index.ts');
    assert.match(fn, /customerId/);
    assert.ok(!/biz\.[a-z_]*customer/.test(fn), 'the shop must never be the payer');
  });

  test('both clients go through the same backend, so neither holds its own rule', () => {
    // Mobile reaches the endpoint through its API layer, not the screen.
    for (const [label, src] of [['mobile api', read('lib/products-api.ts')],
                                ['web', readWeb('app/basket/page.tsx')]] as const) {
      assert.match(src, /create-product-order-intent/, `${label} must use the shared endpoint`);
    }
    for (const [label, src] of [['mobile screen', read('app/product-checkout.tsx')],
                                ['mobile api', read('lib/products-api.ts')],
                                ['web', readWeb('app/basket/page.tsx')]] as const) {
      assert.ok(!/payout_enabled|business_stripe|stripe_account_id/.test(src),
        `${label} must not carry its own copy of the readiness rule`);
    }
  });
});

// ── 4. A declined card gives the stock back ────────────────────────────────

describe('a failed payment does not eat the stock', () => {
  test('the failed branch releases the reservation and cancels the order', () => {
    const fn = read('supabase/functions/create-product-order-intent/index.ts');
    const failed = fn.slice(fn.indexOf("if (outcome.kind !== 'succeeded')"), fn.indexOf("charged: true, status: 'succeeded'"));
    assert.match(failed, /await releaseAll\(\)/,
      'a one-off item held by a declined payment is unbuyable by anyone');
    assert.match(failed, /status: 'cancelled'/);
  });

  test('a payment still in flight keeps its reservation', () => {
    const fn = read('supabase/functions/create-product-order-intent/index.ts');
    const inflight = fn.slice(fn.indexOf("outcome.kind === 'requires_action'"), fn.indexOf("outcome.kind === 'processing'"));
    assert.ok(!/releaseAll/.test(inflight), 'releasing mid-authentication would sell the item twice');
  });
});

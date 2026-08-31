/**
 * business-effective-tier.node.test.ts — one question, answered once.
 *
 * Paid-tier entitlement is presently enforced by the web redirecting and the
 * app not drawing the button. When it moves to the server, every enforcement
 * point needs the same answer to "does this business currently meet tier X?",
 * and `subscription_tier` alone is not that answer: nothing sweeps expiry, so a
 * missed Stripe webhook leaves a business recorded as paid indefinitely past
 * the period it paid for.
 *
 * This predicate has NO consumers, deliberately — a test below asserts that.
 * It is the primitive the enforcement work will be built on, landed on its own
 * so the expiry decision is made once, in the open, before anything depends on
 * it.
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

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'a1a10001-1111-1111-1111-111111111111';
const B = {
  free:      'a1a10002-2222-2222-2222-222222222222',
  pro:       'a1a10003-3333-3333-3333-333333333333',
  premium:   'a1a10004-4444-4444-4444-444444444444',
  proExpired:     'a1a10005-5555-5555-5555-555555555555',
  premiumExpired: 'a1a10006-6666-6666-6666-666666666666',
  premiumNoEnd:   'a1a10007-7777-7777-7777-777777777777',
  cancelling:     'a1a10008-8888-8888-8888-888888888888',
};

/**
 * Seven businesses covering every subscription state the lifecycle produces,
 * plus the two it should not. Tier columns are written as the table owner
 * because tg_lock_business_columns refuses them from a client — which is
 * itself asserted below.
 */
const FIXTURE = `
begin;
  insert into auth.users (id, email) values ('${OWNER}', 'tier-o@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${B.free}','${OWNER}','PROBE FREE','other','P',true),
    ('${B.pro}','${OWNER}','PROBE PRO','other','P',true),
    ('${B.premium}','${OWNER}','PROBE PREM','other','P',true),
    ('${B.proExpired}','${OWNER}','PROBE PRO EXP','other','P',true),
    ('${B.premiumExpired}','${OWNER}','PROBE PREM EXP','other','P',true),
    ('${B.premiumNoEnd}','${OWNER}','PROBE PREM NULL','other','P',true),
    ('${B.cancelling}','${OWNER}','PROBE CANCELLING','other','P',true);
  update public.local_businesses set subscription_tier='pro',     subscription_until=now()+interval '10 days' where id='${B.pro}';
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days' where id='${B.premium}';
  update public.local_businesses set subscription_tier='pro',     subscription_until=now()-interval '1 day'   where id='${B.proExpired}';
  update public.local_businesses set subscription_tier='premium', subscription_until=now()-interval '1 day'   where id='${B.premiumExpired}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null                     where id='${B.premiumNoEnd}';
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '3 days',
         subscription_cancel_at_period_end=true where id='${B.cancelling}';
`;

const meets = (biz: string, tier: string) => `public.business_meets_tier('${biz}','${tier}')`;

/** One round trip for the whole grid. */
const GRID = sql(FIXTURE + `
  select
    ${meets(B.free, 'free')} as free_free, ${meets(B.free, 'pro')} as free_pro, ${meets(B.free, 'premium')} as free_premium,
    ${meets(B.pro, 'free')} as pro_free, ${meets(B.pro, 'pro')} as pro_pro, ${meets(B.pro, 'premium')} as pro_premium,
    ${meets(B.premium, 'free')} as prem_free, ${meets(B.premium, 'pro')} as prem_pro, ${meets(B.premium, 'premium')} as prem_premium,
    ${meets(B.proExpired, 'pro')} as expired_pro,
    ${meets(B.premiumExpired, 'premium')} as expired_prem_premium,
    ${meets(B.premiumExpired, 'pro')} as expired_prem_pro,
    ${meets(B.premiumExpired, 'free')} as expired_prem_free,
    ${meets(B.premiumNoEnd, 'premium')} as no_end,
    ${meets(B.cancelling, 'premium')} as cancelling,
    ${meets('00000000-0000-0000-0000-0000000000ff', 'pro')} as missing,
    public.business_meets_tier(null,'pro') as null_business;
rollback;`)[0];

/* ── 1. The ladder ──────────────────────────────────────────────────────── */

describe('free < pro < premium', () => {
  test('a free business meets free, and nothing above it', () => {
    assert.equal(GRID.free_free, true);
    assert.equal(GRID.free_pro, false);
    assert.equal(GRID.free_premium, false);
  });

  test('a pro business meets free and pro, but not premium', () => {
    assert.equal(GRID.pro_free, true);
    assert.equal(GRID.pro_pro, true);
    assert.equal(GRID.pro_premium, false);
  });

  test('a premium business meets everything', () => {
    assert.equal(GRID.prem_free, true);
    assert.equal(GRID.prem_pro, true);
    assert.equal(GRID.prem_premium, true);
  });
});

/* ── 2. Recorded is not the same as entitled ────────────────────────────── */

describe('a paid tier counts only while it is still paid for', () => {
  test('an expired pro does not meet pro', () => {
    assert.equal(GRID.expired_pro, false, 'a missed webhook must not grant indefinite entitlement');
  });

  test('an expired premium meets neither premium nor pro', () => {
    assert.equal(GRID.expired_prem_premium, false);
    assert.equal(GRID.expired_prem_pro, false, 'expiry drops entitlement, it does not demote it');
  });

  test('but an expired business is still a business, and still meets free', () => {
    assert.equal(GRID.expired_prem_free, true);
  });

  test('cancelling at period end keeps entitlement until the period ends', () => {
    assert.equal(GRID.cancelling, true,
      'cancel_at_period_end is a future intention, not an immediate downgrade');
  });

  test('a paid tier with no end date is not entitled', () => {
    // Checked, not assumed: both writers — apply_subscription_state and
    // apply_boost_entitlement — set subscription_until whenever they grant a
    // paid tier, so this state is not one the lifecycle produces.
    assert.equal(GRID.no_end, false,
      'entitlement must come from a granted period, never from a missing value');
  });

  test('the lifecycle really does always set an expiry when granting a paid tier', () => {
    const [row] = sql(`
      select (position('subscription_until                = p_period_end' in
               pg_get_functiondef('public.apply_subscription_state'::regproc)) > 0) as sub_sets_until,
             (position('subscription_until' in
               pg_get_functiondef('public.apply_boost_entitlement'::regproc)) > 0) as boost_sets_until;`);
    assert.equal(row.sub_sets_until, true);
    assert.equal(row.boost_sets_until, true);
  });
});

/* ── 3. Refusing to guess ───────────────────────────────────────────────── */

describe('it fails closed, and loudly', () => {
  test('a business that does not exist meets nothing', () => {
    assert.equal(GRID.missing, false);
    assert.equal(GRID.null_business, false);
  });

  test('an unknown tier raises rather than behaving like free', () => {
    const rows = sql(`
      begin;
        create temp table r(step text, outcome text) on commit drop;
        do $p$ begin
          perform public.business_meets_tier('${B.premium}'::uuid, 'gold');
          insert into r values ('typo','ALLOWED — a typo would grant entitlement');
        exception when others then insert into r values ('typo','refused: '||sqlstate); end $p$;
        do $p$ begin
          perform public.business_meets_tier('${B.premium}'::uuid, null);
          insert into r values ('null tier','ALLOWED');
        exception when others then insert into r values ('null tier','refused: '||sqlstate); end $p$;
        select * from r order by step;
      rollback;`);
    for (const r of rows) assert.match(String(r.outcome), /^refused: 22023/, String(r.step));
  });
});

/* ── 4. It decides subscriptions, and nothing else ──────────────────────── */

describe('it stays in its lane', () => {
  const def = String(sql(`select pg_get_functiondef('public.business_meets_tier(uuid,text)'::regprocedure) as d;`)[0].d);

  test('it never reads ownership, terms, or feature configuration', () => {
    for (const forbidden of ['owner_id', 'auth.uid', 'commercial_terms', 'has_accepted',
                             'is_active', 'products', 'book_services', 'accepts_']) {
      assert.ok(!def.includes(forbidden), `it must not decide ${forbidden}`);
    }
  });

  test('it reads only the two subscription columns it needs', () => {
    assert.match(def, /subscription_tier/);
    assert.match(def, /subscription_until/);
    assert.match(def, /now\(\)/);
  });

  test('it holds no feature map — that stays with each enforcement point', () => {
    for (const feature of ['products', 'bookings', 'wallet', 'offers', 'loyalty', 'passes']) {
      assert.ok(!new RegExp(`'${feature}'`).test(def), `a feature→tier map must not live here: ${feature}`);
    }
  });

  test('it cannot change anything', () => {
    assert.match(def, /STABLE/i);
    for (const w of ['update ', 'insert ', 'delete ']) {
      assert.ok(!def.toLowerCase().includes(w), `a read-only predicate must not ${w.trim()}`);
    }
  });

  test('calling it cannot alter a tier — that is still locked to the server', () => {
    const rows = sql(FIXTURE + `
      create temp table r(step text, outcome text) on commit drop;
      grant insert, select on r to authenticated;
      select set_config('request.jwt.claims','{"sub":"${OWNER}","role":"authenticated"}',true);
      set local role authenticated;
      do $p$ begin
        update public.local_businesses set subscription_tier='premium' where id='${B.free}';
        insert into r values ('client sets tier',
          (select subscription_tier from public.local_businesses where id='${B.free}'));
      exception when others then insert into r values ('client sets tier','refused'); end $p$;
      insert into r select 'still meets premium', public.business_meets_tier('${B.free}','premium')::text;
      reset role;
      select * from r order by step;
    rollback;`);
    const set = rows.find((r) => r.step === 'client sets tier')?.outcome;
    assert.ok(set === 'free' || set === 'refused', `tg_lock_business_columns should hold: got ${set}`);
    assert.equal(rows.find((r) => r.step === 'still meets premium')?.outcome, 'false');
  });
});

/* ── 5. Security, grants, and the absence of consumers ──────────────────── */

describe('deployed shape', () => {
  test('security definer with a pinned search_path', () => {
    const [row] = sql(`
      select p.prosecdef as definer, p.provolatile as volatility,
             array_to_string(p.proconfig, ',') as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='business_meets_tier';`);
    assert.equal(row.definer, true);
    assert.equal(row.volatility, 's', 'stable');
    assert.match(String(row.config), /search_path=public/);
  });

  /**
   * anon was deliberately withheld when this landed — nothing signed out had a
   * reason to ask. The Products slice gave it one: the public read policy on
   * products is evaluated for signed-out readers, so without the grant every
   * shop page would 42501 rather than filter. It discloses nothing new, since
   * whether a business meets Premium is exactly what the visibility of its
   * products already tells you.
   */
  test('grants are exactly anon, authenticated and service_role', () => {
    const [row] = sql(`
      select has_function_privilege('anon','public.business_meets_tier(uuid,text)','execute') as anon,
             has_function_privilege('authenticated','public.business_meets_tier(uuid,text)','execute') as auth,
             has_function_privilege('service_role','public.business_meets_tier(uuid,text)','execute') as svc;`);
    assert.equal(row.anon, true, 'the public products read policy is evaluated as anon');
    assert.equal(row.auth, true, 'policies and BEFORE triggers run as the caller and need EXECUTE');
    assert.equal(row.svc, true);
  });

  /**
   * This began life as "it has ZERO consumers", which was the whole point of
   * the foundation slice — the predicate landed inert so the expiry decision
   * could be made once, in the open, before anything depended on it.
   *
   * Bookings is now that first dependant, by approval. The assertion moves
   * rather than being deleted: it still names every consumer, so a capability
   * that quietly starts enforcing tier fails here. Add to this list only when
   * that enforcement is the approved work of a slice.
   */
  test('its consumers are exactly the ones that were approved', () => {
    const rows = sql(`
      select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname <> 'business_meets_tier'
         and position('business_meets_tier' in pg_get_functiondef(p.oid)) > 0
       order by p.proname;`);
    assert.deepEqual(rows.map((r) => r.proname), [
      'book_bookings_tier_guard',                 // Bookings transaction backstop
      'book_unit_items_tier_guard',               // Passes activation
      'local_businesses_bookings_tier_guard',     // Bookings activation
      'products_tier_guard',                      // Products activation
    ], 'Wallet, Offers and Loyalty must not have gained tier enforcement');

    const [pol] = sql(`
      select count(*)::int as n from pg_policy p
       where position('business_meets_tier' in
         coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) > 0;`);
    // The two sales surfaces whose EXPOSURE boundary is a read policy rather
    // than a trigger, deliberately: many loaders read products and passes, and
    // filtering in each would be a place to forget every time one is added.
    // Named rather than counted, so a third appearing is a decision.
    assert.equal(pol.n, 2);
    const which = sql(`
      select c.relname || ':' || p.polname as p from pg_policy p join pg_class c on c.oid=p.polrelid
       where position('business_meets_tier' in
         coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) > 0
       order by 1;`);
    assert.deepEqual(which.map((r) => r.p), [
      'book_unit_items:Anyone can read active unit items',
      'products:public reads live products',
    ]);
  });

  test('nothing that was already enforced changed', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger where tgname='commercial_terms_guard' and not tgisinternal) as w3i,
             (select count(*)::int from pg_trigger where tgname='local_businesses_commercial_guard' and not tgisinternal) as lb,
             (select count(*)::int from pg_trigger where tgname='tg_lock_business_columns' or tgfoid='public.tg_lock_business_columns'::regproc) as column_lock,
             public.commercial_terms_version() as terms_version,
             (select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid
               where position('subscription_tier' in
                 coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) > 0) as tier_policies;`);
    assert.equal(row.w3i, 9);
    assert.equal(row.lb, 1);
    assert.equal(row.terms_version, '1.0');
    assert.ok((row.column_lock as number) >= 1, 'tier columns still locked from clients');
    assert.equal(row.tier_policies, 0, 'this task adds no tier enforcement anywhere');
  });
});

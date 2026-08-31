/**
 * passes-tier-entitlement.node.test.ts — selling passes is Premium; a pass
 * already bought is not the seller's to take away.
 *
 * The third and last of the paid sales surfaces, and the one with a line the
 * other two do not have. A product is a thing for sale. A pass is a thing for
 * sale AND a promise already made to somebody who paid, and those need
 * opposite treatment when a subscription lapses:
 *
 *   selling new passes    stops
 *   passes already sold   keep working, in full, on their original terms
 *
 * So the guards sit on book_unit_items and NOTHING sits on
 * book_unit_purchases. A customer with three swims left has three swims left.
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
const INTENT  = readFileSync(join(REPO_ROOT, 'supabase/functions/create-unit-purchase-intent/index.ts'), 'utf8');
const CONFIRM = readFileSync(join(REPO_ROOT, 'supabase/functions/confirm-unit-purchase/index.ts'), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'e2e20001-1111-1111-1111-111111111111';
const CUST  = 'e2e20009-9999-9999-9999-999999999999';
const B = {
  premium:  'e2e20002-2222-2222-2222-222222222222',
  pro:      'e2e20003-3333-3333-3333-333333333333',
  free:     'e2e20004-4444-4444-4444-444444444444',
  lapsing:  'e2e20005-5555-5555-5555-555555555555',
  premNull: 'e2e20006-6666-6666-6666-666666666666',
};
const LIVE = 'e2e2000a-0000-0000-0000-00000000000a';
const DRAFT = 'e2e2000b-0000-0000-0000-00000000000b';
const BOUGHT = 'e2e2000c-0000-0000-0000-00000000000c';

const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','pk-o@probe.invalid'),('${CUST}','pk-c@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active) values
    ('${B.premium}','${OWNER}','PK PREM','other','P',true),
    ('${B.pro}','${OWNER}','PK PRO','other','P',true),
    ('${B.free}','${OWNER}','PK FREE','other','P',true),
    ('${B.lapsing}','${OWNER}','PK LAPSING','other','P',true),
    ('${B.premNull}','${OWNER}','PK PREM NULL','other','P',true);
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days'
    where id in ('${B.premium}','${B.lapsing}');
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '10 days' where id='${B.pro}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null where id='${B.premNull}';
  insert into public.book_unit_items (id,business_id,name,price_pence,is_active) values
    ('${LIVE}','${B.lapsing}','Swim 10',5000,true),
    ('${DRAFT}','${B.pro}','Draft pack',5000,false);
  -- somebody who already paid, with units left
  insert into public.book_unit_purchases (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining)
    values ('${BOUGHT}','${LIVE}','${B.lapsing}','${CUST}',5000,3);
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
const newPass = (biz: string, active: boolean) =>
  `insert into public.book_unit_items (business_id,name,price_pence,is_active) values ('${biz}','P',5000,${active})`;
const lapse = `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';`;

/* ── 1. Putting a pass on sale needs Premium ────────────────────────────── */

describe('selling passes is Premium', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
    attempt('premium publishes', newPass(B.premium, true)) +
    attempt('pro publishes',     newPass(B.pro, true)) +
    attempt('free publishes',    newPass(B.free, true)) +
    attempt('premium-null publishes', newPass(B.premNull, true)) +
    attempt('pro creates a draft', newPass(B.pro, false)) +
    attempt('pro edits the draft', `update public.book_unit_items set price_pence=6000 where id='${DRAFT}'`) +
    attempt('pro publishes the draft', `update public.book_unit_items set is_active=true where id='${DRAFT}'`) +
    END);

  test('Premium may put a pass on sale', () => {
    assert.equal(outcome(rows, 'premium publishes'), 'ALLOWED');
  });

  test('Pro may not — passes are Premium, not Pro', () => {
    assert.equal(outcome(rows, 'pro publishes'), 'refused');
  });

  test('Free may not', () => assert.equal(outcome(rows, 'free publishes'), 'refused'));

  test('a paid tier with no end date may not', () => {
    assert.equal(outcome(rows, 'premium-null publishes'), 'refused');
  });

  test('an unpublished pass can be built and edited below Premium', () => {
    assert.equal(outcome(rows, 'pro creates a draft'), 'ALLOWED');
    assert.equal(outcome(rows, 'pro edits the draft'), 'ALLOWED');
  });

  test('putting it on sale is where the plan is asked for', () => {
    assert.equal(outcome(rows, 'pro publishes the draft'), 'refused');
  });

  test('passes are Premium in the tier model on both clients', () => {
    for (const f of [join(WEB, 'lib/listing-tiers.ts'), join(REPO_ROOT, 'lib/listing-tiers.ts')]) {
      assert.match(readFileSync(f, 'utf8'), /passes:\s*"premium"/);
    }
  });
});

/* ── 2. What a customer already bought is theirs ────────────────────────── */

describe('a lapsed seller keeps its promises', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll + asOwnerRole + lapse + asUser(OWNER) +
    attempt('redeem a use after lapsing',
      `update public.book_unit_purchases set uses_remaining=uses_remaining-1 where id='${BOUGHT}'`) +
    asOwnerRole +
    `insert into r select 'units left', uses_remaining::text from public.book_unit_purchases where id='${BOUGHT}';
     insert into r select 'purchase still exists', count(*)::text from public.book_unit_purchases where id='${BOUGHT}';` +
    asUser(CUST) +
    `insert into r select 'customer still sees it', count(*)::text from public.book_unit_purchases where id='${BOUGHT}';` +
    END);

  test('the business can still redeem units somebody paid for', () => {
    assert.equal(outcome(rows, 'redeem a use after lapsing'), 'ALLOWED',
      'a subscription ending does not cancel a promise already made');
  });

  test('the remaining units are decremented normally, not wiped', () => {
    assert.equal(outcome(rows, 'units left'), '2');
  });

  test('the purchase record survives', () => {
    assert.equal(outcome(rows, 'purchase still exists'), '1');
  });

  test('the customer can still see what they bought', () => {
    assert.equal(outcome(rows, 'customer still sees it'), '1');
  });

  test('nothing was put on book_unit_purchases at all', () => {
    const rows2 = sql(`
      select (select count(*)::int from pg_trigger t
               where t.tgrelid='public.book_unit_purchases'::regclass and not t.tgisinternal
                 and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0) as triggers,
             (select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid
               where c.relname='book_unit_purchases'
                 and position('business_meets_tier' in
                   coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) > 0) as policies;`);
    assert.equal(rows2[0].triggers, 0, "redemption must never consult the seller's plan");
    assert.equal(rows2[0].policies, 0);
  });
});

/* ── 3. Expiry, withdrawal, recovery ────────────────────────────────────── */

describe('a lapsed seller stops selling but keeps its shelf', () => {
  const rows = sql(FIXTURE + asUser(OWNER) + acceptAll + asOwnerRole + lapse + asUser(OWNER) +
    attempt('edit a live pass',  `update public.book_unit_items set price_pence=9999 where id='${LIVE}'`) +
    attempt('withdraw it',       `update public.book_unit_items set is_active=false where id='${LIVE}'`) +
    attempt('reactivate it',     `update public.book_unit_items set is_active=true where id='${LIVE}'`) +
    asOwnerRole +
    `insert into r select 'pass still stored', count(*)::text from public.book_unit_items where id='${LIVE}';
     update public.local_businesses set subscription_until=now()+interval '5 days' where id='${B.lapsing}';` +
    asUser(OWNER) +
    attempt('reactivate once Premium returns', `update public.book_unit_items set is_active=true where id='${LIVE}'`) +
    END);

  test('an under-tier seller may not change a pass that is still on sale', () => {
    assert.equal(outcome(rows, 'edit a live pass'), 'refused');
  });

  test('but may always take it off sale', () => {
    assert.equal(outcome(rows, 'withdraw it'), 'ALLOWED');
  });

  test('and may not put it back while under-tier', () => {
    assert.equal(outcome(rows, 'reactivate it'), 'refused');
  });

  test('the configuration is never destroyed', () => {
    assert.equal(outcome(rows, 'pass still stored'), '1');
  });

  test('regaining Premium allows it back on sale', () => {
    assert.equal(outcome(rows, 'reactivate once Premium returns'), 'ALLOWED');
  });

  test('withdrawal works without current terms too', () => {
    const solo = sql(FIXTURE + asUser(OWNER) +
      attempt('withdraw without terms', `update public.book_unit_items set is_active=false where id='${LIVE}'`) + END);
    assert.equal(outcome(solo, 'withdraw without terms'), 'ALLOWED');
  });
});

/* ── 4. Exposure ────────────────────────────────────────────────────────── */

describe('an unentitled pass is not on the shelf', () => {
  const rows = sql(FIXTURE + asOwnerRole + lapse +
    `insert into public.book_unit_items (business_id,name,price_pence,is_active)
       values ('${B.premium}','ON SALE',5000,true);
     select set_config('request.jwt.claims','',true);
     set local role anon;
     insert into r select 'anon sees the lapsed pass', count(*)::text from public.book_unit_items where id='${LIVE}';
     insert into r select 'anon sees the entitled pass', count(*)::text from public.book_unit_items where business_id='${B.premium}' and is_active;` +
    asUser(OWNER) +
    `insert into r select 'owner still sees their own', count(*)::text from public.book_unit_items where id='${LIVE}';` +
    END);

  test('a signed-out customer cannot see it, by any route', () => {
    assert.equal(outcome(rows, 'anon sees the lapsed pass'), '0');
  });

  test('an entitled seller is unaffected', () => {
    assert.equal(outcome(rows, 'anon sees the entitled pass'), '1');
  });

  test('the owner keeps sight of their own configuration', () => {
    assert.equal(outcome(rows, 'owner still sees their own'), '1');
  });

  test('the filter is in the read policy, so every loader inherits it', () => {
    const [row] = sql(`
      select pg_get_expr(p.polqual, p.polrelid) as expr from pg_policy p join pg_class c on c.oid=p.polrelid
       where c.relname='book_unit_items' and p.polname='Anyone can read active unit items';`);
    assert.match(String(row.expr), /business_meets_tier/);
    assert.match(String(row.expr), /is_business_owner/, 'the owner arm must survive');
  });
});

/* ── 5. The purchase backstop ───────────────────────────────────────────── */

describe('a purchase is refused before any money moves', () => {
  test('the check sits after the item loads and before the PaymentIntent', () => {
    const item = INTENT.indexOf("if (!item || !item.is_active)");
    const check = INTENT.indexOf("p_required_tier: 'premium'");
    assert.ok(check > item, 'the item must be loaded first');
    // EVERY Stripe call site, not just the first — this function has two, and
    // a check that only precedes one of them is not a backstop.
    const calls = [...INTENT.matchAll(/await createPaymentIntent\(/g)].map((m) => m.index!);
    assert.ok(calls.length >= 2, 'expected both charge paths');
    for (const at of calls) assert.ok(at > check, 'no Stripe call may precede the check');
  });

  test('it asks the shared predicate', () => {
    assert.match(INTENT, /rpc\('business_meets_tier'/);
    assert.ok(!/subscription_tier/.test(INTENT), 'no second tier formula');
  });

  test('an unreadable answer refuses', () => {
    assert.match(INTENT, /if \(tierErr \|\| maySell !== true\)/);
  });

  test('the customer is told the item is unavailable, nothing more', () => {
    const at = INTENT.indexOf("p_required_tier: 'premium'");
    const block = INTENT.slice(at, at + 400);
    assert.match(block, /Item not available/);
    for (const leak of ['Premium', 'subscription', 'plan', 'tier', 'billing']) {
      assert.ok(!new RegExp(`error: '[^']*${leak}`, 'i').test(block), `must not leak: ${leak}`);
    }
  });

  test('confirm-unit-purchase is deliberately NOT gated', () => {
    // It runs after Stripe has taken the money. Refusing there would charge
    // somebody and withhold the pass.
    assert.ok(!/business_meets_tier/.test(CONFIRM),
      'a customer who has already paid is owed what they bought');
  });

  test('the decision is right for both cases', () => {
    const rows = sql(FIXTURE + asOwnerRole + lapse +
      `insert into r select 'lapsed may sell', public.business_meets_tier('${B.lapsing}','premium')::text;
       insert into r select 'entitled may sell', public.business_meets_tier('${B.premium}','premium')::text;` + END);
    assert.equal(outcome(rows, 'lapsed may sell'), 'false');
    assert.equal(outcome(rows, 'entitled may sell'), 'true');
  });
});

/* ── 6. Bypass, isolation, composition ──────────────────────────────────── */

describe('no way round, and nothing else disturbed', () => {
  test('direct PostgREST activation cannot bypass', () => {
    const rows = sql(FIXTURE + asUser(OWNER) + acceptAll +
      attempt('direct activate', newPass(B.free, true)) + END);
    assert.equal(outcome(rows, 'direct activate'), 'refused');
  });

  test("a stranger cannot alter another business's pass", () => {
    const rows = sql(FIXTURE + asUser(CUST) +
      attempt('stranger edits', `update public.book_unit_items set price_pence=1 where id='${LIVE}'`) +
      asOwnerRole +
      `insert into r select 'price after stranger', price_pence::text from public.book_unit_items where id='${LIVE}';` +
      END);
    assert.equal(outcome(rows, 'price after stranger'), '5000');
  });

  test('terms remain independently required — tier did not replace W3I', () => {
    const rows = sql(FIXTURE + asUser(OWNER) +
      attempt('premium seller, no terms', newPass(B.premium, true)) + END);
    assert.equal(outcome(rows, 'premium seller, no terms'), 'refused');
  });

  test('W3I still guards book_unit_items, unmodified', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger where tgname='commercial_terms_guard' and not tgisinternal) as w3i,
             (select count(*)::int from pg_trigger where tgname='commercial_terms_guard'
               and tgrelid='public.book_unit_items'::regclass and not tgisinternal) as on_units,
             public.commercial_terms_version() as version;`);
    assert.equal(row.w3i, 9);
    assert.equal(row.on_units, 1);
    assert.equal(row.version, '1.0');
  });

  test('Products and Bookings enforcement is exactly as deployed', () => {
    const rows = sql(`
      select tgname from pg_trigger
       where tgname in ('products_tier_guard','local_businesses_bookings_tier_guard','book_bookings_tier_guard')
         and not tgisinternal order by tgname;`);
    assert.deepEqual(rows.map((r) => r.tgname),
      ['book_bookings_tier_guard', 'local_businesses_bookings_tier_guard', 'products_tier_guard']);
  });

  test('the enforced set is exactly the six approved capabilities', () => {
    const rows = sql(`
      -- distinct: local_businesses carries more than one guard (Bookings and
      -- Wallet), and this asks which TABLES are enforced, not how many guards.
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    assert.deepEqual(rows.map((r) => r.tbl).sort(),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       'local_wallet_transactions', 'products'],
      'this is the complete set of tier-enforced tables');
  });

  test('the existing Premium navigation gate is untouched', () => {
    const page = readFileSync(join(WEB, 'app/business/[id]/manage/passes/page.tsx'), 'utf8');
    assert.match(page, /tierUnlocks\(business\.subscription_tier, "passes"\)/);
  });
});

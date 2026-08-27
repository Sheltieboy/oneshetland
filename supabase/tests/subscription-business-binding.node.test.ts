/**
 * subscription-business-binding.node.test.ts — the payer is not the business.
 *
 * The subscription webhook found the business by asking
 * stripe_customer_id = subscription.customer, and the checkout consolidated the
 * payer's Customer onto whichever business was being bought for, behind a
 * partial UNIQUE index that let one Customer belong to at most one business.
 *
 * One owner, two businesses, one saved card broke all three at once:
 *
 *   A already holds cus_U
 *   owner subscribes B with the same card
 *   → B's consolidation violates the unique index, and the error is not read
 *   → B keeps no customer and receives nothing
 *   → the webhook resolves cus_U to A, and A RECEIVES B's PREMIUM
 *
 * SAFETY
 * Disposable businesses inside rolled-back transactions. No Stripe call, no
 * subscription, no payment.
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
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');
const webhook  = code(read('supabase/functions/stripe-webhook/index.ts'));
const intent   = code(read('supabase/functions/local-subscription-intent/index.ts'));
const invoices = code(read('supabase/functions/local-subscription-invoices/index.ts'));
const change   = code(read('supabase/functions/local-subscription-change/index.ts'));
const cancel   = code(read('supabase/functions/local-subscription-cancel/index.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

const PRELUDE = `
create temp table res (n serial, scen text, got text);
create or replace function pg_temp.mk(p_owner uuid, p_name text, p_cus text default null) returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier,stripe_customer_id)
      values (v,p_name,'other','Lerwick',p_owner,'free',p_cus); return v; end $f$;
create or replace function pg_temp.st(p_biz uuid) returns text language sql as
$f$ select coalesce(to_char(subscription_until,'YYYY-MM-DD'),'NULL')||'/'||subscription_tier||'/'
        ||coalesce(stripe_subscription_id,'NOSUB') from public.local_businesses where id=p_biz $f$;
create or replace function pg_temp.attempt(p_rid text, p_user uuid, p_biz uuid, p_sub text) returns void language plpgsql as $f$
begin
  insert into public.local_subscription_attempts
    (client_request_id,user_id,business_id,tier,period,payload_fingerprint,stripe_subscription_id,status)
  values (p_rid,p_user,p_biz,'premium','monthly','fp',p_sub,'in_flight');
end $f$;
create or replace function pg_temp.ev(p_sub text, p_cus text, p_status text, p_tier text, p_end timestamptz, p_created bigint, p_meta uuid default null)
returns text language plpgsql as $f$
declare r jsonb; begin
  r := public.apply_subscription_state(p_sub, p_cus, p_status, p_tier, p_end, false, p_created, false, p_meta);
  return coalesce(r->>'reason','?');
end $f$;
`;

function scenario(body: string): Record<string, string> {
  const rows = runSql(`begin;\n${PRELUDE}\ndo $$\ndeclare o uuid; o2 uuid; a uuid; b uuid;\nbegin\n  select id into o from public.profiles limit 1;\n  select id into o2 from public.profiles offset 1 limit 1;\n${body}\nend $$;\nselect scen, got from res order by n;\nrollback;`);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.scen)] = `${r.got}`;
  return out;
}
const rec = (name: string, expr: string) => `  insert into res(scen,got) values ('${name}', ${expr});\n`;

/* ── 1. one owner, two businesses, one card ───────────────────────────────── */

describe('a subscription entitles the business it was bought for', () => {
  const T = 1793200000;
  const r = scenario(`
  a := pg_temp.mk(o,'ZZ Business A','cus_U_shared');
  b := pg_temp.mk(o,'ZZ Business B','cus_U_shared');
${rec('shared_customer_allowed', "(select count(*)::text from public.local_businesses where stripe_customer_id='cus_U_shared')")}

  perform pg_temp.attempt('rid-a', o, a, 'sub_A');
${rec('A_subscribed', `pg_temp.ev('sub_A','cus_U_shared','active','pro','2026-09-27 10:00+00', ${T})`)}
${rec('A_state', 'pg_temp.st(a)')}
${rec('B_untouched_after_A', 'pg_temp.st(b)')}

  perform pg_temp.attempt('rid-b', o, b, 'sub_B');
${rec('B_subscribed', `pg_temp.ev('sub_B','cus_U_shared','active','premium','2026-10-27 10:00+00', ${T + 10})`)}
${rec('B_state', 'pg_temp.st(b)')}
${rec('A_unchanged_after_B', 'pg_temp.st(a)')}

${rec('B_lapse', `pg_temp.ev('sub_B','cus_U_shared','past_due',null,null, ${T + 20})`)}
${rec('B_after_lapse', 'pg_temp.st(b)')}
${rec('A_still_pro', 'pg_temp.st(a)')}

  perform public.extend_subscription_period('sub_A','2026-11-27');
${rec('A_extended', 'pg_temp.st(a)')}
${rec('B_not_extended', 'pg_temp.st(b)')}

${rec('retire_B', "(public.retire_subscription('sub_B', 1793300000, true))->>'reason'")}
${rec('B_retired', 'pg_temp.st(b)')}
${rec('A_survives_B_retirement', 'pg_temp.st(a)')}`);

  test('two businesses may share one payer', () =>
    assert.equal(r.shared_customer_allowed, '2', 'the unique index still forbids a shared payer'));

  test('subscribing A entitles A only', () => {
    assert.equal(r.A_subscribed, 'active');
    assert.equal(r.A_state, '2026-09-27/pro/sub_A');
    assert.equal(r.B_untouched_after_A, 'NULL/free/NOSUB');
  });

  test('subscribing B with the SAME customer entitles B, and leaves A alone', () => {
    // The defect: A received B's Premium because the webhook asked the customer.
    assert.equal(r.B_subscribed, 'active');
    assert.equal(r.B_state, '2026-10-27/premium/sub_B');
    assert.equal(r.A_unchanged_after_B, '2026-09-27/pro/sub_A',
      "business A was given business B's subscription");
  });

  test('a lapse on B cannot lapse A', () => {
    assert.equal(r.B_lapse, 'owner_lapsed');
    assert.equal(r.B_after_lapse, 'NULL/free/sub_B');
    assert.equal(r.A_still_pro, '2026-09-27/pro/sub_A');
  });

  test('an invoice for A extends A only', () => {
    assert.equal(r.A_extended, '2026-11-27/pro/sub_A');
    assert.equal(r.B_not_extended, 'NULL/free/sub_B');
  });

  test('retiring B retires B only', () => {
    assert.equal(r.retire_B, 'retired');
    assert.equal(r.B_retired, 'NULL/free/NOSUB');
    assert.equal(r.A_survives_B_retirement, '2026-11-27/pro/sub_A');
  });
});

/* ── 2. what may NOT resolve to a business ────────────────────────────────── */

describe('nothing but server-authored evidence binds a subscription', () => {
  const T = 1793400000;
  const r = scenario(`
  a := pg_temp.mk(o,'ZZ Known Payer','cus_known');
${rec('foreign_sub_known_customer', `pg_temp.ev('sub_never_seen','cus_known','active','premium','2026-09-27 10:00+00', ${T})`)}
${rec('foreign_left_nothing', 'pg_temp.st(a)')}

  b := pg_temp.mk(o,'ZZ Other');
  perform pg_temp.attempt('rid-x', o, b, 'sub_meta');
${rec('metadata_disagrees', `pg_temp.ev('sub_meta','cus_known','active','premium','2026-09-27 10:00+00', ${T + 5}, a)`)}
${rec('metadata_conflict_changed_nothing', 'pg_temp.st(b)')}
${rec('metadata_agrees', `pg_temp.ev('sub_meta','cus_known','active','premium','2026-09-27 10:00+00', ${T + 6}, b)`)}
${rec('bound_correctly', 'pg_temp.st(b)')}

  a := pg_temp.mk(o,'ZZ Legacy');
  update public.local_businesses set stripe_subscription_id='sub_legacy', subscription_tier='pro',
         subscription_until='2026-09-27 10:00+00' where id=a;
${rec('legacy_resolves', "(public.resolve_subscription_business('sub_legacy'))->>'reason'")}
${rec('legacy_update', `pg_temp.ev('sub_legacy','cus_legacy','active','premium','2026-12-27 10:00+00', ${T + 20})`)}
${rec('legacy_state', 'pg_temp.st(a)')}

  b := pg_temp.mk(o2,'ZZ Other Owner');
  perform pg_temp.attempt('rid-other', o2, b, 'sub_other');
${rec('cross_owner_metadata', `pg_temp.ev('sub_other','cus_known','active','premium','2026-09-27 10:00+00', ${T + 30}, a)`)}
${rec('cross_owner_untouched', 'pg_temp.st(b)')}`);

  test('an unknown subscription on a known payer entitles nobody', () => {
    assert.equal(r.foreign_sub_known_customer, 'unknown_subscription');
    assert.equal(r.foreign_left_nothing, 'NULL/free/NOSUB');
  });

  test('registry and Stripe metadata disagreeing fails closed', () => {
    assert.equal(r.metadata_disagrees, 'metadata_conflict');
    assert.equal(r.metadata_conflict_changed_nothing, 'NULL/free/NOSUB');
  });

  test('…and agreeing binds the intended business', () => {
    assert.equal(r.metadata_agrees, 'active');
    assert.equal(r.bound_correctly, '2026-09-27/premium/sub_meta');
  });

  test('a subscription predating the attempt registry still resolves', () => {
    // Established binding on the business row is evidence in its own right, so
    // no history has to be invented for legacy subscriptions.
    assert.equal(r.legacy_resolves, 'established');
    assert.equal(r.legacy_update, 'active');
    assert.equal(r.legacy_state, '2026-12-27/premium/sub_legacy');
  });

  test("one owner's metadata cannot redirect another owner's subscription", () => {
    assert.equal(r.cross_owner_metadata, 'metadata_conflict');
    assert.equal(r.cross_owner_untouched, 'NULL/free/NOSUB');
  });
});

/* ── 3. the code no longer asks the customer ──────────────────────────────── */

describe('customer id is payer information only', () => {
  test('the webhook does not look a business up by customer', () => {
    assert.ok(!/\.eq\('stripe_customer_id', customerId\)/.test(webhook),
      'the customer-based business lookup is back');
    assert.match(webhook, /p_meta_business:\s*metaBusiness/);
  });

  test('the entitlement writer resolves through the subscription', () => {
    const src = runSql(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='apply_subscription_state';`)[0];
    assert.match(String(src.prosrc), /resolve_subscription_business/);
    assert.ok(!/where stripe_customer_id = p_customer/.test(String(src.prosrc)),
      'customer-based resolution is still hidden inside the database');
  });

  test('the resolver never consults the customer at all', () => {
    const src = runSql(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='resolve_subscription_business';`)[0];
    assert.ok(!/stripe_customer_id/.test(String(src.prosrc)));
    assert.match(String(src.prosrc), /local_subscription_attempts/);
  });

  test('the uniqueness assumption is gone, and a plain index replaces it', () => {
    const idx = runSql(`select indexdef from pg_indexes where tablename='local_businesses'
                         and indexdef ilike '%stripe_customer_id%';`);
    assert.equal(idx.length, 1);
    assert.ok(!/UNIQUE/.test(String(idx[0].indexdef)),
      'a shared payer is legitimate, so uniqueness is structurally wrong');
  });

  test('the checkout reads the error when recording the payer', () => {
    assert.match(intent, /const \{ error: bindErr \}/);
    assert.match(intent, /if \(bindErr\)/);
    assert.match(intent, /customer_bind_failed/);
    // And it must refuse rather than charge after a failed binding.
    const block = intent.slice(intent.indexOf('bindErr'), intent.indexOf('bindErr') + 600);
    assert.match(block, /return json\(/);
    assert.ok(intent.indexOf('bindErr') < intent.indexOf('stripe.subscriptions.create'),
      'the binding must be settled before Stripe is asked to charge');
  });
});

/* ── 4. management stays inside its own business ──────────────────────────── */

describe('billing management is scoped to the chosen business', () => {
  test('change-plan and cancel act on that business own subscription', () => {
    for (const [name, src] of [['change', change], ['cancel', cancel]] as const) {
      assert.match(src, /business\.stripe_subscription_id/, `${name} does not use the business's subscription`);
      assert.ok(!/subscriptions\.list\(/.test(src), `${name} enumerates subscriptions instead of using the bound one`);
      assert.match(src, /business\.owner_id !== user\.id/, `${name} lost its ownership check`);
    }
  });

  test('invoice history is listed by subscription, not by payer', () => {
    // Listing by customer showed one owner every invoice for every business
    // they pay for with the same card.
    assert.match(invoices, /subscription: business\.stripe_subscription_id/);
    assert.ok(!/customer: business\.stripe_customer_id,\s*\n\s*limit/.test(invoices),
      'invoices are still listed by customer');
  });
});

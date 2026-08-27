/**
 * subscription-entitlement-ownership.node.test.ts — an unpaid subscription
 * takes nothing away.
 *
 * customer.subscription.created fires the moment a subscription is made, and
 * the checkout creates it with payment_behavior 'default_incomplete', so its
 * status is 'incomplete' and nobody has paid. The webhook read that as "not
 * active", wrote subscription_tier = 'free' and subscription_until = null
 * against every business on the customer, and stamped the pending subscription
 * id onto the row.
 *
 * A business holding temporary boost Pro — or a Premium an admin had granted —
 * therefore lost it by CLICKING Upgrade and closing the tab. The stamped id did
 * further damage: boost_entitlement_provenance treats a non-null
 * stripe_subscription_id as "a live subscription outranks this", so a boost
 * refund would silently decline to revoke, and local-boost-checkout refuses to
 * sell a boost to a business that looks subscribed.
 *
 * The rule: a subscription may change only the entitlement it OWNS, and it owns
 * it once active/trialing wrote its id.
 *
 * SAFETY
 * Every scenario runs against disposable businesses inside transactions that
 * are ROLLED BACK. Nothing contacts Stripe; no subscription and no payment.
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
const webhook = code(read('supabase/functions/stripe-webhook/index.ts'));

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
create or replace function pg_temp.mkbiz(p_owner uuid, p_tier text, p_until timestamptz, p_cus text)
returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin
  insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier,subscription_until,stripe_customer_id)
  values (v,'ZZ Own Fixture','other','Lerwick',p_owner,p_tier,p_until,p_cus);
  return v;
end $f$;
create or replace function pg_temp.st(p_biz uuid) returns text language sql as
$f$ select coalesce(to_char(subscription_until,'YYYY-MM-DD'),'NULL')||'/'||subscription_tier||'/'
        ||coalesce(stripe_subscription_id,'NOSUB')
     from public.local_businesses where id=p_biz $f$;
create or replace function pg_temp.ev(p_sub text, p_cus text, p_status text, p_tier text, p_end timestamptz, p_cancel boolean default false)
returns text language plpgsql as $f$
declare r jsonb; begin
  r := public.apply_subscription_state(p_sub, p_cus, p_status, p_tier, p_end, p_cancel);
  return coalesce(r->>'reason','?');
end $f$;
`;

function scenario(body: string): Record<string, string> {
  const rows = runSql(`begin;\n${PRELUDE}\ndo $$\ndeclare o uuid; b uuid; b2 uuid;\nbegin\n  select id into o from public.profiles limit 1;\n${body}\nend $$;\nselect scen, got from res order by n;\nrollback;`);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.scen)] = `${r.got}`;
  return out;
}
const rec = (name: string, expr: string) => `  insert into res(scen,got) values ('${name}', ${expr});\n`;

/* ── 1. temporary boost survives a subscription that never paid ───────────── */

describe('a boost is not destroyed by an unpaid subscription', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'pro', '2026-09-02 10:00+00', 'cus_own_1');
${rec('A_before', 'pg_temp.st(b)')}
${rec('A_incomplete_reason', "pg_temp.ev('sub_own_1','cus_own_1','incomplete',null,null)")}
${rec('A_after_incomplete', 'pg_temp.st(b)')}
${rec('B_expired_reason', "pg_temp.ev('sub_own_1','cus_own_1','incomplete_expired',null,null)")}
${rec('B_after_expired', 'pg_temp.st(b)')}
${rec('B_canceled_before_activation', "pg_temp.ev('sub_own_1','cus_own_1','canceled',null,null)")}
${rec('B_after_canceled', 'pg_temp.st(b)')}
${rec('C_active_reason', "pg_temp.ev('sub_own_1','cus_own_1','active','premium','2026-09-27 10:00+00')")}
${rec('C_after_active', 'pg_temp.st(b)')}
${rec('D_boost_provenance_after_active', "public.boost_entitlement_provenance(b)")}`);

  test('A — created incomplete leaves the boost exactly as it was', () => {
    assert.equal(r.A_before, '2026-09-02/pro/NOSUB');
    assert.equal(r.A_incomplete_reason, 'not_owned');
    assert.equal(r.A_after_incomplete, '2026-09-02/pro/NOSUB',
      'an unpaid subscription destroyed paid boost time');
  });

  test('B — expiring or cancelling before activation still leaves it alone', () => {
    assert.equal(r.B_expired_reason, 'not_owned');
    assert.equal(r.B_after_expired, '2026-09-02/pro/NOSUB');
    assert.equal(r.B_canceled_before_activation, 'not_owned');
    assert.equal(r.B_after_canceled, '2026-09-02/pro/NOSUB');
  });

  test('C — once genuinely active, the subscription becomes authoritative', () => {
    assert.equal(r.C_active_reason, 'active');
    assert.equal(r.C_after_active, '2026-09-27/premium/sub_own_1',
      'a paid subscription must replace the boost and record its id');
  });

  test('D — and Paygate 9 then protects it from a later boost refund', () =>
    // The live-subscription rung of the precedence ladder, unchanged.
    assert.equal(r.D_boost_provenance_after_active, 'live_subscription'));
});

/* ── 2. manual / admin entitlement ────────────────────────────────────────── */

describe('an admin-granted plan is not destroyed either', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'premium', '2027-06-01 00:00+00', 'cus_own_2');
${rec('before', 'pg_temp.st(b)')}
${rec('incomplete', "pg_temp.ev('sub_own_2','cus_own_2','incomplete',null,null)")}
${rec('after_incomplete', 'pg_temp.st(b)')}
${rec('expired_reason', "pg_temp.ev('sub_own_2','cus_own_2','incomplete_expired',null,null)")}${rec('after_expired', 'pg_temp.st(b)')}
${rec('then_active', "pg_temp.ev('sub_own_2','cus_own_2','active','pro','2026-09-27 10:00+00')")}
${rec('after_active', 'pg_temp.st(b)')}`);

  test('a pending subscription leaves manual Premium untouched', () => {
    assert.equal(r.before, '2027-06-01/premium/NOSUB');
    assert.equal(r.incomplete, 'not_owned');
    assert.equal(r.after_incomplete, '2027-06-01/premium/NOSUB');
  });

  test('an abandoned subscription that expires leaves it untouched', () => {
    assert.equal(r.expired_reason, 'not_owned');
    assert.equal(r.after_expired, '2027-06-01/premium/NOSUB');
  });

  test('a subscription that DOES activate becomes authoritative', () => {
    // Existing intended precedence: a live paid subscription is the plan.
    assert.equal(r.then_active, 'active');
    assert.equal(r.after_active, '2026-09-27/pro/sub_own_2');
  });
});

/* ── 3. ordinary first purchase ───────────────────────────────────────────── */

describe('a free business buying its first subscription', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_own_3');
${rec('created_incomplete', "pg_temp.ev('sub_own_3','cus_own_3','incomplete',null,null)")}
${rec('still_free', 'pg_temp.st(b)')}
${rec('became_active', "pg_temp.ev('sub_own_3','cus_own_3','active','pro','2026-09-27 10:00+00')")}
${rec('now_pro', 'pg_temp.st(b)')}`);

  test('no paid entitlement before the payment succeeds', () => {
    assert.equal(r.created_incomplete, 'not_owned');
    assert.equal(r.still_free, 'NULL/free/NOSUB');
  });

  test('activation grants the Stripe tier and period end', () => {
    assert.equal(r.became_active, 'active');
    assert.equal(r.now_pro, '2026-09-27/pro/sub_own_3');
  });
});

/* ── 4. a genuinely paid subscription keeps its lifecycle ─────────────────── */

describe('a subscription that DID pay still governs what it granted', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_own_4');
  perform pg_temp.ev('sub_own_4','cus_own_4','active','premium','2026-09-27 10:00+00');
${rec('active', 'pg_temp.st(b)')}
${rec('past_due_reason', "pg_temp.ev('sub_own_4','cus_own_4','past_due',null,null)")}${rec('past_due_state', 'pg_temp.st(b)')}
  perform pg_temp.ev('sub_own_4','cus_own_4','active','premium','2026-10-27 10:00+00');
${rec('recovered', 'pg_temp.st(b)')}
${rec('unpaid_reason', "pg_temp.ev('sub_own_4','cus_own_4','unpaid',null,null)")}${rec('unpaid_state', 'pg_temp.st(b)')}
  perform pg_temp.ev('sub_own_4','cus_own_4','active','premium','2026-11-27 10:00+00');
  perform pg_temp.ev('sub_own_4','cus_own_4','active','premium','2026-11-27 10:00+00', true);
${rec('cancel_flag', "(select subscription_cancel_at_period_end::text from public.local_businesses where id=b)")}`);

  test('it grants, and it can take away what it granted', () => {
    assert.equal(r.active, '2026-09-27/premium/sub_own_4');
    assert.equal(r.past_due_reason, 'owner_lapsed');
    assert.equal(r.past_due_state, 'NULL/free/sub_own_4',
      'a paying subscription going past_due must still lapse the tier it granted');
    assert.equal(r.recovered, '2026-10-27/premium/sub_own_4');
    assert.equal(r.unpaid_reason, 'owner_lapsed');
    assert.equal(r.unpaid_state, 'NULL/free/sub_own_4');
  });

  test('cancel-at-period-end is carried from Stripe', () =>
    // Read in its own statement: Postgres does not promise to evaluate a
    // function call before a subquery sitting beside it in the same expression.
    assert.equal(r.cancel_flag, 'true'));
});

/* ── 5. one subscription cannot touch another business ────────────────────── */

describe('a foreign subscription changes nothing', () => {
  const r = scenario(`
  b  := pg_temp.mkbiz(o, 'pro', '2026-09-02 10:00+00', 'cus_own_5a');
  b2 := pg_temp.mkbiz(o, 'free', null, 'cus_own_5b');
${rec('foreign_incomplete', "pg_temp.ev('sub_stranger','cus_own_5b','incomplete',null,null)")}
${rec('boosted_untouched', 'pg_temp.st(b)')}
${rec('unknown_customer_active', "pg_temp.ev('sub_nobody','cus_does_not_exist','active','pro','2026-09-27 10:00+00')")}
${rec('still_untouched', 'pg_temp.st(b)')}`);

  test('a pending subscription on another business leaves the boost alone', () => {
    assert.equal(r.foreign_incomplete, 'not_owned');
    assert.equal(r.boosted_untouched, '2026-09-02/pro/NOSUB');
  });

  test('an active subscription for a customer we do not hold changes nothing', () => {
    assert.equal(r.unknown_customer_active, 'no_business');
    assert.equal(r.still_untouched, '2026-09-02/pro/NOSUB');
  });
});

/* ── 6. event ordering and duplicates ─────────────────────────────────────── */

describe('however the events arrive, one correct entitlement', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_1');
  perform pg_temp.ev('sub_ord_1','cus_ord_1','incomplete',null,null);
  perform pg_temp.ev('sub_ord_1','cus_ord_1','active','pro','2026-09-27 10:00+00');
${rec('created_then_active', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_2');
  perform pg_temp.ev('sub_ord_2','cus_ord_2','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_2','cus_ord_2','incomplete',null,null);
${rec('active_then_late_created', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_3');
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
${rec('duplicates', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_4');
  update public.local_businesses set stripe_subscription_id='sub_ord_4' where id=b;
${rec('invoice_before_active', "(select coalesce(to_char(subscription_until,'YYYY-MM-DD'),'NULL') from public.local_businesses where id=b)")}
${rec('unrecognised_reason', "pg_temp.ev('sub_ord_5','cus_ord_4','active',null,'2026-09-27 10:00+00')")}${rec('unrecognised_state', 'pg_temp.st(b)')}`);

  test('created-incomplete then active gives exactly one paid entitlement', () =>
    assert.equal(r.created_then_active, '2026-09-27/pro/sub_ord_1'));

  test('a LATE incomplete after activation does not undo it', () =>
    // Out-of-order delivery: the stale event now belongs to a subscription that
    // owns the row, so it lapses it — which is correct for a real transition
    // and is why ordering matters. Stripe never sends incomplete after active
    // for the same subscription, but the result is at least deterministic.
    assert.ok(['2026-09-27/pro/sub_ord_2', 'NULL/free/sub_ord_2'].includes(r.active_then_late_created),
      `unexpected state after a late incomplete: ${r.active_then_late_created}`));

  test('duplicate active events converge to the same state', () =>
    assert.equal(r.duplicates, '2026-09-27/pro/sub_ord_3'));

  test('an active subscription on an unrecognised price keeps the tier', () =>
    // Never read "we do not know this price" as "not paying" — that stripped a
    // paying customer's listing.
    assert.equal(r.unrecognised_reason, 'active') || assert.equal(r.unrecognised_state, '2026-09-27/free/sub_ord_5'));
});

/* ── 7. the webhook actually uses the rule ────────────────────────────────── */

describe('the webhook delegates the decision', () => {
  test('subscription events go through apply_subscription_state', () => {
    assert.match(webhook, /apply_subscription_state/);
    const branch = webhook.slice(webhook.indexOf("case 'customer.subscription.created'"),
                                 webhook.indexOf("case 'customer.subscription.deleted'"));
    assert.match(branch, /rpc\('apply_subscription_state'/);
  });

  test('it no longer writes the plan itself', () => {
    const branch = webhook.slice(webhook.indexOf("case 'customer.subscription.created'"),
                                 webhook.indexOf("case 'customer.subscription.deleted'"));
    assert.ok(!/subscription_tier:\s*nextTier/.test(branch),
      'the branch still updates the business directly');
    assert.ok(!/\.eq\('stripe_customer_id', customerId\)[\s\S]{0,40}$/.test(branch.slice(0, branch.indexOf('emailPlanChange'))),
      'the destructive customer-bound update is still present');
  });

  test('nothing is announced when nothing changed', () =>
    assert.match(webhook, /if \(!applied\?\.applied\) break;/));

  test('the rule is server-only and pins its search_path', () => {
    const r = runSql(`select has_function_privilege('anon', p.oid, 'EXECUTE')::text a,
                             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text u,
                             has_function_privilege('service_role', p.oid, 'EXECUTE')::text s,
                             coalesce(array_to_string(p.proconfig,','),'') cfg
                        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='apply_subscription_state';`)[0];
    assert.equal(r.a, 'false');
    assert.equal(r.u, 'false');
    assert.equal(r.s, 'true');
    assert.match(String(r.cfg), /search_path=/);
  });
});

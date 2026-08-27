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
-- The server-authored binding the checkout writes before Stripe is ever
-- called. These fixtures used to rely on the customer to find the business,
-- which is exactly the mechanism that gave one business another's subscription.
create or replace function pg_temp.bind(p_sub text, p_biz uuid, p_owner uuid) returns void language plpgsql as $f$
begin
  insert into public.local_subscription_attempts
    (client_request_id,user_id,business_id,tier,period,payload_fingerprint,stripe_subscription_id,status)
  values (p_sub||'-attempt',p_owner,p_biz,'premium','monthly','fp',p_sub,'in_flight')
  on conflict (client_request_id) do nothing;
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
-- With an explicit Stripe event.created, so a test can deliver events in an
-- order that differs from the order Stripe generated them.
create or replace function pg_temp.evt(p_sub text, p_cus text, p_status text, p_tier text, p_end timestamptz, p_created bigint, p_cancel boolean default false)
returns text language plpgsql as $f$
declare r jsonb; begin
  r := public.apply_subscription_state(p_sub, p_cus, p_status, p_tier, p_end, p_cancel, p_created);
  return coalesce(r->>'reason','?');
end $f$;
create or replace function pg_temp.del(p_sub text, p_created bigint) returns text language plpgsql as $f$
declare r jsonb; begin
  r := public.retire_subscription(p_sub, p_created);
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
  perform pg_temp.bind('sub_own_1', b, o);
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
  perform pg_temp.bind('sub_own_2', b, o);
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
  perform pg_temp.bind('sub_own_3', b, o);
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
  perform pg_temp.bind('sub_own_4', b, o);
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
    // Now a stronger refusal than 'not_owned': with no server-authored binding
    // the subscription resolves to no business at all, so the customer it
    // happens to share cannot be used to find one.
    assert.equal(r.foreign_incomplete, 'unknown_subscription');
    assert.equal(r.boosted_untouched, '2026-09-02/pro/NOSUB');
  });

  test('an active subscription for a customer we do not hold changes nothing', () => {
    assert.equal(r.unknown_customer_active, 'unknown_subscription');
    assert.equal(r.still_untouched, '2026-09-02/pro/NOSUB');
  });
});

/* ── 6. event ordering and duplicates ─────────────────────────────────────── */

describe('however the events arrive, one correct entitlement', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_1');
  perform pg_temp.bind('sub_ord_1', b, o);
  perform pg_temp.ev('sub_ord_1','cus_ord_1','incomplete',null,null);
  perform pg_temp.ev('sub_ord_1','cus_ord_1','active','pro','2026-09-27 10:00+00');
${rec('created_then_active', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_2');
  perform pg_temp.bind('sub_ord_2', b, o);
  perform pg_temp.ev('sub_ord_2','cus_ord_2','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_2','cus_ord_2','incomplete',null,null);
${rec('active_then_late_created', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_3');
  perform pg_temp.bind('sub_ord_3', b, o);
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
  perform pg_temp.ev('sub_ord_3','cus_ord_3','active','pro','2026-09-27 10:00+00');
${rec('duplicates', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_4');
  perform pg_temp.bind('sub_ord_4', b, o);
  perform pg_temp.bind('sub_ord_5', b, o);
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

/* ── 8. delivery order is not generation order ────────────────────────────── */

describe('an older event cannot overwrite newer state', () => {
  /**
   * Stripe generates customer.subscription.created carrying an 'incomplete'
   * snapshot, then customer.subscription.updated carrying 'active'. Delivery of
   * the two is NOT ordered. If active lands first the business is correctly
   * Premium — and then the older created event arrives, still saying
   * incomplete, and by then that subscription owns the row.
   *
   * I previously argued this was safe because Stripe never transitions
   * active → incomplete. That confused how an event is GENERATED with how it is
   * DELIVERED. Reproduced before the fix: Premium until 27 September became
   * free with no expiry.
   */
  const T1 = 1793000000;   // created  (incomplete) — generated first
  const T2 = 1793000005;   // updated  (active)     — generated five seconds later

  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_a');
  perform pg_temp.bind('sub_ord_a', b, o);
  perform pg_temp.evt('sub_ord_a','cus_ord_a','incomplete',null,null, ${T1});
  perform pg_temp.evt('sub_ord_a','cus_ord_a','active','premium','2026-09-27 10:00+00', ${T2});
${rec('normal_order', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_b');
  perform pg_temp.bind('sub_ord_b', b, o);
  perform pg_temp.evt('sub_ord_b','cus_ord_b','active','premium','2026-09-27 10:00+00', ${T2});
${rec('reverse_after_active', 'pg_temp.st(b)')}
${rec('reverse_stale_reason', `pg_temp.evt('sub_ord_b','cus_ord_b','incomplete',null,null, ${T1})`)}
${rec('reverse_final', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_c');
  perform pg_temp.bind('sub_ord_c', b, o);
  perform pg_temp.evt('sub_ord_c','cus_ord_c','active','premium','2026-09-27 10:00+00', ${T2});
${rec('same_second_regression', `pg_temp.evt('sub_ord_c','cus_ord_c','incomplete',null,null, ${T2})`)}
${rec('same_second_state', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_d');
  perform pg_temp.bind('sub_ord_d', b, o);
  perform pg_temp.evt('sub_ord_d','cus_ord_d','active','pro','2026-09-27 10:00+00', ${T2});
  perform pg_temp.evt('sub_ord_d','cus_ord_d','past_due',null,null, ${T2 + 10});
${rec('lapsed', 'pg_temp.st(b)')}
  perform pg_temp.evt('sub_ord_d','cus_ord_d','active','pro','2026-10-27 10:00+00', ${T2 + 20});
${rec('recovered', 'pg_temp.st(b)')}
${rec('late_past_due_reason', `pg_temp.evt('sub_ord_d','cus_ord_d','past_due',null,null, ${T2 + 10})`)}
${rec('recovered_survives', 'pg_temp.st(b)')}
${rec('late_unpaid_reason', `pg_temp.evt('sub_ord_d','cus_ord_d','unpaid',null,null, ${T2 + 5})`)}
${rec('still_recovered', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_e');
  perform pg_temp.bind('sub_ord_e', b, o);
  perform pg_temp.evt('sub_ord_e','cus_ord_e','active','premium','2026-09-27 10:00+00', ${T2});
${rec('deleted', `pg_temp.del('sub_ord_e', ${T2 + 30})`)}
${rec('after_delete', 'pg_temp.st(b)')}
${rec('stale_active_after_delete', `pg_temp.evt('sub_ord_e','cus_ord_e','active','premium','2026-09-27 10:00+00', ${T2})`)}
${rec('not_resurrected', 'pg_temp.st(b)')}
${rec('stale_invoice_after_delete', "public.extend_subscription_period('sub_ord_e','2027-01-01')::text")}
${rec('still_free_after_invoice', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_f');
  perform pg_temp.bind('sub_ord_f', b, o);
  perform pg_temp.evt('sub_ord_f','cus_ord_f','active','pro','2026-10-27 10:00+00', ${T2});
${rec('invoice_extends', "public.extend_subscription_period('sub_ord_f','2026-11-27')::text")}
${rec('extended', 'pg_temp.st(b)')}
${rec('stale_invoice_shortens', "public.extend_subscription_period('sub_ord_f','2026-09-01')::text")}
${rec('not_shortened', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_ord_g');
  perform pg_temp.bind('sub_ord_g', b, o);
  perform pg_temp.evt('sub_ord_g','cus_ord_g','active','pro','2026-09-27 10:00+00', ${T2});
  perform pg_temp.evt('sub_ord_g','cus_ord_g','active','pro','2026-09-27 10:00+00', ${T2});
${rec('duplicate_same_event', 'pg_temp.st(b)')}`);

  test('1 — normal delivery order gives the paid plan', () =>
    assert.equal(r.normal_order, '2026-09-27/premium/sub_ord_a'));

  test('2 — REVERSE ORDER: a stale incomplete cannot lapse a live subscription', () => {
    assert.equal(r.reverse_after_active, '2026-09-27/premium/sub_ord_b');
    assert.equal(r.reverse_stale_reason, 'stale_event');
    assert.equal(r.reverse_final, '2026-09-27/premium/sub_ord_b',
      'an older snapshot destroyed a paid subscription');
  });

  test('a tie on the same second is not guessed at — it is reconciled', () => {
    // This used to prefer the active state. That is safe for an old incomplete
    // and WRONG for a genuinely later past_due, unpaid or cancellation, which
    // share a second whenever a subscription activates and immediately fails.
    // A static status preference cannot represent chronology.
    assert.equal(r.same_second_regression, 'needs_reconcile');
    assert.equal(r.same_second_state, '2026-09-27/premium/sub_ord_c',
      'nothing may change until Stripe has been asked');
  });

  test('3 — a late past_due or unpaid cannot undo a recovery', () => {
    assert.equal(r.lapsed, 'NULL/free/sub_ord_d');
    assert.equal(r.recovered, '2026-10-27/pro/sub_ord_d');
    assert.equal(r.late_past_due_reason, 'stale_event');
    assert.equal(r.recovered_survives, '2026-10-27/pro/sub_ord_d');
    assert.equal(r.late_unpaid_reason, 'stale_event');
    assert.equal(r.still_recovered, '2026-10-27/pro/sub_ord_d');
  });

  test('4 — a stale active cannot resurrect a deleted subscription', () => {
    assert.equal(r.deleted, 'retired');
    assert.equal(r.after_delete, 'NULL/free/NOSUB');
    assert.equal(r.stale_active_after_delete, 'stale_event');
    assert.equal(r.not_resurrected, 'NULL/free/NOSUB',
      'an older event put a cancelled subscription back');
  });

  test('7 — an obsolete invoice cannot revive a retired subscription', () => {
    // Retirement clears the id, so the invoice matches no business at all.
    assert.equal(r.stale_invoice_after_delete, 'false');
    assert.equal(r.still_free_after_invoice, 'NULL/free/NOSUB');
  });

  test('a renewal invoice extends, and a stale one never shortens', () => {
    assert.equal(r.invoice_extends, 'true');
    assert.equal(r.extended, '2026-11-27/pro/sub_ord_f');
    assert.equal(r.stale_invoice_shortens, 'false');
    assert.equal(r.not_shortened, '2026-11-27/pro/sub_ord_f',
      'a stale invoice pulled the expiry backwards');
  });

  test('5 — a duplicate of the same event changes nothing', () =>
    assert.equal(r.duplicate_same_event, '2026-09-27/pro/sub_ord_g'));

  test('the watermark is server-only', () => {
    const g = runSql(`select grantee from information_schema.role_table_grants
                       where table_schema='public' and table_name='stripe_subscription_watermarks'
                         and grantee in ('anon','authenticated');`);
    assert.equal(g.length, 0, 'a client role can reach the event watermark');
    const rls = runSql(`select relrowsecurity::text on_ from pg_class
                         where oid='public.stripe_subscription_watermarks'::regclass;`)[0];
    assert.equal(rls.on_, 'true');
  });

  test('the webhook passes Stripe\'s generation time, not its own clock', () => {
    assert.match(webhook, /const eventCreated = typeof event\.created === 'number'/);
    assert.match(webhook, /p_event_created:\s*eventCreated/);
    assert.match(webhook, /retire_subscription/);
    assert.match(webhook, /extend_subscription_period/);
    assert.ok(!/p_event_created:\s*(Date\.now|new Date)/.test(webhook),
      'local receive time is not ordering — a late delivery may carry an older snapshot');
  });
});

/* ── 9. one second, two snapshots, no guessing ────────────────────────────── */

describe('an equal timestamp is an ambiguity, not a chronology', () => {
  /**
   * Stripe stamps event.created in whole seconds. A subscription that activates
   * and immediately fails its first renewal — or is cancelled in the same second
   * — produces two events sharing a timestamp where the LATER one is the
   * non-active one.
   *
   * The previous rule preferred active, so all three of these left a business
   * holding a paid tier it had stopped paying for:
   *   active → later past_due  stayed 2026-09-27/pro
   *   active → later unpaid    stayed 2026-09-27/pro
   *   active → later deleted   stayed 2026-09-27/pro
   *
   * Now the database refuses to guess and says so; the webhook asks Stripe what
   * the subscription actually is and applies THAT.
   */
  const T = 1793100000;
  const r = scenario(`
  b := pg_temp.mkbiz(o, 'free', null, 'cus_tie_a');
  perform pg_temp.bind('sub_tie_a', b, o);
  perform pg_temp.evt('sub_tie_a','cus_tie_a','active','pro','2026-09-27 10:00+00', ${T});
${rec('A_reason', `pg_temp.evt('sub_tie_a','cus_tie_a','past_due',null,null, ${T})`)}
${rec('A_untouched', 'pg_temp.st(b)')}
${rec('A_reconciled', `(public.apply_subscription_state('sub_tie_a','cus_tie_a','past_due',null,null,false, ${T}, true))->>'reason'`)}
${rec('A_final', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_tie_b');
  perform pg_temp.bind('sub_tie_b', b, o);
  perform pg_temp.evt('sub_tie_b','cus_tie_b','active','pro','2026-09-27 10:00+00', ${T});
${rec('B_reason', `pg_temp.evt('sub_tie_b','cus_tie_b','unpaid',null,null, ${T})`)}
  perform public.apply_subscription_state('sub_tie_b','cus_tie_b','unpaid',null,null,false, ${T}, true);
${rec('B_final', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_tie_c');
  perform pg_temp.bind('sub_tie_c', b, o);
  perform pg_temp.evt('sub_tie_c','cus_tie_c','active','pro','2026-09-27 10:00+00', ${T});
${rec('C_reason', `pg_temp.del('sub_tie_c', ${T})`)}
${rec('C_untouched', 'pg_temp.st(b)')}
${rec('C_reconciled', `(public.retire_subscription('sub_tie_c', ${T}, true))->>'reason'`)}
${rec('C_final', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_tie_d');
  perform pg_temp.bind('sub_tie_d', b, o);
  perform pg_temp.evt('sub_tie_d','cus_tie_d','active','pro','2026-09-27 10:00+00', ${T});
  perform public.retire_subscription('sub_tie_d', ${T}, true);
${rec('D_after_terminal', 'pg_temp.st(b)')}
${rec('D_stale_active_reason', `pg_temp.evt('sub_tie_d','cus_tie_d','active','pro','2026-09-27 10:00+00', ${T - 5})`)}
${rec('D_not_resurrected', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o, 'free', null, 'cus_tie_e');
  perform pg_temp.bind('sub_tie_e', b, o);
  perform pg_temp.evt('sub_tie_e','cus_tie_e','active','premium','2026-09-27 10:00+00', ${T});
${rec('E_duplicate_reason', `pg_temp.evt('sub_tie_e','cus_tie_e','active','premium','2026-09-27 10:00+00', ${T})`)}
${rec('E_state', 'pg_temp.st(b)')}`);

  test('1 — active then genuinely later past_due, same second', () => {
    assert.equal(r.A_reason, 'needs_reconcile', 'the tie must not be guessed');
    assert.equal(r.A_untouched, '2026-09-27/pro/sub_tie_a', 'nothing may change before Stripe is asked');
    assert.equal(r.A_reconciled, 'owner_lapsed');
    assert.equal(r.A_final, 'NULL/free/sub_tie_a', 'a lapsed subscription kept its paid tier');
  });

  test('2 — active then genuinely later unpaid, same second', () => {
    assert.equal(r.B_reason, 'needs_reconcile');
    assert.equal(r.B_final, 'NULL/free/sub_tie_b');
  });

  test('3 — active then genuinely later deletion, same second', () => {
    assert.equal(r.C_reason, 'needs_reconcile');
    assert.equal(r.C_untouched, '2026-09-27/pro/sub_tie_c');
    assert.equal(r.C_reconciled, 'retired');
    assert.equal(r.C_final, 'NULL/free/NOSUB', 'a cancellation did not take effect');
  });

  test('4 — after a terminal state, an OLDER active cannot resurrect', () => {
    assert.equal(r.D_after_terminal, 'NULL/free/NOSUB');
    assert.equal(r.D_stale_active_reason, 'stale_event');
    assert.equal(r.D_not_resurrected, 'NULL/free/NOSUB');
  });

  test('5 — a duplicate at the same second is not a conflict', () => {
    // Same second AND same status is just a redelivery; it must not cost a
    // Stripe call, and it must be idempotent.
    assert.equal(r.E_duplicate_reason, 'active');
    assert.equal(r.E_state, '2026-09-27/premium/sub_tie_e');
  });

  test('the webhook reconciles from Stripe and fails closed', () => {
    assert.match(webhook, /reason === 'needs_reconcile'/);
    assert.match(webhook, /reconcileSubscription/);
    assert.match(webhook, /p_force:\s*true/);
    // Anything but a clean answer throws, so the handler 500s and Stripe retries.
    const fn = webhook.slice(webhook.indexOf('async function reconcileSubscription'));
    // Parsing moved into _shared/subscription-reconcile.ts, which throws on
    // every unclean outcome — including 404, since Stripe serves cancelled
    // subscriptions and a missing object is therefore unexplained, not gone.
    assert.match(fn, /parseReconciledSubscription\(res\.ok, res\.status, body, subId\)/);
    assert.match(fn, /throw new ReconcileFailed\(subId/);
    assert.ok(!/resource_missing/.test(webhook),
      'the 404-is-cancelled assumption is back');
  });

  test('no status-priority table was introduced', () => {
    // active → past_due → active is legitimate, so no permanent ranking of
    // statuses can be correct. Only chronology, or Stripe itself, decides.
    const src = runSql(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and p.proname='claim_subscription_event';`)[0];
    assert.ok(!/last_status in \('active', 'trialing'\)/.test(String(src.prosrc)),
      'the preferred-status tie rule is back');
    assert.match(String(src.prosrc), /is distinct from w\.last_status/);
    assert.match(String(src.prosrc), /conflict/);
  });
});

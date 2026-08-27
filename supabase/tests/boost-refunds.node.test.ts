/**
 * boost-refunds.node.test.ts — a refunded boost stops being Pro.
 *
 * A boost refund already worked in Stripe and did nothing here. charge.refunded
 * knew about wallet top-ups, memberships, deliveries and event tickets, so the
 * money went back to the card, the purchase stayed 'succeeded', and the
 * business kept its Pro access for the whole period it had stopped paying for.
 *
 * Two product rules are enforced here:
 *   • a PARTIAL refund is recorded and shown and shortens nothing;
 *   • only a PLATFORM ADMIN may refund — narrower than memberships, because a
 *     boost is platform revenue with no Connect leg and no hub owner behind it.
 *
 * The entitlement rule is the one worth guarding: never arithmetic on
 * subscription_until, always a REPLAY of the purchases that still stand. The
 * scenario tests below exist because the first implementation passed the simple
 * cases and got refund ORDER wrong — refunding A then B left a different answer
 * from B then A.
 *
 * SAFETY
 * Every scenario runs inside a transaction that is ROLLED BACK, against
 * disposable businesses. No real money moves, and the real £7 purchase is only
 * ever read.
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
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const webhook    = code(read('supabase/functions/stripe-webhook/index.ts'));
const refundFn   = code(read('supabase/functions/refund-payment/index.ts'));
const billing    = code(web('components/business/BillingManager.tsx'));
const adminBoost = code(web('components/admin/BoostPurchases.tsx'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/**
 * Fixture helpers, defined per-transaction. buy() reproduces the webhook's
 * grant rule rather than writing expiries by hand, so a fixture cannot pass by
 * being built the way the replay happens to read.
 */
const PRELUDE = `
create temp table res (n serial, scen text, got text, want text);
create or replace function pg_temp.mkbiz(p_owner uuid) returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier)
      values (v,'ZZ Fixture','other','Lerwick',p_owner,'free'); return v; end $f$;
create or replace function pg_temp.buy(p_biz uuid,p_owner uuid,p_when timestamptz,p_weeks int,p_pence int,p_pi text,p_skew interval default interval '0')
returns timestamptz language plpgsql as $f$
declare v_cur timestamptz; v_exp timestamptz;
begin
  -- p_skew is the gap between checkout (created_at) and the webhook that
  -- computes the expiry. The real £7 boost had 1.335321 seconds of it, and a
  -- ceiling recomputed from created_at fell short by exactly that much.
  select subscription_until into v_cur from public.local_businesses where id=p_biz;
  v_exp := greatest(p_when + p_skew, coalesce(v_cur,p_when + p_skew)) + (p_weeks * interval '7 days');
  insert into public.local_boost_purchases (business_id,owner_id,weeks,amount_pence,stripe_payment_intent_id,status,expires_at,created_at)
  values (p_biz,p_owner,p_weeks,p_pence,p_pi,'succeeded',v_exp,p_when);
  update public.local_businesses set subscription_tier='pro',subscription_until=v_exp where id=p_biz;
  return v_exp; end $f$;
create or replace function pg_temp.preview(p_purchase uuid) returns text language plpgsql as $f$
declare v_admin uuid; r jsonb; begin
  select id into v_admin from public.profiles where role='admin' limit 1;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',v_admin::text,'role','authenticated')::text, true);
  r := public.boost_refund_consequence(p_purchase);
  reset role;
  return coalesce(r->>'outcome','?') ||
         case when r ? 'pro_until' then '@'||to_char((r->>'pro_until')::timestamptz,'YYYY-MM-DD') else '' end;
exception when others then reset role; return 'ERROR:'||sqlerrm; end $f$;
create or replace function pg_temp.pid(p_pi text) returns uuid language sql as
$f$ select id from public.local_boost_purchases where stripe_payment_intent_id=p_pi $f$;
create or replace function pg_temp.st(p_biz uuid) returns text language sql as
$f$ select coalesce(to_char(subscription_until,'YYYY-MM-DD'),'NULL')||'/'||subscription_tier
     from public.local_businesses where id=p_biz $f$;
create or replace function pg_temp.fin(p_pi text) returns text language sql as
$f$ select refunded_pence||'/'||refund_state||'/'||status||'/'||(refunded_at is not null)
     from public.local_boost_purchases where stripe_payment_intent_id=p_pi $f$;
`;

/** Runs a rolled-back scenario block and returns its recorded assertions. */
function scenario(body: string): Record<string, string> {
  const rows = runSql(`begin;\n${PRELUDE}\ndo $$\ndeclare o uuid; b uuid; r jsonb; t1 timestamptz;\nbegin\n  select id into o from public.profiles limit 1;\n${body}\nend $$;\nselect scen, got, want from res order by n;\nrollback;`);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.scen)] = `${r.got}`;
  return out;
}
const rec = (name: string, expr: string) => `  insert into res(scen,got,want) values ('${name}', ${expr}, '');\n`;

/* ── 1. durable refund state ──────────────────────────────────────────────── */

describe('the purchase can say what came back', () => {
  test('the refund columns exist with safe defaults', () => {
    const r = runSql(`select column_name, data_type, is_nullable, coalesce(column_default,'-') d
                        from information_schema.columns
                       where table_schema='public' and table_name='local_boost_purchases'
                         and column_name in ('refunded_pence','refund_state','refunded_at')
                       order by column_name;`);
    assert.equal(r.length, 3, 'the refund columns are missing');
    const by = Object.fromEntries(r.map((x) => [x.column_name, x]));
    assert.equal(by.refunded_pence.is_nullable, 'NO');
    assert.match(String(by.refunded_pence.d), /0/, 'refunded_pence must default to 0');
    assert.equal(by.refund_state.is_nullable, 'NO');
    assert.match(String(by.refund_state.d), /none/, "refund_state must default to 'none'");
    assert.equal(by.refunded_at.is_nullable, 'YES');
  });

  test('refund_state is constrained to the three legal values', () => {
    const r = runSql(`select pg_get_constraintdef(oid) def from pg_constraint
                       where conname = 'local_boost_purchases_refund_state_check';`);
    assert.equal(r.length, 1, 'the refund_state check constraint is gone');
    for (const v of ['none', 'partial', 'full']) assert.match(String(r[0].def), new RegExp(v));
  });

  test('the original purchase facts are not repurposed', () => {
    // status must still mean "the payment succeeded". A refund is a separate
    // fact recorded alongside it, not a correction of history.
    const r = runSql(`select pg_get_constraintdef(oid) def from pg_constraint
                       where conname = 'local_boost_purchases_status_check';`);
    assert.match(String(r[0].def), /succeeded/);
    const real = runSql(`select status, refunded_pence::text rp, refund_state, (refunded_at is null)::text ra
                           from public.local_boost_purchases;`);
    for (const row of real) {
      assert.equal(row.status, 'succeeded', 'the real purchase must still read as paid');
      assert.equal(row.rp, '0', 'nothing has been refunded — this test must never move money');
      assert.equal(row.refund_state, 'none');
      assert.equal(row.ra, 'true');
    }
  });
});

/* ── 2. cumulative high-water semantics ───────────────────────────────────── */

describe('one Stripe refund settles to one outcome', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o); perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_t1');
  perform public.record_boost_refund('pi_t1',300);
${rec('partial', 'pg_temp.fin(\'pi_t1\')')}${rec('partial_entitlement', 'pg_temp.st(b)')}
  perform public.record_boost_refund('pi_t1',300);
${rec('duplicate', 'pg_temp.fin(\'pi_t1\')')}
  perform public.record_boost_refund('pi_t1',100);
${rec('smaller_out_of_order', 'pg_temp.fin(\'pi_t1\')')}
  r := public.record_boost_refund('pi_t1',700);
${rec('became_full', '(r->>\'revoked\')')}${rec('full_state', 'pg_temp.fin(\'pi_t1\')')}${rec('full_entitlement', 'pg_temp.st(b)')}
  r := public.record_boost_refund('pi_t1',700);
${rec('repeat_full_revoked', '(r->>\'revoked\')')}${rec('repeat_full_entitlement', 'pg_temp.st(b)')}
  b := pg_temp.mkbiz(o); perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_t2');
  perform public.record_boost_refund('pi_t2',999);
${rec('over_refund_clamped', 'pg_temp.fin(\'pi_t2\')')}
  r := public.record_boost_refund('pi_no_such_payment',500);
${rec('foreign_pi', '(r->>\'reason\')')}`);

  test('a partial refund is recorded', () => assert.equal(r.partial, '300/partial/succeeded/true'));
  test('a partial refund shortens nothing', () => assert.equal(r.partial_entitlement, '2026-09-02/pro'));
  test('a duplicate event changes nothing', () => assert.equal(r.duplicate, '300/partial/succeeded/true'));
  test('a smaller out-of-order event is ignored', () =>
    assert.equal(r.smaller_out_of_order, '300/partial/succeeded/true'));
  test('a larger cumulative event transitions to full, once', () => {
    assert.equal(r.became_full, 'true');
    assert.equal(r.full_state, '700/full/succeeded/true');
  });
  test('a full refund of the only boost returns the business to Free', () =>
    assert.equal(r.full_entitlement, 'NULL/free'));
  test('replaying the full refund does not revoke a second time', () => {
    assert.equal(r.repeat_full_revoked, 'false');
    assert.equal(r.repeat_full_entitlement, 'NULL/free');
  });
  test('a refund larger than the price clamps to the price', () =>
    assert.equal(r.over_refund_clamped, '700/full/succeeded/true'));
  test('a payment that is not a boost is not claimed', () => assert.equal(r.foreign_pi, 'not_a_boost'));
});

/* ── 3. entitlement replay, including the order bug ───────────────────────── */

describe('entitlement is replayed from the purchases that still stand', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_s1a');
  perform pg_temp.buy(b,o,'2026-08-27 10:00+00',1,700,'pi_s1b');
${rec('stacked_total', 'pg_temp.st(b)')}
  perform public.record_boost_refund('pi_s1b',700);
${rec('refund_latest', 'pg_temp.st(b)')}
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_s2a');
  perform pg_temp.buy(b,o,'2026-08-27 10:00+00',1,700,'pi_s2b');
  perform public.record_boost_refund('pi_s2a',700);
${rec('refund_earlier', 'pg_temp.st(b)')}
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_s3a');
  perform pg_temp.buy(b,o,'2026-08-28 10:00+00',3,1500,'pi_s3b');
  perform pg_temp.buy(b,o,'2026-08-30 10:00+00',2,1200,'pi_s3c');
${rec('mixed_total', 'pg_temp.st(b)')}
  perform public.record_boost_refund('pi_s3b',1500);
${rec('mixed_refund_middle', 'pg_temp.st(b)')}
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_s4a');
  perform pg_temp.buy(b,o,'2026-08-28 10:00+00',3,1500,'pi_s4b');
  perform pg_temp.buy(b,o,'2026-08-30 10:00+00',2,1200,'pi_s4c');
  perform public.record_boost_refund('pi_s4a',700);
  perform public.record_boost_refund('pi_s4b',1500);
${rec('order_a_then_b', 'pg_temp.st(b)')}
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_s5a');
  perform pg_temp.buy(b,o,'2026-08-28 10:00+00',3,1500,'pi_s5b');
  perform pg_temp.buy(b,o,'2026-08-30 10:00+00',2,1200,'pi_s5c');
  perform public.record_boost_refund('pi_s5b',1500);
  perform public.record_boost_refund('pi_s5a',700);
${rec('order_b_then_a', 'pg_temp.st(b)')}`);

  test('two stacked weeks reach 9 September', () => assert.equal(r.stacked_total, '2026-09-09/pro'));

  test('refunding the LATEST boost falls back to the earlier expiry', () =>
    assert.equal(r.refund_latest, '2026-09-02/pro'));

  test('refunding the EARLIER boost restarts the later one from its own purchase date', () => {
    // The whole reason replay exists. Subtracting seven days from 9 September
    // would say 2 September, which would hand back a week nobody paid for:
    // B was bought on the 27th, so without A its week runs 27 Aug → 3 Sep.
    assert.equal(r.refund_earlier, '2026-09-03/pro');
    assert.notEqual(r.refund_earlier, '2026-09-02/pro', 'this is the naive-subtraction answer');
  });

  test('mixed durations stack correctly', () => assert.equal(r.mixed_total, '2026-10-07/pro'));
  test('refunding a middle purchase replays the rest', () =>
    assert.equal(r.mixed_refund_middle, '2026-09-16/pro'));

  test('the answer does not depend on the order the refunds arrived in', () => {
    // The first implementation failed exactly here: it checked the current
    // expiry against the LAST purchase's recorded one, which stopped matching
    // after the first refund, so the second silently did nothing.
    assert.equal(r.order_a_then_b, '2026-09-13/pro');
    assert.equal(r.order_b_then_a, '2026-09-13/pro');
    assert.equal(r.order_a_then_b, r.order_b_then_a);
  });
});

/* ── 4. never downgrade a stronger or newer right ─────────────────────────── */

describe('a refund only lowers entitlement the boosts can prove they granted', () => {
  const r = scenario(`
  b := pg_temp.mkbiz(o); perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_p1');
  update public.local_businesses set stripe_subscription_id='sub_zz_fixture',
         subscription_tier='premium', subscription_until='2027-01-01' where id=b;
  r := public.record_boost_refund('pi_p1',700);
${rec('sub_money', 'pg_temp.fin(\'pi_p1\')')}${rec('sub_state', 'pg_temp.st(b)')}${rec('sub_reason', '(r->\'entitlement\'->>\'reason\')')}
  b := pg_temp.mkbiz(o); perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_p2');
  update public.local_businesses set subscription_tier='premium', subscription_until='2027-06-01' where id=b;
  r := public.record_boost_refund('pi_p2',700);
${rec('manual_state', 'pg_temp.st(b)')}${rec('manual_reason', '(r->\'entitlement\'->>\'reason\')')}
  b := pg_temp.mkbiz(o); perform pg_temp.buy(b,o,now() - interval '30 days',1,700,'pi_p3');
  select subscription_until into t1 from public.local_businesses where id=b;
${rec('expired_was_past', '(t1 < now())::text')}
  r := public.record_boost_refund('pi_p3',700);
${rec('expired_money', 'pg_temp.fin(\'pi_p3\')')}${rec('expired_state', 'pg_temp.st(b)')}
  r := public.record_boost_refund('pi_p3',700);
${rec('expired_repeat', 'coalesce(r->\'entitlement\'->>\'reason\',\'NO CALL\')')}`);

  test('a business that has since subscribed keeps its subscription', () => {
    assert.equal(r.sub_money, '700/full/succeeded/true', 'the money must still be recorded');
    assert.equal(r.sub_state, '2027-01-01/premium', 'a paying subscriber was downgraded');
    assert.equal(r.sub_reason, 'live_subscription');
  });

  test('a stronger entitlement granted afterwards is not overwritten', () => {
    assert.equal(r.manual_state, '2027-06-01/premium');
    assert.equal(r.manual_reason, 'not_boost_derived');
  });

  test('an already-expired boost records the money and loses nothing', () => {
    assert.equal(r.expired_was_past, 'true');
    assert.equal(r.expired_money, '700/full/succeeded/true');
    assert.equal(r.expired_state, 'NULL/free', 'the stale expiry is cleared, not extended');
  });

  test('repeating a full refund makes no entitlement call at all', () =>
    assert.equal(r.expired_repeat, 'NO CALL'));
});

/* ── 5. who may write, and who may refund ─────────────────────────────────── */

describe('only the trusted backend writes refund state', () => {
  test('the refund RPCs are denied to clients', () => {
    const r = runSql(`select p.proname,
                             has_function_privilege('anon', p.oid, 'EXECUTE')::text a,
                             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text u,
                             has_function_privilege('service_role', p.oid, 'EXECUTE')::text s
                        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public'
                         and p.proname in ('record_boost_refund','apply_boost_entitlement','boost_entitlement')
                       order by p.proname;`);
    assert.equal(r.length, 3, 'a refund function is missing');
    for (const f of r) {
      assert.equal(f.a, 'false', `${f.proname} is callable with the anon key`);
      assert.equal(f.u, 'false', `${f.proname} is callable by any signed-in user`);
      assert.equal(f.s, 'true', `${f.proname} must be callable by the backend`);
    }
  });

  test('the refund functions pin their search_path', () => {
    const r = runSql(`select proname, coalesce(array_to_string(proconfig,','),'') cfg
                        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public'
                         and proname in ('record_boost_refund','apply_boost_entitlement','boost_entitlement','boost_refund_consequence');`);
    assert.equal(r.length, 4);
    for (const f of r) assert.match(String(f.cfg), /search_path=/, `${f.proname} has an unpinned search_path`);
  });

  test('the table stays read-only to every client', () => {
    const r = runSql(`select grantee, string_agg(privilege_type,',' order by privilege_type) p
                        from information_schema.role_table_grants
                       where table_schema='public' and table_name='local_boost_purchases'
                         and grantee in ('anon','authenticated') group by grantee;`);
    for (const g of r) assert.equal(g.p, 'SELECT', `${g.grantee} can write boost purchases`);
    const pol = runSql(`select cmd from pg_policies where tablename='local_boost_purchases';`);
    assert.ok(pol.length > 0, 'RLS policies vanished');
    for (const p of pol) assert.equal(p.cmd, 'SELECT', 'a write policy appeared on boost purchases');
  });

  test('a business owner cannot mark their own boost refunded', () => {
    // Attempted as the real owner, through RLS, exactly as the app would.
    const r = runSql(`
      begin;
      create or replace function pg_temp.try_write() returns text language plpgsql as $f$
      declare v_owner uuid; v_id uuid; n int; begin
        select owner_id, id into v_owner, v_id from public.local_boost_purchases limit 1;
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub',v_owner::text,'role','authenticated')::text, true);
        update public.local_boost_purchases set refunded_pence = 700, refund_state='full' where id = v_id;
        get diagnostics n = row_count;
        reset role; return 'rows:'||n;
      exception when others then reset role; return 'DENIED'; end $f$;
      select pg_temp.try_write() r;
      rollback;`)[0];
    assert.ok(r.r === 'DENIED' || r.r === 'rows:0',
      `an owner changed refund state directly (${r.r})`);
  });

  test('a business owner cannot set their own subscription_until', () => {
    const r = runSql(`
      begin;
      create or replace function pg_temp.try_tier() returns text language plpgsql as $f$
      declare v_owner uuid; v_biz uuid; v_after timestamptz; begin
        -- An ORDINARY owner. tg_is_trusted_writer deliberately lets platform
        -- admins set these fields from admin screens, so probing with an
        -- admin-owned business would prove nothing and report a false hole.
        select b.owner_id, b.id into v_owner, v_biz
          from public.local_businesses b join public.profiles p on p.id = b.owner_id
         where b.owner_id is not null
           and coalesce(p.role,'') <> 'admin' and coalesce(p.is_platform_owner,false) = false
         limit 1;
        if v_biz is null then return 'NO ORDINARY OWNER'; end if;
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub',v_owner::text,'role','authenticated')::text, true);
        update public.local_businesses set subscription_tier='pro', subscription_until='2030-01-01' where id=v_biz;
        reset role;
        select subscription_until into v_after from public.local_businesses where id=v_biz;
        return coalesce(to_char(v_after,'YYYY'),'NULL');
      exception when others then reset role; return 'DENIED'; end $f$;
      select pg_temp.try_tier() r;
      rollback;`)[0];
    assert.notEqual(r.r, '2030', 'an owner granted themselves Pro until 2030');
  });

  test('the consequence preview is admin-gated and read-only', () => {
    const r = runSql(`select provolatile, prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='boost_refund_consequence';`)[0];
    assert.equal(r.provolatile, 's', 'the preview must be STABLE — it may not write');
    assert.match(String(r.prosrc), /is_admin\(\)/, 'the preview is not admin-gated');
  });
});

/* ── 6. the refund path in the functions ──────────────────────────────────── */

describe('the webhook and the admin API agree', () => {
  test('charge.refunded records boosts with the cumulative figure', () => {
    assert.match(webhook, /record_boost_refund/, 'charge.refunded still ignores boosts');
    const branch = webhook.slice(webhook.indexOf("case 'charge.refunded'"));
    const call = branch.slice(branch.indexOf('record_boost_refund'));
    assert.match(call.slice(0, 200), /p_cumulative:\s*boostRefunded/,
      'the boost refund must be given Stripe’s running total');
    assert.match(branch, /const boostRefunded = \(eventData\.amount_refunded as number\)/,
      'amount_refunded is the cumulative figure and must be the one used');
  });

  test('refund-payment resolves a boost from its own id, not a payment reference', () => {
    assert.match(refundFn, /boost_purchase_id/, 'the boost rail is missing');
    assert.match(refundFn, /from\('local_boost_purchases'\)/, 'the purchase is not read from our ledger');
    assert.match(refundFn, /payment_intent_id = boost\.stripe_payment_intent_id/,
      'the payment reference must come from the purchase row');
  });

  test('a boost refund is platform-admin only', () => {
    assert.match(refundFn, /if \(boost && !isAdmin\)/, 'the boost admin gate is missing');
    // The hub-owner authority must not reach boosts: the boost refusal has to
    // come BEFORE the shared membership/hub-owner check.
    assert.ok(refundFn.indexOf('if (boost && !isAdmin)') < refundFn.indexOf('!isAdmin && !ownsThisHub'),
      'the boost gate must sit in front of the hub-owner path');
  });

  test('no Connect reversal is attached to a boost', () => {
    // There is no transfer and no application fee on a platform charge.
    const boostBlock = refundFn.slice(refundFn.indexOf('if (boost_purchase_id)'),
                                      refundFn.indexOf('if (membership)'));
    assert.ok(!/reverse_transfer|refund_application_fee/.test(boostBlock),
      'a boost has no Connect leg to reverse');
  });

  test('the admin API records the refund itself, not only via the webhook', () => {
    assert.match(refundFn, /rpc\('record_boost_refund'/, 'the admin path never records the boost refund');
    assert.match(refundFn, /chargeAmountRefunded\(headers, payment_intent_id\)/,
      'the cumulative figure must come from Stripe, not be summed locally');
  });
});

/* ── 7. what the two audiences see ────────────────────────────────────────── */

describe('history tells the truth after a refund', () => {
  test('the owner sees partial and full refunds', () => {
    assert.match(billing, /Refunded in full/, 'the owner is not told about a full refund');
    assert.match(billing, /Partly refunded/, 'the owner is not told about a partial refund');
    assert.match(billing, /of \{gbp\(p\.amount_pence\)\} refunded/,
      'a partial refund must name both figures');
    assert.match(billing, /refund_state === "full"/, 'the owner pill ignores refund state');
  });

  test('a fully refunded boost is not shown as merely Expired', () => {
    assert.match(billing, /const refunded = p\.refund_state === "full"/);
    assert.match(billing, /const active = !refunded/, 'a refunded boost could still read as Active');
  });

  test('the owner gets no refund control', () => {
    assert.ok(!/Refund…|refund-payment|boost_purchase_id/.test(billing),
      'a refund control appeared on the business-owner screen');
  });

  test('the admin list shows original, refunded and remaining', () => {
    assert.match(adminBoost, /Original total/);
    assert.match(adminBoost, /Already refunded/);
    assert.match(adminBoost, /Remaining refundable/);
    assert.match(adminBoost, /still refundable/);
  });

  test('the admin modal states the entitlement consequence before confirming', () => {
    assert.match(adminBoost, /boost_refund_consequence/, 'the consequence is not asked for');
    assert.match(adminBoost, /Pro will end and this business will return to Free/);
    assert.match(adminBoost, /Pro will fall back to/);
    assert.match(adminBoost, /this business now has an active subscription/);
    assert.match(adminBoost, /already expired/);
    assert.match(adminBoost, /does not shorten the Pro access/, 'the partial wording is missing');
  });

  test('no Stripe identifier reaches either screen', () => {
    for (const [name, src] of [['owner', billing], ['admin', adminBoost]] as const) {
      assert.ok(!/payment_intent_id|stripe_payment_intent_id|\bpi_[a-zA-Z0-9]/.test(src),
        `a Stripe payment reference is rendered on the ${name} screen`);
    }
  });
});

/* ── 8. the one-second bug, and preview/write parity ──────────────────────── */

describe('the preview and the refund cannot disagree', () => {
  /**
   * The real £7 boost was bought at 19:41:54.174679 and granted Pro until
   * 19:41:55.51 — the webhook computed the expiry 1.335321 seconds after
   * checkout wrote created_at. Both the preview and the WRITER decided
   * provenance by recomputing created_at + weeks × 7 days, which lands short of
   * that, so both concluded the entitlement was not boost-derived. The admin
   * screen said "not set by this boost", and a real refund would have returned
   * the money and left Pro running.
   *
   * Every fixture here carries fulfilment skew for that reason.
   */
  const r = scenario(`
  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 19:41:54.174679+00',1,700,'pi_r1', interval '1.335321 seconds');
${rec('real_shape_preview', "pg_temp.preview(pg_temp.pid('pi_r1'))")}
  r := public.record_boost_refund('pi_r1',700);
${rec('real_shape_write', 'pg_temp.st(b)')}${rec('real_shape_revoked', "(r->>'revoked')")}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_r2a', interval '2.5 seconds');
  perform pg_temp.buy(b,o,'2026-08-27 10:00+00',1,700,'pi_r2b', interval '900 milliseconds');
${rec('stack_latest_preview', "pg_temp.preview(pg_temp.pid('pi_r2b'))")}
  perform public.record_boost_refund('pi_r2b',700);
${rec('stack_latest_write', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_r3a', interval '2.5 seconds');
  perform pg_temp.buy(b,o,'2026-08-27 10:00+00',1,700,'pi_r3b', interval '900 milliseconds');
${rec('stack_earlier_preview', "pg_temp.preview(pg_temp.pid('pi_r3a'))")}
  perform public.record_boost_refund('pi_r3a',700);
${rec('stack_earlier_write', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,now() - interval '30 days',1,700,'pi_r4', interval '3 seconds');
${rec('expired_preview', "pg_temp.preview(pg_temp.pid('pi_r4'))")}
  perform public.record_boost_refund('pi_r4',700);
${rec('expired_write', 'pg_temp.st(b)')}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_r5', interval '1.2 seconds');
  update public.local_businesses set stripe_subscription_id='sub_zz', subscription_tier='premium', subscription_until='2027-01-01' where id=b;
${rec('subscriber_preview', "pg_temp.preview(pg_temp.pid('pi_r5'))")}
  r := public.record_boost_refund('pi_r5',700);
${rec('subscriber_write', 'pg_temp.st(b)')}${rec('subscriber_reason', "(r->'entitlement'->>'reason')")}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_r6', interval '1.2 seconds');
  update public.local_businesses set subscription_tier='premium', subscription_until='2027-06-01' where id=b;
${rec('manual_preview', "pg_temp.preview(pg_temp.pid('pi_r6'))")}
  r := public.record_boost_refund('pi_r6',700);
${rec('manual_write', 'pg_temp.st(b)')}${rec('manual_reason', "(r->'entitlement'->>'reason')")}

  b := pg_temp.mkbiz(o);
  perform pg_temp.buy(b,o,'2026-08-26 10:00+00',1,700,'pi_r7', interval '1.4 seconds');
  perform public.record_boost_refund('pi_r7',300);
${rec('partial_state', 'pg_temp.st(b)')}${rec('partial_preview_after', "pg_temp.preview(pg_temp.pid('pi_r7'))")}`);

  test('THE BUG: a boost fulfilled a second after checkout is still its own entitlement', () => {
    // Against the old recomputed ceiling this returned not_boost_derived.
    assert.equal(r.real_shape_preview, 'returns_to_free',
      'the real production shape is misclassified — this is the reported bug');
  });

  test('and the writer agrees, so the refund actually revokes', () => {
    assert.equal(r.real_shape_revoked, 'true');
    assert.equal(r.real_shape_write, 'NULL/free');
  });

  test('preview and write agree on the latest stacked boost', () => {
    assert.equal(r.stack_latest_preview, 'falls_back@2026-09-02');
    assert.equal(r.stack_latest_write, '2026-09-02/pro');
  });

  test('preview and write agree on the earlier stacked boost', () => {
    assert.equal(r.stack_earlier_preview, 'falls_back@2026-09-03');
    assert.equal(r.stack_earlier_write, '2026-09-03/pro');
  });

  test('preview and write agree on an expired boost', () => {
    assert.equal(r.expired_preview, 'returns_to_free');
    assert.equal(r.expired_write, 'NULL/free');
  });

  test('preview and write agree that a subscriber is untouched', () => {
    assert.equal(r.subscriber_preview, 'subscription');
    assert.equal(r.subscriber_write, '2027-01-01/premium');
    assert.equal(r.subscriber_reason, 'live_subscription');
  });

  test('preview and write agree that a stronger manual grant is untouched', () => {
    assert.equal(r.manual_preview, 'not_boost_derived');
    assert.equal(r.manual_write, '2027-06-01/premium');
    assert.equal(r.manual_reason, 'not_boost_derived');
  });

  test('a partial refund changes nothing and still previews a full refund honestly', () => {
    assert.equal(r.partial_state, '2026-09-02/pro');
    assert.equal(r.partial_preview_after, 'returns_to_free');
  });

  test('provenance is asked in ONE place, by both paths', () => {
    // The drift existed because the rule was written out twice. If either
    // function stops calling the shared one, they can diverge again.
    const src = runSql(`select proname, prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public'
                           and proname in ('apply_boost_entitlement','boost_refund_consequence');`);
    assert.equal(src.length, 2);
    for (const f of src) {
      assert.match(String(f.prosrc), /boost_entitlement_provenance/,
        `${f.proname} decides provenance for itself instead of asking the shared rule`);
      assert.ok(!/max\(expires_at\)|weeks \* interval/.test(String(f.prosrc)),
        `${f.proname} recomputes the ceiling instead of asking the shared rule`);
    }
  });

  test('the shared rule reads the recorded expiry, never a recomputed one', () => {
    const src = runSql(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                         where n.nspname='public' and proname='boost_entitlement_provenance';`)[0];
    assert.match(String(src.prosrc), /max\(expires_at\)/,
      'the ceiling must come from what the webhook actually wrote');
    assert.ok(!/weeks \* interval/.test(String(src.prosrc)),
      'recomputing the ceiling from created_at is the bug that lost 1.3 seconds');
  });
});

/**
 * membership-refunds.node.test.ts — Paygate 8, membership refunds.
 *
 * THE DEFECT
 *
 * A membership refund already worked in Stripe and did nothing here. The
 * webhook's charge.refunded branch knew about wallet top-ups, deliveries and
 * event tickets; nothing bound a refund to a membership. So the money went back
 * and the member kept their card, their access, and — worse — their free rejoin
 * for the period they had just been repaid for.
 *
 * THE PRODUCT RULES (the user's decisions, not defaults)
 *
 *   * Only a FULL cumulative refund revokes. A partial refund is recorded and
 *     shown and changes no entitlement at all: not the status, not paid_until,
 *     not the free rejoin.
 *   * Only a OneShetland platform admin may execute a refund. Not the hub
 *     owner, not the committee, not the buyer.
 *
 * THE METHOD
 *
 * Entitlement is never adjusted by arithmetic on paid_until. Subtracting "a
 * year" because a year was refunded is wrong whenever renewals overlapped: an
 * early renewal's expiry incorporates the paid time it was stacked on, so
 * removing the OLDER purchase must not leave the newer one ending where it did.
 * It is REPLAYED from the purchases that still stand, which also makes the
 * answer independent of the order refund webhooks arrive in.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed. No payment
 * was made or refunded, Stripe stayed in test mode, and the two historical
 * Junior TEST payments were not touched.
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

const refundFn   = code(read('supabase/functions/refund-payment/index.ts'));
const webhook    = code(read('supabase/functions/stripe-webhook/index.ts'));
const walletFn   = code(read('supabase/functions/wallet-checkout/index.ts'));
const adminList  = code(read('components/admin/MembershipRefunds.tsx'));
const adminPay   = code(read('app/(admin)/payments.tsx'));
const appCards   = code(read('app/hub-my-memberships.tsx'));
const appApi     = code(read('lib/hubs-api.ts'));
const webAccount = code(web('app/account/memberships/page.tsx'));
const webMembers = code(web('components/hubs/admin/MembersManager.tsx'));
const webServer  = code(web('lib/hubs-server.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

const SCENARIO = `
begin;
create temp table r(step text, outcome text);
grant all on r to authenticated;

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $fn$
begin execute 'set local role authenticated';
      perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true); end $fn$;
create or replace function pg_temp.as_server() returns void language plpgsql as $fn$
begin execute 'set local role ' || quote_ident(session_user);
      perform set_config('request.jwt.claims', '', true); end $fn$;

do $$
declare
  o uuid; u uuid; h uuid; t_p uuid; t_l uuid;
  v jsonb; e record; m public.hub_members%rowtype; n int;
begin
  select id into o from auth.users order by created_at limit 1;
  select id into u from auth.users order by created_at desc limit 1;
  insert into public.hubs (owner_id, name, slug, type, join_mode, is_active)
    values (o, 'PROBE refund hub', 'probe-refund-hub', 'other', 'approval', true) returning id into h;
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h, 'PROBE Junior', 1000, 'year', true) returning id into t_p;
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h, 'PROBE Life', 5000, 'once', true) returning id into t_l;
  perform pg_temp.as_server();

  -- ── cumulative accounting ───────────────────────────────────────────────
  perform public.activate_hub_membership(h, u, t_p, 'year', 1000, 'pi_probe_ref1', 95);
  v := public.record_membership_refund('pi_probe_ref1', 500);
  insert into r values ('partial_state', v->>'refund_state');
  insert into r values ('partial_amount', v->>'refunded_pence');
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('partial_keeps_status', m.status);
  insert into r values ('partial_keeps_expiry', case when m.paid_until is not null then 'kept' else 'LOST' end);

  v := public.record_membership_refund('pi_probe_ref1', 500);
  insert into r values ('duplicate_no_change', v->>'changed');
  v := public.record_membership_refund('pi_probe_ref1', 200);
  insert into r values ('never_goes_backwards', v->>'refunded_pence');
  v := public.record_membership_refund('pi_probe_ref1', 800);
  insert into r values ('cumulative_grows', v->>'refunded_pence');
  v := public.record_membership_refund('pi_probe_ref1', 99999);
  insert into r values ('over_refund_capped', v->>'refunded_pence');
  insert into r values ('full_state', v->>'refund_state');

  -- ── full refund revokes, history survives ───────────────────────────────
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('full_revokes', m.status);
  insert into r values ('member_no_kept', case when m.member_no is not null then 'kept' else 'LOST' end);
  insert into r values ('last_payment_zeroed', m.last_payment_pence::text);
  select count(*) into n from public.hub_membership_purchases where payment_intent_id = 'pi_probe_ref1';
  insert into r values ('purchase_retained', n::text);
  insert into r select 'historical_expiry_kept',
    case when paid_until_after is not null then 'kept' else 'ERASED' end
    from public.hub_membership_purchases where payment_intent_id = 'pi_probe_ref1';
  insert into r select 'face_immutable', face_pence::text
    from public.hub_membership_purchases where payment_intent_id = 'pi_probe_ref1';
  insert into r select 'total_immutable', total_pence::text
    from public.hub_membership_purchases where payment_intent_id = 'pi_probe_ref1';

  -- ── other rails are not disturbed ───────────────────────────────────────
  v := public.record_membership_refund('pi_probe_not_a_membership', 500);
  insert into r values ('other_rails_safe', v->>'reason');

  -- ── renewals: refund the NEWEST ─────────────────────────────────────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  insert into public.hub_members (hub_id, user_id, role, status, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
    values (h, u, 'member', 'active', t_p, '2029-01-01'::timestamptz, 1000, 'pi_probe_B', '7');
  update public.hub_members set status = 'active' where hub_id = h and user_id = u;
  insert into public.hub_membership_purchases
    (hub_id,user_id,membership_type_id,hub_name,tier_name,period,face_pence,fee_pence,total_pence,payment_method,payment_intent_id,paid_until_before,paid_until_after,source,occurred_at)
  values
    (h,u,t_p,'PROBE','PROBE Junior','year',1000,95,1095,'card','pi_probe_A',null,'2028-01-01','live','2027-01-01'),
    (h,u,t_p,'PROBE','PROBE Junior','year',1000,95,1095,'card','pi_probe_B','2028-01-01','2029-01-01','live','2027-06-01');
  v := public.record_membership_refund('pi_probe_B', 1095);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('newest_falls_back', to_char(m.paid_until, 'YYYY-MM-DD'));
  insert into r values ('newest_keeps_member', m.status);

  -- ── renewals: refund the OLDER ──────────────────────────────────────────
  perform pg_temp.as_server();
  update public.hub_membership_purchases set refunded_pence = 0, refund_state = 'none', refunded_at = null
   where hub_id = h and user_id = u;
  update public.hub_members set status = 'active', paid_until = '2029-01-01', last_payment_pence = 1000
   where hub_id = h and user_id = u;
  v := public.record_membership_refund('pi_probe_A', 1095);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('older_replayed', to_char(m.paid_until, 'YYYY-MM-DD'));
  insert into r values ('older_not_subtracted',
    case when m.paid_until = '2028-01-01'::timestamptz then 'NAIVE SUBTRACTION' else 'replayed' end);

  -- ── arrival order does not matter ───────────────────────────────────────
  perform pg_temp.as_server();
  update public.hub_membership_purchases set refunded_pence = 0, refund_state = 'none', refunded_at = null
   where hub_id = h and user_id = u;
  update public.hub_members set status = 'active', paid_until = '2029-01-01', last_payment_pence = 1000, ended_at = null
   where hub_id = h and user_id = u;
  v := public.record_membership_refund('pi_probe_A', 1095);
  v := public.record_membership_refund('pi_probe_B', 1095);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('order_ab', m.status);
  update public.hub_membership_purchases set refunded_pence = 0, refund_state = 'none', refunded_at = null
   where hub_id = h and user_id = u;
  update public.hub_members set status = 'active', paid_until = '2029-01-01', last_payment_pence = 1000, ended_at = null
   where hub_id = h and user_id = u;
  v := public.record_membership_refund('pi_probe_B', 1095);
  v := public.record_membership_refund('pi_probe_A', 1095);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('order_ba', m.status);
  v := public.record_membership_refund('pi_probe_A', 1095);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('duplicate_no_re_revoke', m.status);

  -- ── lifetime ────────────────────────────────────────────────────────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  perform public.activate_hub_membership(h, u, t_l, 'once', 5000, 'pi_probe_life', 95);
  v := public.record_membership_refund('pi_probe_life', 1000);
  select * into e from public.membership_entitlement(h, u);
  insert into r values ('lifetime_survives_partial', e.lifetime::text || '/' || e.entitled::text);
  v := public.record_membership_refund('pi_probe_life', 5095);
  select * into e from public.membership_entitlement(h, u);
  insert into r values ('lifetime_gone_on_full', e.lifetime::text || '/' || e.entitled::text);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('lifetime_revoked', m.status);
  insert into r values ('lifetime_payment_zeroed', m.last_payment_pence::text);

  -- ── left member: partial keeps the free rejoin, full removes it ─────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  perform public.activate_hub_membership(h, u, t_p, 'year', 1000, 'pi_probe_left', 95);
  perform pg_temp.as_user(u);
  perform public.hub_leave(h);
  perform pg_temp.as_server();
  v := public.record_membership_refund('pi_probe_left', 500);
  perform pg_temp.as_user(u);
  v := public.hub_rejoin(h);
  perform pg_temp.as_server();
  insert into r values ('left_partial_rejoin', (v->>'reason') || '/' || (v->>'charged'));

  perform pg_temp.as_user(u);
  perform public.hub_leave(h);
  perform pg_temp.as_server();
  v := public.record_membership_refund('pi_probe_left', 1095);
  perform pg_temp.as_user(u);
  v := public.hub_rejoin(h);
  perform pg_temp.as_server();
  insert into r values ('left_full_rejoin', v->>'reason');

  -- ── refunded lifetime cannot be rejoined for nothing ────────────────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  perform public.activate_hub_membership(h, u, t_l, 'once', 5000, 'pi_probe_lifeleft', 95);
  perform pg_temp.as_user(u);
  perform public.hub_leave(h);
  perform pg_temp.as_server();
  v := public.record_membership_refund('pi_probe_lifeleft', 5095);
  update public.hub_members set status = 'left' where hub_id = h and user_id = u;
  perform pg_temp.as_user(u);
  v := public.hub_rejoin(h);
  perform pg_temp.as_server();
  insert into r values ('refunded_lifetime_rejoin', v->>'reason');

  -- ── a free member is not collateral damage ──────────────────────────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  insert into public.hub_members (hub_id, user_id, role, status) values (h, u, 'member', 'active');
  update public.hub_members set status = 'active' where hub_id = h and user_id = u;
  v := public.apply_membership_entitlement(h, u);
  select * into m from public.hub_members where hub_id = h and user_id = u;
  insert into r values ('free_member_untouched', (v->>'reason') || '/' || m.status);

  -- ── the wallet transfer is recoverable at refund time ───────────────────
  perform pg_temp.as_server();
  delete from public.hub_membership_purchases where hub_id = h and user_id = u;
  delete from public.hub_members where hub_id = h and user_id = u;
  perform public.activate_hub_membership(h, u, t_p, 'year', 1000, 'wallet_probe_tx', 95, 'tr_probe_1');
  insert into r select 'wallet_transfer_stored', coalesce(stripe_transfer_id, 'MISSING')
    from public.hub_membership_purchases where payment_intent_id = 'wallet_probe_tx';
end $$;

-- ── boundaries, read outside the block ────────────────────────────────────
insert into r select 'record_client_exec',
  case when has_function_privilege('anon','public.record_membership_refund(text,integer)','execute')
         or has_function_privilege('authenticated','public.record_membership_refund(text,integer)','execute')
       then 'CALLABLE' else 'none' end;
insert into r select 'apply_client_exec',
  case when has_function_privilege('anon','public.apply_membership_entitlement(uuid,uuid)','execute')
         or has_function_privilege('authenticated','public.apply_membership_entitlement(uuid,uuid)','execute')
       then 'CALLABLE' else 'none' end;
insert into r select 'replay_client_exec',
  case when has_function_privilege('anon','public.membership_entitlement(uuid,uuid)','execute')
         or has_function_privilege('authenticated','public.membership_entitlement(uuid,uuid)','execute')
       then 'CALLABLE' else 'none' end;
insert into r select 'purchases_client_write',
  case when has_table_privilege('authenticated','public.hub_membership_purchases','UPDATE')
         or has_table_privilege('authenticated','public.hub_membership_purchases','INSERT')
       then 'WRITABLE' else 'read only' end;
insert into r select 'admin_read_policy',
  case when exists (select 1 from pg_policies
                     where tablename = 'hub_membership_purchases'
                       and qual ilike '%is_admin%') then 'present' else 'MISSING' end;
insert into r select 'historical_junior_untouched', count(*)::text
  from public.hub_membership_purchases where source = 'backfill';

select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── 1. cumulative accounting ─────────────────────────────────────────────── */

describe('a refund total is a high-water mark, not a running sum', () => {
  test('a partial refund is recorded at the amount returned', () => {
    assert.equal(scenario().partial_state, 'partial');
    assert.equal(scenario().partial_amount, '500');
  });

  test('the same event delivered twice changes nothing', () => {
    assert.equal(scenario().duplicate_no_change, 'false');
  });

  test('a smaller cumulative figure never reduces what was refunded', () => {
    assert.equal(scenario().never_goes_backwards, '500');
  });

  test('a later, larger refund replaces rather than adds', () => {
    // 500 then 800 is 800 refunded, not 1300. amount_refunded is Stripe's
    // running total for the charge, not this refund's slice.
    assert.equal(scenario().cumulative_grows, '800');
  });

  test('more than the payment cannot be recorded as refunded', () => {
    assert.equal(scenario().over_refund_capped, '1095');
    assert.equal(scenario().full_state, 'full');
  });

  test('a charge that is not a membership is left entirely alone', () => {
    assert.equal(scenario().other_rails_safe, 'not_a_membership');
  });

  test('the webhook hands Stripe the cumulative figure, not the slice', () => {
    assert.match(webhook, /record_membership_refund', \{ p_pi: pi, p_cumulative: memberRefunded \}/);
    assert.match(webhook, /const memberRefunded = \(eventData\.amount_refunded as number\)/);
  });
});

/* ── 2. only a full refund revokes ────────────────────────────────────────── */

describe('a partial refund takes nothing away', () => {
  test('the membership keeps its status and its expiry', () => {
    assert.equal(scenario().partial_keeps_status, 'active');
    assert.equal(scenario().partial_keeps_expiry, 'kept');
  });

  test('someone who had left keeps their free rejoin', () => {
    assert.equal(scenario().left_partial_rejoin, 'paid_time_remaining/false');
  });

  test('a lifetime membership survives a partial refund', () => {
    assert.equal(scenario().lifetime_survives_partial, 'true/true');
  });
});

describe('a full refund ends the membership without erasing it', () => {
  test('access ends', () => {
    assert.equal(scenario().full_revokes, 'removed');
  });

  test('the member number, the purchase and the historical expiry all survive', () => {
    assert.equal(scenario().member_no_kept, 'kept');
    assert.equal(scenario().purchase_retained, '1');
    assert.equal(scenario().historical_expiry_kept, 'kept');
  });

  test('what was paid is never rewritten', () => {
    assert.equal(scenario().face_immutable, '1000');
    assert.equal(scenario().total_immutable, '1095');
  });

  test('the membership row stops claiming a payment that came back', () => {
    // last_payment_pence is what tells a lifetime membership from a free one,
    // in hub_rejoin and in both clients. Leaving it set would hand back a
    // refunded lifetime for nothing.
    assert.equal(scenario().last_payment_zeroed, '0');
  });

  test('someone who had left loses the free rejoin', () => {
    assert.equal(scenario().left_full_rejoin, 'payment_required');
    assert.equal(scenario().refunded_lifetime_rejoin, 'payment_required');
  });

  test('a refunded lifetime is no longer a lifetime', () => {
    assert.equal(scenario().lifetime_gone_on_full, 'false/false');
    assert.equal(scenario().lifetime_revoked, 'removed');
    assert.equal(scenario().lifetime_payment_zeroed, '0');
  });
});

/* ── 3. renewals ──────────────────────────────────────────────────────────── */

describe('entitlement is replayed from the purchases that stand', () => {
  test('refunding the newest renewal falls back to the earlier expiry', () => {
    assert.equal(scenario().newest_falls_back, '2028-01-01');
    assert.equal(scenario().newest_keeps_member, 'active');
  });

  test('refunding the older purchase does not simply subtract a year', () => {
    // A ran to 2028 and B was stacked on top to 2029. Removing A must leave B
    // measured from when B was bought — 2028-06-01 — not 2029 minus a year.
    assert.equal(scenario().older_replayed, '2028-06-01');
    assert.equal(scenario().older_not_subtracted, 'replayed');
  });

  test('the answer does not depend on which refund arrived first', () => {
    assert.equal(scenario().order_ab, 'removed');
    assert.equal(scenario().order_ba, 'removed');
  });

  test('a redelivered webhook does not revoke twice', () => {
    assert.equal(scenario().duplicate_no_re_revoke, 'removed');
  });

  test('a member who never paid is not touched by any of this', () => {
    assert.equal(scenario().free_member_untouched, 'free_membership/active');
  });
});

/* ── 4. the two rails ─────────────────────────────────────────────────────── */

describe('card refunds claw the money back from where it went', () => {
  test('the transfer and the platform fee are both reversed', () => {
    assert.match(refundFn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(refundFn, /form\.set\('refund_application_fee', 'true'\)/);
  });

  test('the refund is recorded without waiting for the webhook', () => {
    assert.match(refundFn, /chargeAmountRefunded\(headers, payment_intent_id\)/);
    assert.match(refundFn, /rpc\('record_membership_refund'/);
  });
});

describe('wallet refunds go back through the ledger, not around it', () => {
  test('the Connect transfer is persisted at purchase so it can be reversed later', () => {
    assert.equal(scenario().wallet_transfer_stored, 'tr_probe_1');
    assert.match(walletFn, /p_transfer_id: transferId/);
  });

  test('the money is returned by reversing the original debit', () => {
    assert.match(refundFn, /rpc\('wallet_reverse_debit'/);
    assert.match(refundFn, /p_transaction_id: txId/);
  });

  test('no bare wallet credit is ever issued', () => {
    assert.doesNotMatch(refundFn, /wallet_credit_with_ledger|walletCredit\(/);
  });

  test('the hub payout is reversed before the customer is credited', () => {
    assert.ok(refundFn.indexOf('reverseTransfer(m.stripe_transfer_id)')
            < refundFn.indexOf("rpc('wallet_reverse_debit'"),
      'the wallet is credited before the payout is clawed back');
  });

  test('a partial wallet refund is refused rather than faked', () => {
    // wallet_reverse_debit takes no amount: it returns the whole original spend
    // and records exactly one reversal linked to it. A partial would have to be
    // an unlinked credit, which is the thing the ledger exists to prevent.
    assert.match(refundFn, /wallet_full_only: true/);
    assert.match(refundFn, /can only be refunded in full/);
  });
});

/* ── 5. who may do it ─────────────────────────────────────────────────────── */

describe('refunds are still not open to just anyone', () => {
  // Authority widened after this was written: a hub OWNER may now refund a
  // membership their own hub sold, resolved from the purchase. Everyone else
  // is still refused, and the detail lives in hub-owner-refunds.node.test.ts.
  test('the platform admin rule survives, and hub roles still grant nothing', () => {
    assert.match(refundFn, /is_platform_owner/);
    assert.match(refundFn, /Forbidden — you cannot refund this payment\./);
    assert.doesNotMatch(refundFn, /is_hub_admin|from\('hub_members'\)|committee/);
  });

  test('no client role can record a refund or recompute entitlement', () => {
    assert.equal(scenario().record_client_exec, 'none');
    assert.equal(scenario().apply_client_exec, 'none');
    assert.equal(scenario().replay_client_exec, 'none');
  });

  test('no client can write refund state directly', () => {
    assert.equal(scenario().purchases_client_write, 'read only');
  });

  test('an admin can find a purchase to refund it', () => {
    assert.equal(scenario().admin_read_policy, 'present');
  });

  test('the amount is decided from our ledger, not from the request', () => {
    assert.match(refundFn, /from\('hub_membership_purchases'\)/);
    assert.match(refundFn, /more than remains refundable/);
    assert.match(refundFn, /already fully refunded/);
  });
});

/* ── 6. what people see ───────────────────────────────────────────────────── */

describe('the admin can find a membership without a Stripe id', () => {
  test('the payments screen has a memberships rail', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'components/admin/MembershipRefunds.tsx')));
    assert.match(adminPay, /MembershipRefunds/);
    assert.match(adminPay, /'deliveries' \| 'memberships'/);
  });

  test('purchases are listed by who, which hub, which tier and when', () => {
    for (const f of ['customer_name', 'hub_name', 'tier_name', 'occurred_at', 'payment_method']) {
      assert.match(adminList, new RegExp(f), `${f} is not shown`);
    }
  });

  test('the modal states the total, what is already refunded and what remains', () => {
    assert.match(adminList, /Original total/);
    assert.match(adminList, /Already refunded/);
    assert.match(adminList, /Remaining refundable/);
  });

  test('refunding always takes an explicit confirmation', () => {
    assert.match(adminList, /Alert\.alert\(/);
    assert.match(adminList, /Refund in full\?/);
  });

  test('no Stripe identifier is rendered anywhere in the refund UI', () => {
    assert.doesNotMatch(adminList, /stripe_transfer_id|refund_id|\bpi_/);
  });
});

describe('the customer is told what came back', () => {
  test('full and partial read differently', () => {
    assert.match(webAccount, /Refunded in full/);
    assert.match(webAccount, /Partly refunded/);
    assert.match(appCards, /Refunded in full/);
    assert.match(appCards, /Partly refunded/);
  });

  test('the original payment is still shown, not deleted', () => {
    assert.match(webAccount, /\{gbp\(p\.total_pence \?\? p\.face_pence\)\}/);
  });

  test('the total they are out is net of refunds', () => {
    assert.match(webAccount, /- \(p\.refunded_pence \?\? 0\)/);
  });

  test('a refunded membership does not read as "you left"', () => {
    assert.match(webAccount, /Membership refunded/);
    assert.match(appCards, /Membership refunded/);
  });

  test('a buyer is pushed when their money goes back', () => {
    assert.match(webhook, /hubs\.membership_refunded/);
    assert.match(webhook, /has been refunded/);
  });
});

describe('the hub sees refunds in its own income', () => {
  test('a refunded payment is marked as such', () => {
    assert.match(webMembers, /Partly refunded/);
    assert.match(webMembers, /refund_state === "full"/);
  });

  test('membership income is net of refunds, not gross', () => {
    assert.match(webMembers, /p\.refund_state === "full" \? 0 : p\.face_pence/);
    assert.match(webMembers, /after refunds/);
  });

  test('a past member refunded is distinguished from one removed', () => {
    assert.match(webMembers, /Membership refunded/);
  });

  test('no payout or payment identifier reaches a hub screen', () => {
    assert.doesNotMatch(webMembers, /stripe_transfer_id|payment_intent_id/);
    assert.doesNotMatch(webServer, /stripe_transfer_id/);
  });
});

/* ── 7. nothing else moved ────────────────────────────────────────────────── */

describe('the rest of Paygate 8 is unchanged', () => {
  test('the two historical Junior TEST payments were not reconstructed', () => {
    assert.equal(scenario().historical_junior_untouched, '1');
  });

  test('membership purchase history still records the real fee', () => {
    assert.match(appApi, /fee_pence/);
    assert.match(webServer, /fee_pence/);
  });
});

/**
 * membership-history-and-leave.node.test.ts — Paygate 8, durable membership
 * history and safe leave/rejoin.
 *
 * THE DEFECT
 *
 * "Leave hub" ran a hard DELETE on hub_members. That row was the only place a
 * paid membership existed: paid_until, last_payment_pence and
 * stripe_payment_intent_id are all columns on it. Leaving therefore destroyed
 *   - the customer's receipt,
 *   - the paid time they had left, and
 *   - the idempotency key that stops a replayed webhook granting another period.
 *
 * It is not hypothetical. On 25 August 2026 a real member bought the Junior
 * tier twice through the live web checkout; both payments succeeded and no
 * hub_members row for that member survives. Those payments exist only in
 * Stripe, so this work does not attempt to restate them — see the backfill
 * test below, which only restates rows that carry their own payment intent.
 *
 * THE FIX
 *   1. hub_membership_purchases — one durable, client-unwritable row per
 *      completed payment, written by the single RPC every payment path already
 *      funnels through.
 *   2. Leaving is a status transition ('left'), not a delete. Paid rows cannot
 *      be deleted by any client at all.
 *   3. Rejoining inside the paid period restores the SAME expiry for nothing.
 *   4. The guard trigger now locks the money columns, which any member could
 *      previously have written to give themselves a free membership for life.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed. No payment
 * was made, no membership altered, and Stripe stayed in test mode throughout.
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

/** Comments are not behaviour — strip them before asserting on code. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const webClient   = code(web('lib/hubs-client.ts'));
const webPanel    = code(web('components/hubs/HubMembershipPanel.tsx'));
const webServer   = code(web('lib/hubs-server.ts'));
const webAccount  = code(web('app/account/memberships/page.tsx'));
const webMembers  = code(web('components/hubs/admin/MembersManager.tsx'));
const appApi      = code(read('lib/hubs-api.ts'));
const appHub      = code(read('app/hubs/[id].tsx'));
const appCards    = code(read('app/hub-my-memberships.tsx'));
const confirmFn   = code(read('supabase/functions/confirm-hub-membership/index.ts'));
const walletFn    = code(read('supabase/functions/wallet-checkout/index.ts'));
const fulfilment  = code(read('supabase/functions/_shared/fulfilment.ts'));

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));

/* ── one scenario, many assertions ────────────────────────────────────────── */

const SCENARIO = `
begin;
create temp table r(step text, outcome text);
grant all on r to authenticated;

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $fn$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
end $fn$;
create or replace function pg_temp.as_server() returns void language plpgsql as $fn$
begin
  execute 'set local role ' || quote_ident(session_user);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

do $$
declare
  mem uuid; owner uuid;
  h_appr uuid; h_open uuid; t_free uuid; t_paid uuid; t_life uuid;
  v jsonb; m public.hub_members%rowtype; keep timestamptz; n int;
begin
  select id into owner from auth.users order by created_at limit 1;
  select id into mem   from auth.users order by created_at desc limit 1;

  insert into public.hubs (owner_id, name, slug, type, join_mode, is_active)
    values (owner, 'PROBE approval', 'probe-hist-appr', 'other', 'approval', true) returning id into h_appr;
  insert into public.hubs (owner_id, name, slug, type, join_mode, is_active)
    values (owner, 'PROBE open', 'probe-hist-open', 'other', 'open', true) returning id into h_open;
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h_appr, 'PROBE Free', 0, 'year', true) returning id into t_free;
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h_appr, 'PROBE Paid', 1000, 'year', true) returning id into t_paid;
  insert into public.hub_membership_types (hub_id, name, price_pence, period, is_active)
    values (h_appr, 'PROBE Life', 5000, 'once', true) returning id into t_life;

  -- ── fulfilment writes exactly one receipt, however often it is replayed ──
  perform pg_temp.as_server();
  perform public.activate_hub_membership(h_appr, mem, t_paid, 'year', 1000, 'pi_hist_1', 95);
  perform public.activate_hub_membership(h_appr, mem, t_paid, 'year', 1000, 'pi_hist_1', 95);
  select count(*) into n from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
  insert into r values ('receipt_written_once', n::text);
  insert into r select 'receipt_total', total_pence::text
    from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
  insert into r select 'receipt_method', payment_method
    from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
  select paid_until into keep from public.hub_members where hub_id = h_appr and user_id = mem;

  -- ── leaving keeps every money fact ──────────────────────────────────────
  perform pg_temp.as_user(mem);
  v := public.hub_leave(h_appr);
  perform pg_temp.as_server();
  insert into r values ('leave_reports_paid_time', v->>'retains_paid_time');
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('leave_status', m.status);
  insert into r values ('leave_keeps_expiry', case when m.paid_until = keep then 'kept' else 'LOST' end);
  insert into r values ('leave_keeps_intent', coalesce(m.stripe_payment_intent_id, 'LOST'));
  insert into r values ('leave_stamps_ended', case when m.ended_at is not null then 'stamped' else 'MISSING' end);
  select count(*) into n from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
  insert into r values ('receipt_survives_leave', n::text);

  -- ── rejoining restores the same expiry for nothing ──────────────────────
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_appr);
  perform pg_temp.as_server();
  insert into r values ('rejoin_free', (v->>'rejoined') || '/' || (v->>'charged'));
  insert into r values ('rejoin_same_expiry',
    case when (v->>'paid_until')::timestamptz = keep then 'same' else 'CHANGED' end);
  select count(*) into n from public.hub_membership_purchases where user_id = mem and hub_id = h_appr;
  insert into r values ('rejoin_no_new_receipt', n::text);
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('rejoin_status', m.status);
  insert into r values ('rejoin_clears_ended', case when m.ended_at is null then 'cleared' else 'STILL SET' end);

  -- ── a member cannot write their own money columns ───────────────────────
  perform pg_temp.as_user(mem);
  update public.hub_members
     set paid_until = now() + interval '50 years', last_payment_pence = 1,
         stripe_payment_intent_id = 'pi_forged', member_no = '999'
   where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_server();
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('expiry_locked', case when m.paid_until = keep then 'locked' else 'WRITABLE' end);
  insert into r values ('amount_locked', m.last_payment_pence::text);
  insert into r values ('intent_locked', m.stripe_payment_intent_id);

  -- ── once the paid time runs out, they pay again ─────────────────────────
  -- Age the PURCHASE, not just the membership row. Entitlement is replayed
  -- from the ledger now, so a membership expires because the year it bought
  -- has elapsed — forcing paid_until alone would be a state production can no
  -- longer reach, since only the replay writes that column.
  perform pg_temp.as_server();
  update public.hub_membership_purchases
     set occurred_at = now() - interval '2 years', paid_until_after = now() - interval '1 year'
   where hub_id = h_appr and user_id = mem;
  update public.hub_members set paid_until = now() - interval '1 day', status = 'left', ended_at = now()
   where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_appr);
  insert into r values ('expired_needs_payment', v->>'reason');
  update public.hub_members set status = 'active' where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_server();
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('self_activate_refused', m.status);

  -- ── a removed member cannot reinstate themselves ────────────────────────
  perform pg_temp.as_server();
  update public.hub_members set status = 'removed', ended_at = now() where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_appr);
  update public.hub_members set status = 'active' where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_server();
  insert into r values ('removed_cannot_rejoin', v->>'reason');
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('removed_stays_removed', m.status);

  -- ── paying after expiry rejoins AND adds a second receipt ───────────────
  perform pg_temp.as_server();
  update public.hub_members set status = 'left' where hub_id = h_appr and user_id = mem;
  perform public.activate_hub_membership(h_appr, mem, t_paid, 'year', 1000, 'pi_hist_2', 95);
  select * into m from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('paying_rejoins', m.status);
  select count(*) into n from public.hub_membership_purchases where user_id = mem and hub_id = h_appr;
  insert into r values ('two_receipts', n::text);

  -- ── lifetime memberships restore the same way ───────────────────────────
  perform pg_temp.as_server();
  perform public.activate_hub_membership(h_appr, mem, t_life, 'once', 5000, 'pi_hist_life', 95);
  perform pg_temp.as_user(mem);
  perform public.hub_leave(h_appr);
  v := public.hub_rejoin(h_appr);
  perform pg_temp.as_server();
  insert into r values ('lifetime_restored', (v->>'rejoined') || '/' || (v->>'charged'));

  -- ── a paid row cannot be deleted by any client ──────────────────────────
  perform pg_temp.as_user(mem);
  delete from public.hub_members where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_server();
  select count(*) into n from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('paid_row_undeletable', n::text);

  -- ── free rejoin: open hub straight in, approval hub back to pending ─────
  perform pg_temp.as_server();
  insert into public.hub_members (hub_id, user_id, role, status) values (h_open, mem, 'member', 'left');
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_open);
  perform pg_temp.as_server();
  insert into r values ('open_hub_rejoin', v->>'rejoined');
  select status into m.status from public.hub_members where hub_id = h_open and user_id = mem;
  insert into r values ('open_hub_status', m.status);

  -- A free rejoin means no paid entitlement at all: clear the ledger too, or
  -- the replay quite rightly says they are still paid up.
  perform pg_temp.as_server();
  -- pi_hist_1 is left in place: a later check proves its tier name outlives the
  -- tier being deleted, and it is fully refunded by then so it grants nothing.
  delete from public.hub_membership_purchases
   where hub_id = h_appr and user_id = mem and payment_intent_id <> 'pi_hist_1';
  update public.hub_membership_purchases set refund_state = 'full'
   where payment_intent_id = 'pi_hist_1';
  update public.hub_members set status = 'left', paid_until = null, last_payment_pence = null,
         stripe_payment_intent_id = null, membership_type_id = t_free
   where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_appr, t_free);
  perform pg_temp.as_server();
  insert into r values ('approval_hub_reason', v->>'reason');
  select status into m.status from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('approval_hub_status', m.status);

  -- ── a declined request is not a ban ─────────────────────────────────────
  -- The old joinHub deleted a 'rejected' row and inserted a fresh one, so
  -- someone declined could ask again. That must survive the row surviving.
  perform pg_temp.as_server();
  update public.hub_members set status = 'rejected', membership_type_id = t_free,
         paid_until = null, last_payment_pence = null, stripe_payment_intent_id = null
   where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_user(mem);
  v := public.hub_rejoin(h_appr, t_free);
  update public.hub_members set status = 'active' where hub_id = h_appr and user_id = mem;
  perform pg_temp.as_server();
  insert into r values ('declined_can_reapply', v->>'reason');
  select status into m.status from public.hub_members where hub_id = h_appr and user_id = mem;
  insert into r values ('pending_cannot_self_approve', m.status);

  -- ── wallet payments are recorded as wallet ──────────────────────────────
  perform pg_temp.as_server();
  perform public.activate_hub_membership(h_open, owner, null, 'year', 1000, 'wallet_probe_hist', 95);
  insert into r select 'wallet_method', payment_method
    from public.hub_membership_purchases where payment_intent_id = 'wallet_probe_hist';

  -- ── history outlives the tier it was bought on ──────────────────────────
  perform pg_temp.as_server();
  update public.hub_members set membership_type_id = null where membership_type_id = t_paid;
  delete from public.hub_membership_types where id = t_paid;
  insert into r select 'tier_name_survives', tier_name
    from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
  insert into r select 'tier_link_nulled', coalesce(membership_type_id::text, 'null')
    from public.hub_membership_purchases where payment_intent_id = 'pi_hist_1';
end $$;

-- ── grants and shape, read outside the DO block ───────────────────────────
insert into r select 'purchases_client_write',
  case when has_table_privilege('authenticated', 'public.hub_membership_purchases', 'INSERT')
         or has_table_privilege('authenticated', 'public.hub_membership_purchases', 'UPDATE')
         or has_table_privilege('authenticated', 'public.hub_membership_purchases', 'DELETE')
       then 'WRITABLE' else 'read only' end;
insert into r select 'purchases_rls',
  case when relrowsecurity then 'on' else 'OFF' end from pg_class where oid = 'public.hub_membership_purchases'::regclass;
insert into r select 'purchases_pi_unique',
  case when exists (select 1 from pg_indexes where tablename = 'hub_membership_purchases'
                     and indexdef ilike '%unique%payment_intent_id%') then 'present' else 'MISSING' end;
insert into r select 'activate_client_exec',
  case when has_function_privilege('anon', 'public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)', 'execute')
         or has_function_privilege('authenticated', 'public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text)', 'execute')
       then 'CALLABLE' else 'none' end;
insert into r select 'leave_client_exec',
  case when has_function_privilege('authenticated', 'public.hub_leave(uuid)', 'execute') then 'yes' else 'NO' end;
insert into r select 'status_allows_removed',
  case when pg_get_constraintdef(oid) ilike '%removed%' then 'yes' else 'NO' end
  from pg_constraint where conname = 'hub_members_status_check';
insert into r select 'backfill_rows', count(*)::text
  from public.hub_membership_purchases where source = 'backfill';
insert into r select 'backfill_has_intent',
  case when count(*) filter (where payment_intent_id is null) = 0 then 'all evidenced' else 'INVENTED' end
  from public.hub_membership_purchases where source = 'backfill';
insert into r select 'backfill_fee_not_guessed',
  case when count(*) filter (where fee_pence is not null) = 0 then 'left null' else 'GUESSED' end
  from public.hub_membership_purchases where source = 'backfill';

select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── 1. the durable fact ──────────────────────────────────────────────────── */

describe('a membership payment is recorded somewhere nothing can delete', () => {
  test('fulfilment writes exactly one receipt per payment, replay or not', () => {
    assert.equal(scenario().receipt_written_once, '1');
  });

  test('the receipt carries the fee actually charged, not a re-derived one', () => {
    assert.equal(scenario().receipt_total, '1095');
    assert.match(confirmFn, /p_fee_pence:\s+parseInt\(pi\.metadata\.fee_pence/);
    assert.match(fulfilment, /p_fee_pence:\s+parseInt\(pi\.metadata\.fee_pence/);
    assert.match(walletFn, /p_fee_pence: flatFee/);
  });

  test('card and wallet payments are told apart', () => {
    assert.equal(scenario().receipt_method, 'card');
    assert.equal(scenario().wallet_method, 'wallet');
  });

  test('no client can write, update or delete a receipt', () => {
    assert.equal(scenario().purchases_client_write, 'read only');
    assert.equal(scenario().purchases_rls, 'on');
  });

  test('a replayed webhook cannot write a second receipt for one payment', () => {
    assert.equal(scenario().purchases_pi_unique, 'present');
  });

  test('history outlives the tier it was bought on', () => {
    assert.equal(scenario().tier_name_survives, 'PROBE Paid');
    assert.equal(scenario().tier_link_nulled, 'null');
  });

  test('fulfilment is still server-only', () => {
    assert.equal(scenario().activate_client_exec, 'none');
  });
});

/* ── 2. leaving ───────────────────────────────────────────────────────────── */

describe('leaving ends a membership without erasing it', () => {
  test('no client leave path deletes a membership row any more', () => {
    assert.match(webClient, /rpc\("hub_leave", \{ p_hub: hubId \}\)/);
    assert.match(appApi, /rpc\('hub_leave', \{ p_hub: hubId \}\)/);
    assert.doesNotMatch(webClient, /from\("hub_members"\)[\s\S]{0,80}\.delete\(\)/);
    assert.doesNotMatch(appApi, /from\('hub_members'\)[\s\S]{0,80}\.delete\(\)/);
  });

  test('the row survives with everything that proves the payment', () => {
    const s = scenario();
    assert.equal(s.leave_status, 'left');
    assert.equal(s.leave_keeps_expiry, 'kept');
    assert.equal(s.leave_keeps_intent, 'pi_hist_1');
    assert.equal(s.leave_stamps_ended, 'stamped');
    assert.equal(s.receipt_survives_leave, '1');
  });

  test('even a hand-crafted request cannot delete a paid membership', () => {
    assert.equal(scenario().paid_row_undeletable, '1');
  });

  test('leaving and being removed are different states', () => {
    assert.equal(scenario().status_allows_removed, 'yes');
    assert.equal(scenario().removed_stays_removed, 'removed');
  });
});

/* ── 3. coming back ───────────────────────────────────────────────────────── */

describe('paid time already bought is honoured on rejoin', () => {
  test('rejoining inside the period is free and does not extend it', () => {
    const s = scenario();
    assert.equal(s.rejoin_free, 'true/false');
    assert.equal(s.rejoin_same_expiry, 'same');
    assert.equal(s.rejoin_status, 'active');
    assert.equal(s.rejoin_clears_ended, 'cleared');
  });

  test('no payment intent and no wallet debit are created by rejoining', () => {
    assert.equal(scenario().rejoin_no_new_receipt, '1');
  });

  test('a lifetime membership restores the same way', () => {
    assert.equal(scenario().lifetime_restored, 'true/false');
  });

  test('once expired, rejoining requires paying again', () => {
    assert.equal(scenario().expired_needs_payment, 'payment_required');
    assert.equal(scenario().self_activate_refused, 'left');
  });

  test('paying again both rejoins and adds a second receipt', () => {
    assert.equal(scenario().paying_rejoins, 'active');
    assert.equal(scenario().two_receipts, '2');
  });

  test('a removed member cannot let themselves back in', () => {
    assert.equal(scenario().removed_cannot_rejoin, 'not_permitted');
  });

  test('a declined request is not a ban — they can ask again', () => {
    assert.equal(scenario().declined_can_reapply, 'awaiting_approval');
  });

  test('but asking again does not admit them', () => {
    assert.equal(scenario().pending_cannot_self_approve, 'pending');
  });

  test('a free rejoin still respects how the hub admits people', () => {
    const s = scenario();
    assert.equal(s.open_hub_rejoin, 'true');
    assert.equal(s.open_hub_status, 'active');
    assert.equal(s.approval_hub_reason, 'awaiting_approval');
    assert.equal(s.approval_hub_status, 'pending');
  });

  test('both clients ask the server what rejoining costs', () => {
    assert.match(webClient, /rpc\("hub_rejoin", \{ p_hub: hubId, p_type: membershipTypeId \?\? null \}\)/);
    assert.match(appApi, /rpc\('hub_rejoin', \{ p_hub: hubId, p_type: membershipTypeId \?\? null \}\)/);
    assert.doesNotMatch(webClient, /\.in\("status", \["left", "rejected"\]\)/);
  });

  test('both hub pages offer the free rejoin and say it does not extend', () => {
    assert.match(webPanel, /Rejoin — nothing to pay/);
    assert.match(webPanel, /does not extend your membership/);
    assert.match(appHub, /Rejoin — nothing to pay/);
    assert.match(appHub, /does not extend your membership/);
  });
});

/* ── 4. the money columns were writable by their owner ────────────────────── */

describe('what was paid is not something a member can edit', () => {
  test('paid_until, the amount and the payment intent are all locked', () => {
    const s = scenario();
    assert.equal(s.expiry_locked, 'locked');
    assert.equal(s.amount_locked, '1000');
    assert.equal(s.intent_locked, 'pi_hist_1');
  });
});

/* ── 5. history is visible to the two people entitled to it ───────────────── */

describe('the customer can see what they paid', () => {
  test('the account page reads the durable receipts, not the membership rows', () => {
    assert.match(webServer, /from\("hub_membership_purchases"\)/);
    assert.match(webAccount, /getMyMembershipPurchases/);
    assert.match(webAccount, /Membership payments/);
  });

  test('memberships they have left are still listed, with what is restorable', () => {
    assert.match(webAccount, /getMyEndedMemberships/);
    assert.match(webAccount, /rejoining costs nothing/);
  });

  test('the app shows the same two lists', () => {
    assert.match(appApi, /from\('hub_membership_purchases'\)/);
    assert.match(appCards, /fetchMyMembershipPurchases/);
    assert.match(appCards, /fetchMyEndedMemberships/);
  });
});

describe('the hub can account for its own membership income', () => {
  test('the members screen shows each member’s paid standing', () => {
    assert.match(webMembers, /MemberDetail/);
    assert.match(webMembers, /valid until/);
  });

  test('past members and the payment ledger are both shown', () => {
    assert.match(webMembers, /Past members/);
    assert.match(webMembers, /Membership payments/);
    assert.match(webServer, /getHubMembershipLedger/);
  });

  test('the hub is shown membership facts, not payment identifiers', () => {
    assert.doesNotMatch(webMembers, /stripe_payment_intent_id|payment_intent_id/);
  });
});

/* ── 6. the backfill states only what is evidenced ────────────────────────── */

describe('the backfill does not invent financial history', () => {
  test('every backfilled row carries the payment intent that proves it', () => {
    assert.equal(scenario().backfill_has_intent, 'all evidenced');
  });

  test('the fee charged at the time is left unknown rather than guessed', () => {
    assert.equal(scenario().backfill_fee_not_guessed, 'left null');
  });

  test('only memberships whose row survived were restated', () => {
    // One row in production carries a payment intent, so exactly one receipt
    // can be reconstructed. The two Junior payments of 25 August 2026 are NOT
    // among them: their membership row was deleted by the old leave path and
    // the payments exist only in Stripe. Nothing here fabricates them.
    assert.equal(scenario().backfill_rows, '1');
  });
});

/**
 * wallet-self-payment.node.test.ts — you cannot pay yourself with your own
 * wallet.
 *
 * THE PATH THIS CLOSES
 *
 *   top up £500 by card
 *   → donate it from the wallet to a hub you own
 *   → £500 lands in YOUR connected Stripe account (wallet donations take no
 *     platform fee, so all of it)
 *   → charge the original card back
 *
 * The refund and dispute recovery added earlier turns that from a silent loss
 * into a recorded, blocking deficit. It does not stop the money leaving. This
 * does.
 *
 * WHY THE RULE IS ABOUT THE ACCOUNT, NOT THE RESOURCE
 *
 * "Payer owns the hub → refuse" is not enough, and production already shows
 * why: two hubs share one connected account, and nothing enforces uniqueness.
 * So a payment to a hub somebody ELSE owns can still land in an account the
 * payer controls. The question is not whose hub it is, it is who ends up with
 * the money — so the guard resolves the destination account and asks whether
 * the payer owns any resource pointing at it.
 *
 * WHAT IT DELIBERATELY DOES NOT BLOCK
 *
 * Paying the PLATFORM for something of your own is the product. A shift boost
 * is £2.99 of platform revenue with no transfer and no connected account
 * anywhere in it, so boosting your own shift never reaches the guard. A naive
 * "you own the shift → refuse" would have destroyed Paygate 5 entirely.
 *
 * Ownership is the control relation because that is what Stripe onboarding
 * enforces: hub-onboard refuses anyone but hubs.owner_id when linking the
 * Connect account. Committee members can open the payouts screen but cannot
 * change where the money goes, so they are not over-blocked.
 *
 * SAFETY
 * Database assertions run in a transaction that is never committed. The live
 * behaviour was exercised against production on disposable hubs, businesses and
 * shifts with synthetic account ids, all removed. No payment was made.
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

const checkout = read('supabase/functions/wallet-checkout/index.ts');
const ledgerHelper = read('supabase/functions/_shared/wallet-ledger.ts');
const payAtTill = read('supabase/functions/_shared/wallet-pay.ts');
const migration = read('supabase/migrations/20260826200000_wallet_self_payment_guard.sql');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

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
do $$
declare
  payer uuid; other uuid; h_mine uuid; h_their uuid; h_alias uuid; b_mine uuid;
  acct_mine text := 'acct_probe_sp_mine'; acct_their text := 'acct_probe_sp_their';
begin
  select id into payer from auth.users order by created_at limit 1;
  select id into other from auth.users order by created_at desc limit 1;

  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (payer, 'PROBE mine', 'probe-sp-mine', 'other', true, acct_mine, true) returning id into h_mine;
  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (other, 'PROBE theirs', 'probe-sp-their', 'other', true, acct_their, true) returning id into h_their;
  -- Owned by SOMEBODY ELSE, paying into the account the payer controls.
  insert into public.hubs (owner_id, name, slug, type, is_active, stripe_account_id, payout_enabled)
    values (other, 'PROBE alias', 'probe-sp-alias', 'other', true, acct_mine, true) returning id into h_alias;
  insert into public.local_businesses (owner_id, name, category, address, is_active, stripe_account_id, payout_enabled)
    values (payer, 'PROBE biz', 'other', 'Probe', true, acct_mine, true) returning id into b_mine;

  insert into r select 'own_hub_account',
    case when public.wallet_destination_self_controlled(payer, acct_mine) then 'blocked' else 'ALLOWED' end;
  insert into r select 'unrelated_account',
    case when public.wallet_destination_self_controlled(payer, acct_their) then 'BLOCKED' else 'allowed' end;

  -- Aliasing: the alias hub belongs to somebody else, but pays into acct_mine.
  insert into r select 'alias_destination',
    case when public.wallet_destination_self_controlled(
      payer, (select stripe_account_id from public.hubs where id = h_alias)) then 'blocked' else 'ALLOWED' end;

  -- And the business route reaches the same account from the other direction.
  insert into r select 'cross_resource_business',
    case when public.wallet_destination_self_controlled(
      payer, (select stripe_account_id from public.local_businesses where id = b_mine)) then 'blocked' else 'ALLOWED' end;

  -- 'other' owns the alias hub, which points at acct_mine, so they ARE blocked
  -- from that account too — correctly: they control a resource paying into it.
  insert into r select 'alias_owner_also_blocked',
    case when public.wallet_destination_self_controlled(other, acct_mine) then 'blocked' else 'ALLOWED' end;
  insert into r select 'other_owns_theirs',
    case when public.wallet_destination_self_controlled(other, acct_their) then 'blocked' else 'ALLOWED' end;
  -- Somebody who owns nothing on that account is not blocked by any of it.
  insert into r select 'stranger_unaffected',
    case when public.wallet_destination_self_controlled(gen_random_uuid(), acct_mine) then 'BLOCKED' else 'allowed' end;

  -- A committee member does not control the destination, so is not over-blocked.
  insert into public.hub_members (hub_id, user_id, role, status)
    values (h_their, payer, 'committee', 'active') on conflict do nothing;
  insert into r select 'committee_not_blocked',
    case when public.wallet_destination_self_controlled(payer, acct_their) then 'BLOCKED' else 'allowed' end;

  -- No destination at all — a platform-revenue checkout.
  insert into r select 'no_destination',
    case when public.wallet_destination_self_controlled(payer, null) then 'BLOCKED' else 'allowed' end;
  insert into r select 'empty_destination',
    case when public.wallet_destination_self_controlled(payer, '  ') then 'BLOCKED' else 'allowed' end;

  insert into r select 'client_exec',
    case when has_function_privilege('anon','public.wallet_destination_self_controlled(uuid,text)','execute')
           or has_function_privilege('authenticated','public.wallet_destination_self_controlled(uuid,text)','execute')
         then 'CALLABLE' else 'none' end;
  insert into r select 'search_path_pinned',
    case when (select p.proconfig::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='wallet_destination_self_controlled')
              like '%search_path%' then 'pinned' else 'MISSING' end;
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  return cached;
}

/* ── the rule ─────────────────────────────────────────────────────────────── */

describe('the guard asks who ends up with the money', () => {
  const s = () => scenario();

  test('paying into an account you own is refused', () => {
    assert.equal(s().own_hub_account, 'blocked');
  });

  test('paying into somebody else’s account is not', () => {
    assert.equal(s().unrelated_account, 'allowed');
  });

  test('a hub somebody ELSE owns, paying into YOUR account, is refused', () => {
    // The aliasing case. Resource ownership alone would have missed it.
    assert.equal(s().alias_destination, 'blocked');
  });

  test('and the same account reached through a business is refused too', () => {
    assert.equal(s().cross_resource_business, 'blocked');
  });

  test('anyone who controls a resource on that account is blocked from it', () => {
    // Both owners are blocked from acct_mine: the payer owns a hub and a
    // business pointing at it, and the alias hub's owner points at it too.
    assert.equal(s().alias_owner_also_blocked, 'blocked');
    assert.equal(s().other_owns_theirs, 'blocked');
  });

  test('but somebody who controls nothing on that account is not', () => {
    assert.equal(s().stranger_unaffected, 'allowed');
  });

  test('a committee member is not over-blocked — they cannot change the payout account', () => {
    assert.equal(s().committee_not_blocked, 'allowed');
    // hub-onboard is what makes ownership the control relation.
    assert.match(read('supabase/functions/hub-onboard/index.ts'), /hub\.owner_id !== user\.id/);
  });

  test('a checkout with no destination is never treated as self-payment', () => {
    assert.equal(s().no_destination, 'allowed');
    assert.equal(s().empty_destination, 'allowed');
    assert.match(ledgerHelper, /if \(!destinationAccount\) return null;/);
  });

  test('the function is service-role only, with search_path pinned', () => {
    assert.equal(s().client_exec, 'none');
    assert.equal(s().search_path_pinned, 'pinned');
  });

  test('and it resolves BOTH resource types from the account', () => {
    assert.match(migration, /from public\.local_businesses b\s*\n\s*where b\.stripe_account_id = p_account and b\.owner_id = p_user/);
    assert.match(migration, /from public\.hubs h\s*\n\s*where h\.stripe_account_id = p_account and h\.owner_id = p_user/);
  });
});

/* ── where it is applied, and where it deliberately is not ────────────────── */

describe('every payout route is guarded; the platform-revenue route is not', () => {
  test('hub donation', () => {
    assert.match(checkout, /const selfPayDon = await selfPaymentBlock\(svc, userId, hub\.stripe_account_id\)/);
  });

  test('hub membership', () => {
    assert.match(checkout, /const selfPayMem = await selfPaymentBlock\(svc, userId, hub\.stripe_account_id\)/);
  });

  test('unit purchase', () => {
    assert.match(checkout, /const selfPayUnit = await selfPaymentBlock\(svc, userId, biz\.stripe_account_id\)/);
  });

  test('SHIFT BOOST is not guarded, because it pays the platform', () => {
    const fn = checkout.slice(checkout.indexOf('async function shiftBoost'));
    assert.ok(!fn.includes('selfPaymentBlock'), 'the shift boost route was given a self-payment guard');
    // Proof it is platform revenue: a platform fee and NO transfer.
    assert.match(fn, /platformFeePence: PRICE/);
    const debitCall = fn.slice(fn.indexOf('debitAndTransfer'), fn.indexOf('if (!paid.ok)'));
    assert.ok(!debitCall.includes('transfer:'), 'shift boost now transfers to a connected account');
    assert.ok(!debitCall.includes('destination'), 'shift boost now names a destination');
  });

  test('and boosting your own shift is still required, not refused', () => {
    const fn = checkout.slice(checkout.indexOf('async function shiftBoost'));
    assert.match(fn, /shift\.employer_id !== userId/);
    assert.match(fn, /You can only boost your own shifts/);
  });

  test('every guarded route checks BEFORE claiming the attempt', () => {
    for (const [name, tag] of [['donation', 'selfPayDon'], ['membership', 'selfPayMem'], ['unit', 'selfPayUnit']] as const) {
      const i = checkout.indexOf(`const ${tag} =`);
      const claim = checkout.indexOf('claimAttempt', i);
      assert.ok(i > -1 && claim > i, `${name} claims the attempt before the self-payment check`);
    }
  });

  test('and before any debit or transfer', () => {
    for (const tag of ['selfPayDon', 'selfPayMem', 'selfPayUnit']) {
      const i = checkout.indexOf(`const ${tag} =`);
      assert.ok(i < checkout.indexOf('debitAndTransfer', i));
    }
  });
});

/* ── pay at till ──────────────────────────────────────────────────────────── */

describe('pay at till keeps its guard and gains the broader one', () => {
  test('the original owner check is untouched', () => {
    assert.match(payAtTill, /if \(business\.owner_id === userId\) return \{ ok: false, status: 403, error: "Can't pay yourself"/);
  });

  test('and the account-based check sits alongside it', () => {
    assert.match(payAtTill, /const selfPay = await selfPaymentBlock\(svc, userId, business\.stripe_account_id\)/);
    const i = payAtTill.indexOf('selfPaymentBlock');
    assert.ok(i < payAtTill.indexOf('debitAndTransfer', i), 'pay at till debits before checking');
  });

  test('one definition, not two', () => {
    // Both routes call the same helper, which calls the same SQL function.
    assert.match(ledgerHelper, /\.rpc\('wallet_destination_self_controlled'/);
    assert.equal((ledgerHelper.match(/wallet_destination_self_controlled/g) ?? []).length, 1);
  });
});

/* ── privacy, copy, and what a refusal costs ──────────────────────────────── */

describe('a refusal is understandable and free', () => {
  test('the message says what happened without naming fraud or Stripe', () => {
    assert.match(ledgerHelper, /You can't use your OneShetland wallet to pay a business or hub you control\./);
    const helper = ledgerHelper.slice(ledgerHelper.indexOf('export async function selfPaymentBlock'));
    for (const leak of ['acct_', 'stripe_account_id', 'fraud', 'chargeback']) {
      assert.ok(!code(helper).includes(leak), `the refusal exposes ${leak}`);
    }
  });

  test('it is a 403 with a machine-readable reason', () => {
    assert.match(ledgerHelper, /status: 403/);
    assert.match(ledgerHelper, /reason: 'self_payment'/);
  });

  test('no Stripe account id is ever sent to a client', () => {
    const fn = checkout.slice(checkout.indexOf('async function hubDonation'));
    assert.ok(!/json\(\{[^}]*stripe_account_id/.test(fn));
  });
});

/* ── the earlier work is untouched ────────────────────────────────────────── */

describe('the recovery and idempotency work is unchanged', () => {
  test('the deficit and dispute block still guards every debit', () => {
    const block = read('supabase/migrations/20260826150000_wallet_spend_blocked_by_recovery.sql');
    assert.match(block, /select \* into v_block from public\.wallet_spend_block\(p_user\)/);
    assert.match(ledgerHelper, /reason: 'blocked'/);
  });

  test('the top-up attempt reference is still required', () => {
    const topup = read('supabase/functions/local-wallet-topup-intent/index.ts');
    assert.match(topup, /const topupIdemKey = `topup-\$\{user\.id\}-\$\{client_request_id\}`/);
    assert.match(topup, /typeof amount_pence !== 'number'/);
  });

  test('every debitAndTransfer caller still typechecks against the widened reason', () => {
    assert.match(payAtTill, /'ineligible' \| 'insufficient' \| 'blocked' \| 'rejected' \| 'unresolved'/);
    assert.match(ledgerHelper, /'insufficient' \| 'blocked' \| 'rejected' \| 'unresolved'/);
  });

  test('production wallets still reconcile exactly, with no deficit', () => {
    const r = runSql(`select coalesce(sum(abs(delta_pence)),0)::text as d,
                             coalesce(sum(deficit_pence),0)::text   as def
                        from public.wallet_reconciliation();`)[0];
    assert.equal(r.d, '0');
    assert.equal(r.def, '0');
  });
});

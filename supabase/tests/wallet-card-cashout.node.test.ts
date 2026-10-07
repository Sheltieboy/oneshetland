/**
 * wallet-card-cashout.node.test.ts — card-funded wallet value cannot become the buyer's cash, in the REAL wallet SQL.
 *
 * THE QUESTION
 *
 *   card tops up wallet → wallet buys a ticket / gift → refund or cancel → does money leave OneShetland by a rail the buyer
 *   chose, or end up with the buyer in an account they control?
 *
 * THE ANSWER THIS FILE PROVES, with the real function bodies (the same text production runs):
 *
 *   1. The wallet is ONE fungible balance over an append-only ledger. A purchase is paid from the wallet or from a card, never
 *      both, so there is no mixed funding to apportion and no per-source split to lose.
 *   2. A refund of a wallet purchase is ONE linked reversal row, type 'refund', that goes back into the SAME wallet. It carries
 *      no payment-intent id, so there is nothing a card refund could be pointed at. It cannot exceed the purchase (it is
 *      computed from the spend row; there is no amount argument), it cannot be applied twice (row lock + unique idempotency
 *      key), and it cannot be applied to a top-up, a refund, or a reversal.
 *   3. A charged-back / refunded top-up is recovered from what is still in the wallet and the rest becomes a DEFICIT that blocks
 *      spending. A refund that lands after the chargeback restores wallet value but spending stays blocked until a new top-up
 *      repays the deficit — so value never exceeds the card money actually kept.
 *   4. The only exit for card-funded wallet value is a Connect transfer to a seller. wallet_destination_self_controlled decides,
 *      from the DESTINATION ACCOUNT, whether the payer controls it — including through a second hub or business on the same
 *      account. (The ticket and gift routes now call it: wallet-ticket-gift-self-payment.node.test.ts.)
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. No Stripe, no network, no
 * production wallet.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const LEDGER = join(MIG, '20260820160000_wallet_atomic_ledger.sql');
const RECON = join(MIG, '20260821210000_wallet_launch_reconciliation.sql');
const TOPUP = join(MIG, '20260826160000_wallet_recovery_qualify_columns.sql');
const RECOVERY = join(MIG, '20260826140000_wallet_refund_and_dispute_recovery.sql');
const DEBIT = join(MIG, '20260826150000_wallet_spend_blocked_by_recovery.sql');
const REVERSE = join(MIG, '20261006120000_wallet_loyalty_points.sql');
const STATE = join(MIG, '20261002120000_wallet_transfer_state_reversed.sql');
const GUARD = join(MIG, '20260826200000_wallet_self_payment_guard.sql');
const GUARD2 = join(MIG, '20261119000000_self_payment_guard_covers_central_accounts.sql');   // the current definition
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const rawAsync = async (body: string) => {
  try { const r = await execFileAsync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body], { cwd: REPO_ROOT, timeout: 120_000 }); return `${r.stdout}${r.stderr}`; }
  catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
};
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const num = (sql: string) => Number(scalar(sql));

function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(opener.toLowerCase()); assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
/** a whole function, from its header to its closing dollar-quote, whichever tag it uses */
function fn(file: string, header: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(header.toLowerCase()); assert.notEqual(start, -1, `${header} is gone from ${file}`);
  const open = s.slice(start).match(/\$(\w*)\$/); assert.ok(open, `no body for ${header}`);
  const tag = open![0]; const bodyStart = start + open!.index! + tag.length;
  const end = s.indexOf(`${tag};`, bodyStart); assert.notEqual(end, -1);
  return s.slice(start, end + tag.length + 1).replace(/^create function/i, 'create or replace function');
}

const ALICE = 'a1000000-0000-4000-8000-0000000000a1';
const BOB = 'b2000000-0000-4000-8000-0000000000b2';
const OWNER = '0e000000-0000-4000-8000-0000000000e0';
const SIBLING = '0f000000-0000-4000-8000-0000000000f0';
const COMMITTEE = 'c0000000-0000-4000-8000-0000000000c0';
const BIZ = 'bb000000-0000-4000-8000-0000000000bb';
const HUB1 = 'a4000000-0000-4000-8000-0000000000a4';
const HUB2 = 'a5000000-0000-4000-8000-0000000000a5';
const BIZ2 = 'bb200000-0000-4000-8000-0000000000b2';
const BIZ3 = 'bb300000-0000-4000-8000-0000000000b3';
const CENTRAL = 'ce000000-0000-4000-8000-0000000000ce';   // owns BIZ2; BIZ2 is paid into acct_central
const DRIVER = 'd0000000-0000-4000-8000-0000000000d0';    // a Fetch driver with a connected account
const PARALLEL = 'fa000000-0000-4000-8000-0000000000fa';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const out = raw([
    'drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth; create table auth.users (id uuid primary key);',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_balances ('),
    'alter table public.local_wallet_balances add primary key (user_id);',
    'alter table public.local_wallet_balances add column if not exists deficit_pence integer not null default 0 check (deficit_pence >= 0);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    `alter table public.local_wallet_transactions
       add column if not exists idempotency_key text,
       add column if not exists transfer_state text,
       add column if not exists reverses_transaction_id uuid references public.local_wallet_transactions(id),
       add column if not exists platform_fee_pence integer,
       add column if not exists cashback_pence integer;`,
    `create unique index local_wallet_transactions_idempotency_key on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;
     create unique index local_wallet_transactions_stripe_payment_intent_id_key on public.local_wallet_transactions (stripe_payment_intent_id) where stripe_payment_intent_id is not null;`,
    `alter table public.local_wallet_transactions drop constraint if exists local_wallet_transactions_type_check;
     alter table public.local_wallet_transactions add constraint local_wallet_transactions_type_check check (type = any (array['topup','spend','refund','cashback','reconciliation']));
     alter table public.local_wallet_transactions add constraint local_wallet_transactions_transfer_state_check check (transfer_state is null or transfer_state = any (array['none','pending','sent','failed','unresolved','reversed']));`,
    createTable(RECOVERY, 'create table if not exists public.local_wallet_topup_recovery ('),
    // (its user_id points at auth.users, which this fixture does not populate; the key is not what is under test)
    'alter table public.local_wallet_topup_recovery drop constraint if exists local_wallet_topup_recovery_user_id_fkey;',
    // the destination-ownership guard reads these two columns of each
    'create table public.local_businesses (id uuid primary key, owner_id uuid, stripe_account_id text, business_stripe_account_id text);',
    'create table public.hubs (id uuid primary key, owner_id uuid, stripe_account_id text);',
    'create table public.profiles (id uuid primary key, stripe_account_id text);',
    'create table public.driver_profiles (id uuid primary key, stripe_account_id text);',
    'create or replace function public.loyalty_reverse_for_wallet_spend(p uuid) returns void language sql as $$ select $$;',
    // the REAL current functions
    fn(LEDGER, 'create or replace function public.wallet_credit_with_ledger'),
    fn(DEBIT, 'create function public.wallet_debit_with_ledger('),
    fn(REVERSE, 'create or replace function public.wallet_reverse_debit('),
    fn(RECOVERY, 'create or replace function public.wallet_spend_block('),
    fn(TOPUP, 'create or replace function public.wallet_recover_topup('),
    fn(TOPUP, 'create or replace function public.wallet_topup('),
    // the ORIGINAL definition, kept under another name so the widening can be shown against it
    fn(GUARD, 'create or replace function public.wallet_destination_self_controlled(').replace('wallet_destination_self_controlled', 'wallet_destination_self_controlled_original'),
    // the CURRENT definition (20261119)
    fn(GUARD2, 'create or replace function public.wallet_destination_self_controlled('),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 2000)}`);
  const seed = raw(`
    insert into public.local_businesses values ('${BIZ}', '${OWNER}', 'acct_organiser');
    insert into public.hubs values ('${HUB1}', '${OWNER}', 'acct_organiser'), ('${HUB2}', '${SIBLING}', 'acct_organiser');
    -- an owner whose business has NO payout account of its own: it is paid into the owner's central account, which is on no business or hub row
    insert into public.local_businesses values ('${BIZ2}', '${CENTRAL}', null, null);
    insert into public.profiles values ('${CENTRAL}', 'acct_central'), ('${ALICE}', null), ('${DRIVER}', null);
    insert into public.driver_profiles values ('${DRIVER}', 'acct_driver');
    -- a business whose payout account sits in the PARALLEL column the resolver also honours
    insert into public.local_businesses values ('${BIZ3}', '${PARALLEL}', null, 'acct_parallel');`);
  assert.doesNotMatch(seed, /ERROR/i, seed);
});

/* ── 4. the destination guard ──────────────────────────────────────────────── */

const controls = (user: string | null, account: string | null) =>
  scalar(`select public.wallet_destination_self_controlled(${user ? `'${user}'` : 'null'}, ${account ? `'${account}'` : 'null'})::text`);

describe('wallet_destination_self_controlled — who ends up with the money', () => {
  test('the owner of a business, or of a hub, on the destination account controls it', () => {
    assert.equal(controls(OWNER, 'acct_organiser'), 'true');
  });
  test('and so does the owner of a DIFFERENT hub that points at the same connected account (production already has a shared account)', () => {
    assert.equal(controls(SIBLING, 'acct_organiser'), 'true');
  });
  test('a customer who controls nothing on the account does not', () => assert.equal(controls(ALICE, 'acct_organiser'), 'false'));
  test('a committee member (cannot change where the money goes) is not over-blocked', () => assert.equal(controls(COMMITTEE, 'acct_organiser'), 'false'));
  test('somebody else’s account is not mine', () => assert.equal(controls(OWNER, 'acct_other'), 'false'));
  test('no destination (a demo or platform-revenue checkout) is never self-payment, and neither is a missing payer or an empty id', () => {
    assert.equal(controls(OWNER, null), 'false');
    assert.equal(controls(OWNER, ''), 'false');
    assert.equal(controls(null, 'acct_organiser'), 'false');
  });
  test('THE WIDENING: an owner whose shop has no account of its own is paid into their CENTRAL account — which is on no business or hub row — and controls it', () => {
    assert.equal(scalar(`select count(*) from public.local_businesses where stripe_account_id = 'acct_central' or business_stripe_account_id = 'acct_central'`), '0', 'the central account is not on any business row');
    assert.equal(scalar(`select count(*) from public.hubs where stripe_account_id = 'acct_central'`), '0', 'nor on any hub row');
    assert.equal(controls(CENTRAL, 'acct_central'), 'true');
    assert.equal(controls(ALICE, 'acct_central'), 'false', 'a stranger still does not');
    assert.equal(controls(OWNER, 'acct_central'), 'false', 'nor a different owner');
  });
  test('CONTROL: the ORIGINAL definition could not see that — it answers false for the central account, the driver account and the parallel column', () => {
    const old = (u: string, a: string) => scalar(`select public.wallet_destination_self_controlled_original('${u}', '${a}')::text`);
    assert.equal(old(CENTRAL, 'acct_central'), 'false');
    assert.equal(old(DRIVER, 'acct_driver'), 'false');
    assert.equal(old(PARALLEL, 'acct_parallel'), 'false');
    // and the new one sees all three
    assert.equal(controls(DRIVER, 'acct_driver'), 'true');
    assert.equal(controls(PARALLEL, 'acct_parallel'), 'true');
  });
  test('a Fetch driver controls their own driver account (the customer-is-also-the-driver case); nobody else does', () => {
    assert.equal(controls(DRIVER, 'acct_driver'), 'true');
    assert.equal(controls(CENTRAL, 'acct_driver'), 'false');
    assert.equal(controls(ALICE, 'acct_driver'), 'false');
  });
  test('everything the ORIGINAL function caught is still caught, and nothing it let through is newly blocked for an unrelated person', () => {
    for (const [u, a] of [[OWNER, 'acct_organiser'], [SIBLING, 'acct_organiser']] as const) {
      assert.equal(scalar(`select public.wallet_destination_self_controlled_original('${u}', '${a}')::text`), 'true');
      assert.equal(controls(u, a), 'true');
    }
    for (const a of ['acct_organiser', 'acct_central', 'acct_driver', 'acct_parallel', 'acct_other']) assert.equal(controls(ALICE, a), 'false', a);
    assert.equal(controls(COMMITTEE, 'acct_organiser'), 'false');
  });
  test('the migration applies exactly as written (its own self-check passes), twice, and the answers do not change', () => {
    const run = () => spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', GUARD2], { cwd: REPO_ROOT, encoding: 'utf8' });
    const before = [controls(CENTRAL, 'acct_central'), controls(DRIVER, 'acct_driver'), controls(ALICE, 'acct_central'), controls(OWNER, 'acct_organiser')];
    assert.equal(run().status, 0, run().stderr);
    assert.deepEqual([controls(CENTRAL, 'acct_central'), controls(DRIVER, 'acct_driver'), controls(ALICE, 'acct_central'), controls(OWNER, 'acct_organiser')], before);
    assert.deepEqual(before, ['true', 'true', 'false', 'true']);
    assert.equal(scalar(`select has_function_privilege('anon','public.wallet_destination_self_controlled(uuid,text)','EXECUTE')::text`), 'false');
    assert.equal(scalar(`select has_function_privilege('authenticated','public.wallet_destination_self_controlled(uuid,text)','EXECUTE')::text`), 'false');
  });
  test('it is service_role-only with a pinned search_path (source)', () => {
    const m = src(GUARD2);
    assert.match(m, /revoke all on function public\.wallet_destination_self_controlled\(uuid, text\) from public, anon, authenticated;/);
    assert.match(m, /grant execute on function public\.wallet_destination_self_controlled\(uuid, text\) to service_role;/);
    assert.match(m, /set search_path to 'public'/);
  });
});

/* ── 1–3. the ledger lifecycle ─────────────────────────────────────────────── */

let seq = 0;
const topup = (user: string, pence: number, pi = `pi_topup_${++seq}`) => { raw(`select * from public.wallet_topup('${user}', ${pence}, '${pi}')`); return pi; };
/** what the ticket / gift routes do: a keyed spend, transfer later marked sent */
function spend(user: string, pence: number, key: string, opts: { cashback?: number; transfer?: boolean } = {}): string {
  const out = raw(`select transaction_id from public.wallet_debit_with_ledger('${user}', ${pence}, ${opts.cashback ?? 0}, 'spend', '${BIZ}', 'purchase', '${key}', 0, ${opts.transfer ?? true})`);
  const id = rowsOf(out).pop() ?? '';
  assert.match(id, /^[0-9a-f-]{36}$/, `spend failed:\n${out}`);
  if (opts.transfer ?? true) raw(`update public.local_wallet_transactions set transfer_state='sent', stripe_transfer_id='tr_${id.slice(0, 8)}' where id='${id}'`);
  return id;
}
const reverse = (txId: string, merchant: 'clawed_back' | 'no_transfer' = 'clawed_back') =>
  rowsOf(raw(`select balance_pence||'|'||already_reversed from public.wallet_reverse_debit('${txId}', 'Refund', '${merchant}')`)).pop() ?? '';
const balance = (user: string) => num(`select coalesce((select balance_pence from public.local_wallet_balances where user_id='${user}'),0)`);
const ledgerSum = (user: string) => num(`select coalesce(sum(amount_pence),0) from public.local_wallet_transactions where user_id='${user}'`);
const deficit = (user: string) => num(`select coalesce((select deficit_pence from public.local_wallet_balances where user_id='${user}'),0)`);
const blocked = (user: string) => scalar(`select blocked::text from public.wallet_spend_block('${user}')`);
const reversals = (txId: string) => num(`select count(*) from public.local_wallet_transactions where reverses_transaction_id='${txId}'`);

describe('a wallet TICKET purchase and its refund', () => {
  test('the spend is a keyed ledger row; the refund is ONE linked reversal back into the SAME wallet, with no payment id', () => {
    topup(ALICE, 10000, 'pi_card_alice');
    const t = spend(ALICE, 196, 'event-tickets:order-1');
    assert.equal(balance(ALICE), 10000 - 196);
    const r = reverse(t);
    assert.equal(r, '10000|false');
    assert.equal(balance(ALICE), 10000);
    assert.equal(balance(ALICE), ledgerSum(ALICE), 'balance equals the ledger exactly');
    const rev = raw(`select concat_ws('|', type, amount_pence, coalesce(stripe_payment_intent_id,'-'), coalesce(stripe_transfer_id,'-'), transfer_state) from public.local_wallet_transactions where reverses_transaction_id='${t}'`).trim();
    assert.equal(rev, 'refund|196|-|-|none', 'a refund row, the whole price, no Stripe payment id, no transfer — nothing a card refund could target');
    assert.equal(scalar(`select transfer_state from public.local_wallet_transactions where id='${t}'`), 'reversed', 'the original spend records that the organiser was clawed back');
    assert.equal(scalar(`select count(*) from public.local_wallet_transactions where type='topup' and stripe_payment_intent_id='pi_card_alice'`), '1', 'the top-up row is untouched');
  });

  test('a DUPLICATE or repeated refund credits nothing more — five attempts, one credit', () => {
    topup(BOB, 5000, 'pi_card_bob');
    const t = spend(BOB, 196, 'event-tickets:order-2');
    const first = reverse(t);
    for (let i = 0; i < 4; i++) assert.equal(reverse(t), `${5000}|true`);
    assert.equal(first, '5000|false');
    assert.equal(balance(BOB), 5000);
    assert.equal(reversals(t), 1);
    assert.equal(balance(BOB), ledgerSum(BOB));
  });

  test('CONCURRENT refunds of one purchase are safe: exactly one reversal row, one credit', async () => {
    const u = 'c1000000-0000-4000-8000-0000000000c1';
    topup(u, 3000, 'pi_card_conc');
    const t = spend(u, 196, 'event-tickets:order-conc');
    const outs = await Promise.all(Array.from({ length: 6 }, () => rawAsync(`select balance_pence||'|'||already_reversed from public.wallet_reverse_debit('${t}', 'Refund', 'clawed_back')`)));
    assert.equal(reversals(t), 1, outs.join('\n'));
    assert.equal(balance(u), 3000);
    assert.equal(balance(u), ledgerSum(u));
  });

  test('a refund can never exceed the purchase: it is the spend row’s own amount (less cashback) — there is no amount argument to inflate', () => {
    const args = scalar(`select pg_get_function_arguments('public.wallet_reverse_debit(uuid, text, text)'::regprocedure)`);
    assert.doesNotMatch(args, /amount|pence/i, args);
    topup(ALICE, 2000, 'pi_cashback');
    const t = spend(ALICE, 500, 'event-tickets:order-cb', { cashback: 25 });
    const before = balance(ALICE);
    reverse(t);
    assert.equal(balance(ALICE) - before, 475, '500 spent, 25 of it business-funded cashback: 475 comes back, never more than was paid');
  });

  test('only a SPEND can be refunded: not a top-up (that would mint card money into the wallet), not a refund, not an unknown id', () => {
    const topupRow = scalar(`select id from public.local_wallet_transactions where stripe_payment_intent_id='pi_card_alice'`);
    const refundRow = scalar(`select id from public.local_wallet_transactions where type='refund' limit 1`);
    for (const id of [topupRow, refundRow]) {
      const before = ledgerSum(ALICE) + ledgerSum(BOB);
      assert.match(raw(`select * from public.wallet_reverse_debit('${id}', 'x', null)`), /only a spend can be reversed/);
      assert.equal(ledgerSum(ALICE) + ledgerSum(BOB), before);
    }
    assert.match(raw(`select * from public.wallet_reverse_debit('00000000-0000-4000-8000-000000000999', 'x', null)`), /no such transaction/);
  });

  test('a refund cannot claim the organiser was clawed back when nothing was sent, nor that it was unpaid when it was sent', () => {
    const noTransfer = spend(ALICE, 100, 'event-tickets:order-free', { transfer: false });
    assert.match(raw(`select * from public.wallet_reverse_debit('${noTransfer}', 'x', 'clawed_back')`), /nothing was sent/);
    const sent = spend(ALICE, 100, 'event-tickets:order-sent');
    assert.match(raw(`select * from public.wallet_reverse_debit('${sent}', 'x', 'never_paid')`), /transfer was sent/);
  });
});

describe('a wallet GIFT purchase and its refund', () => {
  test('the gift spend reverses by the same rule: once, whole price, back into the wallet, no payment id', () => {
    const u = 'c2000000-0000-4000-8000-0000000000c2';
    topup(u, 8000, 'pi_card_gift');
    const g = spend(u, 2000, 'gift:gift-1');
    assert.equal(balance(u), 6000);
    assert.equal(reverse(g), '8000|false');
    assert.equal(reverse(g), '8000|true');
    assert.equal(reversals(g), 1);
    assert.equal(scalar(`select coalesce(stripe_payment_intent_id,'-') from public.local_wallet_transactions where reverses_transaction_id='${g}'`), '-');
    assert.equal(balance(u), ledgerSum(u));
  });

  test('the ledger offers no way to route a wallet purchase to a card: no refund row anywhere carries a payment id', () => {
    assert.equal(scalar(`select count(*) from public.local_wallet_transactions where type='refund' and stripe_payment_intent_id is not null`), '0');
    assert.equal(scalar(`select count(*) from public.local_wallet_transactions where type='spend' and stripe_payment_intent_id is not null`), '0');
  });
});

describe('mixed funding', () => {
  test('is not a thing: the wallet is one fungible balance; a purchase is a single wallet debit or a single card payment', () => {
    const u = 'c3000000-0000-4000-8000-0000000000c3';
    topup(u, 6000, 'pi_mix_1'); topup(u, 4000, 'pi_mix_2');
    const t = spend(u, 8000, 'event-tickets:order-mix');
    assert.equal(balance(u), 2000);
    const cols = scalar(`select string_agg(column_name, ',') from information_schema.columns where table_schema='public' and table_name='local_wallet_transactions' and (column_name like '%source%' or column_name like '%funding%' or column_name like '%provenance%')`);
    assert.equal(cols, '', 'there is no per-source funding column to apportion, so a refund cannot lose one');
    reverse(t);
    assert.equal(balance(u), 10000, 'the whole price returns to the wallet, whichever top-up it came from');
  });
});

describe('a charged-back or refunded TOP-UP, and a ticket refund that arrives after it', () => {
  const U = 'c4000000-0000-4000-8000-0000000000c4';
  test('value spent at a third party before the chargeback becomes a recorded DEFICIT, and the wallet cannot spend', () => {
    topup(U, 10000, 'pi_cb');
    spend(U, 10000, 'event-tickets:order-chargeback');
    assert.equal(balance(U), 0);
    const rec = raw(`select recovered_now_pence||'|'||taken_pence||'|'||deficit_pence from public.wallet_recover_topup('pi_cb', 'dispute_lost', 10000, 'dp_1')`);
    assert.equal(rowsOf(rec).pop(), '10000|0|10000', rec);
    assert.equal(deficit(U), 10000);
    assert.equal(blocked(U), 'true');
    assert.ok(balance(U) >= 0, 'the balance never goes negative; the shortfall is a deficit');
  });
  test('a replay of the same chargeback, or a refund of the same top-up on top of it, takes nothing more', () => {
    raw(`select * from public.wallet_recover_topup('pi_cb', 'dispute_lost', 10000, 'dp_1')`);
    raw(`select * from public.wallet_recover_topup('pi_cb', 'refund', 10000)`);
    raw(`select * from public.wallet_recover_topup('pi_cb', 'refund', 99999)`);
    assert.equal(deficit(U), 10000, 'never more than was credited, never twice');
  });
  test('the organiser then refunds the ticket: wallet value returns, but spending stays BLOCKED while the deficit stands', () => {
    const t = scalar(`select id from public.local_wallet_transactions where idempotency_key='event-tickets:order-chargeback'`);
    reverse(t);
    assert.equal(balance(U), 10000);
    assert.equal(deficit(U), 10000);
    assert.equal(blocked(U), 'true');
    const dbt = raw(`select * from public.wallet_debit_with_ledger('${U}', 100, 0, 'spend', null, 'try', 'try-1', 0, false)`);
    assert.match(dbt, /t\|deficit|blocked|true/, 'the debit primitive itself refuses');
    assert.equal(balance(U), 10000, 'the refused debit moved nothing');
  });
  test('a new card top-up repays the deficit first; the wallet then holds exactly the value backed by card money that was kept', () => {
    raw(`select * from public.wallet_topup('${U}', 10000, 'pi_repay')`);
    assert.equal(deficit(U), 0);
    assert.equal(blocked(U), 'false');
    assert.equal(balance(U), 10000, '10000 of refunded ticket value; the second top-up repaid the charged-back one — no free value was created');
    assert.equal(balance(U), ledgerSum(U));
  });
  test('"not a top-up" is a no-op: asking to recover a payment id that never funded a wallet changes nothing', () => {
    const before = ledgerSum(ALICE);
    assert.equal(rowsOf(raw(`select reason from public.wallet_recover_topup('pi_not_a_topup', 'refund', 500)`)).pop(), 'not_a_topup');
    assert.equal(ledgerSum(ALICE), before);
  });
});

describe('the ledger stays authoritative', () => {
  test('after every scenario above, every wallet balance equals the sum of its ledger, none is negative, and no idempotency key repeats', () => {
    assert.equal(scalar(`select count(*) from public.local_wallet_balances b where b.balance_pence <> coalesce((select sum(amount_pence) from public.local_wallet_transactions t where t.user_id=b.user_id),0) and b.deficit_pence = 0`), '0');
    assert.equal(scalar(`select count(*) from public.local_wallet_balances where balance_pence < 0`), '0');
    assert.equal(scalar(`select count(*) from (select idempotency_key from public.local_wallet_transactions where idempotency_key is not null group by 1 having count(*)>1) x`), '0');
    assert.equal(scalar(`select count(*) from (select reverses_transaction_id from public.local_wallet_transactions where reverses_transaction_id is not null group by 1 having count(*)>1) x`), '0');
  });
  test('no client role can write the ledger or the balances directly (table-level revokes are in the migration; function access is checked against the live catalog)', () => {
    const m = src(LEDGER);
    assert.match(m, /revoke insert, update, delete, truncate on table public\.local_wallet_balances from anon, authenticated;/);
    assert.match(m, /revoke insert, update, delete, truncate on table public\.local_wallet_transactions from anon, authenticated;/);
    assert.match(m, /execute format\('revoke all on function %s from anon', fn\);/);
    assert.match(m, /execute format\('grant execute on function %s to service_role', fn\);/);
  });
});

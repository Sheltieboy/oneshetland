/**
 * wallet-integrity.node.test.ts — a balance never moves without an entry, and
 * an entry never appears without the balance moving.
 *
 * WHY THIS TEST EXISTS
 *
 * Every wallet debit in this codebase was three separate things:
 *
 *     rpc('wallet_debit')                  // commits the balance change
 *     fetch('https://api.stripe.com/...')  // moves the money
 *     .from('local_wallet_transactions')   // SEPARATE commit, result unchecked
 *       .insert({...})                     // no .select(), no error branch
 *
 * The balance step was never the weak part — it is a single guarded UPDATE that
 * cannot overdraw and cannot lose a race. The weak part was the accounting
 * entry: outside the transaction, after a network call, unexamined.
 *
 * Reproduced against production before the fix: wallet_debit committed −2500p
 * and a failing ledger insert left ZERO rows behind. The customer was down and
 * nothing recorded why.
 *
 * The same signature is visible in the live data. Three wallets hold £127.86;
 * their ledgers say £361.31. Every one is BELOW its ledger — money missing from
 * balances, never minted into them. One account reconciles to the penny once
 * you account for a £8.95 wallet ticket order and £57.00 of wallet shop orders
 * that have no ledger rows at all: 895 + 5700 = 6595p, its exact discrepancy.
 *
 * WHAT IS ASSERTED
 *   · balance and ledger agree after every single committed operation
 *   · a ledger insert that fails takes the balance change down with it
 *   · two simultaneous spends cannot overdraw
 *   · one payment identifier debits once, sequentially and concurrently
 *   · cashback is a separate positive entry and cannot exceed the spend
 *   · a reversal is APPENDED and linked; the original debit survives
 *   · the legacy shims now write entries too
 *   · none of it is callable from a browser
 *
 * SAFETY
 * Everything is rolled back except the two concurrency tests, which cannot be:
 * proving two transactions contend needs rows both can see. Those use a profile
 * that has NO wallet, and delete it again in after(). The three real wallet
 * accounts are never read into, written to, or touched.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NIL = '00000000-0000-0000-0000-000000000000';

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

/** Throws on failure rather than returning null — a broken query must fail, not skip. */
function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}

function runSql(sql: string): string {
  // The guard select stops a leading "--" comment being read as a CLI flag.
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    // stdout carries the SQL error; stderr is only the CLI banner.
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}

const query = (sql: string) => lastRow(runSql(sql));

async function queryAsync(sql: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return lastRow(stdout);
}

type Case = { area: string; case_name: string; expected: string; actual: string; verdict: string };

function assertAllPass(rows: Case[], area: string) {
  const mine = rows.filter((r) => r.area === area);
  assert.ok(mine.length > 0, `no cases ran for "${area}"`);
  const failed = mine.filter((r) => r.verdict !== 'PASS');
  if (failed.length) {
    assert.fail(`WALLET REGRESSION in ${area}:\n` +
      failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
  }
}

/** A profile with no wallet, so the three real accounts are never involved. */
const SPARE_USER = `(select p.id from public.profiles p
   where not exists (select 1 from public.local_wallet_transactions t where t.user_id = p.id)
     and not exists (select 1 from public.local_wallet_balances b where b.user_id = p.id
                       and exists (select 1 from public.local_wallet_transactions t2 where t2.user_id = b.user_id))
   order by p.id offset 0 limit 1)`;

// ── 1. Accounting, idempotency, guards — all rolled back ────────────────────

describe('wallet accounting', () => {
  let rows: Case[] = [];

  before(() => {
    const out = runSql(`begin;
create temp table pp as select ${SPARE_USER} u,
  (select id from public.local_businesses where owner_id is not null order by id limit 1) biz;
create temp table res (n int generated always as identity, area text, case_name text, expected text, actual text);

create temp table seed as select * from public.wallet_credit_with_ledger((select u from pp), 10000, 'topup', null, 'opening', 'w:open');

create or replace function pg_temp.bal() returns int language sql as $f$
  select balance_pence from public.local_wallet_balances where user_id=(select u from pp) $f$;
create or replace function pg_temp.led() returns int language sql as $f$
  select coalesce(sum(amount_pence),0)::int from public.local_wallet_transactions where user_id=(select u from pp) $f$;
create or replace function pg_temp.agree() returns text language sql as $f$
  select case when pg_temp.bal() = pg_temp.led() then 'agree'
    else format('DIVERGED balance=%s ledger=%s', pg_temp.bal(), pg_temp.led()) end $f$;

-- ══ balance and ledger agree at EVERY committed state ═════════════════════
insert into res (area, case_name, expected, actual)
select 'atomicity', 'opening: balance equals ledger', 'agree', pg_temp.agree();

create temp table c1 as select * from public.wallet_credit_with_ledger((select u from pp), 5000, 'topup', null, 'top-up', 'w:t1');
insert into res (area, case_name, expected, actual)
select 'atomicity', 'after a credit: balance', '15000', pg_temp.bal()::text;
insert into res (area, case_name, expected, actual)
select 'atomicity', 'after a credit: still agrees', 'agree', pg_temp.agree();

create temp table s1 as select * from public.wallet_debit_with_ledger((select u from pp), 2000, 0, 'spend', null, 'spend', 'w:s1', 100, false);
insert into res (area, case_name, expected, actual)
select 'atomicity', 'after a debit: balance', '13000', pg_temp.bal()::text;
insert into res (area, case_name, expected, actual)
select 'atomicity', 'after a debit: still agrees', 'agree', pg_temp.agree();
insert into res (area, case_name, expected, actual)
select 'atomicity', 'the debit wrote exactly one entry', '1',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='w:s1');
insert into res (area, case_name, expected, actual)
select 'atomicity', 'the platform fee is recorded on it', '100',
  (select platform_fee_pence::text from public.local_wallet_transactions where idempotency_key='w:s1');

-- ══ cashback ══════════════════════════════════════════════════════════════
create temp table s2 as select * from public.wallet_debit_with_ledger(
  (select u from pp), 1000, 50, 'spend', (select biz from pp), 'spend w/ cashback', 'w:s2', 20, false);
insert into res (area, case_name, expected, actual)
select 'cashback', 'net of spend and cashback', '12050', pg_temp.bal()::text;
insert into res (area, case_name, expected, actual)
select 'cashback', 'still agrees', 'agree', pg_temp.agree();
insert into res (area, case_name, expected, actual)
select 'cashback', 'cashback is its own positive entry', '50',
  (select amount_pence::text from public.local_wallet_transactions where idempotency_key='w:s2:cashback');
insert into res (area, case_name, expected, actual)
select 'cashback', 'the spend entry records what was given back', '50',
  (select cashback_pence::text from public.local_wallet_transactions where idempotency_key='w:s2');

-- ══ reversal is appended, never erased ════════════════════════════════════
create temp table rv as select * from public.wallet_reverse_debit((select transaction_id from s2), 'transfer failed');
insert into res (area, case_name, expected, actual)
select 'reversal', 'the money comes back', '13000', pg_temp.bal()::text;
insert into res (area, case_name, expected, actual)
select 'reversal', 'still agrees', 'agree', pg_temp.agree();
insert into res (area, case_name, expected, actual)
select 'reversal', 'the original debit is still there', '-1000',
  (select amount_pence::text from public.local_wallet_transactions where idempotency_key='w:s2');
insert into res (area, case_name, expected, actual)
select 'reversal', 'the refund points at what it reverses', 'true',
  (select (reverses_transaction_id = (select transaction_id from s2))::text
     from public.local_wallet_transactions where idempotency_key='w:s2:reversal');
insert into res (area, case_name, expected, actual)
select 'reversal', 'the original is annotated, not deleted', 'failed',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='w:s2');
create temp table rv2 as select * from public.wallet_reverse_debit((select transaction_id from s2), 'again');
insert into res (area, case_name, expected, actual)
select 'reversal', 'reversing twice is a no-op', 'true', (select already_reversed::text from rv2);
insert into res (area, case_name, expected, actual)
select 'reversal', 'and did not credit twice', '13000', pg_temp.bal()::text;

-- ══ one identifier, one debit ═════════════════════════════════════════════
create temp table d1 as select * from public.wallet_debit_with_ledger((select u from pp), 500, 0, 'spend', null, 'dup', 'w:dup', null, false);
create temp table d2 as select * from public.wallet_debit_with_ledger((select u from pp), 500, 0, 'spend', null, 'dup', 'w:dup', null, false);
create temp table d3 as select * from public.wallet_debit_with_ledger((select u from pp), 500, 0, 'spend', null, 'dup', 'w:dup', null, false);
create temp table d4 as select * from public.wallet_debit_with_ledger((select u from pp), 500, 0, 'spend', null, 'dup', 'w:dup', null, false);
create temp table d5 as select * from public.wallet_debit_with_ledger((select u from pp), 500, 0, 'spend', null, 'dup', 'w:dup', null, false);
insert into res (area, case_name, expected, actual)
select 'idempotency', 'four of five attempts are no-ops', '4',
  ((select already_applied::int from d2)+(select already_applied::int from d3)
  +(select already_applied::int from d4)+(select already_applied::int from d5))::text;
insert into res (area, case_name, expected, actual)
select 'idempotency', 'the money moved once', '12500', pg_temp.bal()::text;
insert into res (area, case_name, expected, actual)
select 'idempotency', 'one entry, not five', '1',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='w:dup');
insert into res (area, case_name, expected, actual)
select 'idempotency', 'still agrees', 'agree', pg_temp.agree();

-- ══ THE H2 TEST: a failing entry takes the balance with it ════════════════
create or replace function pg_temp.forced_failure() returns text language plpgsql as $f$
declare v_before int; v_after int;
begin
  v_before := pg_temp.bal();
  begin
    -- A business_id that does not exist violates the ledger's foreign key, so
    -- the accounting insert fails after the balance has already been reduced
    -- inside the same transaction. When these were two commits, the balance
    -- stayed down and no entry was ever written.
    perform public.wallet_debit_with_ledger((select u from pp), 1000, 0, 'spend',
      '00000000-0000-0000-0000-0000000000ff'::uuid, 'unwritable', 'w:fail', null, false);
    return 'NO ERROR RAISED';
  exception when others then
    v_after := pg_temp.bal();
    return case when v_before = v_after then 'balance rolled back'
      else format('BALANCE DRIFTED %s -> %s', v_before, v_after) end;
  end;
end $f$;

insert into res (area, case_name, expected, actual)
select 'H2', 'a failed entry rolls the balance back', 'balance rolled back', pg_temp.forced_failure();
insert into res (area, case_name, expected, actual)
select 'H2', 'no half-written entry survives', '0',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='w:fail');
insert into res (area, case_name, expected, actual)
select 'H2', 'balance and ledger still agree', 'agree', pg_temp.agree();

-- ══ guards ════════════════════════════════════════════════════════════════
create temp table ins as select * from public.wallet_debit_with_ledger((select u from pp), 99999999, 0, 'spend', null, 'too much', 'w:broke', null, false);
insert into res (area, case_name, expected, actual)
select 'guards', 'insufficient funds is reported, not raised', 'true', (select insufficient::text from ins);
insert into res (area, case_name, expected, actual)
select 'guards', 'and wrote nothing', '0',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='w:broke');
insert into res (area, case_name, expected, actual)
select 'guards', 'a wallet can never go below zero', 'true', (pg_temp.bal() >= 0)::text;

create or replace function pg_temp.try(p text) returns text language plpgsql as $f$
begin
  if p='neg' then perform public.wallet_debit_with_ledger((select u from pp), -100, 0, 'spend', null, 'x', 'w:a', null, false);
  elsif p='negcb' then perform public.wallet_debit_with_ledger((select u from pp), 100, -5, 'spend', null, 'x', 'w:b', null, false);
  elsif p='zero' then perform public.wallet_debit_with_ledger((select u from pp), 0, 0, 'spend', null, 'x', 'w:c', null, false);
  elsif p='cbgt' then perform public.wallet_debit_with_ledger((select u from pp), 100, 500, 'spend', null, 'x', 'w:d', null, false);
  elsif p='mint' then perform public.wallet_debit_with_ledger((select u from pp), 100, 0, 'topup', null, 'x', 'w:e', null, false);
  elsif p='cneg' then perform public.wallet_credit_with_ledger((select u from pp), -100, 'refund', null, 'x', 'w:f');
  elsif p='czero' then perform public.wallet_credit_with_ledger((select u from pp), 0, 'refund', null, 'x', 'w:g');
  elsif p='nulluser' then perform public.wallet_debit_with_ledger(null, 100, 0, 'spend', null, 'x', 'w:h', null, false);
  elsif p='badstate' then perform public.wallet_mark_transfer((select transaction_id from s1), 'teleported', null);
  end if;
  return 'ACCEPTED';
exception when others then return 'refused';
end $f$;

insert into res (area, case_name, expected, actual)
select 'guards', c.name, 'refused', pg_temp.try(c.k) from (values
  ('a negative spend','neg'), ('negative cashback','negcb'), ('a zero-value debit','zero'),
  ('cashback larger than the spend','cbgt'), ('a debit disguised as a top-up','mint'),
  ('a negative credit','cneg'), ('a zero credit','czero'), ('a null user','nulluser'),
  ('an invented transfer state','badstate')
) c(name,k);

insert into res (area, case_name, expected, actual)
select 'guards', 'no guard test moved any money', 'agree', pg_temp.agree();

-- ══ legacy shims ══════════════════════════════════════════════════════════
create temp table lg as select public.wallet_debit((select u from pp), 700, 0) b;
insert into res (area, case_name, expected, actual)
select 'legacy', 'wallet_debit keeps its contract', '11800', (select b::text from lg);
insert into res (area, case_name, expected, actual)
select 'legacy', 'but now writes an entry', '1',
  (select count(*)::text from public.local_wallet_transactions
    where user_id=(select u from pp) and description like 'Wallet debit (legacy%');
create temp table lgc as select public.wallet_credit((select u from pp), 700) b;
insert into res (area, case_name, expected, actual)
select 'legacy', 'wallet_credit writes one too', '1',
  (select count(*)::text from public.local_wallet_transactions
    where user_id=(select u from pp) and description like 'Wallet credit (legacy%');
insert into res (area, case_name, expected, actual)
select 'legacy', 'legacy paths keep the books straight', 'agree', pg_temp.agree();
insert into res (area, case_name, expected, actual)
select 'legacy', 'insufficient funds still returns NULL', 'true',
  (public.wallet_debit((select u from pp), 99999999, 0) is null)::text;

-- ══ transfer state machine ════════════════════════════════════════════════
create temp table tr as select * from public.wallet_debit_with_ledger(
  (select u from pp), 300, 0, 'spend', null, 'needs a transfer', 'w:tr', null, true);
insert into res (area, case_name, expected, actual)
select 'transfer', 'a transfer-bound debit starts pending', 'pending',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='w:tr');
insert into res (area, case_name, expected, actual)
select 'transfer', 'a debit needing no transfer starts none', 'none',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='w:s1');
-- Each mark is its own statement. Folding the call and the read into one
-- statement reads the PRE-statement snapshot and silently asserts nothing.
create temp table m1 as select public.wallet_mark_transfer((select transaction_id from tr),'sent','tr_test_1') ok;
insert into res (area, case_name, expected, actual)
select 'transfer', 'settling records the transfer id', 'tr_test_1',
  (select stripe_transfer_id from public.local_wallet_transactions where idempotency_key='w:tr');

create temp table m2 as select public.wallet_mark_transfer((select transaction_id from tr),'unresolved',null) ok;
insert into res (area, case_name, expected, actual)
select 'transfer', 'an ambiguous outcome is recorded, not guessed', 'unresolved',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='w:tr');
insert into res (area, case_name, expected, actual)
select 'transfer', 'and never clears a transfer id it already has', 'tr_test_1',
  (select stripe_transfer_id from public.local_wallet_transactions where idempotency_key='w:tr');

-- ══ reconciliation ════════════════════════════════════════════════════════
insert into res (area, case_name, expected, actual)
select 'reconciliation', 'the test wallet reconciles to zero', '0',
  (select delta_pence::text from public.wallet_reconciliation() where user_id=(select u from pp));

select n, area, case_name, expected, actual,
       case when expected is not distinct from actual then 'PASS' else 'FAIL' end as verdict
  from res order by n;
rollback;`);

    const parsed = JSON.parse(out) as { rows?: Case[]; _tag?: string; error?: unknown };
    if (parsed._tag === 'Error' || parsed.error) {
      throw new Error(`wallet matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    }
    rows = (parsed.rows ?? []).filter((r) => r.verdict);
    assert.ok(rows.length >= 40, `expected the full wallet matrix, got ${rows.length} cases`);
  });

  test('balance and ledger move together, always', () => assertAllPass(rows, 'atomicity'));
  test('a failing ledger entry rolls the balance back (H2)', () => assertAllPass(rows, 'H2'));
  test('cashback is accounted for separately', () => assertAllPass(rows, 'cashback'));
  test('reversals are appended, not erased', () => assertAllPass(rows, 'reversal'));
  test('one payment identifier debits once', () => assertAllPass(rows, 'idempotency'));
  test('money stays integer, positive and non-overdrawn', () => assertAllPass(rows, 'guards'));
  test('the legacy shims now write entries', () => assertAllPass(rows, 'legacy'));
  test('the external transfer state is durable', () => assertAllPass(rows, 'transfer'));
  test('reconciliation is exact', () => assertAllPass(rows, 'reconciliation'));
});

// ── 2. Two spends at once ───────────────────────────────────────────────────

describe('two wallet spends arriving together', () => {
  let user = '';

  const cleanup = () => query(`
    delete from public.local_wallet_transactions where idempotency_key like 'wrace%';
    delete from public.local_wallet_balances where user_id in (
      select b.user_id from public.local_wallet_balances b
       where not exists (select 1 from public.local_wallet_transactions t where t.user_id = b.user_id)
         and b.user_id = '${user || NIL}');
    select 1;`);

  before(() => {
    const r = query(`select ${SPARE_USER}::text as u;`);
    user = String(r.u);
    assert.match(user, /^[0-9a-f-]{36}$/, 'no spare profile without a wallet was available');
  });

  after(() => {
    query(`delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}'; select 1;`);
    const left = query(`select count(*)::int as n from public.local_wallet_balances where user_id='${user}';`);
    assert.equal(left.n, 0, 'this suite left its test wallet behind');
  });

  test('a wallet with 1000p cannot pay 800p twice', async () => {
    query(`delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}';
           insert into public.local_wallet_balances (user_id, balance_pence) values ('${user}', 1000); select 1;`);

    // A takes the row lock and holds it. B blocks, then re-tests the guard
    // against the committed balance — 200p, which cannot cover 800p.
    const a = queryAsync(`begin;
create temp table x as select * from public.wallet_debit_with_ledger('${user}', 800, 0, 'spend', null, 'race A', 'wrace-a', null, false);
select pg_sleep(6);
select case when insufficient then 'insufficient' else 'ok' end r from x;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select case when insufficient then 'insufficient' else 'ok' end as r
  from public.wallet_debit_with_ledger('${user}', 800, 0, 'spend', null, 'race B', 'wrace-b', null, false);`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.r), String(rb.r)];
    const wins = results.filter((x) => x === 'ok').length;

    assert.equal(wins, 1, `both spends succeeded — the wallet was overdrawn. Got ${JSON.stringify(results)}`);

    const st = query(`select b.balance_pence,
      (select count(*)::int from public.local_wallet_transactions t where t.user_id='${user}') rows_,
      (select coalesce(sum(t.amount_pence),0)::int from public.local_wallet_transactions t where t.user_id='${user}') sum_
      from public.local_wallet_balances b where b.user_id='${user}';`);
    assert.equal(st.balance_pence, 200, 'the balance is not what one 800p spend leaves behind');
    assert.ok((st.balance_pence as number) >= 0, 'the wallet went negative');
    assert.equal(st.rows_, 1, 'the losing spend still wrote an accounting entry');
    assert.equal(st.sum_, -800, 'the ledger does not match the one spend that happened');
  });

  test('one identifier debits once even from two connections', async () => {
    query(`delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}';
           insert into public.local_wallet_balances (user_id, balance_pence) values ('${user}', 5000); select 1;`);

    const a = queryAsync(`begin;
create temp table y as select * from public.wallet_debit_with_ledger('${user}', 1200, 0, 'spend', null, 'dup race', 'wrace-dup', null, false);
select pg_sleep(6);
select case when already_applied then 'already' else 'applied' end r from y;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select case when already_applied then 'already' else 'applied' end as r
  from public.wallet_debit_with_ledger('${user}', 1200, 0, 'spend', null, 'dup race', 'wrace-dup', null, false);`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.r), String(rb.r)];
    assert.equal(results.filter((x) => x === 'applied').length, 1,
      `one payment identifier debited twice. Got ${JSON.stringify(results)}`);

    const st = query(`select b.balance_pence,
      (select count(*)::int from public.local_wallet_transactions t where t.user_id='${user}') rows_
      from public.local_wallet_balances b where b.user_id='${user}';`);
    assert.equal(st.balance_pence, 3800, 'the money moved more than once');
    assert.equal(st.rows_, 1, 'the same payment wrote two accounting entries');
  });
});

// ── 3. None of it is reachable from a browser ───────────────────────────────

describe('wallet mutation stays server-only', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const denied: Array<[string, Record<string, unknown>]> = [
    ['wallet_debit_with_ledger',  { p_user: NIL, p_spend: 100 }],
    ['wallet_credit_with_ledger', { p_user: NIL, p_amount: 100 }],
    ['wallet_reverse_debit',      { p_transaction_id: NIL }],
    ['wallet_mark_transfer',      { p_transaction_id: NIL, p_state: 'sent' }],
    ['wallet_reconciliation',     {}],
    ['wallet_debit',              { p_user: NIL, p_spend: 100, p_cashback: 0 }],
    ['wallet_credit',             { p_user: NIL, p_amount: 100 }],
    ['wallet_topup',              { p_user: NIL, p_amount: 100, p_pi: 'pi_x' }],
  ];

  for (const [fn, body] of denied) {
    test(`anon cannot call ${fn}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.notEqual(res.status, 404, `${fn}: signature drifted — this probe stopped testing anything`);
      assert.equal(res.status, 401, `SECURITY REGRESSION: ${fn} answered the public anon key with HTTP ${res.status}`);
    });
  }

  // These tables carried GRANT ALL to anon and authenticated. Nothing could be
  // written because RLS has only SELECT policies — but the only thing between
  // the public key and minting money was the absence of a policy.
  const writes: Array<[string, string, string, string | undefined]> = [
    ['local_wallet_balances',     'POST',   '',                        `{"user_id":"${NIL}","balance_pence":999999}`],
    ['local_wallet_balances',     'PATCH',  `?user_id=eq.${NIL}`,      '{"balance_pence":999999}'],
    ['local_wallet_balances',     'DELETE', `?user_id=eq.${NIL}`,      undefined],
    ['local_wallet_transactions', 'POST',   '',                        `{"user_id":"${NIL}","type":"topup","amount_pence":999999}`],
    ['local_wallet_transactions', 'DELETE', `?user_id=eq.${NIL}`,      undefined],
    ['wallet_payment_claims',     'POST',   '',                        `{"client_request_id":"x","user_id":"${NIL}"}`],
  ];

  for (const [table, verb, qs, body] of writes) {
    test(`anon cannot ${verb} ${table}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/${table}${qs}`, {
        method: verb,
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
      });
      assert.equal(res.status, 401,
        `anon ${verb} on ${table} returned HTTP ${res.status} — money tables must not be client-writable`);
    });
  }

  test('reading your own wallet still works', async () => {
    // The tightening removed writes, not reads: the app shows balances.
    const res = await fetch(`${cfg!.url}/rest/v1/local_wallet_balances?select=balance_pence`, {
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}` },
    });
    assert.equal(res.status, 200, `SELECT on local_wallet_balances broke — the wallet screen needs it`);
  });
});

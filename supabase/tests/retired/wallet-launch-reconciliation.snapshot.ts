/**
 * RETIRED — a historical record, not an ongoing invariant suite.
 *
 * Retired at Launch Gate 2 (September 2026). Kept verbatim below because it is
 * the only written account of the Step 6 wallet reconciliation: what the old
 * non-atomic path left behind, why zeroing took two rows rather than one, and
 * what the numbers were on the day.
 *
 * WHY IT IS NO LONGER A TEST
 *
 * It asserts a moment, not a rule: three wallets, zero liability, twenty
 * historical rows. Legitimate sandbox activity has happened since, so those
 * facts are expected to be false now, and were measured as 4 wallets, 1800p
 * and 25 rows. A suite that must fail as the product is used is not an
 * invariant suite.
 *
 * AND WHY IT MUST NOT RUN
 *
 * purgeFixtures() deletes from local_wallet_transactions and, worse, from
 * local_wallet_balances by ALLOWLIST NEGATION — every balance without
 * transactions whose user_id does not end in one of three hard-coded values.
 * That was safe on the day the allowlist was written and is not safe now. Every
 * other wallet suite scopes its deletes to its own marker or to a deliberately
 * empty spare profile; this one does not.
 *
 * The file therefore sits outside the *.node.test.ts pattern, is absent from
 * the canonical npm test registration, and refuses to execute. All three are
 * asserted by supabase/tests/test-registration.node.test.ts.
 */

if (!process.env.ONESHETLAND_RUN_RETIRED_SNAPSHOT) {
  throw new Error(
    'wallet-launch-reconciliation is a RETIRED point-in-time snapshot, not a test. ' +
    'It asserts launch-day figures that legitimate activity has since moved, and its ' +
    'purgeFixtures() deletes production wallet balances by allowlist negation. ' +
    'Read it as history. Do not run it.',
  );
}

/**
 * wallet-launch-reconciliation.node.test.ts — a launch reset that explains
 * itself rather than tidying the number away.
 *
 * WHAT NEEDED RECONCILING
 *
 * Three wallets existed, all created before the Step 6 atomic ledger. Every one
 * of their twenty transactions predates it: none carries an idempotency_key, a
 * transfer_state or a reversal reference. They are what the old non-atomic path
 * left behind, and it moved the balance and wrote the ledger row as two
 * separate operations.
 *
 * So the stored balances sat BELOW the sum of their rows, every time:
 *
 *   stored £127.86    ledger £361.31    variance -£233.45
 *
 * Money had left the balances that no row recorded.
 *
 * WHY TWO ROWS AND NOT ONE
 *
 * Zeroing the stored balance takes -(balance); zeroing the ledger takes
 * -(ledger). They are different numbers, and choosing either leaves the other
 * wrong — or hides the difference inside one tidy-looking figure.
 *
 * So each wallet gets a VARIANCE row (recording the historical movement that
 * was never written down, without touching the balance, because the balance
 * already reflects it) and a RESET row (which does move the balance, to zero).
 * Both land, or neither does.
 *
 * WHAT IS ASSERTED
 *   · a positive balance with ledger drift ends at stored 0 AND ledger 0
 *   · every historical row survives — nothing deleted, no amount rewritten,
 *     every Stripe reference still present
 *   · a second run changes nothing and reports already_applied
 *   · two concurrent runs produce exactly one reset adjustment
 *   · a wallet with an unresolved transfer, open claim or pending charge is
 *     REFUSED, and its balance is left alone
 *   · anon and authenticated cannot call it at all
 *   · the Step 6/6B invariants still hold afterwards
 *
 * SAFETY
 * Fixtures are built on spare profiles that have no wallet, and removed in
 * after(). The concurrency case cannot be rolled back — proving two connections
 * contend needs rows both can see — so it is torn down explicitly and the
 * teardown asserts the wallet table is back to exactly the production three.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKER = 'S12-RECON-FIXTURE';

function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) throw new Error(`db query error: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return parsed.rows ?? [];
}
function runSql(sql: string): Record<string, unknown>[] {
  return rowsOf(execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }));
}
async function runSqlAsync(sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return rowsOf(stdout);
}
const one = (sql: string) => runSql(sql)[0] ?? {};

/** Every fixture row is tagged, so teardown is by marker and cannot over-reach. */
const purgeFixtures = () => runSql(`
  delete from public.local_wallet_transactions
   where description like '${MARKER}%' or idempotency_key like '${MARKER}%';
  delete from public.local_wallet_balances b
   where not exists (select 1 from public.local_wallet_transactions t where t.user_id = b.user_id)
     and right(b.user_id::text,4) not in ('6e67','2bac','6db5');
  select 1 as done;`);

// ── 1. Production is reconciled and history is intact ───────────────────────

describe('the production wallets are reconciled for launch', () => {
  test('every wallet is at zero, by stored balance AND by ledger', () => {
    const r = one(`
      select count(*)::text                                                  as wallets,
             coalesce(sum(coalesce(b.balance_pence,0)),0)::text              as stored,
             (select coalesce(sum(amount_pence),0)::text
                from public.local_wallet_transactions)                       as ledger
        from public.local_wallet_balances b;`);
    assert.equal(r.stored, '0', `aggregate wallet liability is ${r.stored}p, not zero`);
    assert.equal(r.ledger, '0', `aggregate ledger balance is ${r.ledger}p, not zero`);
  });

  test('no wallet drifts from its own ledger', () => {
    const drifted = runSql(`
      select right(b.user_id::text,4) as tail,
             coalesce(b.balance_pence,0)::text as stored,
             coalesce((select sum(t.amount_pence)::int from public.local_wallet_transactions t
                        where t.user_id = b.user_id),0)::text as ledger
        from public.local_wallet_balances b
       where coalesce(b.balance_pence,0)
             <> coalesce((select sum(t.amount_pence)::int from public.local_wallet_transactions t
                           where t.user_id = b.user_id),0);`);
    assert.deepEqual(drifted, [], `wallets whose balance and ledger disagree: ${JSON.stringify(drifted)}`);
  });

  test('the historical rows were preserved, not deleted or rewritten', () => {
    // 20 pre-Step-6 rows existed before the reset and must still exist, still
    // carrying their Stripe references. A launch tidy-up is not a reason to
    // lose the evidence of what the old code did.
    const r = one(`select
      (select count(*)::text from public.local_wallet_transactions where type <> 'reconciliation') as historical,
      (select count(*)::text from public.local_wallet_transactions
        where type <> 'reconciliation' and stripe_payment_intent_id is not null)                   as with_pi,
      (select count(*)::text from public.local_wallet_transactions
        where type <> 'reconciliation' and stripe_transfer_id is not null)                         as with_transfer,
      (select count(*)::text from public.local_wallet_transactions
        where type <> 'reconciliation' and idempotency_key is not null)                            as with_idem;`);
    assert.equal(r.historical, '20', `expected the 20 historical rows, found ${r.historical}`);
    assert.equal(r.with_pi, '16', 'historical Stripe payment references were lost');
    assert.equal(r.with_transfer, '3', 'historical Stripe transfer references were lost');
    assert.equal(r.with_idem, '0',
      'a historical row gained an idempotency_key — they all predate Step 6 and should be untouched');
  });

  test('each reconciled wallet carries exactly one variance row and one reset row', () => {
    const rows = runSql(`
      select right(user_id::text,4) as tail,
             count(*) filter (where idempotency_key like '%:variance:%')::text as variance_rows,
             count(*) filter (where idempotency_key like '%:reset:%')::text    as reset_rows
        from public.local_wallet_transactions
       where type = 'reconciliation'
       group by user_id order by 1;`);
    assert.equal(rows.length, 3, `expected 3 reconciled wallets, found ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.reset_rows, '1', `wallet …${r.tail} has ${r.reset_rows} reset rows — it may have been reset twice`);
      assert.equal(r.variance_rows, '1', `wallet …${r.tail} has ${r.variance_rows} variance rows`);
    }
  });
});

// ── 2. The mechanism itself ─────────────────────────────────────────────────

describe('the reconciliation mechanism', () => {
  after(() => {
    purgeFixtures();
    const r = one(`select count(*)::text as n,
                          coalesce(sum(coalesce(balance_pence,0)),0)::text as stored
                     from public.local_wallet_balances;`);
    assert.equal(r.n, '3', `fixture wallets leaked into production: ${r.n} wallets remain`);
    assert.equal(r.stored, '0', 'production wallet liability is no longer zero after the tests');
  });

  test('a positive balance with drift ends at zero on BOTH measures', () => {
    purgeFixtures();
    const r = one(`
      create temp table pp as
        select p.id as u from public.profiles p
         where not exists (select 1 from public.local_wallet_balances b where b.user_id = p.id)
         order by p.id offset 30 limit 1;
      insert into public.local_wallet_balances (user_id, balance_pence) select u, 9605 from pp;
      insert into public.local_wallet_transactions (user_id, type, amount_pence, description)
        select u, 'topup', 12000, '${MARKER} historical topup' from pp;
      create temp table res as
        select * from public.wallet_launch_reconciliation((select u from pp), '${MARKER}');
      select status, stored_before::text, ledger_before::text, variance::text,
             stored_after::text, ledger_after::text,
             (select count(*)::text from public.local_wallet_transactions
               where user_id=(select u from pp) and type='topup') as historical_kept
        from res;`);
    assert.equal(r.status, 'reconciled');
    assert.equal(r.stored_before, '9605');
    assert.equal(r.ledger_before, '12000');
    assert.equal(r.variance, '-2395', 'the variance was not recorded as its own quantity');
    assert.equal(r.stored_after, '0', 'the stored balance is not zero');
    assert.equal(r.ledger_after, '0', 'the ledger does not sum to zero');
    assert.equal(r.historical_kept, '1', 'the historical row was removed instead of preserved');
  });

  test('running it again changes nothing', () => {
    const r = one(`
      create temp table pp as
        select b.user_id as u from public.local_wallet_balances b
         where exists (select 1 from public.local_wallet_transactions t
                        where t.user_id=b.user_id and t.idempotency_key like '${MARKER}%')
         limit 1;
      create temp table before as
        select count(*)::int as n from public.local_wallet_transactions where user_id=(select u from pp);
      create temp table again as
        select * from public.wallet_launch_reconciliation((select u from pp), '${MARKER}');
      select (select status from again) as status,
             (select n::text from before) as rows_before,
             (select count(*)::text from public.local_wallet_transactions where user_id=(select u from pp)) as rows_after;`);
    assert.equal(r.status, 'already_applied');
    assert.equal(r.rows_after, r.rows_before, 'a second run wrote more rows');
  });

  test('a wallet with unresolved money movement is refused, untouched', () => {
    purgeFixtures();
    const r = one(`
      create temp table pp as
        select p.id as u from public.profiles p
         where not exists (select 1 from public.local_wallet_balances b where b.user_id = p.id)
         order by p.id offset 31 limit 1;
      insert into public.local_wallet_balances (user_id, balance_pence) select u, 5000 from pp;
      insert into public.local_wallet_transactions (user_id, type, amount_pence, description, transfer_state)
        select u, 'spend', -1000, '${MARKER} unresolved', 'unresolved' from pp;
      create temp table res as
        select * from public.wallet_launch_reconciliation((select u from pp), '${MARKER}');
      select (select status from res) as status,
             (select coalesce(balance_pence,0)::text from public.local_wallet_balances
               where user_id=(select u from pp)) as balance_after,
             (select count(*)::text from public.local_wallet_transactions
               where user_id=(select u from pp) and type='reconciliation') as recon_rows;`);
    assert.equal(r.status, 'refused_unresolved_movement',
      'a wallet with money still moving outside the database was reset anyway');
    assert.equal(r.balance_after, '5000', 'the refused wallet had its balance changed');
    assert.equal(r.recon_rows, '0', 'the refused wallet gained a reconciliation row');
  });

  test('two concurrent runs produce exactly one reset adjustment', async () => {
    purgeFixtures();
    const setup = one(`
      with pp as (
        select p.id as u from public.profiles p
         where not exists (select 1 from public.local_wallet_balances b where b.user_id = p.id)
         order by p.id offset 32 limit 1),
      ins as (insert into public.local_wallet_balances (user_id, balance_pence)
              select u, 9605 from pp returning user_id),
      tx as (insert into public.local_wallet_transactions (user_id, type, amount_pence, description)
             select user_id, 'topup', 12000, '${MARKER} concurrency' from ins returning user_id)
      select (select user_id::text from tx) as uid;`);
    const uid = String(setup.uid);
    assert.match(uid, /^[0-9a-f-]{36}$/, 'no spare profile without a wallet was available');

    const call = () => runSqlAsync(
      `select status from public.wallet_launch_reconciliation('${uid}'::uuid, '${MARKER}-conc');`);
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [String(a[0]?.status), String(b[0]?.status)].sort();
    assert.deepEqual(statuses, ['already_applied', 'reconciled'],
      `expected one reconcile and one already_applied, got ${statuses.join(' + ')}`);

    const after = one(`select
      (select count(*)::text from public.local_wallet_transactions
        where user_id='${uid}'::uuid and idempotency_key like '%:reset:%')  as reset_rows,
      (select coalesce(balance_pence,0)::text from public.local_wallet_balances
        where user_id='${uid}'::uuid)                                        as balance;`);
    assert.equal(after.reset_rows, '1', 'concurrent runs wrote two reset adjustments');
    assert.equal(after.balance, '0');

    runSql(`delete from public.local_wallet_transactions where user_id='${uid}'::uuid;
            delete from public.local_wallet_balances where user_id='${uid}'::uuid; select 1 as done;`);
  });
});

// ── 3. Nobody but the server can call it ────────────────────────────────────

describe('the reconciliation is server-only', () => {
  test('anon and authenticated are refused at the database', () => {
    const rows = runSql(`
      begin;
      create temp table pr (n int generated always as identity, who text, outcome text);
      do $$
      declare v_role text; v_out text;
      begin
        foreach v_role in array array['anon','authenticated'] loop
          begin
            execute format('set local role %I', v_role);
            perform public.wallet_launch_reconciliation(
              (select user_id from public.local_wallet_balances limit 1), 'probe');
            reset role; v_out := 'ALLOWED';
          exception when others then reset role; v_out := 'DENIED'; end;
          insert into pr(who,outcome) values (v_role, v_out);
        end loop;
      end $$;
      select who, outcome from pr order by n;`);
    const allowed = rows.filter((r) => r.outcome === 'ALLOWED');
    assert.deepEqual(allowed, [],
      `client roles can run the wallet reset: ${allowed.map((a) => a.who).join(', ')}`);
  });

  test('only service_role holds EXECUTE', () => {
    const r = one(`select
      has_function_privilege('anon','public.wallet_launch_reconciliation(uuid,text)','EXECUTE')::text          as anon_exec,
      has_function_privilege('authenticated','public.wallet_launch_reconciliation(uuid,text)','EXECUTE')::text as auth_exec,
      has_function_privilege('service_role','public.wallet_launch_reconciliation(uuid,text)','EXECUTE')::text  as svc_exec;`);
    assert.equal(r.anon_exec, 'false');
    assert.equal(r.auth_exec, 'false');
    assert.equal(r.svc_exec, 'true', 'service_role cannot run the reconciliation it is meant to own');
  });
});

/**
 * wallet-attempts.node.test.ts — one purchase has one name, and keeps it.
 *
 * WHY THIS TEST EXISTS
 *
 * Step 6 made the debit and the ledger atomic and keyed the Stripe transfer on
 * the wallet transaction id. Two retry weaknesses survived it, and reproducing
 * them showed the second was a different shape than it looked.
 *
 *   FINDING A — wallet-checkout had no attempt identity. Neither client sent
 *   client_request_id, so all four flows called the debit primitive with a null
 *   idempotency key. Reproduced: two identical 1000p purchases, two distinct
 *   wallet transactions, two spend rows, 2000p gone for one thing bought.
 *
 *   FINDING B — local-wallet-pay deleted its claim on ANY failure, including a
 *   Stripe timeout. Reproduced, and it split in two:
 *
 *     same id on retry → the debit was correctly deduped, but debitAndTransfer
 *                        returned early on already_applied and NEVER RESUMED the
 *                        transfer. The row stayed 'unresolved' for ever while
 *                        the customer was told it had worked.
 *
 *     new id on retry  → a second debit and a second transfer. And this was the
 *                        real-world case, because the mobile client minted its
 *                        id INSIDE the API helper — so every attempt, including
 *                        a second tap, got a fresh one.
 *
 * WHAT IS ASSERTED
 *   · a payment reference is required, and validated before anything moves
 *   · five identical attempts debit once; two concurrent ones debit once
 *   · one reference cannot be reused for a different amount or recipient
 *   · an unresolved attempt keeps its reference AND its transaction
 *   · retrying an unresolved attempt resumes the same transaction, so the
 *     Stripe idempotency key is unchanged
 *   · terminal attempts replay their outcome instead of paying again
 *   · a genuinely new purchase with a new reference still goes through
 *   · no client mints a payment reference inside its API helper
 *
 * SAFETY
 * Everything is rolled back except the concurrency test, which cannot be:
 * proving two transactions contend needs rows both can see. It uses a profile
 * with NO wallet and removes it in after(). The three real wallet accounts are
 * never touched.
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

function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}

function runSql(sql: string): string {
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
    assert.fail(`ATTEMPT REGRESSION in ${area}:\n` +
      failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
  }
}

const SPARE_USER = `(select p.id from public.profiles p
   where not exists (select 1 from public.local_wallet_transactions t where t.user_id = p.id)
     and not exists (select 1 from public.local_wallet_balances b where b.user_id = p.id
                       and exists (select 1 from public.local_wallet_transactions t2 where t2.user_id = b.user_id))
   order by p.id offset 1 limit 1)`;

// ── 1. The attempt registry ─────────────────────────────────────────────────

describe('a payment attempt is a durable thing', () => {
  let rows: Case[] = [];

  before(() => {
    const out = runSql(`begin;
create temp table pp as select ${SPARE_USER} u,
  (select p.id from public.profiles p order by p.id offset 7 limit 1) other;
create temp table seed as select * from public.wallet_credit_with_ledger((select u from pp), 20000, 'topup', null, 'float', 'at:seed');
create temp table res (n int generated always as identity, area text, case_name text, expected text, actual text);

-- ══ lifecycle ═════════════════════════════════════════════════════════════
create temp table c1 as select * from public.claim_wallet_attempt('ATT-1',(select u from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'lifecycle','a new reference is claimed','claimed',(select outcome from c1);

create temp table c2 as select * from public.claim_wallet_attempt('ATT-1',(select u from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'lifecycle','a duplicate while in flight is held off','in_flight',(select outcome from c2);

-- ══ payload binding ═══════════════════════════════════════════════════════
create temp table c3 as select * from public.claim_wallet_attempt('ATT-1',(select u from pp),'fp-membership-5000');
insert into res(area,case_name,expected,actual) select 'binding','the same reference for a different purchase','conflict',(select outcome from c3);

create temp table c4 as select * from public.claim_wallet_attempt('ATT-1',(select other from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'binding','somebody else cannot use your reference','conflict',(select outcome from c4);

-- ══ unresolved: the attempt is kept, not released ═════════════════════════
create temp table t1 as select * from public.wallet_debit_with_ledger(
  (select u from pp), 1500, 0, 'spend', null, 'Payment at Shop', 'wallet-attempt:ATT-1', 50, true);
create temp table mk as select public.wallet_mark_transfer((select transaction_id from t1),'unresolved',null) ok;
create temp table st as select public.settle_wallet_attempt('ATT-1','unresolved',(select transaction_id from t1),null) ok;

insert into res(area,case_name,expected,actual) select 'unresolved','the attempt row still exists','1',
  (select count(*)::text from public.wallet_payment_claims where client_request_id='ATT-1');
create temp table c5 as select * from public.claim_wallet_attempt('ATT-1',(select u from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'unresolved','retrying it resumes rather than re-claims','resume',(select outcome from c5);
insert into res(area,case_name,expected,actual) select 'unresolved','and points at the SAME wallet transaction','true',
  ((select wallet_transaction_id from c5) = (select transaction_id from t1))::text;
insert into res(area,case_name,expected,actual) select 'unresolved','so the Stripe key is unchanged','true',
  (('wallet-txn:' || (select wallet_transaction_id from c5)) = ('wallet-txn:' || (select transaction_id from t1)))::text;

-- the debit itself must not repeat while resuming
create temp table t2 as select * from public.wallet_debit_with_ledger(
  (select u from pp), 1500, 0, 'spend', null, 'Payment at Shop', 'wallet-attempt:ATT-1', 50, true);
insert into res(area,case_name,expected,actual) select 'unresolved','resuming does not debit again','true',(select already_applied::text from t2);
insert into res(area,case_name,expected,actual) select 'unresolved','one spend row for the whole saga','1',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='wallet-attempt:ATT-1');

-- ══ terminal states replay ════════════════════════════════════════════════
create temp table sc as select public.settle_wallet_attempt('ATT-1','completed',null,'{\"balance_pence\":18500}'::jsonb) ok;
create temp table c6 as select * from public.claim_wallet_attempt('ATT-1',(select u from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'terminal','a completed attempt replays','replay',(select outcome from c6);
insert into res(area,case_name,expected,actual) select 'terminal','and hands back what happened','18500',((select result from c6)->>'balance_pence');

create temp table c7 as select * from public.claim_wallet_attempt('ATT-REV',(select u from pp),'fp-x');
create temp table t3 as select * from public.wallet_debit_with_ledger((select u from pp), 300, 0, 'spend', null, 'y', 'wallet-attempt:ATT-REV', null, true);
create temp table rv as select * from public.wallet_reverse_debit((select transaction_id from t3),'transfer rejected');
create temp table sv as select public.settle_wallet_attempt('ATT-REV','reversed',(select transaction_id from t3),null) ok;
create temp table c8 as select * from public.claim_wallet_attempt('ATT-REV',(select u from pp),'fp-x');
insert into res(area,case_name,expected,actual) select 'terminal','a reversed attempt is terminal, not retryable','replay',(select outcome from c8);
insert into res(area,case_name,expected,actual) select 'terminal','its status says reversed','reversed',(select status from c8);
create temp table rv2 as select * from public.wallet_reverse_debit((select transaction_id from t3),'again');
insert into res(area,case_name,expected,actual) select 'terminal','and it cannot be reversed twice','true',(select already_reversed::text from rv2);

-- ══ a genuinely new purchase still works ══════════════════════════════════
create temp table c9 as select * from public.claim_wallet_attempt('ATT-2',(select u from pp),'fp-donation-1000');
insert into res(area,case_name,expected,actual) select 'new purchase','a new reference for the same thing is allowed','claimed',(select outcome from c9);
create temp table t4 as select * from public.wallet_debit_with_ledger((select u from pp), 1500, 0, 'spend', null, 'again', 'wallet-attempt:ATT-2', 50, true);
insert into res(area,case_name,expected,actual) select 'new purchase','and it genuinely debits','false',(select already_applied::text from t4);
insert into res(area,case_name,expected,actual) select 'new purchase','producing a second, distinct transaction','true',
  ((select transaction_id from t4) is distinct from (select transaction_id from t1))::text;

-- ══ five identical attempts ═══════════════════════════════════════════════
create temp table d1 as select * from public.wallet_debit_with_ledger((select u from pp), 700, 0, 'spend', null, 'five', 'wallet-attempt:ATT-5', null, false);
create temp table d2 as select * from public.wallet_debit_with_ledger((select u from pp), 700, 0, 'spend', null, 'five', 'wallet-attempt:ATT-5', null, false);
create temp table d3 as select * from public.wallet_debit_with_ledger((select u from pp), 700, 0, 'spend', null, 'five', 'wallet-attempt:ATT-5', null, false);
create temp table d4 as select * from public.wallet_debit_with_ledger((select u from pp), 700, 0, 'spend', null, 'five', 'wallet-attempt:ATT-5', null, false);
create temp table d5 as select * from public.wallet_debit_with_ledger((select u from pp), 700, 0, 'spend', null, 'five', 'wallet-attempt:ATT-5', null, false);
insert into res(area,case_name,expected,actual) select 'repeat','four of five identical attempts are no-ops','4',
  ((select already_applied::int from d2)+(select already_applied::int from d3)
  +(select already_applied::int from d4)+(select already_applied::int from d5))::text;
insert into res(area,case_name,expected,actual) select 'repeat','one spend row','1',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key='wallet-attempt:ATT-5');

-- ══ the four wallet-checkout flows, each with its own reference shape ═════
-- One statement per call. Folding the debits and the count into a single
-- statement reads the PRE-statement snapshot and reports zero regardless —
-- an assertion that always passes against nothing, or always fails.
create temp table fd1 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'hub_donation',   'wallet-attempt:F-hub_donation',   null, true);
create temp table fd2 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'hub_donation',   'wallet-attempt:F-hub_donation',   null, true);
create temp table fm1 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'hub_membership', 'wallet-attempt:F-hub_membership', null, true);
create temp table fm2 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'hub_membership', 'wallet-attempt:F-hub_membership', null, true);
create temp table fu1 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'unit_purchase',  'wallet-attempt:F-unit_purchase',  null, true);
create temp table fu2 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'unit_purchase',  'wallet-attempt:F-unit_purchase',  null, true);
create temp table fs1 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'shift_boost',    'wallet-attempt:F-shift_boost',    null, false);
create temp table fs2 as select * from public.wallet_debit_with_ledger((select u from pp), 200, 0, 'spend', null, 'shift_boost',    'wallet-attempt:F-shift_boost',    null, false);

insert into res(area,case_name,expected,actual)
select 'four flows', c.flow || ': repeated attempt debits once', '1',
  (select count(*)::text from public.local_wallet_transactions where idempotency_key = 'wallet-attempt:F-'||c.flow)
from (values ('hub_donation'),('hub_membership'),('unit_purchase'),('shift_boost')) c(flow);

insert into res(area,case_name,expected,actual)
select 'four flows', c.flow || ': the second attempt was a no-op', 'true', c.second
from (values ('hub_donation',(select already_applied::text from fd2)),
             ('hub_membership',(select already_applied::text from fm2)),
             ('unit_purchase',(select already_applied::text from fu2)),
             ('shift_boost',(select already_applied::text from fs2))) c(flow,second);

insert into res(area,case_name,expected,actual)
select 'four flows','shift_boost needs no Connect transfer','none',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='wallet-attempt:F-shift_boost');
insert into res(area,case_name,expected,actual)
select 'four flows','the other three do','pending',
  (select transfer_state from public.local_wallet_transactions where idempotency_key='wallet-attempt:F-hub_donation');

select n, area, case_name, expected, actual,
  case when expected is not distinct from actual then 'PASS' else 'FAIL' end verdict from res order by n;
rollback;`);

    const parsed = JSON.parse(out) as { rows?: Case[]; _tag?: string; error?: unknown };
    if (parsed._tag === 'Error' || parsed.error) {
      throw new Error(`attempt matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
    }
    rows = (parsed.rows ?? []).filter((r) => r.verdict);
    assert.ok(rows.length >= 20, `expected the full attempt matrix, got ${rows.length} cases`);
  });

  test('claim, duplicate and hold-off', () => assertAllPass(rows, 'lifecycle'));
  test('a reference is bound to one instruction and one person', () => assertAllPass(rows, 'binding'));
  test('an unresolved attempt is kept and resumed, never released', () => assertAllPass(rows, 'unresolved'));
  test('terminal attempts replay instead of paying again', () => assertAllPass(rows, 'terminal'));
  test('a new reference is a new purchase', () => assertAllPass(rows, 'new purchase'));
  test('repeated identical attempts debit once', () => assertAllPass(rows, 'repeat'));
  test('all four wallet-checkout flows', () => assertAllPass(rows, 'four flows'));
});

// ── 2. Two copies of one attempt arriving together ──────────────────────────

describe('two copies of one purchase arriving together', () => {
  let user = '';

  before(() => {
    const r = query(`select ${SPARE_USER}::text as u;`);
    user = String(r.u);
    assert.match(user, /^[0-9a-f-]{36}$/, 'no spare profile without a wallet was available');
  });

  after(() => {
    query(`delete from public.wallet_payment_claims where user_id='${user}';
           delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}'; select 1;`);
    const left = query(`select count(*)::int as n from public.local_wallet_balances where user_id='${user}';`);
    assert.equal(left.n, 0, 'this suite left its test wallet behind');
  });

  test('exactly one copy may claim the reference', async () => {
    query(`delete from public.wallet_payment_claims where client_request_id like 'RACE-%';
           delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}';
           insert into public.local_wallet_balances (user_id, balance_pence) values ('${user}', 10000); select 1;`);

    const a = queryAsync(`begin;
create temp table x as select * from public.claim_wallet_attempt('RACE-1','${user}','fp-race');
select pg_sleep(6);
select outcome r from x;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select outcome as r from public.claim_wallet_attempt('RACE-1','${user}','fp-race');`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.r), String(rb.r)];
    assert.equal(results.filter((x) => x === 'claimed').length, 1,
      `both copies claimed the same reference. Got ${JSON.stringify(results)}`);

    const st = query(`select count(*)::int as n from public.wallet_payment_claims where client_request_id='RACE-1';`);
    assert.equal(st.n, 1, 'the registry holds more than one row for one reference');
  });

  test('and only one of them debits', async () => {
    query(`delete from public.wallet_payment_claims where client_request_id like 'RACE-%';
           delete from public.local_wallet_transactions where user_id='${user}';
           delete from public.local_wallet_balances where user_id='${user}';
           insert into public.local_wallet_balances (user_id, balance_pence) values ('${user}', 10000); select 1;`);

    const a = queryAsync(`begin;
create temp table y as select * from public.wallet_debit_with_ledger('${user}', 2500, 0, 'spend', null, 'race pay', 'wallet-attempt:RACE-2', null, true);
select pg_sleep(6);
select case when already_applied then 'already' else 'applied' end r from y;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select case when already_applied then 'already' else 'applied' end as r
  from public.wallet_debit_with_ledger('${user}', 2500, 0, 'spend', null, 'race pay', 'wallet-attempt:RACE-2', null, true);`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.r), String(rb.r)];
    assert.equal(results.filter((x) => x === 'applied').length, 1,
      `one purchase debited twice. Got ${JSON.stringify(results)}`);

    const st = query(`select b.balance_pence,
      (select count(*)::int from public.local_wallet_transactions t where t.user_id='${user}') rows_
      from public.local_wallet_balances b where b.user_id='${user}';`);
    assert.equal(st.balance_pence, 7500, 'the money moved more than once');
    assert.equal(st.rows_, 1, 'one purchase wrote two accounting entries');
  });
});

// ── 3. No client may mint a reference inside its API helper ─────────────────

describe('references are minted where the customer commits', () => {
  // Sibling checkout, not an absolute path — the suite has to run on any machine.
  const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

  test('the mobile API helper does not mint its own', () => {
    const src = readFileSync(join(REPO_ROOT, 'lib/local-api.ts'), 'utf8');
    // The old shape: paymentAttemptId() called at the invoke site, so a second
    // tap produced a second reference and therefore a second payment.
    assert.ok(!/randomUUID|Math\.random/.test(src.slice(src.indexOf('payWithWallet'), src.indexOf('payWithWallet') + 2000)),
      'lib/local-api.ts mints a payment reference itself — it must take one as a parameter');
    for (const fn of ['walletCheckout', 'payWithWallet', 'payWithWalletViaTile']) {
      assert.match(src, new RegExp(`export async function ${fn}\\([^)]*attemptId: string`),
        `${fn} must take the attempt id as a parameter`);
    }
  });

  test('the web API helper does not mint its own', () => {
    const src = readFileSync(join(WEB, 'lib/local-commerce-client.ts'), 'utf8');
    assert.ok(!/Math\.random/.test(src),
      'the web wallet client still has a Math.random fallback — a guessable payment reference is collidable');
    for (const fn of ['walletCheckout', 'payWithWallet']) {
      assert.match(src, new RegExp(`export async function ${fn}\\([\\s\\S]{0,200}?attemptId: string`),
        `${fn} must take the attempt id as a parameter`);
    }
  });

  test('every wallet call site passes one', () => {
    const files = [
      join(REPO_ROOT, 'app/local-buy-unit.tsx'), join(REPO_ROOT, 'app/hub-donate.tsx'),
      join(REPO_ROOT, 'app/hubs/[id].tsx'), join(REPO_ROOT, 'app/local-pay.tsx'),
      join(REPO_ROOT, 'app/nfc/[token].tsx'),
      join(WEB, 'components/local/PayAtTillCard.tsx'), join(WEB, 'components/local/BuyUnitModal.tsx'),
      // The membership wallet/card buttons used to live in HubMembershipPanel.
      // That panel now renders one "Join" per tier and defers the choice of how
      // to pay to the checkout, so the attempt id moved with it. Assert the
      // place that actually mints the payment, not the place it used to be.
      join(WEB, 'components/hubs/MembershipCheckout.tsx'), join(WEB, 'components/hubs/DonateModal.tsx'),
      join(WEB, 'components/jobs/ShiftBoostModal.tsx'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.match(src, /useAttemptId\(/, `${f} must hold its attempt id across renders`);
      assert.match(src, /attemptId\(\)/, `${f} must pass its attempt id to the wallet call`);
    }
  });
});

// ── 4. The registry is not reachable from a browser ─────────────────────────

describe('the attempt registry stays server-only', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const denied: Array<[string, Record<string, unknown>]> = [
    ['claim_wallet_attempt',  { p_request_id: 'x', p_user: NIL, p_fingerprint: 'f' }],
    ['settle_wallet_attempt', { p_request_id: 'x', p_status: 'completed' }],
    ['get_wallet_attempt',    { p_request_id: 'x', p_user: NIL }],
  ];

  for (const [fn, body] of denied) {
    test(`anon cannot call ${fn}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.notEqual(res.status, 404, `${fn}: signature drifted — this probe stopped testing anything`);
      assert.equal(res.status, 401, `SECURITY REGRESSION: ${fn} answered the anon key with HTTP ${res.status}`);
    });
  }

  for (const verb of ['GET', 'POST', 'PATCH', 'DELETE']) {
    test(`anon cannot ${verb} wallet_payment_claims`, async () => {
      const qs = verb === 'GET' ? '?select=*' : (verb === 'POST' ? '' : '?client_request_id=eq.x');
      const res = await fetch(`${cfg!.url}/rest/v1/wallet_payment_claims${qs}`, {
        method: verb,
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        ...(verb === 'POST' ? { body: JSON.stringify({ client_request_id: 'forged', user_id: NIL }) } : {}),
        ...(verb === 'PATCH' ? { body: JSON.stringify({ status: 'completed' }) } : {}),
      });
      assert.equal(res.status, 401,
        `anon ${verb} on wallet_payment_claims returned HTTP ${res.status} — the attempt registry must not be client-writable`);
    });
  }
});

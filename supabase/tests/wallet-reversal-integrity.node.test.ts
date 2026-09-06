/**
 * wallet-reversal-integrity.node.test.ts — the refund path, executed.
 *
 * wallet_reverse_debit is the only thing that puts wallet money back. It has
 * been argued about in comments since it was written and never once run: the
 * eight test files that mention it all read the source and assert on the words
 * in it. This runs it.
 *
 * WHAT IS BEING SETTLED
 *
 * 1. The reversal appends exactly one linked refund row, credits the wallet
 *    exactly once, and leaves the original debit intact.
 *
 * 2. The original spend is marked 'reversed' when its transfer had been SENT,
 *    and 'failed' when it never reached the merchant. Those were the same value
 *    before 20261002120000, which is what made a successful refund look like
 *    unresolved external movement and jam wallet_launch_reconciliation for
 *    ever. Both halves are proved, and the pre-fix behaviour is executed
 *    alongside so the difference is demonstrated rather than asserted.
 *
 * 3. Two protections stand between a retry and a second credit, and they are
 *    INDEPENDENT:
 *      a. the reverses_transaction_id guard, taken under SELECT ... FOR UPDATE
 *         on the original row;
 *      b. the derived '<key>:reversal' idempotency key, which is a UNIQUE index
 *         in the database.
 *    A spend with no idempotency key has only (a). A concurrent pair has only
 *    the lock ordering. Each is mutated separately, and each mutation is caught
 *    by a case the other protection cannot save.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. Every function under test is read from the real
 * migrations at run time. No production wallet, transfer or pass is touched.
 *
 * wallet_payment_claims and wallet_charge_requests are created here as minimal
 * stand-ins: wallet_launch_reconciliation reads two columns from each to count
 * blockers, and nothing else in this suite touches them. The functions under
 * test are always the real ones.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
const FIX = join(MIG, '20261002120000_wallet_transfer_state_reversed.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');
const args = (b: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', b];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));

function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let d = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

const U = 'u0000000-0000-4000-8000-00000000000u'.replace(/u/g, 'a');
const V = 'b0000000-0000-4000-8000-00000000000b';   // an unrelated wallet
const BIZ = 'c0000000-0000-4000-8000-00000000000c';
const KEYED = '11110000-0000-4000-8000-000000000001';
const UNKEYED = '22220000-0000-4000-8000-000000000002';
const PENDING = '33330000-0000-4000-8000-000000000003';
const TOPUP = '44440000-0000-4000-8000-000000000004';

/** The real credit primitive and the real reconciliation, always. */
const creditFn = () => slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;');
const reconFn = () => slice(RECON, 'create or replace function public.wallet_launch_reconciliation', '$$;');
const typeWiden = () => slice(
  RECON,
  'alter table public.local_wallet_transactions\n  drop constraint if exists local_wallet_transactions_type_check;',
  "'reconciliation']));");

/** Production as applied today: reversal always writes 'failed'. */
const prodReverse = () => slice(LEDGER, 'create or replace function public.wallet_reverse_debit', '$$;');
/** The hardened reversal from the new migration. */
const fixedReverse = () => slice(FIX, 'create or replace function public.wallet_reverse_debit', '$$;');
const fixedConstraint = () => slice(FIX, 'alter table public.local_wallet_transactions\n  add constraint', ';');

/**
 * Rebuild from nothing. `reverseSql` decides which reversal is under test, so
 * the pre-fix and post-fix behaviours are executed against identical fixtures.
 */
function schema(reverseSql: string, allowReversed: boolean) {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_balances ('),
    'alter table public.local_wallet_balances add primary key (user_id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    `alter table public.local_wallet_transactions
       add column idempotency_key text,
       add column transfer_state text,
       add column reverses_transaction_id uuid references public.local_wallet_transactions(id);`,
    `create unique index local_wallet_transactions_idempotency_key
       on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;`,
    allowReversed
      ? fixedConstraint()
      : `alter table public.local_wallet_transactions
           add constraint local_wallet_transactions_transfer_state_check
           check (transfer_state is null or transfer_state in ('none','pending','sent','failed','unresolved'));`,
    typeWiden(),
    // Minimal stand-ins: reconciliation counts blockers from these two.
    'create table public.wallet_payment_claims (user_id uuid, status text);',
    'create table public.wallet_charge_requests (customer_id uuid, status text);',
    creditFn(),
    reverseSql,
    reconFn(),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1200)}`);
}

/** Four ledger rows and a balance that matches them exactly. */
function fixtures() {
  const out = raw([
    `insert into public.local_wallet_balances (user_id, balance_pence) values ('${U}', 200), ('${V}', 5000);`,
    `insert into public.local_wallet_transactions
       (id, user_id, business_id, type, amount_pence, platform_fee_pence, description, idempotency_key, transfer_state, stripe_transfer_id)
     values
       ('${KEYED}',   '${U}', '${BIZ}', 'spend', -300, 15, 'Keyed spend',   'wallet-attempt:keyed', 'sent',    'tr_keyed'),
       ('${UNKEYED}', '${U}', '${BIZ}', 'spend', -300, 15, 'Unkeyed spend', null,                   'sent',    'tr_unkeyed'),
       ('${PENDING}', '${U}', '${BIZ}', 'spend', -300, 15, 'Never sent',    'wallet-attempt:pend',  'pending', null),
       ('${TOPUP}',   '${U}', null,     'topup',  1100, null, 'Top-up',     'topup:1',              'none',    null);`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixtures failed:\n${out.slice(0, 900)}`);
}

/** The fixture's un-sent spend, settled, so only the reversal is in question. */
const settlePending = () =>
  raw(`update public.local_wallet_transactions set transfer_state='sent' where id = '${PENDING}';`);

const reverse = (id: string, reason = 'Refund') =>
  raw(`select already_reversed from public.wallet_reverse_debit('${id}', '${reason}');`);
const refundRows = (id: string) =>
  num(`select count(*)::text from public.local_wallet_transactions where reverses_transaction_id = '${id}';`);
const balance = (u: string) =>
  num(`select coalesce(balance_pence,0)::text from public.local_wallet_balances where user_id = '${u}';`);
const ledgerSum = (u: string) =>
  num(`select coalesce(sum(amount_pence),0)::text from public.local_wallet_transactions where user_id = '${u}';`);
const stateOf = (id: string) =>
  scalar(`select coalesce(transfer_state,'(null)') from public.local_wallet_transactions where id = '${id}';`);

/**
 * Two reversals of one row, genuinely overlapped.
 *
 * A reverses and then HOLDS its transaction open; B arrives while A is still
 * uncommitted. Sleeping before the call instead would just run them in
 * sequence, which proves nothing — the first version of this did exactly that
 * and reported the lock as load-bearing when the two had never met.
 */
async function raceReverse(id: string): Promise<string[]> {
  const a = rawAsync(
    `begin; select already_reversed from public.wallet_reverse_debit('${id}', 'Race A'); select pg_sleep(0.6); commit;`);
  await new Promise((r) => setTimeout(r, 120));
  const b = rawAsync(
    `begin; select already_reversed from public.wallet_reverse_debit('${id}', 'Race B'); commit;`);
  return Promise.all([a, b]);
}

/* Each stage rebuilds the schema, so its state must be READ while it exists.
   Querying afterwards would ask the last stage's database about the first. */
const fixed = {
  firstAlready: '', refundRowsAfterFirst: 0, balanceAfterFirst: 0, ledgerAfterFirst: 0,
  originalAmount: 0, originalType: '', sentState: '', pendingState: '',
  secondAlready: '', refundRowsAfterSecond: 0, balanceAfterSecond: 0,
  unkeyedSecondAlready: '', unkeyedRefundRows: 0, unkeyedBalance: 0,
  topupError: '', otherWallet: 0, reconStatus: '', refundLinkedAmount: 0, refundType: '',
  raceRefundRows: 0, raceBalance: 0,
};
const prod = { sentState: '', reconStatus: '' };
/* Read from the migration text, asserted by name below rather than in before():
   a mutation that moves one of these should fail ONE test, not the file. */
const anchors = { guard: false, verdict: false, lock: false, key: false };
const mut = {
  m1RefundRows: 0, m1Balance: 0,
  m2State: '', m2Recon: '',
  m3RefundRows: 0, m3Balance: 0,
  m4RefundRows: 0, m4Balance: 0,
  m1Installed: '', m2Installed: '', m3Installed: '', m4Installed: '',
};

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // ── 1. The hardened reversal, end to end ─────────────────────────────────
  schema(fixedReverse(), true);
  fixtures();

  fixed.firstAlready = value(reverse(KEYED, 'Refund of keyed spend'));
  fixed.refundRowsAfterFirst = refundRows(KEYED);
  fixed.balanceAfterFirst = balance(U);
  fixed.ledgerAfterFirst = ledgerSum(U);
  fixed.originalAmount = num(`select amount_pence::text from public.local_wallet_transactions where id='${KEYED}';`);
  fixed.originalType = scalar(`select type from public.local_wallet_transactions where id='${KEYED}';`);
  fixed.sentState = stateOf(KEYED);
  fixed.refundLinkedAmount = num(
    `select amount_pence::text from public.local_wallet_transactions where reverses_transaction_id='${KEYED}';`);
  fixed.refundType = scalar(
    `select type from public.local_wallet_transactions where reverses_transaction_id='${KEYED}';`);
  fixed.otherWallet = balance(V);

  // A second reversal of the same keyed spend.
  fixed.secondAlready = value(reverse(KEYED, 'Refund again'));
  fixed.refundRowsAfterSecond = refundRows(KEYED);
  fixed.balanceAfterSecond = balance(U);

  // The unkeyed spend: only the row guard protects it.
  reverse(UNKEYED, 'Refund unkeyed');
  fixed.unkeyedSecondAlready = value(reverse(UNKEYED, 'Refund unkeyed again'));
  fixed.unkeyedRefundRows = refundRows(UNKEYED);
  fixed.unkeyedBalance = balance(U);

  // A spend whose transfer never went: still 'failed'.
  reverse(PENDING, 'Transfer rejected');
  fixed.pendingState = stateOf(PENDING);

  // A credit is not a spend.
  fixed.topupError = raw(`select * from public.wallet_reverse_debit('${TOPUP}', 'nope');`);

  // ── 1b. Reconciliation must not see a settled reversal as in flight ──────
  //
  // Its own stage, because the fixture deliberately contains a spend still in
  // 'pending' — which reconciliation blocks on for reasons that have nothing
  // to do with reversal. Settling it isolates the one thing under test.
  schema(fixedReverse(), true);
  fixtures();
  settlePending();
  reverse(KEYED, 'Refund of keyed spend');
  fixed.reconStatus = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // ── 1c. The same contention, against the real function ───────────────────
  schema(fixedReverse(), true);
  fixtures();
  await raceReverse(UNKEYED);
  fixed.raceRefundRows = refundRows(UNKEYED);
  fixed.raceBalance = balance(U);

  // ── 2. The same fixtures against production as applied today ─────────────
  schema(prodReverse(), false);
  fixtures();
  settlePending();
  reverse(KEYED, 'Refund of keyed spend');
  prod.sentState = stateOf(KEYED);
  prod.reconStatus = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // ── 3. Mutation: the reverses_transaction_id guard removed ───────────────
  const guard = `  select id into v_existing from public.local_wallet_transactions
   where reverses_transaction_id = p_transaction_id
   limit 1;
  if v_existing is not null then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = v_orig.user_id), 0),
      v_existing, true;
    return;
  end if;`;
  anchors.guard = fixedReverse().includes(guard);
  const m1 = fixedReverse().replace(guard, '  v_existing := null;');
  schema(m1, true);
  fixtures();
  mut.m1Installed = scalar(
    `select case when position('v_existing := null' in pg_get_functiondef(p.oid)) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);
  reverse(UNKEYED, 'first');
  reverse(UNKEYED, 'second');
  mut.m1RefundRows = refundRows(UNKEYED);
  mut.m1Balance = balance(U);

  // ── 4. Mutation: 'reversed' put back to 'failed' ─────────────────────────
  const verdict = `  v_state := case when v_orig.transfer_state = 'sent' then 'reversed' else 'failed' end;`;
  anchors.verdict = fixedReverse().includes(verdict);
  const m2 = fixedReverse().replace(verdict, `  v_state := 'failed';`);
  schema(m2, true);
  fixtures();
  settlePending();
  mut.m2Installed = scalar(
    `select case when position('v_state := ''failed''' in pg_get_functiondef(p.oid)) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);
  reverse(KEYED, 'refund');
  mut.m2State = stateOf(KEYED);
  mut.m2Recon = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // ── 5. Mutation: the row lock removed ────────────────────────────────────
  const lock = `   where id = p_transaction_id
     for update;`;
  anchors.lock = fixedReverse().includes(lock);
  const m3 = fixedReverse().replace(lock, `   where id = p_transaction_id;`);
  schema(m3, true);
  fixtures();
  mut.m3Installed = scalar(
    `select case when position('for update' in lower(pg_get_functiondef(p.oid))) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);
  await raceReverse(UNKEYED);
  mut.m3RefundRows = refundRows(UNKEYED);
  mut.m3Balance = balance(U);

  // ── 6. Mutation: the derived reversal key removed, guard also gone ───────
  //
  // On its own the key is invisible, because the guard already stops the
  // second call. Removing BOTH is what shows the key is a real second layer:
  // with the guard gone, the KEYED spend is protected by the unique index
  // alone, and this proves that is not decoration.
  const key = `    case when v_orig.idempotency_key is null then null else v_orig.idempotency_key || ':reversal' end,`;
  anchors.key = fixedReverse().includes(key);
  const m4 = fixedReverse().replace(guard, '  v_existing := null;').replace(key, '    null,');
  schema(m4, true);
  fixtures();
  mut.m4Installed = scalar(
    `select case when position(''':reversal''' in pg_get_functiondef(p.oid)) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);
  reverse(KEYED, 'first');
  reverse(KEYED, 'second');
  mut.m4RefundRows = refundRows(KEYED);
  mut.m4Balance = balance(U);

  // Leave a hardened database behind, so a stray query reads the real thing.
  schema(fixedReverse(), true);
});

describe('wallet_reverse_debit — the credit itself', () => {
  test('a first reversal is not reported as already done', () => {
    assert.equal(fixed.firstAlready, 'f');
  });

  test('exactly one refund row is appended, linked to the original', () => {
    assert.equal(fixed.refundRowsAfterFirst, 1);
    assert.equal(fixed.refundType, 'refund');
    assert.equal(fixed.refundLinkedAmount, 300);
  });

  test('the wallet is credited exactly once', () => {
    assert.equal(fixed.balanceAfterFirst, 500);
  });

  test('stored balance and ledger sum agree after the reversal', () => {
    assert.equal(fixed.balanceAfterFirst, fixed.ledgerAfterFirst);
  });

  test('the original debit is left intact, not edited away', () => {
    assert.equal(fixed.originalAmount, -300);
    assert.equal(fixed.originalType, 'spend');
  });

  test('another wallet is never touched', () => {
    assert.equal(fixed.otherWallet, 5000);
  });
});

describe('wallet_reverse_debit — what the original is marked', () => {
  test('a spend whose transfer was SENT becomes reversed', () => {
    assert.equal(fixed.sentState, 'reversed');
  });

  test('a spend whose transfer never went stays failed', () => {
    assert.equal(fixed.pendingState, 'failed');
  });

  test('production as applied today marks a sent transfer failed', () => {
    assert.equal(prod.sentState, 'failed');
  });
});

describe('reconciliation after a reversal', () => {
  test('a settled reversal is not counted as movement in flight', () => {
    assert.equal(fixed.reconStatus, 'reconciled');
  });

  test('production as applied today refuses the same wallet', () => {
    assert.equal(prod.reconStatus, 'refused_unresolved_movement');
  });
});

describe('a second reversal', () => {
  test('is reported as already reversed', () => {
    assert.equal(fixed.secondAlready, 't');
    assert.equal(fixed.unkeyedSecondAlready, 't');
  });

  test('appends no second refund row', () => {
    assert.equal(fixed.refundRowsAfterSecond, 1);
    assert.equal(fixed.unkeyedRefundRows, 1);
  });

  test('credits nothing further', () => {
    // 500 after the keyed reversal, 800 after the unkeyed one, and no more.
    assert.equal(fixed.balanceAfterSecond, 500);
    assert.equal(fixed.unkeyedBalance, 800);
  });
});

describe('two reversals at once', () => {
  test('leave exactly one refund row', () => {
    assert.equal(fixed.raceRefundRows, 1);
  });

  test('credit the wallet exactly once', () => {
    assert.equal(fixed.raceBalance, 500);
  });
});

describe('what cannot be reversed', () => {
  test('a top-up is refused', () => {
    assert.match(fixed.topupError, /only a spend can be reversed/i);
  });
});

describe('the suite is anchored to the real migration', () => {
  test('the reverses_transaction_id guard is where the mutations expect it', () => {
    assert.ok(anchors.guard);
  });
  test('the reversed/failed verdict is where the mutations expect it', () => {
    assert.ok(anchors.verdict);
  });
  test('the SELECT ... FOR UPDATE is where the mutations expect it', () => {
    assert.ok(anchors.lock);
  });
  test('the derived :reversal key is where the mutations expect it', () => {
    assert.ok(anchors.key);
  });
});

describe('mutations — each protection is load-bearing', () => {
  test('M1 removing the reversal guard double-credits an unkeyed spend', () => {
    assert.equal(mut.m1Installed, 'yes', 'the mutated function was not installed');
    assert.equal(mut.m1RefundRows, 2);
    assert.equal(mut.m1Balance, 800);
  });

  test('M2 marking a sent transfer failed jams reconciliation', () => {
    assert.equal(mut.m2Installed, 'yes', 'the mutated function was not installed');
    assert.equal(mut.m2State, 'failed');
    assert.equal(mut.m2Recon, 'refused_unresolved_movement');
  });

  test('M3 removing FOR UPDATE lets two concurrent reversals both credit', () => {
    assert.equal(mut.m3Installed, 'no', 'the lock was not actually removed');
    assert.equal(mut.m3RefundRows, 2);
    assert.equal(mut.m3Balance, 800);
  });

  test('M4 removing the derived reversal key allows a second credit', () => {
    assert.equal(mut.m4Installed, 'no', 'the derived key was not actually removed');
    assert.equal(mut.m4RefundRows, 2);
    assert.equal(mut.m4Balance, 800);
  });
});

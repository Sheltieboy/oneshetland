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
const RECOVERY = join(MIG, '20260826140000_wallet_refund_and_dispute_recovery.sql');
const DEBIT = join(MIG, '20260826150000_wallet_spend_blocked_by_recovery.sql');
const RECONFIX = join(MIG, '20261003120000_reconciliation_accepts_refused_transfers.sql');

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
const KEYED    = '11110000-0000-4000-8000-000000000001';  // sent,       keyed
const UNKEYED  = '22220000-0000-4000-8000-000000000002';  // sent,       no key
const PENDING  = '33330000-0000-4000-8000-000000000003';  // pending
const TOPUP    = '44440000-0000-4000-8000-000000000004';  // a credit
const NONEROW  = '55550000-0000-4000-8000-000000000005';  // none,       keyed
const NONEFREE = '66660000-0000-4000-8000-000000000006';  // none,       no key
const FAILROW  = '77770000-0000-4000-8000-000000000007';  // failed
const UNRES    = '88880000-0000-4000-8000-000000000008';  // unresolved
const REVMARK  = '99990000-0000-4000-8000-000000000009';  // reversed, with no reversal

/** The real credit primitive and the real reconciliation, always. */
const creditFn = () => slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;');
const reconFn = () => slice(RECON, 'create or replace function public.wallet_launch_reconciliation', 'end $$;');
/** The same function with 'failed' out of the blocker set. */
const reconFixed = () => slice(RECONFIX, 'create or replace function public.wallet_launch_reconciliation', 'end $$;');

/** Everything the REAL debit primitive needs, so the failed path is not faked. */
const realDebitStack = () => [
  'alter table public.local_wallet_balances add column if not exists deficit_pence integer not null default 0;',
  createTable(RECOVERY, 'create table if not exists public.local_wallet_topup_recovery ('),
  slice(RECOVERY, 'create or replace function public.wallet_spend_block(p_user uuid)', '$$;'),
  slice(DEBIT, 'create function public.wallet_debit_with_ledger(', '$$;'),
].join('\n');
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
function schema(
  reverseSql: string,
  allowReversed: boolean,
  opts: { recon?: string; realDebit?: boolean } = {},
) {
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
    opts.recon ?? reconFn(),
    opts.realDebit ? realDebitStack() : '',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1200)}`);
}

/**
 * One spend per legal starting transfer_state, and a balance that matches the
 * ledger exactly. Seven spends at 300p against a 2400p top-up leaves 300p.
 */
const BASE = 300;
function fixtures() {
  const out = raw([
    `insert into public.local_wallet_balances (user_id, balance_pence) values ('${U}', ${BASE}), ('${V}', 5000);`,
    `insert into public.local_wallet_transactions
       (id, user_id, business_id, type, amount_pence, platform_fee_pence, description, idempotency_key, transfer_state, stripe_transfer_id)
     values
       ('${KEYED}',    '${U}', '${BIZ}', 'spend', -300, 15, 'Keyed spend',    'wallet-attempt:keyed', 'sent',       'tr_keyed'),
       ('${UNKEYED}',  '${U}', '${BIZ}', 'spend', -300, 15, 'Unkeyed spend',  null,                   'sent',       'tr_unkeyed'),
       ('${PENDING}',  '${U}', '${BIZ}', 'spend', -300, 15, 'Never sent',     'wallet-attempt:pend',  'pending',    null),
       ('${NONEROW}',  '${U}', null,     'spend', -300, 300, 'Platform only', 'wallet-attempt:none',  'none',       null),
       ('${NONEFREE}', '${U}', null,     'spend', -300, 300, 'Platform, no key', null,                'none',       null),
       ('${FAILROW}',  '${U}', '${BIZ}', 'spend', -300, 15, 'Refused',        'wallet-attempt:fail',  'failed',     null),
       ('${UNRES}',    '${U}', '${BIZ}', 'spend', -300, 15, 'Never answered', 'wallet-attempt:unres', 'unresolved', 'tr_unres'),
       ('${TOPUP}',    '${U}', null,     'topup',  2400, null, 'Top-up',      'topup:1',              'none',       null);`,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixtures failed:\n${out.slice(0, 900)}`);
}

/**
 * Everything the fixture deliberately leaves unsettled, settled — so a
 * reconciliation stage measures what the REVERSAL left behind and nothing else.
 */
const settleForRecon = () =>
  raw(`update public.local_wallet_transactions set transfer_state='sent'
        where id in ('${PENDING}', '${FAILROW}', '${UNRES}');`);

type Merchant = 'clawed_back' | 'never_paid' | 'no_transfer' | 'nonsense';
const reverse = (id: string, reason = 'Refund', merchant?: Merchant) =>
  raw(`select already_reversed from public.wallet_reverse_debit('${id}', '${reason}'`
      + (merchant ? `, '${merchant}'` : '') + `);`);
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
/* Each stage rebuilds the schema, so its state must be READ while it exists.
   Querying afterwards would ask the last stage's database about the first. */
const fixed = {
  firstAlready: '', refundRowsAfterFirst: 0, balanceAfterFirst: 0, ledgerAfterFirst: 0,
  originalAmount: 0, originalType: '', refundLinkedAmount: 0, refundType: '',
  secondAlready: '', refundRowsAfterSecond: 0, balanceAfterSecond: 0,
  unkeyedSecondAlready: '', unkeyedRefundRows: 0, unkeyedBalance: 0,
  topupError: '', otherWallet: 0, reconStatus: '',
  raceRefundRows: 0, raceBalance: 0,
};
/** What the reversal leaves on the original, per starting state. */
const marked = { sent: '', pending: '', none: '', failed: '', balanceAfterAll: 0 };
/** The gates: what is refused, and what an unasserted caller settles as. */
const gate = {
  pendingClawedBack: '', sentNeverPaid: '', noneClawedBack: '',
  unresolvedPlain: '', unresolvedClawedBack: '', badMerchant: '',
  sentUnasserted: '', pendingUnasserted: '', balance: 0, unresRefundRows: 0,
  reversedMarked: '', reversedMarkedRows: 0, overloads: 0,
};
const prod = { sentState: '', reconStatus: '' };
/** Section 3: the refused-transfer path, driven through the real primitives. */
const real = {
  stateAfterDebit: '', balanceAfterDebit: 0, stateAfterReversal: '',
  balanceAfterReversal: 0, ledgerAfterReversal: 0, rowCount: 0,
  reconOld: '', reconNew: '',
};
/** Reconciliation's verdict on a wallet holding one spend in each state. */
const reconBy: Record<string, { before: string; after: string }> = {};
const mutRecon = { failedStatus: '', installed: '' };
/* Read from the migration text, asserted by name below rather than in before():
   a mutation that moves one of these should fail ONE test, not the file. */
const anchors = { guard: false, verdict: false, lock: false, key: false, unresGate: false, blockerSet: false };
const mut = {
  m1RefundRows: 0, m1Balance: 0, m1Installed: '',
  m2State: '', m2Recon: '', m2Installed: '',
  m3RefundRows: 0, m3Balance: 0, m3Installed: '',
  m4RefundRows: 0, m4Balance: 0, m4Installed: '',
  m5State: '', m5Rows: 0, m5Installed: '',
  m6Sent: '', m6None: '', m6Installed: '',
};

const dropOld = () => slice(FIX, 'drop function if exists public.wallet_reverse_debit(uuid, text);', ';');

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // ── 1. The hardened reversal, end to end ─────────────────────────────────
  schema(fixedReverse(), true);
  fixtures();

  fixed.firstAlready = value(reverse(KEYED, 'Refund of keyed spend', 'clawed_back'));
  fixed.refundRowsAfterFirst = refundRows(KEYED);
  fixed.balanceAfterFirst = balance(U);
  fixed.ledgerAfterFirst = ledgerSum(U);
  fixed.originalAmount = num(`select amount_pence::text from public.local_wallet_transactions where id='${KEYED}';`);
  fixed.originalType = scalar(`select type from public.local_wallet_transactions where id='${KEYED}';`);
  fixed.refundLinkedAmount = num(
    `select amount_pence::text from public.local_wallet_transactions where reverses_transaction_id='${KEYED}';`);
  fixed.refundType = scalar(
    `select type from public.local_wallet_transactions where reverses_transaction_id='${KEYED}';`);
  fixed.otherWallet = balance(V);

  // A second reversal of the same keyed spend.
  fixed.secondAlready = value(reverse(KEYED, 'Refund again', 'clawed_back'));
  fixed.refundRowsAfterSecond = refundRows(KEYED);
  fixed.balanceAfterSecond = balance(U);

  // The unkeyed spend: only the row guard protects it.
  reverse(UNKEYED, 'Refund unkeyed', 'clawed_back');
  fixed.unkeyedSecondAlready = value(reverse(UNKEYED, 'Refund unkeyed again', 'clawed_back'));
  fixed.unkeyedRefundRows = refundRows(UNKEYED);
  fixed.unkeyedBalance = balance(U);

  // ── 1a. What each starting state is marked, when the caller does say ─────
  marked.sent = stateOf(KEYED);
  reverse(PENDING, 'Stripe refused it', 'never_paid');
  marked.pending = stateOf(PENDING);
  reverse(NONEROW, 'Platform purchase undone', 'no_transfer');
  marked.none = stateOf(NONEROW);
  reverse(FAILROW, 'Already refused', 'no_transfer');
  marked.failed = stateOf(FAILROW);
  marked.balanceAfterAll = balance(U);

  // A credit is not a spend.
  fixed.topupError = raw(`select * from public.wallet_reverse_debit('${TOPUP}', 'nope');`);

  // ── 1b. Reconciliation must not see a settled reversal as in flight ──────
  //
  // Its own stage, because the fixture deliberately holds spends in 'pending',
  // 'failed' and 'unresolved' — which reconciliation blocks on for reasons
  // that have nothing to do with reversal. Settling them isolates the one
  // thing under test.
  schema(fixedReverse(), true);
  fixtures();
  settleForRecon();
  reverse(KEYED, 'Refund of keyed spend', 'clawed_back');
  fixed.reconStatus = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // ── 1c. The same contention, against the real function ───────────────────
  schema(fixedReverse(), true);
  fixtures();
  await raceReverse(UNKEYED);
  fixed.raceRefundRows = refundRows(UNKEYED);
  fixed.raceBalance = balance(U);

  // ── 1d. The gates ────────────────────────────────────────────────────────
  //
  // Refusals first: they change nothing, so they can share one database with
  // the two settling cases that follow.
  schema(fixedReverse(), true);
  fixtures();
  gate.pendingClawedBack = reverse(PENDING, 'x', 'clawed_back');
  gate.sentNeverPaid = reverse(KEYED, 'x', 'never_paid');
  gate.noneClawedBack = reverse(NONEROW, 'x', 'clawed_back');
  gate.unresolvedPlain = reverse(UNRES, 'x');
  gate.unresolvedClawedBack = reverse(UNRES, 'x', 'clawed_back');
  gate.badMerchant = reverse(KEYED, 'x', 'nonsense');
  gate.unresRefundRows = refundRows(UNRES);
  // Now the two that do settle, unasserted: neither may claim a reversal.
  reverse(UNKEYED, 'caller said nothing');
  gate.sentUnasserted = stateOf(UNKEYED);
  reverse(PENDING, 'caller said nothing');
  gate.pendingUnasserted = stateOf(PENDING);
  gate.balance = balance(U);

  // A row already marked reversed, with no reversal recorded, is inconsistent.
  gate.reversedMarked = raw(
    `insert into public.local_wallet_transactions
       (id, user_id, business_id, type, amount_pence, description, transfer_state)
     values ('${REVMARK}', '${U}', '${BIZ}', 'spend', -300, 'Marked reversed', 'reversed');
     select * from public.wallet_reverse_debit('${REVMARK}', 'x', 'clawed_back');`);
  gate.reversedMarkedRows = refundRows(REVMARK);

  // ── 1e. The old two-argument form must be GONE, not shadowed ─────────────
  schema(prodReverse(), true);
  raw(dropOld() + '\n' + fixedReverse());
  gate.overloads = num(
    `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);

  // ── 1f. The refused-transfer path, through the REAL primitives ──────────
  //
  // Not a fixture row set to 'failed' by hand: the debit primitive writes
  // 'pending', the reversal is the thing that writes 'failed', and this walks
  // that path so the state under test is one the system actually produces.
  schema(fixedReverse(), true, { realDebit: true });
  raw(`insert into public.local_wallet_balances (user_id, balance_pence) values ('${U}', 1000);
       insert into public.local_wallet_transactions
         (user_id, type, amount_pence, description, idempotency_key, transfer_state)
       values ('${U}', 'topup', 1000, 'Top-up', 'topup:real', 'none');`);
  const realTxn = value(raw(
    `select transaction_id from public.wallet_debit_with_ledger(
       '${U}', 300, 0, 'spend', '${BIZ}', 'Real spend', 'wallet-attempt:real', 15, true);`));
  real.stateAfterDebit = stateOf(realTxn);
  real.balanceAfterDebit = balance(U);
  // Stripe refused it. Only the caller knows that, so only the caller says it.
  reverse(realTxn, 'Transfer rejected: no such destination', 'never_paid');
  real.stateAfterReversal = stateOf(realTxn);
  real.balanceAfterReversal = balance(U);
  real.ledgerAfterReversal = ledgerSum(U);
  real.rowCount = num(
    `select count(*)::text from public.local_wallet_transactions where user_id = '${U}';`);
  real.reconOld = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);
  // Same database, same rows, only the function swapped.
  raw(reconFixed());
  real.reconNew = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof2');`);

  // ── 1g. Reconciliation's verdict on every state, before and after ────────
  const STATES = ['none', 'sent', 'reversed', 'failed', 'pending', 'unresolved'];
  const userFor = (i: number) => `d000000${i}-0000-4000-8000-000000000001`;
  const seedStates = () => raw(STATES.map((st, i) => `
    insert into public.local_wallet_balances (user_id, balance_pence) values ('${userFor(i)}', 700);
    insert into public.local_wallet_transactions
      (user_id, business_id, type, amount_pence, description, idempotency_key, transfer_state)
    values ('${userFor(i)}', null, 'topup', 1000, 'Top-up', 'topup:${st}', 'none'),
           ('${userFor(i)}', '${BIZ}', 'spend', -300, 'Spend', 'spend:${st}', '${st}');`).join('\n'));

  schema(fixedReverse(), true);            // reconciliation as applied today
  seedStates();
  const before = STATES.map((_, i) =>
    scalar(`select status from public.wallet_launch_reconciliation('${userFor(i)}', 'proof');`));
  schema(fixedReverse(), true, { recon: reconFixed() });
  seedStates();
  const after = STATES.map((_, i) =>
    scalar(`select status from public.wallet_launch_reconciliation('${userFor(i)}', 'proof');`));
  STATES.forEach((st, i) => { reconBy[st] = { before: before[i], after: after[i] }; });

  // ── 1h. Mutation: 'failed' put back into the blocker set ────────────────
  const blockers = `        and t.transfer_state not in ('none','sent','reversed','failed'))`;
  anchors.blockerSet = reconFixed().includes(blockers);
  schema(fixedReverse(), true, {
    recon: reconFixed().replace(blockers, `        and t.transfer_state not in ('none','sent','reversed'))`),
  });
  seedStates();
  mutRecon.installed = scalar(
    `select case when position('''reversed'',''failed''' in pg_get_functiondef(p.oid)) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_launch_reconciliation';`);
  mutRecon.failedStatus = scalar(
    `select status from public.wallet_launch_reconciliation('${userFor(3)}', 'proof');`);

  // ── 2. The same fixtures against production as applied today ─────────────
  schema(prodReverse(), false);
  fixtures();
  settleForRecon();
  reverse(KEYED, 'Refund of keyed spend');
  prod.sentState = stateOf(KEYED);
  prod.reconStatus = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // ── 3. Mutations ─────────────────────────────────────────────────────────
  const guard = `  select id into v_existing from public.local_wallet_transactions
   where reverses_transaction_id = p_transaction_id
   limit 1;
  if v_existing is not null then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = v_orig.user_id), 0),
      v_existing, true;
    return;
  end if;`;
  const verdict = `  v_state := case
               when v_orig.transfer_state = 'sent'
                 then case when p_merchant = 'clawed_back' then 'reversed' else 'unresolved' end
               when v_orig.transfer_state = 'pending'
                 then case when p_merchant = 'never_paid' then 'failed' else 'unresolved' end
               else v_orig.transfer_state
             end;`;
  const lock = `   where id = p_transaction_id
     for update;`;
  const key = `    case when v_orig.idempotency_key is null then null else v_orig.idempotency_key || ':reversal' end,`;
  const unresGate = `  if v_orig.transfer_state = 'unresolved' then
    raise exception 'wallet_reverse_debit: the merchant transfer is unresolved — settle it at Stripe before refunding'
      using errcode = '22023';
  end if;`;
  anchors.guard = fixedReverse().includes(guard);
  anchors.verdict = fixedReverse().includes(verdict);
  anchors.lock = fixedReverse().includes(lock);
  anchors.key = fixedReverse().includes(key);
  anchors.unresGate = fixedReverse().includes(unresGate);

  const installed = (needle: string) => scalar(
    `select case when position(${needle} in pg_get_functiondef(p.oid)) > 0 then 'yes' else 'no' end
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='wallet_reverse_debit';`);

  // M1 — the row guard removed. Proved on the UNKEYED 'none' spend, whose
  // reversal leaves a state no gate refuses, so the guard is the only thing
  // between a retry and a second credit.
  schema(fixedReverse().replace(guard, '  v_existing := null;'), true);
  fixtures();

  mut.m1Installed = installed("'v_existing := null'");
  reverse(NONEFREE, 'first', 'no_transfer');
  reverse(NONEFREE, 'second', 'no_transfer');
  mut.m1RefundRows = refundRows(NONEFREE);
  mut.m1Balance = balance(U);

  // M2 — the first draft's guess, read on a platform-funded spend. It invents
  // a failed transfer where none was ever attempted, and that invented failure
  // is enough to refuse the whole wallet at reconciliation.
  schema(fixedReverse().replace(verdict,
    `  v_state := case when v_orig.transfer_state = 'sent' then 'reversed' else 'failed' end;`), true);
  fixtures();
  settleForRecon();
  mut.m2Installed = installed("'then ''reversed'' else ''failed'''");
  reverse(NONEROW, 'platform purchase undone', 'no_transfer');
  mut.m2State = stateOf(NONEROW);
  mut.m2Recon = scalar(`select status from public.wallet_launch_reconciliation('${U}', 'proof');`);

  // M3 — the row lock removed.
  schema(fixedReverse().replace(lock, `   where id = p_transaction_id;`), true);
  fixtures();
  mut.m3Installed = installed("'for update'");
  await raceReverse(UNKEYED);
  mut.m3RefundRows = refundRows(UNKEYED);
  mut.m3Balance = balance(U);

  // M4 — guard AND derived key removed, on a KEYED 'none' spend: with the
  // guard gone the unique index is all that is left, and this says whether it
  // is really holding anything.
  schema(fixedReverse().replace(guard, '  v_existing := null;').replace(key, '    null,'), true);
  fixtures();
  mut.m4Installed = installed("''':reversal'''");
  reverse(NONEROW, 'first', 'no_transfer');
  reverse(NONEROW, 'second', 'no_transfer');
  mut.m4RefundRows = refundRows(NONEROW);
  mut.m4Balance = balance(U);

  // M5 — the unresolved gate removed: an uncertain transfer becomes a
  // completed refund, which is the double-payment this whole gate exists for.
  schema(fixedReverse().replace(unresGate, ''), true);
  fixtures();
  mut.m5Installed = installed("'settle it at Stripe'");
  reverse(UNRES, 'refund anyway');
  mut.m5Rows = refundRows(UNRES);
  mut.m5State = stateOf(UNRES);

  // M6 — the same first-draft guess, read on the two states it misreports.
  schema(fixedReverse().replace(verdict,
    `  v_state := case when v_orig.transfer_state = 'sent' then 'reversed' else 'failed' end;`), true);
  fixtures();
  mut.m6Installed = installed("'then ''reversed'' else ''failed'''");
  reverse(UNKEYED, 'caller said nothing');
  mut.m6Sent = stateOf(UNKEYED);
  reverse(NONEROW, 'platform only', 'no_transfer');
  mut.m6None = stateOf(NONEROW);

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
    assert.equal(fixed.balanceAfterFirst, BASE + 300);
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

describe('what the original is marked, per starting state', () => {
  test('sent + clawed back becomes reversed', () => {
    assert.equal(marked.sent, 'reversed');
  });

  test('pending + never paid becomes failed', () => {
    assert.equal(marked.pending, 'failed');
  });

  test('none stays none — no transfer is invented to fail', () => {
    assert.equal(marked.none, 'none');
  });

  test('failed stays failed', () => {
    assert.equal(marked.failed, 'failed');
  });

  test('all four credited the wallet exactly once each', () => {
    assert.equal(marked.balanceAfterAll, BASE + 300 * 5);
  });

  test('production as applied today marks a sent transfer failed', () => {
    assert.equal(prod.sentState, 'failed');
  });
});

describe('the gates — nothing is settled on an assumption', () => {
  test('an unresolved transfer is refused outright', () => {
    assert.match(gate.unresolvedPlain, /unresolved — settle it at Stripe/i);
    assert.match(gate.unresolvedClawedBack, /unresolved — settle it at Stripe/i);
  });

  test('and credits nothing while refusing', () => {
    assert.equal(gate.unresRefundRows, 0);
  });

  test('a sent transfer cannot be reported unpaid', () => {
    assert.match(gate.sentNeverPaid, /cannot be reported unpaid/i);
  });

  test('nothing unsent can have been clawed back', () => {
    assert.match(gate.pendingClawedBack, /nothing can have been clawed back/i);
    assert.match(gate.noneClawedBack, /nothing can have been clawed back/i);
  });

  test('an unknown merchant outcome is refused', () => {
    assert.match(gate.badMerchant, /unknown merchant outcome/i);
  });

  test('a sent transfer nobody vouched for settles as unresolved, not reversed', () => {
    assert.equal(gate.sentUnasserted, 'unresolved');
  });

  test('a pending transfer nobody vouched for settles as unresolved, not failed', () => {
    assert.equal(gate.pendingUnasserted, 'unresolved');
  });

  test('the refusals credited nothing; only the two settling calls did', () => {
    assert.equal(gate.balance, BASE + 300 * 2);
  });

  test('a row marked reversed with no reversal recorded is refused', () => {
    assert.match(gate.reversedMarked, /marked reversed with no reversal recorded/i);
    assert.equal(gate.reversedMarkedRows, 0);
  });

  test('the two-argument form is dropped, not left beside the new one', () => {
    assert.equal(gate.overloads, 1);
  });
});

describe('the refused-transfer path, through the real primitives', () => {
  test('the debit primitive writes pending, not failed', () => {
    assert.equal(real.stateAfterDebit, 'pending');
    assert.equal(real.balanceAfterDebit, 700);
  });

  test('the reversal marks it failed and puts the money back', () => {
    assert.equal(real.stateAfterReversal, 'failed');
    assert.equal(real.balanceAfterReversal, 1000);
  });

  test('the ledger agrees, and the debit is still there beside its refund', () => {
    assert.equal(real.ledgerAfterReversal, 1000);
    assert.equal(real.rowCount, 3);   // top-up, spend, refund
  });

  test('reconciliation as applied today refuses that wallet', () => {
    assert.equal(real.reconOld, 'refused_unresolved_movement');
  });

  test('and the same rows reconcile once failed stops being a blocker', () => {
    assert.equal(real.reconNew, 'reconciled');
  });
});

describe('reconciliation, state by state', () => {
  test('states with nothing outstanding are allowed', () => {
    for (const st of ['none', 'sent', 'reversed']) {
      assert.equal(reconBy[st].after, 'reconciled', `${st} should reconcile`);
      assert.equal(reconBy[st].before, 'reconciled', `${st} reconciled before the change too`);
    }
  });

  test('a refused transfer is allowed, where it used to be refused', () => {
    assert.equal(reconBy.failed.before, 'refused_unresolved_movement');
    assert.equal(reconBy.failed.after, 'reconciled');
  });

  test('pending still blocks — the money may yet move', () => {
    assert.equal(reconBy.pending.before, 'refused_unresolved_movement');
    assert.equal(reconBy.pending.after, 'refused_unresolved_movement');
  });

  test('unresolved still blocks — nobody knows whether it moved', () => {
    assert.equal(reconBy.unresolved.before, 'refused_unresolved_movement');
    assert.equal(reconBy.unresolved.after, 'refused_unresolved_movement');
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
    assert.equal(fixed.balanceAfterSecond, BASE + 300);
    assert.equal(fixed.unkeyedBalance, BASE + 600);
  });
});

describe('two reversals at once', () => {
  test('leave exactly one refund row', () => {
    assert.equal(fixed.raceRefundRows, 1);
  });

  test('credit the wallet exactly once', () => {
    assert.equal(fixed.raceBalance, BASE + 300);
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
  test('the state verdict is where the mutations expect it', () => {
    assert.ok(anchors.verdict);
  });
  test('the SELECT ... FOR UPDATE is where the mutations expect it', () => {
    assert.ok(anchors.lock);
  });
  test('the derived :reversal key is where the mutations expect it', () => {
    assert.ok(anchors.key);
  });
  test('the unresolved gate is where the mutations expect it', () => {
    assert.ok(anchors.unresGate);
  });
  test('the reconciliation blocker set is where the mutation expects it', () => {
    assert.ok(anchors.blockerSet);
  });
});

describe('mutations — each protection is load-bearing', () => {
  test('M1 removing the reversal guard double-credits an unkeyed spend', () => {
    assert.equal(mut.m1Installed, 'yes', 'the mutated function was not installed');
    assert.equal(mut.m1RefundRows, 2);
    assert.equal(mut.m1Balance, BASE + 600);
  });

  test('M2 guessing the verdict invents a failure and jams reconciliation', () => {
    assert.equal(mut.m2Installed, 'yes', 'the mutated function was not installed');
    assert.equal(mut.m2State, 'failed');
    assert.equal(mut.m2Recon, 'refused_unresolved_movement');
  });

  test('M3 removing FOR UPDATE lets two concurrent reversals both credit', () => {
    assert.equal(mut.m3Installed, 'no', 'the lock was not actually removed');
    assert.equal(mut.m3RefundRows, 2);
    assert.equal(mut.m3Balance, BASE + 600);
  });

  test('M4 removing the derived reversal key allows a second credit', () => {
    assert.equal(mut.m4Installed, 'no', 'the derived key was not actually removed');
    assert.equal(mut.m4RefundRows, 2);
    assert.equal(mut.m4Balance, BASE + 600);
  });

  test('M5 removing the unresolved gate completes a refund that may pay twice', () => {
    assert.equal(mut.m5Installed, 'no', 'the gate was not actually removed');
    assert.equal(mut.m5Rows, 1);
    assert.equal(mut.m5State, 'unresolved');
  });

  test('M7 putting failed back into the blocker set refuses a settled wallet', () => {
    assert.equal(mutRecon.installed, 'no', 'the blocker set was not actually changed');
    assert.equal(mutRecon.failedStatus, 'refused_unresolved_movement');
  });

  test('M6 guessing the verdict misreports sent-unvouched and none', () => {
    assert.equal(mut.m6Installed, 'yes', 'the mutated function was not installed');
    assert.equal(mut.m6Sent, 'reversed', 'an unvouched transfer was claimed as reversed');
    assert.equal(mut.m6None, 'failed', 'a transfer that never existed was claimed to have failed');
  });
});

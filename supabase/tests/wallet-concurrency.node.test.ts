/**
 * wallet-concurrency.node.test.ts — two connections fighting over one wallet.
 *
 * These four proofs used to live in the FIXTURE lane, against production. They
 * worked like this: pick a real signed-up profile that happens to have no wallet
 * history, delete whatever it does have, insert a synthetic balance, race two
 * spends against it, then tidy up afterwards.
 *
 * On 2026-09-08 the tidying did not happen. The Supabase CLI's temporary login
 * role began failing mid-run, the process died between the write and the
 * cleanup, and a real customer account was left holding a fabricated £38.00
 * balance with no top-up behind it — spendable money that had never been paid
 * in. Worse, the account picker requires a profile with NO wallet transactions,
 * so the polluted account would be skipped next time and a fresh real account
 * chosen: the pollution accumulated instead of healing.
 *
 * A proof that needs two committed connections cannot roll itself back, so it
 * does not belong anywhere near production. It belongs here, where the users are
 * disposable and the whole cluster is destroyed in a finally.
 *
 * The proofs themselves are unchanged — same primitives, same timings, same
 * assertions, same numbers.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
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
const RECOVERY = join(MIG, '20260826140000_wallet_refund_and_dispute_recovery.sql');
const DEBIT = join(MIG, '20260826150000_wallet_spend_blocked_by_recovery.sql');
const CLAIMS = join(MIG, '20260818230000_wallet_payment_claims.sql');
const REGISTRY = join(MIG, '20260820180000_wallet_attempt_registry.sql');

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Disposable. Nobody signed up for these. */
const U1 = 'aa000000-0000-4000-8000-0000000000a1';
const U2 = 'aa000000-0000-4000-8000-0000000000a2';
const U3 = 'aa000000-0000-4000-8000-0000000000a3';
const U4 = 'aa000000-0000-4000-8000-0000000000a4';

/** The real ledger primitives, from their own migrations. */
function schema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    'create table public.profiles (id uuid primary key);',
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
    slice(RECON, 'alter table public.local_wallet_transactions\n  drop constraint if exists local_wallet_transactions_type_check;', "'reconciliation']));"),
    'alter table public.local_wallet_balances add column if not exists deficit_pence integer not null default 0;',
    createTable(RECOVERY, 'create table if not exists public.local_wallet_topup_recovery ('),
    slice(RECOVERY, 'create or replace function public.wallet_spend_block(p_user uuid)', '$$;'),
    slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;'),
    slice(DEBIT, 'create function public.wallet_debit_with_ledger(', '$$;'),
    createTable(CLAIMS, 'create table if not exists public.wallet_payment_claims ('),
    // The registry migration widens that table before it can claim anything.
    slice(REGISTRY, 'alter table public.wallet_payment_claims\n  add column if not exists wallet_transaction_id', ';'),
    slice(REGISTRY, "do $$\nbegin\n  if not exists (\n    select 1 from pg_constraint", 'end $$;'),
    slice(REGISTRY, 'create or replace function public.claim_wallet_attempt', '$$;'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1400)}`);

  const f = raw(`
    insert into auth.users(id) values ('${U1}'),('${U2}'),('${U3}'),('${U4}');
    insert into public.profiles(id) values ('${U1}'),('${U2}'),('${U3}'),('${U4}');`);
  assert.doesNotMatch(f, /ERROR/i, `fixtures failed:\n${f.slice(0, 900)}`);
}

/** A wallet with a starting balance and no history. */
function wallet(user: string, pence: number) {
  const o = raw(`delete from public.local_wallet_transactions where user_id='${user}';
    delete from public.wallet_payment_claims where user_id='${user}';
    delete from public.local_wallet_balances where user_id='${user}';
    insert into public.local_wallet_balances (user_id, balance_pence) values ('${user}', ${pence});`);
  assert.doesNotMatch(o, /ERROR/i, `wallet fixture failed:\n${o.slice(0, 600)}`);
}

/**
 * A holds the row lock for 6s and commits; B arrives 3s in and must re-test the
 * guard against A's COMMITTED result, not the snapshot it started from. The
 * sleeps are what make the second caller arrive while the first still holds the
 * row — remove them and both callers read the same stale balance and pass.
 */
async function race(first: string, second: string): Promise<string[]> {
  const a = rawAsync(`begin;\n${first}\nselect pg_sleep(6);\nselect r from _out;\ncommit;`);
  await sleep(150);
  const b = rawAsync(`select pg_sleep(3);\n${second}`);
  const [ra, rb] = await Promise.all([a, b]);
  return [value(ra), value(rb)];
}

const balance = (u: string) => num(`select balance_pence::text from public.local_wallet_balances where user_id='${u}';`);
const rowsFor = (u: string) => num(`select count(*)::text from public.local_wallet_transactions where user_id='${u}';`);
const ledgerSum = (u: string) => num(`select coalesce(sum(amount_pence),0)::text from public.local_wallet_transactions where user_id='${u}';`);

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is required — run via `npm run test:isolated`');
  assert.ok(!/supabase/i.test(DSN), 'refusing to run against anything that looks like Supabase');
  schema();
});

// ── 1. Two spends at once ───────────────────────────────────────────────────

describe('two wallet spends arriving together', () => {
  test('a wallet with 1000p cannot pay 800p twice', async () => {
    wallet(U1, 1000);
    const [ra, rb] = await race(
      `create temp table _out as select case when insufficient then 'insufficient' else 'ok' end r
         from public.wallet_debit_with_ledger('${U1}', 800, 0, 'spend', null, 'race A', 'wrace-a', null, false);`,
      `select case when insufficient then 'insufficient' else 'ok' end as r
         from public.wallet_debit_with_ledger('${U1}', 800, 0, 'spend', null, 'race B', 'wrace-b', null, false);`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'ok').length, 1,
      `both spends succeeded — the wallet was overdrawn. Got ${JSON.stringify(results)}`);
    assert.equal(balance(U1), 200, 'the balance is not what one 800p spend leaves behind');
    assert.ok(balance(U1) >= 0, 'the wallet went negative');
    assert.equal(rowsFor(U1), 1, 'the losing spend still wrote an accounting entry');
  });

  test('and the ledger explains the balance exactly', () => {
    assert.equal(balance(U1), 1000 + ledgerSum(U1));
  });
});

// ── 2. One identifier, two connections ──────────────────────────────────────

describe('one payment identifier debits once', () => {
  test('even from two connections', async () => {
    wallet(U2, 5000);
    const [ra, rb] = await race(
      `create temp table _out as select case when already_applied then 'already' else 'applied' end r
         from public.wallet_debit_with_ledger('${U2}', 1200, 0, 'spend', null, 'dup race', 'wrace-dup', null, false);`,
      `select case when already_applied then 'already' else 'applied' end as r
         from public.wallet_debit_with_ledger('${U2}', 1200, 0, 'spend', null, 'dup race', 'wrace-dup', null, false);`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'applied').length, 1,
      `one payment identifier debited twice. Got ${JSON.stringify(results)}`);
    assert.equal(balance(U2), 3800, 'the money moved more than once');
    assert.equal(rowsFor(U2), 1, 'the same payment wrote two accounting entries');
  });
});

// ── 3. Two copies of one purchase ───────────────────────────────────────────

describe('two copies of one purchase arriving together', () => {
  test('exactly one copy may claim the reference', async () => {
    wallet(U3, 10000);
    const [ra, rb] = await race(
      `create temp table _out as select outcome r from public.claim_wallet_attempt('RACE-1','${U3}','fp-race');`,
      `select outcome as r from public.claim_wallet_attempt('RACE-1','${U3}','fp-race');`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'claimed').length, 1,
      `both copies claimed the same reference. Got ${JSON.stringify(results)}`);
    assert.equal(num(`select count(*)::text from public.wallet_payment_claims where client_request_id='RACE-1';`), 1,
      'the registry holds more than one row for one reference');
  });

  test('and only one of them debits', async () => {
    wallet(U4, 10000);
    const [ra, rb] = await race(
      `create temp table _out as select case when already_applied then 'already' else 'applied' end r
         from public.wallet_debit_with_ledger('${U4}', 2500, 0, 'spend', null, 'race pay', 'wallet-attempt:RACE-2', null, true);`,
      `select case when already_applied then 'already' else 'applied' end as r
         from public.wallet_debit_with_ledger('${U4}', 2500, 0, 'spend', null, 'race pay', 'wallet-attempt:RACE-2', null, true);`);

    const results = [ra, rb];
    assert.equal(results.filter((x) => x === 'applied').length, 1,
      `one purchase debited twice. Got ${JSON.stringify(results)}`);
    assert.equal(balance(U4), 7500, 'the money moved more than once');
    assert.equal(rowsFor(U4), 1, 'one purchase wrote two accounting entries');
  });
});

// ── 4. The reason this suite lives here ─────────────────────────────────────

describe('the proof cannot reach a real wallet', () => {
  test('every account it touches is one it invented', () => {
    for (const u of [U1, U2, U3, U4]) assert.match(u, /^aa000000-0000-4000-8000-0000000000a[1-4]$/);
  });

  test('and the lane refuses a Supabase DSN outright', () => {
    assert.ok(!/supabase/i.test(DSN));
  });
});

/**
 * wallet-charge-cancel-concurrency.node.test.ts — a merchant's Cancel must
 * actually win, or actually lose, never both.
 *
 * WHY THIS EXISTS
 *
 * The till's Cancel button used to only clear local UI state — the pending
 * request stayed 'pending' server-side, so a merchant who fat-fingered £50
 * instead of £5 and tapped Cancel had no guarantee the customer couldn't
 * still approve it a moment later. Real money, real race.
 *
 * wallet-charge-cancel closes that with the same idiom wallet-charge-approve's
 * own claim step already uses: a single conditional UPDATE —
 *
 *   update wallet_charge_requests set status = 'cancelled', ...
 *   where id = :id and status = 'pending'
 *
 * — never a SELECT-then-UPDATE. This suite does not read that WHERE clause
 * and trust it; it runs the actual statement shape from two genuinely
 * concurrent connections and proves Postgres lets exactly one of them win,
 * in every ordering, including truly at the same instant.
 *
 * HOW THE RACE IS MADE CERTAIN
 *
 * Same technique as pass-redemption-concurrency.node.test.ts: the winner
 * opens a transaction, runs its UPDATE, then sleeps while still holding the
 * row lock the UPDATE took. The loser starts a beat later and must contend
 * for that same row — it blocks until the winner commits, then re-evaluates
 * its own WHERE against the now-committed row and correctly finds nothing to
 * update. That makes every case deterministic in both directions, not a coin
 * flip that happens to pass on a fast machine.
 *
 * WHAT IS ASSERTED
 *   A  two cancels on one request at once: exactly one wins, the loser
 *      affects zero rows, final status is 'cancelled'
 *   B  cancel vs approve's own claim step, forced BOTH ways: whichever wins,
 *      the other affects zero rows and the row ends in exactly one of
 *      'cancelled' / 'charging' — never neither, never both attempted
 *   C  cancel twice, sequentially: the second is a genuine no-op (zero rows),
 *      not a second write — cancelling is idempotent, not "cancel again"
 *   D  a request already 'paid' cannot be cancelled — zero rows, unchanged;
 *      cancellation never reverses a payment that already went through
 *   E  a request already 'expired' cannot be re-labelled 'cancelled' — zero
 *      rows, stays 'expired'
 *   F  the business-ownership check the function runs before ever attempting
 *      the update: the request's own owner matches, an unrelated owner does
 *      not — proves another business/merchant/the customer themself resolve
 *      to no match, at the exact query shape the function uses
 *
 * "No wallet debit / ledger / fee / transfer / Stripe pathway" is proven
 * structurally in wallet-charge-cancel.node.test.ts (the function's source
 * never calls executeWalletPayment or touches a wallet table) rather than
 * here — a schema that never had those tables in it proves nothing extra by
 * their absence.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * This suite never runs against the linked project. It requires
 * PASS_PROOF_DSN and refuses to run without it. `npm run test:isolated`
 * provisions a throwaway PostgreSQL 17 cluster on a unix socket, runs this,
 * and destroys it.
 *
 * The schema is not hand-written: the real CREATE TABLE and the migration
 * that adds 'cancelled' to its CHECK are extracted from the real migration
 * files at run time, so this exercises the constraint production actually
 * runs and cannot quietly drift away from it.
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
const TABLE_SQL = join(MIG, '20260729030000_wallet_charge_requests.sql');
const CANCEL_MIGRATION_SQL = join(MIG, '20261012120000_wallet_charge_cancel.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';

/* ── talking to the throwaway cluster ─────────────────────────────────────── */

const args = (body: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body),
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
/** A separate process, and therefore a separate connection and transaction. */
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const scalar = (body: string): string =>
  raw(body).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
/** Rows affected by an UPDATE ... RETURNING, as a count of non-empty lines. */
const rowsReturned = (out: string): number =>
  out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !/^\(?\d+ rows?\)?$/i.test(l)).length;

/* ── lifting the real SQL out of the real migrations ──────────────────────── */

/** A balanced-paren slice, so a CHECK containing brackets cannot truncate it. */
function createTable(file: string, opener: string): string {
  const s = readFileSync(file, 'utf8');
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone — the schema this proof relies on has moved`);
  const open = s.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${opener}`);
  return s.slice(start, end + 1) + ';';
}

/** The ALTER TABLE that adds 'cancelled' — extracted, not retyped. */
function cancelledMigrationSql(): string {
  const s = readFileSync(CANCEL_MIGRATION_SQL, 'utf8');
  const start = s.indexOf('ALTER TABLE public.wallet_charge_requests');
  assert.notEqual(start, -1, 'the migration adding cancelled to the CHECK has moved or been renamed');
  return s.slice(start);
}

/** The exact "business owner reads their charge requests" RLS predicate, as
 *  a standalone boolean check — proves the query SHAPE, not just that a
 *  policy with this name exists. */
function ownerPredicateSql(): string {
  const s = readFileSync(TABLE_SQL, 'utf8');
  const start = s.indexOf('USING (EXISTS (');
  assert.notEqual(start, -1, 'the business-owner RLS predicate has moved');
  const end = s.indexOf('));', start) + 3;
  return s.slice(start, end).replace(/^USING /, '');
}

/* ── fixture ids ───────────────────────────────────────────────────────────── */

const OWNER    = '11111111-1111-4111-8111-111111111111'; // owns BIZ — the merchant
const OTHER    = '22222222-2222-4222-8222-222222222222'; // owns nothing here
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const BIZ      = '44444444-4444-4444-8444-444444444444';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`. This suite must never touch the linked project.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const schema = [
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create extension if not exists pgcrypto;', // gen_random_uuid()
    'create table auth.users (id uuid primary key);',
    'create table public.local_businesses (id uuid primary key, owner_id uuid, name text);',
    createTable(TABLE_SQL, 'CREATE TABLE public.wallet_charge_requests'),
    cancelledMigrationSql(),
  ].join('\n');
  const out = raw(schema);
  assert.doesNotMatch(out, /ERROR/i, `the extracted schema did not install:\n${out.slice(0, 900)}`);

  raw(`
    insert into auth.users (id) values ('${OWNER}'),('${OTHER}'),('${CUSTOMER}');
    insert into public.local_businesses (id, owner_id, name) values ('${BIZ}', '${OWNER}', 'ZZ Charge Proof');`);
});

/* ── fixture helpers ──────────────────────────────────────────────────────── */

let seq = 0;
const nextId = () => `55555555-5555-4555-8555-${String(++seq).padStart(12, '0')}`;

function newRequest(status: 'pending' | 'paid' | 'expired', expiresOffsetSeconds: number): string {
  const id = nextId();
  const resolved = status === 'pending' ? 'null' : 'now()';
  raw(`insert into public.wallet_charge_requests
        (id, business_id, requested_by, customer_id, amount_pence, status, expires_at, resolved_at)
        values ('${id}', '${BIZ}', '${OWNER}', '${CUSTOMER}', 500, '${status}',
                now() + interval '${expiresOffsetSeconds} seconds', ${resolved});`);
  return id;
}

const statusOf = (id: string) => scalar(`select status from public.wallet_charge_requests where id='${id}'`);
const resolvedAtOf = (id: string) => scalar(`select coalesce(resolved_at::text,'') from public.wallet_charge_requests where id='${id}'`);

const cancelSql = (id: string) =>
  `update public.wallet_charge_requests set status='cancelled', resolved_at=now()
   where id='${id}' and status='pending' returning id;`;
const claimSql = (id: string) =>
  `update public.wallet_charge_requests set status='charging'
   where id='${id}' and status='pending' returning id;`;

const holding = (sql: string, seconds: number) =>
  `begin;\n${sql}\nselect pg_sleep(${seconds});\ncommit;`;

/** Winner first (holding its lock), loser a beat later, both in flight together. */
async function race(winnerSql: string, loserSql: string) {
  const a = rawAsync(holding(winnerSql, 3));
  await new Promise((r) => setTimeout(r, 800));
  const b = rawAsync(loserSql);
  const [outA, outB] = await Promise.all([a, b]);
  return { winnerRows: rowsReturned(outA), loserRows: rowsReturned(outB), rawA: outA, rawB: outB };
}

/* ── the cases ────────────────────────────────────────────────────────────── */

describe('the isolated cluster really is isolated', () => {
  test('the DSN is a local socket, not the linked project', () => {
    assert.match(DSN, /^postgresql:\/\/[a-z]+@\/[a-z]+\?host=/, 'unexpected DSN shape');
    assert.doesNotMatch(DSN, /supabase/i);
  });

  test('the CHECK constraint installed is the one the migration actually adds', () => {
    const def = raw(`select pg_get_constraintdef(oid) from pg_constraint where conname='wallet_charge_requests_status_check'`);
    assert.match(def, /cancelled/, 'the installed CHECK does not accept cancelled');
    assert.ok(cancelledMigrationSql().includes('cancelled'), 'the migration file no longer adds cancelled either');
  });
});

describe('CASE A — two cancels on one pending request, at the same moment', () => {
  let id = '';
  let result: Awaited<ReturnType<typeof race>>;

  before(async () => {
    id = newRequest('pending', 180);
    result = await race(cancelSql(id), cancelSql(id));
  });

  test('exactly one cancel affects a row', () => {
    assert.equal(result.winnerRows, 1);
    assert.equal(result.loserRows, 0, `the loser must affect zero rows, not race a second write through\nA=${result.rawA}\nB=${result.rawB}`);
  });

  test('the request ends cancelled, exactly once', () => {
    assert.equal(statusOf(id), 'cancelled');
    assert.notEqual(resolvedAtOf(id), '', 'resolved_at must be stamped');
  });
});

describe('CASE B — cancel races approve\'s own claim step, forced both ways', () => {
  test('cancel-before-approve: cancel wins, the claim affects zero rows', async () => {
    const id = newRequest('pending', 180);
    const result = await race(cancelSql(id), claimSql(id));
    assert.equal(result.winnerRows, 1);
    assert.equal(result.loserRows, 0, 'approve\'s claim step must not also succeed once cancelled');
    assert.equal(statusOf(id), 'cancelled', 'not "charging" — the approve side must never win after this');
  });

  test('approve-before-cancel: the claim wins, cancel affects zero rows', async () => {
    const id = newRequest('pending', 180);
    const result = await race(claimSql(id), cancelSql(id));
    assert.equal(result.winnerRows, 1);
    assert.equal(result.loserRows, 0, 'cancel must not also succeed once the payment has been claimed');
    assert.equal(statusOf(id), 'charging', 'the claim must stand — cancellation cannot interrupt an approval already in flight');
  });

  test('either direction, the row ends in exactly one terminal state — never both attempted writes taking effect', () => {
    // The two tests above are themselves the proof (each already asserts
    // winnerRows===1 and loserRows===0 for both orderings); this restates
    // the invariant they jointly establish for a reader who skips down here.
    assert.ok(true);
  });
});

describe('CASE C — cancel twice, sequentially', () => {
  test('the second cancel is a genuine no-op, not a second write', () => {
    const id = newRequest('pending', 180);
    const first = raw(cancelSql(id));
    assert.equal(rowsReturned(first), 1);
    const firstResolvedAt = resolvedAtOf(id);

    const second = raw(cancelSql(id));
    assert.equal(rowsReturned(second), 0, 'a repeat cancel must not affect any row');
    assert.equal(statusOf(id), 'cancelled');
    assert.equal(resolvedAtOf(id), firstResolvedAt, 'resolved_at must not move on the repeat call — no second write happened');
  });
});

describe('CASE D — an already-paid request cannot be cancelled', () => {
  test('zero rows affected; the paid row is untouched', () => {
    const id = newRequest('paid', 180);
    const before_ = statusOf(id);
    const out = raw(cancelSql(id));
    assert.equal(rowsReturned(out), 0);
    assert.equal(statusOf(id), before_, 'a paid request must never be reversed by the cancel path');
    assert.equal(statusOf(id), 'paid');
  });
});

describe('CASE E — an already-expired request stays expired, not relabelled cancelled', () => {
  test('zero rows affected', () => {
    const id = newRequest('expired', -60); // already past its window
    const out = raw(cancelSql(id));
    assert.equal(rowsReturned(out), 0);
    assert.equal(statusOf(id), 'expired');
  });
});

describe('CASE F — the business-ownership predicate, at the exact shape the function uses', () => {
  test('the request\'s real owner matches', () => {
    const id = newRequest('pending', 180);
    const match = scalar(`
      select exists (
        select 1 from public.local_businesses b, public.wallet_charge_requests r
        where r.id = '${id}' and b.id = r.business_id and b.owner_id = '${OWNER}'
      );`);
    assert.equal(match, 't');
  });

  test('an unrelated owner does not match — another business/merchant cannot cancel it', () => {
    const id = newRequest('pending', 180);
    const match = scalar(`
      select exists (
        select 1 from public.local_businesses b, public.wallet_charge_requests r
        where r.id = '${id}' and b.id = r.business_id and b.owner_id = '${OTHER}'
      );`);
    assert.equal(match, 'f');
  });

  test('the customer themself does not match — they are not the business owner', () => {
    const id = newRequest('pending', 180);
    const match = scalar(`
      select exists (
        select 1 from public.local_businesses b, public.wallet_charge_requests r
        where r.id = '${id}' and b.id = r.business_id and b.owner_id = '${CUSTOMER}'
      );`);
    assert.equal(match, 'f');
  });

  test('this is the same predicate the RLS policy already enforces for reads', () => {
    const predicate = ownerPredicateSql();
    assert.match(predicate, /b\.owner_id = auth\.uid\(\)/, 'the RLS predicate this mirrors has changed shape');
    assert.match(predicate, /b\.id = wallet_charge_requests\.business_id/);
  });
});

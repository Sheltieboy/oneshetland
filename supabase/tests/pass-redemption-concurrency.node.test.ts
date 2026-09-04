/**
 * pass-redemption-concurrency.node.test.ts — a use can only be spent once.
 *
 * WHY THIS EXISTS
 *
 * redeem_pass_atomic locks the redemption row and then the purchase row, and
 * the reasoning for why that is enough has always been sound. But the standing
 * suite only READ the function: it asserted that `for update` appears in the
 * source. That would pass against a function that took the lock and then
 * ignored what it read, and it would pass against any future edit that kept the
 * words and lost the meaning. The concurrency was exercised once, by hand,
 * against disposable production fixtures — and never again.
 *
 * So this runs it. Two operating-system processes, two connections, two
 * transactions, fighting over one pass.
 *
 * HOW THE RACE IS MADE CERTAIN
 *
 * Launching two calls together and hoping they overlap proves nothing on a fast
 * machine: a correct implementation passes and a broken one usually does too.
 * Instead the winner opens a transaction, redeems, and then SLEEPS while
 * holding its row locks. The loser starts a moment later and must contend.
 *
 *   · with the locks, the loser blocks, and on release re-reads committed state
 *   · without them, the loser reads the pre-image and acts on stale numbers
 *
 * That makes every case deterministic in both directions, which is what lets
 * the mutations below fail reliably rather than occasionally.
 *
 * WHAT IS ASSERTED
 *   A  two attempts on ONE code: one wins, one is already_used, one decrement
 *   B  two DIFFERENT codes, one use left: one wins, one no_uses_left, never -1
 *   C  two DIFFERENT codes, two uses: both win, final balance exactly 0
 *   D  fully_used_at stamped on the transition to zero, and never moved after
 *   E  the function is unreachable by anon/authenticated/public
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * This suite never runs against the linked project. It requires PASS_PROOF_DSN
 * and refuses to run without it. `npm run test:isolated` provisions a throwaway
 * PostgreSQL 17 cluster on a unix socket, runs this, and destroys it.
 *
 * The schema is not hand-written: the table definitions and the function body
 * are extracted from the real migrations at run time, so this exercises the
 * current production SQL and cannot quietly drift away from it.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BACKBONE_SQL = join(MIG, '20260721000000_loyalty_redemption_backbone.sql');
const BASELINE_SQL = join(MIG, '20260623000000_baseline_remote_schema.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';

/* ── talking to the throwaway cluster ─────────────────────────────────────── */

const args = (body: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body];

/** psql's own output, errors included — an expected refusal is data, not a crash. */
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
/** Last JSON object printed by a statement, so command tags cannot confuse it. */
const lastJson = (out: string): Record<string, unknown> => {
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  return line ? JSON.parse(line) as Record<string, unknown> : {};
};
const scalar = (body: string): string =>
  raw(body).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
/** Whole output, for anything that spans lines such as pg_get_functiondef. */
const text = (body: string): string => raw(body);

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

/**
 * Every definition of the function, in migration order.
 *
 * It is defined twice: 20260824160000 introduced it, and 20260824170000
 * replaced it because the original compared a uuid column to a text parameter
 * and so could never match a token — every call died with 42883. Pinning one
 * file would prove whichever version that file happened to hold; replaying the
 * chain, as production did, leaves the database with the definition it actually
 * runs. A third migration would be picked up without touching this test.
 */
function migrationsDefining(): string[] {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  const hits = files.filter((f) =>
    readFileSync(join(MIG, f), 'utf8').includes('create or replace function public.redeem_pass_atomic('));
  assert.ok(hits.length > 0, 'no migration defines redeem_pass_atomic');
  return hits.map((f) => join(MIG, f));
}

function functionDefs(): string {
  return migrationsDefining().map((file) => {
    const s = readFileSync(file, 'utf8');
    const start = s.indexOf('create or replace function public.redeem_pass_atomic(');
    const end = s.indexOf('$$;', start);
    assert.notEqual(end, -1, `could not find the end of redeem_pass_atomic in ${file}`);
    return s.slice(start, end + 3);
  }).join('\n');
}

/** The last definition installed — what the database will actually run. */
function currentDef(): string {
  const all = functionDefs();
  return all.slice(all.lastIndexOf('create or replace function public.redeem_pass_atomic('));
}

function grantLines(): string {
  return migrationsDefining().flatMap((file) =>
    readFileSync(file, 'utf8').split('\n')
      .filter((l) => /^(revoke|grant)\b/i.test(l.trim()) && l.includes('redeem_pass_atomic')),
  ).join('\n');
}

/* ── fixture ids, fixed so every case reads clearly ───────────────────────── */

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HOLDER = '33333333-3333-4333-8333-333333333333';
const BIZ = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`. This suite must never touch the linked project.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const schema = [
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    'create table public.local_businesses (id uuid primary key, owner_id uuid, name text, slug text);',
    createTable(BASELINE_SQL, 'CREATE TABLE public.book_unit_items'),
    createTable(BASELINE_SQL, 'CREATE TABLE public.book_unit_purchases'),
    'alter table public.book_unit_purchases add primary key (id);',
    createTable(BACKBONE_SQL, 'create table if not exists public.local_redemptions'),
    "do $r$ begin \n      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;\n      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;\n      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;\n    end $r$;",
    functionDefs(),
    grantLines(),
  ].join('\n');
  const out = raw(schema);
  assert.doesNotMatch(out, /ERROR/i, `the extracted schema did not install:\n${out.slice(0, 900)}`);

  // Everything that is not the thing under test, created once.
  raw(`
    insert into auth.users (id) values ('${OWNER}'),('${OTHER}'),('${HOLDER}');
    insert into public.local_businesses (id, owner_id, name, slug)
      values ('${BIZ}', '${OWNER}', 'ZZ Pass Proof', 'zz-pass-proof');
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase)
      values ('${ITEM}', '${BIZ}', 'ZZ 3 Session Pass', 300, 3);`);

});

/* ── fixture helpers ──────────────────────────────────────────────────────── */

let seq = 0;
const nextId = () => `66666666-6666-4666-8666-${String(++seq).padStart(12, '0')}`;

/** A pass with a given balance, plus however many pending codes are asked for. */
function givenPass(uses: number, codes: string[]): string {
  const purchase = nextId();
  const rows = codes.map((c) =>
    `('${nextId()}','${BIZ}','${HOLDER}','pass','${purchase}','${c}','${nextId()}','pending', now() + interval '1 hour')`).join(',');
  raw(`
    insert into public.book_unit_purchases (id, item_id, business_id, owner_id, paid_amount_pence, uses_remaining, expires_at)
      values ('${purchase}','${ITEM}','${BIZ}','${HOLDER}',300,${uses}, now() + interval '30 days');
    insert into public.local_redemptions (id, business_id, user_id, kind, ref_id, code, token, status, expires_at)
      values ${rows};`);
  return purchase;
}

const balance = (purchase: string) =>
  Number(scalar(`select uses_remaining from public.book_unit_purchases where id='${purchase}'`));
const fullyUsedAt = (purchase: string) =>
  scalar(`select coalesce(fully_used_at::text,'') from public.book_unit_purchases where id='${purchase}'`);
const redeemed = (purchase: string) =>
  Number(scalar(`select count(*) from public.local_redemptions where ref_id='${purchase}' and status='consumed'`));

/** Redeem, then hold the locks open so the other side must genuinely contend. */
const winnerHolding = (code: string, seconds: number) =>
  `begin;
   select redeem_pass_atomic('${OWNER}'::uuid, '${code}', null) as j;
   select pg_sleep(${seconds});
   commit;`;

const plain = (code: string) => `select redeem_pass_atomic('${OWNER}'::uuid, '${code}', null) as j;`;

/** Winner first, loser a beat later, both in flight together. */
async function race(winner: string, loser: string) {
  const a = rawAsync(winnerHolding(winner, 3));
  await new Promise((r) => setTimeout(r, 800));
  const b = rawAsync(plain(loser));
  const [outA, outB] = await Promise.all([a, b]);
  return { a: lastJson(outA), b: lastJson(outB), rawA: outA, rawB: outB };
}

/* ── the cases ────────────────────────────────────────────────────────────── */

describe('the isolated cluster really is isolated', () => {
  test('the DSN is a local socket, not the linked project', () => {
    assert.match(DSN, /^postgresql:\/\/[a-z]+@\/[a-z]+\?host=/, 'unexpected DSN shape');
    assert.doesNotMatch(DSN, /supabase/i);
  });

  test('the function under test is the one from the migration, not a copy', () => {
    const installed = text(`select pg_get_functiondef('public.redeem_pass_atomic(uuid,text,text)'::regprocedure)`);
    assert.match(installed, /for update/i, 'the installed function does not lock at all');
    assert.ok(currentDef().includes('for update'), 'the migration no longer locks');
  });
});

describe('CASE A — one code, two tills, at the same moment', () => {
  let purchase = '';
  let result: Awaited<ReturnType<typeof race>>;

  before(async () => {
    purchase = givenPass(3, ['AAAA1111']);
    result = await race('AAAA1111', 'AAAA1111');
  });

  test('exactly one attempt succeeds', () => {
    const wins = [result.a, result.b].filter((r) => r.ok === true).length;
    assert.equal(wins, 1, `expected one winner, got ${wins}\nA=${JSON.stringify(result.a)}\nB=${JSON.stringify(result.b)}`);
  });

  test('the loser is told the code is already used', () => {
    const loser = result.a.ok === true ? result.b : result.a;
    assert.equal(loser.ok, false);
    assert.equal(loser.error, 'already_used');
  });

  test('the pass is decremented exactly once', () => {
    assert.equal(balance(purchase), 2, 'the balance moved by something other than one use');
  });

  test('and only one redemption row is consumed', () => {
    assert.equal(redeemed(purchase), 1);
  });
});

describe('CASE B — different codes, one use left', () => {
  let purchase = '';
  let result: Awaited<ReturnType<typeof race>>;

  before(async () => {
    purchase = givenPass(1, ['BBBB1111', 'BBBB2222']);
    result = await race('BBBB1111', 'BBBB2222');
  });

  test('exactly one attempt succeeds', () => {
    const wins = [result.a, result.b].filter((r) => r.ok === true).length;
    assert.equal(wins, 1, `two distinct codes both spent the last use\nA=${JSON.stringify(result.a)}\nB=${JSON.stringify(result.b)}`);
  });

  test('the loser is refused for want of a use, not for the code', () => {
    const loser = result.a.ok === true ? result.b : result.a;
    assert.equal(loser.ok, false);
    assert.equal(loser.error, 'no_uses_left');
  });

  test('the balance ends at zero and never goes below it', () => {
    assert.equal(balance(purchase), 0);
  });

  test('the refused code stays pending, so it is not silently burnt', () => {
    assert.equal(redeemed(purchase), 1);
  });
});

describe('CASE C — different codes, two uses, both legitimate', () => {
  let purchase = '';
  let result: Awaited<ReturnType<typeof race>>;

  before(async () => {
    purchase = givenPass(2, ['CCCC1111', 'CCCC2222']);
    result = await race('CCCC1111', 'CCCC2222');
  });

  test('both succeed, because both were entitled to', () => {
    assert.equal(result.a.ok, true, `A=${JSON.stringify(result.a)}`);
    assert.equal(result.b.ok, true, `B=${JSON.stringify(result.b)}`);
  });

  test('the balance is exactly zero — no update was lost', () => {
    assert.equal(balance(purchase), 0, 'two concurrent spends left more than zero: a lost update');
  });

  test('both redemptions are consumed', () => {
    assert.equal(redeemed(purchase), 2);
  });
});

describe('CASE D — the last use, and what it leaves behind', () => {
  test('fully_used_at is unset while uses remain', () => {
    const p = givenPass(2, ['DDDD1111']);
    raw(plain('DDDD1111'));
    assert.equal(balance(p), 1);
    assert.equal(fullyUsedAt(p), '', 'stamped before the pass was exhausted');
  });

  test('it is stamped on the transition to zero', () => {
    const p = givenPass(1, ['DDDD2222']);
    raw(plain('DDDD2222'));
    assert.equal(balance(p), 0);
    assert.notEqual(fullyUsedAt(p), '', 'the pass hit zero without being stamped');
  });

  test('a replayed code cannot move or clear it', () => {
    const p = givenPass(1, ['DDDD3333', 'DDDD4444']);
    raw(plain('DDDD3333'));
    const stamped = fullyUsedAt(p);
    assert.notEqual(stamped, '');
    const replay = lastJson(raw(plain('DDDD3333')));
    assert.equal(replay.error, 'already_used');
    const fresh = lastJson(raw(plain('DDDD4444')));
    assert.equal(fresh.error, 'no_uses_left');
    assert.equal(fullyUsedAt(p), stamped, 'a refused redemption moved fully_used_at');
    assert.equal(balance(p), 0);
  });
});

describe('CASE E — only the server may spend a pass', () => {
  const SIG = 'public.redeem_pass_atomic(uuid,text,text)';

  for (const role of ['anon', 'authenticated', 'public']) {
    test(`${role} cannot execute it`, () => {
      const can = scalar(`select has_function_privilege('${role}', '${SIG}', 'execute')::text`);
      assert.equal(can, 'false', `${role} can spend a pass directly`);
    });
  }

  test('service_role can, because the edge function is the intended caller', () => {
    assert.equal(scalar(`select has_function_privilege('service_role', '${SIG}', 'execute')::text`), 'true');
  });

  test('it runs as definer with a pinned search_path', () => {
    const d = text(`select pg_get_functiondef('${SIG}'::regprocedure)`);
    assert.match(d, /SECURITY DEFINER/i);
    assert.match(d, /SET search_path TO ['"]?public/i);
  });

  test('and it refuses a call with no verifier', () => {
    const out = raw(`select redeem_pass_atomic(null, 'AAAA1111', null) as j;`);
    assert.match(out, /auth_required/, 'a null verifier was accepted');
  });

  test('a verifier who does not own the business is refused', () => {
    givenPass(2, ['EEEE1111']);
    const r = lastJson(raw(`select redeem_pass_atomic('${OTHER}'::uuid, 'EEEE1111', null) as j;`));
    assert.equal(r.error, 'not_your_business');
  });
});

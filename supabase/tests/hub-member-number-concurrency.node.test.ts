/**
 * hub-member-number-concurrency.node.test.ts — two people, one member number.
 *
 * WHAT IS WRONG
 *
 * activate_hub_membership allocates a member number like this:
 *
 *     select * into v_existing from public.hub_members
 *       where hub_id = p_hub and user_id = p_user
 *       for update;                                  -- the CALLER'S own row
 *     ...
 *     select coalesce(max(member_no::int), 0) + 1
 *       from public.hub_members where hub_id = p_hub;  -- no lock at all
 *
 * The `for update` locks the caller's own member row. A first-time joiner does
 * not have one, so it locks nothing, and the aggregate takes no lock either.
 * Two people joining the same hub at the same moment read the same max and are
 * both issued the same number. There was no unique constraint to stop it.
 *
 * The first case below installs the function AS IT IS TODAY and reproduces
 * that, so the fix is measured against the defect rather than an assumption.
 *
 * THE FIX
 *
 * An advisory lock keyed on the hub, taken only while allocating, plus a
 * partial unique index as the hard backstop. The lock is what lets BOTH joins
 * succeed with different numbers — a unique index alone would have failed the
 * loser's activation after their payment had already been taken.
 *
 * WHAT IS ASSERTED
 *   A  two new members, same hub, concurrent: both succeed, numbers differ
 *   B  a renewal keeps the number it had
 *   C  leave then rejoin keeps the number
 *   D  different hubs both get a member 1
 *   E  an ended/refunded membership does not release its number for reuse
 *   ·  and the index refuses a duplicate even if something allocates unlocked
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN that mentions Supabase. Run by
 * `npm run test:isolated`. The schema and both function versions are read from
 * the real migrations at run time, so this exercises production's SQL.
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
const HISTORY = join(MIG, '20260827120000_membership_history_and_safe_leave.sql');
const CURRENT = join(MIG, '20260828120000_membership_refunds.sql');
/** Columns the refunds migration added to hub_membership_purchases, which the
 *  current function writes — the table's CREATE predates them. */
const purchaseColumns = () =>
  slice(CURRENT, 'alter table public.hub_membership_purchases', ';');
const FIX = join(MIG, '20260929120000_hub_member_no_allocation.sql');

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
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) =>
  out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));

/** Slice a statement out of a migration by its opening text. */
function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `could not find the end of ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

/** The function exactly as production runs it today, defect included. */
const currentFn = () =>
  slice(CURRENT, 'create function public.activate_hub_membership(', '$function$;')
    .replace('create function', 'create or replace function');
/** The same function with the allocation serialised, plus the unique index. */
const fixedFn = () => slice(FIX, 'create or replace function public.activate_hub_membership(', '$function$;');
/** Missing? Record it — a throw in a hook removes the suite from the run
 *  entirely, and "0 tests, 0 failures" reads like success. */
let indexSql = '';
let indexError = '';
function loadIndex() {
  try { indexSql = slice(FIX, 'create unique index if not exists uq_hub_members_hub_member_no', ';'); }
  catch (e) { indexError = (e as Error).message; }
}

const HUB_A = 'a1a1a1a1-1111-4111-8111-111111111111';
const HUB_B = 'b2b2b2b2-2222-4222-8222-222222222222';
const TIER_A = 'c3c3c3c3-3333-4333-8333-333333333333';
const TIER_B = 'd4d4d4d4-4444-4444-8444-444444444444';
const u = (n: number) => `e5e5e5e5-5555-4555-8555-${String(n).padStart(12, '0')}`;

let raceBeforeFix = '';

function buildSchema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    createTable(BASELINE, 'CREATE TABLE public.hubs ('),
    // The baseline is a pg_dump: primary keys arrive as separate ALTERs, and
    // the purchases table below carries inline foreign keys that need them.
    'alter table public.hubs add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.hub_members ('),
    'alter table public.hub_members add primary key (id);',
    'alter table public.hub_members add constraint hub_members_hub_id_user_id_key unique (hub_id, user_id);',
    createTable(BASELINE, 'CREATE TABLE public.hub_membership_types ('),
    'alter table public.hub_membership_types add primary key (id);',
    createTable(HISTORY, 'create table if not exists public.hub_membership_purchases'),
    purchaseColumns(),
    // ended_at arrived with the history migration; the function writes it.
    'alter table public.hub_members add column if not exists ended_at timestamptz;',
    'create unique index if not exists uq_hub_membership_purchases_pi on public.hub_membership_purchases (payment_intent_id) where payment_intent_id is not null;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema did not build:\n${out.slice(0, 900)}`);
}

function seed() {
  raw(`
    delete from public.hub_membership_purchases; delete from public.hub_members;
    delete from public.hub_membership_types; delete from public.hubs; delete from auth.users;
    insert into auth.users (id) select u from unnest(array[
      '${u(1)}'::uuid,'${u(2)}'::uuid,'${u(3)}'::uuid,'${u(4)}'::uuid,'${u(9)}'::uuid]) u;
    insert into public.hubs (id, owner_id, name, slug, type, is_active)
      values ('${HUB_A}','${u(9)}','ZZ Hub A','zz-hub-a','club',true),
             ('${HUB_B}','${u(9)}','ZZ Hub B','zz-hub-b','club',true);
    insert into public.hub_membership_types (id, hub_id, name, price_pence, period)
      values ('${TIER_A}','${HUB_A}','Adult',1000,'year'),
             ('${TIER_B}','${HUB_B}','Adult',1000,'year');`);
}

/** Activate, then hold the transaction open so the other side must contend. */
const joinHolding = (hub: string, user: string, tier: string, pi: string, seconds: number) =>
  `begin;
   select public.activate_hub_membership('${hub}'::uuid,'${user}'::uuid,'${tier}'::uuid,'year',1000,'${pi}',95,null);
   select pg_sleep(${seconds});
   commit;`;
const activate = (hub: string, user: string, tier: string, pi: string) =>
  `select public.activate_hub_membership('${hub}'::uuid,'${user}'::uuid,'${tier}'::uuid,'year',1000,'${pi}',95,null);`;

/** Winner opens and holds; loser starts a beat later and must queue. */
async function race(a: string, b: string) {
  const pa = rawAsync(a);
  await new Promise((r) => setTimeout(r, 800));
  const pb = rawAsync(b);
  return Promise.all([pa, pb]);
}

const numbersIn = (hub: string) =>
  scalar(`select coalesce(string_agg(member_no, ',' order by member_no), '-')
            from public.hub_members where hub_id='${hub}'::uuid and member_no is not null`);
const numberFor = (hub: string, user: string) =>
  scalar(`select coalesce(member_no,'-') from public.hub_members
           where hub_id='${hub}'::uuid and user_id='${user}'::uuid`);

before(async () => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`. This suite must never touch the linked project.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  buildSchema();

  // 1. The defect, with the function exactly as production runs it today.
  assert.doesNotMatch(raw(currentFn()), /ERROR/i, 'the current function did not install');
  seed();
  await race(joinHolding(HUB_A, u(1), TIER_A, 'pi_before_1', 3), activate(HUB_A, u(2), TIER_A, 'pi_before_2'));
  raceBeforeFix = numbersIn(HUB_A);

  // 2. Now the fix.
  buildSchema();
  assert.doesNotMatch(raw(fixedFn()), /ERROR/i, 'the fixed function did not install');
  loadIndex();
  if (indexSql) assert.doesNotMatch(raw(indexSql), /ERROR/i, 'the unique index did not install');
  seed();
});

describe('the defect, reproduced before it is fixed', () => {
  test('two concurrent first-time joins were both issued member 1', () => {
    assert.equal(raceBeforeFix, '1,1',
      `expected the race to produce two member 1s; got "${raceBeforeFix}". If this passes cleanly the proof is measuring nothing.`);
  });
});

describe('CASE A — two new members, same hub, same moment', () => {
  let numbers = '';
  before(async () => {
    await race(joinHolding(HUB_A, u(1), TIER_A, 'pi_a1', 3), activate(HUB_A, u(2), TIER_A, 'pi_a2'));
    numbers = numbersIn(HUB_A);
  });

  test('both joins succeeded', () => {
    assert.equal(scalar(`select count(*)::text from public.hub_members
                          where hub_id='${HUB_A}'::uuid and status='active'`), '2',
      'a joiner was refused — the loser must queue, not fail');
  });

  test('and they were issued different numbers', () => {
    assert.equal(numbers, '1,2', `both members share a number: ${numbers}`);
  });

  test('numbering starts at 1 and does not skip', () => {
    assert.equal(numberFor(HUB_A, u(1)), '1');
    assert.equal(numberFor(HUB_A, u(2)), '2');
  });
});

describe('CASE B — a renewal keeps its number', () => {
  test('paying again does not reissue', () => {
    const before = numberFor(HUB_A, u(1));
    raw(activate(HUB_A, u(1), TIER_A, 'pi_a1_renewal'));
    assert.equal(numberFor(HUB_A, u(1)), before, 'a renewal changed the member number');
    assert.equal(numbersIn(HUB_A), '1,2', 'a renewal allocated a new number');
  });
});

describe('CASE C — leave, then rejoin', () => {
  test('the number survives leaving', () => {
    raw(`update public.hub_members set status='left', ended_at=now()
          where hub_id='${HUB_A}'::uuid and user_id='${u(2)}'::uuid;`);
    assert.equal(numberFor(HUB_A, u(2)), '2', 'leaving cleared the member number');
  });

  test('and rejoining returns the same one', () => {
    raw(activate(HUB_A, u(2), TIER_A, 'pi_a2_rejoin'));
    assert.equal(numberFor(HUB_A, u(2)), '2', 'rejoining issued a new number');
    assert.equal(scalar(`select status from public.hub_members
                          where hub_id='${HUB_A}'::uuid and user_id='${u(2)}'::uuid`), 'active');
  });
});

describe('CASE D — different hubs number independently', () => {
  test('hub B also gets a member 1', () => {
    raw(activate(HUB_B, u(3), TIER_B, 'pi_b1'));
    assert.equal(numberFor(HUB_B, u(3)), '1', 'hub B did not start at 1');
    assert.equal(numbersIn(HUB_A), '1,2', 'hub A was disturbed by a join elsewhere');
  });

  test('the same number in two hubs is allowed by the index', () => {
    assert.equal(scalar(`select count(*)::text from public.hub_members where member_no='1'`), '2');
  });
});

describe('CASE E — an ended membership does not release its number', () => {
  test('a refunded, removed member keeps theirs', () => {
    raw(`update public.hub_members
            set status='removed', ended_at=now(), paid_until=null, last_payment_pence=0
          where hub_id='${HUB_A}'::uuid and user_id='${u(2)}'::uuid;`);
    assert.equal(numberFor(HUB_A, u(2)), '2', 'a removed member lost their number');
  });

  test('and the next joiner is given 3, not the vacated 2', () => {
    raw(activate(HUB_A, u(4), TIER_A, 'pi_a4'));
    assert.equal(numberFor(HUB_A, u(4)), '3', 'a member number was recycled');
    assert.equal(numbersIn(HUB_A), '1,2,3');
  });
});

describe('the index is a real backstop, not decoration', () => {
  test('the migration actually creates it', () => {
    assert.equal(indexError, '', `the unique index is missing from the migration: ${indexError}`);
    assert.match(indexSql, /on public\.hub_members \(hub_id, member_no\)/,
      'the index must be scoped to the hub, so two hubs may each have a member 1');
    assert.match(indexSql, /where member_no is not null/, 'the index must be partial');
  });

  test('a duplicate written directly is refused', () => {
    const out = raw(`insert into public.hub_members (hub_id, user_id, role, status, member_no)
                     values ('${HUB_A}'::uuid,'${u(9)}'::uuid,'member','active','1');`);
    assert.match(out, /duplicate key value|unique constraint/i,
      'the unique index did not stop a duplicate member number');
  });

  test('but a null member_no is not constrained', () => {
    const out = raw(`insert into public.hub_members (hub_id, user_id, role, status, member_no)
                     values ('${HUB_B}'::uuid,'${u(9)}'::uuid,'member','pending',null);`);
    assert.doesNotMatch(out, /duplicate key value/i, 'the index is not partial — pending members cannot exist');
  });
});

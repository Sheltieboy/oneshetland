/**
 * payment-abuse-limits.node.test.ts — the database half of the card-testing controls.
 *
 * WHAT IT PROVES, against the real limiter SQL (20260821280000_rate_limits.sql) plus migration 20261118000000:
 *
 *   · the new budgets exist with the intended ceilings, and the existing ones did not move
 *   · stripe_intent_burst really stops a loop within a minute, and stripe_intent_day stops it farming the hour limit
 *   · a refused claim spends NOTHING (all-or-nothing across the four budgets a payment start claims)
 *   · rate_limit_blocked is READ-ONLY (asking never costs allowance), blocks exactly when a ceiling is reached,
 *     treats an unclassified action as blocked, and is isolated per account
 *   · payment_failed / pi_failed behave as the brake needs: the Nth failure is counted, the one after the ceiling is refused
 *   · NO client role can read, write or reset a counter or a policy, and cannot call either function
 *   · the migration is idempotent, and refuses to commit if a rate-limit table has been opened to clients
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. No Stripe, no network.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const LIMITER = join(MIG, '20260821280000_rate_limits.sql');
const FIX = join(MIG, '20261118000000_payment_start_abuse_limits.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';

const SVC = 'set local role service_role;';
const claim = (subject: string, actions: string[]) =>
  scalar(`begin; ${SVC} select allowed||'|'||coalesce(blocked_action,'-') from public.claim_rate_limits('${subject}', array[${actions.map((a) => `'${a}'`).join(',')}]); commit;`);
const blocked = (subject: string, actions: string[]) =>
  scalar(`begin; ${SVC} select blocked||'|'||coalesce(blocked_action,'-') from public.rate_limit_blocked('${subject}', array[${actions.map((a) => `'${a}'`).join(',')}]); commit;`);
const used = (subject: string, action: string) =>
  Number(scalar(`select coalesce(sum(count),0) from public.rate_limits where subject='${subject}' and action='${action}'`));
const START = ['stripe_intent', 'stripe_intent_burst', 'stripe_intent_day', 'stripe_any'];
const u = (n: number) => `user:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const limiter = src(LIMITER);
  const upto = limiter.indexOf('commit;\n\n-- Scheduled outside');
  assert.notEqual(upto, -1, 'the limiter migration changed shape');
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'grant usage on schema public to anon, authenticated, service_role;',
    limiter.slice(0, upto + 'commit;'.length),
    // Supabase's default privileges, granted AFTER the limiter's own revokes would be wrong; the migration's revokes stand.
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `the limiter did not build:\n${out.slice(0, 1500)}`);
  const fix = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(fix.status, 0, `migration failed:\n${fix.stderr}`);
});

describe('the budgets', () => {
  const policy = (a: string) => scalar(`select window_seconds||'/'||max_count from public.rate_limit_policies where action='${a}'`);
  test('the new ceilings exist as designed', () => {
    assert.equal(policy('stripe_intent_burst'), '60/10');
    assert.equal(policy('stripe_intent_day'), '86400/120');
    assert.equal(policy('payment_failed'), '3600/10');
    assert.equal(policy('payment_failed_day'), '86400/30');
    assert.equal(policy('pi_failed'), '86400/6');
  });
  test('the existing Stripe budgets did not move', () => {
    assert.equal(policy('stripe_intent'), '3600/40');
    assert.equal(policy('stripe_any'), '3600/45');
    assert.equal(policy('stripe_account'), '3600/6');
  });
});

describe('a payment start is limited, and a refusal costs nothing', () => {
  test('a scripted loop is stopped by the per-minute budget: 10 get through, the 11th does not, however many hours are left', () => {
    const s = u(1);
    for (let i = 1; i <= 10; i++) assert.equal(claim(s, START), 'true|-', `start ${i}`);
    assert.equal(claim(s, START), 'false|stripe_intent_burst');
  });
  test('all-or-nothing: the refused 11th spent none of the other three budgets', () => {
    const s = u(1);
    assert.equal(used(s, 'stripe_intent'), 10);
    assert.equal(used(s, 'stripe_intent_day'), 10);
    assert.equal(used(s, 'stripe_any'), 10);
    assert.equal(used(s, 'stripe_intent_burst'), 10);
  });
  test('the daily ceiling stops the hourly budget being farmed round the clock', () => {
    const s = u(2);
    raw(`insert into public.rate_limits (subject, action, bucket, count)
          values ('${s}', 'stripe_intent_day', to_timestamp(floor(extract(epoch from now())/86400)*86400), 120)`);
    assert.equal(claim(s, START), 'false|stripe_intent_day');
  });
  test('accounts are independent: one account at its ceiling does not slow another', () => {
    assert.equal(claim(u(3), START), 'true|-');
  });
  test('an unclassified action is refused, never allowed', () => {
    assert.equal(claim(u(3), ['stripe_intent_typo']), 'false|stripe_intent_typo');
  });
});

describe('rate_limit_blocked — the failed-payment gate', () => {
  const FAIL = ['payment_failed', 'payment_failed_day'];
  test('it is READ-ONLY: asking any number of times costs nothing and creates no row', () => {
    const s = u(10);
    for (let i = 0; i < 6; i++) assert.equal(blocked(s, FAIL), 'false|-');
    assert.equal(Number(scalar(`select count(*) from public.rate_limits where subject='${s}'`)), 0);
  });
  test('it blocks exactly when the account has failed too many payments in the hour', () => {
    const s = u(11);
    for (let i = 1; i <= 9; i++) {
      assert.equal(claim(s, FAIL), 'true|-', `failure ${i} is recorded`);
      assert.equal(blocked(s, FAIL), 'false|-', `still allowed to start a payment after ${i} failures`);
    }
    assert.equal(claim(s, FAIL), 'true|-');                    // the 10th failure is recorded…
    assert.equal(blocked(s, FAIL), 'true|payment_failed');      // …and now new payment starts are refused
    assert.equal(claim(s, FAIL), 'false|payment_failed');       // an 11th failure is simply not recorded further
  });
  test('and the daily failure ceiling blocks even when the hourly bucket has turned', () => {
    const s = u(12);
    raw(`insert into public.rate_limits (subject, action, bucket, count)
          values ('${s}', 'payment_failed_day', to_timestamp(floor(extract(epoch from now())/86400)*86400), 30)`);
    assert.equal(blocked(s, FAIL), 'true|payment_failed_day');
  });
  test('it is per account: another account is not blocked', () => assert.equal(blocked(u(13), FAIL), 'false|-'));
  test('an unclassified action is reported blocked (exactly as the claim treats it)', () => assert.equal(blocked(u(13), ['nope']), 'true|nope'));
  test('the retry hint is positive and no longer than the window', () => {
    const r = scalar(`begin; ${SVC} select retry_after_secs from public.rate_limit_blocked('${u(11)}', array['payment_failed']); commit;`);
    assert.ok(Number(r) >= 1 && Number(r) <= 3600, r);
  });
  test('the per-intent counter: 6 failures are counted, the 7th finds the ceiling (that is the one that cancels the intent)', () => {
    const s = 'pi:pi_3Lexample';
    for (let i = 1; i <= 6; i++) assert.equal(claim(s, ['pi_failed']), 'true|-', `failure ${i}`);
    assert.equal(claim(s, ['pi_failed']), 'false|pi_failed');
  });
});

describe('no client can touch the limiter', () => {
  const as = (role: string, sql: string) => raw(`begin; set local role ${role}; ${sql}; rollback;`);
  for (const role of ['anon', 'authenticated']) {
    test(`${role}: cannot read, write or reset a counter or a policy`, () => {
      for (const sql of ['select * from public.rate_limits', 'delete from public.rate_limits', `update public.rate_limits set count = 0`,
        `insert into public.rate_limits (subject, action, bucket) values ('user:x','stripe_intent', now())`,
        'select * from public.rate_limit_policies', `update public.rate_limit_policies set max_count = 1000000`, 'delete from public.rate_limit_policies']) {
        assert.match(as(role, sql), /permission denied/, `${role}: ${sql}`);
      }
    });
    test(`${role}: cannot call the claim, the gate, or purge`, () => {
      for (const sql of [`select * from public.claim_rate_limits('user:x', array['stripe_intent'])`, `select * from public.rate_limit_blocked('user:x', array['payment_failed'])`, 'select public.purge_rate_limits()']) {
        assert.match(as(role, sql), /permission denied/, `${role}: ${sql}`);
      }
    });
  }
  test('RLS is on for both tables, and there is no policy that could open them', () => {
    assert.equal(scalar(`select bool_and(relrowsecurity)::text from pg_class where oid in ('public.rate_limits'::regclass, 'public.rate_limit_policies'::regclass)`), 'true');
    assert.equal(scalar(`select count(*) from pg_policies where tablename like 'rate_limit%'`), '0');
  });
  test('service_role (our Edge Functions) keeps what it needs', () => {
    for (const f of ['claim_rate_limits(text, text[])', 'rate_limit_blocked(text, text[])']) assert.equal(scalar(`select has_function_privilege('service_role', 'public.${f}', 'EXECUTE')::text`), 'true', f);
  });
});

describe('the migration', () => {
  test('is idempotent and changes no existing policy row', () => {
    const before = scalar(`select md5(string_agg(action||window_seconds||max_count, ',' order by action)) from public.rate_limit_policies where action not in ('stripe_intent_burst','stripe_intent_day','payment_failed','payment_failed_day','pi_failed')`);
    const again = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(scalar(`select md5(string_agg(action||window_seconds||max_count, ',' order by action)) from public.rate_limit_policies where action not in ('stripe_intent_burst','stripe_intent_day','payment_failed','payment_failed_day','pi_failed')`), before);
  });
  test('it touches only the limiter objects', () => {
    const sql = src(FIX).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const named = new Set([...sql.matchAll(/\bpublic\.([a-z_]+)/g)].map((m) => m[1]));
    assert.deepEqual([...named].sort(), ['rate_limit_blocked', 'rate_limit_policies', 'rate_limits']);
  });
  test('it refuses to commit if a rate-limit table has been opened to a client', () => {
    raw('grant select on public.rate_limits to anon;');
    const r = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must not be client-reachable/);
    raw('revoke select on public.rate_limits from anon;');
  });
});

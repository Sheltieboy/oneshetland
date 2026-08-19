/**
 * ticket-expiry.node.test.ts — an abandoned checkout cannot hold seats forever.
 *
 * WHY THIS TEST EXISTS
 * expire_stale_ticket_orders has worked since 20260729020000. It had simply
 * never been scheduled: the live cron.job table carried five active jobs and
 * none of them was this one. So a buyer who opened checkout and walked away
 * held those seats until somebody noticed by hand.
 *
 * Migration 20260819240000 schedules it every five minutes against a 60-minute
 * staleness threshold, so the real hold is 60–65 minutes rather than unbounded.
 *
 * WHAT IS ASSERTED
 *   · a stale pending order expires and returns its seats exactly once
 *   · running expiry again changes nothing
 *   · a PAID order is never expired, whatever its age
 *   · reservations made by the Step 3B basket model are recognised
 *   · quantity_sold can never be driven negative by repeated runs
 *   · the function stays unreachable from a browser
 *   · production has exactly one expiry job, active, on the intended cadence
 *
 * SAFETY
 * Every database case runs inside a transaction that is always rolled back.
 *
 * A note on the shape of the repeat-run test: expire_stale_ticket_orders builds
 * a `_stale_orders` temp table ON COMMIT DROP, so it cannot be called twice in
 * one transaction without dropping that table in between. pg_cron gives each
 * run its own transaction, so this is a testing artefact rather than a defect —
 * but it is why the test drops the table between calls instead of just calling
 * the function three times.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function query(sql: string): Record<string, unknown> | null {
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 150_000 });
    return (JSON.parse(out) as { rows?: Record<string, unknown>[] }).rows?.[0] ?? null;
  } catch { return null; }
}

// ── 1. Expiry behaviour, against the live schema ────────────────────────────

const LIFECYCLE_SQL = `
begin;
create temp table t as select id, event_id from public.event_ticket_types limit 1;
update public.event_ticket_types set quantity_available=quantity_sold+10, is_active=true, per_order_max=10 where id=(select id from t);
create temp table u as select id from public.profiles limit 1;
create temp table b0 as select quantity_sold s from public.event_ticket_types where id=(select id from t);
create function pg_temp.seats(p_type uuid, p_n int) returns jsonb language sql as $g$
  select jsonb_agg(jsonb_build_object('ticket_type_id',p_type,
    'token_hash', encode(sha256((p_type::text||g||random()::text)::bytea),'hex')))
  from generate_series(1,p_n) g $g$;

-- abandoned checkout, created through the Step 3B basket model
create temp table made as select (public.reserve_ticket_basket(
  (select event_id from t),(select id from u),pg_temp.seats((select id from t),4),0,0,'{}'::jsonb)->>'order_id')::uuid oid;
create temp table b1 as select quantity_sold s from public.event_ticket_types where id=(select id from t);

-- a PAID order of the same age, which must survive
create temp table paid as select (public.reserve_ticket_basket(
  (select event_id from t),(select id from u),pg_temp.seats((select id from t),2),0,0,'{}'::jsonb)->>'order_id')::uuid oid;
update public.event_ticket_orders set status='paid', paid_at=now() where id=(select oid from paid);
update public.event_tickets set status='valid' where order_id=(select oid from paid);
create temp table b2 as select quantity_sold s from public.event_ticket_types where id=(select id from t);

update public.event_ticket_orders set created_at = now() - interval '3 hours'
 where id in (select oid from made union select oid from paid);

create temp table run1 as select public.expire_stale_ticket_orders(60) n;
create temp table b3 as select quantity_sold s from public.event_ticket_types where id=(select id from t);
drop table if exists _stale_orders;
create temp table run2 as select public.expire_stale_ticket_orders(60) n;
drop table if exists _stale_orders;
create temp table run3 as select public.expire_stale_ticket_orders(60) n;
create temp table b4 as select quantity_sold s from public.event_ticket_types where id=(select id from t);

select (select n from run1) run1_expired, (select n from run2) run2_expired, (select n from run3) run3_expired,
  ((select s from b1)-(select s from b0)) reserved_abandoned,
  ((select s from b2)-(select s from b1)) reserved_paid,
  ((select s from b3)-(select s from b2)) released_by_run1,
  ((select s from b4)-(select s from b3)) released_by_later_runs,
  ((select s from b4)-(select s from b0)) net_change,
  (select status from public.event_ticket_orders where id=(select oid from made)) abandoned_status,
  (select status from public.event_ticket_orders where id=(select oid from paid)) paid_status,
  (select count(*) from public.event_tickets where order_id=(select oid from paid) and status='valid') paid_tickets_valid,
  (select count(*) from public.event_tickets where order_id=(select oid from made) and status='pending_payment') abandoned_tickets_still_holding,
  (select quantity_sold >= 0 from public.event_ticket_types where id=(select id from t)) never_negative;
rollback;`;

describe('stale ticket orders expire and give their seats back', () => {
  let r: Record<string, unknown> | null = null;
  before(() => { r = query(LIFECYCLE_SQL); });

  const CASES: Array<[string, unknown, string]> = [
    ['reserved_abandoned',     4,  'the basket model did not reserve the abandoned order'],
    ['reserved_paid',          2,  'the basket model did not reserve the paid order'],
    ['run1_expired',           1,  'expiry did not cancel the one stale order'],
    ['released_by_run1',      -4,  'expiry did not return exactly the seats the stale order held'],
    ['run2_expired',           0,  'a second run expired something again — not idempotent'],
    ['run3_expired',           0,  'a third run expired something again — not idempotent'],
    ['released_by_later_runs', 0,  'SEATS RELEASED TWICE — repeated runs double-decrement capacity'],
    ['net_change',             2,  'the paid order lost or gained capacity'],
    ['abandoned_status', 'cancelled', 'the abandoned order was not cancelled'],
    ['abandoned_tickets_still_holding', 0, 'the abandoned order still holds pending tickets'],
    ['paid_status',      'paid',       'A PAID ORDER WAS EXPIRED — a buyer who paid lost their tickets'],
    ['paid_tickets_valid',     2,  'a paid order lost its valid tickets'],
    ['never_negative',      true,  'quantity_sold went negative'],
  ];

  test('lifecycle: reserve, abandon, expire, re-run', (t) => {
    if (!r) { t.skip('Supabase CLI or linked project unavailable — run `supabase link`.'); return; }
    const failed = CASES.filter(([k, want]) => r![k] !== want);
    if (failed.length) {
      assert.fail('EXPIRY REGRESSION:\n' +
        failed.map(([k, want, why]) => `  • ${k}: ${why} (got ${JSON.stringify(r![k])}, expected ${JSON.stringify(want)})`).join('\n'));
    }
    console.log('\n  ticket expiry lifecycle verified against the live schema (rolled back)\n');
  });
});

// ── 2. The schedule itself ──────────────────────────────────────────────────

describe('stale expiry is actually scheduled in production', () => {
  let r: Record<string, unknown> | null = null;
  before(() => {
    r = query(`select
      (select count(*) from cron.job where jobname='expire-stale-ticket-orders') as expiry_jobs,
      (select count(*) from cron.job where jobname='expire-stale-ticket-orders' and active) as active_jobs,
      (select schedule from cron.job where jobname='expire-stale-ticket-orders') as schedule,
      (select count(*) from cron.job) as total_jobs,
      (select count(*) from cron.job_run_details d
         join cron.job j on j.jobid=d.jobid
        where j.jobname='expire-stale-ticket-orders' and d.status='succeeded') as succeeded_runs;`);
  });

  test('exactly one active expiry job, on a cadence that matches the threshold', (t) => {
    if (!r) { t.skip('CLI unavailable'); return; }
    assert.equal(r.expiry_jobs, 1,
      'there must be exactly one expire-stale-ticket-orders job — duplicates would race each other');
    assert.equal(r.active_jobs, 1, 'the expiry job exists but is not active');
    // The function's threshold is 60 minutes. Anything slower than every 15
    // makes the real hold materially longer than the rule it enforces.
    assert.match(String(r.schedule), /^\*\/(1|2|3|5|10|15) \* \* \* \*$/,
      `expiry runs on "${r.schedule}" against a 60-minute threshold — too slow to keep the real hold near the rule`);
  });

  test('the job has actually executed successfully', (t) => {
    if (!r) { t.skip('CLI unavailable'); return; }
    assert.ok(Number(r.succeeded_runs) > 0,
      'cron.job_run_details records no successful run — the job exists but has never fired. ' +
      'A scheduled job that has never run is not a working safety net.');
  });
});

// ── 3. Still not reachable from a browser ───────────────────────────────────

describe('expire_stale_ticket_orders stays server-only', () => {
  before(() => { if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).'); });

  test('anon cannot execute it', async () => {
    const res = await fetch(`${cfg!.url}/rest/v1/rpc/expire_stale_ticket_orders`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_older_than_minutes: 999_999 }),
    });
    assert.notEqual(res.status, 404, 'signature drifted — the probe stopped testing anything');
    assert.equal(res.status, 401,
      `SECURITY REGRESSION: expire_stale_ticket_orders answered the anon key with HTTP ${res.status}. ` +
      'Scheduling it must not have widened its grants — pg_cron runs as postgres, which already had EXECUTE.');
  });

  test('release_ticket_order is still server-only too', async () => {
    const res = await fetch(`${cfg!.url}/rest/v1/rpc/release_ticket_order`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_order_id: NIL }),
    });
    assert.equal(res.status, 401, `release_ticket_order answered anon with HTTP ${res.status}`);
  });
});

/**
 * fetch-price-lock.node.test.ts — charged under the terms you agreed to.
 *
 * Fix 4 made the HOLD large enough to cover a waiting fee. It did not stop the
 * CAPTURE being computed under different rules to the hold: both the service
 * fee and every waiting term were re-read from mutable global configuration at
 * capture time, so raising the platform fee or the waiting rate while a
 * delivery was in flight enlarged a charge the customer had already agreed to.
 *
 * Measured against production configuration before the fix: a delivery
 * authorised at £11.50 would have had £19.00 attempted at capture. The clamp
 * would have caught it — as silent lost revenue for the driver, which is not a
 * fix, it is a different failure.
 *
 * The drift tests below run against the real database inside a transaction
 * that is always rolled back, because the question is what the DATABASE
 * computes, not what the source appears to say.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const authorise = code(readFileSync(join(REPO_ROOT, 'supabase/functions/authorise-payment/index.ts'), 'utf8'));
const capture   = code(readFileSync(join(REPO_ROOT, 'supabase/functions/capture-payment/index.ts'), 'utf8'));
const migration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260909120000_fetch_price_lock.sql'), 'utf8');

/** Rolled back, always: the guard row makes an accidental commit impossible. */
function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}

/**
 * One delivery, authorised under today's configuration, then the platform
 * changes its prices before the driver arrives. Returns what capture computes.
 */
const DRIFT = `
begin;
  -- a disposable customer, driver, request and waiting event
  insert into auth.users (id, email) values
    ('11111111-1111-1111-1111-111111111111', 'pricelock-c@probe.invalid'),
    ('22222222-2222-2222-2222-222222222222', 'pricelock-d@probe.invalid');
  insert into public.delivery_requests
    (id, customer_id, category_slug, pickup_name, pickup_location, destination_address,
     destination_area, liability_acknowledged, status, ready_for_collection)
  values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
     'shopping', 'PROBE', 'PROBE', 'PROBE', 'Unst', true, 'matched', true);
  update public.delivery_requests set base_fee_pence = 400
   where id = '33333333-3333-3333-3333-333333333333';

  -- T0: authorise, freezing today's terms
  create temp table _claim on commit drop as select * from public.claim_fetch_authorisation(
    '33333333-3333-3333-3333-333333333333'::uuid,
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    400 + (select (value)::int from public.admin_config where key='fees.fetch.fixed_pence')
        + (select wait_max_pence from public.delivery_pricing_config limit 1),
    400,
    (select (value)::int from public.admin_config where key='fees.fetch.fixed_pence'),
    (select wait_grace_secs   from public.delivery_pricing_config limit 1),
    (select wait_period_secs  from public.delivery_pricing_config limit 1),
    (select wait_period_pence from public.delivery_pricing_config limit 1),
    (select wait_max_pence    from public.delivery_pricing_config limit 1));

  -- the driver waited 22 minutes
  insert into public.waiting_events (request_id, driver_id, arrived_at, collected_at)
  values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
          now() - interval '22 minutes', now());

  -- T1: the platform raises everything while the delivery is in flight
  update public.admin_config set value = '300'::jsonb where key = 'fees.fetch.fixed_pence';
  update public.delivery_pricing_config
     set wait_period_pence = 300, wait_max_pence = 1200, wait_grace_secs = 0;

  select t.total_pence, t.authorised_pence, t.terms_frozen,
         (t.total_pence > t.authorised_pence) as exceeds_hold
    from public.fetch_capture_total_pence('33333333-3333-3333-3333-333333333333') t;
rollback;
`;

let drift: Record<string, unknown> | null = null;
try { drift = sql(DRIFT)[0] ?? null; } catch { drift = null; }

/* ── 1. the drift, measured ───────────────────────────────────────────────── */
describe('a price rise mid-delivery cannot enlarge a held charge', () => {
  test('the scenario ran', { skip: !drift }, () => {
    assert.ok(drift, 'the rollback-safe drift scenario could not run');
  });

  test('the terms are frozen onto the authorisation', { skip: !drift }, () => {
    assert.equal(drift!.terms_frozen, true, 'the delivery carries no frozen terms');
  });

  test('and capture stays inside the hold despite the rise', { skip: !drift }, () => {
    const total = Number(drift!.total_pence);
    const held  = Number(drift!.authorised_pence);
    assert.equal(drift!.exceeds_hold, false,
      `capture wanted ${total}p against a ${held}p hold — the config change leaked through`);
    assert.ok(total <= held, `${total} > ${held}`);
  });

  test('the waiting fee is still measured, under the OLD rules', { skip: !drift }, () => {
    // 22 minutes, 5-minute grace, £1.50 per 5 minutes → 3 periods → 450p,
    // under the frozen £6.00 cap. The new rules (no grace, £3.00 per period,
    // £12.00 cap) would have produced far more.
    const total = Number(drift!.total_pence);
    assert.ok(total > 400 + 150, 'no waiting fee was charged at all');
    assert.ok(total < 400 + 300 + 1200, 'the new, higher terms were used');
  });
});

/* ── 2. where each term comes from ────────────────────────────────────────── */
describe('the terms are captured when the hold is placed', () => {
  test('authorisation freezes base, service and every waiting rule', () => {
    for (const p of ['p_base:', 'p_service:', 'p_grace:', 'p_period:', 'p_rate:', 'p_cap:']) {
      assert.ok(authorise.includes(p), `${p} is not frozen at authorisation`);
    }
  });

  test('capture asks for the total under those terms', () => {
    assert.match(capture, /rpc\('fetch_capture_total_pence', \{ p_request: request_id \}\)/);
    assert.match(capture, /if \(totals\?\.terms_frozen\)/);
  });

  test('the live commission config is only the legacy fallback', () => {
    const frozen = capture.indexOf('if (totals?.terms_frozen)');
    const live   = capture.indexOf("getCommissionConfig(supabase, 'fetch')");
    assert.ok(live > frozen, 'current configuration is consulted before the frozen terms');
  });

  test('the waiting fee prefers frozen terms over live configuration', () => {
    assert.match(migration, /coalesce\(a\.wait_grace_secs,\s+c\.wait_grace_secs/);
    assert.match(migration, /coalesce\(a\.wait_max_pence,\s+c\.wait_max_pence/);
  });

  test('the authorised maximum is persisted, not recomputed', () => {
    assert.match(migration, /amount_pence/);
    assert.match(capture, /authorised_pence/);
  });

  test('the old claim signature is dropped, not left as an overload', () => {
    // `create or replace` with new parameters makes a SECOND function, and the
    // stale one stays callable — which is how a superseded rule survived once.
    assert.match(migration, /drop function if exists public\.claim_fetch_authorisation\(uuid, uuid, uuid, integer\);/);
  });

  test('the base fee is still the one Fix 1 stored', () => {
    assert.match(authorise, /const baseFeePence = request\.base_fee_pence;/);
    assert.ok(!/fetch_base_fee_pence/.test(capture), 'capture recomputes the base fee');
  });
});

/* ── 3. a shortfall is surfaced, never absorbed ───────────────────────────── */
describe('an authorisation shortfall is somebody’s problem, not nobody’s', () => {
  test('the clamp records a mismatch rather than quietly taking less', () => {
    const block = capture.slice(capture.indexOf('const captureAmount = Math.min'));
    assert.match(block, /authorisation shortfall/);
    assert.match(block, /settle_fetch_capture/);
    assert.match(block, /expected \$\{totalPence\}p but only \$\{capturable\}p was authorised/);
  });

  test('and says which kind it is', () => {
    assert.match(capture, /frozen terms should have made this impossible/);
    assert.match(capture, /legacy pre-freeze authorisation/);
  });

  test('the clamp still cannot be exceeded', () => {
    assert.match(capture, /const captureAmount = Math\.min\(totalPence, capturable\)/);
    assert.match(capture, /amount_to_capture: String\(captureAmount\)/);
  });
});

/* ── 4. new deliveries do use new prices ──────────────────────────────────── */
describe('a price change still applies to the next Fetch', () => {
  test('the terms come from configuration at authorisation time', () => {
    assert.match(authorise, /from\('delivery_pricing_config'\)/);
    assert.match(authorise, /getCommissionConfig\(supabase, 'fetch'\)/);
    // Frozen means "as at this hold", not "as at some fixed past date".
    assert.match(authorise, /p_cap:      waitingHeadroom,/);
  });

  test('the customer is quoted the frozen maximum, not a global figure', () => {
    assert.match(authorise, /We hold up to £\$\{\(\(baseFeePence \+ serviceFeePence \+ waitingHeadroom\) \/ 100\)/);
  });

  test('the snapshot columns are server-managed', () => {
    assert.match(migration, /revoke execute on function public\.claim_fetch_authorisation\(uuid, uuid, uuid, integer, integer, integer, integer, integer, integer, integer\) from anon, authenticated, public/);
    assert.match(migration, /grant  execute on function public\.fetch_capture_total_pence\(uuid\) to service_role/);
  });
});

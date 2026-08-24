/**
 * booking-metering-invocation.node.test.ts — the meter that stopped silently.
 *
 * WHAT WAS WRONG
 *
 * meter-bookings was returning 403 Forbidden to reminder-runner on every pass,
 * and nothing anywhere said so.
 *
 * reminder-runner invoked it as:
 *
 *     const { data: metered } = await svc.functions.invoke('meter-bookings', { body: {} });
 *     result.bookings_metered = (metered as { units?: number } | null)?.units ?? 0;
 *
 * Two faults, one on top of the other:
 *
 *   · functions.invoke did not carry the service key to the gateway, even
 *     though createServiceClient() builds the client with it and every database
 *     call it makes is correctly service-role. meter-bookings' own
 *     isServiceRole() check refused it.
 *
 *   · the error was DROPPED. functions.invoke resolves with { data, error }
 *     rather than throwing, so the surrounding catch never fired. A failing
 *     meter looked exactly like a quiet one — bookings_metered: 0, ok: true,
 *     HTTP 200, cron.job_run_details all green, 940 consecutive "successes".
 *
 * Proven in production rather than reasoned about. meter-bookings invoked
 * directly with the service key returned 200 and marked the backlog
 * immediately; invoked through reminder-runner it returned
 *
 *     FunctionsHttpError: … status=403 body={"error":"Forbidden"}
 *
 * which is what the newly surfaced metering_error field printed the moment it
 * was deployed.
 *
 * NOT AN OUTAGE SINCE 18 AUGUST. max(metered_at) sat at 18 Aug, but no booking
 * was CREATED between 18 Aug 11:52 and 24 Aug 11:01 — the meter had nothing to
 * do. The only genuinely missed booking is the one from 24 Aug.
 *
 * WHAT IS ASSERTED
 *   · the invocation states the service-role Authorization header explicitly
 *   · a metering failure is recorded, not swallowed
 *   · reminder-runner cannot report a healthy run while metering failed
 *   · meter-bookings still refuses anyone who is not service_role
 *   · Premium is marked, never billed; per-booking idempotency is intact
 *   · the health function still judges from data, not from the scheduler
 *
 * SAFETY
 * Source inspection only. The live behaviour was exercised against production
 * with disposable premium fixtures, all removed afterwards. No Stripe usage was
 * reported: the entire backlog was Premium, which is marked and never billed.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const runner = read('supabase/functions/reminder-runner/index.ts');
const meter = read('supabase/functions/meter-bookings/index.ts');
const health = read('supabase/migrations/20260821200000_metering_health_and_reclaim_window.sql');
const config = read('supabase/config.toml');

/** The metering block of reminder-runner. */
const meterBlock =
  runner.match(/\/\/ ── Bookings meter[\s\S]*?\n    \/\/ ── Loyalty/)?.[0] ?? '';

/* ── 1. The invocation authenticates ──────────────────────────────────────── */

describe('reminder-runner reaches meter-bookings as service_role', () => {
  test('the metering block was found', () => {
    assert.ok(meterBlock.length > 0, 'could not locate the metering block');
  });

  test('the Authorization header is stated explicitly, not inferred', () => {
    assert.match(meterBlock, /headers: \{ Authorization: `Bearer \$\{serviceKey\}` \}/);
    assert.match(meterBlock, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  });

  test('meter-bookings still refuses anyone who is not service_role', () => {
    assert.match(meter, /if \(!isServiceRole\(auth, serviceKey\)\) return json\(\{ error: 'Forbidden' \}, 403\);/);
    const check = meter.match(/function isServiceRole[\s\S]*?\n}/)?.[0] ?? '';
    assert.match(check, /json\?\.role === 'service_role'/);
  });

  test('it still requires a JWT at the gateway too', () => {
    assert.match(config, /\[functions\.meter-bookings\]\s*\nverify_jwt = true/);
  });

  test('reminder-runner itself stays reachable by the scheduler', () => {
    // pg_cron sends no Authorization header at all, only x-cron-secret.
    assert.match(config, /\[functions\.reminder-runner\]\s*\nverify_jwt = false/);
  });
});

/* ── 2. A failure can no longer hide ──────────────────────────────────────── */

describe('a metering failure stays visible', () => {
  test('the invoke error is read rather than dropped', () => {
    assert.match(meterBlock, /error: meterErr/);
    assert.match(meterBlock, /if \(meterErr\) \{/);
  });

  test('it is recorded on the run result, not just logged', () => {
    assert.match(meterBlock, /result\.metering_error = detail/);
    assert.match(runner, /metering_error: null as string \| null/);
  });

  test('the real reason is extracted from the response body', () => {
    // "returned a non-2xx status code" on its own is what made this invisible.
    const helper = runner.match(/async function describeInvokeError[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(helper.length > 0, 'describeInvokeError not found');
    assert.match(helper, /e\?\.context/);
    assert.match(helper, /status=/);
    assert.match(helper, /body=/);
  });

  test('errors reported BY meter-bookings surface too, not just transport errors', () => {
    assert.match(meterBlock, /m\?\.errors\?\.length/);
    assert.match(meterBlock, /result\.metering_error = m\.errors/);
  });

  test('a thrown error is still caught and recorded', () => {
    assert.match(meterBlock, /catch \(e\) \{[\s\S]*?result\.metering_error = detail;/);
  });

  test('premium_marked is reported, so a Premium-only run is distinguishable from a dead one', () => {
    // units is 0 for a successful Premium-only pass, which is exactly what a
    // broken meter also returned. premium_marked tells them apart.
    assert.match(meterBlock, /result\.premium_marked = m\?\.premium_marked \?\? 0/);
  });
});

/* ── 3. The commercial rules are untouched ────────────────────────────────── */

describe('what gets billed did not change', () => {
  test('Premium is marked, never billed', () => {
    assert.match(meter, /PREMIUM IS MARKED, NOT BILLED/);
    assert.match(meter, /── Premium: mark processed, never bill ─/);
  });

  test('Pro is 95p per booking, capped at 17', () => {
    assert.match(meter, /const BOOKING_FEE_PENCE = 95;/);
    assert.match(meter, /const MONTHLY_CAP_UNITS = 17;/);
  });

  test('the unit of billing is ONE booking, so a payload cannot drift', () => {
    assert.match(meter, /Now the unit is ONE BOOKING\. Quantity is always 1/);
  });

  test('idempotency is the booking-scoped attempt id, in the database', () => {
    assert.match(meter, /claim_bookings_for_metering/);
    assert.match(meter, /settle_booking_metering/);
    assert.match(meter, /identifier AND Idempotency-Key = attempt id/);
  });

  test('nothing in this change writes a metering column directly', () => {
    // The repair must not fake progress by stamping metered_at.
    assert.ok(!/metered_at\s*[:=]/.test(meterBlock), 'the runner stamps metering state itself');
    assert.ok(!/metering_state\s*[:=]/.test(meterBlock));
  });
});

/* ── 4. Health still judges from the data ─────────────────────────────────── */

describe('the health check remains the backstop', () => {
  test('it reads booking state rather than the scheduler', () => {
    assert.match(health, /from public\.book_bookings b/);
    assert.match(health, /metering_state in \('pending', 'reporting', 'unresolved'\)/);
  });

  test('it counts pro and premium, and excludes cancelled', () => {
    assert.match(health, /lb\.subscription_tier in \('pro', 'premium'\)/);
    assert.match(health, /b\.status <> 'cancelled'/);
  });

  test('a Pro business with no subscription is called out separately, not as a stopped meter', () => {
    assert.match(health, /lb\.subscription_tier = 'pro' and lb\.stripe_subscription_id is null\) as unbillable/);
  });

  test('six hours of chances before anything is called late', () => {
    assert.match(health, /created_at < now\(\) - interval '6 hours'/);
  });

  test('it is not callable by client roles', () => {
    // The grants were set where the function was introduced; the reclaim-window
    // migration only replaces the body.
    const origin = read('supabase/migrations/20260821160000_metering_backlog_health.sql');
    assert.match(origin, /revoke all on function public\.metering_backlog_health\(\) from public/);
  });
});

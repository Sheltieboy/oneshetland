/**
 * booking-metering.node.test.ts — one booking, at most one Stripe charge.
 *
 * WHAT WAS WRONG
 *
 * meter-bookings reported a month's backlog as a single Stripe event and then
 * stamped metered_at. Nothing durable sat between those two steps, so two
 * overlapping reminder-runner passes could both report the same bookings.
 *
 * Step 10 recorded the Billing Meter path as "appears retry-safe" because it
 * sent a deterministic identifier. Stripe's own documentation says otherwise:
 * "Stripe enforces uniqueness within a rolling period of at least 24 hours."
 * The old identifier was `bk-{business}-{month}-{already_billed}`, and
 * already_billed only moves once stamping succeeds, which gave two failures:
 *
 *   Quantity drift — report 5, crash before stamping, two more bookings arrive,
 *   retry. Same identifier, payload now 7. Stripe drops the duplicate and the
 *   code stamps all seven. Two bookings billed to nobody.
 *
 *   Window expiry — past ~24h the identifier is accepted again, so a delayed
 *   retry bills twice.
 *
 * The legacy usage-record path had no protection at all: a bare increment.
 *
 * And separately, worse: anon and authenticated held UPDATE on book_bookings
 * including metered_at. RLS filters rows, not columns, and the UPDATE policy
 * covers every booking of a business you own — so a Pro business could stamp
 * its own bookings as metered and never be billed. Verified against production
 * before the fix.
 *
 * WHAT IS ASSERTED
 *   · the response classifier separates refusal from ambiguity, in both
 *     directions, including the cases the real API will not produce on demand
 *   · both Stripe generations carry the attempt id, and quantity is always 1,
 *     so a payload cannot drift between attempts
 *   · two concurrent workers on two real connections never claim the same
 *     booking, and together never exceed the monthly cap
 *   · a definite failure returns the booking to the queue KEEPING its identity
 *   · an ambiguous outcome is never recorded as success
 *   · terminal states never reopen; a foreign attempt id cannot settle
 *   · Premium is marked, never billed, and terminally so
 *   · no client role can write any metering column
 *   · the health check separates a stopped pipeline from a dead worker from an
 *     ambiguous outcome that needs a person
 *
 * SAFETY
 * No real Stripe call is made anywhere in this file. The provider boundary is
 * tested as pure functions. Database tests use a rolled-back transaction except
 * the concurrency one, which cannot be — proving two connections contend needs
 * rows both can see — so it builds an INACTIVE fixture business and removes it
 * in after(). The eight real bookings are never touched.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyStripeResponse, buildUsageRequest } from '../functions/_shared/stripe-usage.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_SLUG = 's11-metering-test';
const CAP = 17;

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

function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) throw new Error(`db query error: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return parsed.rows ?? [];
}
function runSql(sql: string): Record<string, unknown>[] {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  return rowsOf(out);
}
/** A separate process, and therefore a separate database connection. */
async function runSqlAsync(sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return rowsOf(stdout);
}
const one = (sql: string) => runSql(sql)[0] ?? {};

// ── 1. The provider boundary, as pure logic ─────────────────────────────────

describe('a Stripe response is classified, not guessed at', () => {
  test('success is success', () => {
    for (const s of [200, 201, 202]) {
      assert.equal(classifyStripeResponse(s).settlement, 'reported', `HTTP ${s}`);
    }
  });

  test('a definite refusal is retryable as the SAME event, not lost', () => {
    // 4xx means nothing was billed. Safe to return to the queue.
    for (const s of [400, 401, 402, 403, 404, 422]) {
      assert.equal(classifyStripeResponse(s, 'resource_missing').settlement, 'failed', `HTTP ${s}`);
    }
  });

  test('no response at all is AMBIGUOUS, never failure', () => {
    // The request may have arrived and been applied. Treating this as failure
    // is how a retry becomes a second charge.
    const r = classifyStripeResponse(null, 'TimeoutError');
    assert.equal(r.settlement, 'unresolved');
    assert.equal(r.error, 'TimeoutError');
  });

  test("Stripe's own errors are ambiguous, because execution may have begun", () => {
    for (const s of [500, 502, 503, 504, 429]) {
      assert.equal(classifyStripeResponse(s).settlement, 'unresolved', `HTTP ${s}`);
    }
  });

  test('an idempotency conflict is ambiguous', () => {
    // 409: a request with this key is still in flight. Its outcome is unknown.
    assert.equal(classifyStripeResponse(409).settlement, 'unresolved');
  });

  test('no status is ever silently treated as success', () => {
    const settlements = [null, 400, 402, 409, 429, 500, 503]
      .map((s) => classifyStripeResponse(s as number | null).settlement);
    assert.ok(!settlements.includes('reported'), 'a non-2xx response was classified as reported');
  });
});

// ── 2. Both Stripe generations ──────────────────────────────────────────────

describe('both billing generations carry the same identity', () => {
  const ATTEMPT = '11111111-2222-3333-4444-555555555555';

  test('Billing Meter: identifier AND idempotency key are the attempt id', () => {
    const r = buildUsageRequest({
      attemptId: ATTEMPT, meterEventName: 'booking',
      subscriptionItemId: null, stripeCustomerId: 'cus_TEST',
    });
    assert.equal(r.path, 'billing/meter_events');
    assert.equal(r.params.identifier, ATTEMPT, 'the meter event identifier must be the stable attempt id');
    assert.equal(r.idempotencyKey, ATTEMPT);
    assert.equal(r.params['payload[value]'], '1',
      'quantity must always be 1 — a varying payload is what let a retry be silently dropped');
  });

  test('legacy usage record: idempotency key is the attempt id', () => {
    // This path has no identifier field at all, which is exactly why it was
    // unprotected before: the header is the only defence available.
    const r = buildUsageRequest({
      attemptId: ATTEMPT, meterEventName: null,
      subscriptionItemId: 'si_TEST', stripeCustomerId: 'cus_TEST',
    });
    assert.equal(r.path, 'subscription_items/si_TEST/usage_records');
    assert.equal(r.idempotencyKey, ATTEMPT);
    assert.equal(r.params.quantity, '1');
    assert.equal(r.params.action, 'increment');
  });

  test('the same booking produces a byte-identical request every time', () => {
    // A retry must not manufacture a new external identity.
    const build = () => buildUsageRequest({
      attemptId: ATTEMPT, meterEventName: 'booking',
      subscriptionItemId: null, stripeCustomerId: 'cus_TEST',
    });
    assert.deepEqual(build(), build());
  });

  test('two different bookings produce two different identities', () => {
    const a = buildUsageRequest({ attemptId: 'aaaa', meterEventName: 'booking', subscriptionItemId: null, stripeCustomerId: 'cus_X' });
    const b = buildUsageRequest({ attemptId: 'bbbb', meterEventName: 'booking', subscriptionItemId: null, stripeCustomerId: 'cus_X' });
    assert.notEqual(a.params.identifier, b.params.identifier);
    assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  });
});

// ── 3. The claim, on real connections — MOVED ───────────────────────────────
//
// This whole section committed to PRODUCTION: it created a business, a service
// and 20 bookings under a REAL owner's profile, then removed them in an after()
// hook. Two of its tests also raced two committed connections. An interrupted
// run left a whole fake business, with bookings, attached to a real account —
// the same failure mode that left fabricated money on a customer's wallet on
// 2026-09-08.
//
// All nine tests are unchanged and now live in the isolated lane, where the
// business, the owner and the bookings are invented and the cluster is
// destroyed in a finally:
//
//     supabase/tests/production-concurrency-proofs.node.test.ts
//     (npm run test:isolated)

// ── 4. Premium ──────────────────────────────────────────────────────────────

describe('Premium is marked, never billed', () => {
  test('skipping is terminal, so a later tier change cannot bill it', () => {
    // Never committed: the transaction is left open and the disconnect rolls it
    // back, so the real Premium booking is put back exactly as it was.
    const r = one(`
      begin;
      create temp table t as
        select b.id, b.business_id from public.book_bookings b
        join public.local_businesses lb on lb.id = b.business_id
        where lb.subscription_tier = 'premium' limit 1;
      update public.book_bookings set metering_state='pending', metered_at=null
       where id = (select id from t);
      select public.skip_bookings_for_metering((select business_id from t)) as skipped;
      create temp table after_skip as
        select metering_state, (metered_at is not null) as stamped
          from public.book_bookings where id = (select id from t);
      create temp table claimable as
        select count(*)::int as n from public.claim_bookings_for_metering(
          (select business_id from t), date_trunc('month', now()), 17);
      select (select metering_state from after_skip) as state,
             (select stamped::text from after_skip)   as stamped,
             (select n::text from claimable)          as claimable_after;`);
    assert.equal(r.state, 'skipped');
    assert.equal(r.stamped, 'true', 'a skipped booking should still be marked processed');
    assert.equal(r.claimable_after, '0', 'a skipped booking could still be claimed for billing');
  });
});

// ── 5. Nobody outside the server can touch billing state ────────────────────

describe('billing state is not client-writable', () => {
  test('no client role can write any metering column', () => {
    const cols = ['metered_at', 'metering_state', 'metering_attempt_id', 'metering_claimed_at', 'metering_reported_at'];
    const checks = cols.flatMap((c) => ['anon', 'authenticated'].map((r) =>
      `select '${r}' as role_name, '${c}' as col, has_column_privilege('${r}','public.book_bookings','${c}','UPDATE')::text as can_write`))
      .join(' union all ');
    const leaked = runSql(`${checks};`).filter((r) => r.can_write === 'true');
    assert.deepEqual(leaked, [],
      `client roles can write billing state: ${leaked.map((l) => `${l.role_name}.${l.col}`).join(', ')}`);
  });

  test('customers can still book and cancel', () => {
    // The column whitelist must not have taken away what the app legitimately does.
    const r = one(`select
      has_column_privilege('authenticated','public.book_bookings','status','UPDATE')::text       as cancel,
      has_column_privilege('authenticated','public.book_bookings','cancelled_at','UPDATE')::text as cancelled_at,
      has_column_privilege('authenticated','public.book_bookings','starts_at','INSERT')::text    as book,
      has_column_privilege('authenticated','public.book_bookings','price_pence','INSERT')::text  as price;`);
    for (const [k, v] of Object.entries(r)) {
      assert.equal(v, 'true', `authenticated lost ${k} — the booking flow would break`);
    }
  });

  test('the metering RPCs are service-role only', () => {
    const fns = ['claim_bookings_for_metering', 'settle_booking_metering',
                 'skip_bookings_for_metering', 'reclaim_unresolved_metering', 'metering_backlog_health'];
    const rows = runSql(`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE')::text  as svc_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname in (${fns.map((f) => `'${f}'`).join(',')})
       order by 1;`);
    assert.equal(rows.length, fns.length, `expected ${fns.length} metering functions, found ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.anon_exec, 'false', `anon can execute ${r.fn}`);
      assert.equal(r.auth_exec, 'false', `authenticated can execute ${r.fn}`);
      assert.equal(r.svc_exec, 'true', `service_role cannot execute ${r.fn}`);
    }
  });
});

// ── 6. The function's own caller boundary ───────────────────────────────────

describe('meter-bookings refuses ordinary callers', () => {
  test('the anon key alone is rejected', { skip: cfg ? false : 'no local Supabase config' }, async () => {
    // verify_jwt=true accepts the anon key as a JWT — it is one — so the
    // handler's own service-role check is the real boundary.
    const { url, anonKey } = cfg!;
    const res = await fetch(`${url}/functions/v1/meter-bookings`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403, 'the anon key reached the billing meter');
    const body = await res.json().catch(() => ({}));
    assert.equal((body as { error?: string }).error, 'Forbidden');
  });

  test('no credentials at all is rejected', { skip: cfg ? false : 'no local Supabase config' }, async () => {
    const { url } = cfg!;
    const res = await fetch(`${url}/functions/v1/meter-bookings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.ok(res.status === 401 || res.status === 403, `unauthenticated call returned ${res.status}`);
  });

  test('the function takes no financial input from its caller', () => {
    // Every amount, recipient, month and identity is derived server-side.
    const src = readFileSync(join(REPO_ROOT, 'supabase/functions/meter-bookings/index.ts'), 'utf8');
    const body = src.slice(src.indexOf('serve(async (req)'));
    for (const [label, re] of [
      ['reads the request body', /req\.json\(\)/],
      ['reads query parameters', /searchParams/],
    ] as const) {
      assert.ok(!re.test(body), `meter-bookings ${label} — billing input must come only from the database`);
    }
  });
});

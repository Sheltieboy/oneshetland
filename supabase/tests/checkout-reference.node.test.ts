/**
 * checkout-reference.node.test.ts — the ticket checkout reference, and what a
 * buyer is told when a checkout fails.
 *
 * WHAT WAS WRONG
 *
 * MOBILE: the card path called purchaseTickets WITHOUT client_request_id while
 * the wallet path sent it, so the server saw no checkout reference and answered
 * "Invalid checkout reference" — implementation vocabulary, shown to a buyer.
 *
 * WEB: a different fault entirely, hidden behind identical wording. The web
 * always sent a valid reference; its three failed attempts are in the database
 * with 36-character references and no PaymentIntent, which puts the failure in
 * the Stripe call. Stripe's refusal hit the catch-all from Step 14 and came back
 * as the fixed sentence "Something went wrong. Please try again." — the same
 * message for a declined card, an organiser who cannot be paid, and a genuine
 * bug.
 *
 * Step 14 was right that raw provider text must not reach a caller. The mistake
 * was letting "do not forward the provider's words" become "say nothing".
 *
 * WHAT IS ASSERTED
 *   · both clients send a reference, and it is stable across retries of one
 *     basket and replaced when the basket changes
 *   · the server still refuses a missing or malformed one, before it reserves
 *     anything
 *   · a Stripe refusal is a named outcome with a reason, not the generic line
 *   · the generic line is still what an unexpected exception gets
 *   · no provider message, id or key reaches a caller
 *
 * SAFETY
 * Source inspection plus read-only SQL. No Stripe call, no payment, no
 * production row.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const one = (sql: string) => (rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }))[0] ?? {});

// ── 1. Both clients send a reference ───────────────────────────────────────

describe('every purchase path sends a checkout reference', () => {
  test('mobile sends it on the card path as well as the wallet path', () => {
    const src = read('app/event-ticket-checkout.tsx');
    const calls = [...src.matchAll(/purchaseTickets\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    assert.ok(calls.length >= 2, 'expected a card path and a wallet path');
    for (const call of calls) {
      assert.match(call, /client_request_id: attemptId\(\)/,
        'a purchase call without a reference is refused by the server');
    }
  });

  test('web sends it from the component that owns the basket', () => {
    const modal = readWeb('components/events/TicketModal.tsx');
    assert.match(modal, /clientRequestId: attemptId\(\)/);
    assert.match(modal, /newCheckoutAttemptId/);
  });

  test('neither client mints one inside the low-level helper', () => {
    // A fresh id per HTTP call would give every retry a new key and remove the
    // protection entirely — which is why both generate in the component.
    assert.ok(!/newCheckoutAttemptId/.test(read('lib/events-api.ts')));
    assert.ok(!/newCheckoutAttemptId/.test(readWeb('lib/events-client.ts')));
  });

  test('the id is stable per basket and replaced when the basket changes', () => {
    for (const [src, dep] of [[read('app/event-ticket-checkout.tsx'), 'quantities'],
                              [readWeb('components/events/TicketModal.tsx'), 'qty']] as const) {
      assert.match(src, /attemptRef\.current \?\?= newCheckoutAttemptId\(\)/,
        'retries of the same basket must reuse the same id');
      assert.match(src, new RegExp(`attemptRef\\.current = null;? \\}, \\[${dep}\\]`),
        'a different basket is a different purchase and needs a new id');
    }
  });

  test('a completed purchase releases the id for the next deliberate one', () => {
    assert.match(readWeb('components/events/TicketModal.tsx'), /attemptRef\.current = null;/);
  });
});

// ── 2. The server contract ─────────────────────────────────────────────────

describe('the server still enforces the reference', () => {
  const fn = () => read('supabase/functions/create-event-ticket-intent/index.ts');

  test('missing or malformed is refused', () => {
    const src = fn();
    assert.match(src, /typeof client_request_id !== 'string'/);
    assert.match(src, /client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    assert.match(src, /Invalid checkout reference/);
  });

  test('the refusal happens before anything is reserved', () => {
    const src = fn();
    // Compare against the actual RPC call, not the first mention — the function
    // is described in a header comment long before it is invoked.
    assert.ok(src.indexOf('Invalid checkout reference') < src.indexOf("supabase.rpc('reserve_ticket_basket'"),
      'a refused checkout must leave no order, no tickets and no held capacity');
  });

  test('the Stripe idempotency key is still derived from the order', () => {
    assert.match(fn(), /`evt-order-\$\{order\.id\}`/,
      'a retried create must return the ORIGINAL PaymentIntent, not a second charge');
  });

  test('the reference is still recorded against the reservation', () => {
    assert.match(fn(), /p_client_request_id:\s+client_request_id/);
  });
});

// ── 3. A refusal is named, not hidden ──────────────────────────────────────

describe('a Stripe refusal says what happened', () => {
  const helper = () => read('supabase/functions/_shared/stripe-errors.ts');

  test('the Stripe call throws a typed error rather than a bare one', () => {
    const src = read('supabase/functions/create-event-ticket-intent/index.ts');
    assert.match(src, /throw stripeError\(res\.status, json\)/);
    assert.ok(!/throw new Error\(json\.error\?\.message/.test(src),
      'the provider message must not become the thrown message');
  });

  test('known refusals map to wording a buyer can act on', () => {
    const src = helper();
    for (const reason of ['card_declined', 'card_expired', 'insufficient_funds',
                          'authentication_required', 'organiser_payout', 'amount_invalid']) {
      assert.match(src, new RegExp(reason), `${reason} is not classified`);
    }
    assert.match(src, /Your card was declined/);
    assert.match(src, /isn’t able to receive payments yet/);
  });

  test('the provider message is logged, never returned', () => {
    const src = helper();
    const returned = src.slice(src.indexOf('return { status: 402'));
    assert.ok(!returned.includes('err.message'), 'Stripe’s own text must not reach a caller');
    assert.match(src, /console\.error\(`\[\$\{scope\}\] stripe refused/, 'but an operator must be able to read it');
  });

  test('an unexpected exception still gets the generic line', () => {
    const src = read('supabase/functions/create-event-ticket-intent/index.ts');
    assert.match(src, /checkoutFailure\('create-event-ticket-intent', err\)/);
    assert.match(src, /safeError\('create-event-ticket-intent', err\)/,
      'anything that is not a Stripe refusal is a bug, and its text is not for a buyer');
    assert.ok(src.indexOf('checkoutFailure') < src.indexOf('safeError('),
      'the named case must be tried before the generic one');
  });
});

// ── 4. What the buyer reads ────────────────────────────────────────────────

describe('both clients phrase failures the same way', () => {
  test('each client has the mapping and uses it', () => {
    for (const [p, src] of [['mobile', read('lib/checkout-errors.ts')],
                            ['web', readWeb('lib/checkout-errors.ts')]] as const) {
      assert.match(src, /Invalid checkout reference/, `${p} does not rephrase the reference error`);
      assert.match(src, /close this ticket window/, `${p} shows implementation vocabulary`);
      assert.match(src, /Something went wrong/, `${p} has no generic fallback`);
    }
    assert.match(read('app/event-ticket-checkout.tsx'), /describeCheckoutError\(e\)/);
    assert.match(readWeb('components/events/TicketModal.tsx'), /describeCheckoutError\(e\)/);
  });

  test('the web carries reason and code through for support', () => {
    const src = readWeb('lib/events-client.ts');
    assert.match(src, /reason = b\?\.reason/);
    assert.match(src, /code = b\?\.code/);
  });

  test('no client displays a raw provider or database error', () => {
    // Only the wording a buyer actually sees — the file's own comments are free
    // to name Stripe, and the first version of this test failed on exactly that.
    for (const src of [read('lib/checkout-errors.ts'), readWeb('lib/checkout-errors.ts')]) {
      const shown = [...src.matchAll(/^\s*(?:"[^"]+":\s*)?["'“]([^"'”]{12,})["'”]/gm)].map((m) => m[1]);
      assert.ok(shown.length > 0, 'no user-facing strings found to check');
      for (const line of shown) {
        for (const leak of ['stripe', 'Stripe', 'pi_', 'acct_', 'SQLSTATE', 'client_request_id']) {
          assert.ok(!line.includes(leak), `buyer-facing wording must not mention ${leak}: "${line}"`);
        }
      }
    }
  });
});

// ── 5. The failed attempts left nothing that blocks a retest ───────────────

describe('a failed checkout does not block the next one', () => {
  test('pending orders hold no capacity on an unlimited ticket type, and expiry is scheduled', () => {
    const r = one(`
      select coalesce(t.quantity_available::text,'unlimited') as capacity,
             (select count(*)::text from cron.job where jobname='expire-stale-ticket-orders') as expiry_job
        from public.event_ticket_types t
        join public.events e on e.id = t.event_id
       where e.title ilike 'Live Band at Hamnavoe%' limit 1;`);
    assert.equal(r.expiry_job, '1', 'stale reservations must still be released automatically');
    assert.ok(r.capacity === 'unlimited' || Number(r.capacity) > 0);
  });
});

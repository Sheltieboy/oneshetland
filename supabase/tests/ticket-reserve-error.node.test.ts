/**
 * ticket-reserve-error.node.test.ts — the sentence create-event-ticket-intent shows when reserve_ticket_basket refuses.
 *
 * WHAT IS ASSERTED
 *   · MULTI_PERFORMANCE gets its own plain sentence (no jargon, no dialect), wherever it sits in the database message
 *   · every earlier mapping is byte-for-byte unchanged, including the generic fallback
 *   · the Edge Function still answers HTTP 409 for every refusal and routes through the helper
 *   · before the migration the string never occurs, so behaviour is the old behaviour
 * SAFETY: pure functions and source reads. No database, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveFailureText, MULTI_PERFORMANCE_TEXT } from '../functions/_shared/ticket-reserve-error.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN = readFileSync(join(ROOT, 'supabase/functions/create-event-ticket-intent/index.ts'), 'utf8');

describe('reserveFailureText', () => {
  test('MULTI_PERFORMANCE has a distinct, friendly sentence', () => {
    const t = reserveFailureText('MULTI_PERFORMANCE: this event has more than one performance');
    assert.equal(t, MULTI_PERFORMANCE_TEXT);
    assert.match(t, /several dates/); assert.match(t, /ticket link/); assert.match(t, /contact/);
    assert.doesNotMatch(t, /MULTI_PERFORMANCE|occurrence|performance|error|wee\b/i);
    assert.notEqual(t, reserveFailureText('anything else'));
  });
  test('it is recognised inside a longer message', () => {
    assert.equal(reserveFailureText('P0001: MULTI_PERFORMANCE: blah (code 22023)'), MULTI_PERFORMANCE_TEXT);
  });
  test('earlier mappings are byte-for-byte unchanged', () => {
    assert.equal(reserveFailureText('SOLD_OUT: x'), 'Some tickets are now sold out. Please refresh and try again.');
    assert.equal(reserveFailureText('CHECKOUT_EXPIRED'), 'This checkout has expired. Please start again.');
    assert.equal(reserveFailureText('IDEMPOTENCY_CONFLICT'), 'That checkout reference was already used for a different order. Please start again.');
    assert.equal(reserveFailureText(''), 'Those tickets are not available. Please refresh and try again.');
    assert.equal(reserveFailureText('deadlock detected'), 'Those tickets are not available. Please refresh and try again.');
  });
  test('without the new string (migration not applied) nothing changes', () => {
    for (const m of ['', 'SOLD_OUT', 'CHECKOUT_EXPIRED', 'IDEMPOTENCY_CONFLICT', 'permission denied', 'EVENT_NOT_FOUND']) {
      assert.notEqual(reserveFailureText(m), MULTI_PERFORMANCE_TEXT);
    }
  });
});

describe('create-event-ticket-intent wiring', () => {
  test('the refusal path uses the helper and stays a 409', () => {
    const i = FN.indexOf('reserveFailureText(msg)');
    assert.ok(i > 0, 'helper used');
    const tail = FN.slice(i, i + 400);
    assert.match(tail, /status: 409/);
    assert.match(FN, /import \{ reserveFailureText \} from '\.\.\/_shared\/ticket-reserve-error\.ts'/);
  });
  test('the inline ternary is gone (one source of wording)', () => {
    assert.doesNotMatch(FN, /msg\.includes\('SOLD_OUT'\)/);
  });
  test('the refusal happens before any Stripe or wallet call (fail-closed ordering)', () => {
    assert.ok(FN.indexOf("rpc('reserve_ticket_basket'") > 0);
    assert.ok(FN.indexOf("rpc('reserve_ticket_basket'") < FN.indexOf('reserveFailureText(msg)'));
    assert.ok(FN.indexOf('reserveFailureText(msg)') < FN.indexOf('debitAndTransfer('));
  });
});

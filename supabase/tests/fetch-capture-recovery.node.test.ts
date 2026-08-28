/**
 * fetch-capture-recovery.node.test.ts — a lost response is not a failure.
 *
 * capture-payment believed the HTTP result:
 *
 *     const captured = await captureRes.json();
 *     if (!captureRes.ok) throw new Error(`Capture failed: …`);
 *
 * A timeout, a 5xx or a dropped connection AFTER Stripe has taken the money
 * reads exactly like a refusal. The function threw a 500, the delivery was
 * never marked delivered, and the driver — standing on a doorstep with an
 * empty bag — tapped again. The only guard against that second tap was
 * `payment_status === 'captured'`, read then written with nothing holding the
 * gap.
 *
 * The race below runs against the real database. The Stripe reasoning is
 * proven structurally, because the alternative is taking real money twice to
 * see whether we take it twice.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const capture   = code(readFileSync(join(REPO_ROOT, 'supabase/functions/capture-payment/index.ts'), 'utf8'));
const authorise = code(readFileSync(join(REPO_ROOT, 'supabase/functions/authorise-payment/index.ts'), 'utf8'));
const cancelFn  = code(readFileSync(join(REPO_ROOT, 'supabase/functions/cancel-payment/index.ts'), 'utf8'));
const webhook   = code(readFileSync(join(REPO_ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8'));
const migration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260908120000_fetch_capture_state.sql'), 'utf8');

function env() {
  let url = '', anon = '';
  try {
    for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].endsWith('URL')) url = v; else anon = v;
    }
  } catch { return null; }
  let srk = '';
  try { srk = readFileSync(join(REPO_ROOT, 'service_key.txt'), 'utf8').trim(); } catch { return null; }
  return url && anon && srk ? { url, anon, srk } : null;
}
const cfg = env();
const api = async (path: string, key: string, init: RequestInit & { bearer?: string; prefer?: string } = {}) => {
  const res = await fetch(`${cfg!.url}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${init.bearer ?? key}`, 'Content-Type': 'application/json',
               ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const rpc = (fn: string, args: unknown, key = cfg!.srk, bearer?: string) =>
  api(`/rest/v1/rpc/${fn}`, key, { method: 'POST', body: JSON.stringify(args), bearer });

let customer = '', tokCustomer = '', driver = '', reqId = '';

before(async () => {
  if (!cfg) return;
  const mk = async () => {
    const email = `fetchcap-${Math.random().toString(16).slice(2, 10)}@probe.invalid`;
    const password = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    const made = await api('/auth/v1/admin/users', cfg!.srk, { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
    const tok = await api('/auth/v1/token?grant_type=password', cfg!.anon, { method: 'POST', body: JSON.stringify({ email, password }) });
    return { id: made.body.id as string, token: tok.body.access_token as string };
  };
  const c = await mk(); customer = c.id; tokCustomer = c.token;
  const d = await mk(); driver = d.id;
  const made = await api('/rest/v1/delivery_requests', cfg.anon, {
    method: 'POST', bearer: tokCustomer, prefer: 'return=representation',
    body: JSON.stringify({
      customer_id: customer, category_slug: 'shopping', pickup_name: 'PROBE',
      pickup_location: 'PROBE — delete me, Lerwick', destination_address: 'PROBE — delete me, Scalloway',
      destination_area: 'Scalloway', liability_acknowledged: true, status: 'pending',
    }),
  });
  reqId = made.body?.[0]?.id ?? '';
  if (reqId) {
    await rpc('claim_fetch_authorisation', { p_request: reqId, p_customer: customer, p_driver: driver, p_amount: 550 });
    await rpc('settle_fetch_authorisation', { p_request: reqId, p_status: 'authorised', p_pi: `pi_probe_cap_${reqId.slice(0, 8)}` });
  }
});

after(async () => {
  if (!cfg) return;
  if (reqId) {
    await api(`/rest/v1/fetch_authorisation_attempts?delivery_request_id=eq.${reqId}`, cfg.srk, { method: 'DELETE' });
    await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg.srk, { method: 'DELETE' });
  }
  for (const u of [customer, driver]) if (u) await api(`/auth/v1/admin/users/${u}`, cfg.srk, { method: 'DELETE' });
});

/* ── 1. the race, for real ────────────────────────────────────────────────── */
describe('twenty taps on Deliver take the money once', () => {
  test('exactly one caller may reach Stripe', { skip: !cfg }, async () => {
    assert.ok(reqId, 'the probe fixture was not created');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rpc('claim_fetch_capture', { p_request: reqId, p_driver: driver, p_amount: 550 })),
    );
    const outcomes = results.map((r) => (Array.isArray(r.body) ? r.body[0]?.outcome : r.body?.outcome));
    assert.equal(outcomes.filter((o) => o === 'claimed').length, 1,
      `${outcomes.filter((o) => o === 'claimed').length} callers were allowed to capture`);
    for (const o of outcomes.filter((x) => x !== 'claimed')) {
      assert.ok(['in_flight', 'already_captured'].includes(o), `unexpected outcome ${o}`);
    }
  });

  test('a driver who is not the assigned one is refused', { skip: !cfg }, async () => {
    const r = await rpc('claim_fetch_capture', { p_request: reqId, p_driver: customer, p_amount: 550 });
    assert.equal(Array.isArray(r.body) ? r.body[0]?.outcome : r.body?.outcome, 'wrong_driver');
  });

  test('once captured, a further tap is an idempotent success', { skip: !cfg }, async () => {
    await rpc('settle_fetch_capture', { p_request: reqId, p_state: 'captured', p_amount: 550 });
    const again = await rpc('claim_fetch_capture', { p_request: reqId, p_driver: driver, p_amount: 550 });
    assert.equal(Array.isArray(again.body) ? again.body[0]?.outcome : again.body?.outcome, 'already_captured');
  });

  test('and the attempt records when and how much', { skip: !cfg }, async () => {
    const row = await api(`/rest/v1/fetch_authorisation_attempts?delivery_request_id=eq.${reqId}&select=capture_state,capture_amount_pence,captured_at,status,completion_requested_at`, cfg!.srk);
    assert.equal(row.body[0].capture_state, 'captured');
    assert.equal(row.body[0].capture_amount_pence, 550);
    assert.ok(row.body[0].captured_at, 'no capture timestamp');
    assert.ok(row.body[0].completion_requested_at, 'the driver’s completion request was not recorded');
    assert.equal(row.body[0].status, 'captured');
  });

  test('the registry stays server-only', { skip: !cfg }, async () => {
    const r = await rpc('claim_fetch_capture', { p_request: reqId, p_driver: driver, p_amount: 1 }, cfg!.anon, tokCustomer);
    assert.ok(r.status >= 400, `a client claimed a capture (HTTP ${r.status})`);
    const w = await rpc('settle_fetch_capture', { p_request: reqId, p_state: 'captured' }, cfg!.anon, tokCustomer);
    assert.ok(w.status >= 400, `a client settled a capture (HTTP ${w.status})`);
  });
});

/* ── 2. Stripe is asked before anything is taken ──────────────────────────── */
describe('the stored word "authorised" is not evidence', () => {
  test('the intent is retrieved before capture is attempted', () => {
    const read = capture.indexOf('const before = await readIntent');
    const cap  = capture.indexOf('/capture`');
    assert.ok(read > 0 && read < cap, 'capture is attempted before Stripe is asked anything');
  });

  test('an already-succeeded intent is recovered, never captured again', () => {
    const block = capture.slice(capture.indexOf("if (before.status === 'succeeded')"), capture.indexOf("if (before.status === 'canceled')"));
    assert.match(block, /recovered: true/);
    assert.ok(!/\/capture`/.test(block), 'a succeeded intent is captured a second time');
  });

  test('a canceled intent is terminal, with no capture call', () => {
    const block = capture.slice(capture.indexOf("if (before.status === 'canceled')"), capture.indexOf("if (before.status !== 'requires_capture')"));
    assert.match(block, /TERMINAL/);
    assert.ok(!/\/capture`/.test(block));
  });

  test('anything that is not requires_capture fails closed', () => {
    assert.match(capture, /if \(before\.status !== 'requires_capture'\)/);
    assert.match(capture, /NOT_AUTHORISED/);
  });

  test('the intent comes from the authorisation registry, not the row alone', () => {
    assert.match(capture, /const paymentIntentId = claim\.stripe_payment_intent_id;/);
    assert.match(capture, /request\.payment_intent_id !== paymentIntentId/);
  });
});

/* ── 3. the lost response ─────────────────────────────────────────────────── */
describe('an unknown outcome is asked about, not assumed', () => {
  test('a throw or a bad status is ambiguous, not failed', () => {
    assert.match(capture, /let ambiguous = false;/);
    assert.match(capture, /catch \(_e\) \{[\s\S]{0,200}ambiguous = true;/);
    assert.ok(!/if \(!captureRes\.ok\) \{\s*throw new Error\(`Capture failed/.test(capture),
      'a non-ok response is still thrown as a failure');
  });

  test('and Stripe is re-read to find out what happened', () => {
    const block = capture.slice(capture.indexOf('if (ambiguous) {'));
    assert.match(block, /const after = await readIntent/);
    assert.match(block, /after\.status === 'succeeded'[\s\S]{0,200}recovered: true/);
  });

  test('a genuine non-capture is retryable under the same key', () => {
    const block = capture.slice(capture.indexOf('if (ambiguous) {'));
    assert.match(block, /after\.status === 'requires_capture'/);
    assert.match(block, /code: 'RETRY'/);
  });

  test('anything else is unresolved, and says so honestly', () => {
    assert.match(capture, /p_state: 'unresolved'/);
    assert.match(capture, /don't retry repeatedly/);
    assert.ok(!/raw Stripe|error\.message\}`\}\)/.test(capture.slice(capture.indexOf('UNRESOLVED'))), 'a raw Stripe error is shown');
  });

  test('failed and unresolved are kept apart', () => {
    assert.match(migration, /capture_state in \('none', 'in_flight', 'captured', 'failed', 'unresolved'\)/);
    assert.match(migration, /capture_last_error/);
  });

  test('a clean HTTP result is still checked for succeeded', () => {
    assert.match(capture, /if \(captured\.status !== 'succeeded'\)/);
  });
});

/* ── 4. the key ───────────────────────────────────────────────────────────── */
describe('the capture key is stable', () => {
  test('it is derived from the delivery alone', () => {
    assert.match(capture, /'Idempotency-Key': `fetch-capture-\$\{request_id\}`/);
  });

  test('with nothing random or time-based near it', () => {
    const line = capture.slice(capture.indexOf("'Idempotency-Key'"), capture.indexOf("'Idempotency-Key'") + 120);
    assert.ok(!/Date\.now|Math\.random|randomUUID|crypto\./.test(line));
  });

  test('and it differs from the authorisation key for the same delivery', () => {
    assert.match(authorise, /`fetch-auth-\$\{request_id\}`/);
    assert.notEqual('fetch-capture-x', 'fetch-auth-x');
  });

  test('in-flight is recorded before Stripe is called', () => {
    const claim = capture.indexOf("rpc('claim_fetch_capture'");
    const cap   = capture.indexOf('/capture`');
    assert.ok(claim > 0 && claim < cap, 'the claim is taken after the Stripe call');
    assert.match(migration, /capture_state\s*=\s*'in_flight'/);
    assert.match(migration, /capture_started_at\s*=\s*now\(\)/);
  });
});

/* ── 5. delivered is a thing a driver does ────────────────────────────────── */
describe('Stripe cannot deliver a parcel', () => {
  test('the driver’s completion request is recorded separately', () => {
    assert.match(migration, /completion_requested_at/);
    assert.match(migration, /Stripe saying a payment succeeded is not evidence/);
  });

  test('delivered is written on that request, not by the webhook', () => {
    assert.match(capture, /status: 'delivered'/);
    const succeeded = webhook.slice(webhook.indexOf("case 'payment_intent.succeeded'"), webhook.indexOf("case 'transfer.created'"));
    const fetchBit = succeeded.slice(0, succeeded.indexOf('local_boost'));
    assert.ok(!/status: 'delivered'/.test(fetchBit), 'the webhook marks deliveries delivered');
    assert.match(fetchBit, /payment_status: 'captured'/);
  });

  test('the webhook is idempotent and cannot start a capture', () => {
    const succeeded = webhook.slice(webhook.indexOf("case 'payment_intent.succeeded'"), webhook.indexOf("case 'transfer.created'"));
    assert.ok(!/claim_fetch_capture|\/capture`/.test(succeeded), 'the webhook can initiate a capture');
    assert.match(webhook, /claim_stripe_event/);
  });

  test('an already-captured delivery converges without another Stripe call', () => {
    const block = capture.slice(capture.indexOf("claim?.outcome === 'already_captured'"), capture.indexOf("claim?.outcome === 'in_flight'"));
    assert.match(block, /payment_status: 'captured', status: 'delivered'/);
    assert.match(block, /already completed/);
    assert.ok(!/\/capture`/.test(block));
  });
});

/* ── 6. the waiting fee against the hold ──────────────────────────────────── */
describe('the capture cannot exceed what is held', () => {
  test('the hold includes the waiting fee that does not exist yet', () => {
    // The waiting fee is MEASURED after the driver arrives, long after the
    // hold is placed. Holding only base + service meant capture could be asked
    // for up to the configured cap MORE than was authorised — and a confirmed
    // card intent cannot be captured above its authorisation, so the driver
    // simply lost the difference. The hold now covers the worst case and
    // capture takes only what is owed.
    assert.match(authorise, /amount: String\(baseFeePence \+ serviceFeePence \+ waitingHeadroom\)/);
    assert.match(authorise, /wait_max_pence/);
    assert.match(capture, /const totalPence = \(request\.base_fee_pence \?\? 0\) \+ serviceFeePence \+ Number\(waitingPence \?\? 0\)/);
  });

  test('and capture is still clamped, so it can never exceed the hold', { skip: !cfg }, async () => {
    const cfgRow = await api('/rest/v1/delivery_pricing_config?select=wait_max_pence', cfg!.srk);
    const cap = cfgRow.body[0].wait_max_pence;
    assert.ok(cap > 0, 'the waiting cap is zero, so there would be nothing to clamp');
    // Belt and braces. The hold now covers the cap, so the clamp should never
    // bite — but an older intent authorised before this change would still be
    // short, and capturing above a hold must remain impossible either way.
    assert.match(capture, /const captureAmount = Math\.min\(totalPence, capturable\)/);
    assert.match(capture, /does not fit inside the authorisation/);
  });

  test('and never over-captures', () => {
    assert.ok(!/amount_to_capture: String\(totalPence\)/.test(capture), 'the full total is captured regardless of the hold');
    assert.match(capture, /amount_to_capture: String\(captureAmount\)/);
  });
});

/* ── 7. nothing earlier was loosened ──────────────────────────────────────── */
describe('Fixes 1–3 are intact', () => {
  test('the driver is still proven before anything happens', () => {
    assert.match(capture, /run\.driver_id !== user\.id/);
  });
  test('no amount or intent comes from the request body', () => {
    assert.ok(!/body\.amount|body\.payment_intent|amount_to_capture: String\(body/.test(capture));
  });
  test('one delivery still owns one authorisation', () => {
    assert.match(authorise, /claim_fetch_authorisation/);
    assert.match(authorise, /'Idempotency-Key': `fetch-auth-\$\{request_id\}`/);
  });
  test('cancellation still refuses to void a captured payment', () => {
    assert.match(cancelFn, /pi\.status === 'succeeded'/);
    assert.match(cancelFn, /already been taken/);
  });
});

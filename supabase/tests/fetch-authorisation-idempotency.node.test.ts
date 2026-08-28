/**
 * fetch-authorisation-idempotency.node.test.ts — one delivery, one hold.
 *
 * authorise-payment decided whether to create a PaymentIntent by reading a
 * column and finding it empty:
 *
 *     if (request.payment_intent_id && request.payment_status === 'authorised')
 *       return already_authorised
 *     … create the PaymentIntent …
 *     .update({ payment_intent_id: pi.id })
 *
 * A read, a decision, then a write, with nothing holding the gap. Two
 * concurrent accepts both read null, both created a manual-capture intent, and
 * the customer got TWO holds on their card. The second id overwrote the first,
 * so the first was orphaned — nothing pointed at it, so nothing would ever
 * capture or cancel it, and it sat on the card until Stripe expired it.
 *
 * The race below is run against the real database with twenty simultaneous
 * claims, because a sequential proof would not have caught the original bug
 * either.
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

const authorise = code(readFileSync(join(REPO_ROOT, 'supabase/functions/authorise-payment/index.ts'), 'utf8'));
const cancelFn  = code(readFileSync(join(REPO_ROOT, 'supabase/functions/cancel-payment/index.ts'), 'utf8'));
const continueFn = code(readFileSync(join(REPO_ROOT, 'supabase/functions/fetch-authorise/index.ts'), 'utf8'));
const migration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260907120000_fetch_authorisation_attempts.sql'), 'utf8');

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
    const email = `fetchidem-${Math.random().toString(16).slice(2, 10)}@probe.invalid`;
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
describe('twenty drivers accepting at once produce one hold', () => {
  test('exactly one caller is allowed to create', { skip: !cfg }, async () => {
    assert.ok(reqId, 'the probe request was not created');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpc('claim_fetch_authorisation', { p_request: reqId, p_customer: customer, p_driver: driver, p_amount: 550 })),
    );
    const outcomes = results.map((r) => (Array.isArray(r.body) ? r.body[0]?.outcome : r.body?.outcome));
    const claimed = outcomes.filter((o) => o === 'claimed');
    assert.equal(claimed.length, 1, `${claimed.length} callers were allowed to create a PaymentIntent`);
    // Everyone else is told to wait or resume — never to create.
    for (const o of outcomes.filter((x) => x !== 'claimed')) {
      assert.ok(['in_flight', 'resume', 'terminal', 'conflict'].includes(o), `unexpected outcome ${o}`);
    }
  });

  test('and the delivery owns exactly one attempt row', { skip: !cfg }, async () => {
    const rows = await api(`/rest/v1/fetch_authorisation_attempts?delivery_request_id=eq.${reqId}&select=delivery_request_id,status`, cfg!.srk);
    assert.equal(rows.body.length, 1, `${rows.body.length} attempts exist for one delivery`);
    assert.equal(rows.body[0].status, 'in_flight');
  });

  test('a different customer cannot take over the attempt', { skip: !cfg }, async () => {
    const r = await rpc('claim_fetch_authorisation', { p_request: reqId, p_customer: driver, p_driver: driver, p_amount: 550 });
    const outcome = Array.isArray(r.body) ? r.body[0]?.outcome : r.body?.outcome;
    assert.equal(outcome, 'conflict');
  });
});

/* ── 2. the intent is recorded, once, and resumed ─────────────────────────── */
describe('the PaymentIntent is remembered before anything can go wrong', () => {
  test('settling stores it and the claim then resumes', { skip: !cfg }, async () => {
    await rpc('settle_fetch_authorisation', { p_request: reqId, p_status: 'in_flight', p_pi: 'pi_probe_first' });
    const again = await rpc('claim_fetch_authorisation', { p_request: reqId, p_customer: customer, p_driver: driver, p_amount: 550 });
    const row = Array.isArray(again.body) ? again.body[0] : again.body;
    assert.equal(row.outcome, 'resume');
    assert.equal(row.stripe_payment_intent_id, 'pi_probe_first', 'a retry was pointed at a different intent');
  });

  test('a second, different intent is refused rather than orphaning the first', { skip: !cfg }, async () => {
    const clash = await rpc('settle_fetch_authorisation', { p_request: reqId, p_status: 'in_flight', p_pi: 'pi_probe_second' });
    assert.ok(clash.status >= 400, 'a second PaymentIntent was accepted for one delivery');
    const rows = await api(`/rest/v1/fetch_authorisation_attempts?delivery_request_id=eq.${reqId}&select=stripe_payment_intent_id`, cfg!.srk);
    assert.equal(rows.body[0].stripe_payment_intent_id, 'pi_probe_first');
  });

  test('settling without an id never erases the one we have', { skip: !cfg }, async () => {
    await rpc('settle_fetch_authorisation', { p_request: reqId, p_status: 'awaiting_customer' });
    const rows = await api(`/rest/v1/fetch_authorisation_attempts?delivery_request_id=eq.${reqId}&select=stripe_payment_intent_id,status`, cfg!.srk);
    assert.equal(rows.body[0].stripe_payment_intent_id, 'pi_probe_first', 'the intent id was wiped');
    assert.equal(rows.body[0].status, 'awaiting_customer');
  });

  test('the request row cannot be pointed at a different intent', { skip: !cfg }, async () => {
    const ok = await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg!.srk, {
      method: 'PATCH', body: JSON.stringify({ payment_intent_id: 'pi_probe_first' }),
    });
    assert.ok(ok.status < 400, 'the matching intent was refused');
    const clash = await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg!.srk, {
      method: 'PATCH', body: JSON.stringify({ payment_intent_id: 'pi_probe_elsewhere' }),
    });
    assert.ok(clash.status >= 400, 'a mismatched intent was written to the request');
  });
});

/* ── 3. cancellation is terminal ──────────────────────────────────────────── */
describe('a cancelled delivery cannot mint another hold', () => {
  test('retiring the attempt makes a further claim terminal', { skip: !cfg }, async () => {
    await rpc('settle_fetch_authorisation', { p_request: reqId, p_status: 'terminal', p_result: { cancelled: true } });
    const again = await rpc('claim_fetch_authorisation', { p_request: reqId, p_customer: customer, p_driver: driver, p_amount: 550 });
    const row = Array.isArray(again.body) ? again.body[0] : again.body;
    assert.equal(row.outcome, 'terminal', 'a cancelled delivery could start another authorisation');
  });

  test('cancel-payment retires it', () => {
    assert.match(cancelFn, /settle_fetch_authorisation/);
    assert.match(cancelFn, /p_status: 'terminal'/);
  });

  test('and authorise-payment refuses a terminal attempt', () => {
    assert.match(authorise, /claim\?\.outcome === 'terminal'/);
    assert.match(authorise, /ATTEMPT_TERMINAL/);
  });
});

/* ── 4. the registry is the server's alone ────────────────────────────────── */
describe('nobody signs in and edits the registry', () => {
  test('an authenticated caller cannot read it', { skip: !cfg }, async () => {
    const r = await api('/rest/v1/fetch_authorisation_attempts?select=delivery_request_id&limit=1', cfg!.anon, { bearer: tokCustomer });
    const empty = r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0);
    assert.ok(empty, 'the attempt registry is readable by clients');
  });

  test('nor write one', { skip: !cfg }, async () => {
    const r = await api('/rest/v1/fetch_authorisation_attempts', cfg!.anon, {
      method: 'POST', bearer: tokCustomer,
      body: JSON.stringify({ delivery_request_id: reqId, customer_id: customer, status: 'authorised' }),
    });
    assert.ok(r.status >= 400, `a client inserted an attempt (HTTP ${r.status})`);
  });

  test('nor call the claim RPC', { skip: !cfg }, async () => {
    const r = await rpc('claim_fetch_authorisation',
      { p_request: reqId, p_customer: customer, p_driver: driver, p_amount: 1 }, cfg!.anon, tokCustomer);
    assert.ok(r.status >= 400, `a client claimed an authorisation (HTTP ${r.status})`);
  });

  test('nor the settle RPC', { skip: !cfg }, async () => {
    const r = await rpc('settle_fetch_authorisation',
      { p_request: reqId, p_status: 'authorised' }, cfg!.anon, tokCustomer);
    assert.ok(r.status >= 400, `a client settled an authorisation (HTTP ${r.status})`);
  });

  test('the functions are pinned and service-role only', () => {
    assert.match(migration, /security definer set search_path = public/);
    assert.match(migration, /revoke execute on function public\.claim_fetch_authorisation[\s\S]{0,120}from anon, authenticated, public/);
    assert.match(migration, /grant  execute on function public\.claim_fetch_authorisation[\s\S]{0,120}to service_role/);
    assert.match(migration, /revoke all on public\.fetch_authorisation_attempts from anon, authenticated/);
  });
});

/* ── 5. the Stripe key is stable ──────────────────────────────────────────── */
describe('the Stripe idempotency key survives a lost response', () => {
  test('it is derived from the delivery, and only from the delivery', () => {
    assert.match(authorise, /'Idempotency-Key': `fetch-auth-\$\{request_id\}`/);
  });

  test('nothing random or time-based is anywhere near it', () => {
    const line = authorise.slice(authorise.indexOf("'Idempotency-Key'"), authorise.indexOf("'Idempotency-Key'") + 120);
    assert.ok(!/Date\.now|Math\.random|randomUUID|crypto\./.test(line), 'the key is not reproducible');
  });

  test('two deliveries cannot share a key', () => {
    const key = (id: string) => `fetch-auth-${id}`;
    assert.notEqual(key('a'), key('b'));
    assert.equal(key('a'), key('a'));
  });

  test('the intent is recorded before anything that can fail', () => {
    const created = authorise.indexOf('const pi = await piRes.json()');
    const recorded = authorise.indexOf("p_request: request_id, p_status: 'in_flight', p_pi: pi.id");
    const classify = authorise.indexOf('const outcome = classifyAuthorisation(pi.status)');
    assert.ok(recorded > created && recorded < classify, 'the intent id is stored too late to be recoverable');
  });
});

/* ── 6. retries read, they do not create ──────────────────────────────────── */
describe('every retry resumes the same intent', () => {
  test('a known intent is retrieved, never re-created', () => {
    assert.match(authorise, /claim\?\.outcome === 'resume' && claim\.stripe_payment_intent_id/);
    assert.match(authorise, /return await resumeExisting\(/);
    const resume = authorise.slice(authorise.indexOf('async function resumeExisting'));
    assert.ok(!/method: 'POST'[\s\S]{0,200}payment_intents/.test(resume), 'the resume path can create an intent');
  });

  test('resume reports the CURRENT state rather than a stored guess', () => {
    const resume = authorise.slice(authorise.indexOf('async function resumeExisting'));
    assert.match(resume, /classifyAuthorisation\(pi\.status\)/);
  });

  test('a claim still in flight is told to wait, not given a 500', () => {
    assert.match(authorise, /code: 'IN_FLIGHT'/);
    assert.match(authorise, /already being set up/);
  });

  test('an already-authorised delivery short-circuits', () => {
    assert.match(authorise, /already_authorised: true/);
  });

  test('the customer continuation still uses the stored intent only', () => {
    assert.match(continueFn, /request\.payment_intent_id/);
    assert.ok(!/method: 'POST'[\s\S]{0,200}payment_intents/.test(continueFn), 'the continuation can create an intent');
  });
});

/* ── 7. nothing earlier was loosened ──────────────────────────────────────── */
describe('Fix 1 and Fix 2 are intact', () => {
  test('the price is still the authoritative one', () => {
    assert.match(authorise, /const baseFeePence = request\.base_fee_pence;/);
    assert.match(authorise, /NOT_PRICED/);
  });

  test('the status is still what decides funding', () => {
    assert.match(authorise, /const outcome = classifyAuthorisation\(pi\.status\)/);
  });

  test('the driver is still proven before anything is claimed', () => {
    const guard = authorise.indexOf("run.driver_id !== user.id");
    const claim = authorise.indexOf('claim_fetch_authorisation');
    assert.ok(guard > 0 && guard < claim, 'the attempt is claimed before the driver is proven');
  });
});

/**
 * fetch-authorisation-truth.node.test.ts — a 200 is not a hold.
 *
 * authorise-payment read the HTTP status of the PaymentIntent call and nothing
 * else:
 *
 *     const pi = await piRes.json();
 *     if (!piRes.ok) throw …
 *     .update({ payment_intent_id: pi.id, payment_status: 'authorised' })
 *
 * A 200 means Stripe accepted the request, not that money is held. A card
 * needing 3DS returns 200 with `requires_action`; a card that failed at confirm
 * returns 200 with `requires_payment_method`. Both were written down as
 * authorised, the customer was pushed "your card will be charged on delivery",
 * and the driver drove.
 *
 * Worse on this rail than any other: the confirm is triggered by the DRIVER
 * accepting, so the customer is not at their phone. requires_action is the
 * expected answer for any card whose bank asks, not an edge case.
 *
 * The classifier is pure, so every status is exercised for real. The write
 * protection is probed against production with throwaway rows, because only
 * the database can say whether a PATCH is refused.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAuthorisation, paymentStatusFor, isFunded } from '../functions/_shared/fetch-authorisation.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const authorise = code(readFileSync(join(REPO_ROOT, 'supabase/functions/authorise-payment/index.ts'), 'utf8'));
const continueFn = code(readFileSync(join(REPO_ROOT, 'supabase/functions/fetch-authorise/index.ts'), 'utf8'));
const savedCard = code(readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/saved-card.ts'), 'utf8'));
const webhook   = code(readFileSync(join(REPO_ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8'));
const migration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260906120000_fetch_authorisation_truth.sql'), 'utf8');
const config    = readFileSync(join(REPO_ROOT, 'supabase/config.toml'), 'utf8');
const panel     = code(readFileSync(join(WEB_ROOT, 'components/fetch/AuthorisePanel.tsx'), 'utf8'));
const driverUi  = code(readFileSync(join(WEB_ROOT, 'components/fetch/DriverActions.tsx'), 'utf8'));

/* ── live probe plumbing ──────────────────────────────────────────────────── */
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

let userA = '', tokA = '', userB = '', tokB = '', reqId = '';
const mkUser = async () => {
  const email = `fetchauth-${Math.random().toString(16).slice(2, 10)}@probe.invalid`;
  const password = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const made = await api('/auth/v1/admin/users', cfg!.srk, { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
  const tok = await api('/auth/v1/token?grant_type=password', cfg!.anon, { method: 'POST', body: JSON.stringify({ email, password }) });
  return { id: made.body.id as string, token: tok.body.access_token as string };
};

before(async () => {
  if (!cfg) return;
  const a = await mkUser(); userA = a.id; tokA = a.token;
  const b = await mkUser(); userB = b.id; tokB = b.token;
  const made = await api('/rest/v1/delivery_requests', cfg.anon, {
    method: 'POST', bearer: tokA, prefer: 'return=representation',
    body: JSON.stringify({
      customer_id: userA, category_slug: 'shopping', pickup_name: 'PROBE',
      pickup_location: 'PROBE — delete me, Lerwick', destination_address: 'PROBE — delete me, Scalloway',
      destination_area: 'Scalloway', liability_acknowledged: true, status: 'pending',
      // the forgeries, sent together
      payment_status: 'authorised', payment_intent_id: 'pi_forged_by_the_client', total_fee_pence: 1,
    }),
  });
  reqId = made.body?.[0]?.id ?? '';
});

after(async () => {
  if (!cfg) return;
  if (reqId) await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg.srk, { method: 'DELETE' });
  for (const u of [userA, userB]) if (u) await api(`/auth/v1/admin/users/${u}`, cfg.srk, { method: 'DELETE' });
});

/* ── 1. every status Stripe can return ────────────────────────────────────── */
describe('only requires_capture is a hold', () => {
  test('requires_capture → authorised', () => {
    assert.deepEqual(classifyAuthorisation('requires_capture'), { kind: 'authorised' });
    assert.equal(paymentStatusFor(classifyAuthorisation('requires_capture')), 'authorised');
    assert.equal(isFunded('authorised'), true);
  });

  test('requires_action → NOT authorised', () => {
    assert.equal(classifyAuthorisation('requires_action').kind, 'requires_action');
    assert.equal(paymentStatusFor(classifyAuthorisation('requires_action')), 'requires_action');
    assert.equal(isFunded('requires_action'), false);
  });

  test('requires_payment_method → NOT authorised', () => {
    const o = classifyAuthorisation('requires_payment_method');
    assert.equal(o.kind, 'requires_payment_method');
    assert.equal(paymentStatusFor(o), 'requires_payment_method');
    assert.equal(isFunded('requires_payment_method'), false);
    // The message is the customer's, so it says what to do and never leaks
    // Stripe's internals.
    assert.match((o as { message: string }).message, /nothing has been charged/i);
    assert.ok(!/pi_|sec_|api key/i.test((o as { message: string }).message));
  });

  test('processing → NOT authorised', () => {
    assert.equal(classifyAuthorisation('processing').kind, 'processing');
    assert.equal(paymentStatusFor(classifyAuthorisation('processing')), 'processing');
    assert.equal(isFunded('processing'), false);
  });

  test('an unknown status fails closed', () => {
    for (const weird of ['something_new', '', null, undefined]) {
      const o = classifyAuthorisation(weird as string);
      assert.equal(o.kind, 'unknown', `${weird} was recognised`);
      assert.equal(isFunded(paymentStatusFor(o)), false, `${weird} counted as funded`);
    }
  });

  test('succeeded is handled deliberately, never reinterpreted as a hold', () => {
    // Money already taken. Calling it 'authorised' would send capture-payment
    // to capture it a second time.
    assert.equal(classifyAuthorisation('succeeded').kind, 'succeeded');
    assert.equal(paymentStatusFor(classifyAuthorisation('succeeded')), 'captured');
  });

  test('canceled is a failure, not a hold', () => {
    assert.equal(paymentStatusFor(classifyAuthorisation('canceled')), 'failed');
    assert.equal(isFunded('failed'), false);
  });

  test('nothing but authorised counts as funded', () => {
    for (const s of ['unpaid', 'requires_action', 'requires_payment_method', 'processing', 'failed', 'refunded', null]) {
      assert.equal(isFunded(s as string), false, `${s} counted as funded`);
    }
  });
});

/* ── 2. the endpoint reads the status ─────────────────────────────────────── */
describe('authorise-payment believes Stripe, not the HTTP code', () => {
  test('it classifies pi.status and stores what that means', () => {
    assert.match(authorise, /const outcome = classifyAuthorisation\(pi\.status\)/);
    assert.match(authorise, /payment_status: paymentStatus/);
    // Scoped to the DATABASE write. The success response still reports
    // payment_status: 'authorised', which is a fact about the outcome rather
    // than a value written regardless of it.
    const write = authorise.slice(authorise.indexOf(".from('delivery_requests')\n      .update({"), authorise.indexOf(".eq('id', request_id);"));
    assert.ok(!/payment_status: 'authorised'/.test(write), "'authorised' is still written unconditionally");
  });

  test('a non-hold returns authorised:false and does not release the driver', () => {
    assert.match(authorise, /if \(outcome\.kind !== 'authorised'\)/);
    assert.match(authorise, /authorised: false/);
    assert.match(authorise, /requires_customer_action: needsCustomer/);
  });

  test('the intent id is kept whatever the outcome, so it can be continued', () => {
    const block = authorise.slice(authorise.indexOf('const outcome ='), authorise.indexOf("if (outcome.kind !== 'authorised')"));
    assert.match(block, /payment_intent_id: pi\.id/);
  });

  test('"charged on delivery" is only promised once the hold is real', () => {
    const promise = authorise.indexOf('Your card will be charged on delivery');
    const gate = authorise.indexOf("if (outcome.kind !== 'authorised')");
    assert.ok(promise > gate, 'the customer is still told their card will be charged before a hold exists');
  });
});

/* ── 3. the saved card is chosen deterministically ────────────────────────── */
describe('the card is the customer’s default, not whichever came back first', () => {
  test('the default is honoured only when the card is still attached', () => {
    // Paygate 13 Fix 1 inverted this deliberately. Reading the Customer's
    // default FIRST was the defect: a detached PaymentMethod is permanently
    // unusable, Stripe does not document clearing the default on detach, and
    // returning it blind handed a dead card to every saved-card rail — which
    // adding a new card would not have fixed, because the stale default kept
    // winning. The attached list is the authority now; the stored default is a
    // preference within it.
    assert.match(savedCard, /invoice_settings\?\.default_payment_method/);
    const fn = savedCard.slice(savedCard.indexOf('export async function defaultCardFor'));
    assert.ok(fn.length > 200, 'defaultCardFor was located');
    const list = fn.indexOf('listAttachedCards');
    const use  = fn.indexOf('attached.some((c) => c.id === current)');
    assert.ok(list > 0 && use > list, 'the default must be checked against the attached list');
    assert.ok(fn.indexOf('return null') < use, 'an empty attached list short-circuits first');
  });

  test('the first card is promoted so the next call agrees with this one', () => {
    assert.match(savedCard, /invoice_settings\[default_payment_method\]/);
  });

  test('authorise-payment uses it instead of its own lookup', () => {
    // Fix 6 moved the customer id off the profile read and onto the canonical
    // registry — a customer who has never paid has no profile binding yet, and
    // reading one was the 400 that stranded the delivery. The card lookup is
    // unchanged; only where the Customer comes from is.
    assert.match(authorise, /await defaultCardFor\(stripeKey, stripeCustomerId\)/);
    assert.match(authorise, /const stripeCustomerId = customer\.customerId;/);
    assert.ok(!/defaultCardFor\(stripeKey, customerProfile/.test(authorise),
      'the card lookup must not depend on a profile binding that may not exist yet');
    assert.ok(!/payment_methods\?type=card&limit=1/.test(authorise), 'the old first-card lookup is still there');
  });
});

/* ── 4. the cardless customer ─────────────────────────────────────────────── */
describe('no saved card is recoverable, not a dead end', () => {
  test('the driver is no longer told the customer has no card', () => {
    assert.ok(!/No payment method found for customer/.test(authorise), 'the dead end is still there');
  });

  test('the intent is created unconfirmed rather than refused', () => {
    assert.match(authorise, /if \(paymentMethodId\) \{[\s\S]{0,120}piBody\.confirm = 'true';/);
  });

  test('the customer completes that same intent', () => {
    assert.match(panel, /functions\.invoke\("fetch-authorise"/);
    assert.match(panel, /<PaymentCheckout/);
  });
});

/* ── 5. continuation never makes a second intent ──────────────────────────── */
describe('the continuation endpoint only ever continues', () => {
  test('the ordinary continuation creates no PaymentIntent', () => {
    // Fix 5 introduced ONE exception, and this pin now measures its edges
    // rather than asserting an absolute that is no longer true. Stripe cannot
    // revive a canceled intent, so a hold that lapsed can only be replaced —
    // and that replacement lives entirely inside reauthorise(), which is
    // reachable only by the customer, only after Stripe itself has confirmed
    // the old hold is gone. The continuation path proper still creates nothing.
    const serveBody = continueFn.slice(0, continueFn.indexOf('async function reauthorise'));
    assert.ok(serveBody.length > 500, 'the continuation body was located');
    assert.ok(!/method: 'POST'[\s\S]{0,200}payment_intents/.test(serveBody),
      'the continuation path POSTs to payment_intents');
    assert.ok(!/payment_intents['"`]?,\s*\{[\s\S]{0,40}method: 'POST'/.test(serveBody),
      'the continuation path can create an intent');
  });

  test('the one exception is gated on Stripe, on the customer, and on a generation', () => {
    const reauth = continueFn.slice(continueFn.indexOf('async function reauthorise'));
    assert.ok(reauth.length > 500, 'the re-authorisation body was located');
    // Stripe decides it expired; the database hands out exactly one generation;
    // only then is anything created.
    assert.ok(reauth.indexOf('readHold(') < reauth.indexOf("reauthorise_fetch_delivery"),
      'Stripe is asked before a replacement is claimed');
    assert.ok(reauth.indexOf("reauthorise_fetch_delivery") < reauth.indexOf('${STRIPE}/payment_intents`'),
      'the generation is claimed before anything is created');
    assert.match(reauth, /hold\.state !== 'expired'/);
    // And it is reached only through an explicit, customer-owned request.
    assert.match(continueFn, /body\?\.reauthorise === true/);
    assert.ok(continueFn.indexOf("request.customer_id !== user.id") < continueFn.indexOf('body?.reauthorise === true'),
      'ownership is proven before re-authorisation is even considered');
  });

  test('the intent comes from our row, never from the request body', () => {
    assert.match(continueFn, /request\.payment_intent_id/);
    assert.ok(!/body\?\.payment_intent_id|body\.payment_intent/.test(continueFn), 'a caller can name an intent');
  });

  test('only the customer who owns the request may continue it', () => {
    assert.match(continueFn, /if \(request\.customer_id !== user\.id\) return json\(\{ error: 'Forbidden' \}, 403\)/);
    assert.match(continueFn, /auth\.getUser\(\)/);
  });

  test('Stripe is re-read and the row corrected from it', () => {
    assert.match(continueFn, /classifyAuthorisation\(pi\.status\)/);
    assert.match(continueFn, /\.update\(\{ payment_status: paymentStatus \}\)/);
  });

  test('the browser never asserts success', () => {
    assert.match(panel, /await check\(true\)/);
    assert.ok(!/payment_status: "authorised"/.test(panel), 'the browser writes the outcome');
  });

  test('an abandoned challenge resumes the same intent', () => {
    // Nothing is cleared on the way out, so reopening the request reads the
    // same stored intent back.
    assert.ok(!/payment_intent_id: null/.test(continueFn), 'the intent is discarded on abandonment');
  });

  test('processing and unknown fail closed with something to say', () => {
    assert.match(continueFn, /outcome\.kind === 'processing' \|\| outcome\.kind === 'unknown'/);
    assert.match(continueFn, /authorised: false/);
  });

  test('it is behind a JWT', () => {
    assert.match(config, /\[functions\.fetch-authorise\]\s*\nverify_jwt = true/);
  });
});

/* ── 6. the driver is gated on real money ─────────────────────────────────── */
describe('a driver is not released by a PaymentIntent existing', () => {
  test('the screen asks whether it is funded, not whether an intent exists', () => {
    assert.match(driverUi, /const funded = req\.payment_status === "authorised" \|\| req\.payment_status === "captured"/);
    assert.match(driverUi, /if \(!funded\) \{/);
  });

  test('and the database refuses the transition regardless of the screen', () => {
    assert.match(migration, /new\.status in \('collected', 'delivered'\)/);
    assert.match(migration, /not in \('authorised', 'captured'\)/);
    assert.match(migration, /raise exception 'This delivery is not authorised yet/);
  });

  test('cancelling is never gated — giving up must always be possible', () => {
    const gate = migration.slice(migration.indexOf('new.status is distinct from old.status'), migration.indexOf('return new;', migration.indexOf('new.status is distinct')));
    assert.ok(!/cancelled/.test(gate), 'cancellation was caught by the funding gate');
  });
});

/* ── 7. the fields cannot be forged — against production ──────────────────── */
describe('payment state is the server’s', () => {
  test('a forged request is stored unpaid, with no intent and no total', { skip: !cfg }, () => {
    assert.ok(reqId, 'the probe request was refused outright');
  });

  test('the forged values did not survive the insert', { skip: !cfg }, async () => {
    const now = await api(`/rest/v1/delivery_requests?id=eq.${reqId}&select=payment_status,payment_intent_id,total_fee_pence`, cfg!.srk);
    const r = now.body[0];
    assert.equal(r.payment_status, 'unpaid', 'a client marked its own request authorised');
    assert.equal(r.payment_intent_id, null, 'a client set its own PaymentIntent');
    assert.equal(r.total_fee_pence, null, 'a client set the charged total');
  });

  test('and cannot be patched in afterwards', { skip: !cfg }, async () => {
    await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg!.anon, {
      method: 'PATCH', bearer: tokA,
      body: JSON.stringify({ payment_status: 'authorised', payment_intent_id: 'pi_forged', total_fee_pence: 1 }),
    });
    const now = await api(`/rest/v1/delivery_requests?id=eq.${reqId}&select=payment_status,payment_intent_id,total_fee_pence`, cfg!.srk);
    assert.equal(now.body[0].payment_status, 'unpaid');
    assert.equal(now.body[0].payment_intent_id, null);
    assert.equal(now.body[0].total_fee_pence, null);
  });

  test('the trusted path can still write them', { skip: !cfg }, async () => {
    const set = await api(`/rest/v1/delivery_requests?id=eq.${reqId}`, cfg!.srk, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ payment_status: 'requires_action', payment_intent_id: 'pi_probe_server_written' }),
    });
    assert.equal(set.status, 200);
    assert.equal(set.body[0].payment_status, 'requires_action', 'the server cannot record the truth');
  });

  test('another customer cannot continue this request', { skip: !cfg }, async () => {
    const res = await fetch(`${cfg!.url}/functions/v1/fetch-authorise`, {
      method: 'POST',
      headers: { apikey: cfg!.anon, Authorization: `Bearer ${tokB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: reqId }),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 403, `a stranger got HTTP ${res.status}`);
    assert.equal((body as { error?: string }).error, 'Forbidden');
  });

  test('a stranger cannot even see the row', { skip: !cfg }, async () => {
    const read = await api(`/rest/v1/delivery_requests?id=eq.${reqId}&select=id`, cfg!.anon, { bearer: tokB });
    assert.equal(read.body.length, 0, 'row ownership was weakened');
  });
});

/* ── 8. Stripe's own signal ───────────────────────────────────────────────── */
describe('the webhook agrees with the API read', () => {
  test('amount_capturable_updated marks a Fetch request authorised', () => {
    assert.match(webhook, /case 'payment_intent\.amount_capturable_updated'/);
    assert.match(webhook, /amount_capturable === 'number' && eventData\.amount_capturable > 0/);
    assert.match(webhook, /payment_status: 'authorised'/);
  });

  test('it never walks a capture backwards', () => {
    const block = webhook.slice(webhook.indexOf("case 'payment_intent.amount_capturable_updated'"), webhook.indexOf("case 'payment_intent.succeeded'"));
    assert.match(block, /\.neq\('payment_status', 'captured'\)/);
  });

  test('the webhook stays signature-authenticated', () => {
    assert.match(config, /\[functions\.stripe-webhook\]\s*\nverify_jwt = false/);
  });
});

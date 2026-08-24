/**
 * unit-purchase-and-redemption.node.test.ts — Paygate 4's two defects.
 *
 * DEFECT 1 — A PASS CODE COULD BE SPENT MORE THAN ONCE
 *
 * local-redeem-verify spent a pass by reading uses_remaining, subtracting one
 * and writing it back, then flipping local_redemptions pending -> consumed with
 * no guard on that either. Every check was a read nothing held.
 *
 * Reproduced against production on disposable fixtures — five trials, six
 * concurrent verifies of the SAME code, a pass holding five uses:
 *
 *     successes=4 credits_spent=2   successes=4 credits_spent=2
 *     successes=6 credits_spent=3   successes=4 credits_spent=3
 *     successes=3 credits_spent=2
 *
 * Five out of five. One code, presented repeatedly, honoured again and again
 * while the balance fell by less than the services handed over.
 *
 * Now one function holds real locks: the redemption row FOR UPDATE first, so
 * concurrent callers queue and only the first finds it pending; then the
 * purchase row, re-read under that lock. Re-run after deploying: 6/6 trials,
 * exactly one success and exactly one credit every time.
 *
 * DEFECT 2 — A SECOND DELIBERATE PURCHASE RETURNED THE FIRST PAYMENTINTENT
 *
 * The Stripe idempotency key was `unit-<user>-<item>` with no attempt nonce.
 * Stripe honours a key for 24 hours, so buying the same coffee card twice in a
 * day returned the FIRST PaymentIntent, fulfilment deduped on it, and the
 * customer got no second pass while the UI reported success.
 *
 * Now `unit-<user>-<item>-<client_request_id>`, the same convention
 * create-event-ticket-intent already validates. Both clients already minted an
 * attempt id via useAttemptId and were already passing it on the WALLET path —
 * only the card path beside it omitted it.
 *
 * WHAT IS ASSERTED
 *   · redemption is one locked transaction, reachable only by the server
 *   · the verifier's business ownership is re-checked inside it
 *   · a balance cannot go below zero and fully_used_at is stamped once
 *   · the attempt id is required, validated, and in the Stripe key
 *   · price and buyer identity are still server-authoritative
 *   · SCA still resumes the same PaymentIntent
 *   · fulfilment is still unique per payment_intent_id, on both paths
 *   · stamps/points were NOT touched
 *
 * SAFETY
 * Source inspection only. The concurrency and idempotency behaviour was
 * exercised against production on disposable fixtures — a demo-slug business,
 * its own owner and customer — all removed afterwards. No PaymentIntent was
 * ever confirmed.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const rpc = read('supabase/migrations/20260824170000_atomic_pass_redemption_token_type.sql');
const verify = read('supabase/functions/local-redeem-verify/index.ts');
const intent = read('supabase/functions/create-unit-purchase-intent/index.ts');
const confirm = read('supabase/functions/confirm-unit-purchase/index.ts');
const fulfil = read('supabase/functions/_shared/fulfilment.ts');
const idem = read('supabase/migrations/20260623020000_payment_idempotency.sql');
const appBuy = read('app/local-buy-unit.tsx');
const webModal = web('components/local/BuyUnitModal.tsx');
const webClient = web('lib/local-commerce-client.ts');

const fn = (src: string, name: string) =>
  src.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';

/* ── 1. Redemption is one locked transaction ──────────────────────────────── */

describe('a pass code is spent exactly once', () => {
  const body = fn(rpc, 'redeem_pass_atomic');

  test('the redemption row is locked first, so callers serialise', () => {
    assert.ok(body.length > 0, 'redeem_pass_atomic not found');
    const redLock = body.indexOf('from public.local_redemptions');
    const forUpdate = body.indexOf('for update', redLock);
    const purLock = body.indexOf('from public.book_unit_purchases');
    assert.ok(redLock > -1 && forUpdate > -1, 'the redemption row is not locked');
    assert.ok(forUpdate < purLock, 'the purchase is locked before the redemption — wrong order');
  });

  test('the purchase row is locked too, and re-read under that lock', () => {
    const pur = body.slice(body.indexOf('from public.book_unit_purchases'));
    assert.match(pur, /for update/);
  });

  test('the loser of the race changes nothing', () => {
    assert.match(body, /if v_red\.status <> 'pending' then[\s\S]*?'already_used'/);
  });

  test('the redemption is consumed inside the same transaction', () => {
    assert.match(body, /update public\.local_redemptions\s*\n\s*set status = 'consumed', consumed_at = now\(\), consumed_by = p_verifier/);
    // and the edge function must not ALSO flip it afterwards
    assert.match(verify, /redeem_pass_atomic also flips the redemption to/);
    assert.match(verify, /return json\(\{\s*\n\s*ok: true,\s*\n\s*kind: 'pass'/);
  });

  test('a balance cannot go below zero', () => {
    assert.match(body, /coalesce\(v_purchase\.uses_remaining, 0\) <= 0/);
    assert.match(body, /'no_uses_left'/);
    assert.match(body, /v_left := v_purchase\.uses_remaining - 1;/);
  });

  test('fully_used_at is stamped on the way to zero and never cleared', () => {
    assert.match(body, /fully_used_at\s+= case when v_left = 0 then now\(\) else fully_used_at end/);
    // the old code wrote null on every non-final redemption
    assert.ok(!/fully_used_at\s*=\s*null/i.test(body));
  });

  test('an expired pass or expired code is refused', () => {
    assert.match(body, /v_red\.expires_at is not null and v_red\.expires_at <= now\(\)/);
    assert.match(body, /v_purchase\.expires_at is not null and v_purchase\.expires_at <= now\(\)/);
  });
});

describe('only the server can spend a pass, and only for its own business', () => {
  const body = fn(rpc, 'redeem_pass_atomic');

  test('the function is service_role only', () => {
    assert.match(rpc, /revoke all on function public\.redeem_pass_atomic\(uuid, text, text\) from public, anon, authenticated;/);
    assert.match(rpc, /grant execute on function public\.redeem_pass_atomic\(uuid, text, text\) to service_role;/);
  });

  test('ownership is re-checked against the database inside the transaction', () => {
    assert.match(body, /from public\.local_businesses b\s*\n\s*where b\.id = v_red\.business_id and b\.owner_id = p_verifier/);
    assert.match(body, /'not_your_business'/);
  });

  test('it takes a CODE, not a purchase id — it cannot be a generic decrementer', () => {
    assert.match(rpc, /redeem_pass_atomic\(\s*\n?\s*p_verifier uuid,\s*\n?\s*p_code\s+text default null,\s*\n?\s*p_token\s+text default null/);
    assert.ok(!/p_purchase|p_uses|p_amount/.test(body), 'the function accepts caller-supplied pass state');
  });

  test('the edge function passes the JWT-derived verifier, not anything from the body', () => {
    assert.match(verify, /p_verifier: user\.id/);
    assert.match(verify, /const \{ data: \{ user \} \} = await anon\.auth\.getUser\(\)/);
  });

  test('the caller must still own a business at the edge', () => {
    assert.match(verify, /if \(bizIds\.length === 0\) return json\(\{ error: 'You do not run a business' \}, 403\)/);
  });
});

describe('stamps and points were deliberately not touched', () => {
  test('only the pass branch calls the atomic RPC', () => {
    // Actual invocations, not the comment that explains it.
    assert.equal((verify.match(/svc\.rpc\('redeem_pass_atomic'/g) ?? []).length, 1);
  });

  test('the reward and points branches are unchanged read-then-write', () => {
    // Recorded so this stays a known, separate backlog item rather than a
    // silent assumption that everything was fixed.
    assert.match(verify, /red\.kind === 'reward'/);
    assert.match(verify, /red\.kind === 'points'/);
    // The scope note lives in the migration that introduced the function.
    const origin = read('supabase/migrations/20260824160000_atomic_pass_redemption.sql');
    assert.match(origin, /Stamps, points and the redemption-row flip for/);
    assert.match(origin, /reported separately/);
  });
});

/* ── 2. One checkout attempt, one PaymentIntent ───────────────────────────── */

describe('a second deliberate purchase gets its own PaymentIntent', () => {
  test('the attempt id is required and validated', () => {
    assert.match(intent, /client_request_id = null \} = await req\.json\(\)/);
    assert.match(intent, /typeof client_request_id !== 'string'[\s\S]*?client_request_id\.length < 8 \|\| client_request_id\.length > 100/);
    assert.match(intent, /'client_request_id required'/);
  });

  test('it is in the Stripe idempotency key, on BOTH branches', () => {
    const keys = [...intent.matchAll(/`unit-\$\{user\.id\}-\$\{item\.id\}([^`]*)`/g)].map((m) => m[1]);
    assert.equal(keys.length, 2, `expected both branches keyed, found ${keys.length}`);
    for (const k of keys) assert.equal(k, '-${client_request_id}');
  });

  test('the bare key can never come back', () => {
    assert.ok(!/`unit-\$\{user\.id\}-\$\{item\.id\}`/.test(intent),
      'a PaymentIntent is still keyed without the attempt id');
  });

  test('it is an idempotency token only — never a price or an identity', () => {
    assert.match(intent, /amount:\s+String\(item\.price_pence\)/);
    assert.match(intent, /'metadata\[buyer_id\]':\s+user\.id/);
    assert.ok(!/price_pence.*client_request_id|client_request_id.*amount/.test(intent));
  });

  test('both clients send one attempt id per deliberate checkout', () => {
    assert.match(webModal, /startUnitPurchase\(item\.id, true, attemptId\(\)\)/);
    assert.match(webModal, /const attemptId = useAttemptId\(item\.id\)/);
    assert.match(appBuy, /client_request_id: attemptId\(\)/);
    assert.match(appBuy, /const attemptId = useAttemptId\(item\?\.id \?\? null\)/);
  });

  test('the web helper defaults to a fresh id rather than omitting one', () => {
    assert.match(webClient, /attemptId: string = newCheckoutAttemptId\(\)/);
    assert.match(webClient, /client_request_id: attemptId/);
  });
});

/* ── 3. Everything that already worked still does ─────────────────────────── */

describe('the rest of the unit purchase is untouched', () => {
  test('price stays server-authoritative and the item is validated', () => {
    assert.match(intent, /\.from\('book_unit_items'\)[\s\S]*?\.select\('id, name, price_pence, stock, is_active, business_id'\)/);
    assert.match(intent, /if \(!item \|\| !item\.is_active\)/);
    assert.match(intent, /'stock_exhausted'/);
  });

  test('rate limiting is preserved', () => {
    assert.match(intent, /enforceRateLimit\('create-unit-purchase-intent', userSubject\(user\.id\), \['stripe_intent', 'stripe_any'\]/);
  });

  test('saved-card SCA still resumes the SAME PaymentIntent', () => {
    assert.match(intent, /onSessionConfirm\(customerId, pmId\)/);
    assert.match(intent, /requires_action[\s\S]*?the SDK finishes THIS intent/);
    assert.match(webClient, /settleSavedCardPayment/);
    assert.match(appBuy, /settleSavedCardPayment/);
  });

  test('fulfilment is still unique per payment_intent_id', () => {
    assert.match(idem, /CREATE UNIQUE INDEX IF NOT EXISTS book_unit_purchases_payment_intent_id_key/);
  });

  test('and both fulfilment paths still handle the duplicate', () => {
    assert.match(confirm, /\.eq\('payment_intent_id', payment_intent_id\)/);
    assert.match(confirm, /insertErr\?\.code === '23505'/);
    assert.match(fulfil, /\.eq\('payment_intent_id', pi\.id\)/);
    assert.match(fulfil, /insertErr\.code === '23505'\) return already\('recorded'\)/);
  });

  test('the two idempotency layers solve different problems and both remain', () => {
    // attempt id -> one PaymentIntent per checkout
    assert.match(intent, /client_request_id/);
    // unique index -> one fulfilment per payment
    assert.match(idem, /book_unit_purchases_payment_intent_id_key/);
  });
});

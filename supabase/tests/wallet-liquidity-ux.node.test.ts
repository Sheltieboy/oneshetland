/**
 * wallet-liquidity-ux.node.test.ts
 *
 * The platform was in Critical liquidity state. A merchant's £1.00
 * scan-to-charge request, approved by the customer, was correctly declined
 * BEFORE any debit by the preflight gate — but both screens rendered it as
 * a destructive red "Payment failed (not charged)" / customer error,
 * indistinguishable from a genuine Stripe transfer rejection.
 *
 * This proves the fix: a dedicated 'liquidity_unavailable' reason/status,
 * propagated end to end (executeWalletPayment → wallet-charge-approve →
 * wallet_charge_requests.status → both clients' error-reason plumbing →
 * neutral, non-red UI on both the merchant till and the customer approval
 * prompt) — never collapsed into the generic failure path, which remains
 * exactly as it was for a genuine Stripe rejection.
 */

import './_support/production-lane-guard.ts';   // fail closed: this file can contact production (see that module)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function sql(body: string): Record<string, unknown>[] {
  let out: string;
  try {
    out = execFileSync('npx',
      ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.rows ?? [];
}

/* ── 1. The real production attempt reconciles exactly as designed ───────── */

describe('the real £1.00 Critical-liquidity attempt: reconciled against production', () => {
  const REQUEST_ID = '097c5eba-4ab4-4c02-95e9-fb61c1edb0cd';

  test('the charge request settled to a failure-shaped status, with no wallet_transactions row ever created for it', () => {
    const [req] = sql(`select status, amount_pence, resolved_at, created_at from wallet_charge_requests where id = '${REQUEST_ID}';`);
    assert.ok(req, 'the real request row is missing — update this test\'s id if it was ever purged');
    assert.equal(req.amount_pence, 100);
    assert.ok(req.status === 'failed' || req.status === 'liquidity_unavailable',
      `expected the pre-fix 'failed' or the post-fix 'liquidity_unavailable', got ${req.status}`);
  });

  test('no spend row, no refund row, no transfer was ever created for this attempt — the preflight declined before any money moved', () => {
    const rows = sql(`select type, transfer_state, stripe_transfer_id from local_wallet_transactions
       where idempotency_key = 'charge-${REQUEST_ID}' or idempotency_key = 'charge-${REQUEST_ID}:reversal';`);
    assert.equal(rows.length, 0, 'a wallet_transactions row exists for this declined attempt — the preflight must run before any debit');
  });

  test('no approval remains pending for this request — it reached a terminal status', () => {
    const [req] = sql(`select status from wallet_charge_requests where id = '${REQUEST_ID}';`);
    assert.notEqual(req.status, 'pending');
    assert.notEqual(req.status, 'charging');
  });
});

/* ── 2. wallet_charge_requests carries the dedicated status, live ────────── */

describe('wallet_charge_requests.status: the dedicated value is live and distinct', () => {
  test('the CHECK constraint includes liquidity_unavailable alongside every pre-existing value, none removed', () => {
    const [row] = sql(`select pg_get_constraintdef(oid) as d from pg_constraint
       where conrelid = 'wallet_charge_requests'::regclass and conname = 'wallet_charge_requests_status_check';`);
    const d = String(row.d);
    for (const v of ['pending', 'charging', 'paid', 'declined', 'expired', 'failed', 'cancelled', 'liquidity_unavailable']) {
      assert.match(d, new RegExp(`'${v}'`), `status value "${v}" missing from the live constraint`);
    }
  });
});

/* ── 3. executeWalletPayment's dedicated reason ───────────────────────────── */

describe('executeWalletPayment returns a dedicated liquidity_unavailable reason, never generic ineligible', () => {
  const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));

  test('both liquidity-decline paths (unreadable balance, reservation declined) use reason: \'liquidity_unavailable\'', () => {
    const unknownBlock = wp.slice(wp.indexOf("if (liquidity.status === 'unknown')"), wp.indexOf("if (liquidity.status !== 'disabled')"));
    assert.match(unknownBlock, /reason: 'liquidity_unavailable'/);
    const reserveBlock = wp.slice(wp.indexOf('const reservation = await reserveWalletLiquidity'), wp.indexOf('reservationId = reservation.reservationId;'));
    assert.match(reserveBlock, /reason: 'liquidity_unavailable'/);
  });

  test('neither liquidity-decline path uses the generic \'ineligible\' reason any more', () => {
    const unknownBlock = wp.slice(wp.indexOf("if (liquidity.status === 'unknown')"), wp.indexOf("if (liquidity.status !== 'disabled')"));
    const reserveBlock = wp.slice(wp.indexOf('const reservation = await reserveWalletLiquidity'), wp.indexOf('reservationId = reservation.reservationId;'));
    assert.doesNotMatch(unknownBlock, /reason: 'ineligible'/);
    assert.doesNotMatch(reserveBlock, /reason: 'ineligible'/);
  });

  test('every OTHER refusal in executeWalletPayment (self-pay, not-accepting, below-Pro, fee-exceeds-amount) still uses \'ineligible\', unchanged', () => {
    for (const marker of [
      "error: \"Can't pay yourself\", reason: 'ineligible'",
      "error: \"This business doesn't accept wallet payments yet\", reason: 'ineligible'",
      "error: \"This business isn't currently accepting Wallet payments\", reason: 'ineligible'",
    ]) {
      assert.ok(wp.includes(marker), `an unrelated 'ineligible' refusal changed or moved: ${marker}`);
    }
  });

  test('the type union documents liquidity_unavailable as its own, deliberately distinct reason', () => {
    const raw = read('supabase/functions/_shared/wallet-pay.ts');
    assert.match(raw, /reason: 'ineligible' \| 'insufficient' \| 'blocked' \| 'rejected' \| 'unresolved' \| 'liquidity_unavailable'/);
    assert.match(raw, /deliberately distinct from\s*\n\s*\/\/ 'ineligible'/);
  });
});

/* ── 4. wallet-charge-approve propagates it to the request row and the response ── */

describe('wallet-charge-approve: dedicated status on the row, dedicated reason in the response', () => {
  const fn = code(read('supabase/functions/wallet-charge-approve/index.ts'));

  test('settles the request to \'liquidity_unavailable\' specifically when the reason is liquidity_unavailable, else the original \'failed\'', () => {
    assert.match(fn, /const settledStatus = result\.reason === 'liquidity_unavailable' \? 'liquidity_unavailable' : 'failed';/);
  });

  test('the JSON error response carries reason, not just a message string — the client must not pattern-match text', () => {
    assert.match(fn, /return json\(\{ error: result\.error, reason: result\.reason \}, result\.status\);/);
  });
});

/* ── 5. Merchant screens (mobile local-till, web LoyaltyTill) never show generic "Payment failed" for this case ── */

describe('merchant till screens render a dedicated neutral state, never the generic red "Payment failed"', () => {
  for (const [label, path, readFn] of [
    ['mobile local-till.tsx', 'app/local-till.tsx', read] as const,
    ['web LoyaltyTill.tsx', 'components/business/LoyaltyTill.tsx', readWeb] as const,
  ]) {
    test(`${label}: has a dedicated liquidity_unavailable branch, distinct from the 'failed' branch`, () => {
      const src = code(readFn(path));
      assert.match(src, /charge\.status === ['"]liquidity_unavailable['"]/);
    });

    test(`${label}: the liquidity_unavailable branch never renders the generic "Payment failed" text, and states the required facts`, () => {
      const raw = readFn(path);
      const marker = "charge.status === 'liquidity_unavailable'" ;
      const altMarker = 'charge.status === "liquidity_unavailable"';
      const start = raw.includes(marker) ? raw.indexOf(marker) : raw.indexOf(altMarker);
      assert.ok(start >= 0, `${label}: liquidity_unavailable branch not found`);
      const nextBranch = raw.indexOf("charge.status === ", start + 20);
      const block = code(raw.slice(start, nextBranch > start ? nextBranch : start + 600));
      assert.doesNotMatch(block, /Payment failed/);
      assert.match(block, /Wallet temporarily unavailable/);
      assert.match(block, /No money was taken/);
    });
  }

  test('the existing "New charge" (mobile) / equivalent reset control still applies to liquidity_unavailable — it is not \'pending\'/\'charging\', so it already falls into the reset branch by construction', () => {
    const mobile = code(read('app/local-till.tsx'));
    assert.match(mobile, /charge\.status === 'pending' \|\| charge\.status === 'charging'\s*\n\s*\? \(cancelling \? 'Cancelling…' : 'Cancel'\)\s*\n\s*: 'New charge'/);
  });
});

/* ── 6. Customer approval prompts never show the generic red failure for this case ── */

describe('customer approval prompts render a dedicated neutral state, never the generic red failure badge', () => {
  test('mobile ChargeApprovalListener: a liquidity_unavailable reason sets a neutral kind, never \'failure\'', () => {
    const src = code(read('components/ChargeApprovalListener.tsx'));
    assert.match(src, /if \(reason === 'liquidity_unavailable'\)/);
    const block = src.slice(src.indexOf("if (reason === 'liquidity_unavailable')"), src.indexOf('} else {'));
    assert.match(block, /kind: 'neutral'/);
    assert.doesNotMatch(block, /kind: 'failure'/);
  });

  test('mobile: the neutral badge colour is distinct from the failure colour, and the failure path is otherwise unchanged', () => {
    const src = code(read('components/ChargeApprovalListener.tsx'));
    assert.match(src, /const NEUTRAL = '#92400E';/);
    assert.match(src, /const FAILURE = '#e11d48';/);
    assert.doesNotMatch(src, /NEUTRAL === FAILURE/);
    // The failure branch (declined/generic error) still produces kind: 'failure'.
    assert.match(src, /setResult\(\{ kind: 'failure', text: e instanceof Error \? e\.message : 'Something went wrong\.' \}\);/);
  });

  test('web ChargeApprovalListener: a liquidity_unavailable reason sets its own phase, distinct from \'failed\'', () => {
    const src = code(readWeb('components/wallet/ChargeApprovalListener.tsx'));
    assert.match(src, /if \(reason === "liquidity_unavailable"\)/);
    assert.match(src, /setPhase\("liquidity_unavailable"\);/);
  });

  test('web: the liquidity_unavailable phase uses NEUTRAL accent/icon colour, never DANGER', () => {
    const src = code(readWeb('components/wallet/ChargeApprovalListener.tsx'));
    assert.match(src, /accent={phase === "failed" \? DANGER : phase === "liquidity_unavailable" \? NEUTRAL : ACCENT}/);
    const block = src.slice(src.indexOf('phase === "liquidity_unavailable" ? ('), src.indexOf(') : phase === "succeeded"'));
    assert.doesNotMatch(block, /DANGER/);
  });

  test('web: liquidity_unavailable is in the fully-protected phase set — a later realtime row update cannot overwrite a confirmed answer', () => {
    const src = readWeb('components/wallet/ChargeApprovalListener.tsx');
    assert.match(src, /phase === "working" \|\| phase === "succeeded" \|\| phase === "declined" \|\| phase === "liquidity_unavailable"/);
  });

  test('both clients propagate reason from the edge function response onto the thrown error, never discarding it', () => {
    assert.match(code(read('lib/member-card.ts')), /if \(reason\) err\.reason = reason;/);
    assert.match(code(readWeb('lib/member-card-client.ts')), /if \(reason\) err\.reason = reason;/);
  });
});

/* ── 7. A genuine Stripe transfer failure is NOT confused with a preflight refusal ── */

describe('a genuine Stripe transfer rejection still uses the existing failure/reversal UX, untouched', () => {
  test('wallet-ledger.ts\'s rejected-transfer handling (the real £5.00 incident\'s path) is unchanged — still reason \'rejected\', still the automatic reversal', () => {
    const ledger = code(read('supabase/functions/_shared/wallet-ledger.ts'));
    assert.match(ledger, /if \(outcome\.kind === 'rejected'\)/);
    assert.match(ledger, /await walletReverse\(svc, debit\.transactionId, `Transfer rejected: \$\{outcome\.message\}`, 'never_paid'\);/);
    assert.doesNotMatch(ledger, /liquidity_unavailable/, 'a genuine Stripe rejection must never be relabelled as a liquidity refusal');
  });

  test('wallet-charge-approve still settles a genuine rejection (reason \'rejected\') to \'failed\', not \'liquidity_unavailable\'', () => {
    const fn = code(read('supabase/functions/wallet-charge-approve/index.ts'));
    // The ternary is the ONLY branch point: anything other than
    // 'liquidity_unavailable' — including 'rejected' — settles to 'failed'.
    assert.match(fn, /result\.reason === 'liquidity_unavailable' \? 'liquidity_unavailable' : 'failed'/);
  });

  test('both merchant tills keep the original \'failed\' branch, rendering "Payment failed (not charged)" for a genuine rejection, unmodified', () => {
    assert.match(read('app/local-till.tsx'), /charge\.status === 'failed' && <Text style={\[styles\.chargeResult, \{ color: '#dc2626' \}\]}>Payment failed \(not charged\)<\/Text>/);
    assert.match(readWeb('components/business/LoyaltyTill.tsx'), /charge\.status === "failed" && <p className="text-sm font-bold text-rose-600">Payment failed \(they&apos;ve not been charged\)<\/p>/);
  });

  test('both customer listeners keep the original failure styling for a non-liquidity error (declined card, genuine rejection, generic error)', () => {
    const mobile = code(read('components/ChargeApprovalListener.tsx'));
    assert.match(mobile, /backgroundColor: result\?\.kind === 'success' \? ACCENT : result\?\.kind === 'neutral' \? NEUTRAL : FAILURE/);
    const web = code(readWeb('components/wallet/ChargeApprovalListener.tsx'));
    assert.match(web, /phase === "failed" \? "Payment failed"/);
  });
});

/* ── 8. No stale approval/error UI from a previous request ───────────────── */

describe('a fresh charge request clears any previous result before showing — no stale UI can bleed through', () => {
  test('mobile: activate() resets both phase and result when a new request is shown', () => {
    const src = code(read('components/ChargeApprovalListener.tsx'));
    const activateFn = src.slice(src.indexOf('const activate = useCallback'), src.indexOf('}, []);'));
    assert.match(activateFn, /setPhase\('ask'\); setResult\(null\);/);
  });

  test('web: activate() resets phase and outcome when a new request is shown', () => {
    const src = readWeb('components/wallet/ChargeApprovalListener.tsx');
    const activateFn = src.slice(src.indexOf('const activate = useCallback'), src.indexOf('[]);'));
    assert.match(activateFn, /setPhase\("ask"\);/);
    assert.match(activateFn, /setOutcome\(null\);/);
  });
});

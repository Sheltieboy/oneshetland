/**
 * wallet-charge-cancel.node.test.ts — the till's Cancel button now means it.
 *
 * WHAT WAS WRONG
 *
 * "Take a wallet payment" → Request → the till waits for the customer to
 * approve. Tapping Cancel only did `setCharge(null)` — pure local UI state.
 * The request stayed 'pending' server-side for the full 180-second window,
 * approvable the whole time. A merchant who fat-fingered £50 instead of £5,
 * tapped Cancel, and believed the request was dead had no such guarantee:
 * the customer's phone still showed "Approve payment of £50.00?" and could
 * still pay it.
 *
 * THE FIX, AND WHAT THIS FILE PROVES ABOUT IT
 *   · a real edge function, wallet-charge-cancel, does a single conditional
 *     UPDATE — `where id = :id and status = 'pending'` — the same atomic-
 *     guard idiom wallet-charge-approve's own claim step already uses. The
 *     concurrency proof for this lives in
 *     wallet-charge-cancel-concurrency.node.test.ts (isolated cluster); this
 *     file proves the STATIC properties: who is authorised, what it can
 *     never touch, and that the mobile app actually calls it.
 *   · authorisation mirrors wallet-charge-request's own "my business"
 *     resolution — the business owner, not whoever created the request, not
 *     the customer.
 *   · it can never move money: no Stripe import, no executeWalletPayment
 *     call, no wallet balance/ledger table reference anywhere in its source.
 *   · errors are friendly and typed, never a raw Postgres/PostgREST message.
 *   · the mobile Cancel button now awaits the server call and reflects
 *     whatever it actually settled to — including "actually, it was already
 *     paid" — rather than unconditionally clearing local state.
 *   · the customer's already-open approval prompt now also listens for the
 *     request updating away from 'pending' (not just new INSERTs), so it can
 *     dismiss itself — extending the existing realtime subscription rather
 *     than building new infrastructure.
 *
 * SAFETY
 * Reads source only — no database, no network, no writes. This branch does
 * not apply its own migration (see the task's constraints: no production
 * migration from this session), so nothing here queries the linked project's
 * live schema; the migration's SQL is checked as a file, and the constraint
 * it produces is exercised for real in wallet-charge-cancel-concurrency's
 * isolated cluster instead.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANCEL_FN   = join(REPO_ROOT, 'supabase/functions/wallet-charge-cancel/index.ts');
const REQUEST_FN  = join(REPO_ROOT, 'supabase/functions/wallet-charge-request/index.ts');
const APPROVE_FN  = join(REPO_ROOT, 'supabase/functions/wallet-charge-approve/index.ts');
const MEMBER_CARD = join(REPO_ROOT, 'lib/member-card.ts');
const TILL        = join(REPO_ROOT, 'app/local-till.tsx');
const LISTENER     = join(REPO_ROOT, 'components/ChargeApprovalListener.tsx');
const MIGRATION    = join(REPO_ROOT, 'supabase/migrations/20261012120000_wallet_charge_cancel.sql');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (p: string) => strip(readFileSync(p, 'utf8'));
const raw  = (p: string) => readFileSync(p, 'utf8');

/* ── the edge function exists and does one conditional write ─────────────── */

describe('wallet-charge-cancel — the atomic guard', () => {
  const fn = code(CANCEL_FN);

  test('the function file exists and is a real Deno edge function', () => {
    assert.match(fn, /serve\(async \(req\) => \{/);
  });

  test('cancellation is a single UPDATE guarded on status = \'pending\' — no SELECT-then-UPDATE', () => {
    const updateIdx = fn.indexOf("status: 'cancelled'");
    assert.notEqual(updateIdx, -1, 'no update to cancelled found');
    const block = fn.slice(Math.max(0, updateIdx - 200), updateIdx + 300);
    assert.match(block, /\.update\(/, 'the cancellation must be a single .update() call');
    assert.match(block, /\.eq\('status', 'pending'\)/, 'the update must be guarded on status = pending, or a concurrent approve could race it');
  });

  test('a lost race is read back and reported, never silently swallowed', () => {
    assert.match(fn, /cancelled\.length === 0/);
    assert.match(fn, /already \$\{cur\?\.status/);
  });

  test('resolved_at is stamped on cancellation, same as every other terminal transition', () => {
    const updateIdx = fn.indexOf("status: 'cancelled'");
    const block = fn.slice(updateIdx, updateIdx + 120);
    assert.match(block, /resolved_at:/);
  });
});

describe('wallet-charge-cancel — authorisation mirrors wallet-charge-request exactly', () => {
  const fn = code(CANCEL_FN);
  const requestFn = code(REQUEST_FN);

  test('the caller must own the business the request belongs to', () => {
    assert.match(fn, /\.eq\('id', reqRow\.business_id\)/);
    assert.match(fn, /\.eq\('owner_id', user\.id\)/);
  });

  test('this is the SAME field wallet-charge-request already resolves "my business" by', () => {
    assert.match(requestFn, /eq\('owner_id', user\.id\)/, 'wallet-charge-request no longer resolves ownership this way — the mirrored check in cancel is now unproven');
  });

  test('an unauthorised caller gets 403, not a silent success or a 500', () => {
    const anchor = fn.indexOf('Not authorised to cancel');
    assert.notEqual(anchor, -1);
    assert.match(fn.slice(anchor, anchor + 60), /\}, 403\)/);
  });

  test('a missing/unauthenticated caller is refused before any row is read', () => {
    assert.match(fn, /if \(!authHeader\) return json\(\{ error: 'Unauthorised' \}, 401\)/);
    assert.match(fn, /if \(!user\) return json\(\{ error: 'Unauthorised' \}, 401\)/);
  });
});

describe('wallet-charge-cancel — cannot move money, by construction', () => {
  const fn = code(CANCEL_FN); // comments stripped — the doc comment's own prose ("the reverse holds too") must not count as code

  test('no Stripe import or reference anywhere in the function', () => {
    assert.doesNotMatch(fn, /stripe/i);
  });

  test('executeWalletPayment is never called', () => {
    assert.doesNotMatch(fn, /executeWalletPayment/);
  });

  test('no wallet balance or ledger table is referenced', () => {
    assert.doesNotMatch(fn, /local_wallet_balances|local_wallet_transactions/);
  });

  test('only wallet_charge_requests and local_businesses are touched', () => {
    const tables = [...fn.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.ok(tables.length > 0, 'expected at least one .from() call');
    for (const t of tables) {
      assert.ok(['wallet_charge_requests', 'local_businesses'].includes(t), `unexpected table touched: ${t}`);
    }
  });

  test('an already-approved payment cannot be reversed here: the guard makes a non-pending row unreachable, and there is no separate reversal path', () => {
    assert.doesNotMatch(fn, /'paid'.*status.*'cancelled'|reverse|refund/i);
  });
});

describe('wallet-charge-cancel — expiry is honoured, not overwritten', () => {
  const fn = code(CANCEL_FN);

  test('an already-past-expiry pending row is moved to expired, not cancelled', () => {
    const anchor = fn.indexOf('reqRow.status === \'pending\' && new Date(reqRow.expires_at)');
    assert.notEqual(anchor, -1, 'no reactive expiry check found');
    const block = fn.slice(anchor, anchor + 300);
    assert.match(block, /status: 'expired'/);
    assert.match(block, /\.eq\('status', 'pending'\)/, 'the reactive expiry write must itself be guarded');
  });

  test('this mirrors wallet-charge-approve\'s own reactive expiry check', () => {
    const approveFn = code(APPROVE_FN);
    assert.match(approveFn, /status: 'expired'/);
    assert.match(approveFn, /new Date\(reqRow\.expires_at\)\.getTime\(\) < Date\.now\(\)/);
    const cancelFn = code(CANCEL_FN);
    assert.match(cancelFn, /new Date\(reqRow\.expires_at\)\.getTime\(\) < Date\.now\(\)/);
  });
});

describe('errors are friendly, never a raw database message', () => {
  test('the catch-all uses the shared safeError helper, same as its siblings', () => {
    const cancelFn = code(CANCEL_FN);
    assert.match(cancelFn, /import \{ safeError \} from '\.\.\/_shared\/safe-error\.ts'/);
    assert.match(cancelFn, /safeError\('wallet-charge-cancel', err\)/);
  });
});

/* ── mobile client ─────────────────────────────────────────────────────────── */

describe('lib/member-card.ts — cancelChargeRequest', () => {
  const src = code(MEMBER_CARD);

  test('cancelled is a real ChargeStatus, not just a UI string', () => {
    assert.match(src, /export type ChargeStatus = [^;]*'cancelled'/);
  });

  test('invokes wallet-charge-cancel with the request id', () => {
    const anchor = src.indexOf('export async function cancelChargeRequest');
    assert.notEqual(anchor, -1);
    const block = src.slice(anchor, anchor + 700);
    assert.match(block, /functions\.invoke\('wallet-charge-cancel'/);
    assert.match(block, /request_id: requestId/);
  });

  test('a 409 (already settled another way) resolves with that status rather than throwing', () => {
    const anchor = src.indexOf('export async function cancelChargeRequest');
    const block = src.slice(anchor, anchor + 700);
    assert.match(block, /body\?\.status/, 'a structured 409 status must be read and returned, not just thrown');
  });

  test('a genuine failure still throws a friendly message via the same invokeErr every other call here uses', () => {
    const anchor = src.indexOf('export async function cancelChargeRequest');
    const block = src.slice(anchor, anchor + 700);
    assert.match(block, /throw await invokeErr\(error\)/);
  });
});

/* ── merchant till UI ──────────────────────────────────────────────────────── */

describe('app/local-till.tsx — Cancel actually cancels', () => {
  const src = code(TILL);

  test('imports and calls cancelChargeRequest', () => {
    assert.match(src, /import \{[^}]*cancelChargeRequest[^}]*\} from '@\/lib\/member-card'/);
    assert.match(src, /await cancelChargeRequest\(charge\.requestId\)/);
  });

  test('the Cancel button, while pending/charging, calls the server — it no longer just clears local state', () => {
    const anchor = src.indexOf('async function cancelCharge()');
    assert.notEqual(anchor, -1, 'cancelCharge() is gone');
    const onPressAnchor = src.indexOf("onPress={() => {\n                      if (charge.status === 'pending' || charge.status === 'charging') cancelCharge();");
    assert.notEqual(onPressAnchor, -1, 'the Cancel/New-charge button no longer branches on status to call cancelCharge()');
  });

  test('on success the result is reflected from the server response, not assumed', () => {
    const anchor = src.indexOf('async function cancelCharge()');
    const block = src.slice(anchor, anchor + 700);
    assert.match(block, /const r = await cancelChargeRequest/);
    assert.match(block, /setCharge\(\(c\) => \(c \? \{ \.\.\.c, status: r\.status \} : c\)\)/,
      'must set status to whatever the server actually returned (e.g. "paid" if the customer won the race), not hardcode "cancelled"');
  });

  test('a failed cancel attempt leaves charge state untouched — no pretending it succeeded', () => {
    const anchor = src.indexOf('async function cancelCharge()');
    const block = src.slice(anchor, src.indexOf('\n  }', anchor + 50));
    const catchIdx = block.indexOf('} catch (e)');
    assert.notEqual(catchIdx, -1);
    const catchBlock = block.slice(catchIdx);
    assert.doesNotMatch(catchBlock, /setCharge\(null\)/, 'a failure must not clear the charge — that would hide a still-pending request');
    assert.match(catchBlock, /setToast\(\{ ok: false/, 'a failure must surface an error to the merchant');
  });

  test('a resolved charge (cancelled/paid/declined/expired/failed) resets on tap without a further server call', () => {
    assert.match(src, /else setCharge\(null\);/);
  });

  test('the button is disabled while a cancel is in flight, so a double-tap cannot fire two requests', () => {
    const btnAnchor = src.indexOf("{charge.status === 'pending' || charge.status === 'charging'\n                        ? (cancelling ? 'Cancelling…' : 'Cancel')");
    assert.notEqual(btnAnchor, -1);
    assert.match(src, /disabled=\{cancelling\}/);
  });

  test('a dedicated "Cancelled" result is shown — reuses the existing status-branch pattern (paid/declined/expired/failed)', () => {
    assert.match(src, /charge\.status === 'cancelled' && <Text/);
  });

  test('successful cancellation returns to a safe till state: the poll stops itself (status is no longer pending/charging)', () => {
    const pollAnchor = src.indexOf('useEffect(() => {\n    if (!charge || (charge.status !== \'pending\' && charge.status !== \'charging\')) return;');
    assert.notEqual(pollAnchor, -1, 'the poll\'s own pending/charging guard has moved — cancellation relies on it to stop polling');
  });
});

/* ── customer-side approval prompt ────────────────────────────────────────── */

describe('components/ChargeApprovalListener.tsx — an open prompt can be told it is dead', () => {
  const src = code(LISTENER);

  test('now also subscribes to UPDATE, not only INSERT', () => {
    const updates = src.match(/event: 'UPDATE'/g) ?? [];
    assert.equal(updates.length, 1, 'expected exactly one UPDATE subscription');
    assert.match(src, /event: 'INSERT'/, 'the original INSERT subscription must still be there');
  });

  test('the same table and customer filter is used for both subscriptions', () => {
    const filters = src.match(/filter: `customer_id=eq\.\$\{userId\}`/g) ?? [];
    assert.equal(filters.length, 2);
  });

  test('an in-flight approve/decline (phase "working") is never interrupted by this', () => {
    assert.match(src, /if \(phaseRef\.current === 'working'\) return;/);
  });

  test('only the request currently on screen can be dismissed by it — not some other update', () => {
    assert.match(src, /if \(reqRef\.current\?\.id !== row\.id\) return;/);
  });

  test('money safety does not depend on this: respondToCharge still gets the definitive answer either way (unchanged)', () => {
    assert.match(src, /const r = await respondToCharge\(req\.id, decision\)/);
  });
});

/* ── the migration, and the constraint it installs ────────────────────────── */

describe('the migration adds cancelled without touching anything else', () => {
  const m = raw(MIGRATION);

  test('exactly one statement, an ALTER TABLE on wallet_charge_requests', () => {
    assert.match(m, /ALTER TABLE public\.wallet_charge_requests/);
    assert.equal((m.match(/ALTER TABLE/g) ?? []).length, 1);
  });

  test('drops and re-adds the same constraint name — no RLS, no grant, no other column touched', () => {
    assert.match(m, /DROP CONSTRAINT wallet_charge_requests_status_check/);
    assert.match(m, /ADD CONSTRAINT wallet_charge_requests_status_check/);
    // Only the actual statement, not the leading -- comment block (whose own
    // prose mentions "No RLS change" — true of the SQL, not a match on it).
    const statement = m.slice(m.indexOf('ALTER TABLE'));
    assert.doesNotMatch(statement, /GRANT|POLICY|RLS|CREATE TABLE|CREATE FUNCTION/i);
  });

  test('every original status value survives, plus cancelled', () => {
    const listMatch = m.match(/CHECK \(status IN \(([^)]+)\)\)/);
    assert.ok(listMatch, 'could not find the new CHECK list');
    const values = listMatch![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(values.sort(), ['cancelled', 'charging', 'declined', 'expired', 'failed', 'paid', 'pending'].sort());
  });
});

// No live check against the linked project's pg_constraint here: this branch
// deliberately does not apply its own migration (see the task constraints —
// no production migration from this session), so the constraint text above
// is proven against the migration FILE, not the linked database's current
// state. Re-run the isolated concurrency suite's "CHECK constraint installed"
// case (which builds the constraint from this same migration on a throwaway
// cluster) for a live proof that stays inside that boundary.

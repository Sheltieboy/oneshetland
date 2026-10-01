/**
 * wallet-failed-transfer-display.node.test.ts
 *
 * The business dashboard showed a real £5.00 Premium Wallet payment —
 * whose Stripe transfer was REJECTED and automatically reversed — exactly
 * like a genuine sale that was later refunded: "£5.00 paid · £4.95 to you ·
 * £0.05 fee", then "Refunded". That is false: the merchant never received
 * £4.95, and the platform never kept the 5p fee.
 *
 * This proves the fix distinguishes the two cases using the literal,
 * already-stored transfer_state column (never inferred from display text):
 *   A. a genuine sale, sent, later refunded          — transfer_state 'reversed'
 *   B. a transfer Stripe rejected, auto-reversed      — transfer_state 'failed'
 * across all four surfaces: the dashboard receipts card and the full
 * ledger, on both mobile and web.
 *
 * The real SQL/fixture proof (both state patterns, live against a
 * throwaway Postgres) is in statement-refund-accounting.node.test.ts's
 * "transfer_state distinguishes..." describe block — this file covers the
 * client-side rendering and the live RPC shape, under plain `npm test`.
 */

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

/* ── 1. Live: both RPCs now expose transfer_state, with original grants kept ── */

describe('both RPCs expose transfer_state live, with their pre-existing grants unchanged', () => {
  test('get_business_transactions returns transfer_state in its column list', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_business_transactions'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /RETURNS TABLE\([^)]*transfer_state text\)/);
    assert.match(d, /t\.transfer_state AS transfer_state/);
    assert.match(d, /o\.transfer_state\s*\n\s*FROM public\.local_wallet_transactions r/);
  });

  test('get_business_wallet_receipts returns transfer_state in its column list', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_business_wallet_receipts'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /RETURNS TABLE\([^)]*transfer_state text\)/);
    assert.match(d, /t\.transfer_state\s*\n\s*from public\.local_wallet_transactions t/);
  });

  test('every non-Wallet branch of get_business_transactions reports transfer_state as a literal null, never a guess', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_business_transactions'::regproc) as d;`);
    const d = String(row.d);
    // Branches 2-7 each end their SELECT list with a bare null::text in the
    // transfer_state position — six occurrences, one per non-Wallet branch.
    assert.equal((d.match(/null::text\s*\n\s*FROM public\./g) ?? []).length, 6,
      'expected exactly six non-Wallet branches reporting transfer_state as null');
  });

  test('get_business_transactions grants are unchanged: authenticated + service_role, never anon', () => {
    const rows = sql(`select grantee from information_schema.routine_privileges where routine_name = 'get_business_transactions';`);
    const grantees = rows.map((r) => r.grantee);
    assert.ok(grantees.includes('authenticated'));
    assert.ok(grantees.includes('service_role'));
    assert.ok(!grantees.includes('anon'));
  });

  test('get_business_wallet_receipts grants are unchanged: anon + authenticated + service_role', () => {
    const rows = sql(`select grantee from information_schema.routine_privileges where routine_name = 'get_business_wallet_receipts';`);
    const grantees = rows.map((r) => r.grantee);
    assert.ok(grantees.includes('anon'));
    assert.ok(grantees.includes('authenticated'));
    assert.ok(grantees.includes('service_role'));
  });

  test('neither function\'s auth/ownership check changed', () => {
    const [tx] = sql(`select pg_get_functiondef('public.get_business_transactions'::regproc) as d;`);
    assert.match(String(tx.d), /b\.owner_id = auth\.uid\(\)/);
    const [rc] = sql(`select pg_get_functiondef('public.get_business_wallet_receipts'::regproc) as d;`);
    assert.match(String(rc.d), /owner_id = v_user_id/);
  });
});

/* ── 2. Mobile dashboard receipts card ─────────────────────────────────────── */

describe('mobile: WalletReceiptsCard renders case B distinctly, using transfer_state only', () => {
  const api = code(read('lib/local-api.ts'));
  const dash = code(read('app/local-business-dashboard.tsx'));
  const dashRaw = read('app/local-business-dashboard.tsx');

  test('BusinessWalletReceipt carries transfer_state, defaulting a missing column to null (not a guess toward "paid")', () => {
    assert.match(api, /transfer_state: string \| null;/);
    assert.match(api, /transfer_state:\s*r\.transfer_state \?\? null,/);
  });

  test('the card branches on transfer_state === \'failed\' alone — not on refund_state, not on amounts', () => {
    assert.match(dash, /\{r\.transfer_state === 'failed' \? \(/);
  });

  test('the failed branch never renders "to you", a fee amount, or a cashback figure', () => {
    const start = dashRaw.indexOf("r.transfer_state === 'failed' ? (");
    const end = dashRaw.indexOf(') : (', start);
    const failedBlock = code(dashRaw.slice(start, end));
    assert.doesNotMatch(failedBlock, /to you/);
    assert.doesNotMatch(failedBlock, /receiptFee\b/);
    assert.doesNotMatch(failedBlock, /receiptCashback\b/);
  });

  test('the failed branch states the required three facts: failed, attempted amount with auto-refund, and no payout', () => {
    const start = dashRaw.indexOf("r.transfer_state === 'failed' ? (");
    const end = dashRaw.indexOf(') : (', start);
    const failedBlock = dashRaw.slice(start, end);
    assert.match(failedBlock, /Failed wallet payment/);
    assert.match(failedBlock, /attempted · customer automatically refunded/);
    assert.match(failedBlock, /No payout to business/);
  });

  test('the Refund button is never offered on a failed, already-auto-reversed row — it is not in the failed branch at all', () => {
    const start = dashRaw.indexOf("r.transfer_state === 'failed' ? (");
    const end = dashRaw.indexOf(') : (', start);
    const failedBlock = dashRaw.slice(start, end);
    assert.doesNotMatch(failedBlock, /confirmRefund/);
  });
});

/* ── 3. Web dashboard receipts card (WalletManager) ────────────────────────── */

describe('web: WalletManager renders case B distinctly, using transfer_state only', () => {
  const type = readWeb('lib/business-data.ts');
  const mgr = code(readWeb('components/business/WalletManager.tsx'));
  const mgrRaw = readWeb('components/business/WalletManager.tsx');

  test('WalletReceipt carries transfer_state', () => {
    assert.match(type, /transfer_state\?: string \| null;/);
  });

  test('the component branches on transfer_state === "failed" alone', () => {
    assert.match(mgr, /r\.transfer_state === "failed" \? \(/);
  });

  test('the failed branch never renders "to you" or a fee/cashback figure', () => {
    const start = mgrRaw.indexOf('r.transfer_state === "failed" ? (');
    const end = mgrRaw.indexOf(') : (', start);
    const failedBlock = code(mgrRaw.slice(start, end));
    assert.doesNotMatch(failedBlock, /to you/);
    assert.doesNotMatch(failedBlock, /cashback_pence/);
  });

  test('the failed branch states the required facts and offers no Refund control', () => {
    const start = mgrRaw.indexOf('r.transfer_state === "failed" ? (');
    const end = mgrRaw.indexOf(') : (', start);
    const failedBlock = mgrRaw.slice(start, end);
    assert.match(failedBlock, /Failed wallet payment/);
    assert.match(failedBlock, /attempted · customer automatically refunded/);
    assert.match(failedBlock, /No payout to business/);
    assert.doesNotMatch(failedBlock, /setConfirm\(r\)/);
  });
});

/* ── 4. Full ledger, both platforms ────────────────────────────────────────── */

describe('full ledger (mobile + web): case B never claims "to you", a fee, or a net payout — and CSV carries a Merchant paid column', () => {
  const mobileRaw = read('app/local-business-transactions.tsx');
  const mobile = code(mobileRaw);
  const webRaw = readWeb('components/business/TransactionsLedger.tsx');
  const web = code(webRaw);

  test('both Txn types carry transfer_state', () => {
    assert.match(mobile, /transfer_state: string \| null;/);
    assert.match(web, /transfer_state: string \| null;/);
  });

  test('both gate the failed-row rendering on transfer_state === \'failed\' specifically — not on direction or kind alone', () => {
    assert.match(mobile, /r\.transfer_state === 'failed'/);
    assert.match(web, /r\.transfer_state === "failed"/);
  });

  test('mobile: the failed row shows "Failed wallet payment", the attempted amount, and "No payout to business" — never the Fee/Net-to-you breakdown', () => {
    const start = mobileRaw.indexOf("if (r.transfer_state === 'failed')");
    const end = mobileRaw.indexOf('// A sale\'s own amount', start);
    const block = mobileRaw.slice(start, end);
    assert.match(block, /Failed wallet payment/);
    assert.match(block, /attempted · customer automatically refunded/);
    assert.match(block, /No payout to business/);
    assert.doesNotMatch(block, /Net to you/);
    assert.doesNotMatch(block, /Fee -/);
  });

  test('mobile: the failed row\'s own refund-side wording says no fee was ever charged, not a fee "reversed"', () => {
    assert.match(mobileRaw, /automatically refunded · no fee was ever charged/);
  });

  test('mobile: the failed row shows a neutral £0.00, never a green gross or a red negative figure implying real money moved', () => {
    assert.match(mobileRaw, /<Text style={\[styles\.rowNet, styles\.rowNeutral\]}>{money\(0\)}<\/Text>/);
  });

  test('web: the failed row\'s Fee and Cashback cells show "—", and Net shows £0.00, never the stored figures', () => {
    assert.match(webRaw, /\{failed \? "—" : \(r\.fee_pence \? `− \$\{gbp\(r\.fee_pence\)\}` : "—"\)\}/);
    assert.match(webRaw, /\{failed \? gbp\(0\)/);
  });

  test('web: a dedicated "Merchant paid" column renders No/Yes, distinct from refund_state', () => {
    assert.match(web, /Merchant paid/);
    assert.match(webRaw, /\{failed \? "No" : "Yes"\}/);
  });

  test('both CSV exports add a "Merchant paid" column, derived from transfer_state, never from amounts', () => {
    assert.match(mobile, /'Merchant paid'/);
    assert.match(mobile, /r\.transfer_state === 'failed' \? 'No' : 'Yes'/);
    assert.match(web, /"Merchant paid"/);
    assert.match(web, /r\.transfer_state === "failed" \? "No" : "Yes"/);
  });

  test('neither client infers the failed state from gross/fee/net amounts — only from transfer_state', () => {
    for (const src of [mobile, web]) {
      assert.doesNotMatch(src, /gross_pence === 0 && fee_pence/i);
      assert.doesNotMatch(src, /fee_pence === net_pence/i);
    }
  });

  test('the existing Money in / Fees / Net totals computation is untouched — it already nets a failed-then-reversed pair to zero by construction, same as a genuine refund', () => {
    // These are the same totals useMemo blocks audited earlier this session;
    // confirming they still sum direction 'in'/'refund' uniformly, with no
    // new branch for transfer_state, is the proof nothing needed to change
    // here — the netting was already correct before this fix.
    assert.match(mobile, /if \(r\.direction === 'in'\) \{ grossIn \+= r\.gross_pence; fees \+= r\.fee_pence;/);
    assert.match(web, /if \(r\.direction === "in"\) \{ grossIn \+= r\.gross_pence; fees \+= r\.fee_pence;/);
    assert.doesNotMatch(mobile.slice(mobile.indexOf('const totals = useMemo'), mobile.indexOf('}, [rows]);')), /transfer_state/);
    assert.doesNotMatch(web.slice(web.indexOf('const totals = useMemo'), web.indexOf('}, [rows]);')), /transfer_state/);
  });
});

/* ── 5. Nothing about mechanics changed ────────────────────────────────────── */

describe('payment, transfer, refund and preflight logic are untouched by this reporting fix', () => {
  test('wallet-pay.ts, wallet-ledger.ts and wallet-liquidity.ts have no new reference to this fix\'s concepts', () => {
    for (const file of ['supabase/functions/_shared/wallet-pay.ts', 'supabase/functions/_shared/wallet-ledger.ts', 'supabase/functions/_shared/wallet-liquidity.ts']) {
      assert.doesNotMatch(read(file), /merchant_was_paid|Failed wallet payment|No payout to business/);
    }
  });

  test('the migration touches only the two reporting RPCs — no DDL against local_wallet_transactions, wallet_debit_with_ledger, wallet_reverse_debit or the liquidity reservation tables', () => {
    const mig = read('supabase/migrations/20261025060000_wallet_merchant_paid_flag.sql');
    assert.doesNotMatch(mig, /alter table public\.local_wallet_transactions/i);
    assert.doesNotMatch(mig, /create or replace function public\.wallet_debit_with_ledger/i);
    assert.doesNotMatch(mig, /create or replace function public\.wallet_reverse_debit/i);
    assert.doesNotMatch(mig, /wallet_liquidity_reserve|wallet_liquidity_release/);
  });

  test('every stored amount column (gross/fee/cashback/net) in both rewritten functions is byte-identical to the prior migration — only the final transfer_state column and its computation are new', () => {
    const prior = read('supabase/migrations/20261025040000_wallet_refund_kind_disambiguation.sql');
    const mig = read('supabase/migrations/20261025060000_wallet_merchant_paid_flag.sql');
    for (const amountExpr of [
      'abs(t.amount_pence) AS gross_pence, coalesce(t.platform_fee_pence, 0) AS fee_pence',
      'abs(t.amount_pence) - coalesce(t.platform_fee_pence, 0) - coalesce(t.cashback_pence, 0) AS net_pence',
      '-abs(o.amount_pence),\n           -coalesce(o.platform_fee_pence, 0),',
    ]) {
      assert.ok(prior.includes(amountExpr), `fixture check: "${amountExpr}" missing from the prior migration — update this test`);
      assert.ok(mig.includes(amountExpr), `amount computation changed: "${amountExpr}"`);
    }
  });
});

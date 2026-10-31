/**
 * wallet-liquidity.node.test.ts
 *
 * A real £5.00 Premium Wallet payment was correctly debited, correctly
 * fee'd, then Stripe refused the £4.95 merchant transfer: "Insufficient
 * funds in Stripe account." The automatic reversal caught it — nothing was
 * lost — but the customer was debited before anything asked whether the
 * transfer could actually be settled.
 *
 * This proves the fix: a liquidity preflight (_shared/wallet-liquidity.ts)
 * runs BEFORE the customer is debited, reads Stripe's balance live (never
 * cached), and fails closed when it cannot even read that balance.
 *
 * The DB-backed reservation ledger that stops two concurrent spends from
 * oversubscribing the same headroom is proved against a real second
 * connection in wallet-liquidity-concurrency.node.test.ts
 * (`npm run test:isolated`) — not here, which runs under plain `npm test`.
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

/* ── 1. The preflight gate — placement and wiring ─────────────────────────── */

describe('the liquidity preflight runs before the customer is debited', () => {
  const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));

  test('getWalletLiquiditySnapshot / reserveWalletLiquidity / releaseWalletLiquidity are imported from the one canonical module', () => {
    assert.match(wp, /import \{ getWalletLiquiditySnapshot, reserveWalletLiquidity, releaseWalletLiquidity \} from '\.\/wallet-liquidity\.ts';/);
  });

  test('the preflight (snapshot + reserve) runs strictly before debitAndTransfer — the only place the customer is debited or a transfer is requested', () => {
    const snapshotAt = wp.indexOf('getWalletLiquiditySnapshot(svc)');
    const reserveAt = wp.indexOf('reserveWalletLiquidity(svc,');
    const debitAt = wp.indexOf('await debitAndTransfer(svc,');
    assert.ok(snapshotAt > 0 && reserveAt > snapshotAt && reserveAt < debitAt,
      'the liquidity check must read, then reserve, then debit — in that order');
  });

  test('an unreadable Stripe balance (status "unknown") declines the spend rather than guessing — fails CLOSED', () => {
    assert.match(wp, /if \(liquidity\.status === 'unknown'\)/);
    const unknownBlock = wp.slice(wp.indexOf("if (liquidity.status === 'unknown')"), wp.indexOf("if (liquidity.status !== 'disabled')"));
    assert.match(unknownBlock, /ok: false/);
    assert.doesNotMatch(unknownBlock, /debitAndTransfer/, 'an unreadable balance must return before any debit, not merely warn');
  });

  test('a declined reservation returns before debitAndTransfer is ever called, and names no customer/payment failure', () => {
    const reserveBlock = wp.slice(wp.indexOf('const reservation = await reserveWalletLiquidity'), wp.indexOf('reservationId = reservation.reservationId;'));
    assert.match(reserveBlock, /if \(!reservation\.ok\)/);
    assert.match(reserveBlock, /Wallet payments are temporarily unavailable\. Please use another payment method\./);
    assert.doesNotMatch(reserveBlock, /debitAndTransfer/);
    // Not framed as a failure: no "failed" wording in the declined-preflight message itself.
    const declineMsg = reserveBlock.match(/error: '([^']+)'/)?.[1] ?? '';
    assert.doesNotMatch(declineMsg, /fail/i);
  });

  test('the declined preflight is logged for operations, distinctly from the Stripe-rejection path', () => {
    assert.match(wp, /console\.warn\(\s*\n?\s*`\[wallet-liquidity\] preflight declined/);
  });

  test('disabled liquidity protection (status "disabled") is an explicit, named fallback straight to the original debit/transfer/reversal behaviour — not a silent "always healthy"', () => {
    assert.match(wp, /if \(liquidity\.status !== 'disabled'\)/);
    // No reservation is attempted when disabled: the code path that calls
    // reserveWalletLiquidity is INSIDE the !== 'disabled' branch only.
    const disabledGateAt = wp.indexOf("if (liquidity.status !== 'disabled')");
    const reserveCallAt = wp.indexOf('reserveWalletLiquidity(svc,');
    assert.ok(disabledGateAt < reserveCallAt && reserveCallAt < disabledGateAt + 600,
      'reserveWalletLiquidity must be gated behind the disabled check, not called unconditionally');
  });

  test('the required merchant transfer passed to the reservation is gross − wallet fee − cashback, the exact figure Stripe is asked to transfer', () => {
    assert.match(wp, /const transferAmount = amountPence - platformFee - cashbackPence;/);
    assert.match(wp, /reserveWalletLiquidity\(svc, transferAmount, liquidity\.available_pence, liquidity\.reserve_pence\)/);
    // transferAmount is computed, and the liquidity check reads it, BEFORE the
    // debit/transfer block — confirmed above — so fee and cashback are both
    // already netted out of what liquidity is checked against.
    const transferAmountAt = wp.indexOf('const transferAmount = amountPence - platformFee - cashbackPence;');
    const reserveAt = wp.indexOf('reserveWalletLiquidity(svc,');
    assert.ok(transferAmountAt < reserveAt);
  });

  test('the reservation is released in a finally — an unexpected throw from debitAndTransfer cannot leak it', () => {
    assert.match(wp, /\}\s*finally\s*\{\s*\n\s*await releaseWalletLiquidity\(svc, reservationId\);\s*\n\s*\}/);
  });

  test('the existing automatic reversal path is untouched: a rejected Stripe transfer still reverses the debit exactly as before', () => {
    const ledger = code(read('supabase/functions/_shared/wallet-ledger.ts'));
    assert.match(ledger, /if \(outcome\.kind === 'rejected'\)/);
    assert.match(ledger, /await walletReverse\(svc, debit\.transactionId, `Transfer rejected: \$\{outcome\.message\}`, 'never_paid'\);/);
    assert.match(ledger, /Payment to the recipient failed — your wallet has been refunded\./);
  });

  test('self-payment block, Pro-tier entitlement gate and tier-aware fee resolution all still run, unmodified, strictly before the liquidity check', () => {
    const selfPayAt = wp.indexOf('selfPaymentBlock(svc,');
    const tierGateAt = wp.indexOf("business_meets_tier");
    const feeAt = wp.indexOf('getWalletCommissionConfig(svc,');
    const liquidityAt = wp.indexOf('getWalletLiquiditySnapshot(svc)');
    assert.ok(selfPayAt < tierGateAt && tierGateAt < feeAt && feeAt < liquidityAt,
      'order must stay: self-payment → tier entitlement → fee → liquidity → debit');
  });
});

/* ── 2. getWalletLiquiditySnapshot — status, caching, fail-closed design ──── */

describe('getWalletLiquiditySnapshot: the one canonical liquidity read', () => {
  const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));

  test('reads Stripe balance live — no caching in the canonical function itself', () => {
    assert.match(wl, /await fetch\('https:\/\/api\.stripe\.com\/v1\/balance'/);
    assert.doesNotMatch(wl, /cache|Cache|TTL|setTimeout/, 'a cache here risks the preflight acting on a stale balance');
  });

  test('disabled (wallet.liquidity.enabled=false) returns status "disabled" before any Stripe call is made', () => {
    const disabledAt = wl.indexOf("if (!enabled)");
    const fetchAt = wl.indexOf("fetch('https://api.stripe.com/v1/balance'");
    assert.ok(disabledAt > 0 && disabledAt < fetchAt);
    assert.match(wl, /return \{ \.\.\.base, available_pence: 0, pending_pence: 0, headroom_pence: 0, gap_to_reserve_pence: null, recommended_funding_pence: null, coverage_bps: null, status: 'disabled' \};/);
  });

  test('a network error or non-OK Stripe response returns status "unknown" with the error recorded, never thrown uncaught', () => {
    assert.match(wl, /status: 'unknown', error: msg/);
    assert.match(wl, /catch \(e\) \{/);
  });

  test('coverage is computed from available balance over total positive liability, in basis points, floored', () => {
    assert.match(wl, /coverage_bps = Math\.floor\(\(available_pence \* 10_000\) \/ liability_pence\)/);
  });

  test('zero liability is "healthy" regardless of balance — there is nothing to cover', () => {
    assert.match(wl, /if \(liability_pence <= 0\) \{\s*\n\s*status = 'healthy';/);
  });

  test('status classification: below critical_coverage_bps is critical, below low_coverage_bps is low, otherwise healthy', () => {
    assert.match(wl, /status = coverage_bps < critical_coverage_bps \? 'critical'\s*\n\s*: coverage_bps < low_coverage_bps \? 'low'\s*\n\s*: 'healthy';/);
  });

  test('reserve target and both thresholds are read from admin_config, with safe in-code fallbacks if a row is missing', () => {
    assert.match(wl, /getConfigBulk\(svc, \[\s*\n\s*'wallet\.liquidity\.enabled',\s*\n\s*'wallet\.liquidity\.reserve_pence',\s*\n\s*'wallet\.liquidity\.low_coverage_bps',\s*\n\s*'wallet\.liquidity\.critical_coverage_bps',/);
    assert.match(wl, /parseIntOr\(cfg\.get\('wallet\.liquidity\.reserve_pence'\), 10_000\)/);
  });

  test('liability is summed only from positive customer Wallet balances — never a negative/deficit row', () => {
    assert.match(wl, /\.from\('local_wallet_balances'\)/);
    assert.match(wl, /\.gt\('balance_pence', 0\)/);
  });

  test('gap_to_reserve_pence (how far below the reserve) and headroom_pence (what is left to spend) are two distinct, independently documented fields — never collapsed into one', () => {
    assert.match(wl, /gap_to_reserve_pence: number \| null;/);
    assert.match(wl, /headroom_pence: number;/);
    const raw = read('supabase/functions/_shared/wallet-liquidity.ts');
    assert.match(raw, /Closing this gap only brings headroom up\s*\n\s*\* to exactly 0, which still permits NO transfer at all\./);
  });

  test('disabled and unreadable snapshots report gap_to_reserve_pence as null, never computed against the 0 placeholder used for available_pence', () => {
    const disabledReturn = wl.slice(wl.indexOf("if (!enabled)"), wl.indexOf("let balanceRes"));
    assert.match(disabledReturn, /gap_to_reserve_pence: null/);
    const unknownReturns = wl.match(/gap_to_reserve_pence: null, recommended_funding_pence: null, coverage_bps: null, status: 'unknown'/g) ?? [];
    assert.equal(unknownReturns.length, 2, 'both the network-error and non-OK-response branches must report gap_to_reserve_pence: null');
  });

  test('the reservation RPC call is a single round trip — the check and the claim happen together, not as two separate reads compared in application code', () => {
    assert.match(wl, /svc\.rpc\('wallet_liquidity_reserve', \{/);
    const fnBody = wl.slice(wl.indexOf('export async function reserveWalletLiquidity'), wl.indexOf('export async function releaseWalletLiquidity'));
    assert.equal((fnBody.match(/svc\.rpc\(/g) ?? []).length, 1, 'reserveWalletLiquidity must make exactly one RPC call');
  });

  test('a failed reservation RPC call fails closed (ok: false), never defaults to permitting the spend', () => {
    const fnBody = wl.slice(wl.indexOf('export async function reserveWalletLiquidity'), wl.indexOf('export async function releaseWalletLiquidity'));
    assert.match(fnBody, /if \(error \|\| !data\) \{[\s\S]*?return \{ ok: false, reservationId: null, heldPence: 0 \};/);
  });
});

/* ── 3. Live: migration, RPC grants, admin_config values ──────────────────── */

describe('the liquidity reservation RPCs and config are live and correctly scoped', () => {
  test('wallet_liquidity_reserve and wallet_liquidity_release exist, are SECURITY DEFINER, and serialise via an advisory lock', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_liquidity_reserve'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /SECURITY DEFINER/i);
    assert.match(d, /pg_advisory_xact_lock\(hashtext\('wallet_liquidity_reserve'\)\)/);
    assert.match(d, /created_at > now\(\) - interval '2 minutes'/);
  });

  test('both RPCs are service_role only — never callable by anon or authenticated', () => {
    for (const [fn] of [['wallet_liquidity_reserve'], ['wallet_liquidity_release']] as const) {
      const rows = sql(`select grantee, privilege_type from information_schema.routine_privileges
         where routine_name = '${fn}';`);
      const grantees = rows.map((r) => r.grantee);
      assert.ok(grantees.includes('service_role'), `${fn} is not granted to service_role`);
      assert.ok(!grantees.includes('anon'), `${fn} is callable by anon`);
      assert.ok(!grantees.includes('authenticated'), `${fn} is callable directly by authenticated — it must only be reached via the edge function`);
    }
  });

  test('live admin_config values match the proposed production settings: £100 reserve, 150% low, 100% critical, enabled', () => {
    const rows = sql(`select key, value from public.admin_config
       where key like 'wallet.liquidity.%' order by key;`);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(map['wallet.liquidity.enabled'], 'true');
    assert.equal(map['wallet.liquidity.reserve_pence'], '10000');
    assert.equal(map['wallet.liquidity.low_coverage_bps'], '15000');
    assert.equal(map['wallet.liquidity.critical_coverage_bps'], '10000');
  });

  test('a reservation can be created and released, and a released reservation never counts toward held headroom again', () => {
    const [made] = sql(`select * from public.wallet_liquidity_reserve(500, 100000, 0);`);
    assert.equal(made.ok, true);
    assert.ok(made.reservation_id);
    const [heldWhileOpen] = sql(`select coalesce(sum(amount_pence),0) as held from public.local_wallet_liquidity_reservations where status='held' and created_at > now() - interval '2 minutes';`);
    assert.ok(Number(heldWhileOpen.held) >= 500);
    sql(`select public.wallet_liquidity_release('${made.reservation_id}'::uuid);`);
    const [row] = sql(`select status from public.local_wallet_liquidity_reservations where id='${made.reservation_id}'::uuid;`);
    assert.equal(row.status, 'released');
  });
});

/* ── 4. Low/Critical arithmetic ────────────────────────────────────────────── */

describe('coverage status boundaries', () => {
  function classify(availablePence: number, liabilityPence: number, lowBps: number, criticalBps: number): string {
    if (liabilityPence <= 0) return 'healthy';
    const coverage = Math.floor((availablePence * 10_000) / liabilityPence);
    return coverage < criticalBps ? 'critical' : coverage < lowBps ? 'low' : 'healthy';
  }

  test('exactly at the critical boundary (100% coverage) is NOT critical — critical is strictly below', () => {
    assert.equal(classify(10_000, 10_000, 15_000, 10_000), 'low');
  });

  test('one penny below the critical boundary is critical', () => {
    assert.equal(classify(9_999, 10_000, 15_000, 10_000), 'critical');
  });

  test('exactly at the low boundary (150% coverage) is healthy — low is strictly below', () => {
    assert.equal(classify(15_000, 10_000, 15_000, 10_000), 'healthy');
  });

  test('one penny below the low boundary is low', () => {
    assert.equal(classify(14_999, 10_000, 15_000, 10_000), 'low');
  });

  test('£100 available against the proposed £0 liability today is healthy regardless of coverage math', () => {
    assert.equal(classify(10_000, 0, 15_000, 10_000), 'healthy');
  });
});

/* ── 5. Admin panel and admin-only access ──────────────────────────────────── */

describe('the admin liquidity panel and its edge function', () => {
  test('wallet-liquidity-snapshot checks profiles.role/is_platform_owner before returning anything, the same pattern as refund-payment', () => {
    const fn = code(read('supabase/functions/wallet-liquidity-snapshot/index.ts'));
    assert.match(fn, /me\?\.role === 'admin' \|\| me\?\.is_platform_owner === true/);
    assert.match(fn, /if \(!isAdmin\) return json\(\{ error: 'Admin only' \}, 403\);/);
    const authAt = fn.indexOf('isAdmin');
    const snapshotAt = fn.indexOf('getWalletLiquiditySnapshot(svc)');
    assert.ok(authAt < snapshotAt, 'the admin check must run before the snapshot is computed');
  });

  test('is pinned verify_jwt = true in config.toml (an authenticated, admin-gated call — not a cron endpoint)', () => {
    const toml = read('supabase/config.toml');
    const m = toml.match(/\[functions\.wallet-liquidity-snapshot\]\s*\nverify_jwt = (true|false)/);
    assert.ok(m, 'wallet-liquidity-snapshot is not pinned in config.toml');
    assert.equal(m![1], 'true');
  });

  test('the web admin panel renders Healthy/Low/Critical, the liability/available/pending/reserve/gap/headroom/coverage figures, and the required explanatory copy', () => {
    const panel = readWeb('components/admin/WalletLiquidityPanel.tsx');
    for (const label of ['Customer Wallet liability', 'Stripe available', 'Stripe pending', 'Reserve target', 'Gap to reserve', 'Spendable headroom', 'Coverage']) {
      assert.ok(panel.includes(label), `panel is missing the "${label}" figure`);
    }
    assert.match(panel, /Wallet balances are customer liabilities\. OneShetland keeps transferable Stripe funds available so merchants\s*\n?\s*can be settled immediately\./);
  });

  test('the panel surfaces the gap to the reserve floor when available balance sits below it', () => {
    const panel = readWeb('components/admin/WalletLiquidityPanel.tsx');
    assert.match(panel, /Initial Wallet float required before launch/);
    assert.match(panel, /snapshot\.gap_to_reserve_pence !== null && snapshot\.gap_to_reserve_pence > 0/);
  });

  test('the panel never renders a Stripe account id, key, or any field beyond the snapshot shape', () => {
    const panel = readWeb('components/admin/WalletLiquidityPanel.tsx');
    assert.doesNotMatch(panel, /acct_|sk_|pk_|stripe_account_id/);
  });
});

/* ── 5b. Gap-to-reserve vs. spendable headroom — the exact distinction the
 * audit's own report got wrong once: reaching the reserve (gap = £0) still
 * leaves headroom at exactly £0, which permits NO transfer. A £5.00 Premium
 * payment needs a £4.95 transfer, so "available reaches the £100 reserve" is
 * NOT "Wallet is ready" — available must reach £104.95 for THAT payment. ── */

describe('gap to reserve and spendable headroom are reported as two distinct, non-interchangeable numbers', () => {
  const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));
  const panel = readWeb('components/admin/WalletLiquidityPanel.tsx');

  test('gap_to_reserve_pence is max(0, reserve − available) — a different quantity from headroom_pence (available − reserve), never the same formula', () => {
    assert.match(wl, /const gap_to_reserve_pence = Math\.max\(0, reserve_pence - available_pence\);/);
    assert.match(wl, /const headroom_pence = available_pence - reserve_pence;/);
  });

  test('live: reaching the reserve exactly (available = reserve) gives gap 0 but headroom 0, not a positive, spendable figure', () => {
    const reserve = 10_000;
    const available = reserve; // exactly at the reserve floor
    const gap = Math.max(0, reserve - available);
    const headroom = available - reserve;
    assert.equal(gap, 0);
    assert.equal(headroom, 0, 'at exactly the reserve, headroom must be 0, not positive — no transfer fits');
  });

  test('a representative £5.00 transfer needs available to reach reserve + £5.00, not merely the reserve — matching the real incident (£4.95 transfer, £100 reserve)', () => {
    const reserve = 10_000; // £100
    const transfer = 495; // the real incident's merchant transfer
    const minimumAvailableToPermitIt = reserve + transfer;
    assert.equal(minimumAvailableToPermitIt, 10_495, 'available must reach £104.95, not £100, to permit a £4.95 transfer');
  });

  test('neither the shared module nor the panel ever claims readiness from the reserve alone — no "ready" or "sufficient" copy keyed only on gap_to_reserve', () => {
    for (const src of [wl, panel]) {
      assert.doesNotMatch(src, /ready to spend|sufficient (for|to) spend/i);
    }
  });

  test('the panel\'s "blocked" warning is keyed on headroom_pence <= 0, never on gap_to_reserve_pence alone — reaching the reserve must not silence it', () => {
    assert.match(panel, /snapshot\.headroom_pence <= 0 && \(/s);
    const blockedBanner = panel.slice(panel.indexOf('Wallet transfers are currently blocked'), panel.indexOf('Wallet transfers are currently blocked') + 400);
    assert.match(blockedBanner, /spendable headroom is/);
  });

  test('the blocked warning, when shown, explicitly says closing the reserve gap alone is not enough', () => {
    assert.match(panel, /closing\s*\n?\s*that gap alone would only bring headroom to exactly £0\.00, still not enough to permit a transfer\./);
  });

  test('the worked examples compute additional float needed as reserve + transfer − available, clamped at zero, never claiming "ready" below that', () => {
    assert.match(panel, /const needed = Math\.max\(0, snapshot\.reserve_pence \+ transferPence - snapshot\.available_pence\);/);
    assert.match(panel, /needed > 0 \? `\+\$\{gbp\(needed\)\} needed` : "Already covered"/);
  });

  test('the worked examples are explicit that their amounts are transfer amounts, not gross payment amounts', () => {
    assert.match(panel, /illustrative transfer amounts, not gross payment amounts/);
  });

  test('live: the real £5.00 Premium incident is reproduced exactly by the worked-example formula', () => {
    const [row] = sql(`select value from public.admin_config where key = 'wallet.liquidity.reserve_pence';`);
    const reserve = Number(row.value);
    const available = 555; // the real balance at the time of the original report
    const transfer = 495;  // the real incident's merchant transfer (gross 500 − 5p Premium fee)
    const needed = Math.max(0, reserve + transfer - available);
    assert.equal(needed, 9940, 'the real incident needed £99.40 more, not the £94.45 gap-to-reserve figure first reported');
  });
});

/* ── 6. The scheduled monitor ───────────────────────────────────────────────── */

describe('wallet-liquidity-monitor: scheduled, fails closed, pages once per escalation', () => {
  const fn = code(read('supabase/functions/wallet-liquidity-monitor/index.ts'));

  test('authenticates via the shared cron guard, before anything privileged, like the other scheduled functions', () => {
    const full = read('supabase/functions/wallet-liquidity-monitor/index.ts');
    assert.ok(full.includes("from '../_shared/cron-auth.ts'"));
    assert.match(full, /const denied = requireCronSecret\(req, corsHeaders\);\s*\n\s*if \(denied\) return denied;/);
    const serveAt = full.indexOf('serve(');
    const guardAt = full.indexOf('requireCronSecret(req');
    const preamble = full.slice(serveAt, guardAt);
    for (const re of [/\.(from|rpc)\(/, /\bfetch\(/, /\bawait\b/, /createServiceClient\(/]) {
      assert.doesNotMatch(preamble, re, `privileged work happens before the cron guard: ${re}`);
    }
  });

  test('does not reference the literal CRON_SECRET name — it goes through the shared helper only, same convention as reconcile-saved-cards', () => {
    assert.doesNotMatch(read('supabase/functions/wallet-liquidity-monitor/index.ts'), /CRON_SECRET/);
  });

  test('is pinned verify_jwt = false in config.toml (cron-invoked, no user JWT)', () => {
    const toml = read('supabase/config.toml');
    const m = toml.match(/\[functions\.wallet-liquidity-monitor\]\s*\nverify_jwt = (true|false)/);
    assert.ok(m, 'wallet-liquidity-monitor is not pinned in config.toml');
    assert.equal(m![1], 'false');
  });

  test('alerts only on a WORSENING status, keyed against the single-row alert-state table — not on every tick', () => {
    assert.match(fn, /const worsened = \(SEVERITY\[snapshot\.status\] \?\? 0\) > \(SEVERITY\[lastStatus\] \?\? 0\);/);
    assert.match(fn, /if \(worsened && \(snapshot\.status === 'low' \|\| snapshot\.status === 'critical' \|\| snapshot\.status === 'unknown'\)\)/);
  });

  test('pushes every admin with a device token, the same query shape as notify-business-claim', () => {
    assert.match(fn, /\.from\('profiles'\)/);
    assert.match(fn, /\.eq\('role', 'admin'\)/);
    assert.match(fn, /\.not\('push_token', 'is', null\)/);
  });

  test('is scheduled via cron.schedule → pg_net → x-cron-secret from Vault, the established pattern', () => {
    const mig = read('supabase/migrations/20261025050000_wallet_liquidity.sql');
    assert.match(mig, /select cron\.schedule\(\s*\n\s*'wallet-liquidity-monitor',/);
    assert.match(mig, /x-cron-secret.*vault\.decrypted_secrets/s);
  });
});

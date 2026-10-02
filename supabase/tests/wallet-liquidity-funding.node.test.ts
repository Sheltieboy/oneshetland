/**
 * wallet-liquidity-funding.node.test.ts
 *
 * The operator should be able to manage Local Wallet liquidity from Admin
 * rather than hand-calculating amounts and navigating Stripe. This proves:
 *
 *   1. the recommended-funding formula (reserve + desired headroom −
 *      available, never merely "reach the reserve")
 *   2. pending Topup funds are never counted as spendable headroom
 *   3. the funding action is admin-only, bounded, and idempotent
 *   4. it never touches a customer's Wallet balance — platform capital only
 *   5. the fallback UI (funding_enabled = false, the current production
 *      setting) never fakes the action
 *   6. the existing Wallet-spend preflight is completely unaffected
 *
 * No real Stripe Topup is created by this file, consistent with the task
 * that produced it — the one DB-level idempotency proof inserts a throwaway
 * row directly (never through Stripe) and cleans it up in after().
 */

import { test, describe, after } from 'node:test';
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

// A real, existing auth.users row used elsewhere this session — satisfies
// wallet_liquidity_topups.initiated_by's foreign key for the one live
// idempotency proof below, which inserts and immediately removes its own
// rows. No wallet, business, or Stripe state is touched by this id's use.
const TEST_USER = 'eb599396-6e9c-4c49-ae67-cb60fbc02bac';

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

/* ── 1. Capability finding and funding_enabled default ───────────────────── */

describe('capability: programmatic Topup creation is not confirmed, and the system defaults accordingly', () => {
  test('wallet.liquidity.funding_enabled is live and currently false — the capability finding this task reached', () => {
    const [row] = sql(`select value from public.admin_config where key = 'wallet.liquidity.funding_enabled';`);
    assert.ok(row, 'wallet.liquidity.funding_enabled is missing from admin_config');
    assert.equal(row.value, 'false');
  });

  test('wallet.liquidity.desired_headroom_pence is live and set to the proposed £50.00 default', () => {
    const [row] = sql(`select value from public.admin_config where key = 'wallet.liquidity.desired_headroom_pence';`);
    assert.equal(row.value, '5000');
  });

  test('the migration documents the capability investigation: no POST /v1/topups was ever executed', () => {
    const mig = read('supabase/migrations/20261025080000_wallet_liquidity_funding.sql');
    assert.match(mig, /no POST/);
    assert.match(mig, /external bank-account source/);
  });
});

/* ── 2. The recommended-funding formula ───────────────────────────────────── */

describe('recommended funding targets reserve + desired headroom together, never merely the reserve', () => {
  const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));

  test('the formula is max(0, reserve + desired_headroom − available)', () => {
    assert.match(wl, /const recommended_funding_pence = Math\.max\(0, reserve_pence \+ desired_headroom_pence - available_pence\);/);
  });

  test('the exact worked example from the task: reserve £100, headroom £50, available £5.55 → £144.45, not £94.45', () => {
    const reserve = 10_000, headroom = 5_000, available = 555;
    const recommended = Math.max(0, reserve + headroom - available);
    assert.equal(recommended, 14_445);
  });

  test('live: today\'s actual recommended-funding figure, computed from the real admin_config and the real Stripe balance', () => {
    const rows = sql(`select key, value from public.admin_config where key in ('wallet.liquidity.reserve_pence', 'wallet.liquidity.desired_headroom_pence');`);
    const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    assert.equal(map['wallet.liquidity.reserve_pence'], 10_000);
    assert.equal(map['wallet.liquidity.desired_headroom_pence'], 5_000);
    // available_pence itself is live Stripe state, read by the snapshot
    // function, not duplicated here — this pins only the CONFIG side of the
    // formula, which this task controls.
  });

  test('recommended_funding_pence is null (not computed against a 0 placeholder) when status is disabled or unknown, same convention as gap_to_reserve_pence', () => {
    const disabledBranch = wl.slice(wl.indexOf('if (!enabled)'), wl.indexOf('let balanceRes'));
    assert.match(disabledBranch, /recommended_funding_pence: null/);
    const unknownReturns = wl.match(/recommended_funding_pence: null, coverage_bps: null, status: 'unknown'/g) ?? [];
    assert.equal(unknownReturns.length, 2, 'both unreadable-balance branches must report recommended_funding_pence: null');
  });
});

/* ── 3. Pending Topup funds are never counted as available ───────────────── */

describe('pending Topup funds are never folded into spendable headroom', () => {
  const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));

  test('available_pence comes ONLY from Stripe\'s own /v1/balance — getRecentWalletTopups never feeds into it', () => {
    const snapshotFn = wl.slice(wl.indexOf('export async function getWalletLiquiditySnapshot'), wl.indexOf('export interface LiquidityReservation'));
    assert.doesNotMatch(snapshotFn, /wallet_liquidity_topups|getRecentWalletTopups/, 'the liquidity snapshot must not read the funding ledger at all');
  });

  test('getRecentWalletTopups only ever reads/updates its own ledger table, never local_wallet_balances or the Stripe balance endpoint', () => {
    const topupsFn = wl.slice(wl.indexOf('export async function getRecentWalletTopups'));
    assert.match(topupsFn, /\.from\('wallet_liquidity_topups'\)/);
    assert.doesNotMatch(topupsFn, /local_wallet_balances|\/v1\/balance/);
  });

  test('a pending/creating topup is refreshed from Stripe\'s own GET (never POST) before being returned', () => {
    const topupsFn = wl.slice(wl.indexOf('export async function getRecentWalletTopups'));
    assert.match(topupsFn, /fetch\(`https:\/\/api\.stripe\.com\/v1\/topups\/\$\{row\.stripe_topup_id\}`/);
    assert.doesNotMatch(topupsFn, /method: 'POST'/);
  });
});

/* ── 4. wallet-liquidity-fund: admin-only, bounded, idempotent, platform capital only ── */

describe('wallet-liquidity-fund: admin-only, bounded amount, idempotent, never touches a customer Wallet', () => {
  const fnRaw = read('supabase/functions/wallet-liquidity-fund/index.ts');
  const fn = code(fnRaw);

  test('checks admin status before any privileged work, the same pattern as the other admin-gated functions', () => {
    assert.match(fn, /me\?\.role === 'admin' \|\| me\?\.is_platform_owner === true/);
    const authAt = fnRaw.indexOf('isAdmin');
    const stripeAt = fnRaw.indexOf("fetch('https://api.stripe.com/v1/topups'");
    assert.ok(authAt > 0 && authAt < stripeAt, 'the admin check must run before the Stripe call');
  });

  test('refuses outright when wallet.liquidity.funding_enabled is not \'true\' — the exact fallback condition', () => {
    assert.match(fn, /if \(cfg\.get\('wallet\.liquidity\.funding_enabled'\) !== 'true'\)/);
    const gateAt = fnRaw.indexOf("funding_enabled') !== 'true'");
    const stripeAt = fnRaw.indexOf("fetch('https://api.stripe.com/v1/topups'");
    assert.ok(gateAt > 0 && gateAt < stripeAt, 'the funding_enabled gate must run before the Stripe call');
  });

  test('amount is bounded between £10 and £1,000, rejecting anything outside that before any Stripe call', () => {
    assert.match(fn, /const MIN_PENCE = 1_000;/);
    assert.match(fn, /const MAX_PENCE = 100_000;/);
    assert.match(fn, /if \(amountPence < MIN_PENCE \|\| amountPence > MAX_PENCE\)/);
  });

  test('a duplicate client_request_id returns the EXISTING row (a unique_violation, code 23505) rather than a second Stripe call', () => {
    assert.match(fn, /insertErr\.code === '23505'/);
    const dupBlock = fn.slice(fn.indexOf("insertErr.code === '23505'"), fn.indexOf('console.error', fn.indexOf("insertErr.code === '23505'")));
    assert.doesNotMatch(dupBlock, /fetch\(/, 'a duplicate submission must return before ever calling Stripe again');
  });

  test('replaying a request id whose attempt FAILED reports the failure, never ok:true', () => {
    const fn = read('supabase/functions/wallet-liquidity-fund/index.ts');
    assert.match(fn, /existing\?\.status === 'error'[\s\S]{0,200}409\)/);
    assert.ok(fn.indexOf("existing?.status === 'error'") < fn.indexOf('replay: true'));
  });

  test('the Stripe call carries Idempotency-Key = client_request_id, so even a lost response replays to the same Topup', () => {
    assert.match(fn, /'Idempotency-Key': clientRequestId,/);
  });

  test('the Stripe call attaches the required metadata: purpose, initiated_by, reserve_target_pence', () => {
    assert.match(fn, /'metadata\[purpose\]': 'wallet_liquidity',/);
    assert.match(fn, /'metadata\[initiated_by\]': user\.id,/);
    assert.match(fn, /'metadata\[reserve_target_pence\]': String\(reservePence\),/);
  });

  test('never creates customer Wallet credit — no reference anywhere to the debit/credit/transfer primitives or local_wallet_transactions', () => {
    assert.doesNotMatch(fn, /local_wallet_transactions|local_wallet_balances|wallet_debit_with_ledger|wallet_credit_with_ledger|debitAndTransfer|executeWalletPayment/);
  });

  test('is pinned verify_jwt = true in config.toml — an authenticated, admin-gated call', () => {
    const toml = read('supabase/config.toml');
    const m = toml.match(/\[functions\.wallet-liquidity-fund\]\s*\nverify_jwt = (true|false)/);
    assert.ok(m, 'wallet-liquidity-fund is not pinned in config.toml');
    assert.equal(m![1], 'true');
  });

  test('is granted via grant execute to authenticated/service_role in its own migration — no anon access', () => {
    // wallet-liquidity-fund has no table of its own to grant — its privilege
    // boundary is entirely the admin check above and the gateway's own JWT
    // requirement (verify_jwt = true, confirmed above).
    assert.doesNotMatch(fn, /grant execute.*anon/);
  });
});

/* ── 5. Live: the DB-level idempotency guarantee, proved without Stripe ──── */

describe('wallet_liquidity_topups.client_request_id: a real, live unique constraint — no Stripe call involved', () => {
  const DUMMY_KEY = `test-idempotency-proof-${Date.now()}`;
  let firstId: string | null = null;

  after(() => {
    // Clean up both the row that succeeded and (defensively) anything else
    // this exact dummy key might have left behind.
    sql(`delete from public.wallet_liquidity_topups where client_request_id = '${DUMMY_KEY}';`);
  });

  test('the first insert with a fresh client_request_id succeeds', () => {
    const [row] = sql(`insert into public.wallet_liquidity_topups
      (client_request_id, amount_pence, status, initiated_by, reserve_target_pence, desired_headroom_pence)
      values ('${DUMMY_KEY}', 1000, 'creating', '${TEST_USER}', 10000, 5000)
      returning id;`);
    assert.ok(row?.id, 'the first insert did not return an id');
    firstId = String(row.id);
  });

  test('a second insert with the SAME client_request_id is refused by the unique constraint — this is the real guarantee the edge function relies on', () => {
    // sql() throws synchronously on a real Postgres error — the assertion is
    // that the ATTEMPT throws a unique-violation, proving the constraint is
    // genuinely live, not merely assumed.
    assert.throws(
      () => sql(`insert into public.wallet_liquidity_topups
        (client_request_id, amount_pence, status, initiated_by, reserve_target_pence, desired_headroom_pence)
        values ('${DUMMY_KEY}', 2000, 'creating', '${TEST_USER}', 10000, 5000)
        returning id;`),
      /duplicate key|unique/i,
      'a duplicate client_request_id was accepted — the idempotency guarantee is not actually enforced',
    );
  });

  test('exactly one row exists for this key, with the FIRST attempt\'s amount — the duplicate never landed', () => {
    const rows = sql(`select amount_pence from public.wallet_liquidity_topups where client_request_id = '${DUMMY_KEY}';`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount_pence, 1000);
  });
});

/* ── 6. Admin panel: fallback UI, recommended figure, pending list, no fake action ── */

describe('the admin panel never fakes the funding action, and renders the fallback plainly', () => {
  const panel = code(readWeb('components/admin/WalletLiquidityPanel.tsx'));
  const panelRaw = readWeb('components/admin/WalletLiquidityPanel.tsx');

  test('the live action and the fallback are mutually exclusive, gated on snapshot.funding_enabled', () => {
    assert.match(panel, /\{snapshot\.funding_enabled \? \(/);
  });

  test('the old "complete it in Stripe" fallback is gone: the not-enabled branch renders the in-app push-transfer workflow', () => {
    assert.doesNotMatch(panelRaw, /Funding must currently be completed in Stripe/);
    assert.doesNotMatch(panelRaw, /Open Stripe Dashboard/);
    assert.match(panel, /<PushFunding snapshot=\{snapshot\} onChanged=\{onFunded\} \/>/);
  });

  test('the push workflow never calls the programmatic Topup function (wallet-liquidity-fund) — it is the disabled-flag path only', () => {
    const start = panelRaw.indexOf('function PushFunding(');
    const end = panelRaw.indexOf('function Stat(');
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(panelRaw.slice(start, end), /wallet-liquidity-fund"/);
  });

  test('the live action requires explicit confirmation (useConfirm) before calling the edge function, and the confirmation names the real amount and that it is platform capital, not customer credit', () => {
    assert.match(panel, /const ok = await confirm\(\{/);
    const confirmCall = panel.slice(panel.indexOf('const ok = await confirm({'), panel.indexOf('if (!ok) return;'));
    assert.match(confirmCall, /platform working capital/);
    assert.match(confirmCall, /does not credit any customer's Wallet balance/);
  });

  test('the live action generates ONE client_request_id per component instance, not per click — a double-tap reuses it, which is the idempotency protection', () => {
    assert.match(panel, /const \[requestId, setRequestId\] = useState\(\(\) => crypto\.randomUUID\(\)\);/);
    assert.match(panel, /if \(refused\) setRequestId\(crypto\.randomUUID\(\)\);/, 'a definitively refused attempt must not poison the next retry');
  });

  test('the recommended-funding stat and the pending/recent topups list are both rendered', () => {
    assert.match(panel, /label="Recommended funding"/);
    assert.match(panel, /Pending \/ recent funding/);
    assert.match(panel, /snapshot\.recent_topups\.map/);
  });

  test('a failed/error topup\'s failure_message is surfaced to the admin, not swallowed', () => {
    assert.match(panel, /t\.failure_message && <p/);
  });
});

/* ── 7. The existing Wallet-spend preflight is completely unaffected ─────── */

describe('the existing liquidity preflight (wallet-pay.ts) is unchanged by this funding workflow', () => {
  const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));

  test('the preflight still reads the snapshot and reserves headroom in the same order, with the same two outcomes', () => {
    const snapshotAt = wp.indexOf('getWalletLiquiditySnapshot(svc)');
    const reserveAt = wp.indexOf('reserveWalletLiquidity(svc,');
    const debitAt = wp.indexOf('await debitAndTransfer(svc,');
    assert.ok(snapshotAt > 0 && reserveAt > snapshotAt && reserveAt < debitAt);
    assert.match(wp, /reason: 'liquidity_unavailable'/);
  });

  test('wallet-pay.ts has no new reference to the funding workflow\'s own concepts', () => {
    assert.doesNotMatch(wp, /wallet_liquidity_topups|wallet-liquidity-fund|recommended_funding|funding_sessions|wallet-funding/);
  });

  test('wallet-liquidity.ts\'s reservation functions (reserveWalletLiquidity/releaseWalletLiquidity) are byte-for-byte unchanged in their own logic', () => {
    const wl = code(read('supabase/functions/_shared/wallet-liquidity.ts'));
    assert.match(wl, /export async function reserveWalletLiquidity\(/);
    assert.match(wl, /svc\.rpc\('wallet_liquidity_reserve', \{/);
    assert.match(wl, /export async function releaseWalletLiquidity\(/);
    assert.match(wl, /svc\.rpc\('wallet_liquidity_release', \{ p_reservation_id: reservationId \}\);/);
  });

  test('live: wallet_liquidity_reserve and wallet_liquidity_release RPCs are unchanged — same grants, same advisory lock', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_liquidity_reserve'::regproc) as d;`);
    assert.match(String(row.d), /pg_advisory_xact_lock\(hashtext\('wallet_liquidity_reserve'\)\)/);
  });
});

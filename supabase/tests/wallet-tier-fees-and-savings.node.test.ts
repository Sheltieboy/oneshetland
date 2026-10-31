/**
 * wallet-tier-fees-and-savings.node.test.ts
 *
 * Economic audit of a real £1.00 Wallet payment found the flat 2%+25p fee
 * genuinely poor for small transactions (27% on that one payment), and —
 * separately — that a wallet SPEND incurs no Stripe cost of its own at all
 * (proved against real balance_transactions: the Connect transfer and the
 * one real payout both carry fee:0). The only real external cost in the
 * whole lifecycle is the card-processing fee paid once, at top-up.
 *
 * This replaces the single global wallet rate with a tier-aware one
 * (Pro 1.5%, Premium 1.0%, both admin-configurable, fixed fee now 0 —
 * percentage-only), resolved server-side from the business's OWN current
 * subscription_tier — never from anything a client supplies — and adds a
 * configurable "estimated saving vs a typical card payment" merchant
 * metric, built from an explicitly non-authoritative admin-set benchmark.
 *
 * Nothing about the debit/transfer/refund primitives changed. The fee is
 * still just an integer parameter `wallet_debit_with_ledger` stores verbatim
 * on the transaction row and `wallet_reverse_debit`/get_business_transactions
 * read back from that SAME row — this file proves that explicitly, because
 * it is now load-bearing in a way it wasn't when the rate never changed.
 *
 * Run: npm test
 */

import './_support/production-lane-guard.ts';   // fail closed: this file can contact production (see that module)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(export )?(async function|function|const|type|interface) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

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
  // The guard statement returns zero rows (where false), so every row here
  // comes from the real query — no need to slice to "the last result set".
  return parsed.rows ?? [];
}

/* ── 1. Server-side tier resolution — never a client-supplied tier ───────── */

describe('getWalletCommissionConfig resolves the rate from the business\'s OWN current tier, server-side', () => {
  const src = code(read('supabase/functions/_shared/commission-config.ts'));
  const fn = functionBody(src, 'getWalletCommissionConfig');

  test('it takes a businessId, not a tier — there is no tier parameter to spoof', () => {
    assert.match(src, /export async function getWalletCommissionConfig\(\s*supabase: SupabaseClient,\s*businessId: string,\s*\): Promise<CommissionConfig>/);
  });

  test('the tier is read fresh from local_businesses.subscription_tier, not trusted from a caller-supplied object', () => {
    assert.match(fn, /\.from\('local_businesses'\)/);
    assert.match(fn, /\.select\('subscription_tier'\)/);
    assert.match(fn, /\.eq\('id', businessId\)/);
  });

  test('premium resolves to fees.wallet.premium_percent_bps, anything else resolves to fees.wallet.pro_percent_bps', () => {
    assert.match(fn, /const tier: 'pro' \| 'premium' = biz\?\.subscription_tier === 'premium' \? 'premium' : 'pro';/);
    assert.match(fn, /tier === 'premium' \? 'fees\.wallet\.premium_percent_bps' : 'fees\.wallet\.pro_percent_bps'/);
  });

  test('an unreadable tier fails safe to Pro\'s rate, never Premium\'s', () => {
    // biz may be null/undefined on a read error; the ternary above already
    // defaults anything that isn't literally 'premium' to 'pro'.
    assert.doesNotMatch(fn, /biz\?\.subscription_tier !== 'pro' \? 'premium'/);
  });

  test('the old global fees.wallet.percent_bps is kept as a fallback, not removed', () => {
    assert.match(fn, /legacyKey = 'fees\.wallet\.percent_bps'/);
    assert.match(fn, /legacyPercent !== null/);
  });

  test('executeWalletPayment calls this, not the generic per-rail getCommissionConfig, and passes business.id — not a tier', () => {
    const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));
    assert.match(wp, /import \{ getWalletCommissionConfig \} from '\.\/commission-config\.ts';/);
    assert.match(wp, /const walletCfg = await getWalletCommissionConfig\(svc, business\.id\);/);
    assert.doesNotMatch(wp, /getCommissionConfig\(svc, 'wallet'\)/, 'the old untiered lookup must be gone');
  });
});

/* ── 2. Below-Pro entitlement and self-payment protection are untouched ──── */

describe('nothing about entitlement, self-payment or the money primitives changed', () => {
  const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));

  test('the Pro-tier entitlement gate is still there, unmodified, and still runs before any fee is computed', () => {
    assert.match(wp, /business_meets_tier/);
    assert.match(wp, /p_required_tier: 'pro'/);
    const gateIdx = wp.indexOf('business_meets_tier');
    const feeIdx = wp.indexOf('getWalletCommissionConfig('); // the call site, not the top-of-file import
    assert.ok(gateIdx < feeIdx, 'the tier gate must still run before the fee is ever looked up');
  });

  test('the self-payment block is still called with the resolved destination account, unchanged', () => {
    assert.match(wp, /selfPaymentBlock\(svc, userId, sellerAccountId\)/);
  });

  test('debitAndTransfer is still called exactly once, still takes platformFee as a plain number — not a config object', () => {
    assert.equal((wp.match(/await debitAndTransfer\(/g) ?? []).length, 1);
    assert.match(wp, /platformFeePence: platformFee,/);
  });
});

/* ── 3. The savings benchmark RPC — live, read-only checks ───────────────── */

describe('get_wallet_savings_benchmark() is live, correctly scoped, and returns the configured values', () => {
  test('the function exists, is SECURITY DEFINER, and is readable only by authenticated/service_role — never anon', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_wallet_savings_benchmark'::regproc) as d;`);
    assert.match(String(row.d), /SECURITY DEFINER/);
    assert.match(String(row.d), /card_percent_bps/);
    assert.match(String(row.d), /card_fixed_pence/);
  });

  test('anon cannot execute it; authenticated can', () => {
    const [row] = sql(`
      select has_function_privilege('anon', 'public.get_wallet_savings_benchmark()', 'execute') as anon_can,
             has_function_privilege('authenticated', 'public.get_wallet_savings_benchmark()', 'execute') as auth_can;`);
    assert.equal(row.anon_can, false);
    assert.equal(row.auth_can, true);
  });

  test('live values match the production go-live configuration: 175 bps, 0 fixed, enabled', () => {
    const [row] = sql(`select * from public.get_wallet_savings_benchmark();`);
    assert.equal(row.card_percent_bps, 175);
    assert.equal(row.card_fixed_pence, 0);
    assert.equal(row.enabled, true);
  });

  test('live wallet tier config matches the go-live rates: Pro 150bps, Premium 100bps, fixed 0', () => {
    const rows = sql(`select key, value from public.admin_config
       where key in ('fees.wallet.pro_percent_bps','fees.wallet.premium_percent_bps','fees.wallet.fixed_pence')
       order by key;`);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(map['fees.wallet.fixed_pence'], '0');
    assert.equal(map['fees.wallet.premium_percent_bps'], '100');
    assert.equal(map['fees.wallet.pro_percent_bps'], '150');
  });

  test('the legacy global key is untouched in value — still 200 — so nothing that still reads it silently changes behaviour', () => {
    const [row] = sql(`select value from public.admin_config where key = 'fees.wallet.percent_bps';`);
    assert.equal(row.value, '200');
  });
});

/* ── 4. Historical fee immutability — refund reverses the ORIGINAL fee ───── */

describe('a transaction\'s fee is written once and never recalculated from current config', () => {
  test('wallet_debit_with_ledger stores platform_fee_pence as a plain parameter — no config lookup inside the SQL function at all', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_debit_with_ledger'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /p_platform_fee integer DEFAULT NULL::integer/);
    assert.doesNotMatch(d, /admin_config/, 'the debit primitive must not read config — the fee arrives pre-computed from the caller');
  });

  test('wallet_reverse_debit computes the refund amount from the ORIGINAL row\'s own stored columns, never from admin_config', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_reverse_debit'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /v_cashback := coalesce\(v_orig\.cashback_pence, 0\)/);
    assert.match(d, /v_amount   := abs\(v_orig\.amount_pence\) - v_cashback/);
    assert.doesNotMatch(d, /admin_config|platform_fee_pence \* |platform_fee_pence \+ /, 'the reversal must not recompute or blend in a fee from current config');
  });

  test('wallet_credit_with_ledger (the refund credit itself) writes no fee/cashback columns at all — the merchant-ledger view reads the fee from the ORIGINAL spend row, not the refund row', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_credit_with_ledger'::regproc) as d;`);
    const d = String(row.d);
    assert.doesNotMatch(d, /platform_fee_pence/, 'a refund row must not carry its own fee figure to recompute from');
  });

  test('get_business_transactions\' refund branch reads fee/cashback/net straight off the ORIGINAL ("o") row — proving the historical figure, not a current one, reaches the merchant ledger and the CSV', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_business_transactions'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /-coalesce\(o\.platform_fee_pence, 0\)/);
    assert.match(d, /-coalesce\(o\.cashback_pence, 0\)/);
  });
});

/* ── 4b. A refund's kind names what it reverses, live ─────────────────────── */

describe('get_business_transactions disambiguates a refund\'s kind by what it reverses, live', () => {
  test('branch 8 resolves kind against the ORIGINAL ("o") row, the same way branch 1 resolves a sale\'s kind, and no longer emits the generic "wallet_refund"', () => {
    const [row] = sql(`select pg_get_functiondef('public.get_business_transactions'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /\(coalesce\(funded\.kind, 'wallet_payment'\) \|\| '_refund'\)::text/);
    assert.doesNotMatch(d, /'wallet_refund'/, 'the undisambiguated generic kind must be gone from the live function');
  });

  test('wallet_reverse_debit takes no amount parameter — every reversal is a full reversal of the original spend, so a partial refund is not a row this calculator will ever see', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_reverse_debit'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /CREATE OR REPLACE FUNCTION public\.wallet_reverse_debit\(p_transaction_id uuid, p_reason text DEFAULT NULL::text, p_merchant text DEFAULT NULL::text\)/);
    assert.doesNotMatch(d, /p_amount/, 'a reversal must not take a caller-chosen amount — partial refunds are not supported');
  });

  test('a second reversal of the same spend is refused as already-done, not accepted as a further partial credit', () => {
    const [row] = sql(`select pg_get_functiondef('public.wallet_reverse_debit'::regproc) as d;`);
    const d = String(row.d);
    assert.match(d, /already_reversed/);
    assert.match(d, /select id into v_existing from public\.local_wallet_transactions\s+where reverses_transaction_id = p_transaction_id/);
  });
});

/* ── 5. The savings calculator — client-side formula, both platforms ─────── */

describe('the savings calculator: scoped correctly, clamped correctly, gated correctly', () => {
  test('both platforms scope the comparison to genuine wallet_payment rows only — never a wallet-funded gift/pass/product sale, which is charged at a different rail\'s rate', () => {
    for (const src of [code(read('app/local-business-transactions.tsx')), code(readWeb('components/business/TransactionsLedger.tsx'))]) {
      assert.match(src, /r\.direction === ["']in["'] && r\.kind === ["']wallet_payment["']/);
    }
  });

  test('both compute the benchmark fee with the same formula calculateCommission itself uses: floor(abs(gross)*bps/10000) + fixed, signed back onto the row\'s own sign', () => {
    for (const src of [code(read('app/local-business-transactions.tsx')), code(readWeb('components/business/TransactionsLedger.tsx'))]) {
      assert.match(src, /const sign = r\.gross_pence < 0 \? -1 : 1;/);
      assert.match(src, /sign \* \(Math\.floor\(\(Math\.abs\(r\.gross_pence\) \* benchmark[!?.]?\.?card_percent_bps\) \/ 10_000\) \+ benchmark[!?.]?\.?card_fixed_pence\)/);
    }
  });

  test('a refund\'s benchmark fee is the exact negative of its sale\'s, never off by a penny from floor() rounding a negative number the wrong way', () => {
    // floor(-x) rounds further from zero than floor(x) rounds toward it for
    // any x with a non-zero fractional part, so computing the benchmark fee
    // directly on a signed (possibly negative) gross_pence would make a
    // refund's contribution one penny MORE negative than its sale's was
    // positive — the pair would no longer cancel exactly. Deriving the
    // magnitude from Math.abs() first, then reapplying the row's own sign,
    // is what keeps a sale and its full refund exact mirrors of each other.
    const saleGross = 2050, bps = 175, fixed = 0;
    const naiveRefund = Math.floor((-saleGross * bps) / 10_000) + fixed;
    const saleFee = Math.floor((saleGross * bps) / 10_000) + fixed;
    assert.notEqual(-saleFee, naiveRefund, 'this fixture no longer demonstrates the rounding trap — pick another amount');
    const signAwareRefund = (-1) * (Math.floor((Math.abs(-saleGross) * bps) / 10_000) + fixed);
    assert.equal(signAwareRefund, -saleFee, 'the sign-aware formula must exactly mirror the sale');
  });

  test('both platforms also include a genuine till payment\'s own refund (kind "wallet_payment_refund") in the comparison, so a refunded sale nets to zero rather than continuing to count as a saving', () => {
    for (const src of [code(read('app/local-business-transactions.tsx')), code(readWeb('components/business/TransactionsLedger.tsx'))]) {
      assert.match(src, /r\.direction === ["']refund["'] && r\.kind === ["']wallet_payment_refund["']/);
    }
  });

  test('a refund of something wallet-FUNDED (gift/pass/product/ticket) is excluded by the same kind check — only "wallet_payment_refund" qualifies, not the generic retired "wallet_refund"', () => {
    for (const src of [code(read('app/local-business-transactions.tsx')), code(readWeb('components/business/TransactionsLedger.tsx'))]) {
      assert.doesNotMatch(src, /kind === ["']wallet_refund["']/, 'the generic, undisambiguated refund kind must no longer be matched anywhere');
    }
  });

  test('both KIND_LABEL maps still show every refund as plain "Refund", regardless of what it reversed', () => {
    for (const src of [read('app/local-business-transactions.tsx'), readWeb('components/business/TransactionsLedger.tsx')]) {
      for (const kind of ['wallet_payment_refund', 'product_sale_refund', 'pass_sale_refund', 'gift_sale_refund', 'ticket_sale_refund']) {
        assert.match(src, new RegExp(`${kind}:\\s*['"]Refund['"]`), `${kind} is missing from KIND_LABEL — it would display as the raw kind string`);
      }
    }
  });

  test('estimated savings is clamped at a minimum of zero — never shown as a confusing negative figure', () => {
    for (const src of [code(read('app/local-business-transactions.tsx')), code(readWeb('components/business/TransactionsLedger.tsx'))]) {
      assert.match(src, /Math\.max\(0, cardFees - walletFees\)/);
    }
  });

  test('the whole metric is gated on benchmark.enabled, and hides cleanly (returns/renders null) rather than showing £0.00 when disabled or empty', () => {
    const mobile = code(read('app/local-business-transactions.tsx'));
    const web = code(readWeb('components/business/TransactionsLedger.tsx'));
    assert.match(mobile, /if \(!benchmark \|\| !benchmark\.enabled\) return null;/);
    assert.match(web, /if \(!benchmark \|\| !benchmark\.enabled\) return null;/);
    assert.match(mobile, /if \(walletRows\.length === 0\) return null;/);
    assert.match(web, /if \(walletRows\.length === 0\) return null;/);
  });

  test('the merchant-facing copy explicitly disclaims this as a configured benchmark, not the merchant\'s real rate', () => {
    const mobile = read('app/local-business-transactions.tsx');
    const web = readWeb('components/business/TransactionsLedger.tsx');
    assert.match(mobile, /not your actual card-processing rate/);
    assert.match(web, /not your actual card-processing rate/);
  });

  test('both expose Wallet sales / Wallet fees / Benchmark fees as a supporting breakdown, not just one bare number', () => {
    const mobile = read('app/local-business-transactions.tsx');
    const web = readWeb('components/business/TransactionsLedger.tsx');
    for (const src of [mobile, web]) {
      assert.match(src, /savings\.sales/);
      assert.match(src, /savings\.walletFees/);
      assert.match(src, /savings\.cardFees/);
    }
  });

  test('the per-row proof on mobile is scoped to wallet_payment rows only and only shown when genuinely positive', () => {
    const mobile = code(read('app/local-business-transactions.tsx'));
    assert.match(mobile, /if \(saved > 0\) breakdown\.push\(`saved \$\{money\(saved\)\} vs card`\);/);
  });
});

/* ── 6. Fee resolution is NOT silently broken for any existing consumer ──── */

describe('getCommissionConfig (the generic per-rail resolver every OTHER rail still uses) is completely untouched', () => {
  test('the function signature, defaults and every other rail\'s behaviour are unchanged', () => {
    const src = code(read('supabase/functions/_shared/commission-config.ts'));
    assert.match(src, /export async function getCommissionConfig\(/);
    assert.match(src, /fetch:      \{ percent_bps:   0, fixed_pence: 150 \}/);
    assert.match(src, /product:    \{ percent_bps: 400, fixed_pence:   0 \}/);
  });

  test('gift and unit wallet-funded purchases still use their own rail\'s commission, not the wallet rate — unmodified by this change', () => {
    const giftSrc = code(read('supabase/functions/create-gift-intent/index.ts'));
    assert.match(giftSrc, /getCommissionConfig\(supabase, 'gift'\)/);
    assert.doesNotMatch(giftSrc, /getWalletCommissionConfig/);
  });
});

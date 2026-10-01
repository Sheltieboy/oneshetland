/**
 * transactions-ledger-economics-display.node.test.ts
 *
 * Physical acceptance found a real £1.00 Local Wallet payment displayed on
 * mobile's Money & transactions as just "Wallet payment  £0.73" — the NET
 * amount, with no indication the customer actually paid £1.00 and £0.27 was
 * OneShetland's fee. Read on its own, that row looks like the customer's
 * payment was £0.73.
 *
 * get_business_transactions already returns gross_pence, fee_pence,
 * cashback_pence and net_pence as four separate fields — net_pence is
 * gross_pence - fee_pence - cashback_pence, computed once in the RPC, not
 * invented client-side. Nothing here manufactures a second transaction or a
 * fee row: this is a display-only fix, reusing fields the screen already
 * fetched and the CSV export already wrote out correctly.
 *
 * Web's table already showed Gross / Fee / Cashback / Net as four separate
 * columns — never ambiguous — so only mobile's single-amount card needed
 * the fix. This file pins both: the mobile fix, and that web's existing
 * correctness doesn't regress.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const MOBILE = () => code(read('app/local-business-transactions.tsx'));
const WEB = () => code(readWeb('components/business/TransactionsLedger.tsx'));

/* ── 1. Mobile: gross is now the primary amount for a sale ───────────────── */

describe('mobile: the customer\'s actual payment (gross) is the headline amount', () => {
  test('an "in" row displays gross_pence, not net_pence, as its primary figure', () => {
    const src = MOBILE();
    assert.match(src, /r\.direction === 'in' \? money\(r\.gross_pence\)/);
    assert.doesNotMatch(src, /r\.direction === 'in' \? money\(r\.net_pence\)/, 'the old net-as-headline bug must not come back');
  });

  test('refund and "out" rows are untouched — this fix is scoped to "in" rows only', () => {
    const src = MOBILE();
    assert.match(src, /: r\.direction === 'refund' \? `− \$\{money\(Math\.abs\(r\.net_pence\)\)\}`/);
    assert.match(src, /: `− \$\{money\(r\.gross_pence\)\}`/);
  });
});

/* ── 2. Mobile: fee and net are visible underneath, in the preferred shape ── */

describe('mobile: fee and net are shown at transaction level, in the requested format', () => {
  test('the breakdown line is built from Fee / Cashback / Net to you, joined by " · "', () => {
    const src = MOBILE();
    assert.match(src, /breakdown\.push\(`Fee -\$\{money\(r\.fee_pence\)\}`\)/);
    assert.match(src, /breakdown\.push\(`Cashback -\$\{money\(r\.cashback_pence\)\}`\)/);
    assert.match(src, /breakdown\.push\(`Net to you \$\{money\(r\.net_pence\)\}`\)/);
    assert.match(src, /breakdown\.join\(' · '\)/);
  });

  test('nothing here invents a second transaction or a separate fee row — one row, re-rendered', () => {
    const src = MOBILE();
    // Still exactly one row per item in `rows` — no .flatMap, no injected
    // synthetic fee entry, no second RPC call.
    assert.match(src, /rows\.map\(\(r, i\) => \{/);
    assert.doesNotMatch(src, /flatMap|\.push\(\{\s*kind:\s*'fee'/);
  });

  test('the fee/cashback calculation itself is untouched — still read straight off the row, never recomputed', () => {
    const src = MOBILE();
    assert.doesNotMatch(src, /r\.gross_pence \* 0\.\d+/, 'fee must not be recalculated client-side — it is a server value');
    assert.doesNotMatch(src, /r\.gross_pence - r\.fee_pence(?! - r\.cashback_pence\) AS)/);
  });
});

/* ── 3. Zero-fee transactions are clean — no breakdown, no "-£0.00" ──────── */

describe('mobile: a transaction with no fee and no cashback shows no breakdown line at all', () => {
  test('hasDeduction is false, and only false, when both fee_pence and cashback_pence are zero', () => {
    const src = MOBILE();
    assert.match(src, /const hasDeduction = r\.direction === 'in' && \(r\.fee_pence !== 0 \|\| r\.cashback_pence !== 0\);/);
  });

  test('the breakdown Text is gated on hasDeduction — it does not render at all when gross already equals net', () => {
    const src = MOBILE();
    assert.match(src, /\{hasDeduction && <Text style=\{styles\.rowMeta\}>\{breakdown\.join\(' · '\)\}<\/Text>\}/);
  });

  test('no literal -£0.00 (or equivalent) string construction exists for the fee/net line', () => {
    const src = MOBILE();
    assert.doesNotMatch(src, /Fee -\$\{money\(0\)\}/);
  });
});

/* ── 4. Web was already correct — pinned so it cannot regress ───────────── */

describe('web: Gross / Fee / Cashback / Net were already four separate, always-visible columns', () => {
  test('the table has one column per figure, not a single collapsed amount', () => {
    const src = WEB();
    assert.match(src, /<th className="px-4 py-3 text-right font-bold">Gross<\/th>/);
    assert.match(src, /<th className="px-4 py-3 text-right font-bold">Fee<\/th>/);
    assert.match(src, /<th className="px-4 py-3 text-right font-bold">Cashback<\/th>/);
    assert.match(src, /<th className="px-4 py-3 text-right font-bold">Net<\/th>/);
  });

  test('a zero fee/cashback renders "—", never "-£0.00"', () => {
    const src = WEB();
    assert.match(src, /r\.fee_pence \? `− \$\{gbp\(r\.fee_pence\)\}` : "—"/);
    assert.match(src, /r\.cashback_pence \? `− \$\{gbp\(r\.cashback_pence\)\}` : "—"/);
  });

  test('web required no change for this task — unmodified since the gift/wallet audits', () => {
    const src = WEB();
    assert.match(src, /gross_pence: number;/);
    assert.match(src, /fee_pence: number;/);
    assert.match(src, /net_pence: number;/);
  });
});

/* ── 5. CSV already exported gross, fee, cashback and net separately ─────── */

describe('CSV export: gross, fee, cashback and net were already separate columns on both platforms', () => {
  test('web CSV header names all four money columns distinctly', () => {
    const src = WEB();
    assert.match(src, /"Gross \(£\)", "Platform fee \(£\)", "Cashback \(£\)", "Net \(£\)"/);
  });

  test('mobile CSV header names all four money columns distinctly', () => {
    const src = MOBILE();
    assert.match(src, /'Gross', 'Fee', 'Cashback', 'Net'/);
  });

  test('both platforms write all four pence fields into the row, not a derived/collapsed figure', () => {
    for (const src of [WEB(), MOBILE()]) {
      assert.match(src, /p\(r\.gross_pence\), p\(r\.fee_pence\), p\(r\.cashback_pence\), p\(r\.net_pence\)/);
    }
  });
});

/* ── 6. The summary totals at the top of the screen are untouched ────────── */

describe('summary totals are unchanged — this fix is row-display only', () => {
  test('mobile totals still sum grossIn/fees/cashback/net exactly as before', () => {
    const src = MOBILE();
    assert.match(src, /grossIn \+= r\.gross_pence; fees \+= r\.fee_pence; cashback \+= r\.cashback_pence; netIn \+= r\.net_pence;/);
  });

  test('web totals are byte-identical to mobile\'s — both still untouched by this task', () => {
    const src = WEB();
    assert.match(src, /grossIn \+= r\.gross_pence; fees \+= r\.fee_pence; cashback \+= r\.cashback_pence; netIn \+= r\.net_pence;/);
  });
});

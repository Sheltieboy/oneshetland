/**
 * business-payout-status-parity.node.test.ts — mobile and web now ask the
 * same question about a business's payout status.
 *
 * WHAT WAS WRONG
 *
 * Merchant-facing payout status had drifted from the canonical rule (Phase 1
 * of this work fixed the SERVER-side payment paths; this is the DASHBOARD/
 * STATUS-DISPLAY side):
 *
 *   · web's dashboard Home ("Payouts ready" / "Payouts not set up",
 *     lib/business-dashboard.server.ts) read the dead
 *     business_stripe_payouts_enabled column whenever a business had
 *     use_business_payout=true — a column populated on zero businesses — so
 *     every such business was told "Payouts not set up" regardless of truth.
 *   · web's WalletManager ("Stripe connected · ready for payouts" / "Connect
 *     Stripe to accept wallet payments", plus the accept-toggle and
 *     Connect-Stripe-button visibility) read business.payout_enabled
 *     directly — the business's OWN account only, with no owner-
 *     central-account fallback.
 *   · mobile's "Accept Local Wallet" card and its accept-toggle pre-flight
 *     check (app/local-business-dashboard.tsx) had the identical
 *     activeBusiness.payout_enabled gap.
 *   · mobile's Me tab business list (app/(tabs)/me.tsx) independently read
 *     business_stripe_payouts_enabled too — the same dead-column bug as web,
 *     on a different screen.
 *
 * THE FIX
 *
 * Every one of those four now asks business_payout_ready(p_business) — the
 * same canonical function Phase 1 already wired into every payment path —
 * fetched once per business load and reused, never re-derived from
 * stripe_account_id / payout_enabled / business_stripe_payouts_enabled /
 * use_business_payout individually. The canonical resolver itself
 * (_business_payout_resolve / business_payout_ready / business_payout_destination)
 * is untouched by this phase — its Route A / Route B / neither correctness is
 * proven separately by marketplace-readiness.node.test.ts.
 *
 * Two rows were deliberately left alone on both platforms: mobile's "Payout
 * bank account" toggle row and web's BillingManager equivalent. Both answer a
 * narrower question — "is THIS business's OWN account connected, or is
 * verification still in progress" — that only makes sense when
 * use_business_payout is true, and the single canonical boolean cannot
 * decompose into that finer state. Changing those would have been a
 * regression (losing "Verification in progress"), not a fix.
 *
 * WHAT IS ASSERTED
 *   · mobile's fetchBusinessPayoutReady, executed for real against a mocked
 *     RPC, reports ready exactly when the RPC says true — the same answer
 *     regardless of whether Route A or Route B produced it, since the client
 *     never sees which route resolved, only the boolean (this is what makes
 *     mobile and web answer identically for the same business: both trust
 *     the one function, not a reconstruction of its logic)
 *   · web's getBusinessPayoutReady and business-dashboard.server.ts's
 *     payoutReady both resolve via the same RPC and the same p_business
 *     parameter shape mobile uses — parity by construction, not by
 *     coincidence
 *   · the dead column and the raw-column reconstruction are gone from every
 *     fixed spot on both platforms
 *   · the two narrower own-account rows are untouched
 *   · existing Connect/setup actions (handleConnectStripe,
 *     createBusinessOnboardingLink, connectBank) are unchanged
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions and a mocked-RPC execution of mobile's plain
 * fetch helper — web's getBusinessPayoutReady needs Next.js's server/cookie
 * context to actually run, so it is verified by source inspection rather
 * than execution, consistent with how this repo already tests other
 * *.server.ts files. Resolver correctness itself (which route a real
 * business actually resolves to) is proven live by
 * marketplace-readiness.node.test.ts, not re-proven here.
 *
 * SAFETY
 * No Supabase call, no database write, no Stripe call. The one "RPC" in this
 * file is a local mock object, not a network call.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

/** Lift a named function's full source (declaration through matching brace). */
function liftFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `end of ${decl} not found`);
  return src.slice(start, end + 1);
}

/* ── 1-4, 10. Mobile's helper, executed for real against a mocked RPC ────── */

describe('mobile\'s fetchBusinessPayoutReady reports ready exactly when the canonical RPC says true — both routes, indistinguishably', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib/local-api.ts'), 'utf8');
  const fnSrc = liftFn(code(src), 'export async function fetchBusinessPayoutReady(');

  function run(mockResult: { data: unknown; error: unknown }): Promise<boolean> {
    const js = ts.transpileModule(
      `const supabase = { rpc: async (_name, _args) => (${JSON.stringify(mockResult)}) };\n` +
      fnSrc.replace('export async function', 'async function') +
      `\nmodule.exports = fetchBusinessPayoutReady;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
    ).outputText;
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', js)(mod, mod.exports);
    return (mod.exports as (id: string) => Promise<boolean>)('biz-1');
  }

  test('1 & 3. RPC says true (either route resolved it) → ready', async () => {
    assert.equal(await run({ data: true, error: null }), true);
  });

  test('5. RPC says false (no valid route) → not ready', async () => {
    assert.equal(await run({ data: false, error: null }), false);
  });

  test('an unreadable RPC (error) fails closed → not ready, never a guess', async () => {
    assert.equal(await run({ data: null, error: { message: 'boom' } }), false);
  });

  test('the function calls business_payout_ready with p_business, not a raw column read', () => {
    assert.match(fnSrc, /supabase\.rpc\('business_payout_ready', \{ p_business: businessId \}\)/);
    assert.doesNotMatch(fnSrc, /stripe_account_id|payout_enabled|use_business_payout/);
  });
});

/* ── 2, 4, 10. Web's helper and the dashboard computation — source-level ── */

describe('web\'s payout-ready sources call the same canonical RPC with the same parameter shape', () => {
  test('getBusinessPayoutReady (lib/business-data.server.ts) calls business_payout_ready with p_business', () => {
    const src = code(readWeb('lib/business-data.server.ts'));
    const fnSrc = liftFn(src, 'export async function getBusinessPayoutReady(');
    assert.match(fnSrc, /sb\.rpc\("business_payout_ready", \{ p_business: businessId \}\)/);
    assert.match(fnSrc, /return data === true;/);
    assert.doesNotMatch(fnSrc, /stripe_account_id|payout_enabled|use_business_payout|business_stripe_payouts_enabled/);
  });

  test('business-dashboard.server.ts (dashboard Home\'s "Payouts ready" status) uses the same RPC, not a reconstruction', () => {
    const src = code(readWeb('lib/business-dashboard.server.ts'));
    assert.match(src, /sb\.rpc\("business_payout_ready", \{ p_business: businessId \}\)/);
    assert.match(src, /const payoutReady = bool\(payoutReadyRes as never\);/);
  });

  test('6. the dead business_stripe_payouts_enabled column is gone from the dashboard\'s payoutReady computation', () => {
    const src = code(readWeb('lib/business-dashboard.server.ts'));
    assert.doesNotMatch(src, /business_stripe_payouts_enabled/);
    assert.doesNotMatch(src, /business_private_fields/, 'the RPC that only fed the old reconstruction should no longer be fetched here');
  });

  test('the mobile and web RPC calls agree on shape: same function name, same parameter name, same p_business value — this is why they agree for any given business, not by coincidence', () => {
    const mobileFn = liftFn(code(readFileSync(join(REPO_ROOT, 'lib/local-api.ts'), 'utf8')), 'export async function fetchBusinessPayoutReady(');
    const webFn = liftFn(code(readWeb('lib/business-data.server.ts')), 'export async function getBusinessPayoutReady(');
    for (const fn of [mobileFn, webFn]) {
      assert.match(fn, /business_payout_ready/);
      assert.match(fn, /p_business:\s*businessId/);
    }
  });
});

/* ── 7. Mobile no longer independently approximates the resolver ────────── */

describe('mobile\'s merchant-facing payout displays no longer independently approximate the resolver', () => {
  test('the "Accept Local Wallet" card reads the fetched payoutReady state; its accept-toggle actually re-checks fresh — both trace back to business_payout_ready, neither to activeBusiness.payout_enabled', () => {
    // UPDATE — the canonical payout-readiness work, Phase 3 (paid-activation
    // gating). The CARD DISPLAY still reads the cached payoutReady state
    // fetched once per business load, exactly as this test originally
    // asserted (assertions below, unchanged). The TOGGLE'S PRE-FLIGHT CHECK
    // was deliberately changed to re-run requirePayoutReadyForPaidActivation
    // fresh, rather than trust that same cached state: payoutReady is Phase
    // 2's DISPLAY value, which can go stale between the dashboard's load and
    // the moment the merchant actually flips the switch (e.g. they connected
    // Stripe in another tab and haven't reloaded). The activation GATE must
    // not risk enabling Wallet on a stale "ready". See
    // payout-activation-gate.node.test.ts for full behavioural coverage of
    // this toggle.
    const src = code(read('app/local-business-dashboard.tsx'));
    assert.match(src, /if \(value && !\(await requirePayoutReadyForPaidActivation\(activeBusiness\.id\)\)\) \{/,
      'toggleAcceptWallet must re-check the canonical RPC fresh, not the cached display state');
    assert.match(src, /\{payoutReady\s*\n\s*\? 'Stripe connected · ready for payouts'/);
    assert.match(src, /\{payoutReady && \(\s*\n\s*<Switch/);
    assert.match(src, /\{!payoutReady \? \(/);
  });

  test('payoutReady is fetched once per business load via fetchBusinessPayoutReady, not per render', () => {
    const src = code(read('app/local-business-dashboard.tsx'));
    assert.match(src, /fetchBusinessPayoutReady\(target\.id\)\.catch\(\(\) => false\)/);
    assert.match(src, /setPayoutReady\(payoutIsReady\);/);
    // Exactly one call site for the fetch — inside loadAll's own batch, not
    // scattered across multiple effects or event handlers.
    const calls = src.match(/fetchBusinessPayoutReady\(/g) ?? [];
    assert.equal(calls.length, 1, 'fetchBusinessPayoutReady should be called from exactly one place (loadAll), and its result reused via state everywhere else');
  });

  test('me.tsx\'s "Payout bank" pill uses payout_ready (canonical), not the dead business_stripe_payouts_enabled column', () => {
    const src = code(read('app/(tabs)/me.tsx'));
    assert.match(src, /backgroundColor: biz\.payout_ready \? colors\.jobsLight : '#FEF3C7'/);
    assert.match(src, /color: biz\.payout_ready \? colors\.jobs : '#92400E'/);
    assert.doesNotMatch(src, /biz\.business_stripe_payouts_enabled \? colors\.jobsLight/, 'the dead-column pill colour must be gone');
    assert.doesNotMatch(src, /biz\.business_stripe_payouts_enabled \? 'Business bank' : 'Setup needed'/, 'the dead-column ready/not-ready text must be gone');
  });

  test('me.tsx fetches payout_ready once per business alongside the existing private-fields fetch, in the same load — not a second, separate effect', () => {
    const src = code(read('app/(tabs)/me.tsx'));
    assert.match(src, /fetchBusinessPayoutReady\(b\.id\)/);
    assert.match(src, /payout_ready: payoutReady/);
    const calls = src.match(/fetchBusinessPayoutReady\(/g) ?? [];
    assert.equal(calls.length, 1);
  });
});

/* ── 9. Own-account sub-status rows and Connect/setup actions unchanged ─── */

describe('the narrower own-account sub-status rows are untouched, and existing Connect/setup actions are unchanged', () => {
  test('mobile\'s "Payout bank account" toggle row still reads the business\'s own account columns — a genuinely different, narrower question the canonical boolean cannot decompose into', () => {
    const src = code(read('app/local-business-dashboard.tsx'));
    assert.match(src, /\(activeBusiness as any\)\.use_business_payout\s*\n\s*\? activeBusiness\.payout_enabled/);
    assert.match(src, /'Verification in progress'/, 'the own-account nuance must survive — a single boolean cannot express it');
  });

  test('web\'s BillingManager payout-bank row still reads the business\'s own account columns, unchanged', () => {
    const src = code(readWeb('components/business/BillingManager.tsx'));
    assert.match(src, /b\.use_business_payout \? \(b\.payout_enabled \? "✓ Business bank connected" : "Business bank — setup needed"\) : "Using your central OneShetland bank"/);
  });

  test('mobile\'s handleConnectStripe / createBusinessOnboardingLink and web\'s connectBank are untouched by this phase', () => {
    const mobileSrc = code(read('app/local-business-dashboard.tsx'));
    assert.match(mobileSrc, /const handleConnectStripe = async \(\) => \{/);
    assert.match(mobileSrc, /createBusinessOnboardingLink\(activeBusiness\.id\)/);
    const webSrc = code(readWeb('components/business/WalletManager.tsx'));
    assert.match(webSrc, /async function connectBank\(\) \{/);
    assert.match(webSrc, /createBusinessOnboardingLink\(b\.id\)/);
  });

  test('WalletManager now takes payoutReady as an explicit prop, sourced from the server, not recomputed client-side', () => {
    const src = code(readWeb('components/business/WalletManager.tsx'));
    assert.match(src, /payoutReady: boolean;/);
    assert.doesNotMatch(src, /b\.payout_enabled/, 'every readiness usage must be the prop, not the raw column');
    const page = code(readWeb('app/business/[id]/manage/wallet/page.tsx'));
    assert.match(page, /getBusinessPayoutReady\(business\.id\)/);
    assert.match(page, /payoutReady=\{payoutReady\}/);
  });

  test('Phase 2 added no payout gate to product/pass/event publishing — that arrived later, in Phase 3, on schedule', () => {
    // UPDATE — the canonical payout-readiness work, Phase 3 (paid-activation
    // gating). This test originally asserted the ABSENCE of any
    // business_payout_ready reference on these six activation surfaces, to
    // prove Phase 2 (dashboard/status display only) hadn't prematurely
    // started gating activation. Phase 3 has since been implemented and
    // deployed-to-source exactly as planned: every one of these six now
    // calls requirePayoutReadyForPaidActivation (which itself calls
    // business_payout_ready) at the moment a paid capability would go live.
    // That is the fix arriving, not a regression — this test is flipped to
    // assert the gate now exists, rather than deleted. Full behavioural
    // coverage (free-vs-paid, ready-vs-not, editing-is-not-a-new-activation,
    // etc.) lives in payout-activation-gate.node.test.ts; this assertion is
    // just presence-on-the-six-approved-surfaces, kept here for continuity
    // with the boundary this test used to guard.
    for (const path of ['app/business-products.tsx', 'app/local-book-units.tsx', 'app/event-create.tsx']) {
      const src = code(read(path));
      assert.match(src, /requirePayoutReadyForPaidActivation/, `${path} must gate paid activation`);
    }
    for (const path of ['components/business/ProductsManager.tsx', 'components/business/UnitItemsManager.tsx', 'components/business/BusinessEventForm.tsx']) {
      const src = code(readWeb(path));
      assert.match(src, /requirePayoutReadyForPaidActivation/, `${path} must gate paid activation`);
    }
  });
});

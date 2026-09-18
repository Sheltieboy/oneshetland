/**
 * payout-setup-launcher.node.test.ts — the contextual "Connect Stripe"
 * follow-up to Phase 3 (payout-activation-gate.node.test.ts).
 *
 * WHAT WAS WRONG
 * Every paid-activation guard's Connect Stripe action — event publishing,
 * product activation, pass activation, Wallet activation — handed the
 * confirm prompt a router.push to the dashboard's Money tab (mobile) or the
 * Plan & payouts screen (web). OneShetland already knew exactly which
 * onboarding flow this business needed; the merchant had to navigate to a
 * general settings screen and find the same control a second time to reach
 * it.
 *
 * THE FIX
 * One reusable action per platform, startOrResumePayoutSetup(businessId) in
 * both lib/payout-readiness.ts files, launches the correct existing Stripe
 * onboarding flow directly:
 *
 *   · already business_payout_ready → nothing is started
 *   · use_business_payout (from business_private_fields, owner-checked, not
 *     a raw column read) → the business's own Connect account, via the
 *     existing createBusinessOnboardingLink (local-business-onboard)
 *   · otherwise → the owner's central account, via the existing
 *     startPayoutOnboarding (create-connect-account)
 *
 * Both onboarding calls are unchanged, existing mechanisms — see
 * lib/local-api.ts / lib/payment-state.ts (mobile) and
 * lib/business-client.ts / lib/payment-state.ts (web) — and both already
 * resume an existing Stripe account rather than creating a second one; this
 * file does not re-prove that (business-payout-canonical-resolver.node.test.ts
 * and the two edge functions themselves already do).
 *
 * WHAT THIS FILE CANNOT PROVE
 * Execution happens against a hand-lifted copy of startOrResumePayoutSetup
 * with its own module-level dependencies replaced by controllable mocks — a
 * source edit that silently changes its logic without matching the lift
 * markers fails the lift, not silently passes. It does not spin up React,
 * Next.js, Expo Router or a browser; the Wallet/Products/Passes/Events UI
 * wiring is checked by source assertion (does this call site invoke the
 * shared launcher, not the old billing/settings navigation), not by
 * rendering a screen.
 *
 * SAFETY
 * No Supabase call, no database, no network, no Stripe call, no real popup
 * or browser sheet. Every dependency here is a local mock.
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

/**
 * Lift a named function's full source (declaration through matching brace).
 * Finds the body's opening brace as the LAST '{' on the signature line,
 * rather than the first '{' after the parameter list — this function's own
 * return type, Promise<{ ready: boolean }>, has braces of its own that the
 * simpler "first { after )" heuristic would latch onto instead.
 */
function liftFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} not found`);
  const sigEnd = src.indexOf('\n', src.indexOf(')', start));
  const open = src.lastIndexOf('{', sigEnd);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `end of ${decl} not found`);
  return src.slice(start, end + 1);
}

function runJs(js: string): unknown {
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const transpile = (tsSrc: string) =>
  ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

const mobileSrc = read('lib/payout-readiness.ts');
const webSrc = readWeb('lib/payout-readiness.ts');
const mobileFn = code(mobileSrc).replace('export async function startOrResumePayoutSetup', 'async function startOrResumePayoutSetup');
const webFnBody = code(webSrc).replace('export async function startOrResumePayoutSetup', 'async function startOrResumePayoutSetup');

type Calls = { ready: boolean; readyCalls: number; usedOwn: boolean | undefined; business: boolean; central: boolean; opened: string | null };

/**
 * Runs mobile's startOrResumePayoutSetup for real, against controllable
 * mocks for every one of its module-level dependencies — the same shape as
 * payout-activation-gate.node.test.ts's runMobile/runWeb.
 */
function runMobile(opts: {
  ready: boolean; useOwnAccount: boolean;
  businessUrl?: string | null; centralUrl?: string | null; centralAlreadyComplete?: boolean;
}): { result: Promise<{ ready: boolean }>; calls: Calls } {
  const fnSrc = liftFn(mobileFn, 'async function startOrResumePayoutSetup(');
  const calls: Calls = { ready: opts.ready, readyCalls: 0, usedOwn: undefined, business: false, central: false, opened: null };
  const js = transpile(`
    let readyCalls = 0;
    async function requirePayoutReadyForPaidActivation(_id) { readyCalls++; return ${JSON.stringify(opts.ready)}; }
    async function fetchBusinessPrivate(_id) { return { use_business_payout: ${JSON.stringify(opts.useOwnAccount)} }; }
    async function createBusinessOnboardingLink(_id) { __calls.business = true; return { url: ${JSON.stringify(opts.businessUrl ?? 'https://connect.stripe.com/business')} }; }
    async function startPayoutOnboarding() { __calls.central = true; return { url: ${JSON.stringify(opts.centralUrl ?? 'https://connect.stripe.com/central')}, alreadyComplete: ${JSON.stringify(!!opts.centralAlreadyComplete)} }; }
    const WebBrowser = {
      WebBrowserPresentationStyle: { PAGE_SHEET: 'PAGE_SHEET' },
      openBrowserAsync: async (url) => { __calls.opened = url; return { type: 'dismiss' }; },
    };
    ${fnSrc}
    module.exports = async (id) => {
      const r = await startOrResumePayoutSetup(id);
      __calls.readyCalls = readyCalls;
      return r;
    };
  `);
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
  return { result: (mod.exports as (id: string) => Promise<{ ready: boolean }>)('biz-1'), calls };
}

function runWeb(opts: {
  ready: boolean; useOwnAccount: boolean;
  businessUrl?: string | null; centralUrl?: string | null; centralAlreadyComplete?: boolean;
}): { result: Promise<{ ready: boolean }>; calls: Calls } {
  const fnSrc = liftFn(webFnBody, 'async function startOrResumePayoutSetup(');
  const calls: Calls = { ready: opts.ready, readyCalls: 0, usedOwn: undefined, business: false, central: false, opened: null };
  const js = transpile(`
    let readyCalls = 0;
    async function requirePayoutReadyForPaidActivation(_id) { readyCalls++; return ${JSON.stringify(opts.ready)}; }
    async function createBusinessOnboardingLink(_id) { __calls.business = true; return { url: ${JSON.stringify(opts.businessUrl ?? 'https://connect.stripe.com/business')} }; }
    async function startPayoutOnboarding() { __calls.central = true; return { url: ${JSON.stringify(opts.centralUrl ?? 'https://connect.stripe.com/central')}, alreadyComplete: ${JSON.stringify(!!opts.centralAlreadyComplete)} }; }
    const fakePopup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
    function createClient() {
      return { rpc: (_name, _args) => ({ maybeSingle: async () => ({ data: { use_business_payout: ${JSON.stringify(opts.useOwnAccount)} } }) }) };
    }
    function openStripePopup() { return fakePopup; }
    function waitForClose(popup) { __calls.opened = popup.location.href; return Promise.resolve(); }
    ${fnSrc}
    module.exports = async (id) => {
      const r = await startOrResumePayoutSetup(id);
      __calls.readyCalls = readyCalls;
      return r;
    };
  `);
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
  return { result: (mod.exports as (id: string) => Promise<{ ready: boolean }>)('biz-1'), calls };
}

/* ════════════════════════════════════════════════════════════════════════
   8. Already canonically ready → nothing is started, on either platform.
   ════════════════════════════════════════════════════════════════════════ */

describe('8. a canonically ready business never has onboarding started for it', () => {
  test('mobile: ready=true short-circuits before any routing decision or Stripe call', async () => {
    const { result, calls } = runMobile({ ready: true, useOwnAccount: true });
    const r = await result;
    assert.equal(r.ready, true);
    assert.equal(calls.business, false, 'must not call createBusinessOnboardingLink');
    assert.equal(calls.central, false, 'must not call startPayoutOnboarding');
    assert.equal(calls.opened, null, 'must not open any browser sheet');
  });

  test('web: ready=true short-circuits before any routing decision or Stripe call', async () => {
    const { result, calls } = runWeb({ ready: true, useOwnAccount: true });
    const r = await result;
    assert.equal(r.ready, true);
    assert.equal(calls.business, false);
    assert.equal(calls.central, false);
    assert.equal(calls.opened, null);
  });

  test('stale client state resolves the same way as always-ready: a fresh check runs every call, never a cached read', async () => {
    const mobile = runMobile({ ready: true, useOwnAccount: false });
    await mobile.result;
    assert.equal(mobile.calls.readyCalls, 1, 'exactly one fresh RPC check, not a cached prop');
  });
});

/* ════════════════════════════════════════════════════════════════════════
   9 & 10. Canonical routing: use_business_payout picks the destination.
   ════════════════════════════════════════════════════════════════════════ */

describe('9 & 10. central vs business-specific routing follows use_business_payout, the same signal _business_payout_resolve uses', () => {
  test('mobile: use_business_payout=false → the OWNER\'s central onboarding (startPayoutOnboarding), never the business-specific one', async () => {
    const { result, calls } = runMobile({ ready: false, useOwnAccount: false });
    await result;
    assert.equal(calls.central, true, 'central onboarding must be started');
    assert.equal(calls.business, false, 'business-specific onboarding must not be started');
  });

  test('mobile: use_business_payout=true → the BUSINESS\'s own onboarding (createBusinessOnboardingLink), never the central one', async () => {
    const { result, calls } = runMobile({ ready: false, useOwnAccount: true });
    await result;
    assert.equal(calls.business, true, 'business-specific onboarding must be started');
    assert.equal(calls.central, false, 'central onboarding must not be started');
  });

  test('web: use_business_payout=false → the OWNER\'s central onboarding, never the business-specific one', async () => {
    const { result, calls } = runWeb({ ready: false, useOwnAccount: false });
    await result;
    assert.equal(calls.central, true);
    assert.equal(calls.business, false);
  });

  test('web: use_business_payout=true → the BUSINESS\'s own onboarding, never the central one', async () => {
    const { result, calls } = runWeb({ ready: false, useOwnAccount: true });
    await result;
    assert.equal(calls.business, true);
    assert.equal(calls.central, false);
  });

  test('parity: both platforms decide the SAME way from the SAME signal — use_business_payout, not a raw payout_enabled/stripe_account_id read', () => {
    assert.match(mobileFn, /priv\.use_business_payout === true/);
    assert.match(webFnBody, /use_business_payout === true/);
    assert.doesNotMatch(liftFn(mobileFn, 'async function startOrResumePayoutSetup('), /payout_enabled|stripe_account_id/);
    assert.doesNotMatch(liftFn(webFnBody, 'async function startOrResumePayoutSetup('), /payout_enabled|stripe_account_id/);
  });

  test('mobile reads use_business_payout via the owner-checked fetchBusinessPrivate RPC wrapper, not a raw table select', () => {
    assert.match(liftFn(mobileFn, 'async function startOrResumePayoutSetup('), /fetchBusinessPrivate\(businessId\)/);
    assert.doesNotMatch(liftFn(mobileFn, 'async function startOrResumePayoutSetup('), /\.from\(['"]local_businesses['"]\)/);
  });

  test('web reads use_business_payout via the owner-checked business_private_fields RPC, not a raw table select', () => {
    const fn = liftFn(webFnBody, 'async function startOrResumePayoutSetup(');
    assert.match(fn, /business_private_fields/);
    assert.doesNotMatch(fn, /\.from\(["']local_businesses["']\)/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   2 & 7. The real onboarding/resume mechanism is invoked; an existing
   incomplete account is resumed, never duplicated.
   ════════════════════════════════════════════════════════════════════════ */

describe('2 & 7. the real onboarding mechanism runs, and an already-existing account is resumed rather than duplicated', () => {
  test('mobile: a returned URL is actually opened in the existing WebBrowser sheet', async () => {
    const { result, calls } = runMobile({ ready: false, useOwnAccount: false, centralUrl: 'https://connect.stripe.com/resume-me' });
    await result;
    assert.equal(calls.opened, 'https://connect.stripe.com/resume-me');
  });

  test('web: a returned URL is actually navigated to in the existing popup', async () => {
    const { result, calls } = runWeb({ ready: false, useOwnAccount: true, businessUrl: 'https://connect.stripe.com/resume-me-too' });
    await result;
    assert.equal(calls.opened, 'https://connect.stripe.com/resume-me-too');
  });

  test('mobile: central "already complete" (an existing account Stripe now reports ready) opens nothing and just re-reads readiness — createBusinessOnboardingLink is never called as a fallback', async () => {
    const { result, calls } = runMobile({ ready: false, useOwnAccount: false, centralAlreadyComplete: true });
    await result;
    assert.equal(calls.opened, null);
    assert.equal(calls.business, false);
  });

  test('web: central "already complete" opens nothing and just re-reads readiness', async () => {
    const { result, calls } = runWeb({ ready: false, useOwnAccount: false, centralAlreadyComplete: true });
    await result;
    assert.equal(calls.opened, null);
    assert.equal(calls.business, false);
  });

  test('resuming never creates a second Stripe account: both onboarding calls this delegates to are the existing, unmodified resolve-then-link functions', () => {
    // local-business-onboard resolves business.stripe_account_id before ever
    // calling Stripe's accounts endpoint; create-connect-account resolves
    // profiles/driver_profiles first. Neither is touched by this task — see
    // both edge functions' own "if (!accountId)" guards.
    const onboardFn = read('supabase/functions/local-business-onboard/index.ts');
    assert.match(onboardFn, /let accountId = business\.stripe_account_id;\s*\n\s*if \(!accountId\)/);
    const connectFn = read('supabase/functions/create-connect-account/index.ts');
    assert.match(connectFn, /let accountId: string = prof\?\.stripe_account_id \|\| drv\?\.stripe_account_id/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   6. Payment-CARD setup is never invoked for a payout-readiness blocker.
   ════════════════════════════════════════════════════════════════════════ */

describe('6. payment-card setup is never reachable from a payout-readiness blocker', () => {
  test('mobile: startOrResumePayoutSetup never references card-on-file / has_payment_method machinery', () => {
    const fn = liftFn(mobileFn, 'async function startOrResumePayoutSetup(');
    assert.doesNotMatch(fn, /card/i);
    assert.doesNotMatch(fn, /has_payment_method|setup-card|SetupIntent/);
  });

  test('web: startOrResumePayoutSetup never references card-on-file / has_payment_method machinery', () => {
    const fn = liftFn(webFnBody, 'async function startOrResumePayoutSetup(');
    assert.doesNotMatch(fn, /card/i);
    assert.doesNotMatch(fn, /has_payment_method|SetupIntent|fetchCardOnFile/);
  });

  test('the two functions it DOES call are payout-only by name, on both platforms', () => {
    for (const src of [mobileFn, webFnBody]) {
      const fn = liftFn(src, 'async function startOrResumePayoutSetup(');
      assert.match(fn, /createBusinessOnboardingLink|startPayoutOnboarding/);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   1, 3, 4, 5, 11, 12. Every contextual activation surface calls the shared
   launcher instead of merely navigating to general settings, and Event
   Manage's own return context is preserved.
   ════════════════════════════════════════════════════════════════════════ */

const SURFACES: Array<{ label: string; file: string; web?: boolean }> = [
  { label: '1 & 11. mobile event-manage.tsx (Event Manage\'s own banner/status strip)', file: 'app/event-manage.tsx' },
  { label: '1. mobile business-events.tsx (the management list\'s draft rows)',        file: 'app/business-events.tsx' },
  { label: '1. mobile event-create.tsx (saved-as-draft prompt)',                       file: 'app/event-create.tsx' },
  { label: '3. mobile business-products.tsx (product activation)',                     file: 'app/business-products.tsx' },
  { label: '4. mobile local-book-units.tsx (pass activation)',                         file: 'app/local-book-units.tsx' },
  { label: '5. mobile local-business-dashboard.tsx (Wallet activation)',               file: 'app/local-business-dashboard.tsx' },
];

const WEB_SURFACES: Array<{ label: string; file: string }> = [
  { label: '5. web WalletManager.tsx (Wallet activation)',            file: 'components/business/WalletManager.tsx' },
  { label: '3. web ProductsManager.tsx (product activation)',         file: 'components/business/ProductsManager.tsx' },
  { label: '4. web UnitItemsManager.tsx (pass activation)',           file: 'components/business/UnitItemsManager.tsx' },
  { label: '1. web BusinessEventForm.tsx (saved-as-draft prompt)',    file: 'components/business/BusinessEventForm.tsx' },
  { label: '1 & 11. web BusinessEventManage.tsx (Event Manage\'s own banner)', file: 'components/business/BusinessEventManage.tsx' },
  { label: '1. web ConnectStripeToPublishLink.tsx (the management list\'s draft rows)', file: 'components/business/ConnectStripeToPublishLink.tsx' },
];

describe('every contextual paid-activation surface calls startOrResumePayoutSetup, mobile', () => {
  for (const s of SURFACES) {
    test(`${s.label} — calls the shared launcher and does not merely navigate to the dashboard's Money tab for this`, () => {
      const src = code(read(s.file));
      assert.match(src, /startOrResumePayoutSetup\(/, `${s.file} must call startOrResumePayoutSetup`);
    });
  }

  test('event-manage.tsx no longer routes Connect Stripe through router.push to the dashboard', () => {
    const src = code(read('app/event-manage.tsx'));
    const goConnect = src.slice(src.indexOf('const goConnectStripe ='), src.indexOf('const goConnectStripe =') + 400);
    assert.doesNotMatch(goConnect, /router\.push/);
  });

  test('business-events.tsx no longer routes Connect Stripe through router.push to the dashboard', () => {
    const src = code(read('app/business-events.tsx'));
    const goConnect = src.slice(src.indexOf('const goConnectStripe ='), src.indexOf('const goConnectStripe =') + 400);
    assert.doesNotMatch(goConnect, /router\.push/);
  });

  test('business-products.tsx no longer routes Connect Stripe through router.push to the dashboard', () => {
    const src = code(read('app/business-products.tsx'));
    const goConnect = src.slice(src.indexOf('const goConnectStripe ='), src.indexOf('const goConnectStripe =') + 400);
    assert.doesNotMatch(goConnect, /router\.push/);
  });

  test('the dashboard\'s own explicit "use my own business bank" toggle control is untouched — it is not a contextual guard, it IS the general control the toggle asked for', () => {
    const src = code(read('app/local-business-dashboard.tsx'));
    assert.match(src, /const handleConnectStripe = async \(\) => \{/);
    assert.match(src, /createBusinessOnboardingLink\(activeBusiness\.id\)/, 'unconditionally business-specific, exactly as the toggle intends');
    // But the Wallet card's OWN Connect Stripe control (a genuine contextual
    // guard) must use the new, branching launcher instead.
    assert.match(src, /const handleConnectStripeContextual = async \(\) => \{[\s\S]{0,300}startOrResumePayoutSetup\(activeBusiness\.id\)/);
  });
});

describe('every contextual paid-activation surface calls startOrResumePayoutSetup, web', () => {
  for (const s of WEB_SURFACES) {
    test(`${s.label} — calls the shared launcher and does not merely navigate to manage/billing for this`, () => {
      const src = code(readWeb(s.file));
      assert.match(src, /startOrResumePayoutSetup\(/, `${s.file} must call startOrResumePayoutSetup`);
    });
  }

  test('BusinessEventForm.tsx no longer routes the Connect Stripe confirm to manage/billing, and returns to the event it just saved', () => {
    const src = code(readWeb('components/business/BusinessEventForm.tsx'));
    const block = src.slice(src.indexOf('EVENT_SAVED_AS_DRAFT_PROMPT'));
    assert.doesNotMatch(block.slice(0, block.indexOf('router.push')), /manage\/billing/);
    assert.match(src, /router\.push\(`\/business\/\$\{businessId\}\/manage\/events\/\$\{targetId\}`\)/, '11. must still land on the event it just saved');
  });

  test('BusinessEventManage.tsx\'s goConnectStripe no longer routes to manage/billing', () => {
    const src = code(readWeb('components/business/BusinessEventManage.tsx'));
    const fn = liftFn(src, 'async function goConnectStripe(');
    assert.doesNotMatch(fn, /manage\/billing/);
  });

  test('WalletManager.tsx\'s connectBank no longer routes to manage/billing and no longer assumes createBusinessOnboardingLink unconditionally', () => {
    const src = code(readWeb('components/business/WalletManager.tsx'));
    const fn = liftFn(src, 'async function connectBank(');
    assert.doesNotMatch(fn, /manage\/billing/);
    assert.doesNotMatch(fn, /createBusinessOnboardingLink/, 'routing is now delegated to startOrResumePayoutSetup, not decided here');
  });

  test('the dashboard\'s own explicit "use my own business bank" toggle control (BillingManager) is untouched — general settings keep working as-is', () => {
    const src = code(readWeb('components/business/BillingManager.tsx'));
    assert.match(src, /async function connectBank\(\) \{/);
    assert.match(src, /createBusinessOnboardingLink\(b\.id\)/);
  });
});

describe('12. mobile/web semantics match: both await the SAME shape from startOrResumePayoutSetup', () => {
  test('both functions return a fresh { ready } after the onboarding UI closes, not before', () => {
    assert.match(liftFn(mobileFn, 'async function startOrResumePayoutSetup('), /return \{ ready: await requirePayoutReadyForPaidActivation\(businessId\) \};/);
    assert.match(liftFn(webFnBody, 'async function startOrResumePayoutSetup('), /return \{ ready: await requirePayoutReadyForPaidActivation\(businessId\) \};/);
  });

  test('both take exactly (businessId), no returnContext plumbing — the onboarding UI is a modal/popup on the caller\'s own screen, not a redirect away from it', () => {
    assert.match(mobileSrc, /export async function startOrResumePayoutSetup\(businessId: string\): Promise<\{ ready: boolean \}>/);
    assert.match(webSrc, /export async function startOrResumePayoutSetup\(businessId: string\): Promise<\{ ready: boolean \}>/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Untouched by this task: canonical resolver, Stripe server routing,
   account-creation rules, publication requirements.
   ════════════════════════════════════════════════════════════════════════ */

describe('untouched by this task', () => {
  test('_business_payout_resolve and business_payout_ready are not edited', () => {
    const sql = read('supabase/migrations/20260822160000_business_payout_and_product_read.sql');
    assert.match(sql, /create or replace function public\._business_payout_resolve/);
    assert.match(sql, /create or replace function public\.business_payout_ready/);
  });

  test('the two onboarding edge functions are not edited by this task (both still create Express accounts and account_links exactly as before)', () => {
    const onboardFn = read('supabase/functions/local-business-onboard/index.ts');
    assert.match(onboardFn, /type:\s*'account_onboarding'/);
    const connectFn = read('supabase/functions/create-connect-account/index.ts');
    assert.match(connectFn, /type: 'account_onboarding'/);
  });

  test('requirePayoutReadyForPaidActivation itself — the actual gate — is untouched on both platforms', () => {
    assert.match(mobileSrc, /export async function requirePayoutReadyForPaidActivation\(businessId: string\): Promise<boolean> \{\s*\n\s*const \{ data, error \} = await supabase\.rpc\('business_payout_ready', \{ p_business: businessId \}\);\s*\n\s*return !error && data === true;/);
  });
});

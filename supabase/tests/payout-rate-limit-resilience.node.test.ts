/**
 * payout-rate-limit-resilience.node.test.ts — graceful handling of a rate-limited
 * Stripe payout-onboarding launch (follow-up to payout-loading-feedback.node.test.ts).
 *
 * WHAT WENT WRONG
 * Opening several onboarding entry points in quick succession showed
 * "Stripe onboarding failed — Too many requests". That text is not Stripe's: it
 * is the literal body enforceRateLimit() (supabase/functions/_shared/rate-limit.ts)
 * returns with HTTP 429 when local-business-onboard or create-connect-account
 * trips its per-account ceiling (rate_limit_policies actions stripe_account /
 * stripe_any). Both functions call it BEFORE touching Stripe or the database,
 * so a 429 can never create an account or alter one — this file proves that
 * ordering from source rather than assuming it. (Errors thrown from inside
 * those functions, including any Stripe-side failure, were already reduced to a
 * fixed sentence by safeError; the only raw text that ever reached a merchant
 * was this limiter's, unfriendly rather than sensitive.)
 *
 * THE FIX (client only — no edge function, resolver or account rule is touched)
 *   · classifyPayoutOnboardingError: rate_limited (HTTP 429 via .status, or the
 *     limiter's exact wording) vs ordinary
 *   · one friendly message everywhere: "Stripe setup is temporarily busy" /
 *     "Your payout setup has already started. Please wait a moment, then try
 *     again." / OK — never the raw text
 *   · TWO in-memory, per-business guards shared by every launcher, including the
 *     explicit Plan & payouts controls that do not go through
 *     startOrResumePayoutSetup: a 5s launch guard (anti-double-tap, not a rate-limit
 *     claim) and a backoff that starts ONLY after a genuine 429 — the server's
 *     Retry-After where readable, else 60s. The server's own window for onboarding-
 *     link creation is an hour (6 per 3600s), so five seconds after a real 429
 *     would only earn another one
 *   · nothing here writes to the business: state such as "Verification in
 *     progress" is untouched because nothing is written
 *
 * WHAT THIS FILE CANNOT PROVE
 * The real edge functions and limiter are not invoked (no network, no
 * Stripe, no database). The cooldown/classifier/message code is lifted
 * from source and executed for real against a controllable clock; screen
 * wiring is checked by source assertion. The live 429 itself was observed
 * by the merchant during acceptance testing, not reproduced here.
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

function liftFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} not found`);
  const parenStart = src.indexOf('(', start);
  let pdepth = 0, parenEnd = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { parenEnd = i; break; } }
  }
  assert.notEqual(parenEnd, -1, `${decl}: parameter list did not close`);
  const nextNl = src.indexOf('\n', parenEnd);
  const open = src.lastIndexOf('{', nextNl === -1 ? src.length : nextNl);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `end of ${decl} not found`);
  return src.slice(start, end + 1);
}

const transpile = (tsSrc: string) =>
  ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

const mobilePayout = code(read('lib/payout-readiness.ts'));
const webPayout = code(readWeb('lib/payout-readiness.ts'));

/**
 * Builds a fresh, isolated instance of the real cooldown + classifier + message
 * code for one platform, with a controllable clock. The block lifted runs from
 * the cooldown constant through the last message helper, so this executes the
 * shipped source, not a re-implementation.
 */
function instance(platform: 'mobile' | 'web') {
  const src = platform === 'mobile' ? mobilePayout : webPayout;
  const start = src.indexOf('const PAYOUT_ONBOARDING_LAUNCH_GUARD_MS');
  assert.notEqual(start, -1);
  const lastFn = platform === 'mobile' ? 'export function payoutOnboardingErrorAlert(' : 'export function payoutOnboardingErrorNotify(';
  const end = src.indexOf(lastFn);
  assert.notEqual(end, -1);
  const block = liftFn(src, lastFn);
  const body = src.slice(start, end) + block;
  const clock = { t: 1_000_000 };
  const js = transpile(`
    const colors = { jobs: '#j', error: '#e' };
    const Date = { now: () => __clock.t };
    ${body.replace(/export /g, '')}
    module.exports = { guardPayoutOnboardingLaunch, isPayoutOnboardingCoolingDown, isPayoutOnboardingBackedOff, classifyPayoutOnboardingError,
      message: ${platform === 'mobile' ? 'payoutOnboardingErrorAlert' : 'payoutOnboardingErrorNotify'} };
  `);
  const mod = { exports: {} as any };
  new Function('module', 'exports', '__clock', js)(mod, mod.exports, clock);
  return { api: mod.exports as {
    guardPayoutOnboardingLaunch: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    isPayoutOnboardingCoolingDown: (id: string) => boolean;
    isPayoutOnboardingBackedOff: (id: string) => boolean;
    classifyPayoutOnboardingError: (e: unknown) => 'rate_limited' | 'ordinary';
    message: (e: unknown) => Record<string, any>;
  }, clock };
}

const server429 = () => Object.assign(new Error('Too many requests'), { status: 429 });

for (const platform of ['mobile', 'web'] as const) {
  const text = (m: Record<string, any>) => JSON.stringify(m);

  describe(`${platform}: 1 & 2. a 429 never exposes the raw text; the merchant sees the friendly message`, () => {
    test('a server 429 (status) is classified rate_limited and shows the friendly copy, not "Too many requests"', () => {
      const { api } = instance(platform);
      assert.equal(api.classifyPayoutOnboardingError(server429()), 'rate_limited');
      const m = api.message(server429());
      assert.equal(m.title, 'Stripe setup is temporarily busy');
      assert.equal(m.message ?? m.body, 'Please wait a moment, then try again. Your existing payout setup, if any, has not been changed.');
      assert.doesNotMatch(text(m), /too many requests|429|http/i);
      // 1. Truthful whether or not setup exists: never claims it has started.
      assert.doesNotMatch(text(m), /already started|has started|in progress|underway|still setting/i);
    });

    test('the limiter\'s wording alone (no status available) is still recognised', () => {
      const { api } = instance(platform);
      assert.equal(api.classifyPayoutOnboardingError(new Error('Too many requests')), 'rate_limited');
      assert.doesNotMatch(text(api.message(new Error('Too many requests'))), /too many requests/i);
    });

    test('the friendly message offers a single OK action', () => {
      const { api } = instance(platform);
      const m = api.message(server429());
      if (platform === 'mobile') assert.deepEqual(m.actions, [{ label: 'OK', style: 'primary' }]);
      else assert.equal(m.okLabel, 'OK');
    });
  });

  describe(`${platform}: 16. non-429 errors keep the existing general failure UX`, () => {
    test('an ordinary error is classified ordinary and keeps its own message under the existing title', () => {
      const { api } = instance(platform);
      const e = new Error('Accept the business & selling terms for this business before connecting a bank account.');
      assert.equal(api.classifyPayoutOnboardingError(e), 'ordinary');
      const m = api.message(e);
      assert.equal(m.title, 'Stripe onboarding failed');
      assert.equal(m.message ?? m.body, e.message);
    });

    test('a 500 with a status is still ordinary', () => {
      const { api } = instance(platform);
      assert.equal(api.classifyPayoutOnboardingError(Object.assign(new Error('Something went wrong. Please try again.'), { status: 500 })), 'ordinary');
    });
  });

  describe(`${platform}: 3. the short launch guard blocks an ordinary rapid repeat (and is not a rate-limit claim)`, () => {
    test('the first launch reaches the backend and starts the guard, but NOT a backoff', async () => {
      const { api } = instance(platform);
      let calls = 0;
      await api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; return 'url'; });
      assert.equal(calls, 1);
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), true);
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false, 'an ordinary launch must not start the 429 backoff');
    });

    test('a repeat inside the guard makes zero backend calls', async () => {
      const { api, clock } = instance(platform);
      let calls = 0;
      await api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; });
      clock.t += 2_000;
      await assert.rejects(
        api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; }),
        (e: unknown) => api.classifyPayoutOnboardingError(e) === 'rate_limited',
      );
      assert.equal(calls, 1);
    });

    test('the guard is about five seconds and, after an ordinary launch, retry works once it has expired', async () => {
      const { api, clock } = instance(platform);
      let calls = 0;
      await api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; });
      clock.t += 4_900;
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), true);
      clock.t += 200;
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), false);
      await api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; });
      assert.equal(calls, 2);
    });

    test('an ordinary (non-429) failure starts only the short guard, never the long backoff', async () => {
      const { api, clock } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw new Error('Something went wrong. Please try again.'); }));
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false);
      clock.t += 6_000;
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), false);
    });

    test('the launch guard constant is five seconds', () => {
      const src = platform === 'mobile' ? mobilePayout : webPayout;
      assert.equal(/PAYOUT_ONBOARDING_LAUNCH_GUARD_MS = ([\d_]+)/.exec(src)![1].replace(/_/g, ''), '5000');
    });
  });

  describe(`${platform}: 4-8. an actual 429 starts the longer per-business backoff`, () => {
    test('4. a real 429 establishes a backoff that outlasts the launch guard', async () => {
      const { api, clock } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw server429(); }));
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), true);
      clock.t += 10_000; // well past the 5s launch guard
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), true, 'still backed off after the short guard would have expired');
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), true);
    });

    test('5. a retry during the backoff makes zero backend calls', async () => {
      const { api, clock } = instance(platform);
      let calls = 0;
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; throw server429(); }));
      for (const step of [6_000, 10_000, 20_000]) {
        clock.t += step;
        await assert.rejects(
          api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; }),
          (e: unknown) => api.classifyPayoutOnboardingError(e) === 'rate_limited',
        );
      }
      assert.equal(calls, 1, 'only the original request ever reached the backend');
    });

    test('7. a server-provided Retry-After is honoured exactly', async () => {
      const { api, clock } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw Object.assign(server429(), { retryAfterSecs: 300 }); }));
      clock.t += 299_000;
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), true);
      clock.t += 2_000;
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false);
    });

    test('7. a short Retry-After (below the fallback) is honoured too — the server knows best', async () => {
      const { api, clock } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw Object.assign(server429(), { retryAfterSecs: 20 }); }));
      clock.t += 21_000;
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false);
    });

    test('8. with no Retry-After available the fallback is 60 seconds', async () => {
      const { api, clock } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw server429(); }));
      clock.t += 59_000;
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), true);
      clock.t += 2_000;
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false);
    });

    test('an absurd Retry-After is capped at the server window (an hour), and a zero/invalid one falls back', async () => {
      const a = instance(platform);
      await assert.rejects(a.api.guardPayoutOnboardingLaunch('biz-1', async () => { throw Object.assign(server429(), { retryAfterSecs: 999_999 }); }));
      a.clock.t += 3_601_000;
      assert.equal(a.api.isPayoutOnboardingBackedOff('biz-1'), false);
      const b = instance(platform);
      await assert.rejects(b.api.guardPayoutOnboardingLaunch('biz-1', async () => { throw Object.assign(server429(), { retryAfterSecs: 0 }); }));
      b.clock.t += 59_000;
      assert.equal(b.api.isPayoutOnboardingBackedOff('biz-1'), true);
    });

    test('6. once the backoff expires a retry reaches the backend normally', async () => {
      const { api, clock } = instance(platform);
      let calls = 0;
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; throw server429(); }));
      clock.t += 61_000;
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), false);
      await api.guardPayoutOnboardingLaunch('biz-1', async () => { calls++; });
      assert.equal(calls, 2);
    });

    test('a synthetic refusal from the guard itself never starts or extends the backoff', async () => {
      const { api, clock } = instance(platform);
      await api.guardPayoutOnboardingLaunch('biz-1', async () => 'ok');
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => 'blocked'));
      assert.equal(api.isPayoutOnboardingBackedOff('biz-1'), false);
      clock.t += 6_000;
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-1'), false);
    });

    test('the backoff is per business', async () => {
      const { api } = instance(platform);
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => { throw server429(); }));
      assert.equal(api.isPayoutOnboardingBackedOff('biz-2'), false);
      await api.guardPayoutOnboardingLaunch('biz-2', async () => 'ok');
    });
  });

  describe(`${platform}: 4. cooldown is shared per business, not per button`, () => {
    test('one business\'s cooldown does not block another business', async () => {
      const { api } = instance(platform);
      await api.guardPayoutOnboardingLaunch('biz-1', async () => 1);
      assert.equal(api.isPayoutOnboardingCoolingDown('biz-2'), false);
      await api.guardPayoutOnboardingLaunch('biz-2', async () => 2);
    });

    test('the map is module-level: separate callers going through the same guard share one window', async () => {
      const { api } = instance(platform);
      await api.guardPayoutOnboardingLaunch('biz-1', async () => 'from the contextual launcher');
      await assert.rejects(api.guardPayoutOnboardingLaunch('biz-1', async () => 'from the Plan & payouts button'));
    });
  });

  describe(`${platform}: 3. preserving progress — nothing here writes to the business or Stripe`, () => {
    test('the cooldown/classifier/message code contains no writes and no account or state fields', () => {
      const src = platform === 'mobile' ? mobilePayout : webPayout;
      const start = src.indexOf('const PAYOUT_ONBOARDING_LAUNCH_GUARD_MS');
      const end = src.indexOf(platform === 'mobile' ? 'export function payoutOnboardingErrorAlert(' : 'export function payoutOnboardingErrorNotify(');
      const block = src.slice(start, end) + liftFn(src, platform === 'mobile' ? 'export function payoutOnboardingErrorAlert(' : 'export function payoutOnboardingErrorNotify(');
      assert.doesNotMatch(block, /\.update\(|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(|updateBusiness|supabase|createClient/);
      assert.doesNotMatch(block, /stripe_account_id|use_business_payout|payout_enabled|stripe_connected|onboarding_complete/);
    });
  });
}

describe('17. an already-ready business never enters cooldown or onboarding', () => {
  test('mobile and web check readiness before the guard, and only the guard starts a window', () => {
    for (const [src, decl] of [
      [mobilePayout, 'export async function startOrResumePayoutSetup('],
      [webPayout, 'export async function startOrResumePayoutSetup('],
    ] as const) {
      const fn = liftFn(src, decl);
      const readyIdx = fn.indexOf('requirePayoutReadyForPaidActivation(businessId)');
      const guardIdx = fn.indexOf('guardPayoutOnboardingLaunch(');
      assert.ok(readyIdx !== -1 && guardIdx !== -1 && readyIdx < guardIdx, 'readiness first, guard second');
    }
    // The map is written in exactly one place — the guard.
    for (const src of [mobilePayout, webPayout]) {
      const guardWrites = src.match(/payoutOnboardingLaunchGuardUntil\.set\(/g) ?? [];
      const backoffWrites = src.match(/payoutOnboardingBackoffUntil\.set\(/g) ?? [];
      assert.equal(guardWrites.length, 1, 'the launch guard is started in exactly one place');
      assert.equal(backoffWrites.length, 1, 'the backoff is started in exactly one place');
    }
  });
});

/* ── 7-13. Every surface uses the shared handling ─────────────────────── */

describe('7-11. contextual surfaces use the shared handling', () => {
  test('mobile: Event Manage, Events list, and the Wallet control show payoutOnboardingErrorAlert', () => {
    assert.match(code(read('app/event-manage.tsx')), /alert\(payoutOnboardingErrorAlert\(e\)\)/);
    assert.match(code(read('app/business-events.tsx')), /alert\(payoutOnboardingErrorAlert\(e\)\)/);
    const dash = code(read('app/local-business-dashboard.tsx'));
    const wallet = liftFn(dash, 'const handleConnectStripeContextual = async () => {');
    assert.match(wallet, /brandedAlert\(payoutOnboardingErrorAlert\(e\)\)/);
  });

  test('mobile: Products, Passes and the event-create prompt share launchPayoutSetupFromPrompt, whose failure path is the shared alert', () => {
    const fn = liftFn(mobilePayout, 'export async function launchPayoutSetupFromPrompt(');
    assert.match(fn, /ui\.alert\(payoutOnboardingErrorAlert\(e\)\)/);
    for (const f of ['app/business-products.tsx', 'app/local-book-units.tsx', 'app/event-create.tsx']) {
      assert.match(code(read(f)), /launchPayoutSetupFromPrompt\(/, f);
    }
  });

  test('web: every contextual surface notifies via payoutOnboardingErrorNotify for a launch failure', () => {
    for (const f of [
      'components/business/BusinessEventManage.tsx',
      'components/business/ConnectStripeToPublishLink.tsx',
      'components/business/ProductsManager.tsx',
      'components/business/UnitItemsManager.tsx',
      'components/business/WalletManager.tsx',
      'components/business/BusinessEventForm.tsx',
    ]) {
      const src = code(readWeb(f));
      assert.match(src, /payoutOnboardingErrorNotify\(/, f);
      assert.match(src, /useNotify\(\)/, f);
    }
  });

  test('web: the friendly dialog shows after the loading state has been reset, so the control is already usable', () => {
    for (const [f, decl] of [
      ['components/business/BusinessEventManage.tsx', 'async function goConnectStripe() {'],
      ['components/business/ConnectStripeToPublishLink.tsx', 'async function go() {'],
      ['components/business/ProductsManager.tsx', 'async function launchStripe() {'],
      ['components/business/UnitItemsManager.tsx', 'async function launchStripe() {'],
    ] as const) {
      const fn = liftFn(code(readWeb(f)), decl);
      assert.ok(fn.indexOf('finally') < fn.indexOf('notify('), `${f}: notify must follow the reset`);
    }
  });
});

describe('12 & 13. explicit Plan & payouts controls use the shared guard and message', () => {
  test('mobile: handleConnectStripe (also "Check verification status" — one button, two labels) is guarded and shows the friendly alert', () => {
    const dash = code(read('app/local-business-dashboard.tsx'));
    const fn = liftFn(dash, 'const handleConnectStripe = async () => {');
    assert.match(fn, /guardPayoutOnboardingLaunch\(activeBusiness\.id, \(\) => createBusinessOnboardingLink\(activeBusiness\.id\)\)/);
    assert.match(fn, /brandedAlert\(payoutOnboardingErrorAlert\(e\)\)/);
    assert.match(dash, /'Check verification status'/);
    // "Check verification status" and "Connect business bank account" are the same control.
    assert.match(dash, /onPress=\{handleConnectStripe\}[\s\S]{0,400}Check verification status/);
  });

  test('mobile: turning the Payout bank account switch on is a plain database write — it never reaches the onboarding endpoint, so it needs no throttle of its own', () => {
    const dash = code(read('app/local-business-dashboard.tsx'));
    const fn = liftFn(dash, 'const toggleBusinessPayout = async (value: boolean) => {');
    assert.doesNotMatch(fn, /createBusinessOnboardingLink|startPayoutOnboarding|functions\.invoke/);
    assert.match(fn, /updateBusiness\(/);
  });

  test('web: BillingManager.connectBank is guarded and shows the friendly dialog for a rate-limited response, keeping its banner for anything else', () => {
    const src = code(readWeb('components/business/BillingManager.tsx'));
    const fn = liftFn(src, 'async function connectBank() {');
    assert.match(fn, /guardPayoutOnboardingLaunch\(b\.id, \(\) => createBusinessOnboardingLink\(b\.id\)\)/);
    assert.match(fn, /classifyPayoutOnboardingError\(e\) === "rate_limited"/);
    assert.match(fn, /else fail\(e\)/);
    assert.match(fn, /popup\?\.close\(\)/, 'the pre-opened popup is closed when the launch is refused');
  });
});

/* ── 14 & 15. Existing account resumed, never duplicated; a 429 cannot create one ── */

describe('14 & 15. an existing account is resumed, and a rate-limited call can never create or alter one', () => {
  const business = read('supabase/functions/local-business-onboard/index.ts');
  const central = read('supabase/functions/create-connect-account/index.ts');

  test('business-specific: the stored account id is read first and a new Stripe account is created only when there is none', () => {
    assert.match(business, /let accountId = business\.stripe_account_id;\s*\n\s*if \(!accountId\) \{/);
    const guardIdx = business.indexOf('if (!accountId)');
    const createIdx = business.indexOf("stripePost('accounts'");
    assert.ok(guardIdx !== -1 && createIdx > guardIdx, 'account creation sits inside the no-account branch');
    assert.match(business, /stripePost\('account_links'/, 'an existing account still gets a fresh onboarding link');
  });

  test('central: the existing profile/driver account is resolved first and creation happens only when none exists', () => {
    assert.match(central, /let accountId: string = prof\?\.stripe_account_id \|\| drv\?\.stripe_account_id \|\| ''/);
    const guardIdx = central.indexOf('if (!accountId)');
    const createIdx = central.indexOf('${STRIPE}/accounts`');
    assert.ok(guardIdx !== -1 && createIdx > guardIdx);
  });

  test('the rate limiter runs before ANY Stripe call, database read or write in both functions — a 429 has nothing it could have changed', () => {
    for (const [name, src, firstStripe, firstDb] of [
      ['local-business-onboard', business, "stripePost('accounts'", ".from('local_businesses')"],
      ['create-connect-account', central, '${STRIPE}/accounts', ".from('profiles')"],
    ] as const) {
      const limiter = src.indexOf('enforceRateLimit(');
      assert.ok(limiter !== -1, `${name} calls the limiter`);
      assert.ok(limiter < src.indexOf(firstStripe), `${name}: limiter precedes account creation`);
      assert.ok(limiter < src.indexOf(firstDb), `${name}: limiter precedes the first database access`);
      assert.match(src, /if \('denied' in limited\) return limited\.denied;/);
    }
  });

  test('the client never retries a refused launch on its own or falls back to another creation route', () => {
    for (const src of [mobilePayout, webPayout]) {
      const fn = liftFn(src, 'export async function startOrResumePayoutSetup(');
      // Web has one catch, solely to close its pre-opened popup — and it rethrows.
      if (/catch/.test(fn)) assert.match(fn, /catch \(e\) \{\s*\n\s*popup\?\.close\(\);\s*\n\s*throw e;/);
      const creations = fn.match(/createBusinessOnboardingLink\(|startPayoutOnboarding\(/g) ?? [];
      assert.equal(creations.length, 2, 'exactly the two existing routes, each called once, never retried');
    }
  });
});

/* ── 8. One small helper per platform, three-way distinction ────────────── */

describe('8. error normalisation is one small helper per platform, not a framework', () => {
  test('both platforms export the same classifier with the same two outcomes', () => {
    for (const src of [mobilePayout, webPayout]) {
      assert.match(src, /export function classifyPayoutOnboardingError\(err: unknown\)/);
      assert.match(src, /'rate_limited' \| 'ordinary'|"rate_limited" \| "ordinary"/);
    }
  });

  test('"already ready / no action required" is expressed by startOrResumePayoutSetup resolving without throwing, not by a third error kind', () => {
    for (const src of [mobilePayout, webPayout]) {
      assert.match(liftFn(src, 'export async function startOrResumePayoutSetup('), /return \{ ready: true \}/);
    }
  });

  test('server responses carry their HTTP status to the classifier on every onboarding path, both platforms', () => {
    assert.match(read('lib/local-api.ts'), /if \(c\) \{ status = c\.status; retryAfterSecs = retryAfterSecsFrom\(c\); \}/);
    assert.match(read('lib/payment-state.ts'), /status = ctx\?\.status;/);
    // ...and so does Retry-After, wherever the invocation layer exposes it.
    assert.match(read('lib/local-api.ts'), /retryAfterSecs = retryAfterSecsFrom\(c\)/);
    assert.match(read('lib/payment-state.ts'), /retryAfterSecs = retryAfterSecsFrom\(ctx\)/);
    assert.match(readWeb('lib/business-client.ts'), /retryAfterSecsFrom\(\(error as \{ context\?: unknown \}\)\.context\)/);
    assert.match(readWeb('lib/payment-state.ts'), /retryAfterSecsFrom\(\(error as \{ context\?: unknown \}\)\.context\)/);
    assert.match(readWeb('lib/business-client.ts'), /context\?: \{ status\?: number \}/);
    assert.match(readWeb('lib/payment-state.ts'), /context\?: \{ status\?: number \}/);
  });
});

/* ── 18. Parity ─────────────────────────────────────────────────────────── */

describe('18. mobile and web semantics match', () => {
  test('same cooldown length, same key (business id), same friendly wording, same trigger signals', () => {
    const ms = (s: string, name: string) => new RegExp(`${name} = ([\\d_]+)`).exec(s)![1];
    for (const name of ['PAYOUT_ONBOARDING_LAUNCH_GUARD_MS', 'PAYOUT_ONBOARDING_BACKOFF_FALLBACK_MS', 'PAYOUT_ONBOARDING_BACKOFF_MAX_MS']) {
      assert.equal(ms(mobilePayout, name), ms(webPayout, name), name);
    }
    for (const src of [mobilePayout, webPayout]) {
      assert.match(src, /Stripe setup is temporarily busy/);
      assert.match(src, /Please wait a moment, then try again\. Your existing payout setup, if any, has not been changed\./);
      assert.doesNotMatch(src, /Your payout setup has already started/);
      assert.match(src, /status === 429/);
      assert.match(src, /too many requests/i);
      assert.equal((src.match(/new Map<string, number>\(\)/g) ?? []).length, 2, 'exactly the two per-business maps');
    }
  });

  test('the friendly copy is defined once per platform (no second hand-typed copy in any screen)', () => {
    for (const f of [
      'app/event-manage.tsx', 'app/business-events.tsx', 'app/local-business-dashboard.tsx',
      'app/business-products.tsx', 'app/local-book-units.tsx', 'app/event-create.tsx',
    ]) assert.doesNotMatch(read(f), /still setting things up/, f);
    for (const f of [
      'components/business/BusinessEventManage.tsx', 'components/business/ConnectStripeToPublishLink.tsx',
      'components/business/ProductsManager.tsx', 'components/business/UnitItemsManager.tsx',
      'components/business/WalletManager.tsx', 'components/business/BusinessEventForm.tsx',
      'components/business/BillingManager.tsx',
    ]) assert.doesNotMatch(readWeb(f), /still setting things up/, f);
  });
});

/* ── Retry-After: read where genuinely available, never invented ─────────── */

describe('7 & 8. Retry-After extraction', () => {
  const src = read('lib/retry-after.ts');
  const fn = transpile(src.replace(/^export /gm, '').replace(/\/\*[\s\S]*?\*\//g, '') + '\nmodule.exports = retryAfterSecsFrom;');
  const run = (ctx: unknown) => {
    const mod = { exports: {} as any };
    new Function('module', 'exports', fn)(mod, mod.exports);
    return (mod.exports as (c: unknown) => number | undefined)(ctx);
  };
  const withHeader = (v: string | null) => ({ headers: { get: (k: string) => (k === 'Retry-After' ? v : null) } });

  test('a numeric Retry-After header is returned in whole seconds', () => {
    assert.equal(run(withHeader('42')), 42);
    assert.equal(run(withHeader('41.2')), 42);
  });
  test('an absent, unreadable, zero, negative or date-form header yields undefined so the caller uses its fallback', () => {
    assert.equal(run(withHeader(null)), undefined);
    assert.equal(run({}), undefined);
    assert.equal(run(undefined), undefined);
    assert.equal(run(withHeader('0')), undefined);
    assert.equal(run(withHeader('-5')), undefined);
    assert.equal(run(withHeader('Wed, 21 Oct 2026 07:28:00 GMT')), undefined);
  });
  test('the mobile and web copies are identical', () => {
    assert.equal(src, readWeb('lib/retry-after.ts'));
  });
  test('the server DOES send Retry-After (exact seconds left in its window) — readable on mobile; a browser will not expose it cross-origin, so web uses the fallback unless the server later lists it in Access-Control-Expose-Headers (deliberately not changed here)', () => {
    const limiter = read('supabase/functions/_shared/rate-limit.ts');
    assert.match(limiter, /\{ 'Retry-After': String\(retry\) \}/);
    assert.doesNotMatch(limiter, /Access-Control-Expose-Headers/);
    assert.match(read('supabase/migrations/20260821280000_rate_limits.sql'), /\('stripe_account',\s+3600,\s+6,/);
  });
});

/* ── No blank popup for a launch that cannot happen (web) ─────────────────── */

describe('web: no blank popup while a guard or backoff is active, without breaking the popup-blocker rule', () => {
  test('startOrResumePayoutSetup decides synchronously (no await first), still checks readiness before refusing, and closes the popup on refusal', () => {
    const fn = liftFn(webPayout, 'export async function startOrResumePayoutSetup(');
    const checkIdx = fn.indexOf('const blocked = isPayoutOnboardingCoolingDown(businessId);');
    const popupIdx = fn.indexOf('const popup = blocked ? null : openStripePopup();');
    const readyIdx = fn.indexOf('requirePayoutReadyForPaidActivation(businessId)');
    const refuseIdx = fn.indexOf('if (blocked) throw rateLimitedCooldownError();');
    assert.ok(checkIdx !== -1 && popupIdx > checkIdx && readyIdx > popupIdx && refuseIdx > readyIdx);
    assert.doesNotMatch(fn.slice(0, popupIdx), /await /);
    assert.match(fn, /catch \(e\) \{\s*\n\s*popup\?\.close\(\);/);
  });
  test('BillingManager.connectBank skips window.open while blocked', () => {
    const fn = liftFn(code(readWeb('components/business/BillingManager.tsx')), 'async function connectBank() {');
    assert.match(fn, /isPayoutOnboardingCoolingDown\(b\.id\) \? null : window\.open\(/);
  });
  test('an already-ready business is never told it is busy: readiness resolves before the refusal', async () => {
    // The ordering above (ready check, then refusal) is what guarantees it; the
    // already-ready fast path returns { ready: true } before `blocked` is read.
    const fn = liftFn(webPayout, 'export async function startOrResumePayoutSetup(');
    assert.ok(fn.indexOf('return { ready: true }') < fn.indexOf('if (blocked) throw'));
  });
});

/* ── Commercial Terms parity: mobile Events management index ─────────────── */

describe('11-13. the mobile Events management list uses the established Commercial Terms gate, matching web', () => {
  const mobile = read('app/business-events.tsx');
  const webPage = readWeb('app/business/[id]/manage/events/page.tsx');

  test('11. it is wrapped in the existing CommercialTermsGate with the same feature label web uses', () => {
    assert.match(mobile, /import \{ CommercialTermsGate \} from '@\/components\/CommercialTermsGate';/);
    assert.match(mobile, /<CommercialTermsGate businessId=\{businessId\} feature="Events">\s*\n\s*<BusinessEventsBody \/>/);
    assert.match(webPage, /commercialTermsGate\(business, "Events"\)/);
  });

  test('11. no new terms flow: only the shared component is used, and nothing writes an acceptance itself', () => {
    assert.doesNotMatch(mobile, /record_commercial_terms_acceptance|fetchCommercialTermsStatus/);
  });

  test('12. both platforms gate before doing the screen\'s own work', () => {
    assert.ok(mobile.indexOf('<CommercialTermsGate') > mobile.indexOf('function BusinessEventsBody'));
    assert.ok(webPage.indexOf('commercialTermsGate(') < webPage.indexOf('getBusinessEvents('));
  });

  test('13. the list itself is unchanged: same default-export gate wrapper, same body, same grouping, same rows, same navigation', () => {
    assert.match(mobile, /const \{ drafts, upcoming, past \} = groupEventsForManagement\(events\);/);
    assert.match(mobile, /fetchBusinessEventsForManagement\(businessId\)/);
    assert.match(mobile, /Drafts · needs attention/);
    assert.match(mobile, /router\.push\(\{ pathname: '\/event-manage', params: \{ id: e\.id \} \}\)/);
    assert.match(mobile, /pathname: '\/event-create', params: \{ businessId: businessId \?\? '' \}/);
    assert.match(mobile, /notReadyPaidDraft=\{eventHasActivePaidTicket\(e\.ticket_types \?\? \[\]\) && draftPayoutReady\[e\.id\] !== true\}/);
    // The gate wraps the screen only — it neither reads nor writes events, payouts or tickets.
    const wrapper = mobile.slice(mobile.indexOf('export default function BusinessEventsScreen'), mobile.indexOf('function EventGroup'));
    assert.doesNotMatch(wrapper, /supabase|fetchBusinessEvents|payout|ticket/i);
  });
});

/* ── 14. every contextual surface still uses the shared handling ─────────── */

describe('14. every contextual payout surface continues to use the shared handling', () => {
  test('mobile and web surfaces still route through startOrResumePayoutSetup / launchPayoutSetupFromPrompt / the shared guard and friendly message', () => {
    for (const f of ['app/event-manage.tsx', 'app/business-events.tsx']) assert.match(code(read(f)), /startOrResumePayoutSetup\(/);
    for (const f of ['app/business-products.tsx', 'app/local-book-units.tsx', 'app/event-create.tsx']) assert.match(code(read(f)), /launchPayoutSetupFromPrompt\(/);
    const dash = code(read('app/local-business-dashboard.tsx'));
    assert.match(dash, /guardPayoutOnboardingLaunch\(activeBusiness\.id/);
    assert.match(dash, /startOrResumePayoutSetup\(activeBusiness\.id\)/);
    for (const f of [
      'components/business/BusinessEventManage.tsx', 'components/business/ConnectStripeToPublishLink.tsx',
      'components/business/ProductsManager.tsx', 'components/business/UnitItemsManager.tsx',
      'components/business/WalletManager.tsx', 'components/business/BusinessEventForm.tsx',
    ]) assert.match(code(readWeb(f)), /startOrResumePayoutSetup\(/, f);
    assert.match(code(readWeb('components/business/BillingManager.tsx')), /guardPayoutOnboardingLaunch\(b\.id/);
  });
});

describe('untouched by this task', () => {
  test('the edge functions, canonical resolver and readiness gate are not edited', () => {
    assert.match(read('supabase/migrations/20260822160000_business_payout_and_product_read.sql'), /create or replace function public\.business_payout_ready/);
    assert.match(mobilePayout, /rpc\('business_payout_ready', \{ p_business: businessId \}\)/);
    assert.match(webPayout, /rpc\("business_payout_ready", \{ p_business: businessId \}\)/);
    assert.match(read('supabase/functions/_shared/rate-limit.ts'), /json\(\{ error: 'Too many requests' \}, 429/);
  });
});

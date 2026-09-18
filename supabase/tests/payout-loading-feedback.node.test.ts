/**
 * payout-loading-feedback.node.test.ts — immediate visual feedback for the
 * contextual Connect Stripe launchers (payout-setup-launcher.node.test.ts).
 *
 * WHAT WAS WRONG
 * startOrResumePayoutSetup's first work — a fresh business_payout_ready
 * check, then business_private_fields, then creating/resuming the
 * onboarding link — takes a few real seconds before the Stripe sheet/popup
 * appears. Nothing on screen changed in that window, so a merchant who had
 * just tapped Connect Stripe could not tell whether the tap had registered.
 *
 * THE FIX, both platforms
 * Every contextual launcher now sets its own local "connecting" state as
 * the literal first statement of its handler — before startOrResumePayoutSetup
 * (or, for the three BrandedAlert/ConfirmProvider-dialog-triggered surfaces,
 * before the wrapping launcher even shows its own loading UI) — which:
 *   · disables the control immediately (and duplicate-taps are additionally
 *     guarded by an explicit `if (connecting) return;` at the top of the
 *     handler, since `disabled` only takes effect on the next render)
 *   · swaps the label to "Opening Stripe…"
 *   · is cleared in a finally block, so a thrown error (no URL, no onboarding
 *     link) always restores the control — never a stuck "Opening Stripe…"
 *   · the SAME finally-based reset covers the already-ready fast path too:
 *     startOrResumePayoutSetup resolves quickly there, and the caller does
 *     not special-case it — one code path for every outcome
 *
 * DIALOG-TRIGGERED SURFACES (event-create.tsx, business-products.tsx,
 * local-book-units.tsx on mobile; ProductsManager.tsx, UnitItemsManager.tsx,
 * BusinessEventForm.tsx on web)
 * BrandedAlert (mobile) and ConfirmProvider (web) both dismiss their dialog
 * before firing onPress/resolving confirm() — there is no longer a button on
 * screen to animate by the time onConnectStripe runs. Mobile gets a new,
 * opt-in `loading` mode on BrandedAlert itself (a second, non-dismissible
 * alert shown immediately, replaced by nothing or a plain error once
 * settled) via the new shared launchPayoutSetupFromPrompt helper. Web gets a
 * small inline status banner on the underlying page, using each file's own
 * existing error-banner convention.
 *
 * WEB POPUP-BLOCKER SAFETY (requirement 14)
 * startOrResumePayoutSetup's own popup-opening code is UNCHANGED by this
 * task — openStripePopup() is still the literal first statement, before any
 * await. Every call site's new "set connecting" line is a synchronous React
 * state setter call, not an await, so it does not introduce a task boundary
 * between the click and that first synchronous statement — this file proves
 * that ordering by asserting no `await` appears between a handler's opening
 * brace and its call into startOrResumePayoutSetup / launchPayoutSetupFromPrompt.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions and lifted-and-executed pure logic only — this
 * repo has no React/React Native render test infrastructure, so a real
 * popup-blocker verdict from an actual browser is not exercised here; nor is
 * the animation/visual result. business_payout_ready, the central/business
 * routing decision, and the onboarding mechanisms themselves are proven in
 * payout-setup-launcher.node.test.ts, not re-proven here.
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
 * Lift a named function's full source. Finds the parameter list's true
 * closing paren via proper depth counting (not just the first ')' after the
 * declaration) — launchPayoutSetupFromPrompt's own `ui: { alert: (o: ...)
 * => void; hide: () => void }` parameter has a nested function-type paren
 * that a naive first-')' search latches onto instead. The body's opening
 * brace is then the LAST '{' on the signature's own line, since a return
 * type such as Promise<{ ready: boolean }> can carry braces of its own.
 */
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
  const sigEnd = nextNl === -1 ? src.length : nextNl;
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

const mobileEventManage = code(read('app/event-manage.tsx'));
const mobileBusinessEvents = code(read('app/business-events.tsx'));
const mobileDashboard = code(read('app/local-business-dashboard.tsx'));
const mobileEventCreate = code(read('app/event-create.tsx'));
const mobileProducts = code(read('app/business-products.tsx'));
const mobileUnits = code(read('app/local-book-units.tsx'));
const mobilePayout = code(read('lib/payout-readiness.ts'));
const brandedAlert = code(read('components/BrandedAlert.tsx'));

const webEventManage = code(readWeb('components/business/BusinessEventManage.tsx'));
const webEventsLink = code(readWeb('components/business/ConnectStripeToPublishLink.tsx'));
const webWallet = code(readWeb('components/business/WalletManager.tsx'));
const webProducts = code(readWeb('components/business/ProductsManager.tsx'));
const webUnits = code(readWeb('components/business/UnitItemsManager.tsx'));
const webEventForm = code(readWeb('components/business/BusinessEventForm.tsx'));

/* ════════════════════════════════════════════════════════════════════════
   1, 2, 3. Loading state begins before any await, disables the control,
   and relabels it — for every direct-button surface.
   ════════════════════════════════════════════════════════════════════════ */

type ButtonSurface = { label: string; src: string; setter: string; disabledAttr: RegExp; text: string };

const BUTTON_SURFACES: ButtonSurface[] = [
  { label: '5. mobile event-manage.tsx StatusStrip Connect Stripe button', src: mobileEventManage, setter: 'setConnectingStripe(true)', disabledAttr: /connectingStripe && styles\.disabledBtn|disabled=\{connectingStripe\}/, text: 'Opening Stripe…' },
  { label: '6. mobile business-events.tsx draft row link', src: mobileBusinessEvents, setter: 'setConnectingStripe(true)', disabledAttr: /disabled=\{connectingStripe\}/, text: 'Opening Stripe…' },
  { label: '9. mobile local-business-dashboard.tsx Wallet button', src: mobileDashboard, setter: 'setConnectingStripeContextual(true)', disabledAttr: /disabled=\{connectingStripeContextual\}/, text: 'Opening Stripe…' },
  { label: '5. web BusinessEventManage.tsx buttons', src: webEventManage, setter: 'setConnectingStripe(true)', disabledAttr: /disabled=\{connecting\}/, text: 'Opening Stripe…' },
  { label: '6. web ConnectStripeToPublishLink.tsx', src: webEventsLink, setter: 'setBusy(true)', disabledAttr: /disabled=\{busy\}/, text: 'Opening Stripe…' },
  { label: '9. web WalletManager.tsx connectBank button', src: webWallet, setter: 'setBusy("bank")', disabledAttr: /disabled=\{busy === "bank"\}/, text: 'Opening Stripe…' },
];

describe('1, 2, 3. every direct-button surface sets loading state, disables, and relabels', () => {
  for (const s of BUTTON_SURFACES) {
    test(`${s.label} — sets its loading flag, has a disabled binding, and renders "Opening Stripe…"`, () => {
      assert.match(s.src, new RegExp(s.setter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${s.label} must set its loading flag`);
      assert.match(s.src, s.disabledAttr, `${s.label} must disable its control while loading`);
      assert.match(s.src, new RegExp(s.text), `${s.label} must show "${s.text}"`);
    });
  }

  test('3. every button-surface label swap explicitly checks the loading flag with a ternary, not a separate always-on spinner', () => {
    assert.match(mobileEventManage, /connectingStripe \? 'Opening Stripe…' : 'Connect Stripe/);
    assert.match(mobileBusinessEvents, /connectingStripe \? 'Opening Stripe…' : 'Connect Stripe to publish'/);
    assert.match(mobileDashboard, /connectingStripeContextual \? 'Opening Stripe…' : 'Connect Stripe'/);
    assert.match(webEventManage, /connecting \? "Opening Stripe…" : label/);
    assert.match(webEventsLink, /busy \? "Opening Stripe…" : "Connect Stripe to publish"/);
    assert.match(webWallet, /busy === "bank" \? "Opening Stripe…" : "Connect Stripe"/);
  });

  test('a visible spinner glyph accompanies the label on every button surface, not text alone', () => {
    for (const src of [mobileEventManage, mobileBusinessEvents, mobileDashboard]) {
      assert.match(src, /ActivityIndicator size="small"/);
    }
    for (const src of [webEventManage, webEventsLink, webWallet]) {
      assert.match(src, /animate-spin/);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   4. Duplicate-tap prevention: an explicit early-return guard, not just the
   disabled prop (which only takes effect on the next render).
   ════════════════════════════════════════════════════════════════════════ */

describe('4. an explicit guard blocks a second call while one is already in flight', () => {
  test('mobile event-manage.tsx goConnectStripe guards on connectingStripe', () => {
    const fn = liftFn(mobileEventManage, 'const goConnectStripe = async () => {');
    assert.match(fn, /if \(connectingStripe\) return;/);
  });

  test('mobile business-events.tsx goConnectStripe guards on connectingStripe', () => {
    const fn = liftFn(mobileBusinessEvents, 'const goConnectStripe = async () => {');
    assert.match(fn, /if \(connectingStripe\) return;/);
  });

  test('mobile local-business-dashboard.tsx handleConnectStripeContextual guards on connectingStripeContextual (and activeBusiness)', () => {
    const fn = liftFn(mobileDashboard, 'const handleConnectStripeContextual = async () => {');
    assert.match(fn, /if \(!activeBusiness \|\| connectingStripeContextual\) return;/);
  });

  test('web BusinessEventManage.tsx goConnectStripe guards on connectingStripe', () => {
    const fn = liftFn(webEventManage, 'async function goConnectStripe() {');
    assert.match(fn, /if \(connectingStripe\) return;/);
  });

  test('web ConnectStripeToPublishLink.tsx go() guards on busy', () => {
    const fn = liftFn(webEventsLink, 'async function go() {');
    assert.match(fn, /if \(busy\) return;/);
  });

  test('web WalletManager.tsx connectBank guards on busy === "bank"', () => {
    const fn = liftFn(webWallet, 'async function connectBank() {');
    assert.match(fn, /if \(busy === "bank"\) return;/);
  });

  test('web ProductsManager.tsx / UnitItemsManager.tsx launchStripe guards on connectingStripe', () => {
    for (const src of [webProducts, webUnits]) {
      const fn = liftFn(src, 'async function launchStripe() {');
      assert.match(fn, /if \(connectingStripe\) return;/);
    }
  });

  test('the guard is checked BEFORE the flag is set, on every surface — otherwise the flag would always read true and self-block', () => {
    for (const [src, decl, flag] of [
      [mobileEventManage, 'const goConnectStripe = async () => {', 'connectingStripe'],
      [mobileBusinessEvents, 'const goConnectStripe = async () => {', 'connectingStripe'],
      [webEventManage, 'async function goConnectStripe() {', 'connectingStripe'],
      [webEventsLink, 'async function go() {', 'busy'],
    ] as const) {
      const fn = liftFn(src, decl);
      const guardIdx = fn.indexOf(`if (${flag}`);
      const setIdx = fn.indexOf(`set${flag[0].toUpperCase()}${flag.slice(1)}`);
      assert.ok(guardIdx !== -1 && setIdx !== -1 && guardIdx < setIdx, `${decl} must guard before setting`);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   5-9. Named surfaces — Event Manage, Events list, Product, Pass, Wallet —
   each use this behaviour. Combines the button-surface coverage above with
   the three dialog-triggered surfaces, which get a different but equivalent
   mechanism (a loading alert / an inline page banner).
   ════════════════════════════════════════════════════════════════════════ */

describe('5. Event Manage uses this behaviour, both platforms', () => {
  test('mobile: covered by the button-surface suite above (event-manage.tsx)', () => {
    assert.match(mobileEventManage, /connectingStripe/);
  });
  test('web: covered by the button-surface suite above (BusinessEventManage.tsx)', () => {
    assert.match(webEventManage, /connectingStripe/);
  });
});

describe('6. Events list uses this behaviour, both platforms', () => {
  test('mobile: business-events.tsx draft rows share one loading flag per business', () => {
    assert.match(mobileBusinessEvents, /connectingStripe/);
    assert.match(mobileBusinessEvents, /connectingStripe=\{connectingStripe\}/, 'the flag is threaded down to EventRow');
  });
  test('web: ConnectStripeToPublishLink.tsx has its own local loading flag', () => {
    assert.match(webEventsLink, /const \[busy, setBusy\] = useState\(false\);/);
  });
});

describe('7. Product recovery uses this behaviour, both platforms', () => {
  test('mobile: business-products.tsx routes through launchPayoutSetupFromPrompt, whose own loading alert is asserted below', () => {
    assert.match(mobileProducts, /launchPayoutSetupFromPrompt\(/);
  });
  test('web: ProductsManager.tsx shows its own "Opening Stripe…" banner via connectingStripe', () => {
    assert.match(webProducts, /const \[connectingStripe, setConnectingStripe\] = useState\(false\);/);
    assert.match(webProducts, /connectingStripe && \(/);
    assert.match(webProducts, /Opening Stripe…/);
  });
});

describe('8. Pass recovery uses this behaviour, both platforms', () => {
  test('mobile: local-book-units.tsx routes through launchPayoutSetupFromPrompt', () => {
    assert.match(mobileUnits, /launchPayoutSetupFromPrompt\(/);
  });
  test('web: UnitItemsManager.tsx shows its own "Opening Stripe…" banner via connectingStripe', () => {
    assert.match(webUnits, /const \[connectingStripe, setConnectingStripe\] = useState\(false\);/);
    assert.match(webUnits, /connectingStripe && \(/);
    assert.match(webUnits, /Opening Stripe…/);
  });
});

describe('9. Wallet recovery uses this behaviour, both platforms', () => {
  test('mobile: covered above (local-business-dashboard.tsx handleConnectStripeContextual)', () => {
    assert.match(mobileDashboard, /connectingStripeContextual/);
  });
  test('web: covered above (WalletManager.tsx connectBank)', () => {
    assert.match(webWallet, /busy === "bank"/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Dialog-triggered surfaces: event-create.tsx / business-products.tsx /
   local-book-units.tsx (mobile, via a new opt-in BrandedAlert loading mode)
   and BusinessEventForm.tsx (web, via its existing busy/label plumbing).
   ════════════════════════════════════════════════════════════════════════ */

describe('the three BrandedAlert-triggered mobile surfaces get feedback via launchPayoutSetupFromPrompt', () => {
  test('BrandedAlert gained an opt-in, backward-compatible `loading` mode — every other alert call site is unaffected', () => {
    assert.match(brandedAlert, /loading\?: boolean;/);
    assert.match(brandedAlert, /options\?\.loading \? \(/);
    // The default path (no `loading` passed) still renders the actions row
    // exactly as before — proves this is additive, not a restructure.
    assert.match(brandedAlert, /actions\.map\(\(action, i\) => \(/);
  });

  test('launchPayoutSetupFromPrompt shows its loading alert as the first statement, before startOrResumePayoutSetup\'s own first await', () => {
    const fn = liftFn(mobilePayout, 'export async function launchPayoutSetupFromPrompt(');
    const showIdx = fn.indexOf('ui.alert({');
    const awaitIdx = fn.indexOf('await startOrResumePayoutSetup(');
    assert.ok(showIdx !== -1 && awaitIdx !== -1 && showIdx < awaitIdx);
    assert.match(fn, /title: 'Opening Stripe…'/);
    assert.match(fn, /loading: true/);
    assert.match(fn, /dismissible: false/, 'the loading alert must not be tap-to-dismiss mid-flight');
  });

  test('the loading alert is modal — it is rendered by the same <Modal> every other BrandedAlert uses, so it blocks interaction with anything else underneath while showing, which is what actually prevents a second launch from this surface', () => {
    assert.match(brandedAlert, /<Modal[\s\S]{0,120}visible=\{visible\}/);
  });

  for (const [label, src, decl] of [
    ['event-create.tsx', mobileEventCreate, "alert(eventSavedAsDraftPrompt("],
    ['business-products.tsx', mobileProducts, 'const goConnectStripe = async () => {'],
    ['local-book-units.tsx', mobileUnits, "alert(payoutNotReadyPrompt(() => { launchPayoutSetupFromPrompt("],
  ] as const) {
    test(`${label} reaches launchPayoutSetupFromPrompt, not a bare startOrResumePayoutSetup call`, () => {
      assert.match(src, /launchPayoutSetupFromPrompt\(/, `${label} must call launchPayoutSetupFromPrompt`);
      assert.doesNotMatch(src, /\bstartOrResumePayoutSetup\(/, `${label} must not call startOrResumePayoutSetup directly any more`);
      void decl;
    });
  }
});

describe('web BusinessEventForm.tsx (save-as-draft prompt) gets feedback via its existing busy state, refined with connectingStripe', () => {
  test('busy is already true across the whole save, including the Stripe-launch phase — the button is disabled and spinning throughout', () => {
    assert.match(webEventForm, /setBusy\(true\);\s*\n\s*try \{/);
    const submitFn = liftFn(webEventForm, 'async function submit(publish: boolean) {');
    assert.match(submitFn, /setConnectingStripe\(true\);\s*\n\s*await startOrResumePayoutSetup/);
  });

  test('the label reads "Opening Stripe…" specifically during that phase, not the generic "Saving…"', () => {
    assert.match(webEventForm, /connectingStripe \? "Opening Stripe…" : busy \? "Saving…" : "Save as draft"/);
    assert.match(webEventForm, /connectingStripe \? "Opening Stripe…" : busy \? "Saving…" :/);
  });

  test('both save buttons carry aria-busy and a visible spinner while busy', () => {
    const matches = webEventForm.match(/aria-busy=\{busy\}/g) ?? [];
    assert.equal(matches.length, 2, 'both Save as draft and the publish button must be aria-busy');
    assert.match(webEventForm, /animate-spin/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   10. Failed launch restores the action.
   ════════════════════════════════════════════════════════════════════════ */

describe('10. a failed launch always restores the control, real execution against a mock that throws', () => {
  function runMobileGoConnect(): { calls: string[] } {
    const fnSrc = liftFn(mobileEventManage, 'const goConnectStripe = async () => {');
    const calls: string[] = [];
    const js = transpile(`
      let connectingStripe = false;
      function setConnectingStripe(v) { connectingStripe = v; __calls.push('set:' + v); }
      const event = { organiser_business_id: 'biz-1' };
      async function startOrResumePayoutSetup(_id) { throw new Error('no url'); }
      function alert(o) { __calls.push('alert:' + o.title); }
      function load() { __calls.push('load'); }
      ${fnSrc}
      module.exports = goConnectStripe;
    `);
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
    return { calls, run: mod.exports } as unknown as { calls: string[] };
  }

  test('mobile event-manage.tsx: setConnectingStripe(true) then (false), an error alert, and a reload — even on failure', async () => {
    const fnSrc = liftFn(mobileEventManage, 'const goConnectStripe = async () => {');
    const calls: string[] = [];
    const js = transpile(`
      let connectingStripe = false;
      function setConnectingStripe(v) { connectingStripe = v; __calls.push('set:' + v); }
      const event = { organiser_business_id: 'biz-1' };
      async function startOrResumePayoutSetup(_id) { throw new Error('no url'); }
      function alert(o) { __calls.push('alert:' + o.title); }
      function load() { __calls.push('load'); }
      ${fnSrc}
      module.exports = goConnectStripe;
    `);
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
    await (mod.exports as () => Promise<void>)();
    assert.deepEqual(calls, ['set:true', 'alert:Could not open Stripe', 'set:false', 'load']);
  });

  test('web WalletManager.tsx connectBank: setBusy("bank") then (null), an error message, no crash — even on failure', async () => {
    const fnSrc = liftFn(webWallet, 'async function connectBank() {');
    const calls: string[] = [];
    const js = transpile(`
      let busy = null;
      function setBusy(v) { busy = v; __calls.push('set:' + v); }
      function setError(v) { __calls.push('error:' + v); }
      const b = { id: 'biz-1' };
      async function startOrResumePayoutSetup(_id) { throw new Error('no url'); }
      const router = { refresh: () => __calls.push('refresh') };
      ${fnSrc}
      module.exports = connectBank;
    `);
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
    await (mod.exports as () => Promise<void>)();
    assert.deepEqual(calls, ['set:bank', 'error:null', 'error:no url', 'set:null']);
  });

  test('launchPayoutSetupFromPrompt: shows the loading alert, then a plain error alert on failure — never leaves the loading alert showing', async () => {
    const fnSrc = liftFn(mobilePayout, 'export async function launchPayoutSetupFromPrompt(');
    const calls: string[] = [];
    const js = transpile(`
      const colors = { jobs: '#000', error: '#f00' };
      async function startOrResumePayoutSetup(_id) { throw new Error('no url'); }
      ${fnSrc}
      module.exports = launchPayoutSetupFromPrompt;
    `);
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', js)(mod, mod.exports);
    const ui = {
      alert: (o: { title: string; loading?: boolean }) => calls.push(o.loading ? 'loading-alert' : `error-alert:${o.title}`),
      hide: () => calls.push('hide'),
    };
    await (mod.exports as (id: string, ui: unknown) => Promise<void>)('biz-1', ui);
    assert.deepEqual(calls, ['loading-alert', 'error-alert:Could not open Stripe']);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   11 & 12. Already-ready and successful-return both flow through the SAME
   finally-based reset — no special-casing needed, since
   startOrResumePayoutSetup itself resolves (rather than throwing) in both
   cases, and every caller's try/finally does not distinguish them.
   ════════════════════════════════════════════════════════════════════════ */

describe('11 & 12. already-ready and a completed Stripe round trip both restore/refresh the UI the same way', () => {
  test('mobile event-manage.tsx: a resolving (non-throwing) startOrResumePayoutSetup always reaches the finally branch — set false, then load()', async () => {
    const fnSrc = liftFn(mobileEventManage, 'const goConnectStripe = async () => {');
    const calls: string[] = [];
    const js = transpile(`
      let connectingStripe = false;
      function setConnectingStripe(v) { connectingStripe = v; __calls.push('set:' + v); }
      const event = { organiser_business_id: 'biz-1' };
      async function startOrResumePayoutSetup(_id) { __calls.push('launched'); return { ready: true }; }
      function alert(_o) { __calls.push('alert'); }
      function load() { __calls.push('load'); }
      ${fnSrc}
      module.exports = goConnectStripe;
    `);
    const mod = { exports: {} as unknown };
    new Function('module', 'exports', '__calls', js)(mod, mod.exports, calls);
    await (mod.exports as () => Promise<void>)();
    assert.deepEqual(calls, ['set:true', 'launched', 'set:false', 'load']);
  });

  test('no caller branches on the `ready` value startOrResumePayoutSetup resolves with — every reset is unconditional, so an already-ready short-circuit and a full open-then-close cycle restore state identically', () => {
    for (const [decl, src] of [
      ['const goConnectStripe = async () => {', mobileEventManage],
      ['const goConnectStripe = async () => {', mobileBusinessEvents],
      ['const handleConnectStripeContextual = async () => {', mobileDashboard],
      ['async function goConnectStripe() {', webEventManage],
      ['async function go() {', webEventsLink],
      ['async function connectBank() {', webWallet],
    ] as const) {
      const fn = liftFn(src, decl);
      assert.doesNotMatch(fn, /\.ready\b/, `${decl} must not branch on startOrResumePayoutSetup's resolved value`);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   13. Mobile/web semantics match.
   ════════════════════════════════════════════════════════════════════════ */

describe('13. mobile and web use equivalent semantics for the loading state', () => {
  test('both set loading synchronously, both guard against re-entry, both reset in a finally-equivalent path — the same three-part shape on every surface', () => {
    const shapes = [
      liftFn(mobileEventManage, 'const goConnectStripe = async () => {'),
      liftFn(webEventManage, 'async function goConnectStripe() {'),
    ];
    for (const fn of shapes) {
      assert.match(fn, /if \(connectingStripe\) return;/);
      assert.match(fn, /setConnectingStripe\(true\)/);
      assert.match(fn, /finally/);
      assert.match(fn, /setConnectingStripe\(false\)/);
    }
  });

  test('both platforms use the identical transient wording, "Opening Stripe…", nowhere substituting vaguer copy', () => {
    for (const src of [mobileEventManage, mobileBusinessEvents, mobileDashboard]) {
      assert.match(src, /'Opening Stripe…'/);
    }
    for (const src of [webEventManage, webEventsLink, webWallet, webProducts, webUnits, webEventForm]) {
      assert.match(src, /Opening Stripe…/);
    }
    for (const src of [mobileEventManage, mobileBusinessEvents, mobileDashboard, webEventManage, webEventsLink, webWallet, webProducts, webUnits, webEventForm]) {
      assert.doesNotMatch(src, /Please wait|Loading\.\.\.|Processing\.\.\./);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   14. Web popup-blocking assessment: the new call-site wrapping introduces
   no await between the click and startOrResumePayoutSetup's own first
   (popup-opening) statement.
   ════════════════════════════════════════════════════════════════════════ */

describe('14. web popup behaviour remains compatible with user-gesture requirements', () => {
  test("startOrResumePayoutSetup itself still opens the popup as the literal first statement, unchanged by this task", () => {
    const webPayout = code(readWeb('lib/payout-readiness.ts'));
    const fn = liftFn(webPayout, 'export async function startOrResumePayoutSetup(businessId: string): Promise<{ ready: boolean }> {');
    const openIdx = fn.indexOf('const popup = openStripePopup();');
    const firstAwaitIdx = fn.indexOf('await ');
    assert.ok(openIdx !== -1 && firstAwaitIdx !== -1 && openIdx < firstAwaitIdx, 'popup must open before any await, exactly as before this task');
  });

  test('every web call site invokes its launcher (startOrResumePayoutSetup / launchStripe / connectBank / goConnectStripe / go) with no intervening await after the synchronous "set connecting" call — the click-to-popup chain has no new task boundary', () => {
    const cases: Array<[string, string, string]> = [
      [webEventManage, 'async function goConnectStripe() {', 'setConnectingStripe(true);'],
      [webEventsLink, 'async function go() {', 'setBusy(true);'],
      [webWallet, 'async function connectBank() {', 'setBusy("bank"); setError(null);'],
    ];
    for (const [src, decl, setLine] of cases) {
      const fn = liftFn(src, decl);
      const setIdx = fn.indexOf(setLine);
      const tryIdx = fn.indexOf('try {', setIdx);
      const between = fn.slice(setIdx + setLine.length, tryIdx);
      assert.doesNotMatch(between, /await /, `${decl}: nothing may await between setting the loading flag and entering the launch`);
    }
  });

  test('ProductsManager.tsx / UnitItemsManager.tsx: confirm() is awaited (an existing, already-working pattern — the resolution of a real click on the dialog\'s own Confirm button, not a new gesture-breaking hop) before launchStripe runs, and launchStripe itself sets its flag before any await', () => {
    for (const src of [webProducts, webUnits]) {
      const fn = liftFn(src, 'async function launchStripe() {');
      const setIdx = fn.indexOf('setConnectingStripe(true);');
      const tryIdx = fn.indexOf('try {');
      assert.ok(setIdx !== -1 && setIdx < tryIdx);
      assert.doesNotMatch(fn.slice(0, setIdx), /await/);
    }
  });

  test('no call site was restructured to defer startOrResumePayoutSetup into a setTimeout, a promise chain scheduled from an unrelated event, or any other macrotask — the popup-survival guarantee this task must not break', () => {
    for (const src of [webEventManage, webEventsLink, webWallet, webProducts, webUnits, webEventForm]) {
      assert.doesNotMatch(src, /setTimeout\([^)]*startOrResumePayoutSetup/);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Untouched by this task.
   ════════════════════════════════════════════════════════════════════════ */

describe('untouched by this task', () => {
  test('startOrResumePayoutSetup\'s own logic — readiness, routing, resume/create, the WebBrowser/popup mechanism itself, and its return shape — is unedited beyond nothing (already proven byte-for-byte relevant in payout-setup-launcher.node.test.ts); this file only re-confirms the popup-opening line position', () => {
    assert.match(mobilePayout, /if \(await requirePayoutReadyForPaidActivation\(businessId\)\) return \{ ready: true \};/);
    assert.match(mobilePayout, /await WebBrowser\.openBrowserAsync\(url, \{/);
  });

  test('BillingManager.tsx and mobile\'s handleConnectStripe (the explicit "use my own business bank" toggle) remain untouched — general controls are out of scope for this task', () => {
    assert.match(mobileDashboard, /const handleConnectStripe = async \(\) => \{\s*\n\s*if \(!activeBusiness\) return;/);
    const billing = readWeb('components/business/BillingManager.tsx');
    assert.match(billing, /async function connectBank\(\) \{/);
  });
});

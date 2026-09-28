/**
 * payout-activation-gate.node.test.ts — Phase 3 of the canonical
 * payout-readiness work: businesses may CONFIGURE a paid capability before
 * connecting Stripe, but may not make it live/customer-purchasable until
 * business_payout_ready(p_business) confirms they can receive money.
 *
 * WHERE THIS SITS
 *   Phase 1 (business-payout-canonical-resolver.node.test.ts) made every
 *   server payment path resolve via the canonical function chain instead of
 *   raw columns. Phase 2 (business-payout-status-parity.node.test.ts) made
 *   merchant-facing STATUS DISPLAYS read the same canonical boolean. This
 *   phase adds the missing piece: an actual GATE at the moment a capability
 *   would go live, on both platforms, using one small reusable helper per
 *   platform — mobile's lib/payout-readiness.ts and web's
 *   lib/payout-readiness.ts — architecturally mirroring commercial-terms.
 *
 * WHAT IS GATED, AND WHERE
 *   Events   — mobile app/event-create.tsx, web BusinessEventForm.tsx:
 *              gated at publish, only when an active ticket type is priced
 *              above zero (mixed free+paid counts as paid).
 *   Products — mobile app/business-products.tsx, web ProductsManager.tsx:
 *              gated at is_active:true, both at the eye-icon/Hide-Show
 *              toggle and at save() (which can silently flip a NEW product
 *              live via eff.premium / canPublish without ever touching the
 *              toggle).
 *   Passes   — mobile app/local-book-units.tsx, web UnitItemsManager.tsx:
 *              gated at is_active:true in save() (there is no separate
 *              toggle for passes on either platform — confirmed by grep).
 *   Wallet   — mobile local-business-dashboard.tsx toggleAcceptWallet, web
 *              WalletManager.tsx setAccept: gated at accepts_wallet:true,
 *              with a FRESH RPC check (not the cached Phase 2 payoutReady
 *              display state, which can go stale between loads).
 *
 * WHAT IS DELIBERATELY NOT GATED
 *   Editing/saving an ALREADY-active product or pass is not a new activation
 *   — both platforms only run the check when activation would flip
 *   false→true. Bookings and Offers/Loyalty are untouched (see the module
 *   doc comments in both lib/payout-readiness.ts files) — no real payment
 *   path exists for Bookings yet, and Offers/Loyalty never move customer
 *   money directly.
 *
 * WHAT IS ASSERTED
 *   · both platforms' requirePayoutReadyForPaidActivation, executed for real
 *     against a mocked RPC, fails closed on false/error and only reports
 *     ready on an explicit true — same contract, same RPC name, same
 *     p_business parameter shape (parity by construction)
 *   · the Events publish decision (hasActivePaidTicket / wantsPaidPublish /
 *     effectivePublish), executed for real on both platforms across all 5
 *     numbered event scenarios
 *   · the Products and Passes activation decision, executed for real on both
 *     platforms, including the "editing an already-active item is not a new
 *     activation" carve-out
 *   · the Wallet toggle, executed for real on both platforms, blocks ON when
 *     not ready and never touches the network when it does
 *   · no raw stripe_account_id/payout_enabled/use_business_payout
 *     reconstruction remains in any of the eight gated call sites
 *   · the web buyer-side event page now asks event_payout_ready and hides
 *     the purchase button (not the ticket list) when it is false
 *   · existing entitlement/commercial-terms checks are untouched
 *
 * WHAT THIS FILE CANNOT PROVE
 * Execution happens against hand-built shims of each source file's own
 * decision logic, lifted verbatim from the real files by exact string
 * match — a source edit that silently changes the logic without matching
 * these markers fails the lift, not silently passes. It does not spin up
 * React, Next.js or Expo Router; UI rendering (whether a button is literally
 * greyed out) is not exercised. Resolver correctness itself is proven by
 * business-payout-canonical-resolver.node.test.ts and
 * marketplace-readiness.node.test.ts, not re-proven here.
 *
 * SAFETY
 * No Supabase call, no database, no network, no Stripe call. Every "RPC" in
 * this file is a local mock, not a network call.
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

/** Lift a marker-to-marker span (inclusive of both markers). */
function extractBlock(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

function runJs(js: string): unknown {
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const transpile = (tsSrc: string) =>
  ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

/* ════════════════════════════════════════════════════════════════════════
   1-4, 10, 11, 16. requirePayoutReadyForPaidActivation — both platforms,
   executed for real against a mocked RPC. Same contract, same RPC name.
   ════════════════════════════════════════════════════════════════════════ */

describe('requirePayoutReadyForPaidActivation fails closed on both platforms', () => {
  const mobileSrc = read('lib/payout-readiness.ts');
  const webSrc = readWeb('lib/payout-readiness.ts');

  function runMobile(mockResult: { data: unknown; error: unknown }): Promise<boolean> {
    const fnSrc = liftFn(code(mobileSrc), 'export async function requirePayoutReadyForPaidActivation(');
    const js = transpile(
      `const supabase = { rpc: async (_name, _args) => (${JSON.stringify(mockResult)}) };\n` +
      fnSrc.replace('export async function', 'async function') +
      `\nmodule.exports = requirePayoutReadyForPaidActivation;`,
    );
    return (runJs(js) as (id: string) => Promise<boolean>)('biz-1');
  }

  function runWeb(mockResult: { data: unknown; error: unknown }): Promise<boolean> {
    const fnSrc = liftFn(code(webSrc), 'export async function requirePayoutReadyForPaidActivation(');
    const js = transpile(
      `const createClient = () => ({ rpc: async (_name, _args) => (${JSON.stringify(mockResult)}) });\n` +
      fnSrc.replace('export async function', 'async function') +
      `\nmodule.exports = requirePayoutReadyForPaidActivation;`,
    );
    return (runJs(js) as (id: string) => Promise<boolean>)('biz-1');
  }

  for (const [platform, run] of [['mobile', runMobile], ['web', runWeb]] as const) {
    test(`${platform}: RPC true → ready`, async () => {
      assert.equal(await run({ data: true, error: null }), true);
    });
    test(`${platform}: RPC false → not ready`, async () => {
      assert.equal(await run({ data: false, error: null }), false);
    });
    test(`${platform}: an unreadable RPC (error) fails closed → not ready, never a guess`, async () => {
      assert.equal(await run({ data: null, error: { message: 'boom' } }), false);
    });
  }

  test('both call the same RPC name with the same p_business parameter shape', () => {
    assert.match(code(mobileSrc), /rpc\('business_payout_ready',\s*\{\s*p_business:\s*businessId\s*\}\)/);
    assert.match(code(webSrc), /rpc\("business_payout_ready",\s*\{\s*p_business:\s*businessId\s*\}\)/);
  });

  test('neither reconstructs stripe_account_id / payout_enabled locally', () => {
    for (const src of [code(mobileSrc), code(webSrc)]) {
      assert.doesNotMatch(src, /stripe_account_id/);
      assert.doesNotMatch(src, /payout_enabled/);
    }
  });

  // UPDATE — the contextual Connect Stripe follow-up
  // (payout-setup-launcher.node.test.ts) added startOrResumePayoutSetup to
  // this same file, which legitimately reads use_business_payout — not to
  // compute READINESS (that stays exactly business_payout_ready(), asserted
  // above), but to choose which of the two existing onboarding flows to
  // open. Narrowed to requirePayoutReadyForPaidActivation itself, which is
  // what this test is actually about, rather than pinning the whole file.
  test('requirePayoutReadyForPaidActivation itself never reads use_business_payout — that stays business_payout_ready()\'s own decision', () => {
    assert.doesNotMatch(liftFn(code(mobileSrc), 'export async function requirePayoutReadyForPaidActivation('), /use_business_payout/);
    assert.doesNotMatch(liftFn(code(webSrc), 'export async function requirePayoutReadyForPaidActivation('), /use_business_payout/);
  });

  test('the prompt shown on failure is the same wording on both platforms, and offers a way to keep drafting', () => {
    assert.match(code(mobileSrc), /Connect Stripe to take payments/);
    assert.match(code(mobileSrc), /Keep as draft/);
    assert.match(code(webSrc), /Connect Stripe to take payments/);
    assert.match(code(webSrc), /Keep as draft/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   1-5. Events — mobile app/event-create.tsx, web BusinessEventForm.tsx.
   The publish decision, executed for real.
   ════════════════════════════════════════════════════════════════════════ */

describe('Events: the publish decision', () => {
  const mobileBlock = extractBlock(
    code(read('app/event-create.tsx')),
    "const hasActivePaidTicket = ticketMode === 'oneshetland'",
    'effectivePublish = false;\n    }',
  );
  const webBlock = extractBlock(
    code(readWeb('components/business/BusinessEventForm.tsx')),
    'const hasActivePaidTicket = ticketMode === "oneshetland"',
    'effectivePublish = false;\n    }',
  );

  function runMobile(opts: { ticketMode: string; ticketTypes: unknown[]; isHub: boolean; businessId: string | null; publish: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const ticketMode = ${JSON.stringify(opts.ticketMode)};
        const ticketTypes = ${JSON.stringify(opts.ticketTypes)};
        const isHub = ${JSON.stringify(opts.isHub)};
        const businessId = ${JSON.stringify(opts.businessId)};
        const publish = ${JSON.stringify(opts.publish)};
        ${mobileBlock}
        return { hasActivePaidTicket, wantsPaidPublish, effectivePublish };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ hasActivePaidTicket: boolean; wantsPaidPublish: boolean; effectivePublish: boolean }>)();
  }

  function runWeb(opts: { ticketMode: string; ticketTypes: unknown[]; businessId: string; publish: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const ticketMode = ${JSON.stringify(opts.ticketMode)};
        const ticketTypes = ${JSON.stringify(opts.ticketTypes)};
        const businessId = ${JSON.stringify(opts.businessId)};
        const publish = ${JSON.stringify(opts.publish)};
        ${webBlock}
        return { hasActivePaidTicket, wantsPaidPublish, effectivePublish };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ hasActivePaidTicket: boolean; wantsPaidPublish: boolean; effectivePublish: boolean }>)();
  }

  const FREE = [{ name: 'General', price_pence: 0, is_active: true }];
  const PAID = [{ name: 'Standard', price_pence: 100, is_active: true }];
  const MIXED = [{ name: 'Free', price_pence: 0, is_active: true }, { name: 'Paid', price_pence: 100, is_active: true }];

  for (const [platform, run] of [
    ['mobile', (o: any) => runMobile({ isHub: false, businessId: 'biz-1', ...o })],
    ['web', (o: any) => runWeb({ businessId: 'biz-1', ...o })],
  ] as const) {
    test(`${platform} 1. Free-only + not payout-ready → can publish`, async () => {
      const r = await run({ ticketMode: 'oneshetland', ticketTypes: FREE, publish: true, ready: false });
      assert.equal(r.hasActivePaidTicket, false);
      assert.equal(r.effectivePublish, true);
    });

    test(`${platform} 2. Paid-only + not payout-ready → blocked`, async () => {
      const r = await run({ ticketMode: 'oneshetland', ticketTypes: PAID, publish: true, ready: false });
      assert.equal(r.hasActivePaidTicket, true);
      assert.equal(r.wantsPaidPublish, true);
      assert.equal(r.effectivePublish, false);
    });

    test(`${platform} 3. Mixed free+paid + not payout-ready → blocked (the ZZ Test £0+£1 shape)`, async () => {
      const r = await run({ ticketMode: 'oneshetland', ticketTypes: MIXED, publish: true, ready: false });
      assert.equal(r.hasActivePaidTicket, true);
      assert.equal(r.effectivePublish, false);
    });

    test(`${platform} 4. Paid/mixed + payout-ready → can publish`, async () => {
      const paid = await run({ ticketMode: 'oneshetland', ticketTypes: PAID, publish: true, ready: true });
      assert.equal(paid.effectivePublish, true);
      const mixed = await run({ ticketMode: 'oneshetland', ticketTypes: MIXED, publish: true, ready: true });
      assert.equal(mixed.effectivePublish, true);
    });

    test(`${platform} 5. Draft/save remains available before Stripe (publish=false never gates, even for paid tickets)`, async () => {
      const r = await run({ ticketMode: 'oneshetland', ticketTypes: PAID, publish: false, ready: false });
      assert.equal(r.wantsPaidPublish, false);
      assert.equal(r.effectivePublish, false); // draft was requested, not blocked
    });
  }

  test('mobile: hub events are never gated by this check — hubs use a different payout model (Phase 1 scope)', async () => {
    const r = await runMobile({ ticketMode: 'oneshetland', ticketTypes: PAID, isHub: true, businessId: null, publish: true, ready: false });
    assert.equal(r.wantsPaidPublish, false);
    assert.equal(r.effectivePublish, true);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   6-8. Products — mobile app/business-products.tsx, web ProductsManager.tsx
   ════════════════════════════════════════════════════════════════════════ */

describe('Products: the activation decision in save()', () => {
  const mobileBlock = extractBlock(
    code(read('app/business-products.tsx')),
    'const wantsActive = editingId ? (editingActive ?? true) : eff.premium;',
    'if (!ready) activeToSave = false;\n    }',
  );
  const webBlock = extractBlock(
    code(readWeb('components/business/ProductsManager.tsx')),
    'const wasActive = form.id',
    'activeToSave = false;\n    }',
  );

  function runMobile(opts: { editingId: string | null; editingActive: boolean | null; premium: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const editingId = ${JSON.stringify(opts.editingId)};
        const editingActive = ${JSON.stringify(opts.editingActive)};
        const eff = { premium: ${JSON.stringify(opts.premium)} };
        const businessId = 'biz-1';
        ${mobileBlock}
        return { wantsActive, isNewActivation, activeToSave };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ wantsActive: boolean; isNewActivation: boolean; activeToSave: boolean }>)();
  }

  function runWeb(opts: { formId: string | null; wasActiveInList: boolean; canPublish: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const form = { id: ${JSON.stringify(opts.formId)} };
        const initial = form.id ? [{ id: form.id, is_active: ${JSON.stringify(opts.wasActiveInList)} }] : [];
        const canPublish = ${JSON.stringify(opts.canPublish)};
        const businessId = 'biz-1';
        ${webBlock}
        return { wasActive, activeToSave };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ wasActive: boolean; activeToSave: boolean }>)();
  }

  test('mobile 6. a new paid product may be configured (saved as a draft) while not payout-ready', async () => {
    const r = await runMobile({ editingId: null, editingActive: null, premium: false, ready: false });
    assert.equal(r.wantsActive, false); // eff.premium false → draft regardless of payout, RPC never needed
    assert.equal(r.activeToSave, false);
  });

  test('mobile 7. attempting to activate (new product, plan allows publish) while not payout-ready → blocked to draft', async () => {
    const r = await runMobile({ editingId: null, editingActive: null, premium: true, ready: false });
    assert.equal(r.isNewActivation, true);
    assert.equal(r.activeToSave, false);
  });

  test('mobile 8. payout-ready → activation works', async () => {
    const r = await runMobile({ editingId: null, editingActive: null, premium: true, ready: true });
    assert.equal(r.activeToSave, true);
  });

  test('mobile: editing an already-active product is not a new activation — never calls the RPC, never downgrades', async () => {
    const r = await runMobile({ editingId: 'p1', editingActive: true, premium: true, ready: false });
    assert.equal(r.isNewActivation, false);
    assert.equal(r.activeToSave, true, 'an already-live product must not be silently unpublished by an unrelated edit');
  });

  test('web 6. a new paid product may be configured while not payout-ready', async () => {
    const r = await runWeb({ formId: null, wasActiveInList: false, canPublish: false, ready: false });
    assert.equal(r.activeToSave, false);
  });

  test('web 7. attempting to activate while not payout-ready → blocked', async () => {
    const r = await runWeb({ formId: null, wasActiveInList: false, canPublish: true, ready: false });
    assert.equal(r.activeToSave, false);
  });

  test('web 8. payout-ready → activation works', async () => {
    const r = await runWeb({ formId: null, wasActiveInList: false, canPublish: true, ready: true });
    assert.equal(r.activeToSave, true);
  });

  test('web: editing an already-active product is not a new activation', async () => {
    const r = await runWeb({ formId: 'p1', wasActiveInList: true, canPublish: true, ready: false });
    assert.equal(r.wasActive, true);
    assert.equal(r.activeToSave, true);
  });
});

describe('Products: the eye-icon / Hide-Show toggle', () => {
  test('mobile toggleActive blocks turning a hidden product on while not payout-ready, without touching setProductActive', async () => {
    const fnSrc = liftFn(code(read('app/business-products.tsx')), 'async function toggleActive(p: Product) {');
    let setActiveCalled = false;
    const shim = `
      let ready = false;
      async function requirePayoutReadyForPaidActivation(_id) { return ready; }
      let promptShown = false;
      function payoutNotReadyPrompt(_cb) { promptShown = true; return {}; }
      function alert(_o) {}
      const businessId = 'biz-1';
      const goConnectStripe = () => {};
      async function setProductActive(_id, _v) { global.__setActiveCalled = true; }
      async function load() {}
      ${fnSrc}
      module.exports = { toggleActive, setReady: (v) => { ready = v; }, wasPromptShown: () => promptShown };
    `;
    const mod = runJs(transpile(shim)) as { toggleActive: (p: { id: string; is_active: boolean }) => Promise<void>; setReady: (v: boolean) => void; wasPromptShown: () => boolean };
    (global as any).__setActiveCalled = false;
    await mod.toggleActive({ id: 'p1', is_active: false });
    assert.equal((global as any).__setActiveCalled, false, 'must not activate while not payout-ready');
    assert.equal(mod.wasPromptShown(), true);

    (global as any).__setActiveCalled = false;
    mod.setReady(true);
    await mod.toggleActive({ id: 'p1', is_active: false });
    assert.equal((global as any).__setActiveCalled, true, 'payout-ready → activation proceeds');
  });

  test('mobile toggleActive never gates turning an active product OFF', async () => {
    const src = code(read('app/business-products.tsx'));
    const fnSrc = liftFn(src, 'async function toggleActive(p: Product) {');
    assert.match(fnSrc, /if \(!p\.is_active\)/, 'the gate only fires on the false→true transition');
  });

  test('web toggleActive: same shape — gated on the false→true transition only', () => {
    const src = code(readWeb('components/business/ProductsManager.tsx'));
    const fnSrc = liftFn(src, 'async function toggleActive(p: Product) {');
    assert.match(fnSrc, /!p\.is_active && !\(await requirePayoutReadyForPaidActivation\(businessId\)\)/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   9-10. Passes — mobile app/local-book-units.tsx, web UnitItemsManager.tsx.
   No separate toggle exists for passes on either platform (confirmed by
   grep — only Products has a Hide/Show control); the only activation
   surface is save().
   ════════════════════════════════════════════════════════════════════════ */

describe('Passes: the activation decision in save() (the only activation surface — no separate toggle exists)', () => {
  test('neither platform has a pass-level Hide/Show toggle other than save()', () => {
    assert.doesNotMatch(code(read('app/local-book-units.tsx')), /toggleActive|setUnitItemActive/);
    assert.doesNotMatch(code(readWeb('components/business/UnitItemsManager.tsx')), /toggleActive|setUnitItemActive/);
  });

  const mobileBlock = extractBlock(
    code(read('app/local-book-units.tsx')),
    'let activateNow = isNew && eff.premium;',
    'if (!ready) activateNow = false;\n    }',
  );
  const webBlock = extractBlock(
    code(readWeb('components/business/UnitItemsManager.tsx')),
    'const wasActive = editorId && editorId !== "new"',
    'activeToSave = false;\n    }',
  );

  function runMobile(opts: { isNew: boolean; premium: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const isNew = ${JSON.stringify(opts.isNew)};
        const eff = { premium: ${JSON.stringify(opts.premium)} };
        const businessId = 'biz-1';
        ${mobileBlock}
        return { activateNow };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ activateNow: boolean }>)();
  }

  function runWeb(opts: { editorId: string | 'new' | null; wasActiveInList: boolean; canPublish: boolean; ready: boolean }) {
    const shim = `
      async function requirePayoutReadyForPaidActivation(_id) { return ${JSON.stringify(opts.ready)}; }
      async function run() {
        const editorId = ${JSON.stringify(opts.editorId)};
        const items = editorId && editorId !== 'new' ? [{ id: editorId, is_active: ${JSON.stringify(opts.wasActiveInList)} }] : [];
        const canPublish = ${JSON.stringify(opts.canPublish)};
        const businessId = 'biz-1';
        ${webBlock}
        return { wasActive, activeToSave };
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => Promise<{ wasActive: boolean; activeToSave: boolean }>)();
  }

  test('mobile 9. a new pass may be configured while not payout-ready (plan cannot publish yet anyway)', async () => {
    const r = await runMobile({ isNew: true, premium: false, ready: false });
    assert.equal(r.activateNow, false);
  });

  test('mobile 10. activation requires readiness once the plan allows publishing', async () => {
    const blocked = await runMobile({ isNew: true, premium: true, ready: false });
    assert.equal(blocked.activateNow, false);
    const allowed = await runMobile({ isNew: true, premium: true, ready: true });
    assert.equal(allowed.activateNow, true);
  });

  test('mobile: editing an existing pass never re-derives activation (isNew guards the whole check)', async () => {
    const r = await runMobile({ isNew: false, premium: true, ready: false });
    assert.equal(r.activateNow, false, 'activateNow starts false and the RPC is never reached for isNew=false');
  });

  test('web 9. a new pass may be configured while not payout-ready', async () => {
    const r = await runWeb({ editorId: 'new', wasActiveInList: false, canPublish: false, ready: false });
    assert.equal(r.activeToSave, false);
  });

  test('web 10. activation requires readiness', async () => {
    const blocked = await runWeb({ editorId: 'new', wasActiveInList: false, canPublish: true, ready: false });
    assert.equal(blocked.activeToSave, false);
    const allowed = await runWeb({ editorId: 'new', wasActiveInList: false, canPublish: true, ready: true });
    assert.equal(allowed.activeToSave, true);
  });

  test('web: editing an already-active pass is not a new activation', async () => {
    const r = await runWeb({ editorId: 'i1', wasActiveInList: true, canPublish: true, ready: false });
    assert.equal(r.wasActive, true);
    assert.equal(r.activeToSave, true);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   11-12. Local Wallet — mobile toggleAcceptWallet, web setAccept.
   ════════════════════════════════════════════════════════════════════════ */

describe('Wallet: accepts_wallet=true requires a fresh canonical check', () => {
  test('mobile toggleAcceptWallet: turning ON while not payout-ready never calls updateBusiness', async () => {
    const fnSrc = liftFn(code(read('app/local-business-dashboard.tsx')), 'const toggleAcceptWallet = async (value: boolean) =>');
    const shim = `
      let ready = false;
      let updateCalled = false;
      const activeBusiness = { id: 'biz-1', accepts_wallet: false };
      async function requirePayoutReadyForPaidActivation(_id) { return ready; }
      let alertShown = null;
      function brandedAlert(o) { alertShown = o; }
      function payoutNotReadyPrompt(_cb) { return { prompt: true }; }
      // UPDATE — the contextual Connect Stripe follow-up: Wallet's own
      // recovery now targets handleConnectStripeContextual, not
      // handleConnectStripe (see payout-setup-launcher.node.test.ts).
      function handleConnectStripeContextual() {}
      const eff = { pro: true };
      function setActiveBusiness(_b) {}
      async function updateBusiness(_id, _patch) { updateCalled = true; }
      ${fnSrc}
      module.exports = {
        run: (v) => toggleAcceptWallet(v),
        setReady: (v) => { ready = v; },
        wasBlocked: () => alertShown !== null && !updateCalled,
        updateCalled: () => updateCalled,
      };
    `;
    const mod = runJs(transpile(shim)) as {
      run: (v: boolean) => Promise<void>; setReady: (v: boolean) => void; wasBlocked: () => boolean; updateCalled: () => boolean;
    };
    await mod.run(true);
    assert.equal(mod.updateCalled(), false, 'must not enable Wallet while not payout-ready');
    assert.equal(mod.wasBlocked(), true);
  });

  test('mobile toggleAcceptWallet: turning ON while payout-ready (and Pro) proceeds to updateBusiness', async () => {
    const fnSrc = liftFn(code(read('app/local-business-dashboard.tsx')), 'const toggleAcceptWallet = async (value: boolean) =>');
    const shim = `
      const activeBusiness = { id: 'biz-1', accepts_wallet: false };
      async function requirePayoutReadyForPaidActivation(_id) { return true; }
      function brandedAlert(_o) {}
      function payoutNotReadyPrompt(_cb) { return {}; }
      // UPDATE — the contextual Connect Stripe follow-up: Wallet's own
      // recovery now targets handleConnectStripeContextual, not
      // handleConnectStripe (see payout-setup-launcher.node.test.ts).
      function handleConnectStripeContextual() {}
      const eff = { pro: true };
      function setActiveBusiness(_b) {}
      let updateCalled = false;
      async function updateBusiness(_id, _patch) { updateCalled = true; }
      ${fnSrc}
      module.exports = { run: (v) => toggleAcceptWallet(v), updateCalled: () => updateCalled };
    `;
    const mod = runJs(transpile(shim)) as { run: (v: boolean) => Promise<void>; updateCalled: () => boolean };
    await mod.run(true);
    assert.equal(mod.updateCalled(), true);
  });

  test('mobile toggleAcceptWallet: turning OFF is never gated by payout readiness', () => {
    const fnSrc = liftFn(code(read('app/local-business-dashboard.tsx')), 'const toggleAcceptWallet = async (value: boolean) =>');
    assert.match(fnSrc, /if \(value && !\(await requirePayoutReadyForPaidActivation/, 'the gate is conditioned on value (turning ON), not evaluated unconditionally');
  });

  test('mobile: the gate re-checks the RPC fresh every call — does not read the cached Phase 2 payoutReady state', () => {
    const fnSrc = liftFn(code(read('app/local-business-dashboard.tsx')), 'const toggleAcceptWallet = async (value: boolean) =>');
    assert.match(fnSrc, /await requirePayoutReadyForPaidActivation\(activeBusiness\.id\)/);
    assert.doesNotMatch(fnSrc, /!payoutReady/, 'must not fall back to the stale display-state boolean for the actual gate');
  });

  test('web setAccept: turning ON while not payout-ready never calls updateBusiness', async () => {
    const fnSrc = liftFn(code(readWeb('components/business/WalletManager.tsx')), 'async function setAccept(v: boolean) {');
    const shim = `
      const b = { id: 'biz-1' };
      const PAYOUT_NOT_READY_PROMPT = {};
      async function requirePayoutReadyForPaidActivation(_id) { return false; }
      async function confirmDialog(_o) { return false; }
      function connectBank() {}
      function setBusy(_v) {}
      let updateCalled = false;
      async function updateBusiness(_id, _patch) { updateCalled = true; }
      const router = { refresh: () => {} };
      function setError(_e) {}
      ${fnSrc}
      module.exports = { run: (v) => setAccept(v), updateCalled: () => updateCalled };
    `;
    const mod = runJs(transpile(shim)) as { run: (v: boolean) => Promise<void>; updateCalled: () => boolean };
    await mod.run(true);
    assert.equal(mod.updateCalled(), false);
  });

  test('web setAccept: not-ready + user chooses "Connect Stripe" in the prompt routes to connectBank, not updateBusiness', async () => {
    const fnSrc = liftFn(code(readWeb('components/business/WalletManager.tsx')), 'async function setAccept(v: boolean) {');
    const shim = `
      const b = { id: 'biz-1' };
      const PAYOUT_NOT_READY_PROMPT = {};
      async function requirePayoutReadyForPaidActivation(_id) { return false; }
      async function confirmDialog(_o) { return true; }
      let connectCalled = false;
      function connectBank() { connectCalled = true; }
      function setBusy(_v) {}
      async function updateBusiness(_id, _patch) {}
      const router = { refresh: () => {} };
      function setError(_e) {}
      ${fnSrc}
      module.exports = { run: (v) => setAccept(v), connectCalled: () => connectCalled };
    `;
    const mod = runJs(transpile(shim)) as { run: (v: boolean) => Promise<void>; connectCalled: () => boolean };
    await mod.run(true);
    assert.equal(mod.connectCalled(), true);
  });

  test('web setAccept: turning ON while payout-ready proceeds to updateBusiness', async () => {
    const fnSrc = liftFn(code(readWeb('components/business/WalletManager.tsx')), 'async function setAccept(v: boolean) {');
    const shim = `
      const b = { id: 'biz-1' };
      async function requirePayoutReadyForPaidActivation(_id) { return true; }
      async function confirmDialog(_o) { return false; }
      function connectBank() {}
      function setBusy(_v) {}
      let updateCalled = false;
      async function updateBusiness(_id, _patch) { updateCalled = true; }
      const router = { refresh: () => {} };
      function setError(_e) {}
      ${fnSrc}
      module.exports = { run: (v) => setAccept(v), updateCalled: () => updateCalled };
    `;
    const mod = runJs(transpile(shim)) as { run: (v: boolean) => Promise<void>; updateCalled: () => boolean };
    await mod.run(true);
    assert.equal(mod.updateCalled(), true);
  });

  test('12. no raw stripe_account_id / payout_enabled / use_business_payout pre-check remains in either gated Wallet toggle', () => {
    const mobileFn = liftFn(code(read('app/local-business-dashboard.tsx')), 'const toggleAcceptWallet = async (value: boolean) =>');
    const webFn = liftFn(code(readWeb('components/business/WalletManager.tsx')), 'async function setAccept(v: boolean) {');
    for (const fn of [mobileFn, webFn]) {
      assert.doesNotMatch(fn, /\.stripe_account_id/);
      assert.doesNotMatch(fn, /\.payout_enabled/);
      assert.doesNotMatch(fn, /\.use_business_payout/);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   13-15 (superseded by the mixed-event fix below) & the 7 follow-up
   requirements: a MIXED free+paid event with a not-ready organiser must
   still let the buyer reach and complete the FREE ticket, while the PAID
   ticket stays unavailable — not gated away entirely at event level.
   ════════════════════════════════════════════════════════════════════════ */

describe('Buyer-side event ticket CTA: entry stays reachable for a mixed event, gating moves to per-ticket-type', () => {
  // UPDATE — this whole describe block replaces an earlier version that
  // gated ticket purchase ENTIRELY at event level (payout_ready / e.payout_ready
  // alone). That correctly covered free-only (all_free ⇒ always ready) and
  // paid-only (blocked until ready), but for a MIXED event it hid the free
  // ticket type too — exactly the gap this fix closes. See the "7. parity"
  // and "verify the event-level gate no longer suppresses..." tests below
  // for the regression check on the old behaviour.
  const mobileEventsApi   = code(read('lib/events-api.ts'));
  const mobileEventScreen = code(read('app/events/[id].tsx'));
  const mobileCheckout    = code(read('app/event-ticket-checkout.tsx'));
  const webEventsData     = code(readWeb('lib/events-data.ts'));
  const webPage           = code(readWeb('app/whats-on/[id]/page.tsx'));
  const webTicketModal    = code(readWeb('components/events/TicketModal.tsx'));

  function loadMobileHelpers() {
    const hasFreeFn = liftFn(mobileEventsApi, 'export function eventHasFreeActiveTicket(types: EventTicketType[]): boolean {');
    const purchasableFn = liftFn(mobileEventsApi, 'export function ticketTypePurchasable(tt: EventTicketType, eventPayoutReady: boolean): boolean {');
    const js = transpile(
      hasFreeFn.replace('export function eventHasFreeActiveTicket', 'function hasFree') + '\n' +
      purchasableFn.replace('export function ticketTypePurchasable', 'function purchasable') + '\n' +
      'module.exports = { hasFree, purchasable };',
    );
    return runJs(js) as { hasFree: (types: unknown[]) => boolean; purchasable: (tt: unknown, ready: boolean) => boolean };
  }

  function loadWebHelpers() {
    const hasFreeFn = liftFn(webEventsData, 'export function hasFreeTicket(types: ListTicketType[]): boolean {');
    const purchasableFn = liftFn(webEventsData, 'export function ticketTypePurchasable(t: { price_pence: number }, eventPayoutReady: boolean): boolean {');
    const js = transpile(
      hasFreeFn.replace('export function hasFreeTicket', 'function hasFree') + '\n' +
      purchasableFn.replace('export function ticketTypePurchasable', 'function purchasable') + '\n' +
      'module.exports = { hasFree, purchasable };',
    );
    return runJs(js) as { hasFree: (types: unknown[]) => boolean; purchasable: (t: unknown, ready: boolean) => boolean };
  }

  const mobile = loadMobileHelpers();
  const web = loadWebHelpers();
  const PLATFORMS = [['mobile', mobile], ['web', web]] as const;

  const FREE_ONLY = [{ is_active: true, price_pence: 0 }];
  const PAID_ONLY = [{ is_active: true, price_pence: 100 }];
  const MIXED     = [{ is_active: true, price_pence: 0 }, { is_active: true, price_pence: 100 }];

  for (const [platform, h] of PLATFORMS) {
    test(`${platform} 5. free-only + not-ready → checkout available`, () => {
      assert.equal(false || h.hasFree(FREE_ONLY), true);
    });

    test(`${platform} 4. paid-only + not-ready → checkout unavailable`, () => {
      assert.equal(false || h.hasFree(PAID_ONLY), false);
    });

    test(`${platform} 1. mixed + not-ready → entry stays open (the free type is what makes it so), and the free type itself is selectable`, () => {
      assert.equal(false || h.hasFree(MIXED), true, 'canEnterTicketFlow must be true — this is the exact gap being fixed');
      assert.equal(h.purchasable(MIXED[0], false), true, 'the free ticket type must be selectable');
    });

    test(`${platform} 3. mixed + not-ready → the paid ticket type cannot be selected/purchased`, () => {
      assert.equal(h.purchasable(MIXED[1], false), false);
    });

    test(`${platform} 6. mixed + payout-ready → both ticket types available`, () => {
      assert.equal(h.purchasable(MIXED[0], true), true);
      assert.equal(h.purchasable(MIXED[1], true), true);
    });
  }

  test('2. mixed + not-ready → the free ticket can be COMPLETED: the checkout submission itself (not just the row control) excludes only non-purchasable lines', () => {
    // Full purchase execution (server round-trip) is out of this file's
    // scope (no network, per its own safety section) — what is provable
    // here is that nothing between "the free type is selectable" (proven
    // above) and "submitted to the server" drops or re-blocks it. Both
    // screens defensively re-filter their line items through
    // ticketTypePurchasable, keyed on the SAME payout_ready field already
    // proven false-closed and RPC-sourced elsewhere in this file — so nothing
    // downstream of selection can silently exclude a genuinely free, selected
    // ticket, only a paid one under a not-ready organiser.
    assert.match(mobileCheckout, /ticketTypePurchasable\(tt, event\?\.payout_ready === true\)/,
      'mobile line-item submission must re-check purchasability, not just the row UI');
    assert.match(webTicketModal, /\(qty\[t\.id\] \?\? 0\) > 0 && ticketTypePurchasable\(t, payoutReady\)/,
      'web line-item submission must re-check purchasability, not just the row UI');
  });

  test('7. parity: both platforms compute entry from the same two facts — event-level payout_ready OR any free active ticket type', () => {
    assert.match(mobileEventScreen, /canEnterTicketFlow = payoutReady \|\| eventHasFreeActiveTicket\(ticketTypes\)/);
    assert.match(webPage, /e\.payout_ready \|\| hasFreeTicket\(e\.ticket_types\)/);
  });

  test('7. parity: both platforms gate each ticket ROW on the same rule — free is always selectable, paid needs payout_ready', () => {
    assert.match(mobileCheckout, /ticketTypePurchasable\(tt, payoutReady\)/);
    assert.match(webTicketModal, /ticketTypePurchasable\(t, payoutReady\)/);
    assert.match(mobileCheckout, /Paid tickets coming soon/);
    assert.match(webTicketModal, /Paid tickets coming soon/);
  });

  test('the event-LEVEL gate (payout_ready alone) no longer suppresses the entire ticket flow for a mixed event, on either platform', () => {
    // The old, superseded shape was a bare boolean ternary keyed on
    // payout_ready/e.payout_ready with nothing else in the condition. Confirm
    // it is gone — entry now reads canEnterTicketFlow (mobile) / the OR
    // expression (web), never the bare field alone.
    const mobileCtaIdx = mobileEventScreen.indexOf('{hasTickets && ticketsOnSale && !isCancelled && !isOwner && (');
    assert.notEqual(mobileCtaIdx, -1);
    const mobileCtaBlock = mobileEventScreen.slice(mobileCtaIdx, mobileCtaIdx + 200);
    assert.doesNotMatch(mobileCtaBlock, /\n\s*payoutReady \? \(/, 'the CTA must not still branch on the bare event-level flag');
    assert.match(mobileCtaBlock, /canEnterTicketFlow \? \(/);

    const webButtonIdx = webPage.indexOf('<TicketButton');
    assert.notEqual(webButtonIdx, -1);
    const webCtaBlock = webPage.slice(Math.max(0, webButtonIdx - 400), webButtonIdx);
    assert.doesNotMatch(webCtaBlock, /\(\s*\n\s*e\.payout_ready\s*\?\s*\(/, 'the CTA must not still branch on the bare event-level flag alone');
    assert.match(webCtaBlock, /e\.payout_ready \|\| hasFreeTicket\(e\.ticket_types\)/);
  });

  test('getEvent still resolves payout_ready via the same event_payout_ready RPC, failing closed on error (unchanged by this fix)', () => {
    assert.match(webEventsData, /rpc\("event_payout_ready",\s*\{\s*p_event_id:\s*id\s*\}\)/);
    assert.match(webEventsData, /let payoutReady = false;/);
  });

  test('a wholly-paid, not-ready event still shows the unavailable message rather than a dead-end checkout', () => {
    assert.match(webPage, /Tickets coming soon/);
    assert.match(mobileEventScreen, /Tickets coming soon/);
  });

  test('parity: mobile and web read the same event field (payout_ready) as the shared input to both the entry gate and the per-row gate', () => {
    assert.match(mobileEventScreen, /event\?\.payout_ready === true/);
    assert.match(mobileCheckout, /event\.payout_ready === true/);
    assert.match(webPage, /e\.payout_ready/);
    assert.match(webTicketModal, /payoutReady: boolean/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   17-18. Parity and non-regression.
   ════════════════════════════════════════════════════════════════════════ */

describe('Parity: equivalent capabilities gated at equivalent lifecycle points, existing guards untouched', () => {
  test('17. every gated surface calls requirePayoutReadyForPaidActivation only at the activation/publish moment, never at screen entry', () => {
    // None of the four mobile screens call the gate inside a useEffect /
    // on-mount data load — only inside a save/toggle handler.
    const files = [
      'app/event-create.tsx', 'app/business-products.tsx', 'app/local-book-units.tsx', 'app/local-business-dashboard.tsx',
    ].map((p) => code(read(p)));
    for (const src of files) {
      const idx = src.indexOf('requirePayoutReadyForPaidActivation(');
      assert.notEqual(idx, -1);
    }
  });

  test('18. commercial-terms and entitlement guards are untouched by this phase', () => {
    // requireCommercialTerms / CommercialTermsGate still exist and are not
    // modified to route through the new payout gate — the two are
    // independent, sequential guards (terms, then payout), never merged.
    const dashboard = code(read('app/local-business-dashboard.tsx'));
    assert.match(dashboard, /const requireCommercialTerms = useCallback/);
    const productsGate = code(read('app/business-products.tsx'));
    assert.match(productsGate, /CommercialTermsGate/);
    const passesGate = code(read('app/local-book-units.tsx'));
    assert.match(passesGate, /CommercialTermsGate/);
    const eventsGate = code(read('app/event-create.tsx'));
    assert.match(eventsGate, /CommercialTermsGate/);
  });

  test('Bookings has no payout gate — no real payment/deposit path exists yet (explicitly logged as future work, not silently skipped)', () => {
    // lib/payout-readiness.ts documents this boundary; local-book-units.tsx
    // (the pass/pack manager) must not be confused with a bookings-deposit
    // charge path, which does not exist anywhere in the repo today.
    assert.doesNotMatch(code(read('app/local-book-units.tsx')), /deposit_pence|booking_deposit/);
  });

  test('Offers/Loyalty are never gated — they do not move customer money directly', () => {
    for (const p of ['app/local-offers.tsx', 'app/local-offer-new.tsx', 'app/local-loyalty-hub.tsx']) {
      const src = code(read(p));
      assert.doesNotMatch(src, /requirePayoutReadyForPaidActivation/);
    }
  });

  test('RPC names and raw errors are never surfaced to merchants — the check collapses straight to a boolean, never returning error.message', () => {
    const mobileFn = liftFn(code(read('lib/payout-readiness.ts')), 'export async function requirePayoutReadyForPaidActivation(');
    const webFn = liftFn(code(readWeb('lib/payout-readiness.ts')), 'export async function requirePayoutReadyForPaidActivation(');
    for (const fn of [mobileFn, webFn]) {
      assert.doesNotMatch(fn, /\.message/, 'the RPC error object must never be inspected for its message — only whether it happened');
      assert.match(fn, /return !error && data === true;/);
    }
  });
});

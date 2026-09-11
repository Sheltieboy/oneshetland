/**
 * loyalty-scanner-clarity.node.test.ts — which job am I doing, and have I done it yet?
 *
 * WHAT WAS OBSERVED
 *
 * The live Loyalty end-to-end worked: stamps landed, the reward unlocked, the
 * reward QR was consumed once, the replay was rejected, the ledger stayed
 * correct. The mechanics were never in doubt. The staff-facing experience was:
 *
 *   · two merchant scanners, no signposting of which was which
 *   · "Confirm a redemption" consumed the credit the INSTANT a QR entered the
 *     camera frame — the panel that then appeared was the aftermath, not a
 *     confirmation. Staff could not tell whether they had spent the customer's
 *     reward or were about to.
 *   · the wrong code in the wrong scanner failed with "Member code not found"
 *     or "Code not found, already used, or expired" — text that reads like the
 *     customer's credit is gone when in truth the merchant was on the wrong
 *     screen
 *   · Counter mode, which PIN-locks staff in, offered ONE button — to the till,
 *     which cannot redeem a reward QR at all. A customer who had pressed "Use
 *     at till" in the app was holding a code the only reachable screen could
 *     not take.
 *
 * The website had already been fixed for the same reason (see
 * redemption-preview-and-balance.node.test.ts, which covers web Counter mode and
 * the customer's mobile screens). The app's merchant screen was never brought
 * across, so it was the last surface still spending on sight.
 *
 * WHY THE TWO CODES CAN BE TOLD APART AT ALL
 *
 * Their shapes are fixed by the schema, not by convention:
 *   member card   profiles.member_code — ensure_member_code() writes
 *                 upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
 *                 so exactly 8 hex characters, no hyphens
 *   reward QR     local_redemptions.token — `uuid not null default
 *                 gen_random_uuid()`, so a full 36-character UUID
 * Neither can be read as the other, so the client refuses a wrong-kind scan
 * from its shape BEFORE any request leaves the phone. That is what makes the
 * cross-flow guarantee absolute rather than best-effort: the wrong code never
 * reaches the wrong endpoint, so it cannot have the wrong effect there.
 *
 * WHAT IS ASSERTED
 *   · the two scanners are distinct screens, named for their two jobs
 *   · the reward scanner looks before it spends, and only an explicit tap spends
 *   · cancelling after the look consumes nothing
 *   · confirming consumes exactly once, and the result screen cannot re-consume
 *   · a reward QR in the till, and a member card in the reward scanner, are
 *     refused locally — no lookup, no action, no network call
 *   · replay shows a friendly already-used state
 *   · no raw backend or transport text reaches a merchant, and the original is
 *     kept for the log
 *   · the backend, its atomic spenders and its replay protection are untouched
 *
 * The shipped functions are TRANSPILED FROM SOURCE AND EXECUTED here, not
 * re-implemented, so a change to the app that breaks the separation breaks this.
 *
 * SAFETY
 * Source inspection plus in-process execution of the app's own code against
 * stub callbacks. No database, no network, no writes.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const UX_SRC = 'lib/redemption-ux.ts';
const VERIFY_SRC = 'app/local-verify.tsx';
const TILL_SRC = 'app/local-till.tsx';
const COUNTER_SRC = 'app/local-counter.tsx';
const DASH_SRC = 'app/local-business-dashboard.tsx';
const API_SRC = 'lib/local-api.ts';
const VERIFY_FN = 'supabase/functions/local-redeem-verify/index.ts';
const TILL_FN = 'supabase/functions/loyalty-till/index.ts';
const PREVIEW_SQL = 'supabase/migrations/20260824190000_redemption_preview.sql';

/** Strip comments — several files DOCUMENT the old wording on purpose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

/* ── The shipped module, transpiled and loaded ────────────────────────────── */

/**
 * lib/redemption-ux.ts as the app actually ships it: real TypeScript through the
 * real compiler, then evaluated. Not a copy of the rules — the rules.
 */
const UX = (() => {
  const js = ts.transpileModule(read(UX_SRC), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports_: Record<string, any> = {};
  new Function('exports', js)(exports_);
  return exports_ as {
    classifyScan(raw: string | null | undefined): 'redemption' | 'member' | 'unknown';
    wrongScannerState(screen: 'redemption' | 'till', scanned: string): { title: string; message: string } | null;
    redemptionErrorState(err: unknown): { title: string; message: string; detail: string };
    tillErrorState(err: unknown): { title: string; message: string; detail: string };
  };
})();

/** Real values of each shape, built the way the database builds them. */
const REWARD_QR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';   // local_redemptions.token
const MEMBER_CARD = 'A1B2C3D4';                              // profiles.member_code
const SHORT_CODE = 'KQ7M';                                   // the 4-char typed code

/* ── 1. Two jobs, two screens, named ──────────────────────────────────────── */

describe('the stamp scanner and the reward scanner are distinct', () => {
  test('they are separate screens on separate routes', () => {
    const dash = read(DASH_SRC);
    assert.match(dash, /pathname: '\/local-till'/, 'the loyalty till route is gone');
    assert.match(dash, /pathname: '\/local-verify', params: \{ businessId: activeBusiness\.id \}/,
      'the redemption route is gone, or stopped carrying its business');
    assert.notEqual(VERIFY_SRC, TILL_SRC);
  });

  test('each says its job, and what to ask the customer for, before scanning', () => {
    assert.match(code(read(VERIFY_SRC)), /title="Redeem a reward"/);
    assert.match(code(read(VERIFY_SRC)), /title="Redeem a reward"/);
    // The subtitle is the business once one is resolved, and the instruction until then.
    assert.match(code(read(VERIFY_SRC)), /subtitle=\{business && business !== 'none' \? business\.name : 'Scan the customer’s reward QR'\}/);
    assert.match(code(read(TILL_SRC)), /title="Add loyalty"/);
    assert.match(code(read(TILL_SRC)), /subtitle=\{data \? data\.business\.name : 'Scan the customer’s member card'\}/);
  });

  test('the two dashboard entries no longer read as one job and its second step', () => {
    const dash = code(read(DASH_SRC));
    assert.ok(!/>Confirm a redemption</.test(dash),
      '"Confirm a redemption" still sits next to the till as though it followed it');
    assert.match(dash, />Add loyalty</);
    assert.match(dash, />Redeem a reward</);
  });

  test('and they no longer share one icon', () => {
    const dash = read(DASH_SRC);
    const block = dash.slice(dash.indexOf('>At the counter<'), dash.indexOf('>Your business<'));
    assert.match(block, /name="stamp"/, 'the add-loyalty entry has no stamp icon');
    assert.match(block, /name="gift"/, 'the redeem entry has no gift icon');
  });

  test('Counter mode offers BOTH jobs — it used to offer only the till', () => {
    const counter = code(read(COUNTER_SRC));
    assert.match(counter, /router\.push\(`\/local-till\?businessId=\$\{business\.id\}`\)/);
    assert.match(counter, /router\.push\(`\/local-verify\?businessId=\$\{business\.id\}`\)/,
      'PIN-locked staff still have no route for a reward QR, or it lost its business');
    assert.ok(!/>Scan a member card</.test(counter), 'the old single ambiguous CTA is back');
    assert.match(counter, /Scan their reward QR/);
    assert.match(counter, /Scan their member card/);
  });
});

/* ── 2. The reward scanner expects reward codes only ──────────────────────── */

describe('each scanner recognises the wrong code by shape', () => {
  test('a reward QR is a UUID and a member card is eight characters', () => {
    assert.equal(UX.classifyScan(REWARD_QR), 'redemption');
    assert.equal(UX.classifyScan(MEMBER_CARD), 'member');
    assert.equal(UX.classifyScan(MEMBER_CARD.toLowerCase()), 'member');
    assert.equal(UX.classifyScan(REWARD_QR.toUpperCase()), 'redemption');
    assert.equal(UX.classifyScan('https://oneshetland.com/anything'), 'unknown');
    assert.equal(UX.classifyScan(''), 'unknown');
    assert.equal(UX.classifyScan(null), 'unknown');
    assert.equal(UX.classifyScan(SHORT_CODE), 'unknown', 'the typed short code is not a QR payload');
  });

  test('the shapes cannot collide', () => {
    assert.notEqual(UX.classifyScan(REWARD_QR), UX.classifyScan(MEMBER_CARD));
  });

  test('a member card in the reward scanner is refused and points at the till', () => {
    const s = UX.wrongScannerState('redemption', 'member');
    assert.ok(s, 'a member card is accepted by the reward scanner');
    assert.match(s!.title, /member card/i);
    assert.match(s!.message, /Loyalty till/);
  });

  test('a reward QR in the till is refused and points at the reward scanner', () => {
    const s = UX.wrongScannerState('till', 'redemption');
    assert.ok(s, 'a reward QR is accepted by the till');
    assert.match(s!.title, /reward code/i);
    assert.match(s!.message, /Redeem a reward/);
  });

  test('and each still accepts its own kind', () => {
    assert.equal(UX.wrongScannerState('redemption', 'redemption'), null);
    assert.equal(UX.wrongScannerState('till', 'member'), null);
  });

  test('an unrelated QR is refused on both, not sent anywhere', () => {
    assert.ok(UX.wrongScannerState('redemption', 'unknown'));
    assert.ok(UX.wrongScannerState('till', 'unknown'));
  });
});

/* ── 3. The reward screen, executed ───────────────────────────────────────── */

/**
 * The screen's own handlers, lifted verbatim out of local-verify.tsx, compiled
 * and run against counting stubs. Everything asserted below is the shipped
 * control flow, not a description of it.
 */
function screen(opts: {
  preview?: () => Promise<any>;
  verify?: () => Promise<any>;
  business?: unknown;
} = {}) {
  const src = read(VERIFY_SRC);
  const from = src.indexOf('  /** Step 1 — look, don’t spend. */');
  const start = from > -1 ? from : src.indexOf('  async function look(');
  const end = src.indexOf('  return (\n    <SafeAreaView');
  assert.ok(start > -1 && end > start, 'local-verify no longer exposes its handlers where this test reads them');

  const block = ts.transpileModule(src.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText
    .replace(/\bpending\b(?!\s*[:=]|\s*\))/g, 'get_pending()')
    .replace(/\bbusy\b(?!\s*[:=])/g, 'get_busy()')
    .replace(/get_pending\(\)\s*=/g, 'pending =');

  const calls = { preview: 0, verify: 0 };
  /** Every business id the handlers actually put on the wire. */
  const sent = { preview: [] as any[], verify: [] as any[] };
  const state = {
    pending: null as any,
    result: null as any,
    busy: false,
    manual: '',
    lockRef: { current: false },
    warned: [] as string[],
  };

  const deps = {
    previewRedemption: async (input: any) => {
      calls.preview++;
      sent.preview.push(input?.businessId);
      return opts.preview ? opts.preview() : { kind: 'reward', detail: { title: 'Free coffee', subtitle: '2 uses left before this one' } };
    },
    verifyRedemption: async (input: any) => {
      calls.verify++;
      sent.verify.push(input?.businessId);
      if (opts.verify) return opts.verify();
      return { ok: true, kind: 'reward', detail: { title: 'Free coffee' } };
    },
    classifyScan: UX.classifyScan,
    wrongScannerState: UX.wrongScannerState,
    redemptionErrorState: UX.redemptionErrorState,
    Haptics: {
      selectionAsync: () => {},
      notificationAsync: () => {},
      NotificationFeedbackType: { Success: 1, Error: 2, Warning: 3 },
    },
    console: { warn: (_: string, d: string) => state.warned.push(d) },
    lockRef: state.lockRef,
    // The resolved merchant context the handlers read. 'none' is the screen's
    // own value for "cannot know which business this is".
    business: opts.business === undefined ? ANDERSON : opts.business,
    get_pending: () => state.pending,
    get_busy: () => state.busy,
    setPending: (v: any) => { state.pending = v; },
    setResult: (v: any) => { state.result = v; },
    setBusy: (v: any) => { state.busy = v; },
    setManual: (v: any) => { state.manual = v; },
  };

  const names = Object.keys(deps);
  const api = new Function(
    ...names,
    `${block}\nreturn { look, confirm, reset, onScan };`,
  )(...names.map((n) => (deps as any)[n]));

  /**
   * onScan is an event handler: it dispatches look() and returns without
   * awaiting it, exactly as the camera calls it. Drain the microtask queue so a
   * test sees the state the merchant would see, rather than a half-run handler.
   */
  const flush = () => new Promise((r) => setImmediate(r));
  const driven = (fn: (...a: any[]) => any) => async (...a: any[]) => { await fn(...a); await flush(); };

  return {
    onScan: driven((api as any).onScan),
    look: driven((api as any).look),
    confirm: driven((api as any).confirm),
    reset: (api as any).reset,
    state,
    calls,
    sent,
  };
}

/** The two businesses one owner holds — the case the scope fix exists for. */
const ANDERSON = { id: 'and-1', name: 'Anderson & Co' };
const DEMO = { id: 'demo-1', name: 'DEMO — Subscription Test Co' };

describe('the reward scan resolves before anything is redeemed', () => {
  test('scanning a reward QR previews and does NOT verify', async () => {
    const s = screen();
    await s.onScan(REWARD_QR);
    assert.equal(s.calls.preview, 1, 'the scan did not look the code up');
    assert.equal(s.calls.verify, 0, 'THE SCAN SPENT THE REWARD');
    assert.equal(s.state.result, null, 'a result appeared before staff confirmed');
    assert.deepEqual(
      { title: s.state.pending.title, token: s.state.pending.token },
      { title: 'Free coffee', token: REWARD_QR },
    );
  });

  test('what it is about to redeem is on screen before it is redeemed', () => {
    const ui = read(VERIFY_SRC);
    assert.match(ui, />ABOUT TO REDEEM</);
    assert.match(ui, />Nothing has been used yet\.</);
    assert.match(ui, />Redeem reward</, 'there is no explicit confirmation button');
    assert.match(ui, />Cancel</, 'there is no way out without redeeming');
  });

  test('only confirm() calls the mutating verify', () => {
    const src = code(read(VERIFY_SRC));
    const look = src.slice(src.indexOf('async function look('), src.indexOf('async function confirm('));
    assert.ok(!/verifyRedemption/.test(look), 'looking a code up still redeems it');
    const confirm = src.slice(src.indexOf('async function confirm('), src.indexOf('function fail('));
    assert.match(confirm, /await verifyRedemption\(/);
  });

  test('the camera is wired to onScan, not to the spender', () => {
    const ui = read(VERIFY_SRC);
    assert.match(ui, /onBarcodeScanned=\{\(\{ data \}: \{ data: string \}\) => onScan\(data\)\}/);
    const handler = ui.slice(ui.indexOf('onBarcodeScanned'), ui.indexOf('onBarcodeScanned') + 160);
    assert.ok(!/verify\(/.test(handler), 'the camera can still call verify directly');
  });
});

describe('cancelling after the look consumes nothing', () => {
  test('cancel clears the pending redemption without verifying', async () => {
    const s = screen();
    await s.onScan(REWARD_QR);
    assert.ok(s.state.pending, 'nothing was resolved to cancel');
    s.reset();
    assert.equal(s.calls.verify, 0, 'CANCELLING SPENT THE REWARD');
    assert.equal(s.state.pending, null);
    assert.equal(s.state.result, null);
  });

  test('leaving and re-entering cannot redeem — no timer, and the one effect only resolves the business', () => {
    const src = code(read(VERIFY_SRC));
    assert.ok(!/setTimeout|setInterval/.test(src), 'a timer could fire a redemption unattended');
    // There is exactly one effect, and it works out which business this is.
    // It must not be able to reach either endpoint.
    const effects = src.split('useEffect(').slice(1);
    assert.equal(effects.length, 1, `the screen has ${effects.length} effects — one is expected`);
    const body = effects[0].slice(0, effects[0].indexOf('}, ['));
    assert.match(body, /fetchMyBusinesses/, 'the effect is no longer the business resolver');
    for (const reach of ['previewRedemption', 'verifyRedemption', 'look(', 'confirm(']) {
      assert.ok(!body.includes(reach), `the mount effect can reach ${reach}`);
    }
    // Every call to the spender is inside confirm(), which only a press reaches.
    assert.equal((src.match(/verifyRedemption\(/g) ?? []).length, 1,
      'the spender is called from more than one place');
  });

  test('re-entering starts from the scanner: nothing is restored from a previous visit', () => {
    const src = code(read(VERIFY_SRC));
    assert.match(src, /useState<Pending \| null>\(null\)/, 'the pending redemption is not local state');
    assert.ok(!/AsyncStorage|SecureStore/.test(src), 'a pending redemption is persisted across visits');
  });
});

describe('confirming consumes exactly once', () => {
  test('confirm verifies once and shows the server’s result', async () => {
    const s = screen();
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.equal(s.calls.verify, 1);
    assert.equal(s.calls.preview, 1, 'confirming looked the code up again');
    assert.equal(s.state.result.ok, true);
    assert.equal(s.state.result.title, 'Free coffee');
    assert.equal(s.state.pending, null, 'the confirm button is still on screen after redeeming');
  });

  test('pressing confirm again after it has run cannot verify a second time', async () => {
    const s = screen();
    await s.onScan(REWARD_QR);
    await s.confirm();
    await s.confirm();
    await s.confirm();
    assert.equal(s.calls.verify, 1, 'THE REWARD WAS REDEEMED MORE THAN ONCE');
  });

  test('the result screen’s only button resets — it never redeems', () => {
    const src = code(read(VERIFY_SRC));
    const reset = src.slice(src.indexOf('function reset()'), src.indexOf('return (\n'));
    assert.ok(!/verifyRedemption|previewRedemption/.test(reset), 'Next customer calls an API');
    const ui = read(VERIFY_SRC);
    const panelEnd = ui.indexOf(') : pending ? (');
    assert.ok(panelEnd > -1, 'the result panel is no longer the first branch of the render');
    const resultPanel = ui.slice(ui.indexOf('{result ? ('), panelEnd);
    assert.ok(!/onPress=\{confirm\}/.test(resultPanel), 'the result panel can redeem again');
  });

  test('the camera cannot overwrite a preview or a result while staff are reading it', async () => {
    const s = screen();
    await s.onScan(REWARD_QR);
    // A second QR drifts into frame while the merchant reads the panel.
    await s.onScan('11111111-2222-3333-4444-555555555555');
    assert.equal(s.calls.preview, 1, 'the camera replaced what the merchant was reading');
    assert.equal(s.state.pending.token, REWARD_QR);
  });
});

/* ── 4. Cross-flow: the wrong code never reaches the wrong endpoint ───────── */

describe('a wrong-kind scan never leaves the phone', () => {
  test('a member card in the reward scanner previews nothing and verifies nothing', async () => {
    const s = screen();
    await s.onScan(MEMBER_CARD);
    assert.equal(s.calls.preview, 0, 'a member card was sent to the redemption endpoint');
    assert.equal(s.calls.verify, 0, 'A MEMBER CARD REDEEMED SOMETHING');
    assert.equal(s.state.pending, null);
    assert.match(s.state.result.title, /member card/i);
    assert.match(s.state.result.message, /Loyalty till/);
    assert.equal(s.state.result.ok, false);
  });

  test('an unrelated QR in the reward scanner is refused locally too', async () => {
    const s = screen();
    await s.onScan('https://example.com/not-a-code');
    assert.equal(s.calls.preview, 0);
    assert.equal(s.calls.verify, 0);
    assert.match(s.state.result.title, /Not a OneShetland code/);
  });

  test('the till classifies before it looks anything up', () => {
    const src = code(read(TILL_SRC));
    const scanned = src.slice(src.indexOf('function scanned('), src.indexOf('async function lookup('));
    assert.match(scanned, /wrongScannerState\('till', classifyScan\(raw\)\)/);
    assert.match(scanned, /if \(wrong\) \{[\s\S]*?return;/, 'the till continues after refusing');
    const before = scanned.indexOf('wrongScannerState');
    const call = scanned.indexOf('lookup(raw)');
    assert.ok(before > -1 && call > before, 'the till looks up before it classifies');
  });

  test('every till entry point goes through that gate', () => {
    const ui = read(TILL_SRC);
    assert.match(ui, /onBarcodeScanned=\{\(\{ data: d \}: \{ data: string \}\) => \{ if \(!notice && d\) scanned\(d\); \}\}/,
      'the camera bypasses the gate');
    assert.match(ui, /onPress=\{\(\) => scanned\(manual\)\}/, 'the Find button bypasses the gate');
    // lookup() itself is only reached from scanned() and the silent refresh.
    const callers = (code(ui).match(/(?<!function )\blookup\(/g) ?? []).length;
    assert.equal(callers, 1, `lookup() is called from ${callers} places, expected only scanned()`);
  });

  test('a normal member card still reaches the till untouched', () => {
    assert.equal(UX.wrongScannerState('till', UX.classifyScan(MEMBER_CARD)), null);
  });

  test('the till accepts only a full-length member code', () => {
    // ensure_member_code() writes exactly 8 characters and every live code is
    // 8 hex characters, verified against production before this gate was added.
    // Find used to enable at 6, which could never have matched anything.
    assert.match(read(TILL_SRC), /disabled=\{manual\.length !== 8 \|\| busy\}/);
    assert.equal(UX.classifyScan('A1B2C3'), 'unknown');
    assert.equal(UX.classifyScan('A1B2C3D'), 'unknown');
    assert.equal(UX.classifyScan('A1B2C3D4'), 'member');
    assert.equal(UX.classifyScan('A1B2C3D4E'), 'unknown');
  });

  test('the member-code rule matches how the database writes them', () => {
    const sql = read('supabase/migrations/20260721050000_member_card.sql');
    assert.match(sql, /upper\(substr\(replace\(gen_random_uuid\(\)::text, '-', ''\), 1, 8\)\)/,
      'member codes are no longer 8 hex characters — the classifier’s rule is now wrong');
  });
});

/* ── 4b. The business on screen is the business on the wire ──────────────── */

describe('the screen operates as exactly one business', () => {
  test('both merchant entry points hand it a business id', () => {
    assert.match(read(DASH_SRC), /pathname: '\/local-verify', params: \{ businessId: activeBusiness\.id \}/,
      'the dashboard opens the reward scanner with no business context');
    assert.match(read(COUNTER_SRC), /`\/local-verify\?businessId=\$\{business\.id\}`/,
      'Counter mode opens the reward scanner with no business context');
  });

  test('and it is the business the screen shows', () => {
    const ui = read(VERIFY_SRC);
    assert.match(ui, /subtitle=\{business && business !== 'none' \? business\.name : /,
      'the header does not name the business being operated');
    assert.match(ui, /<Text style=\{styles\.aboutBiz\}>at \{business\.name\}<\/Text>/,
      'ABOUT TO REDEEM does not say which business the reward is being redeemed at');
  });

  test('the scan sends that business, not a guess', async () => {
    const s = screen({ business: ANDERSON });
    await s.onScan(REWARD_QR);
    assert.deepEqual(s.sent.preview, [ANDERSON.id], 'the preview went out unscoped');
  });

  test('and so does the confirm', async () => {
    const s = screen({ business: ANDERSON });
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.deepEqual(s.sent.verify, [ANDERSON.id], 'the redemption went out unscoped');
  });

  test('a different business context sends that one instead', async () => {
    const s = screen({ business: DEMO });
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.deepEqual([s.sent.preview, s.sent.verify], [[DEMO.id], [DEMO.id]]);
  });

  test('with no usable context it refuses to act at all', async () => {
    const s = screen({ business: 'none' });
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.equal(s.calls.preview, 0, 'it previewed without knowing which business it was');
    assert.equal(s.calls.verify, 0, 'IT REDEEMED WITHOUT A BUSINESS CONTEXT');
  });

  test('and while it is still working the context out, likewise', async () => {
    const s = screen({ business: null });
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.equal(s.calls.preview + s.calls.verify, 0, 'it acted before it knew its business');
  });

  test('a route id that is not one of the caller’s own is not a context', () => {
    const src = code(read(VERIFY_SRC));
    assert.match(src, /const named = routeBusinessId \? mine\.find\(\(b\) => b\.id === routeBusinessId\) : undefined;/,
      'the route id is trusted without checking it belongs to the caller');
    assert.match(src, /setBusiness\(named \?\? 'none'\);/,
      'the screen guesses a business when it cannot resolve one');
  });

  test('the id must be present AND owned — nothing is ever guessed', () => {
    const src = code(read(VERIFY_SRC));
    const m = src.match(/setBusiness\((named \?\?[\s\S]*?)\);/);
    assert.ok(m, 'the resolution is no longer written the way this test reads it');
    const pick = (routeBusinessId: string | undefined, mine: { id: string }[]) => {
      const named = routeBusinessId ? mine.find((b) => b.id === routeBusinessId) : undefined;
      return new Function('named', 'routeBusinessId', 'mine', `return ${m![1].trim()};`)(named, routeBusinessId, mine);
    };
    assert.deepEqual(pick(ANDERSON.id, [ANDERSON, DEMO]), ANDERSON);
    assert.deepEqual(pick(DEMO.id, [ANDERSON, DEMO]), DEMO);
    assert.equal(pick('someone-elses-biz', [ANDERSON, DEMO]), 'none', 'an unowned route id was accepted');
    assert.equal(pick(undefined, [ANDERSON, DEMO]), 'none', 'a two-business owner had one picked for them');
    // Even for an owner of exactly one business, absence is not a context. The
    // terms gate in front of this screen already refuses a missing businessId,
    // so a "there is only one, so it must be that one" branch would be dead
    // code — and guessing is the thing this screen was changed to stop doing.
    assert.equal(pick(undefined, [ANDERSON]), 'none', 'absence of an id was treated as a context');
  });

  test('and the screen is behind the same commercial gate as the till', () => {
    const src = read(VERIFY_SRC);
    assert.match(src, /<CommercialTermsGate businessId=\{businessId\} feature="Loyalty">/,
      'the reward scanner is not gated');
    assert.match(src, /function LocalVerifyBody\(\)/, 'the gate does not wrap the whole screen');
    // The gate refuses a missing businessId on its own, before the body mounts.
    assert.match(read('components/CommercialTermsGate.tsx'), /if \(!businessId\) \{ setStatus\('unknown'\); return; \}/,
      'the gate no longer refuses a missing business id');
  });

  test('the server is the authority — the client only supplies the claim', () => {
    const fn = read(VERIFY_FN);
    // Every RPC the function can reach is told the scope.
    for (const rpc of ['preview_redemption', 'loyalty_redeem_code_atomic', 'redeem_pass_atomic']) {
      const call = fn.slice(fn.indexOf(`rpc('${rpc}'`), fn.indexOf(`rpc('${rpc}'`) + 320);
      assert.match(call, /p_business: scope,/, `${rpc} is called without the business scope`);
    }
    // And a claimed context the caller does not own dies before any code lookup.
    const guard = fn.slice(fn.indexOf('if (scope) {'), fn.indexOf('// ── Look, don\'t spend'));
    assert.match(guard, /\.eq\('owner_id', user\.id\)/, 'the claimed business is not checked against the caller');
    assert.ok(fn.indexOf('if (scope) {') < fn.indexOf("rpc('preview_redemption'"),
      'the context is checked after a code is already being looked up');
  });

  test('a wrong-business code is refused for the real reason, never as already used', () => {
    const fn = read(VERIFY_FN);
    assert.match(fn, /if \(scope && red\.business_id !== scope\) \{\s*\n\s*return json\(\{ error: 'This reward is not for this business' \}, 403\);/,
      'the wrong-business refusal is gone from the shared path');
    // The lookup must NOT be narrowed to the scope, or the answer becomes
    // "not found, already used, or expired" for a perfectly good reward.
    assert.match(fn, /\.in\('business_id', bizIds\)/,
      'the lookup was narrowed — a wrong-business code would read as already used');
  });
});

/* ── 5. Friendly states, and no internals ─────────────────────────────────── */

describe('what a merchant is told', () => {
  test('replay reads as already used, not as a failure', () => {
    const s = UX.redemptionErrorState(new Error('Already redeemed'));
    assert.match(s.title, /Already used/);
    assert.match(s.message, /hasn’t been taken a second time/);
  });

  test('one of the merchant’s OWN other businesses is named as that, not as used', () => {
    const s = UX.redemptionErrorState(new Error('This reward is not for this business'));
    assert.match(s.title, /Not for this business/);
    assert.match(s.message, /other businesses/);
    assert.doesNotMatch(`${s.title} ${s.message}`, /already|used|expired/i,
      'a merchant would think a good reward had been spent');
  });

  test('a context the caller does not own is its own state', () => {
    const s = UX.redemptionErrorState(new Error('That is not your business.'));
    assert.match(s.title, /Wrong business/);
  });

  test('another business’s code says so', () => {
    const s = UX.redemptionErrorState(new Error('That code is not for your business'));
    assert.match(s.title, /Another business/);
    assert.match(s.message, /different business/);
  });

  test('expired and used-up are separate states', () => {
    assert.match(UX.redemptionErrorState(new Error('This pass has expired')).title, /Expired/);
    assert.match(UX.redemptionErrorState(new Error('No uses left')).title, /No uses left/);
    assert.notEqual(
      UX.redemptionErrorState(new Error('This pass has expired')).title,
      UX.redemptionErrorState(new Error('No uses left')).title,
    );
  });

  test('an invalid code explains what to do next', () => {
    const s = UX.redemptionErrorState(new Error('Code not found, already used, or expired'));
    assert.match(s.title, /Code not valid/);
    assert.match(s.message, /Use at till/, 'the merchant is not told how to recover');
  });

  test('the reward-not-earned case is not dressed up as an error', () => {
    assert.match(UX.redemptionErrorState(new Error('No reward ready to claim')).title, /No reward ready/);
  });

  test('every message the verify function deliberately returns is mapped', () => {
    const fn = read(VERIFY_FN);
    const deliberate = [...fn.matchAll(/\[\s*'([^']{8,})',\s*\d{3}\s*\]/g)].map((m) => m[1]);
    assert.ok(deliberate.length >= 8, `only found ${deliberate.length} mapped messages to check`);
    const unmapped = [...new Set(deliberate)].filter(
      (m) => UX.redemptionErrorState(new Error(m)).title === 'Unable to check right now',
    );
    assert.deepEqual(unmapped, [], `these backend messages fall through to the generic state: ${unmapped.join(' | ')}`);
  });
});

describe('raw internals never reach the merchant', () => {
  const RAW = [
    'duplicate key value violates unique constraint "local_offer_redemptions_offer_id_user_id_key"',
    'Edge Function returned a non-2xx status code',
    'FunctionsFetchError: Failed to send a request to the Edge Function',
    'TypeError: Network request failed',
    'new row violates row-level security policy for table "local_redemptions"',
  ];

  test('a PostgREST or transport message collapses to one safe state', () => {
    for (const raw of RAW) {
      const s = UX.redemptionErrorState(new Error(raw));
      assert.equal(s.title, 'Unable to check right now', raw);
      assert.ok(!s.message.includes(raw), 'the raw text is shown to the merchant');
      for (const leak of ['constraint', 'row-level security', 'non-2xx', 'TypeError', 'Edge Function']) {
        assert.ok(!`${s.title} ${s.message}`.includes(leak), `"${leak}" reached the merchant`);
      }
    }
  });

  test('but the original is kept for the log', () => {
    for (const raw of RAW) {
      assert.equal(UX.redemptionErrorState(new Error(raw)).detail, raw, 'diagnostic detail was discarded');
    }
  });

  test('the screen logs the detail and renders only the mapped state', async () => {
    const s = screen({ preview: async () => { throw new Error(RAW[0]); } });
    await s.onScan(REWARD_QR);
    assert.deepEqual(s.state.warned, [RAW[0]], 'the raw error was not logged for diagnosis');
    assert.equal(s.state.result.title, 'Unable to check right now');
    assert.ok(!JSON.stringify(s.state.result).includes('constraint'));
  });

  test('a failed confirm says so without leaking, and leaves nothing pending', async () => {
    const s = screen({ verify: async () => { throw new Error('Already redeemed'); } });
    await s.onScan(REWARD_QR);
    await s.confirm();
    assert.equal(s.state.result.ok, false);
    assert.match(s.state.result.title, /Already used/);
    assert.equal(s.state.pending, null);
  });

  test('no screen in this flow renders an error message straight from the exception', () => {
    for (const p of [VERIFY_SRC, TILL_SRC]) {
      const src = code(read(p));
      assert.ok(!/e instanceof Error \? e\.message/.test(src),
        `${p} still puts the raw exception message on screen`);
    }
  });

  test('the till routes its failures through the same mapper', () => {
    const src = code(read(TILL_SRC));
    // lookup, requestCharge, act — plus cancelCharge (wallet-charge-cancel's
    // client call), added when the till's Cancel button started making a
    // real server call instead of only clearing local state.
    assert.equal((src.match(/tillErrorState\(e\)/g) ?? []).length, 4,
      'a till failure path bypasses the mapper');
    assert.match(src, /console\.warn\('\[local-till\]', st\.detail\)/);
  });

  test('the till’s pass-through list is exactly what its function returns on purpose', () => {
    const ux = read(UX_SRC);
    const fn = read(TILL_FN);
    const safe = read('supabase/functions/_shared/safe-error.ts');
    const block = ux.slice(ux.indexOf('const TILL_MESSAGES'));
    const entries = [...block.matchAll(/^ {2}(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),$/gm)]
      .map((m) => (m[1] ?? m[2]).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
    assert.ok(entries.length >= 15, `only parsed ${entries.length} entries`);
    const stray = entries.filter((e) => !fn.includes(e) && !safe.includes(e));
    assert.deepEqual(stray, [], `not returned by loyalty-till or safe-error: ${stray.join(' | ')}`);
  });
});

/* ── 6. The backend did not move ──────────────────────────────────────────── */

describe('the redemption backend is untouched', () => {
  test('this change adds no migration and no new RPC', () => {
    const sql = read(PREVIEW_SQL);
    assert.match(sql, /stable/, 'preview_redemption is no longer STABLE');
    for (const w of ['insert into', 'update ', 'delete from']) {
      assert.ok(!new RegExp(w, 'i').test(code(sql).replace(/jsonb_build_object/g, '')), `the preview performs ${w}`);
    }
  });

  test('the preview path still returns before any mutating branch', () => {
    const fn = read(VERIFY_FN);
    const branch = fn.slice(fn.indexOf('if (preview === true)'), fn.indexOf('// Businesses this staff/owner controls.'));
    assert.ok(branch.length > 0, 'the preview branch is gone');
    for (const spender of ['redeem_pass_atomic', 'loyalty_redeem_code_atomic', '.insert(', '.update(']) {
      assert.ok(!branch.includes(spender), `the preview path can reach ${spender}`);
    }
  });

  test('the atomic spenders and their replay protection are still the authority', () => {
    const fn = read(VERIFY_FN);
    assert.match(fn, /loyalty_redeem_code_atomic/);
    assert.match(fn, /redeem_pass_atomic/);
    assert.match(fn, /already_used:\s*\['Already redeemed', 409\]/);
    assert.match(fn, /not_your_business:\s*\['That code is not for your business', 403\]/);
  });

  test('the app now uses the preview the backend has always offered', () => {
    const api = read(API_SRC);
    assert.match(api, /export async function previewRedemption\(/);
    const body = api.slice(api.indexOf('export async function previewRedemption('), api.indexOf('export async function verifyRedemption('));
    assert.match(body, /body: \{ code, token, business_id: businessId, preview: true \}/,
      'the preview helper stopped sending its business scope');
    assert.ok(!/rpc\(|\.insert\(|\.update\(/.test(body), 'the preview helper writes');
  });

  test('every edge function that returns json() actually defines it', () => {
    // local-redeem-verify called json() on all twenty-odd paths — including the
    // success path and the catch-all — and never declared it, in every commit
    // since the function was written. A live probe of the deployed function
    // returns a bare platform 500 where its siblings return {"error":"..."} on
    // the identical unauthenticated path. Nothing in the suite could see it,
    // because every test read the source and none ran the module.
    const dir = join(REPO_ROOT, 'supabase', 'functions');
    const broken: string[] = [];
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, 'index.ts');
      if (!existsSync(f)) continue;
      const body = readFileSync(f, 'utf8');
      if (!/\breturn json\(/.test(body)) continue;
      const declares = /\bfunction json\s*\(/.test(body) || /\bconst json\s*=/.test(body)
        || /import\s*\{[^}]*\bjson\b[^}]*\}/.test(body);
      if (!declares) broken.push(name);
    }
    assert.deepEqual(broken, [], `these functions call json() without defining it: ${broken.join(', ')}`);
  });

  test('and the customer-side screens still cannot redeem', () => {
    const customer = code(read('app/local-redeem.tsx'));
    assert.ok(!/verifyRedemption|previewRedemption|local-redeem-verify/.test(customer),
      'the customer screen can now redeem its own reward');
  });
});

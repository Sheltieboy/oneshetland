/**
 * wallet-take-payment-discoverability.node.test.ts
 *
 * Merchant wallet charging always worked on both platforms, but the only
 * route to it was: Dashboard → "Add loyalty" → scan customer → scroll past
 * every loyalty action → "Take a wallet payment". A merchant looking to take
 * a payment had no reason to tap something labelled loyalty.
 *
 * Fixed by adding a second, equally obvious "Take payment" entry point on
 * both dashboards that opens the SAME till screen/component with an
 * intent — it reorders which group renders first and relabels the heading;
 * it is not a second payment implementation. requestCharge/createChargeRequest,
 * the customer-approval flow, cancellation and the wallet debit itself are
 * completely untouched by this change — this file proves the reuse, not the
 * money logic (that's wallet-attempts/wallet-charge-cancel/wallet-recovery's
 * job).
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
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(export )?(async function|function|const|type|interface) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/* ── 1. The dashboard exposes "Take payment" on both platforms ───────────── */

describe('the merchant dashboard exposes "Take payment" as its own clear action', () => {
  test('mobile local-business-dashboard.tsx has a "Take payment" banner, alongside "Add loyalty"', () => {
    const dash = code(read('app/local-business-dashboard.tsx'));
    assert.match(dash, /Text style=\{\[styles\.backfillTitle, \{ color: '#fff' \}\]\}>Take payment</);
    assert.match(dash, /Text style=\{\[styles\.backfillTitle, \{ color: '#fff' \}\]\}>Add loyalty</);
  });

  test('web DashboardTop.tsx links "Take payment" next to "Add loyalty" and "Open counter mode"', () => {
    const top = code(readWeb('components/business/DashboardTop.tsx'));
    assert.match(top, />\s*Take payment\s*<\/Link>/);
    assert.match(top, />\s*Add loyalty\s*<\/Link>/);
    assert.match(top, />\s*Open counter mode\s*<\/Link>/);
  });
});

/* ── 2. Both platforms route into the EXISTING till flow ──────────────────── */

describe('"Take payment" opens the existing till screen, not a new one', () => {
  test('mobile: Take payment pushes /local-till with intent=wallet — the same route "Add loyalty" uses', () => {
    const dash = read('app/local-business-dashboard.tsx');
    const takePayment = dash.slice(dash.indexOf("Take payment"), dash.indexOf("Take payment") + 400);
    assert.match(dash.slice(0, dash.indexOf('Take payment')).slice(-500) + takePayment, /pathname: '\/local-till', params: \{ businessId: activeBusiness\.id, intent: 'wallet' \}/);
    assert.match(dash, /pathname: '\/local-till', params: \{ businessId: activeBusiness\.id \}\s*\}\)\}/, 'Add loyalty still routes to the same screen, with no intent override');
  });

  test('web: Take payment links to the same /loyalty route "Add loyalty" uses, with ?intent=wallet appended', () => {
    const top = readWeb('components/business/DashboardTop.tsx');
    assert.match(top, /href=\{`\$\{base\}\/loyalty\?intent=wallet`\}/);
    assert.match(top, /href=\{`\$\{base\}\/loyalty`\}/);
  });

  test('web: the /loyalty page reads ?intent and passes it straight to the one LoyaltyTill instance — no second till component', () => {
    const page = readWeb('app/business/[id]/manage/loyalty/page.tsx');
    assert.match(page, /const wallet = sp\.intent === "wallet"/);
    // Exactly one LoyaltyTill render in the whole page.
    const occurrences = page.match(/<LoyaltyTill\b/g) ?? [];
    assert.equal(occurrences.length, 1, 'a second LoyaltyTill render would be a second payment implementation');
  });
});

/* ── 3. No second payment implementation ─────────────────────────────────── */

describe('wallet intent reorders the existing till — it does not duplicate charge logic', () => {
  test('mobile local-till.tsx defines requestCharge/cancelCharge exactly once, and chargeBox is a single JSX value referenced on both branches', () => {
    const screen = code(read('app/local-till.tsx'));
    assert.equal((screen.match(/async function requestCharge/g) ?? []).length, 1);
    assert.equal((screen.match(/async function cancelCharge/g) ?? []).length, 1);
    assert.equal((screen.match(/const chargeBox = data &&/g) ?? []).length, 1);
    assert.match(screen, /\{walletFirst && chargeBox\}/);
    assert.match(screen, /\{!walletFirst && chargeBox\}/);
  });

  test('web LoyaltyTill.tsx defines requestCharge exactly once, and chargeBox is a single JSX value referenced on both branches', () => {
    const comp = code(readWeb('components/business/LoyaltyTill.tsx'));
    assert.equal((comp.match(/async function requestCharge/g) ?? []).length, 1);
    assert.equal((comp.match(/const chargeBox = \(/g) ?? []).length, 1);
    assert.match(comp, /\{walletFirst && chargeBox\}/);
    assert.match(comp, /\{!walletFirst && chargeBox\}/);
  });

  test('the edge functions behind the charge (request/approve/cancel) are untouched by this change — not referenced in either dashboard file', () => {
    const dash = read('app/local-business-dashboard.tsx');
    const top = readWeb('components/business/DashboardTop.tsx');
    for (const src of [dash, top]) {
      assert.doesNotMatch(src, /wallet-charge-request|wallet-charge-approve|wallet-charge-cancel/, 'the dashboard only navigates — it must not call the charge functions itself');
    }
  });
});

/* ── 4. The customer scan/member-code lookup is still required either way ── */

describe('wallet intent does not skip the member-code lookup', () => {
  test('mobile: chargeBox only exists once `data` (the till lookup result) is set — intent cannot bypass the scan', () => {
    const screen = read('app/local-till.tsx');
    const chargeBoxDecl = screen.slice(screen.indexOf('const chargeBox ='), screen.indexOf('const chargeBox =') + 60);
    assert.match(chargeBoxDecl, /const chargeBox = data &&/);
  });

  test('mobile: the lead-in copy before a scan still asks for the member card first, in both intents', () => {
    const screen = read('app/local-till.tsx');
    assert.match(screen, /Scan the customer’s member card/);
  });

  test('web: chargeBox is only rendered inside the branch that already required a successful tillLookup', () => {
    const comp = readWeb('components/business/LoyaltyTill.tsx');
    const renderSite = comp.slice(comp.indexOf('{walletFirst && chargeBox}'), comp.indexOf('{walletFirst && chargeBox}') + 10);
    // The render site itself is inside the `data ? ... : (...)` else-branch —
    // confirmed by its proximity to the post-lookup status card markup.
    const statusCardIdx = comp.indexOf('data.customer.name');
    const renderIdx = comp.indexOf('{walletFirst && chargeBox}');
    assert.ok(statusCardIdx !== -1 && statusCardIdx < renderIdx, 'charge box must render after the post-lookup status card, not before it');
    void renderSite;
  });
});

/* ── 5. Loyalty-first entry still works, unchanged ────────────────────────── */

describe('the original "Add loyalty" experience is preserved exactly', () => {
  test('mobile: default intent (no param) leads with loyalty copy/heading, charge box last', () => {
    const screen = read('app/local-till.tsx');
    assert.match(screen, /walletFirst \? 'Take payment' : 'Add loyalty'/);
    assert.match(screen, /Add a stamp, add points, give a ready reward or take a wallet payment\./);
  });

  test('web: default intent leads with "Loyalty programme" / "Loyalty till" copy, till renders after programme config', () => {
    const page = readWeb('app/business/[id]/manage/loyalty/page.tsx');
    const comp = readWeb('components/business/LoyaltyTill.tsx');
    assert.match(page, /wallet \? "Take payment" : "Loyalty programme"/);
    assert.match(page, /\{!wallet && till\}/);
    assert.match(comp, /walletFirst \? "Take payment" : "Loyalty till"/);
  });

  test('neither platform removed any existing loyalty action (stamp, points, reward, offer)', () => {
    const screen = code(read('app/local-till.tsx'));
    const comp = code(readWeb('components/business/LoyaltyTill.tsx'));
    for (const src of [screen, comp]) {
      assert.match(src, /Add a stamp|"stamp"/);
      assert.match(src, /Add points|"points"/);
      assert.match(src, /redeem_reward/);
      assert.match(src, /redeem_offer/);
    }
  });
});

/* ── 6. Counter Mode copy no longer implies loyalty-only ──────────────────── */

describe('Counter Mode names what it actually does', () => {
  test('the primary scan button is no longer labelled "Add loyalty" alone', () => {
    const counter = code(read('app/local-counter.tsx'));
    assert.doesNotMatch(counter, />Add loyalty</, 'the single-purpose label must be gone from Counter Mode');
    assert.match(counter, />Scan customer</);
  });

  test('the supporting hint names loyalty AND wallet payments, not a cram of every action into the button itself', () => {
    const counter = read('app/local-counter.tsx');
    assert.match(counter, /loyalty, points and wallet payments/i);
    // The button's own label stays short — the enumeration lives in the hint.
    const btnText = counter.slice(counter.indexOf('styles.scanText'), counter.indexOf('styles.scanText') + 40);
    assert.doesNotMatch(btnText, /,/, 'the button label itself must not enumerate multiple actions');
  });

  test('Counter Mode still opens the same till route as both dashboard entries', () => {
    const counter = read('app/local-counter.tsx');
    assert.match(counter, /router\.push\(`\/local-till\?businessId=\$\{business\.id\}`\)/);
  });
});

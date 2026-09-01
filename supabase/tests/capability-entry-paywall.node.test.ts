/**
 * capability-entry-paywall.node.test.ts — Business 2.0 Phase 2C.
 *
 * What an owner meets when they open something their plan does not fully
 * include. All six used to do the same thing: check the CONFIGURED tier and
 * redirect straight to Billing, so clicking "Offers" landed you on a price list
 * with nothing anywhere saying what an offer was.
 *
 * Two shapes replace it, matching what the server already enforces.
 *
 * Setup-first — Products, Passes, Bookings, Wallet. The server allows drafts
 * and configuration below tier, so the door is open and the plan is named at
 * the publish/live control. Products and Passes needed a second fix for this to
 * be true: the managers created rows with is_active: true, so a below-Premium
 * owner was refused by the trigger the moment they saved. They now create
 * drafts, which is exactly what products_tier_guard carves out.
 *
 * Gate-before-setup — Offers, Loyalty. The server refuses the insert outright,
 * so an explanation replaces the manager. Existing content stays visible and
 * withdrawable, because the server permits the reducing direction without a
 * plan and nobody should be stuck advertising something they cannot end.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (p: string) => readWeb(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const page = (n: string) => code(`app/business/[id]/manage/${n}/page.tsx`);

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const SETUP_FIRST = ['products', 'passes', 'bookings', 'wallet'];
const GATED = ['offers', 'loyalty'];
const ALL = [...SETUP_FIRST, ...GATED];

/* ── 1. Nobody is dumped into Billing any more ────────────────────────────── */

describe('opening a capability no longer lands you on a price list', () => {
  test('no entry redirect survives on any of the six', () => {
    for (const n of ALL) {
      assert.doesNotMatch(page(n), /redirect\(`\/business\/\$\{business\.id\}\/manage\/billing`\)/,
        `${n} still redirects on entry`);
    }
  });

  test('and none of them decides access on the configured tier', () => {
    for (const n of ALL) {
      assert.doesNotMatch(page(n), /tierUnlocks|tierMeets|subscription_tier/,
        `${n} must ask the effective predicate, not the stored column`);
    }
  });

  test('all six read the one deployed predicate', () => {
    for (const n of ALL) assert.match(page(n), /getEffectiveTier\(business\.id\)/, n);
    const helper = code('lib/entitlement.server.ts');
    assert.match(helper, /business_meets_tier/);
    assert.match(helper, /p_required_tier: "pro"/);
    assert.match(helper, /p_required_tier: "premium"/);
    assert.doesNotMatch(helper, /subscription_until|subscription_tier/, 'no second entitlement formula');
  });

  test('an unreadable plan is treated as not entitled, never as entitled', () => {
    const helper = code('lib/entitlement.server.ts');
    assert.match(helper, /r\.status === "fulfilled" && !r\.value\.error && r\.value\.data === true/);
  });
});

/* ── 2. Setup-first: the door is open ─────────────────────────────────────── */

describe('products and passes can be prepared before paying', () => {
  test('the server genuinely allows a draft below Premium', () => {
    for (const fn of ['products_tier_guard', 'book_unit_items_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      assert.match(String(row.d), /if new\.is_active is not true then\s*\n\s*return new;/,
        `${fn} must keep its draft carve-out — the UX depends on it`);
    }
  });

  test('so the managers create drafts rather than being refused on save', () => {
    // This was the real blocker: both created with is_active: true, so opening
    // the door alone would have produced a 42501 on the first save.
    for (const c of ['ProductsManager', 'UnitItemsManager']) {
      const src = code(`components/business/${c}.tsx`);
      assert.doesNotMatch(src, /is_active: true/, `${c} must not publish on create`);
      assert.match(src, /is_active: canPublish/, `${c} must create a draft below Premium`);
    }
  });

  test('publishing is what asks for Premium, and hiding never does', () => {
    const src = code('components/business/ProductsManager.tsx');
    assert.match(src, /disabled=\{!canPublish && !p\.is_active\}/,
      'Show is blocked below Premium; Hide stays available');
    assert.match(src, /Publishing products needs Premium/);
  });

  test('both pages pass effective Premium down, not a tier string', () => {
    assert.match(page('products'), /canPublish=\{premium\}/);
    assert.match(page('passes'), /canPublish=\{premium\}/);
  });
});

describe('bookings can be configured before paying', () => {
  test('entry is open and step 3 carries the plan', () => {
    assert.match(page('bookings'), /canGoLive=\{pro\}/);
    const src = code('components/business/BookingsManager.tsx');
    assert.match(src, /Taking bookings needs Pro\. Your services and availability are saved\./);
  });

  test('the live toggle is what Pro blocks — and switching OFF never is', () => {
    const src = code('components/business/BookingsManager.tsx');
    assert.match(src, /\(!canGoLive && !business\.accepts_bookings\)/,
      'a business already live must still be able to switch off');
  });

  test('the web never repeats the mobile mistake of calling bookings Premium', () => {
    for (const f of ['components/business/BookingsManager.tsx', 'app/business/[id]/manage/bookings/page.tsx']) {
      assert.doesNotMatch(readWeb(f), /bookings[^\n]{0,60}Premium|Premium[^\n]{0,60}bookings/i, f);
    }
  });

  test('services and schedule still fold into the one bookings page', () => {
    for (const n of ['services', 'schedule']) {
      assert.match(page(n), /redirect\(`\/business\/\$\{id\}\/manage\/bookings#/, n);
    }
  });
});

describe('wallet settings are open below Pro', () => {
  test('entry is open and the switch carries the plan', () => {
    assert.match(page('wallet'), /canEnable=\{pro\}/);
    const src = code('components/business/WalletManager.tsx');
    assert.match(src, /Taking Wallet payments needs Pro\. Your settings are saved\./);
    assert.match(src, /\(!canEnable && !b\.accepts_wallet\)/, 'switching OFF is always allowed');
  });

  test('nothing about money, cashback or receipts was gated', () => {
    const src = code('components/business/WalletManager.tsx');
    // Every use of canEnable must be about switching acceptance on, and
    // nothing else on this screen. A count of occurrences would only have
    // measured how the code was formatted.
    for (const line of src.split('\n').filter((l) => l.includes('canEnable'))) {
      const isProp = /canEnable\s*[,:}]/.test(line) && !line.includes('&&');
      assert.ok(isProp || line.includes('!b.accepts_wallet'),
        `canEnable used away from the acceptance switch: ${line.trim()}`);
    }
    assert.doesNotMatch(src, /canEnable[^\n]*(cashback|receipt|refund|balance)/i);
  });
});

/* ── 3. Gate-before-setup: explained, not redirected ──────────────────────── */

describe('offers and loyalty explain themselves before asking for money', () => {
  test('below Pro the manager is replaced by an explanation', () => {
    for (const n of GATED) {
      assert.match(page(n), /pro \? \(/, `${n} must branch on effective Pro`);
      assert.match(page(n), /<CapabilityPaywall/, `${n} must explain rather than redirect`);
      assert.match(page(n), /plan="Pro"/);
    }
  });

  test('the explanation says what the thing does before it says what it costs', () => {
    const src = readWeb('components/business/CapabilityPaywall.tsx');
    assert.ok(src.indexOf('{what}') < src.indexOf('See plans'),
      'nobody can judge a price for something that has not been described');
    assert.match(src, /See plans/);
  });

  test('and it does not shout', () => {
    // Comments stripped: the component's own doc explains that it avoids the
    // word "unlock", which would otherwise trip this.
    const src = code('components/business/CapabilityPaywall.tsx');
    assert.doesNotMatch(src, /Unlock|unlock|!<\/|Upgrade now|powerful|Limited|hurry/i);
    for (const n of GATED) assert.doesNotMatch(page(n), /Unlock|upgrade now/i);
  });

  test('with effective Pro the manager opens as normal', () => {
    assert.match(page('offers'), /<OffersManager businessId=\{business\.id\} offers=\{offers\} canConfigure \/>/);
    assert.match(page('loyalty'), /<LoyaltyManager businessId=\{business\.id\} program=\{program\} canConfigure \/>/);
  });
});

/* ── 4. The nuance: a downgrade must not trap anybody ─────────────────────── */

describe('a lapsed plan does not strand existing offers or a running programme', () => {
  test('the server allows withdrawal and refuses creation — the UI must match', () => {
    for (const fn of ['local_offers_tier_guard', 'local_loyalty_programs_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      const d = String(row.d);
      assert.match(d, /old\.is_active is true and new\.is_active is not true/, `${fn}: withdrawal is free`);
      assert.match(d, /business_meets_tier/, `${fn}: creating and editing is not`);
    }
  });

  test('existing offers stay listed and endable below Pro', () => {
    assert.match(page('offers'), /offers\.length > 0 &&/);
    assert.match(page('offers'), /canConfigure=\{false\}/);
    const src = code('components/business/OffersManager.tsx');
    // The create button goes; the End button is untouched by canConfigure.
    assert.match(src, /canConfigure\s*\n?\s*\? <button onClick=\{\(\) => setCreating\(true\)\}/);
    const end = src.slice(src.indexOf('o.is_active && <button onClick={() => remove('));
    assert.ok(end.length > 0, 'ending an offer must not depend on the plan');
    assert.doesNotMatch(end.slice(0, 200), /canConfigure/);
  });

  test('a running programme can now actually be stopped', () => {
    // There was no stop action at all before this: the only write was an upsert
    // that set is_active back to true.
    const client = code('lib/business-client.ts');
    assert.match(client, /export async function stopLoyaltyProgram/);
    assert.match(client, /\.update\(\{ is_active: false \}\)\.eq\("business_id", businessId\)/);
    const src = code('components/business/LoyaltyManager.tsx');
    assert.match(src, /program\?\.is_active && \(/);
    assert.match(src, /Stop programme/);
    // ...and it is outside the canConfigure branch, so a lapsed owner has it.
    const stop = src.slice(src.indexOf('program?.is_active && ('));
    assert.doesNotMatch(stop.slice(0, 300), /canConfigure/);
  });

  test('stopping a programme touches no customer value', () => {
    const client = code('lib/business-client.ts');
    const fn = client.slice(client.indexOf('export async function stopLoyaltyProgram'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.doesNotMatch(body, /local_loyalty_cards|local_loyalty_transactions|delete/i,
      'stamps and history are the customer’s, not the shop’s to clear');
  });
});

/* ── 5. Nothing underneath moved ──────────────────────────────────────────── */

describe('enforcement is untouched', () => {
  test('the six server guards are exactly where they were', () => {
    const rows = sql(`
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    assert.deepEqual(rows.map((r) => r.tbl),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       'local_wallet_transactions', 'products']);
  });

  test('business_meets_tier itself was not touched', () => {
    const [row] = sql(`select pg_get_functiondef('public.business_meets_tier'::regproc) as d;`);
    assert.match(String(row.d), /subscription_until/);
    assert.match(String(row.d), /free|pro|premium/);
  });

  test('commercial Terms still gate every one of these screens first', () => {
    for (const n of ALL) assert.match(page(n), /commercialTermsGate\(business, "/, n);
  });

  test('Business Home and its spine were not changed', () => {
    const home = code('app/business/[id]/manage/page.tsx');
    assert.match(home, /businessOutcomes\(business, reads, base\)/);
    assert.match(home, /<DashboardTop/);
  });
});

/* ── 6. A lapsed loyalty programme reads as a fact, not a form ────────────── */

describe('below Pro the programme is shown, not offered for editing', () => {
  const src = code('components/business/LoyaltyManager.tsx');
  // Everything before `return (` for the editable branch is the read-only one.
  const readOnly = src.slice(src.indexOf('if (!canConfigure) {'), src.lastIndexOf('return ('));

  test('there is one manager, with a read-only branch — not a second component', () => {
    assert.equal((src.match(/export function/g) ?? []).length, 1);
    assert.ok(readOnly.length > 0, 'the read-only branch must exist');
  });

  test('1. the programme details are still shown', () => {
    // Read from `program`, because this states what exists rather than drafting
    // what might.
    assert.match(readOnly, /program\?\.type/);
    assert.match(readOnly, /points_per_pound/);
    assert.match(readOnly, /points_for_pound/);
    assert.match(readOnly, /normalizeTiers\(program\?\.reward_tiers\)/);
    assert.match(readOnly, /stamps<\/span> — \{t\.reward\}|\{t\.stamps\} stamps/);
    assert.match(readOnly, /Running|Stopped/);
  });

  test('2. nothing in it is editable', () => {
    for (const editable of ['<input', '<textarea', '<select', 'onChange']) {
      assert.ok(!readOnly.includes(editable), `${editable} must not appear below Pro`);
    }
    // The type pills are buttons that mutate state — they must not be here either.
    assert.doesNotMatch(readOnly, /setType|setStampsRequired|setStampReward|setExtraTiers|setPerPound|setForPound/);
  });

  test('3. save, restart and create are all unavailable', () => {
    assert.doesNotMatch(readOnly, /onClick=\{save\}|upsertLoyaltyProgram/);
    for (const label of ['Update programme', 'Set up programme', 'Add another reward tier']) {
      assert.ok(!readOnly.includes(label), `${label} must not appear below Pro`);
    }
  });

  test('4. Stop programme is still there, and still not gated', () => {
    assert.match(readOnly, /Stop programme/);
    assert.match(readOnly, /onClick=\{stop\}/);
    const stopBlock = readOnly.slice(readOnly.indexOf('program?.is_active && ('));
    assert.doesNotMatch(stopBlock, /canConfigure/, 'stopping never depends on the plan');
  });

  test('5. nothing here touches customer cards or history', () => {
    assert.doesNotMatch(readOnly, /local_loyalty_cards|local_loyalty_transactions|delete|clear/i);
    const client = code('lib/business-client.ts');
    const stopFn = client.slice(client.indexOf('export async function stopLoyaltyProgram'));
    assert.doesNotMatch(stopFn.slice(0, stopFn.indexOf('\n}')), /cards|transactions|delete/i);
  });

  test('with effective Pro the editable manager is exactly as it was', () => {
    const editable = src.slice(src.lastIndexOf('return ('));
    for (const keep of ['setType', 'Stamps to collect', 'Add another reward tier',
                        'onClick={save}', 'Points earned per £1 spent']) {
      assert.ok(editable.includes(keep), `${keep} must survive for an entitled owner`);
    }
    // The save button is no longer wrapped in a plan check — it cannot be
    // reached without one.
    assert.doesNotMatch(editable, /canConfigure/);
  });
});

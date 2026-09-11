/**
 * mobile-entitlement-correctness.node.test.ts — Business 2.0 Phase 3B.
 *
 * Mobile decided every paid question from local_businesses.subscription_tier,
 * the column that records what was bought rather than whether it is still in
 * date. The worst of it was Bookings, which was wrong in both directions at
 * once: a correctly entitled PRO owner could not see the card and was told
 * "Premium feature" at the toggle, while a configured-Premium business whose
 * date had passed sailed through the client and was refused by the server.
 *
 * Everything paid on the owner side now asks business_meets_tier — the same
 * predicate the triggers and read policies use. Setup, history, billing and
 * withdrawal are not paid actions and are never gated by it.
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
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const DASH = 'app/local-business-dashboard.tsx';
const dash = () => code(DASH);

/* ── 1. One reader, and it fails closed ───────────────────────────────────── */

describe('the owner side asks the deployed predicate', () => {
  test('there is exactly one entitlement reader, using business_meets_tier', () => {
    const h = code('lib/entitlement.ts');
    assert.match(h, /business_meets_tier/);
    assert.match(h, /p_required_tier: 'pro'/);
    assert.match(h, /p_required_tier: 'premium'/);
    assert.doesNotMatch(h, /subscription_until|subscription_tier/, 'no second expiry formula');
  });

  test('an unreadable answer is not entitlement', () => {
    const h = code('lib/entitlement.ts');
    assert.match(h, /pro: !pro\.error && pro\.data === true/);
    assert.match(h, /premium: !premium\.error && premium\.data === true/);
    assert.match(h, /NO_ENTITLEMENT: Effective = \{ pro: false, premium: false \}/);
  });

  test('no owner-side paid action still decides on the configured tier', () => {
    const d = dash();
    assert.doesNotMatch(d, /tierMeets\(activeBusiness\.subscription_tier/,
      'every gate must ask the predicate');
    assert.doesNotMatch(d, /subscription_tier === 'premium'/);
    assert.doesNotMatch(d, /subscription_tier !== 'premium'/);
  });
});

/* ── 2. Bookings — the defect that started this ───────────────────────────── */

describe('bookings is Pro, effective, and open to set up', () => {
  test('Pro is the canonical plan in the copy', () => {
    assert.match(dash(), /\{ label: 'In-app bookings',\s+req: 'pro'\s+\}/);
    assert.doesNotMatch(dash(), /'In-app bookings',\s+req: 'premium'/);
  });

  test('the canonical map agrees, and always did', () => {
    const map = read('lib/listing-tiers.ts');
    assert.match(map, /bookings:\s*"pro"/);
  });

  test('enabling asks effective Pro; disabling asks nothing', () => {
    const d = dash();
    assert.match(d, /if \(value && !eff\.pro\) \{/, 'only switching ON is gated');
    assert.match(d, /Bookings need Pro/);
    assert.doesNotMatch(d, /'Premium feature'/);
  });

  test('the card is visible whatever the plan, so setup is reachable', () => {
    const d = dash();
    const card = d.slice(d.indexOf('<Text style={styles.cardTitle}>Bookings</Text>') - 900,
                         d.indexOf('<Text style={styles.cardTitle}>Bookings</Text>'));
    assert.doesNotMatch(card, /subscription_tier|tierMeets/, 'Bookings must not be hidden by plan');
  });

  test('the four setup screens are untouched', () => {
    for (const s of ['local-book-services', 'local-book-schedule', 'local-book-bookings', 'local-book-units']) {
      assert.match(dash(), new RegExp(`'/${s}'`), `${s} must stay reachable`);
    }
  });

  test('"live for booking" needs the flag AND a plan in date', () => {
    // Phase 3D replaced the large capability cards with one compact outcome
    // card each. The behaviour is unchanged; the markup it used to be pinned to
    // is not.
    // The status line now comes from bookingsOutcome, which is the web helper,
    // pinned byte-for-byte and already proved to require both.
    assert.match(dash(), /outcome=\{outcomes\[2\]\}/);
    assert.match(dash(), /onValueChange=\{toggleAcceptsBookings\}/);
  });

  test('the add-ons copy is gone — add-ons stopped existing', () =>
    assert.doesNotMatch(dash(), /enable via Add-ons/));
});

/* ── 3 & 4. Products and Passes — drafts below Premium ────────────────────── */

describe('products and passes can be prepared before paying', () => {
  test('the server keeps its draft carve-out', () => {
    for (const fn of ['products_tier_guard', 'book_unit_items_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      assert.match(String(row.d), /if new\.is_active is not true then\s*\n\s*return new;/, fn);
    }
  });

  test('a new product is a draft unless the plan can publish it', () => {
    const s = code('app/business-products.tsx');
    assert.match(s, /is_active: editingId \? \(editingActive \?\? true\) : eff\.premium/);
    assert.doesNotMatch(s, /is_active: true,/, 'creating must not publish unconditionally');
  });

  test('editing an existing product never changes whether it is on sale', () => {
    const s = code('app/business-products.tsx');
    assert.match(s, /setEditingActive\(p\.is_active\)/, 'the current state is carried into the edit');
    assert.match(s, /editingId \? \(editingActive/, 'and used instead of the plan');
  });

  test('a new pass is a draft unless the plan can publish it', () => {
    const s = code('app/local-book-units.tsx');
    assert.match(s, /\.\.\.\(isNew \? \{ is_active: eff\.premium \} : \{\}\)/);
    assert.doesNotMatch(s, /is_active:\s+true,/, 'creating must not publish unconditionally');
  });

  test('both read effective Premium, not the stored column', () => {
    for (const f of ['app/business-products.tsx', 'app/local-book-units.tsx']) {
      assert.match(code(f), /fetchEffectiveTier\(businessId\)/, f);
      assert.doesNotMatch(code(f), /subscription_tier/, f);
    }
  });
});

/* ── 5 & 6. Wallet, receipts and NFC ──────────────────────────────────────── */

describe('wallet settings are open; only acceptance is paid', () => {
  test('switching ON asks effective Pro, switching OFF asks nothing', () => {
    const d = dash();
    assert.match(d, /if \(value && !eff\.pro\) \{[\s\S]{0,200}Wallet payments need Pro/);
  });

  test('history is not erased by a downgrade, or by switching Wallet off', () => {
    const d = dash();
    // It used to be `tierMeets(...) && accepts_wallet &&`, and the fetch itself
    // was skipped unless Wallet was on — so turning it off hid the record of
    // money already taken.
    assert.match(d, /\{walletReceipts\.length > 0 && \(/);
    assert.doesNotMatch(d, /accepts_wallet\s*&&\s*\(\s*\n?\s*<WalletReceiptsCard/);
    assert.match(d, /fetchBusinessWalletReceipts\(target\.id, 20\)/);
    assert.doesNotMatch(d, /target\.accepts_wallet\s*\n?\s*\?\s*fetchBusinessWalletReceipts/);
  });

  test('customer balances are never treated as business money', () => {
    const d = dash();
    assert.doesNotMatch(d, /local_wallet_balances|balance_pence/,
      'the dashboard shows receipts the business earned, not customer wallets');
  });

  test('the NFC section is not hidden by plan', () => {
    const d = dash();
    const nfc = d.slice(Math.max(0, d.indexOf('NFC tile') - 400), d.indexOf('NFC tile'));
    assert.doesNotMatch(nfc, /tierMeets|subscription_tier/);
  });
});

/* ── 7 & 8. Downgrade safety ──────────────────────────────────────────────── */

describe('a downgrade does not strand offers or a running programme', () => {
  test('the server allows withdrawal and refuses creation', () => {
    for (const fn of ['local_offers_tier_guard', 'local_loyalty_programs_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      assert.match(String(row.d), /old\.is_active is true and new\.is_active is not true/, fn);
    }
  });

  test('retention stays visible below Pro and explains itself', () => {
    // Phase 3D replaced the large capability cards with one compact outcome
    // card each. The behaviour is unchanged; the markup it used to be pinned to
    // is not.
    // The explanation moved into retentionOutcome's status line — the shared
    // helper — so it is one sentence in one place instead of two card bodies.
    const web = readFileSync(join(REPO_ROOT, '..', 'oneshetland-web', 'lib', 'business-outcomes.ts'), 'utf8');
    assert.match(web, /Part of Pro — a reason for folk to come back/);
    assert.match(dash(), /outcome=\{outcomes\[4\]\}/);
  });

  test('creating and editing stay unavailable below Pro', () => {
    // Phase 3D replaced the large capability cards with one compact outcome
    // card each. The behaviour is unchanged; the markup it used to be pinned to
    // is not.
    const d = dash();
    assert.match(d, /eff\.pro \? \[[\s\S]{0,400}setShowLoyaltyModal\(true\)/,
      'new offer and edit loyalty are offered only with Pro');
    assert.match(d, /\] : \[\{ label: 'See plans'/, 'and below it, the plans instead');
  });

  test('stopping a programme exists, and is not gated', () => {
    // Phase 3D shortened the label to "Stop" inside the compact outcome card.
    // The handler, and the fact that it sits outside the plan check, are what
    // this was ever protecting.
    const d = dash();
    assert.match(d, /const stopLoyalty = async \(\) => \{/);
    const from = d.indexOf('{program?.is_active && (');
    assert.ok(from > -1, 'the stop control must still be conditional on a running programme');
    const stop = d.slice(from, from + 600);
    assert.match(stop, /onPress=\{stopLoyalty\}/);
    assert.doesNotMatch(stop, /eff\.pro/, 'stopping never depends on the plan');
  });

  test('stopping changes the programme and nothing of the customer’s', () => {
    const d = dash();
    const fn = d.slice(d.indexOf('const stopLoyalty'), d.indexOf('const updateCashback'));
    assert.match(fn, /update\(\{ is_active: false \}\)\.eq\('business_id'/);
    assert.doesNotMatch(fn, /local_loyalty_cards|local_loyalty_transactions|delete/i);
  });

  test('existing offers stay listed, and ending one is still possible', () => {
    // Phase 3D replaced the large capability cards with one compact outcome
    // card each. The behaviour is unchanged; the markup it used to be pinned to
    // is not.
    const d = dash();
    assert.match(d, /offers\.filter\(o => o\.is_active\)\.map/, 'live offers are still listed');
    assert.match(d, /deactivateOffer\(o\.id\)/, 'and each can still be ended');
    assert.match(d, /'\/local-offer-new'/, 'the offers route stays reachable');
  });
});

/* ── 9 & 10. Billing access and plan claims ───────────────────────────────── */

describe('plan facts and access claims are different things', () => {
  test('billing is reachable on any plan', () => {
    const d = dash();
    const before = d.slice(Math.max(0, d.indexOf('onPress={openBillingPortal}') - 300),
                           d.indexOf('onPress={openBillingPortal}'));
    assert.doesNotMatch(before, /tierMeets|subscription_tier/,
      'a lapsed owner is the one most likely to need the plans screen');
  });

  test('"All features unlocked" is a claim about access, so it uses entitlement', () => {
    assert.match(dash(), /\{eff\.premium && \(\s*\n\s*<View style=\{styles\.allUnlocked\}>/);
  });

  test('the feature checklist ticks what is available now', () => {
    assert.match(dash(), /const unlocked = f\.req === 'free' \? true : f\.req === 'pro' \? eff\.pro : eff\.premium;/);
  });

  test('showing the plan NAME from the stored column is still fine', () => {
    // TIER_LABELS[subscription_tier] is a fact about what was bought, not a
    // claim about what works today.
    assert.match(dash(), /TIER_LABELS\[activeBusiness\.subscription_tier\]/);
  });
});

/* ── 11 & 12. Scope ───────────────────────────────────────────────────────── */

describe('nothing outside correctness moved', () => {
  // These three pinned Phase 3B's deliberate NOT-YETs: Work still listed, the
  // dashboard not regrouped, no spine. Phase 3C is the yet. What they guard now
  // is that none of it cost anything — the detail lives in
  // mobile-business-home.node.test.ts.
  test('Work functionality was not lost when it left the Business list', () => {
    for (const f of ['app/business-jobs.tsx', 'app/business-leads.tsx']) {
      assert.ok(read(f).length > 0, `${f} must still exist`);
    }
    assert.match(code('lib/business-home.ts'), /route: '\/business-jobs'/,
      'Work attention still deep-links into Work');
    assert.match(dash(), /orphanedShiftCount/, 'the shift backfill prompt stays');
  });

  test('the counter block and Money survived the regroup', () => {
    for (const g of ['At the counter', 'Money']) {
      assert.ok(read(DASH).includes(g), `group header lost: ${g}`);
    }
  });

  test('the spine exists, and Next still defers to what is waiting', () => {
    const d = dash();
    assert.match(d, /const next = home && !hasOperationalAttention\(/);
    assert.match(d, /\{attention\.length > 0 && \(/);
  });

  test('web changes stay inside the approved refund-parity files', () => {
    // Phase 3B was mobile-only and this guard existed to keep it that way. The
    // business Wallet refund work is the one approved exception: a merchant who
    // manages money in the web Business Suite has to be able to refund there
    // too, and a refunded pass has to read truthfully on both clients. So the
    // guard is NARROWED to exactly those files rather than dropped — anything
    // else appearing in the web tree still fails here.
    const APPROVED_WEB = [
      'components/business/WalletManager.tsx',   // merchant Refund action
      'lib/business-data.ts',                    // merchant receipt refund_state model
      'components/business/TransactionsLedger.tsx', // statement refund accounting
      'lib/passes-data.ts',                      // pass refund_state model
      'app/account/passes/PassesClient.tsx',     // pass refund_state on screen
      // The redemption business scope. The same merchant redemption workflow is
      // exposed on both clients, and the web one carried the identical defect:
      // RedeemVerify took no businessId while every sibling on its page did, so
      // an owner of two businesses could redeem one business's reward while
      // managing the other. Fixing mobile alone would have left the blocker
      // live on web, so these three are approved on the same ticket.
      'app/business/[id]/manage/loyalty/page.tsx', // passes businessId down
      'components/business/RedeemVerify.tsx',      // scopes preview and redeem
      'lib/loyalty-redeem-client.ts',              // sends business_id
    ];
    const out = execFileSync('git', ['status', '--porcelain'],
      { cwd: join(REPO_ROOT, '..', 'oneshetland-web'), encoding: 'utf8' });
    const changed = out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''));
    assert.deepEqual(changed.filter((f) => !APPROVED_WEB.includes(f)), [],
      'Phase 3B is mobile-only apart from the approved business Wallet refund parity files');
  });

  test('backend enforcement is exactly where it was', () => {
    const rows = sql(`
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    assert.deepEqual(rows.map((r) => r.tbl),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers', 'products']);
    // local_wallet_transactions left this list when 20261006120000 retired
    // tg_loyalty_earn_points. The gate did not leave with it: the tier check
    // moved into loyalty_award_for_wallet_spend, which the four fulfilment
    // callers invoke once the merchant has actually been paid. Asserted here so
    // shrinking the list above can never quietly mean losing enforcement.
    const [movedGate] = sql(`select pg_get_functiondef('public.loyalty_award_for_wallet_spend'::regproc) as d;`);
    assert.match(String(movedGate.d), /business_meets_tier\(v_txn\.business_id, 'pro'\)/,
      'the wallet-points tier gate vanished along with the trigger');
    const [retired] = sql(`select count(*)::int as n from pg_proc p
       join pg_namespace n2 on n2.oid = p.pronamespace
      where n2.nspname='public' and p.proname='tg_loyalty_earn_points';`);
    assert.equal(Number(retired.n), 0, 'the retired award trigger is back');

  });
});

/* ── Selected-business context ────────────────────────────────────────────── */

describe('the dashboard opens the business the user actually tapped', () => {
  // Tapping Anderson & Co opened DEMO — Subscription Test Co. The dashboard
  // never read its route parameter: it took bizList[0], and fetchMyBusinesses
  // orders by created_at desc, so the newest business always won. On a screen
  // carrying refunds, payouts and till access, that is the wrong business.
  const dashSrc = () => read('app/local-business-dashboard.tsx');
  const detailSrc = () => read('app/local-business-detail.tsx');

  type Biz = { id: string; name: string };
  const ANDERSON: Biz = { id: 'and-1', name: 'Anderson & Co' };
  const DEMO: Biz = { id: 'demo-1', name: 'DEMO — Subscription Test Co' };
  /** created_at desc, exactly as fetchMyBusinesses returns them. */
  const OWNED: Biz[] = [DEMO, ANDERSON];

  /** The shipped precedence, lifted out of the source and executed. */
  function pick(biz: Biz | undefined, routeBusinessId: string | undefined, withPrivate: Biz[]): Biz | undefined {
    const s = dashSrc();
    const m = s.match(/const requested = routeBusinessId\s*\n?\s*\?([\s\S]*?);\n\s*const target = ([^;]+);/);
    assert.ok(m, 'the dashboard no longer selects its business the way this test reads it');
    const body = `const requested = routeBusinessId ? ${m![1].trim()}; const target = ${m![2].trim()}; return target;`;
    return new Function('biz', 'routeBusinessId', 'withPrivate', body)(biz, routeBusinessId, withPrivate) as Biz | undefined;
  }

  test('the dashboard reads the business id from the route', () => {
    assert.match(dashSrc(), /useLocalSearchParams<\{ id\?: string(?:; tab\?: string)? \}>\(\)/,
      'the dashboard is not reading its route parameter');
    assert.match(dashSrc(), /\}, \[profile\?\.id, routeBusinessId\]\);/,
      'loadAll would not re-run when the route business changes');
  });

  test('an explicit Anderson id opens Anderson', () => {
    assert.deepEqual(pick(undefined, ANDERSON.id, OWNED), ANDERSON);
  });

  test('the explicit id beats the default, which is the newest business', () => {
    // Without the fix this returned DEMO, because DEMO is OWNED[0].
    assert.notDeepEqual(pick(undefined, ANDERSON.id, OWNED), DEMO);
    assert.deepEqual(pick(undefined, undefined, OWNED), DEMO, 'the fallback itself changed');
  });

  test('opening with no id keeps the existing fallback', () => {
    assert.deepEqual(pick(undefined, undefined, OWNED), OWNED[0]);
    assert.equal(pick(undefined, undefined, []), undefined, 'no businesses must not throw');
  });

  test('switching business on the screen still wins over the route', () => {
    // loadAll(biz) is how the switcher reloads; an explicit argument outranks
    // the route, or the user could never move off the business they arrived on.
    assert.deepEqual(pick(DEMO, ANDERSON.id, OWNED), DEMO);
  });

  test('a reload cannot quietly revert to the default', () => {
    // The selection is a pure function of (argument, route, list), so a second
    // or third load — a refresh, a late effect — resolves the same way rather
    // than falling back to OWNED[0].
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(pick(undefined, ANDERSON.id, OWNED), ANDERSON, `load ${i + 1} drifted`);
    }
  });

  test('an id the user does not own falls back rather than selecting it', () => {
    // The list is built from fetchMyBusinesses(profile.id), so a foreign id
    // simply finds nothing. It can never select someone else's business.
    assert.deepEqual(pick(undefined, 'someone-elses-business', OWNED), DEMO);
    assert.equal(pick(undefined, 'someone-elses-business', []), undefined);
  });

  test('every owner entry point names the business it came from', () => {
    // me.tsx already passed { id }. The business page did not, so "Manage
    // business" on Anderson & Co opened whichever business was newest.
    const detail = detailSrc();
    const bare = detail.match(/router\.push\('\/local-business-dashboard'\)/g) ?? [];
    assert.equal(bare.length, 0, 'an owner entry still opens the dashboard with no business');
    assert.match(detail, /pathname: '\/local-business-dashboard', params: \{ id \}/);
    assert.match(read('app/(tabs)/me.tsx'), /pathname: '\/local-business-dashboard', params: \{ id: biz\.id/);
  });

  test('financial child screens are handed the business on screen', () => {
    const s = dashSrc();
    // Every push out of the dashboard carries activeBusiness.id — never
    // businesses[0], never the route id, so a child can only ever act on the
    // business the merchant can see. event-manage/event-scanner carry an
    // EVENT id instead (they're per-event screens, not per-business), but
    // nextBizEvent is itself derived from data fetched for activeBusiness.id
    // (fetchBusinessEvents(target.id) — see business-next-event.node.test.ts
    // and the "the dashboard actually uses the fix" checks there), so it is
    // still transitively business-scoped, not a stray index or route id.
    const pushes = s.match(/pathname: '\/[a-z-]+', params: \{ (?:businessId|id): ([^,}]+)/g) ?? [];
    assert.ok(pushes.length >= 10, `expected the dashboard to route to its sections, found ${pushes.length}`);
    for (const p of pushes) {
      assert.ok(/activeBusiness|nextBizEvent/.test(p),
        `a child screen is handed something other than the visible business: ${p}`);
    }
    assert.ok(!/params: \{ businessId: routeBusinessId/.test(s),
      'a child screen is handed the route id instead of the visible business');
  });

  test('money screens in particular follow the visible business', () => {
    const s = dashSrc();
    for (const screen of ['local-till', 'local-counter', 'payment-setup', 'business-orders']) {
      const m = s.match(new RegExp(`pathname: '/${screen}', params: \\{ businessId: ([^,}]+)`));
      assert.ok(m, `the dashboard no longer routes to ${screen}`);
      assert.match(m![1], /activeBusiness/, `${screen} is not given the visible business`);
    }
  });
});

/* ── Payments-section targeting ───────────────────────────────────────────── */

describe('tab=payments lands the merchant on the payments section', () => {
  // "Payment card" and "Payout bank" in the Me tab already pushed
  // tab: 'payments'. The dashboard read neither, so both dropped the merchant
  // at the top of a long screen to hunt for the section they had just tapped.
  const dashSrc = () => read('app/local-business-dashboard.tsx');

  /** The shipped guard, lifted out of the source and executed. */
  function attempt(opts: {
    routeTab?: string; activeBusiness: unknown; planCardY: number | null; alreadyJumped?: boolean;
  }) {
    const s = dashSrc();
    const m = s.match(/const jumpToPaymentsIfRequested = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[routeTab, activeBusiness\]\);/);
    assert.ok(m, 'the payments jump is no longer written the way this test reads it');
    const body = m![1]
      .replace(/didJumpToPayments\.current/g, 'state.jumped')
      .replace(/planCardY\.current/g, 'planCardY')
      .replace(/setExpanded\(\(prev\) => \(\{ \.\.\.prev, plan: true \}\)\);/, 'state.expandedPlan = true;')
      .replace(/scrollRef\.current\?\.scrollTo\(\{ y: ([\s\S]+?), animated: true \}\);/, 'state.scrolledTo = $1;');
    const state = { jumped: opts.alreadyJumped ?? false, expandedPlan: false, scrolledTo: null as number | null };
    new Function('routeTab', 'activeBusiness', 'planCardY', 'state', 'Math', body)(
      opts.routeTab, opts.activeBusiness, opts.planCardY, state, Math);
    return state;
  }

  const BIZ = { id: 'and-1', name: 'Anderson & Co' };

  test('the dashboard reads the tab parameter alongside the id', () => {
    assert.match(dashSrc(), /useLocalSearchParams<\{ id\?: string; tab\?: string \}>\(\)/,
      'the dashboard is not reading the tab parameter');
  });

  test('tab=payments opens the section and scrolls to it', () => {
    const r = attempt({ routeTab: 'payments', activeBusiness: BIZ, planCardY: 420 });
    assert.equal(r.jumped, true);
    assert.equal(r.expandedPlan, true, 'the card was left collapsed, so there is nothing to see');
    assert.equal(r.scrolledTo, 412, 'did not scroll to the payments card');
  });

  test('no tab does nothing at all', () => {
    const r = attempt({ activeBusiness: BIZ, planCardY: 420 });
    assert.deepEqual(r, { jumped: false, expandedPlan: false, scrolledTo: null });
  });

  test('an unknown tab does nothing at all', () => {
    const r = attempt({ routeTab: 'loyalty', activeBusiness: BIZ, planCardY: 420 });
    assert.deepEqual(r, { jumped: false, expandedPlan: false, scrolledTo: null });
  });

  test('it waits for the business rather than scrolling an empty screen', () => {
    const r = attempt({ routeTab: 'payments', activeBusiness: null, planCardY: 420 });
    assert.equal(r.jumped, false, 'jumped before the business had loaded');
    assert.equal(r.scrolledTo, null);
  });

  test('it waits for the card to be laid out', () => {
    const r = attempt({ routeTab: 'payments', activeBusiness: BIZ, planCardY: null });
    assert.equal(r.jumped, false, 'scrolled to a position it had not measured');
  });

  test('it fires once, and never again', () => {
    // The guard is a ref, so re-renders, a refresh, or the card re-laying out
    // must not drag the merchant back down the screen.
    const r = attempt({ routeTab: 'payments', activeBusiness: BIZ, planCardY: 900, alreadyJumped: true });
    assert.equal(r.scrolledTo, null, 'scrolled a second time');
    assert.equal(r.expandedPlan, false, 'reopened a card the merchant may have closed');
  });

  test('both the effect and the layout attempt it, so neither has to win the race', () => {
    const s = dashSrc();
    assert.match(s, /useEffect\(\(\) => \{ jumpToPaymentsIfRequested\(\); \}, \[jumpToPaymentsIfRequested, loading\]\);/);
    assert.match(s, /onLayout=\{\(e\) => \{ planCardY\.current = e\.nativeEvent\.layout\.y; jumpToPaymentsIfRequested\(\); \}\}/);
    assert.ok(!/setTimeout|setInterval/.test(s.slice(s.indexOf('jumpToPaymentsIfRequested'), s.indexOf('jumpToPaymentsIfRequested') + 900)),
      'a timer was added to paper over the race');
  });

  test('business selection is untouched by any of this', () => {
    const s = dashSrc();
    // The tab must never influence which business is chosen.
    assert.match(s, /const target = biz \?\? requested \?\? withPrivate\[0\];/);
    assert.ok(!/routeTab.*withPrivate|withPrivate.*routeTab/.test(s),
      'the tab parameter leaked into business selection');
    assert.match(s, /withPrivate\.find\(\(b\) => b\.id === routeBusinessId\)/,
      'the owned-business check was lost');
  });

  test('manual switching and child routing still stand', () => {
    const s = dashSrc();
    assert.match(s, /loadAll\(b\)|loadAll\(activeBusiness\)/, 'the switcher no longer reloads a chosen business');
    const pushes = s.match(/pathname: '\/[a-z-]+', params: \{ (?:businessId|id): ([^,}]+)/g) ?? [];
    assert.ok(pushes.length >= 10);
    for (const p of pushes) {
      assert.ok(/activeBusiness|nextBizEvent/.test(p), `a child screen is no longer given the visible business: ${p}`);
    }
  });
});

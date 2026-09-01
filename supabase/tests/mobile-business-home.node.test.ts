/**
 * mobile-business-home.node.test.ts — Business 2.0 Phase 3C.
 *
 * The mobile dashboard was one 2,300-line screen grouped by OneShetland's own
 * vocabulary — "Sell & list" held bookings, products, jobs, job leads, events
 * and analytics — with no sense anywhere of what was waiting or what to do
 * next. It now follows the same spine and the same five outcomes as web.
 *
 * Semantics are shared by copying the pure helpers and pinning the copies
 * byte-for-byte against the web originals. Re-deriving them here instead is
 * exactly how Bookings came to be advertised as Premium.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Imported from the WEB copies, deliberately. The mobile copies must stay
 * Metro-resolvable, so they import without file extensions and node cannot load
 * them directly. The byte-equality pin below proves the two copies are the same
 * code, which makes exercising either one an exercise of both — and makes drift
 * the thing that fails, rather than something nobody notices.
 */
import { beFound } from '../../../oneshetland-web/lib/be-found.ts';
import { businessOutcomes, sellOutcome, bookingsOutcome, eventsOutcome, retentionOutcome,
         type OutcomeData } from '../../../oneshetland-web/lib/business-outcomes.ts';
import { nextAction, hasOperationalAttention } from '../../../oneshetland-web/lib/business-next-action.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
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
const raw = () => read(DASH);

const NONE: OutcomeData = {
  products: 0, productsActive: 0, passes: 0, passesActive: 0,
  services: 0, availability: 0, events: 0, eventsUpcoming: 0,
  offers: 0, offersLive: 0, loyalty: 0, loyaltyActive: 0,
  meetsPro: false, meetsPremium: false,
};
const d = (o: Partial<OutcomeData>): OutcomeData => ({ ...NONE, ...o });
const CALM = { orders: { length: 0 }, bookings: { length: 0 }, leads: { length: 0 },
               needs: { jobApplications: 0 }, isTrade: false,
               tradeAvailability: null, tradeAvailabilitySetAt: null };

/* ── 1. Shared semantics, pinned ──────────────────────────────────────────── */

describe('the copied helpers stay identical to web', () => {
  for (const f of ['be-found.ts', 'business-outcomes.ts', 'business-next-action.ts']) {
    test(`${f} matches the web original`, () => {
      // Only the header note and the import lines may differ — the repos
      // resolve opening-hours and trades from different places.
      // Block comments and imports removed from BOTH: the mobile copy carries an
      // extra header note, and the two repos resolve opening-hours and trades
      // from different places. Everything else must be identical.
      const strip = (s: string) => s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !l.trim().startsWith('import ')).join('\n')
        .replace(/\n{2,}/g, '\n').trim();
      assert.equal(strip(read(`lib/${f}`)), strip(readWeb(`lib/${f}`)),
        `${f} has drifted — edit the web copy and mirror it, never re-derive`);
    });
  }

  test('mobile does not define its own versions of these rules', () => {
    const dsrc = dash();
    for (const reinvented of ['function beFound', 'function nextAction', 'stamps_required >=']) {
      assert.ok(!dsrc.includes(reinvented), `${reinvented} must come from the helper`);
    }
  });
});

/* ── 2. The spine ─────────────────────────────────────────────────────────── */

describe('needs you, next, this week', () => {
  test('the hierarchy is exactly the accepted one', () => {
    const headers = [...raw().matchAll(/groupHeader}>([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(headers,
      ['Needs you', 'Next', 'This week', 'At the counter', 'Your business', 'Money', 'Grow']);
  });

  test('needs you renders only when something is genuinely waiting', () => {
    assert.match(dash(), /\{attention\.length > 0 && \(/);
    const loader = code('lib/business-home.ts');
    assert.match(loader, /if \(orders && orders > 0\)/, 'a zero is not an item');
    assert.match(loader, /if \(bookings && bookings > 0\)/);
    assert.match(loader, /if \(leads && leads > 0\)/);
    assert.match(loader, /if \(apps && apps > 0\)/);
  });

  test('an unreadable count never becomes an attention item', () => {
    // num() returns null on failure, and `null && null > 0` is falsy — so an
    // unreadable table cannot invent urgency.
    const loader = code('lib/business-home.ts');
    assert.match(loader, /r\.status === 'fulfilled' && !r\.value\.error \? \(r\.value\.count \?\? 0\) : null/);
  });

  test('next is suppressed while anything is waiting', () => {
    assert.match(dash(), /const next = home && !hasOperationalAttention\(/);
    // ...and the helper itself is the web one, already proved by the pin above.
    assert.equal(hasOperationalAttention({ ...CALM, orders: { length: 1 } }), true);
    assert.equal(hasOperationalAttention(CALM), false);
  });

  test('next gives one Be Found action, and nothing commercial', () => {
    const a = nextAction(CALM, { phone: null, lat: null, lng: null }, '');
    assert.equal(a?.key, 'contact');
    const keys = new Set<string>();
    for (const b of [{}, { phone: 'p' }, { phone: 'p', lat: 60.1, lng: -1.1 },
                     { phone: 'p', lat: 60.1, lng: -1.1, description: 'x' }]) {
      const r = nextAction(CALM, b, ''); if (r) keys.add(r.key);
    }
    assert.deepEqual([...keys].sort(), ['contact', 'description', 'image', 'map_pin']);
  });

  test('a finished listing with nothing waiting has no next at all', () => {
    const good = { phone: '01595', lat: 60.15, lng: -1.15, description: 'x',
                   logo_url: 'u', opening_hours: { mon: '9-5' } as never };
    assert.equal(nextAction(CALM, good, ''), null);
    assert.match(dash(), /home && attention\.length === 0 && !next && \(/,
      'and the calm state must look like a state, not a blank');
  });

  test('this week never shows an unknown figure as zero', () => {
    assert.match(dash(), /value === null \? '—'/);
    const loader = code('lib/business-home.ts');
    assert.match(loader, /views: basic \? \(basic\.profile_views \?\? 0\) : null/);
    assert.match(loader, /revenuePence: full/);
    assert.match(loader, /: null,/);
  });
});

/* ── 3. The five outcomes ─────────────────────────────────────────────────── */

describe('five outcomes, same semantics as web', () => {
  test('rendered in the accepted fixed order', () => {
    const src = raw();
    const idx = [0, 1, 2, 3, 4].map((i) => src.indexOf(`outcomes[${i}]`));
    assert.ok(idx.every((n) => n > -1), 'all five must render');
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'order must not be sorted by state');
    assert.deepEqual(
      businessOutcomes({ id: 'b', slug: 's' }, NONE, '').map((o) => o.key),
      ['found', 'sell', 'bookings', 'events', 'retention']);
  });

  test('be found uses the accepted milestones and no percentage', () => {
    assert.equal(beFound({}).state, 'incomplete');
    assert.equal(beFound({ phone: 'p', lat: 60.1, lng: -1.1 }).state, 'ready');
    assert.equal(beFound({ phone: 'p', lat: 60.1, lng: -1.1, description: 'x',
                           logo_url: 'u', opening_hours: { mon: '9-5' } as never }).state, 'good');
    // Scoped: cashback_percent is a legitimate field. What must not exist is a
    // setup SCORE.
    assert.doesNotMatch(dash(), /% complete|setupPercent|completionPercent|of 5 done/i);
  });

  test('sell: live needs effective Premium, and a lapse is not live', () => {
    assert.equal(sellOutcome(d({ products: 2, productsActive: 2, meetsPremium: true }), '').state, 'live');
    assert.equal(sellOutcome(d({ products: 2, productsActive: 2, meetsPremium: false }), '').state, 'saved');
    assert.equal(sellOutcome(NONE, '').state, 'available');
  });

  test('orders are attention, not a Sell setup card', () => {
    const src = raw();
    const your = src.slice(src.indexOf('>Your business<'), src.indexOf('>Money<'));
    assert.doesNotMatch(your, /orders to deal with/i, 'waiting orders belong in NEEDS YOU');
    assert.match(code('lib/business-home.ts'), /key: 'orders'/);
  });

  test('bookings: effective Pro drives live, and Premium wording is gone', () => {
    assert.equal(bookingsOutcome(d({ services: 1, availability: 1, meetsPro: true }), true, '').state, 'live');
    assert.equal(bookingsOutcome(d({ services: 1, availability: 1, meetsPro: false }), true, '').state, 'saved');
    assert.doesNotMatch(raw(), /bookings[^\n]{0,40}Premium|Premium[^\n]{0,40}bookings/i);
  });

  test('the four booking screens are still four screens', () => {
    for (const r of ['/local-book-services', '/local-book-schedule',
                     '/local-book-bookings', '/local-book-units']) {
      assert.match(raw(), new RegExp(`'${r}'`), r);
    }
  });

  test('events are free and derived only from real schema states', () => {
    assert.equal(eventsOutcome(NONE, '').state, 'available');
    assert.equal(eventsOutcome(d({ events: 2, eventsUpcoming: 1 }), '').state, 'upcoming');
    assert.equal(eventsOutcome(d({ events: 2, eventsUpcoming: 0 }), '').state, 'none_upcoming');
    for (const s of [NONE, d({ events: 1, eventsUpcoming: 1 })]) {
      const o = eventsOutcome(s, '');
      assert.doesNotMatch(`${o.status} ${o.blurb}`, /\b(Pro|Premium|plan|upgrade)\b/i);
    }
  });

  test('retention: effective Pro drives live, and downgrade stays safe', () => {
    assert.equal(retentionOutcome(d({ offers: 1, offersLive: 1, meetsPro: true }), '').state, 'live');
    assert.equal(retentionOutcome(d({ offers: 1, offersLive: 1, meetsPro: false }), '').state, 'saved');
    const src = raw();
    // Phase 3D shortened the label to "Stop" inside the compact card. What
    // matters is the handler, not the wording.
    assert.match(src, /onPress=\{stopLoyalty\}/, 'a lapsed owner can still stop a running programme');
    assert.match(src, /deactivateOffer\(o\.id\)/, 'and still end a live offer');
  });

  test('a failed read leaves an outcome unknown, never a confident nothing', () => {
    for (const [fn, data] of [[sellOutcome, d({ products: null })],
                              [eventsOutcome, d({ events: null })],
                              [retentionOutcome, d({ offers: null })]] as const) {
      const o = (fn as (x: OutcomeData, b: string) => { state: string; status: string })(data, '');
      assert.equal(o.state, 'unknown');
      assert.doesNotMatch(o.status, /^(No |Not |0 )/);
    }
    assert.equal(bookingsOutcome(d({ services: null }), false, '').state, 'unknown');
  });
});

/* ── 4. Money, Grow, Work ─────────────────────────────────────────────────── */

describe('the layers below the outcomes', () => {
  test('Counter, Till and Verify keep their own block above Money', () => {
    const src = raw();
    assert.ok(src.indexOf('>At the counter<') < src.indexOf('>Money<'));
    for (const r of ['/local-counter', '/local-till', '/local-verify']) {
      assert.match(src, new RegExp(r.replace('/', '\\/')), r);
    }
    const money = src.slice(src.indexOf('>Money<'), src.indexOf('>Grow<'));
    assert.doesNotMatch(money, /local-counter|local-till/, 'Counter is not duplicated under Money');
  });

  test('Money keeps plan, payouts, wallet and transactions', () => {
    const src = raw();
    const money = src.slice(src.indexOf('>Money<'), src.indexOf('>Grow<'));
    for (const r of ['/payment-setup', '/local-business-transactions']) {
      assert.match(money, new RegExp(r.replace(/\//g, '\\/')), r);
    }
    assert.match(money, /Accept Local Wallet/);
  });

  test('billing is still reachable on any plan', () => {
    // The nearest conditional ABOVE the manage button, rather than a byte
    // window — the loyalty card's "See plans" branch sits nearby and legitimately
    // reads eff.pro.
    const lines = dash().split('\n');
    // The Money card's manage button — not the loyalty card's "See plans",
    // which legitimately appears only below Pro.
    const btn = lines.findIndex((l, i) =>
      l.includes('onPress={openBillingPortal}') &&
      lines.slice(Math.max(0, i - 3), i).some((x) => x.includes('styles.manageBtn')));
    assert.ok(btn > -1);
    const wrapper = [...lines.slice(0, btn)].reverse().find((l) => /&& \(\s*$/.test(l)) ?? '';
    assert.match(wrapper, /\{true && \(/, 'billing must not sit behind any plan check');
  });

  test('Grow holds analytics, boost and urgent alerts', () => {
    const src = raw();
    const grow = src.slice(src.indexOf('>Grow<'));
    assert.match(grow, /local-business-analytics/);
    assert.match(grow, /AlertsCard/);
    // Boost has no standalone mobile route; the plan card already shows it.
    assert.match(src, /isOnBoost\(activeBusiness\)/);
  });

  test('customer wallet balances are never business money', () =>
    assert.doesNotMatch(dash(), /local_wallet_balances|balance_pence/));
});

describe('work is a separate product now', () => {
  test('Jobs and Job leads are no longer Business capabilities', () => {
    assert.doesNotMatch(raw(), /pathname: '\/business-jobs'/);
    assert.doesNotMatch(raw(), /pathname: '\/business-leads'/);
  });

  test('but the screens and routes still exist', () => {
    for (const f of ['app/business-jobs.tsx', 'app/business-leads.tsx']) {
      assert.ok(read(f).length > 0, `${f} must not be deleted`);
    }
  });

  test('and Work attention still deep-links into Work', () => {
    const loader = code('lib/business-home.ts');
    assert.match(loader, /route: '\/business-jobs'/);
    assert.match(loader, /route: '\/business-leads'/);
  });

  test('the shift backfill prompt was not lost', () => {
    assert.match(raw(), /orphanedShiftCount > 0 && \(/);
    assert.match(raw(), /Link \$\{orphanedShiftCount\}|orphanedShiftCount/);
  });
});

/* ── 5. The old structure is gone ─────────────────────────────────────────── */

describe('nothing of the old dashboard survives', () => {
  test('the old groupings are removed', () => {
    for (const gone of ['Sell &amp; list', 'Loyalty &amp; offers', 'enable via Add-ons']) {
      assert.ok(!raw().includes(gone), `${gone} must be gone`);
    }
  });

  test('no configured-tier gating came back', () => {
    const src = dash();
    assert.doesNotMatch(src, /tierMeets\(activeBusiness\.subscription_tier/);
    assert.doesNotMatch(src, /subscription_tier === 'premium'/);
    assert.doesNotMatch(src, /subscription_tier !== 'premium'/);
  });

  test('no permanent upgrade wall, and no grey locked capabilities', () => {
    const src = raw();
    assert.doesNotMatch(src, /Unlock now|Upgrade now/i);
    // An ENDED offer is legitimately dimmed — that is content the owner
    // withdrew, not a capability their plan withholds. What must not exist is
    // anything greyed out or padlocked BECAUSE of entitlement.
    const your = src.slice(src.indexOf('>Your business<'), src.indexOf('>Money<'));
    for (const line of your.split('\n')) {
      if (!/opacity|padlock|Locked</i.test(line)) continue;
      assert.doesNotMatch(line, /eff\.(pro|premium)|tierMeets|subscription_tier/,
        `a capability is dimmed by plan: ${line.trim()}`);
    }
  });

  test('optional capabilities are never coloured as warnings', () => {
    for (const o of businessOutcomes({ id: 'b', slug: 's' }, NONE, '')) {
      assert.notEqual(o.tone, 'warning');
    }
    // Only NEEDS YOU carries the amber treatment.
    const src = raw();
    assert.match(src, /attentionCard:\s*\{ backgroundColor: '#FFF7E6'/);
    assert.doesNotMatch(src, /outcomeDot[^\n]*F5D58A/);
  });

  test('no stored capability state, intent or percentage was introduced', () => {
    for (const bad of ['business_intent', 'capability_state', 'setup_percent']) {
      assert.ok(!dash().includes(bad), bad);
      assert.ok(!code('lib/business-home.ts').includes(bad), bad);
    }
  });
});

/* ── 6. Phase 3D — one reading of an event, and one card per outcome ─────── */

describe('an event cannot be upcoming and not upcoming at once', () => {
  test('the contradiction is reproducible from real data', () => {
    // Anderson & Co: the Home said "No upcoming events" while the card beneath
    // listed "Folk Festival at Mareel". The festival is CANCELLED and HIDDEN,
    // and the card filtered on the date alone.
    const [row] = sql(`
      select
        count(*) filter (where e.starts_at > now())                    as date_only,
        count(*) filter (where e.status = 'published' and not e.is_hidden
                           and e.starts_at > now())                    as canonical
      from public.events e join public.local_businesses b
        on b.id = e.organiser_business_id
      where b.name = 'Anderson & Co';`);
    assert.equal(String(row.date_only), '1', 'a date-only filter still finds it');
    assert.equal(String(row.canonical), '0', 'and the canonical rule correctly does not');
  });

  test('both sides of the Home now apply the same rule', () => {
    const loader = code('lib/business-home.ts');
    assert.match(loader, /\.eq\('status', 'published'\)[\s\S]{0,80}\.eq\('is_hidden', false\)[\s\S]{0,60}\.gt\('starts_at', now\)/,
      'the count must require published, not hidden, and still to come');
    const list = code(DASH);
    assert.match(list, /e\.status === 'published' && !e\.is_hidden && new Date\(e\.starts_at\) > now/,
      'and the list beneath it must require exactly the same');
    assert.doesNotMatch(list, /new Date\(e\.ends_at \?\? e\.starts_at\) >= now/,
      'the date-only filter is what caused the contradiction');
  });

  test('the supporting fact comes from the same filtered list', () => {
    assert.match(raw(), /fact=\{bizEvents\.length > 0/);
    assert.match(raw(), /bizEvents\[0\]\.starts_at/);
  });
});

describe('one compact card per outcome, and no repeats beneath it', () => {
  test('exactly five outcome cards render', () => {
    const n = (raw().match(/<OutcomeCard/g) ?? []).length;
    assert.equal(n, 5, 'five outcomes, five cards');
  });

  test('the old full-size feature cards are gone from Home', () => {
    const src = raw();
    const your = src.slice(src.indexOf('>Your business<'), src.indexOf('>Money<'));
    for (const gone of ['cardTitle}>Products<', 'cardTitle}>Bookings<',
                        'cardTitle}>Offers<', 'cardTitle}>Loyalty programme<',
                        'cardTitle}>Events<']) {
      assert.ok(!your.includes(gone), `${gone} must not be repeated beneath its outcome`);
    }
    assert.doesNotMatch(your, /styles\.card\b/, 'no nested feature cards inside an outcome');
  });

  test('every destination those cards used is still reachable', () => {
    for (const r of ['/business-products', '/business-orders', '/local-book-units',
                     '/local-book-services', '/local-book-schedule', '/local-book-bookings',
                     '/event-manage', '/event-create', '/event-scanner',
                     '/local-offer-new', '/local-business-detail', '/local-business-register']) {
      assert.match(raw(), new RegExp(`'${r}'`), `${r} must stay reachable`);
    }
  });

  test('the controls that had nowhere else to live are still on Home', () => {
    const src = raw();
    assert.match(src, /onValueChange=\{toggleAcceptsBookings\}/, 'the bookings switch');
    assert.match(src, /onPress=\{stopLoyalty\}/, 'stopping a running programme');
    assert.match(src, /deactivateOffer\(o\.id\)/, 'ending a live offer');
    assert.match(src, /setShowLoyaltyModal\(true\)/, 'editing the programme');
  });

  test('an unused capability stays calm — no purple set-up wall', () => {
    const src = raw();
    const your = src.slice(src.indexOf('>Your business<'), src.indexOf('>Money<'));
    assert.doesNotMatch(your, /Not set up yet|No offers yet/,
      'the outcome line already carries that state');
    assert.doesNotMatch(your, /upgradeBtn/, 'no large call-to-action buttons among the outcomes');
  });
});

describe('the rest of Home is navigation and status, not the managers', () => {
  test('urgent alerts is collapsed on Home', () => {
    const src = raw();
    assert.match(src, /const \[open, setOpen\] = useState\(false\);/);
    assert.match(src, /\{!open && \(/);
    assert.match(src, /Send an urgent alert|Manage alerts/);
    assert.match(src, /\{open && \(<>/, 'the composer and access request open on a tap');
  });

  test('nothing about alerts was removed', () => {
    const src = raw();
    for (const keep of ['onRequestAccess', 'onSendAlert', 'onCancelAlert', 'onAcceptPolicy']) {
      assert.ok(src.includes(keep), `${keep} must survive`);
    }
  });

  test('Counter keeps its richer treatment', () => {
    const src = raw();
    const counter = src.slice(src.indexOf('>At the counter<'), src.indexOf('>Your business<'));
    for (const r of ['/local-counter', '/local-till', '/local-verify']) {
      assert.ok(counter.includes(r), `${r} stays in the counter block`);
    }
    assert.ok(src.indexOf('>At the counter<') < src.indexOf('>Your business<'),
      'and it stays above the outcomes');
  });
});

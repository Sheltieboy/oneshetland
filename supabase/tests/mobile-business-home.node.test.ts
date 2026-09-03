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
      ['Needs you', 'Next', 'This week', 'At the counter', 'Your business',
       // Phase 3E: quiet, optional, and between the work and the layers.
       'Also possible on OneShetland', 'Money', 'Grow']);
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
    // Phase 3G moved the alerts MANAGER to /business-alerts; Home keeps a
    // status row. The section still holds the same three things.
    assert.match(grow, /Urgent alerts/);
    assert.match(grow, /'\/business-alerts'/);
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
    // Counted, not totalled. This used to assert date_only = 1 and canonical =
    // 0, which were Anderson & Co's figures on the day — and went red the
    // moment a legitimate new event was published there. The contradiction is
    // a RELATIONSHIP: some event is found by the date alone and not by the
    // canonical rule. That stays true however many events exist.
    const [row] = sql(`
      select
        count(*) filter (where e.starts_at > now()
                           and (e.status <> 'published' or e.is_hidden))  as hidden_but_future,
        count(*) filter (where e.starts_at > now())                       as date_only,
        count(*) filter (where e.status = 'published' and not e.is_hidden
                           and e.starts_at > now())                       as canonical
      from public.events e join public.local_businesses b
        on b.id = e.organiser_business_id
      where b.name = 'Anderson & Co';`);
    const dateOnly = Number(row.date_only);
    const canonical = Number(row.canonical);
    const contradictory = Number(row.hidden_but_future);
    assert.ok(contradictory > 0,
      'no cancelled-or-hidden future event remains at Anderson & Co, so this test can no longer reproduce anything');
    assert.equal(dateOnly - canonical, contradictory,
      'the two filters no longer differ by exactly the events the canonical rule excludes');
    assert.ok(dateOnly > canonical,
      'a date-only filter must still over-count, or there is no contradiction to fix');
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
  // Phase 3D collapsed the alerts card on Home because its compose and
  // access-request flows existed nowhere else. Phase 3G moved them to
  // /business-alerts, so Home now shows a row and the collapse is gone with the
  // card. What still has to hold is that nothing was lost on the way.
  test('urgent alerts is a status row on Home, not a manager', () => {
    const src = raw();
    assert.doesNotMatch(src, /<AlertsCard|function AlertsCard/);
    const grow = src.slice(src.indexOf('>Grow<'));
    assert.match(grow, /Urgent alerts/);
    assert.match(grow, /'\/business-alerts'/);
  });

  test('nothing about alerts was removed', () => {
    const card = read('components/business/UrgentAlertsCard.tsx');
    for (const keep of ['onRequestAccess', 'onSendAlert', 'onCancelAlert', 'onAcceptPolicy']) {
      assert.ok(card.includes(keep), `${keep} must survive at the destination`);
    }
    assert.match(read('app/business-alerts.tsx'), /UrgentAlertsCard/);
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

/* ── 7. Phase 3E — the discovery shelf ────────────────────────────────────── */

describe('also possible on OneShetland', () => {
  const src = () => raw();
  /* The rule as the screen expresses it, exercised against the real helpers:
     a capability is discovery only in the canonical never-configured state, and
     the shelf waits until the listing is genuinely good. */
  const GOOD = { phone: '01595', lat: 60.15, lng: -1.15, description: 'x',
                 logo_url: 'u', opening_hours: { mon: '9-5' } as never };
  const READY = { phone: '01595', lat: 60.15, lng: -1.15 };
  const shelfFor = (business: Record<string, unknown>, data: OutcomeData) => {
    const o = businessOutcomes({ ...business, id: 'b', slug: 's' } as never, data, '');
    const discovery = [1, 2, 3, 4].filter((i) => o[i].state === 'available');
    return { show: o[0].state === 'good' && discovery.length > 0, discovery, outcomes: o };
  };

  test('1. nothing while Be found is incomplete', () =>
    assert.equal(shelfFor({}, NONE).show, false));

  test('2. nothing while Be found is only ready', () =>
    assert.equal(shelfFor(READY, NONE).show, false));

  test('3. it appears once Be found is good and something is unused', () => {
    const r = shelfFor(GOOD, NONE);
    assert.equal(r.show, true);
    assert.deepEqual(r.discovery, [1, 2, 3, 4]);
  });

  test('4 & 9. only the canonical never-used state qualifies, and never twice', () => {
    // Products saved but unpublished is real work, not discovery.
    const r = shelfFor(GOOD, d({ products: 3, meetsPremium: true }));
    assert.deepEqual(r.discovery, [2, 3, 4]);
    assert.equal(r.outcomes[1].state, 'saved');
    // A capability is either working or discoverable. This used to pin the
    // expression that coupled isWorking to showDiscovery — which was the bug —
    // so it now pins the corrected separation, and the executed screen tests
    // below prove the behaviour rather than the wording.
    assert.match(src(), /const isWorking = \(i: number\) => !!outcomes\[i\] && outcomes\[i\]\.state !== 'available';/);
  });

  test('an unreadable capability is not discovery — we do not know it is unused', () =>
    assert.equal(shelfFor(GOOD, d({ products: null })).discovery.includes(1), false));

  test('the screen selects on exactly the canonical never-used state', () => {
    // Without this the tests above only prove the RULE, not that the dashboard
    // implements it — a mutation loosening the predicate to `!== 'live'` would
    // move saved, setup and unknown capabilities into discovery unnoticed.
    assert.match(code(DASH), /outcomes\[i\]\?\.state === 'available'/,
      'discovery must select the canonical never-configured state, and only that');
    assert.match(code(DASH), /const showDiscovery = outcomes\[0\]\?\.state === 'good' && discovery\.length > 0;/,
      'and it must wait for a genuinely good listing');
  });

  test('5. configured Sell stays a working outcome', () => {
    const r = shelfFor(GOOD, d({ products: 2, productsActive: 2, meetsPremium: true }));
    assert.equal(r.outcomes[1].state, 'live');
    assert.equal(r.discovery.includes(1), false);
  });

  test('6. configured Bookings stays a working outcome', () => {
    const r = shelfFor(GOOD, d({ services: 1, meetsPro: true }));
    assert.equal(r.outcomes[2].state, 'setup');
    assert.equal(r.discovery.includes(2), false);
  });

  test('7. past-only Events stays a working outcome', () => {
    const r = shelfFor(GOOD, d({ events: 4, eventsUpcoming: 0 }));
    assert.equal(r.outcomes[3].state, 'none_upcoming');
    assert.equal(r.discovery.includes(3), false);
  });

  test('8. an inactive offer keeps Retention a working outcome', () => {
    const r = shelfFor(GOOD, d({ offers: 1, offersLive: 0, meetsPro: true }));
    assert.equal(r.outcomes[4].state, 'saved');
    assert.equal(r.discovery.includes(4), false);
  });

  test('10. the shelf disappears once all four have been used', () => {
    const r = shelfFor(GOOD, d({ products: 1, services: 1, events: 1, loyalty: 1, meetsPro: true }));
    assert.deepEqual(r.discovery, []);
    assert.equal(r.show, false);
  });

  test('11 & 12. only the four capabilities are ever discoverable', () => {
    // Be found is index 0 and is never in the list the screen builds from.
    assert.match(src(), /const DISCOVERABLE = \[1, 2, 3, 4\] as const;/);
    const items = src().slice(src().indexOf('DISCOVERY_ITEMS'), src().indexOf('const editBusiness'));
    for (const never of ['Be found', 'Money', 'Grow', 'Counter', 'Jobs', 'Job leads', 'Analytics',
                         'Boost', 'Urgent alerts', 'Wallet', 'transactions']) {
      assert.ok(!items.includes(never), `${never} must never be discovery`);
    }
  });

  test('13. it does not nag, badge or score', () => {
    // Comments stripped: the shelf's own comment explains that it carries no
    // dot, badge or count, which would otherwise trip this.
    const s2 = code(DASH);
    const shelf = s2.slice(s2.indexOf('Also possible on OneShetland'), s2.indexOf('>Money<'));
    for (const word of ['Upgrade', 'upgrade', 'Unlock', 'unlock', 'incomplete', 'Not set up',
                        'recommended', 'complete', '%']) {
      assert.ok(!shelf.includes(word), `discovery must not say "${word}"`);
    }
    for (const ornament of ['outcomeDot', 'tone ===', 'badge', 'attentionCard']) {
      assert.ok(!shelf.includes(ornament), `discovery must not carry ${ornament}`);
    }
  });

  test('14. the plan facts are right, and are facts', () => {
    const items = src().slice(src().indexOf('DISCOVERY_ITEMS'), src().indexOf('const editBusiness'));
    for (const [title, plan] of [['Sell things', 'Premium'], ['Take bookings', 'Pro'],
                                 ['Run events', 'Free'], ['Keep customers coming back', 'Pro']]) {
      const line = items.split('\n').find((l) => l.includes(`'${title}'`)) ?? '';
      assert.match(line, new RegExp(`plan: '${plan}'`), `${title} is ${plan}`);
    }
    // The shelf must not consult what the owner is paying for.
    const decide = src().slice(src().indexOf('const DISCOVERABLE'), src().indexOf('const editBusiness'));
    assert.doesNotMatch(decide, /subscription_tier|eff\.pro|eff\.premium/,
      'discovery is not entitlement enforcement');
  });

  test('15. every entry action is an existing route that begins setup', () => {
    const items = src().slice(src().indexOf('DISCOVERY_ITEMS'), src().indexOf('const editBusiness'));
    for (const r of ['/business-products', '/local-book-services', '/event-create', '/local-offer-new']) {
      assert.ok(items.includes(`'${r}'`), `${r} must be the way in`);
    }
    // One way in each, not a menu.
    assert.equal((items.match(/router\.push/g) ?? []).length, 4);
  });

  test('16. the Phase 3D controls and destinations are untouched', () => {
    const s2 = src();
    for (const keep of ['onValueChange={toggleAcceptsBookings}', 'onPress={stopLoyalty}',
                        'deactivateOffer(o.id)', 'setShowLoyaltyModal(true)',
                        '/local-counter', '/local-till', '/local-verify']) {
      assert.ok(s2.includes(keep), `${keep} must survive`);
    }
    assert.equal((s2.match(/<OutcomeCard/g) ?? []).length, 5, 'still five outcome cards');
  });
});

/* ── 8. The screen's own logic, executed ──────────────────────────────────── */

describe('what the dashboard actually renders', () => {
  /**
   * The Phase 3E tests above proved the RULE and then asserted the scenarios
   * from a reimplementation of it. That is how a real contradiction survived
   * review: isWorking was coupled to showDiscovery, so with the shelf hidden
   * the exclusion switched off and all four never-used cards came back — the
   * exact wall the phase existed to remove — while the tests, which never
   * touched isWorking, stayed green.
   *
   * So these lift the three expressions out of the source and run them. A
   * mutation to the screen changes what executes here.
   */
  function screenLogic() {
    const src = read(DASH);
    const grab = (re: RegExp, what: string) => {
      const m = re.exec(src);
      assert.ok(m, `could not find ${what} in ${DASH} — the test must follow the screen`);
      return m[1];
    };
    const discoverable = grab(/const DISCOVERABLE = (\[[^\]]*\])/, 'DISCOVERABLE');
    const discoveryExpr = grab(/const discovery = home\s*\n\s*\?\s*([\s\S]*?)\n\s*: \[\];/, 'discovery');
    const showExpr = grab(/const showDiscovery = ([^;]+);/, 'showDiscovery');
    const workingExpr = grab(/const isWorking = \(i: number\) => ([^;]+);/, 'isWorking');

    return (outcomes: { state: string }[]) => {
      const body = `
        const DISCOVERABLE = ${discoverable};
        const home = true;
        const discovery = ${discoveryExpr.replace(/ as const/g, '')};
        const showDiscovery = ${showExpr};
        const isWorking = (i) => ${workingExpr.replace(/ as 1/g, '')};
        return { discovery, showDiscovery, working: [0,1,2,3,4].filter(isWorking) };
      `;
      return new Function('outcomes', body)(outcomes) as
        { discovery: number[]; showDiscovery: boolean; working: number[] };
    };
  }

  const run = screenLogic();
  const scene = (found: string, rest: string[]) =>
    run([{ state: found }, ...rest.map((state) => ({ state }))]);
  const FOUR_UNUSED = ['available', 'available', 'available', 'available'];

  test('1. incomplete + four never used → Be found alone, no shelf', () => {
    const r = scene('incomplete', FOUR_UNUSED);
    assert.deepEqual(r.working, [0], 'only Be found may render as a working card');
    assert.equal(r.showDiscovery, false, 'and the shelf waits');
  });

  test('2. ready + four never used → Be found alone, no shelf', () => {
    const r = scene('ready', FOUR_UNUSED);
    assert.deepEqual(r.working, [0]);
    assert.equal(r.showDiscovery, false, 'ready is not good enough');
  });

  test('3. good + four never used → Be found working, four in discovery', () => {
    const r = scene('good', FOUR_UNUSED);
    assert.deepEqual(r.working, [0]);
    assert.equal(r.showDiscovery, true);
    assert.deepEqual(r.discovery, [1, 2, 3, 4]);
  });

  test('4. a configured capability stays working, whatever Be found says', () => {
    for (const found of ['incomplete', 'ready', 'good']) {
      const r = scene(found, ['saved', 'available', 'available', 'available']);
      assert.ok(r.working.includes(1), `Sell must stay working when Be found is ${found}`);
      assert.equal(r.discovery.includes(1), false, 'and never be discovery');
    }
  });

  test('5. history-bearing states stay working too', () => {
    const r = scene('good', ['live', 'setup', 'none_upcoming', 'saved']);
    assert.deepEqual(r.working, [0, 1, 2, 3, 4]);
    assert.deepEqual(r.discovery, []);
    assert.equal(r.showDiscovery, false, 'nothing left to discover');
  });

  test('6. unknown is never discovery, and is not hidden from the working area', () => {
    const r = scene('good', ['unknown', 'available', 'available', 'available']);
    assert.ok(r.working.includes(1), 'a read we could not make still shows its row');
    assert.equal(r.discovery.includes(1), false, 'and is no evidence it was never used');
  });

  test('nothing is ever in both places', () => {
    for (const found of ['incomplete', 'ready', 'good']) {
      for (const combo of [FOUR_UNUSED, ['saved', 'available', 'live', 'unknown'],
                           ['live', 'live', 'live', 'live']]) {
        const r = scene(found, combo);
        for (const i of r.discovery) {
          assert.equal(r.working.includes(i), false, `${i} in both, with Be found ${found}`);
        }
      }
    }
  });
});

/* ── 9. Phase 3G — Money and Grow are supporting layers ──────────────────── */

describe('money is a utility strip, not a manager', () => {
  const money = () => { const s = raw(); return s.slice(s.indexOf('>Money<'), s.indexOf('>Grow<')); };

  test('Counter is still not duplicated here', () =>
    assert.doesNotMatch(money(), /local-counter|local-till|local-verify/));

  test('billing stays reachable on any plan', () => {
    const lines = code(DASH).split('\n');
    const btn = lines.findIndex((l, i) => l.includes('onPress={openBillingPortal}') &&
      lines.slice(Math.max(0, i - 3), i).some((x) => x.includes('styles.manageBtn')));
    assert.ok(btn > -1);
    const wrapper = [...lines.slice(0, btn)].reverse().find((l) => /&& \(\s*$/.test(l)) ?? '';
    assert.match(wrapper, /\{true && \(/, 'no plan check in front of the plans screen');
  });

  test('the plan card is collapsed by default', () =>
    assert.match(code(DASH), /useState<\{ pay: boolean; plan: boolean; nfc: boolean; wallet: boolean \}>\(\{ pay: false, plan: false, nfc: false, wallet: false \}\)/));

  test('wallet keeps its switch, and cashback moves behind a setting', () => {
    const m = money();
    assert.match(m, /onValueChange=\{toggleAcceptWallet\}/, 'the switch stays on Home');
    assert.match(m, /Wallet settings/);
    assert.match(m, /\{expanded\.wallet && \(/, 'cashback is behind the disclosure');
    // Home is the only owner UI for cashback, so it must still be reachable.
    assert.match(m, /updateCashback\(pct\)/);
    assert.match(m, /\[0, 2, 5, 10\]\.map/);
  });

  test('Phase 3B wallet rules are untouched', () => {
    const d = code(DASH);
    assert.match(d, /if \(value && !eff\.pro\) \{[\s\S]{0,200}Wallet payments need Pro/);
    assert.match(d, /\{walletReceipts\.length > 0 && \(/, 'history survives a downgrade');
    assert.doesNotMatch(d, /local_wallet_balances|balance_pence/, 'customer money is not business money');
  });

  test('Stripe connection and transactions are unchanged routes', () => {
    const m = money();
    assert.match(m, /handleConnectStripe/);
    assert.match(m, /'\/local-business-transactions'/);
    assert.match(m, /styles\.utilityRow/, 'transactions is a row now, not a card');
  });
});

describe('grow is compact, and holds no manager', () => {
  const grow = () => { const s = raw(); return s.slice(s.indexOf('>Grow<'), s.indexOf('orphanedShiftCount > 0')); };

  test('analytics is still one row to its own screen', () =>
    assert.match(grow(), /'\/local-business-analytics'/));

  test('urgent alerts is a status row that navigates away', () => {
    const g = grow();
    assert.match(g, /Urgent alerts/);
    assert.match(g, /styles\.utilityRow/);
    assert.match(g, /'\/business-alerts'/);
    assert.match(g, /Request access to broadcast urgent messages|Approved|Request under review/);
  });

  test('the manager itself is no longer on Home', () => {
    const d = raw();
    for (const gone of ['<AlertsCard', 'function AlertsCard', 'alertStyles',
                        'onRequestAccess', 'onSendAlert', 'onAcceptPolicy',
                        'showDatePicker', 'DURATION_OPTIONS']) {
      assert.ok(!d.includes(gone), `${gone} belongs to the alerts screen now`);
    }
  });

  test('and all of it lives at the destination', () => {
    const card = read('components/business/UrgentAlertsCard.tsx');
    for (const keep of ['requestAlertAccess', 'sendAlert', 'cancelAlert', 'acceptAlertPolicy',
                        'DURATION_OPTIONS', 'showDatePicker', 'DateTimePicker']) {
      assert.ok(card.includes(keep), `${keep} must have moved, not vanished`);
    }
    assert.match(read('app/business-alerts.tsx'), /<UrgentAlertsCard business=\{\{ id: String\(businessId\)/);
    // It feeds itself now, which is why it can live anywhere.
    assert.match(card, /fetchMyAlertAccess\(business\.id\)/);
    assert.match(card, /export function UrgentAlertsCard\(\{ business \}/);
  });

  test('the approval model was not touched', () => {
    const card = read('components/business/UrgentAlertsCard.tsx');
    assert.match(card, /access\?\.status/, 'the same access states drive the same branches');
    assert.doesNotMatch(card, /is_admin|service_role|rpc\('/, 'no new privilege path');
  });

  test('Boost was given no invented route', () => {
    const g = grow();
    assert.doesNotMatch(g, /'\/boost'|boost-manage|BoostManager/);
    assert.match(raw(), /isOnBoost\(activeBusiness\)/, 'it stays where it actually is, on the plan');
  });
});

describe('the rest of Home did not move', () => {
  test('outcomes, discovery and the spine are all still there', () => {
    const d = raw();
    assert.equal((d.match(/<OutcomeCard/g) ?? []).length, 5);
    assert.match(d, /Also possible on OneShetland/);
    const headers = [...d.matchAll(/groupHeader}>([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(headers,
      ['Needs you', 'Next', 'This week', 'At the counter', 'Your business',
       'Also possible on OneShetland', 'Money', 'Grow']);
  });
});

/**
 * business-outcomes.node.test.ts — Business Home, Phase 2B.
 *
 * The five owner outcomes, imported and run for real. The rule these mostly
 * exist to hold: LIVE means live TO A CUSTOMER. A product flagged active on a
 * business whose Premium lapsed is hidden by the read policy, so Home calling
 * it live would have the owner's dashboard contradict the owner's own listing.
 * Effective entitlement decides, never the configured tier.
 *
 * The second rule: a failed read is not a zero. "No products" and "we could not
 * find out" look identical to an owner and must not be produced by the same
 * code path.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  businessOutcomes, sellOutcome, bookingsOutcome, eventsOutcome, retentionOutcome, foundOutcome,
  type OutcomeData,
} from '../../../oneshetland-web/lib/business-outcomes.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (p: string) => readWeb(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BASE = '/business/b1/manage';
const NONE: OutcomeData = {
  products: 0, productsActive: 0, passes: 0, passesActive: 0,
  services: 0, availability: 0, events: 0, eventsUpcoming: 0,
  offers: 0, offersLive: 0, loyalty: 0, loyaltyActive: 0,
  meetsPro: false, meetsPremium: false,
};
const d = (o: Partial<OutcomeData>): OutcomeData => ({ ...NONE, ...o });

const GOOD_LISTING = {
  phone: '01595 000000', lat: 60.15, lng: -1.15, description: 'x',
  logo_url: 'u', opening_hours: { mon: '9-5' } as never,
};

/* ── Be found ─────────────────────────────────────────────────────────────── */

describe('be found', () => {
  test('READY never claims to be "Live"', () => {
    // is_active is moderation state with no owner control, so a complete-enough
    // listing is READY, not published.
    const r = foundOutcome({ phone: '01595', lat: 60.15, lng: -1.15 }, BASE, 's');
    assert.equal(r.state, 'ready');
    assert.doesNotMatch(r.status, /\blive\b/i);
    assert.match(r.status, /^Ready/);
    assert.equal(r.tone, 'neutral');
  });

  test('incomplete asks for the basics, complete is calm and positive', () => {
    assert.equal(foundOutcome({}, BASE, 's').state, 'incomplete');
    const good = foundOutcome(GOOD_LISTING, BASE, 's');
    assert.equal(good.state, 'good');
    assert.equal(good.status, 'Complete');
    assert.equal(good.tone, 'positive');
  });

  test('it counts what is left rather than scoring it', () => {
    const r = foundOutcome({ phone: '01595', lat: 60.15, lng: -1.15, description: 'x' }, BASE, 's');
    assert.match(r.status, /2 ways/);
    assert.doesNotMatch(r.status, /%/);
  });
});

/* ── Sell ─────────────────────────────────────────────────────────────────── */

describe('sell things', () => {
  test('nothing at all is available, not unfinished', () => {
    const r = sellOutcome(NONE, BASE);
    assert.equal(r.state, 'available');
    assert.equal(r.tone, 'neutral');
    assert.equal(r.status, 'Not selling on OneShetland');
  });

  test('rows but nothing flagged is saved', () => {
    const r = sellOutcome(d({ products: 3, meetsPremium: true }), BASE);
    assert.equal(r.state, 'saved');
    assert.equal(r.status, '3 items saved');
  });

  test('active plus effective Premium is live', () => {
    const r = sellOutcome(d({ products: 5, productsActive: 4, passes: 1, passesActive: 1, meetsPremium: true }), BASE);
    assert.equal(r.state, 'live');
    assert.equal(r.tone, 'positive');
    assert.equal(r.status, '5 items on sale');
  });

  test('active with LAPSED Premium is not live, and says why', () => {
    const r = sellOutcome(d({ products: 3, productsActive: 3, meetsPremium: false }), BASE);
    assert.equal(r.state, 'saved', 'the read policy hides these — calling them live would be untrue');
    assert.equal(r.tone, 'neutral');
    assert.equal(r.status, '3 items saved — Premium needed to publish');
    assert.doesNotMatch(r.status, /ready to publish/i, 'they are already flagged active');
  });

  test('one item reads as one item', () =>
    assert.match(sellOutcome(d({ products: 1, meetsPremium: true }), BASE).status, /^1 item saved/));
});

/* ── Bookings ─────────────────────────────────────────────────────────────── */

describe('take bookings', () => {
  test('no services is available', () =>
    assert.equal(bookingsOutcome(NONE, false, BASE).state, 'available'));

  test('services without availability is a real gap', () => {
    const r = bookingsOutcome(d({ services: 2, meetsPro: true }), false, BASE);
    assert.equal(r.state, 'setup');
    assert.equal(r.status, '2 services — availability not set');
  });

  test('services and availability, switch off, is ready', () => {
    const r = bookingsOutcome(d({ services: 2, availability: 6, meetsPro: true }), false, BASE);
    assert.equal(r.state, 'ready');
    assert.equal(r.status, 'Ready to switch on');
  });

  test('accepting bookings with effective Pro is live', () => {
    const r = bookingsOutcome(d({ services: 2, availability: 6, meetsPro: true }), true, BASE);
    assert.equal(r.state, 'live');
    assert.equal(r.tone, 'positive');
  });

  test('accepting bookings with LAPSED Pro is not live', () => {
    const r = bookingsOutcome(d({ services: 2, availability: 6, meetsPro: false }), true, BASE);
    assert.equal(r.state, 'saved');
    assert.equal(r.tone, 'neutral');
    assert.equal(r.status, 'Bookings setup saved — Pro needed to take bookings');
  });
});

/* ── Events ───────────────────────────────────────────────────────────────── */

describe('run events', () => {
  test('none yet', () => {
    const r = eventsOutcome(NONE, BASE);
    assert.equal(r.state, 'available');
    assert.equal(r.status, 'No events yet');
  });

  test('upcoming', () => {
    const r = eventsOutcome(d({ events: 3, eventsUpcoming: 2 }), BASE);
    assert.equal(r.state, 'upcoming');
    assert.equal(r.status, '2 upcoming events');
    assert.equal(r.tone, 'positive');
  });

  test('history but nothing planned says so plainly, with no nudge', () => {
    const r = eventsOutcome(d({ events: 4, eventsUpcoming: 0 }), BASE);
    assert.equal(r.state, 'none_upcoming');
    assert.equal(r.status, 'No upcoming events');
    assert.doesNotMatch(r.status, /you.?ve run|before|why not|again/i,
      'a business between seasons has not failed at anything');
  });

  test('events are never tier-gated', () => {
    for (const data of [NONE, d({ events: 2, eventsUpcoming: 1 })]) {
      const r = eventsOutcome(data, BASE);
      assert.doesNotMatch(`${r.status} ${r.blurb}`, /\b(Pro|Premium|plan|upgrade)\b/i);
    }
  });
});

/* ── Retention ────────────────────────────────────────────────────────────── */

describe('keep customers coming back', () => {
  test('nothing set up, on Pro, is simply nothing running', () =>
    assert.equal(retentionOutcome(d({ meetsPro: true }), BASE).status, 'Nothing running'));

  test('nothing set up, below Pro, may say so — setup itself is gated here', () => {
    const r = retentionOutcome(NONE, BASE);
    assert.equal(r.state, 'available');
    assert.equal(r.tone, 'neutral');
    assert.match(r.status, /Pro/, 'the server refuses setup, so silence would be baffling');
  });

  test('configured but not running is saved', () =>
    assert.equal(retentionOutcome(d({ offers: 2, loyalty: 1, meetsPro: true }), BASE).state, 'saved'));

  test('active plus effective Pro is live', () => {
    const r = retentionOutcome(d({ offers: 1, offersLive: 1, meetsPro: true }), BASE);
    assert.equal(r.state, 'live');
    assert.equal(r.status, '1 thing running');
  });

  test('active with LAPSED Pro is not live', () => {
    const r = retentionOutcome(d({ offers: 1, offersLive: 1, loyalty: 1, loyaltyActive: 1, meetsPro: false }), BASE);
    assert.equal(r.state, 'saved');
    assert.equal(r.status, 'Set up — Pro needed to run it');
  });
});

/* ── A failed read is not a zero ──────────────────────────────────────────── */

describe('an unreadable count does not become a confident nothing', () => {
  test('each outcome degrades to unknown rather than lying', () => {
    const cases: [string, OutcomeData][] = [
      ['sell', d({ products: null })],
      ['bookings', d({ services: null })],
      ['events', d({ events: null })],
      ['retention', d({ offers: null })],
    ];
    const run = { sell: sellOutcome, bookings: (x: OutcomeData) => bookingsOutcome(x, false, BASE),
                  events: eventsOutcome, retention: retentionOutcome } as const;
    for (const [key, data] of cases) {
      const fn = run[key as keyof typeof run] as (x: OutcomeData, b?: string) => ReturnType<typeof sellOutcome>;
      const r = fn(data, BASE);
      assert.equal(r.state, 'unknown', key);
      assert.equal(r.status, "Couldn't load this just now", key);
      assert.equal(r.tone, 'neutral', key);
      assert.doesNotMatch(r.status, /^(No |Not |0 )/, `${key} must not read as a proved zero`);
      assert.ok(r.primary.href, 'navigation survives a failed read');
    }
  });

  test('an unreadable tier does not promote anything to live', () => {
    assert.equal(sellOutcome(d({ products: 1, productsActive: 1, meetsPremium: null }), BASE).state, 'unknown');
    assert.equal(bookingsOutcome(d({ services: 1, availability: 1, meetsPro: null }), true, BASE).state, 'unknown');
  });

  test('the loader turns a rejected read into null, not zero', () => {
    const src = code('lib/business-dashboard.server.ts');
    assert.match(src, /r\.status === "fulfilled" && !r\.value\.error \? \(r\.value\.count \?\? 0\) : null/);
    assert.match(src, /Promise\.allSettled/);
  });
});

/* ── The five, and the shape of Home ──────────────────────────────────────── */

describe('the Home itself', () => {
  const page = readWeb('app/business/[id]/manage/page.tsx');
  const pageCode = code('app/business/[id]/manage/page.tsx');

  test('exactly five outcomes, in a fixed order', () => {
    const list = businessOutcomes({ ...GOOD_LISTING, id: 'b1', slug: 's', accepts_bookings: false }, NONE, BASE);
    assert.deepEqual(list.map((o) => o.key), ['found', 'sell', 'bookings', 'events', 'retention']);
    assert.doesNotMatch(code('lib/business-outcomes.ts'), /\.sort\(/, 'the order must never depend on state');
  });

  test('the old tile wall and its upgrade banner are gone', () => {
    for (const gone of ['GROUP_ORDER', 'const tiles', 'tierUnlocks', 'Unlock more with Pro', 'Go Premium for the full toolkit']) {
      assert.ok(!pageCode.includes(gone), `${gone} must not survive`);
    }
    assert.doesNotMatch(pageCode, /opacity-60/, 'no grey locked tiles');
  });

  test('configured tier no longer drives Home presentation', () => {
    // TIER_LABELS still names the plan in the header, which is a fact, not a gate.
    assert.doesNotMatch(pageCode, /tierMeets|tierUnlocks|tierFor/);
    assert.match(pageCode, /reads\.meetsPro === true/, 'wallet uses the effective answer');
  });

  test('Jobs, Shifts and Job leads are not business capabilities', () => {
    for (const w of ['/jobs', '/shifts', '/leads']) {
      assert.ok(!pageCode.includes(`${w}\``) && !pageCode.includes(`"${w}"`), `${w} must not be a Home tile`);
    }
    // ...but Work attention still reaches them through the spine, untouched.
    const top = readWeb('components/business/DashboardTop.tsx');
    assert.match(top, /\$\{base\}\/jobs/);
    assert.match(top, /\$\{base\}\/leads/);
  });

  test('Urgent alerts sits under Grow, and Counter is not duplicated under Money', () => {
    const grow = page.slice(page.indexOf('>Grow<'), page.indexOf('>Grow<') + 900);
    assert.match(grow, /Urgent alerts/);
    assert.match(grow, /\/alerts/);
    const money = page.slice(page.indexOf('>Money<'), page.indexOf('>Grow<'));
    assert.doesNotMatch(money, /counter/i, 'Counter keeps its prominent spot at the top');
    assert.match(readWeb('components/business/DashboardTop.tsx'), /Open counter mode/);
  });

  test('Boost points at where Boost actually is', () => {
    // BoostCheckout is rendered by BillingManager, so /billing is its real home.
    assert.match(readWeb('components/business/BillingManager.tsx'), /BoostCheckout/);
    const grow = page.slice(page.indexOf('>Grow<'), page.indexOf('>Grow<') + 900);
    assert.match(grow, /label="Boost" href=\{`\$\{base\}\/billing`\}/);
  });

  test('payout status is omitted rather than guessed', () => {
    assert.match(pageCode, /reads\.payoutReady === null \? null/);
    const loader = code('lib/business-dashboard.server.ts');
    assert.match(loader, /use_business_payout/, 'both payout routes must be consulted');
    assert.match(loader, /business_stripe_payouts_enabled/);
    assert.match(loader, /business_private_fields/);
  });

  test('the spine above is untouched', () => {
    for (const keep of ['DashboardTop', 'AvailabilityChip', 'next={next}', 'listingDone={listingDone}']) {
      assert.ok(page.includes(keep), `${keep} must survive`);
    }
  });

  test('no discovery shelf, no stored capability state', () => {
    assert.doesNotMatch(pageCode, /Also possible on OneShetland/);
    for (const p of ['lib/business-intent.ts', 'lib/business-capabilities.ts']) {
      assert.equal(existsSync(join(WEB, p)), false, `${p} belongs to a later phase`);
    }
    assert.doesNotMatch(code('lib/business-outcomes.ts'), /insert|upsert|localStorage|dismiss/i);
  });

  test('unused outcomes are never coloured as warnings', () => {
    const list = businessOutcomes({ id: 'b1', slug: 's' }, NONE, BASE);
    for (const o of list) assert.notEqual(o.tone, 'warning');
    assert.doesNotMatch(code('components/business/OutcomeRow.tsx'), /amber|warning/i);
  });
});

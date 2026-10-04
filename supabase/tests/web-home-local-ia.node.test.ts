/**
 * web-home-local-ia.node.test.ts — the launch information architecture of Web Home and Web Local.
 *
 * Home answers "what matters across Shetland right now": it curates, it does not catalogue. Local is "Shetland's
 * trading community — businesses and what they offer", not a second home page. Both hide any module that has
 * nothing genuine to show, so neither promises what it cannot deliver.
 *
 * Pure decisions are executed; page composition is asserted from source (comments stripped).
 * Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'app/page.tsx'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const code = (rel: string) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const web = (rel: string) => loadModule(`../oneshetland-web/${rel}`, {
  './supabase/public': { publicClient: () => ({}) },
  './shetland-today': { describeWeather: (c: number | null) => ({ label: c === 3 ? 'Overcast' : 'Clear' }) },
});

const NOW = new Date('2026-10-04T12:00:00Z');
const biz = (o: Record<string, unknown>) => ({
  id: String(o.name), name: 'X', category: 'retail', description: null, logo_url: null, cover_url: null, slug: null,
  subscription_tier: 'free', subscription_until: null, is_claimed: false, is_verified: false, address: 'Lerwick', phone: null,
  website: null, created_at: '2026-01-01T00:00:00Z', ...o,
});

describe('Open for business — genuine businesses, not "newest 20"', opts, () => {
  const { rankBusinesses } = web('lib/curated-businesses.ts');
  test('THE DEFECT: lighthouses, memorials and other points of interest never appear', () => {
    const out = rankBusinesses([
      biz({ name: 'Skroo North Lighthouse', category: 'tourism' }), biz({ name: 'Kantonella Memorial', category: 'tourism' }),
      biz({ name: 'Somewhere', category: 'other' }), biz({ name: 'Harbour Café', category: 'food_drink' }),
    ], NOW, 8);
    assert.deepEqual(out.map((b: { name: string }) => b.name), ['Harbour Café']);
  });
  test('commercial categories only: food & drink, retail, services, accommodation', () => {
    const cats = ['food_drink', 'retail', 'services', 'accommodation'];
    const out = rankBusinesses(cats.map((c, i) => biz({ name: `B${i}`, category: c })), NOW, 8);
    assert.equal(out.length, 4);
  });
  test('a paying plan sorts first, then effort: claimed and complete, then a logo, then a bare import', () => {
    const out = rankBusinesses([
      biz({ name: 'Bare Import' }),
      biz({ name: 'Logo Only', logo_url: 'x' }),
      biz({ name: 'Claimed And Complete', is_claimed: true, logo_url: 'x', cover_url: 'y', description: 'A proper description of what this business does for Shetland.', phone: '1', website: 'w' }),
      biz({ name: 'Paying Pro', subscription_tier: 'pro', subscription_until: '2027-01-01T00:00:00Z' }),
    ], NOW, 8).map((b: { name: string }) => b.name);
    assert.equal(out[0], 'Paying Pro');
    assert.ok(out.indexOf('Claimed And Complete') < out.indexOf('Logo Only'));
    assert.ok(out.indexOf('Logo Only') < out.indexOf('Bare Import'));
  });
  test('an expired plan earns no ranking credit', () => {
    const out = rankBusinesses([biz({ name: 'Lapsed', subscription_tier: 'premium', subscription_until: '2026-01-01T00:00:00Z' }), biz({ name: 'Claimed', is_claimed: true })], NOW, 8);
    assert.equal(out[0].name, 'Claimed');
  });
  test('one card per trading name, however the directory spells it', () => {
    const out = rankBusinesses([biz({ name: "Peerie Shop Cafe", id: 'a' }), biz({ name: "Peerie  Shop café", id: 'b', logo_url: 'x' }), biz({ name: 'peerie shop cafe!', id: 'c' })], NOW, 8);
    assert.equal(out.length, 2);   // "café" has a different letter; the other two collapse
    assert.equal(rankBusinesses([biz({ name: 'The Dowry', id: 'a' }), biz({ name: 'the dowry', id: 'b' })], NOW, 8).length, 1);
  });
  test('the shelf is a mix: no single category fills more than half of it', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => biz({ name: `Bank ${i}`, category: 'services', is_claimed: true, logo_url: 'x' })),
      ...Array.from({ length: 3 }, (_, i) => biz({ name: `Café ${i}`, category: 'food_drink' })),
      ...Array.from({ length: 3 }, (_, i) => biz({ name: `Shop ${i}`, category: 'retail' })),
    ];
    const out = rankBusinesses(rows, NOW, 8) as { category: string }[];
    assert.equal(out.length, 8);
    assert.ok(out.filter((b) => b.category === 'services').length <= 4);
    assert.ok(out.some((b) => b.category === 'food_drink') && out.some((b) => b.category === 'retail'));
  });
  test('and it is shown as a mix: the first four cards are four different kinds when four exist', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => biz({ name: `Bank ${i}`, category: 'services', is_claimed: true })),
      biz({ name: 'Café One', category: 'food_drink' }), biz({ name: 'Shop One', category: 'retail' }), biz({ name: 'Inn One', category: 'accommodation' }),
    ];
    const first4 = (rankBusinesses(rows, NOW, 8) as { category: string }[]).slice(0, 4).map((b) => b.category);
    assert.deepEqual(new Set(first4).size, 4, first4.join());
  });
  test('THE DEFECT (found 4 Oct): the mix was lost whenever the shelf filled on the first pass — i.e. with a real directory', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => biz({ name: `Bank ${String(i).padStart(2, '0')}`, category: 'services', is_claimed: true, logo_url: 'x' })),
      ...Array.from({ length: 6 }, (_, i) => biz({ name: `Café ${i}`, category: 'food_drink', logo_url: 'x' })),
      ...Array.from({ length: 6 }, (_, i) => biz({ name: `Shop ${i}`, category: 'retail', logo_url: 'x' })),
    ];
    const out = rankBusinesses(rows, NOW, 8) as { category: string }[];
    assert.equal(out.length, 8);
    assert.deepEqual(out.slice(0, 3).map((b) => b.category), ['food_drink', 'retail', 'services'], out.map((b) => b.category).join());
  });
  test('when one category is all there is, the shelf still fills (best first)', () => {
    const rows = Array.from({ length: 12 }, (_, i) => biz({ name: `Only ${i}`, category: 'retail' }));
    assert.equal(rankBusinesses(rows, NOW, 8).length, 8);
  });
  test('the limit is honoured, and blank names are dropped', () => {
    const rows = Array.from({ length: 30 }, (_, i) => biz({ name: `Shop ${i}` }));
    assert.equal(rankBusinesses([...rows, biz({ name: '  ' })], NOW, 8).length, 8);
  });
});

describe('notices lead somewhere real', opts, () => {
  const { noticeHref } = web('lib/home-curation.ts');
  test('THE DEFECT: every notice used to link to /local. The most specific destination now wins', () => {
    assert.equal(noticeHref({ campaign_id: 'c1', event_id: 'e1', hub: { slug: 'h' } }), '/hubs/campaign/c1');
    assert.equal(noticeHref({ event_id: 'e1', hub: { slug: 'h' } }), '/whats-on/e1');
    assert.equal(noticeHref({ hub: { slug: 'oneshetland', id: 'h1' } }), '/hubs/oneshetland');
    assert.equal(noticeHref({ hub: { id: 'h1' } }), '/hubs/h1');
    assert.equal(noticeHref({ business: { slug: 'harbour-cafe' } }), '/directory/harbour-cafe');
    assert.equal(noticeHref({}), '/hubs');
    assert.doesNotMatch(noticeHref({ hub: { slug: 'x' } }), /^\/local/);
  });
});

describe('ship content only when a ship is about', opts, () => {
  const { cruiseWorthShowing } = web('lib/home-curation.ts');
  test('in port today: yes. Within three days: yes. Next week: no. Nothing: no', () => {
    assert.equal(cruiseWorthShowing({ isToday: true }, NOW), true);
    assert.equal(cruiseWorthShowing({ date: '2026-10-06' }, NOW), true);
    assert.equal(cruiseWorthShowing({ date: '2026-10-12' }, NOW), false);
    assert.equal(cruiseWorthShowing({ date: '2026-09-20' }, NOW), false);
    assert.equal(cruiseWorthShowing(null, NOW), false);
  });
});

describe('Shetland Today on a phone is one useful line', opts, () => {
  const { todayStrip } = web('lib/home-curation.ts');
  test('temperature, sky and sunset; nothing when there is no data', () => {
    assert.equal(todayStrip({ place: 'Lerwick', tempC: 12.6, weatherCode: 3, sunrise: '07:17', sunset: '18:27', daylight: '11h', tideStation: null, tides: [], tidesConfigured: false }), 'Lerwick: 13° Overcast · Sunset 18:27');
    assert.equal(todayStrip(null), null);
  });
});

describe('Local\'s hero promises only what the page can show', opts, () => {
  const { localHeroCopy } = web('lib/local-copy.ts');
  test('THE DEFECT: with no genuine commerce it no longer mentions offers, cashback, experiences or bookings', () => {
    for (const areaLabel of [undefined, 'Lerwick']) {
      const t = localHeroCopy({ areaLabel, hasOffers: false, hasPasses: false, hasBookable: false });
      assert.doesNotMatch(t, /offer|cashback|experience|booking|book/i, t);
      assert.match(t, /businesses/);
    }
  });
  test('it grows with the content, and names the area', () => {
    assert.match(localHeroCopy({ hasOffers: true, hasPasses: false, hasBookable: false }), /with their offers\./);
    assert.match(localHeroCopy({ hasOffers: true, hasPasses: true, hasBookable: true }), /offers, experiences and bookings/);
    assert.match(localHeroCopy({ areaLabel: 'Unst', hasOffers: false, hasPasses: false, hasBookable: false }), /in Unst/);
  });
});

describe('Web Home — composition', opts, () => {
  const page = () => code('app/page.tsx');
  test('sections run in the approved order', () => {
    const s = page();
    const order = ['<UrgentAlertBanner', '<HeroActions', '<ShetlandTodayCard', '<PlanDayTile', '<ForYou', '<WhatsHappening', '<FindLocal', '<HiringShelf', '<LocalCommerce', '<IslandAndCommunity', '<ExploreMore']
      .map((t) => { const i = s.indexOf(t); assert.notEqual(i, -1, `${t} is missing`); return i; });
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
  test('REMOVED: the 13-tile grid, the bento, the duplicate Work/Hiring modules, the rails and the test-product rail', () => {
    const s = page();
    for (const gone of ['SectionGrid', 'HomeBento', 'FeaturedShelf', 'OffersShelf', 'ShopRails', 'IslandLifeBand', 'getHomeContent', 'fetchLeaderboardWithTrend'])
      assert.doesNotMatch(s, new RegExp(gone), gone);
    assert.equal((s.match(/<HiringShelf/g) ?? []).length, 1, 'jobs appear once');
    assert.equal((s.match(/<WhatsHappening/g) ?? []).length, 1, 'events appear once');
  });
  test('the first phone screen has real actions: What\'s On, Find a business and the Directory search', () => {
    const sec = code('components/home/HomeSections.tsx');
    assert.match(sec, /href="\/whats-on"[^>]*>\s*What&apos;s On/);
    assert.match(sec, /href="\/directory"[^>]*>\s*Find a business/);
    assert.match(sec, /<form action="\/directory" method="get" role="search"/);
    assert.match(sec, /name="q"/);
  });
  test('the weather panel steps aside on a phone for a one-line strip; the mode switch is compact and in the hero', () => {
    const s = page();
    assert.match(s, /md:hidden">\{strip\}/);
    assert.match(s, /<div className="hidden md:block"><ShetlandTodayCard/);
    assert.match(s, /<AudienceChip audience=\{audience\} compact \/>/);
  });
  test('commerce, businesses and community modules hide themselves when empty', () => {
    const sec = code('components/home/HomeSections.tsx');
    assert.match(sec, /export function LocalCommerce[\s\S]*?if \(offers\.length === 0 && products\.length === 0\) return null;/);
    assert.match(sec, /export function FindLocal[\s\S]*?if \(businesses\.length === 0\) return null;/);
    assert.match(sec, /export function WhatsHappening[\s\S]*?if \(!featured && !showCruise\) return null;/);
    assert.match(sec, /if \(!anyCulture && visibleNotices\.length === 0 && live\.length === 0\) return null;/);
  });
  test('one game promotion only (inside Island life), and no stale "Ten sections" copy anywhere', () => {
    const all = code('components/home/HomeSections.tsx') + code('components/home/Shelves.tsx') + page();
    assert.equal((all.match(/Today&apos;s game/g) ?? []).length, 1);
    assert.doesNotMatch(all, /Ten sections/);
  });
  test('"More from OneShetland" is a compact strip, not tiles with photos', () => {
    const sec = code('components/home/HomeSections.tsx');
    assert.match(sec, /More from OneShetland/);
    assert.doesNotMatch(sec.slice(sec.indexOf('export function ExploreMore')), /<Image|SafeImage|h-40/);
  });
  test('the visitor module leads for visitors; residents get a quiet offer instead', () => {
    const s = page();
    assert.match(s, /\{visiting && \(\s*<section[^>]*>\s*<PlanDayTile wide \/>/);
    assert.match(s, /\{!visiting && \(/);
  });
  test('Home\'s job source is open vacancies only', () => {
    assert.match(code('lib/home-data.ts'), /\.from\("jobs"\)\s*\.select\("id, title, location, pay_text, posted_at"\)\s*\.eq\("status", "open"\)/);
    assert.match(code('lib/home-shelves.ts'), /\.eq\("status", "open"\)/);
  });
  test('notices carry a real destination and the mobile menu reaches the notifications inbox', () => {
    assert.match(code('lib/home-data.ts'), /href: noticeHref\(/);
    assert.match(code('components/home/HomeSections.tsx'), /href=\{n\.href\}/);
    assert.match(code('components/site/SiteHeader.tsx'), /href="\/notifications"[\s\S]{0,400}Notifications/);
  });
});

describe('Web Local — composition and the zero-commerce state', opts, () => {
  const page = () => code('app/local/page.tsx');
  test('order: hero, urgent notice, Open for business, Offers, Book, Passes, Shop, Jobs, Local rewards, business CTA', () => {
    const s = page();
    const marks = ['localHeroCopy(', 'urgent.length > 0', '<FindLocal', 'id="offers"', 'id="book"', 'id="passes"', 'shopCount > 0', 'All jobs', 'One card for every shop', 'Running a business in Shetland?'];
    const at = marks.map((m) => { const i = s.indexOf(m); assert.notEqual(i, -1, `${m} is missing`); return i; });
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
  });
  test('THE DEFECT: no empty stats band, no zero-count pillars, no cashback promise, no "newest 20"', () => {
    const s = page();
    assert.match(s, /\{stats\.length > 0 && \(/);
    assert.match(s, /\{pillars\.length >= 2 && \(/);
    assert.doesNotMatch(s, /cashback/i);
    assert.doesNotMatch(s, /businesses\.map\(\(b\) =>/);
  });
  test('every commerce module — and the Shop entry — renders only for genuine items', () => {
    const s = page();
    assert.match(s, /\{hasOffers && \(\s*<section id="offers"/);
    assert.match(s, /\{hasBookable && \(\s*<section id="book"/);
    assert.match(s, /\{hasPasses && \(\s*<section id="passes"/);
    assert.match(s, /\{shopCount > 0 && \(/);
    assert.match(s, /\(jobs\.length > 0\)/);
  });
  test('hub notices are not a consumer section on Local (Home carries them); an urgent notice keeps the admin broadcast control', () => {
    const s = page();
    assert.doesNotMatch(s, /Hub notices/);
    assert.match(s, /urgent = notices\.filter\(\(n\) => n\.severity === "urgent"\)/);
    assert.match(s, /<NoticeBroadcast/);
  });
  test('Jobs: 3–4 open vacancies, same open-status rule as Home and the Jobs page', () => {
    assert.match(code('app/local/page.tsx'), /jobs\.slice\(0, 4\)/);
    assert.match(code('lib/local-data.ts'), /from\("jobs"\)\s*\.select\("id, title, location, pay_text, posted_at"\)\s*\.eq\("status", "open"\)/);
  });
  test('with no businesses in the chosen area it says so honestly and invites a listing', () => {
    assert.match(page(), /No businesses listed in \$\{areaLabel\} yet/);
    assert.match(page(), /Add a business/);
  });
});

describe('terminology', opts, () => {
  test('Jobs / Book / Local rewards on the changed surfaces; the old drift is gone', () => {
    const surfaces = code('app/page.tsx') + code('components/home/HomeSections.tsx') + code('components/home/Shelves.tsx') + code('app/local/page.tsx');
    for (const old of ['Hiring now', 'Jobs & shifts', 'Book now', 'Book in Shetland', 'Shop Local Shetland'])
      assert.doesNotMatch(surfaces, new RegExp(old), old);
    assert.match(code('lib/sections.ts'), /key: "jobs",\s*label: "Jobs"/);
    assert.match(code('components/site/SiteFooter.tsx'), />Local rewards</);
    assert.match(code('app/loyalty/page.tsx'), /Local rewards/);
  });
});

describe('phone fit — the shrinkable-column rule', opts, () => {
  // A CSS grid with no base column gets an implicit AUTO track that grows to the longest unwrapped line: the same
  // defect that made Events, Jobs and Local wider than a 375px phone. Caught here on the new What's happening grid
  // (469px wide on a 390px screen) before it shipped.
  for (const file of ['components/home/HomeSections.tsx', 'components/home/Shelves.tsx', 'app/local/page.tsx']) {
    test(`${file}: every responsive grid starts from grid-cols-1 (or an explicit base count)`, () => {
      const s = code(file);
      const grids = [...s.matchAll(/className=(?:"|\{")(grid [^"]*)"/g)].map((m) => m[1]).filter((g) => /(sm|md|lg):grid-cols-/.test(g));
      assert.ok(grids.length >= 1);
      for (const g of grids) assert.match(g, /grid grid-cols-\d/, g);
    });
  }
});

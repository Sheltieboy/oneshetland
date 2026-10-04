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

describe('Web Home — the approved V2, live', opts, () => {
  const page = () => code('app/page.tsx');
  test('sections run in the approved V2 order', () => {
    const s = page();
    const order = ['<UrgentAlertBanner', '<HeroActions', '<LivePills', '<PlanDayTile', '<ForYou', '<RightNow', '<DiscoverLocal', '<CommerceGateway', '<HomeWork', '<IslandMosaic', '<CommunityV2', '<ExploreV2']
      .map((t) => { const i = s.indexOf(t); assert.notEqual(i, -1, `${t} is missing`); return i; });
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
  test('LIVE only: no preview state, viewer, switch bar or ?work= override; shifts are always the real ones', () => {
    const s = page();
    for (const gone of ['parsePreview', 'buildCommerce', 'PreviewBar', 'parseMix', 'searchParams', 'state=seed'])
      assert.doesNotMatch(s, new RegExp(gone), gone);
    assert.match(s, /buildWork\("live", undefined, \{ jobs: mapLiveJobs\(shelves\.hiring\), shifts: await loadLiveShifts\(\) \}/);
    assert.match(s, /const commerce = mapLiveCommerce\(/);
    assert.doesNotMatch(s, /robots/, 'the live Home is indexable');
  });
  test('the old Home\'s modules are gone: no 13-tile grid, bento, duplicate Work/Hiring shelves or rails', () => {
    const s = page();
    for (const gone of ['SectionGrid', 'HomeBento', 'FeaturedShelf', 'OffersShelf', 'ShopRails', 'IslandLifeBand', 'HiringShelf', 'WhatsHappening', 'LocalCommerce', 'IslandAndCommunity'])
      assert.doesNotMatch(s, new RegExp(gone), gone);
    assert.equal((s.match(/<HomeWork/g) ?? []).length, 1, 'Work appears once');
    assert.equal((s.match(/<RightNow/g) ?? []).length, 1, 'events appear once');
  });
  test('the first phone screen has real actions: What\'s On, Find a business and the Directory search', () => {
    const sec = code('components/home/HomeSections.tsx');
    assert.match(sec, /href="\/whats-on"[^>]*>\s*What&apos;s On/);
    assert.match(sec, /href="\/directory"[^>]*>\s*Find a business/);
    assert.match(sec, /<form action="\/directory" method="get" role="search"/);
  });
  test('the visitor module leads for visitors only; the mode switch is compact and in the hero', () => {
    const s = page();
    assert.match(s, /\{visiting && <section[^>]*><PlanDayTile wide \/><\/section>\}/);
    assert.doesNotMatch(s, /\{!visiting/);
    assert.match(s, /<AudienceChip audience=\{audience\} compact \/>/);
  });
  test('personal content only where it genuinely exists: For you for a signed-in account with items', () => {
    assert.match(page(), /\{account && forYou\.length > 0 && <ForYou /);
  });
  test('Home reads only the PUBLIC client, so a fixture can never reach it', () => {
    for (const f of ['lib/home-data.ts', 'lib/home-shelves.ts', 'lib/curated-businesses.ts', 'lib/local-data.ts', 'lib/jobs-data.ts', 'lib/cruise-data.ts'])
      assert.doesNotMatch(code(f), /supabase\/server|cookies\(/, f);
  });
  test('Home\'s job source is open vacancies only', () => {
    assert.match(code('lib/home-data.ts'), /\.from\("jobs"\)\s*\.select\("id, title, location, pay_text, posted_at"\)\s*\.eq\("status", "open"\)/);
    assert.match(code('lib/home-shelves.ts'), /\.eq\("status", "open"\)/);
  });
  test('notices carry a real destination and the mobile menu reaches the notifications inbox', () => {
    assert.match(code('lib/home-data.ts'), /href: noticeHref\(/);
    assert.match(code('components/preview/v2/HomeV2.tsx'), /href=\{n\.href\}/);
    assert.match(code('components/site/SiteHeader.tsx'), /href="\/notifications"[\s\S]{0,400}Notifications/);
  });
});

describe('Web Local — the approved V2, live', opts, () => {
  const page = () => code('app/local/page.tsx');
  test('order: hero, six pillars, urgent notice, Featured locally, Shop, Offers, Book, Experiences, Rewards, Businesses, Work, business CTA', () => {
    const s = page();
    const marks = ['<LocalHero', '<SixPillars', 'urgent.length > 0', '<GoodLocally', 'pillar="shop"', 'pillar="offers"', 'pillar="book"', 'pillar="experiences"', '<RewardsPanel', '<BusinessesCurated', '<LocalWork', '<ForBusinesses'];
    const at = marks.map((m) => { const i = s.indexOf(m); assert.notEqual(i, -1, `${m} is missing`); return i; });
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
  });
  test('LIVE only: no preview state, viewer or switch bar; area chips link to /local itself; the page is indexable', () => {
    const s = page();
    for (const gone of ['parsePreview', 'buildCommerce', 'PreviewBar', 'parseMix', 'preview/local-v2'])
      assert.doesNotMatch(s, new RegExp(gone), gone);
    assert.match(s, /<LocalHero areaKey=\{areaKey\} base="\/local" \/>/);
    assert.match(s, /export const metadata = \{ title: "Local" \}/);
    assert.doesNotMatch(s, /robots/);
  });
  test('all six pillars are permanent: the gateway is built from fixed tiles, not from what happens to be in stock', () => {
    const l = code('components/preview/v2/LocalV2.tsx');
    for (const k of ['shop', 'offers', 'book', 'exp', 'biz', 'rewards']) assert.match(l, new RegExp(`key: "${k}"`), k);
    const p = page();
    for (const k of ['shop', 'offers', 'book', 'experiences']) assert.match(p, new RegExp(`<PillarBand pillar="${k}"`), k);
  });
  test('Rewards is honest: an invitation, never a made-up card, a named business or a Wallet balance', () => {
    const l = code('components/preview/v2/LocalV2.tsx');
    assert.match(l, /Collect rewards locally/);
    assert.match(l, /Find participating businesses and start earning stamps and points\./);
    assert.doesNotMatch(l, /Sample Café|5 of 8|5 \/ 8|£12\.50|3 more stamps/);
  });
  test('an urgent notice keeps the admin-only broadcast control; hub notices are not a consumer section on Local', () => {
    const s = page();
    assert.doesNotMatch(s, /Hub notices/);
    assert.match(s, /urgent = feed\.notices\.filter\(\(n\) => n\.severity === "urgent"\)/);
    assert.match(s, /\{isAdmin && <NoticeBroadcast/);
    assert.match(s, /const isAdmin = account\?\.profile\?\.role === "admin"/);
  });
  test('Experiences has a real destination: See all goes to the Experiences section of Local, not the generic directory', () => {
    const v2 = code('lib/preview-v2.ts');
    assert.match(v2, /seeAll: "\/local#experiences"/);
    assert.doesNotMatch(v2, /seeAll: "\/directory"/);
  });
  test('Jobs & shifts: real vacancies and real shifts, never padded', () => {
    assert.match(page(), /buildWork\("live", undefined, \{ jobs: mapLiveJobs\(shelves\.hiring\), shifts: await loadLiveShifts\(\) \}/);
    assert.match(code('lib/preview-work-live.ts'), /getOpenShifts\(\)\.catch\(\(\) => \[\]\)/);
  });
  test('For businesses: the call to action reaches the add-a-business form', () => {
    assert.match(code('components/preview/v2/LocalV2.tsx'), /href="\/directory\/new"[^>]*>Add your business free/);
  });
});

describe('terminology', opts, () => {
  test('Jobs / Book / Local rewards on the changed surfaces; the old drift is gone', () => {
    // Work is now deliberately "Jobs & shifts" (one proposition) on Home and Local, so that phrase is no longer drift.
    const surfaces = code('app/page.tsx') + code('app/local/page.tsx') + code('components/preview/v2/HomeV2.tsx') + code('components/preview/v2/LocalV2.tsx') + code('components/preview/v2/WorkV2.tsx') + code('lib/preview-v2.ts');
    for (const old of ['Hiring now', 'Book now', 'Book in Shetland', 'Shop Local Shetland'])
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
  for (const file of ['components/home/HomeSections.tsx', 'components/home/Shelves.tsx', 'components/preview/v2/HomeV2.tsx', 'components/preview/v2/LocalV2.tsx', 'components/preview/v2/WorkV2.tsx']) {
    test(`${file}: every responsive grid starts from grid-cols-1 (or an explicit base count)`, () => {
      const s = code(file);
      const grids = [...s.matchAll(/className=(?:"|\{")(grid [^"]*)"/g)].map((m) => m[1]).filter((g) => /(sm|md|lg):grid-cols-/.test(g));
      assert.ok(grids.length >= 1);
      for (const g of grids) assert.match(g, /grid grid-cols-\d/, g);
    });
  }
});

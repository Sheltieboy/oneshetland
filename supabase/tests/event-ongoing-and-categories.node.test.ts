/**
 * event-ongoing-and-categories.node.test.ts — Stage 4A.5A, mobile side.
 *
 * WHAT WAS WRONG
 *  1. The app's What's On list, Home strip, Local feed and business pages asked `starts_at >= now`, so an
 *     event disappeared the instant it began: a three-day festival (RIFFMAS) or a six-week exhibition
 *     (Art in Nature) was invisible for the whole time it was actually running. The website's What's On
 *     already used "not finished yet"; the app did not.
 *  2. The original events still carry the older category names ("Music & Gigs", "Family & Kids"…). The app
 *     filters by the twelve current names with an exact match, so those events could not be reached by any
 *     chip but "All"; on the web the same data would have produced duplicate chips.
 *
 * WHAT THIS EXECUTES
 * The REAL source of fetchPublishedEvents / fetchHomeEvents / fetchLocalFeed / groupEventsForManagement (via
 * _support/load-source.ts) against an in-memory Supabase fake that EXECUTES the filters those functions build and
 * mimics the row rule production has on events (signed-out and ordinary users see only non-hidden rows; admin
 * sees all). Time is frozen on day 2 of RIFFMAS. Fixtures only.
 *
 * SAFETY: no network, no Supabase project, no production access, no `supabase db query`. Fixtures only.
 *
 * Run: node --test supabase/tests/event-ongoing-and-categories.node.test.ts
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import * as currency from '../../lib/event-currency.ts';
import * as categories from '../../lib/event-categories.ts';
import * as lifecycle from '../../lib/ticket-lifecycle.ts';
// @ts-ignore — plain .mjs test helper
import fake, { setDb, setViewer } from './_support/fake-supabase.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = Date.parse('2026-12-05T12:00:00Z'); // Saturday, day 2 of RIFFMAS (GMT)

let n = 0;
const ev = (title: string, starts: string, ends: string | null, extra: Record<string, unknown> = {}) => ({
  id: `ev-${++n}`, title, category: 'Music', status: 'published', is_hidden: false, organiser_hub_id: null,
  calendar_approved: false, is_featured: false, has_tickets: false, venue: 'Somewhere', locality: 'Lerwick',
  cover_url: null, price_text: null, description: null, organiser_business_id: null,
  starts_at: starts, ends_at: ends, ...extra,
});
const FIXTURE = [
  ev('Future Gig', '2026-12-12T19:00:00Z', '2026-12-12T22:00:00Z'),
  ev("Tonight's Show", '2026-12-05T11:00:00Z', '2026-12-05T14:00:00Z'),
  ev('Last Week', '2026-11-28T19:00:00Z', '2026-11-28T22:00:00Z'),
  ev('RIFFMAS 2026', '2026-12-04T19:00:00Z', '2026-12-06T23:59:00Z'),
  ev('Art in Nature', '2026-10-24T09:00:00Z', '2026-12-20T17:00:00Z', { category: 'Arts & Culture' }),
  ev('Pop-up Market', '2026-12-06T10:00:00Z', null, { category: 'Market' }),
  ev('Old One-Day', '2026-12-01T10:00:00Z', null, { category: 'Market' }),
  ev('Started Today No End', '2026-12-05T09:00:00Z', null, { category: 'Community' }),
  ev('Legacy Gig', '2026-12-13T19:00:00Z', '2026-12-13T22:00:00Z', { category: 'Music & Gigs' }),
  ev('Legacy Kids Party', '2026-12-14T10:00:00Z', '2026-12-14T12:00:00Z', { category: 'Family & Kids' }),
  ev('Odd Category', '2026-12-15T10:00:00Z', '2026-12-15T12:00:00Z', { category: 'Zzz Mystery' }),
  ev('Draft Ongoing', '2026-12-04T19:00:00Z', '2026-12-06T23:59:00Z', { status: 'draft', is_hidden: true }),
  ev('Draft Future', '2026-12-20T19:00:00Z', '2026-12-20T22:00:00Z', { status: 'draft', is_hidden: true, organiser_business_id: 'biz-1' }),
  ev('Cancelled Ongoing', '2026-12-05T10:00:00Z', '2026-12-05T20:00:00Z', { status: 'cancelled', is_hidden: true }),
  ev('Unapproved Hub Event', '2026-12-18T19:00:00Z', '2026-12-18T22:00:00Z', { organiser_hub_id: 'hub-1', calendar_approved: false }),
  ev('Gallery Show', '2026-12-01T10:00:00Z', '2026-12-24T17:00:00Z', { organiser_business_id: 'biz-1', category: 'Arts & Culture' }),
];
const DRAFTS = ['Draft Ongoing', 'Draft Future', 'Cancelled Ongoing'];
const titles = (rows: any[]) => rows.map((r) => r.title);

let eventsApi: Record<string, any>, concierge: Record<string, any>, localApi: Record<string, any>;
before(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  setDb({ events: FIXTURE });
  const common = { './supabase': { supabase: fake, SUPABASE_URL: 'https://fixture.invalid' }, './event-currency': currency, './event-categories': categories };
  eventsApi = loadModule('lib/events-api.ts', {
    ...common, 'expo-file-system/legacy': { uploadAsync: async () => ({}) },
    './stripe-sca': { settleSavedCardPayment: async () => ({}) }, './ticket-lifecycle': lifecycle,
  });
  concierge = loadModule('lib/concierge-api.ts', { ...common, './seed-content': { todaysSpik: () => null } });
  localApi = loadModule('lib/local-api.ts', {
    ...common, './wallet-outcome': { WalletUnavailableError: class extends Error {} },
    './stripe-sca': { settleSavedCardPayment: async () => ({}) }, './retry-after': { retryAfterSecsFrom: () => null },
  }, (src) => src.replace(/^export \{[^}]*\} from '[^']+';\s*$/gm, ''));  // bare re-exports are not needed here
});
after(() => mock.timers.reset());

describe('What\'s On (app) — current means not finished', () => {
  test('future, in-progress, RIFFMAS day 2 and the long-running exhibition are listed', async () => {
    setViewer('anon');
    const t = titles(await eventsApi.fetchPublishedEvents({ limit: 100 }));
    for (const want of ['Future Gig', "Tonight's Show", 'RIFFMAS 2026', 'Art in Nature', 'Gallery Show', 'Legacy Gig']) assert.ok(t.includes(want), `${want} in ${t}`);
  });
  test('a finished event is not listed; an old no-end event never returns; a started no-end event is not invented as ongoing', async () => {
    const t = titles(await eventsApi.fetchPublishedEvents({ limit: 100 }));
    assert.ok(!t.includes('Last Week') && !t.includes('Old One-Day') && !t.includes('Started Today No End'));
    assert.ok(t.includes('Pop-up Market'), 'no end, still to come -> listed');
  });
  test('order is start time: what is on now comes before what is coming', async () => {
    const rows = await eventsApi.fetchPublishedEvents({ limit: 100 });
    const starts = rows.map((r: any) => Date.parse(r.starts_at));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
    const t = titles(rows);
    assert.ok(t.indexOf('RIFFMAS 2026') < t.indexOf('Future Gig') && t.indexOf('Art in Nature') < t.indexOf('Pop-up Market'));
  });
  test("'Today' (Shetland day) includes a festival that began earlier; excludes tomorrow", async () => {
    const t = titles(await eventsApi.fetchPublishedEvents({ to: currency.londonRangeEnd('today'), limit: 100 }));
    for (const want of ["Tonight's Show", 'RIFFMAS 2026', 'Art in Nature']) assert.ok(t.includes(want), want);
    for (const no of ['Pop-up Market', 'Future Gig']) assert.ok(!t.includes(no), no);
  });
  test('the month calendar is still a by-start-date range (explicit from)', async () => {
    const t = titles(await eventsApi.fetchPublishedEvents({ from: '2026-12-01T00:00:00Z', to: '2026-12-31T23:59:59Z', limit: 200 }));
    assert.ok(t.includes('Old One-Day') && t.includes('Last Week') === false, 'December starts only; a Nov event is not in the Dec grid');
    assert.ok(t.includes('RIFFMAS 2026') && !t.includes('Art in Nature'), 'placed by its start date');
  });
});

describe('drafts, hidden and unapproved stay private', () => {
  test('no app query returns a draft or cancelled (hidden) event, for a visitor or an ordinary signed-in user', async () => {
    for (const viewer of ['anon', 'authenticated']) {
      setViewer(viewer);
      const islandsWide = [
        ...titles(await eventsApi.fetchPublishedEvents({ limit: 100 })),
        ...titles(await eventsApi.fetchPublishedEvents({ businessId: 'biz-1', limit: 5 })),
        ...titles(await concierge.fetchHomeEvents(20)),
        ...titles((await localApi.fetchLocalFeed()).events),
      ];
      for (const d of DRAFTS) assert.ok(!islandsWide.includes(d), `${viewer}: ${d} leaked`);
      assert.ok(!islandsWide.includes('Unapproved Hub Event'));
    }
    setViewer('anon');
  });
  test('an admin can still read them (staff inspection is unaffected)', async () => {
    setViewer('admin');
    const { data } = await fake.from('events').select('*');
    for (const d of DRAFTS) assert.ok(titles(data).includes(d), d);
    setViewer('anon');
  });
});

describe('Home, Local and business pages keep running events', () => {
  test('Home strip', async () => {
    const t = titles(await concierge.fetchHomeEvents(20));
    assert.ok(t.includes('RIFFMAS 2026') && t.includes('Art in Nature') && t.includes('Future Gig'));
    assert.ok(!t.includes('Last Week') && !t.includes('Old One-Day'));
  });
  test('Local feed', async () => {
    const t = titles((await localApi.fetchLocalFeed()).events);
    assert.ok(t.includes('RIFFMAS 2026') && t.includes('Gallery Show'));
    assert.ok(!t.includes('Last Week') && !t.includes('Started Today No End'));
  });
  test("a business's page: its running gallery show, not its draft", async () => {
    assert.deepEqual(titles(await eventsApi.fetchPublishedEvents({ businessId: 'biz-1', limit: 5 })), ['Gallery Show']);
  });
});

describe('one logical category in the app', () => {
  test('selecting a current category returns the legacy-stored events too; unrelated stay apart', async () => {
    const t = titles(await eventsApi.fetchPublishedEvents({ category: 'Music', limit: 100 }));
    assert.ok(t.includes('Legacy Gig') && t.includes('Future Gig') && t.includes('RIFFMAS 2026'));
    assert.ok(!t.includes('Legacy Kids Party') && !t.includes('Art in Nature'));
    assert.deepEqual(titles(await eventsApi.fetchPublishedEvents({ category: 'Family', limit: 100 })), ['Legacy Kids Party']);
  });
  test('an unknown category does not crash and finds nothing else', async () => {
    assert.deepEqual(await eventsApi.fetchPublishedEvents({ category: 'Never Heard Of It', limit: 100 }), []);
    assert.deepEqual(titles(await eventsApi.fetchPublishedEvents({ category: 'Zzz Mystery', limit: 100 })), ['Odd Category']);
  });
  test('the app chips are the static twelve and equal the helper list', () => {
    const src = read('lib/events-api.ts');
    const form = [...src.slice(src.indexOf('export const EVENT_CATEGORIES'), src.indexOf('] as const')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...categories.CURRENT_EVENT_CATEGORIES], form);
  });
  test('legacy and current equivalents are one category; the golden mapping', () => {
    assert.equal(categories.normaliseCategory('Music & Gigs'), 'Music');
    assert.equal(categories.sameCategory('Family & Kids', 'Family'), true);
    assert.deepEqual(categories.LEGACY_CATEGORY_MAP, {
      'Art & Exhibitions': 'Arts & Culture', 'Charity & Community': 'Community', 'Cinema': 'Arts & Culture',
      'Comedy': 'Arts & Culture', 'Family & Kids': 'Family', 'Festivals & Celebrations': 'Festival',
      'Heritage & Culture': 'Arts & Culture', 'Literature': 'Arts & Culture', 'Music & Gigs': 'Music',
      'Sports & Outdoors': 'Sport', 'Theatre': 'Arts & Culture',
    });
    for (const v of [null, undefined, '', 7, {}]) assert.equal(categories.normaliseCategory(v), null);
  });
});

describe('screens use the shared rule (wiring)', () => {
  test('What\'s On tab: no starts-after-now `from`, Shetland range ends, category via helper', () => {
    const s = read('app/(tabs)/whats-on.tsx');
    assert.match(s, /londonRangeEnd\(kind\)/);
    assert.doesNotMatch(s, /const from = new Date\(\)\.toISOString\(\);\s*\n\s*const to/);
    assert.match(s, /sameCategory\(e\.category, categoryFilter\)/);
    assert.match(s, /normaliseCategory\(event\.category\)/);
  });
  test('no discovery query in the app still filters on starts_at alone', () => {
    for (const [file, bad] of [
      ['lib/events-api.ts', /q = q\.gte\('starts_at', opts\.from \?\? now\)/],
      ['lib/concierge-api.ts', /\.gte\('starts_at', new Date\(\)\.toISOString\(\)\)\s*\n\s*\.order\('is_featured'/],
      ['lib/local-api.ts', /\.gte\('starts_at', now\)\s*\n\s*\.order\('starts_at', \{ ascending: true \}\)\s*\n\s*\.limit\(12\)/],
      ['lib/business-home.ts', /\.gt\('starts_at', now\)/],
    ] as const) assert.doesNotMatch(read(file), bad, file);
    assert.match(read('lib/business-home.ts'), /currentEventsFilter\(now\)/);
    for (const f of ['app/hubs/[id].tsx', 'app/local-business-dashboard.tsx']) assert.match(read(f), /isCurrentEvent\(/, f);
  });
  test('management lists (owner buckets, hub admin) keep their 6-hour grace so web and app stay in step', () => {
    assert.doesNotMatch(read('app/hub-events.tsx'), /event-currency/);
    assert.match(read('lib/events-api.ts'), /export function groupEventsForManagement<T extends \{ status: EventStatus; starts_at: string \}>\(/);
  });
  test('the dashboard "next event" rule and ticket lifecycle are deliberately untouched', () => {
    assert.doesNotMatch(read('lib/business-next-event.ts'), /event-currency/);
    assert.doesNotMatch(read('lib/ticket-lifecycle.ts'), /event-currency/);
  });
});

describe('both repos carry the identical helper', () => {
  for (const f of ['lib/event-currency.ts', 'lib/event-categories.ts']) {
    test(`${f} matches the web copy`, (t) => {
      const web = join(ROOT, '..', 'oneshetland-web-launch-testing', f);
      if (!existsSync(web)) return t.skip('web checkout not beside this repo');
      assert.equal(read(f), readFileSync(web, 'utf8'));
    });
  }
  test('SHETLAND_TZ literal equals the app convention', () => {
    assert.match(read('lib/event-currency.ts'), /const SHETLAND_TZ = "Europe\/London"/);
    assert.match(read('lib/shetland-time.ts'), /export const SHETLAND_TZ = 'Europe\/London'/);
  });
});

/**
 * home-local-screens.node.test.ts — guard rails for the production Home and Local tabs (components/home-local).
 * Not a design acceptance. What must never regress:
 *   • Fraunces really loads through the SHARED DisplayText (its font paths exist in the installed package)
 *   • the tabs are the new screens, inside the unchanged tab navigator; no preview mechanism, sample data, state
 *     switches or QA controls remain in production code
 *   • no fabricated content anywhere on the path: no sample shifts / jobs / events / notices fallbacks, no made-up For you
 *   • Work is real jobs + real shifts: no shift in production → jobs only; urgency derived from the real start time
 *   • "For you" is built only from genuinely personal items, and collapses when there are none
 *   • all six Local pillars and the low-inventory propositions stay
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const src = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HL = readdirSync(join(REPO, 'components/home-local')).filter((f) => /\.tsx?$/.test(f)).map((f) => `components/home-local/${f}`);

describe('display typography — through the shared component', () => {
  test('every font file the shared DisplayText requires exists in the installed package', () => {
    const reqs = [...src('components/DisplayText.tsx').matchAll(/require\('(@expo-google-fonts\/fraunces\/[^']+\.ttf)'\)/g)].map((m) => m[1]);
    assert.equal(reqs.length, 3);
    for (const r of reqs) assert.ok(existsSync(join(REPO, 'node_modules', r)), `${r} must exist`);
  });
  test('a missing font is loud in development, not silently accepted', () => {
    assert.match(src('components/DisplayText.tsx'), /console\.warn\(`\[DisplayText\]/);
  });
  test('Home and Local use the shared DisplayText', () => {
    for (const f of HL) assert.doesNotMatch(src(f), /PreviewDisplayText/, f);
    assert.match(src('components/home-local/HomeScreen.tsx'), /from '@\/components\/DisplayText'/);
  });
});

describe('the real tabs', () => {
  test('Home and Local tabs render the new screens; the tab navigator is untouched', () => {
    assert.match(src('app/(tabs)/index.tsx'), /export \{ default \} from '@\/components\/home-local\/HomeScreen'/);
    assert.match(src('app/(tabs)/local.tsx'), /export \{ default \} from '@\/components\/home-local\/LocalScreen'/);
    const layout = src('app/(tabs)/_layout.tsx');
    for (const n of ['index', 'whats-on', 'jobs', 'services', 'local']) assert.match(layout, new RegExp(`name="${n}"`), n);
    assert.match(layout, /AppTabBar/);
  });
  test('no preview routes, switches, states, viewers or QA controls remain in production code', () => {
    assert.equal(existsSync(join(REPO, 'app/preview')), false);
    assert.equal(existsSync(join(REPO, 'components/preview-v2')), false);
    for (const f of HL) {
      const c = src(f);
      assert.doesNotMatch(c, /PreviewSwitch|PreviewState|PreviewViewer|TestRibbon|buildCommerce|parseMix|chrome\b|preview/i, f);
      assert.doesNotMatch(c, /Sample (Café|Bistro|Bakehouse|Knitwear)|PREVIEW SAMPLE|ZZ TEST|DEMO —/, f);
    }
  });
});

describe('nothing is fabricated', () => {
  test('the sample events / notices / jobs / shifts fallbacks are gone from the source', () => {
    const api = src('lib/concierge-api.ts');
    assert.doesNotMatch(api, /SAMPLE_|source: 'seed'/);
    assert.doesNotMatch(api, /fetchHomeShifts|fetchHomeJobs/);
    const seed = src('lib/seed-content.ts');
    assert.doesNotMatch(seed, /SAMPLE_|Bar cover|13\.50/);
    assert.match(seed, /todaysSpik/);
  });
  test('nothing under app/ or components/ or lib/ still reads a sample list', () => {
    const walk = (d: string): string[] => readdirSync(join(REPO, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    const offenders = ['app', 'components', 'lib'].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f)).filter((f) => /SAMPLE_(EVENTS|NOTICES|JOBS|SHIFTS|URGENT)/.test(read(f)));
    assert.deepEqual(offenders, []);
  });
  test('no write calls anywhere in Home / Local data paths', () => {
    for (const f of HL) assert.doesNotMatch(src(f), /\.(insert|upsert|rpc)\(|\.from\([^)]*\)\.(update|delete)\(/, f);
  });
});

describe('Work — real jobs and real shifts', () => {
  const m = loadModule('components/home-local/work.ts');
  const NOW = new Date('2026-10-06T10:00:00Z');   // Tue 11:00 London (BST)
  const iso = (s: string) => new Date(s).toISOString();
  const job = { kind: 'job', id: 'j1', title: 'Teacher', employer: 'Council', where: 'Lerwick', pay: null, contract: 'permanent' };
  const shift = (id: string, start: string, end: string) => ({ kind: 'shift', id, title: id, employer: 'E', where: 'W', startAt: iso(start), endAt: iso(end), rate: '£12/hr' });

  test('no real shift → jobs only; nothing is added', () => {
    const w = m.buildWork({ jobs: [job], shifts: [] }, NOW);
    assert.deepEqual(w.shifts, []);
    assert.deepEqual(w.jobs, [job]);
  });
  test('real shifts pass through ordered most-imminent first; ended ones are dropped', () => {
    const w = m.buildWork({ jobs: [], shifts: [shift('later', '2026-10-09T08:00:00Z', '2026-10-09T12:00:00Z'), shift('ended', '2026-10-05T08:00:00Z', '2026-10-05T12:00:00Z'), shift('soon', '2026-10-07T08:00:00Z', '2026-10-07T12:00:00Z')] }, NOW);
    assert.deepEqual(w.shifts.map((s: any) => s.id), ['soon', 'later']);
  });
  test('urgency is derived from the real start time in London time', () => {
    const u = (a: string, b: string, now = NOW) => m.shiftUrgency(iso(a), iso(b), now);
    assert.equal(u('2026-10-06T11:30:00Z', '2026-10-06T15:00:00Z'), 'TODAY');
    assert.equal(u('2026-10-06T16:00:00Z', '2026-10-06T20:00:00Z'), 'TONIGHT');     // 17:00 BST
    assert.equal(u('2026-10-06T15:59:00Z', '2026-10-06T20:00:00Z'), 'TODAY');       // 16:59 BST
    assert.equal(u('2026-10-07T08:00:00Z', '2026-10-07T12:00:00Z'), 'TOMORROW');
    assert.equal(u('2026-10-12T08:00:00Z', '2026-10-12T12:00:00Z'), 'THIS WEEK');
    assert.equal(u('2026-10-13T08:00:00Z', '2026-10-13T12:00:00Z'), null);
    assert.equal(u('2026-10-06T08:00:00Z', '2026-10-06T10:00:00Z'), null);
  });
  test('Home curates one timely shift + two jobs; Local one or two shifts then jobs; shifts-only keeps the Work destination', () => {
    const shifts = [shift('a', '2026-10-06T16:00:00Z', '2026-10-06T20:00:00Z'), shift('b', '2026-10-07T08:00:00Z', '2026-10-07T12:00:00Z'), shift('c', '2026-10-08T08:00:00Z', '2026-10-08T12:00:00Z')];
    const jobs = [job, { ...job, id: 'j2' }, { ...job, id: 'j3' }, { ...job, id: 'j4' }];
    const h = m.curateHome({ shifts, jobs });
    assert.equal(h.shifts.length, 1); assert.equal(h.jobs.length, 2); assert.equal(h.moreShifts, 2);
    assert.equal(m.curateHome({ shifts: [], jobs }).jobs.length, 3);
    const l = m.curateLocal({ shifts, jobs });
    assert.ok(l.shifts.length === 2 && l.jobs.length === 2);
    assert.equal(m.workTab({ shifts, jobs: [] }), 'shifts');
    assert.equal(m.workTab({ shifts, jobs }), 'jobs');
    assert.equal(m.workTab({ shifts: [], jobs: [] }), 'jobs');
  });
  test('both Home and Local show the Work gateway when there is neither, so Work never vanishes', () => {
    const w = src('components/home-local/WorkModule.tsx');
    assert.equal((w.match(/<WorkGateway /g) ?? []).length, 2);
  });
  test('the data layer reads real jobs and real shifts only', () => {
    const d = src('components/home-local/data.ts');
    assert.match(d, /fetchOpenShifts/);
    assert.match(d, /\.from\('jobs'\)/);
    assert.doesNotMatch(d, /sample|SAMPLE/i);
  });
});

describe('For you — only what genuinely belongs to the person', () => {
  const fy = loadModule('components/home-local/forYou.ts');
  const NOW = new Date('2026-10-06T10:00:00Z');
  const none = { signedIn: true, walletPence: null, home: null, tickets: [], savedBoats: [], nearby: [] };

  test('nothing personal → no tiles at all (the section collapses); never filler', () => {
    assert.deepEqual(fy.buildForYou(none, NOW), []);
    assert.deepEqual(fy.buildForYou({ ...none, walletPence: 0 }, NOW), [], 'a zero balance is not worth a tile');
  });
  test('signed out → nothing, whatever else is passed', () => {
    assert.deepEqual(fy.buildForYou({ ...none, signedIn: false, walletPence: 1250, savedBoats: [{ canonical_name: 'X' }] }, NOW), []);
  });
  test('your commitments, wallet, saved vessels and a nearby offer each yield one honest tile (capped at six)', () => {
    const tiles = fy.buildForYou({
      signedIn: true, walletPence: 1250,
      home: {
        activeDelivery: null,
        upcomingBooking: { id: 'b', business_id: 'x', business_name: 'Hair Studio', service_name: 'Cut', starts_at: '2026-10-07T09:30:00Z' },
        application: { id: 'a', title: 'Saturday cover', status: 'accepted', start_at: null },
        rewardReady: { business_id: 'x', business_name: 'The Café', stamps: 8, needed: 8 },
        giftToClaim: { id: 'g' }, owner: null, walletItemCount: 0,
      },
      tickets: [{ event: { id: 'e1', title: 'Fiddle Festival', starts_at: '2026-10-08T18:00:00Z' } }, { event: { id: 'e1', title: 'Fiddle Festival', starts_at: '2026-10-08T18:00:00Z' } }, { event: { id: 'old', title: 'Past', starts_at: '2026-09-01T18:00:00Z' } }],
      savedBoats: [{ canonical_name: 'Antares' }],
      nearby: [{ business_id: 'n', business_name: 'Corner Shop', offer_title: '10% off', business_lat: null, business_lng: null, distance_km: 0.2, offer_id: 'o', offer_image_url: null, has_loyalty: false }],
    }, NOW);
    const by = Object.fromEntries(tiles.map((t: any) => [t.id, t]));
    assert.equal(tiles.length, 6, 'capped at six, your own commitments first');
    assert.deepEqual(Object.keys(by).sort(), ['application', 'booking', 'gift', 'reward', 'tickets', 'wallet']);
    const extra = fy.buildForYou({ ...none, savedBoats: [{ canonical_name: 'Antares' }], nearby: [{ business_id: 'n', business_name: 'Corner Shop', offer_title: '10% off', business_lat: null, business_lng: null, distance_km: 0.2, offer_id: 'o', offer_image_url: null, has_loyalty: false }] }, NOW);
    assert.deepEqual(extra.map((t: any) => t.id), ['nearby', 'saved-boats']);
    assert.equal(by.wallet.headline, '£12.50');
    assert.equal(by.tickets.detail, '2 tickets · Fiddle Festival', 'the past event is ignored and tickets are grouped');
    assert.equal(by.booking.headline.startsWith('Tomorrow'), true);
    assert.ok(tiles.length <= 6);
    // your own live commitments lead
    assert.ok(['booking', 'tickets'].includes(tiles[0].id));
  });
  test('no editorial or engagement filler: no games, events, notices or job suggestions', () => {
    const c = src('components/home-local/forYou.ts');
    assert.doesNotMatch(c, /games|Today's|COMING UP|engagement|jobs\[0\]|notices/i);
  });
  test('Home renders For you only when there are tiles', () => {
    assert.match(src('components/home-local/HomeScreen.tsx'), /forYou\.length > 0 && \(/);
  });
});

describe('Rewards — honest when there is no stamp card', () => {
  const l = src('components/home-local/LocalScreen.tsx');
  test('with no card it is a discovery invitation that does not imply a started card', () => {
    assert.match(l, /Collect rewards locally/);
    assert.match(l, /Find participating businesses and start earning stamps and points\./);
    assert.match(l, /Explore rewards →/);
    assert.doesNotMatch(l, /Any stamp-card shop|Collect a stamp at every visit|0 of 8/);
  });
  test('the progress card (name, N of M, stamps) exists only in the real-card branch', () => {
    const real = l.indexOf('{card ? (');
    const empty = l.indexOf('Collect rewards locally');
    assert.ok(real > 0 && empty > real);
    const branch = l.slice(real, empty);
    assert.match(branch, /collected\} of \{needed/);
    assert.match(branch, /card\.business\?\.name/);
    assert.doesNotMatch(l.slice(empty), /collected\} of/);
  });
  test('the empty-state button opens the rewards hub; the real card opens the person\'s own cards', () => {
    assert.match(l, /router\.push\('\/local-loyalty-hub' as never\)[^\n]*\n?[^\n]*Explore rewards/s);
    assert.match(l, /router\.push\('\/local-my-cards' as never\)/);
  });
});

describe('Wallet hub does not call used / refunded / expired passes "active"', () => {
  test('the Passes & vouchers row counts only passes whose status is active, and otherwise says "past"', () => {
    const w = src('app/local-wallet.tsx');
    assert.doesNotMatch(w, /countLabel=\{`\$\{passes\.length\} active`\}/);
    assert.match(w, /p\.status === 'active'/);
    assert.match(w, /\} past`/);
  });
});

describe('Test fixtures — labelled for the people who can see them, absent for everyone else', () => {
  test('the badge text is exactly "TEST · ADMIN ONLY"', () => {
    assert.match(src('components/TestBadge.tsx'), /TEST_BADGE_TEXT = 'TEST · ADMIN ONLY'/);
  });
  test('fixture ids come from the explicit server list via the admin-only RPC — never a name pattern', () => {
    const f = src('lib/discovery-fixtures.ts');
    assert.match(f, /rpc\('admin_discovery_fixture_ids'\)/);
    assert.doesNotMatch(f, /ZZ|DEMO|\.includes\(|startsWith|RegExp|\/i\b/, 'no name matching');
    assert.match(f, /if \(!userId\) return Promise\.resolve\(NO_FIXTURES\)/, 'signed out → nothing to label');
    assert.match(f, /error \|\| !Array\.isArray\(data\)\) return NO_FIXTURES/, 'any failure → nothing is labelled, nothing is revealed');
  });
  test('every discovery surface badges a fixture it is shown', () => {
    const must: [string, RegExp][] = [
      ['components/home-local/ui.tsx', /props\.m\.test && <TestBadge \/>/],            // Home rail, Local pillar sections, Experiences cards
      ['components/home-local/ui.tsx', /m\.test && <TestBadge \/>/],                   // feature tiles
      ['components/home-local/HomeScreen.tsx', /fixtures\.business\.has\(lead\.id\) && <TestBadge/],
      ['components/home-local/HomeScreen.tsx', /fixtures\.business\.has\(b\.id\) && <TestBadge/],
      ['components/home-local/LocalScreen.tsx', /fixtures\.business\.has\(lead\.id\) && <TestBadge/],
      ['components/home-local/LocalScreen.tsx', /fixtures\.business\.has\(b\.id\) && <TestBadge/],
      ['app/local-businesses-browse.tsx', /isTest && <TestBadge/],                       // Directory
      ['app/shop.tsx', /fixtures\.business\.has\(item\.business_id\) && <TestBadge/],  // Shop
      ['app/local-offers.tsx', /isTest && <TestBadge/],                                  // Offers
      ['app/local-bookable-browse.tsx', /isTest && <TestBadge/],                         // Book
    ];
    for (const [f, re] of must) assert.match(src(f), re, `${f}: ${re}`);
  });
  test('the data layer marks products, offers, services and passes by business id', () => {
    const d = src('components/home-local/data.ts');
    assert.equal((d.match(/test: fixtures\.business\.has\(/g) ?? []).length, 4);
  });
  test('the migration is read-only: no policy, no write, no data change, and it is not callable by anon', () => {
    const m = read('supabase/migrations/20261104020000_admin_discovery_fixture_ids.sql');
    assert.doesNotMatch(m.replace(/--.*$/gm, ''), /\b(insert|update|delete|alter policy|create policy|drop)\b/i);
    assert.match(m, /revoke execute on function public\.admin_discovery_fixture_ids\(\) from public, anon/);
  });
});

describe('Public browsing — Shop and Book never ask for an account to look', () => {
  test('the root layout protects only private groups; Shop and Book are in none of them', () => {
    const l = src('app/_layout.tsx');
    assert.match(l, /const inProtected = inCustomerGroup \|\| inDriverGroup \|\| inAdminGroup \|\| inAccountScreen \|\| onOnboardingScreen;/);
    assert.ok(existsSync(join(REPO, 'app/shop.tsx')) && existsSync(join(REPO, 'app/local-bookable-browse.tsx')));
    for (const f of ['app/shop.tsx', 'app/local-bookable-browse.tsx', 'app/product-detail.tsx']) {
      assert.doesNotMatch(src(f), /useGoToSignIn|goToSignIn|\(auth\)\/sign-in|<Redirect/, `${f} must not force sign-in`);
    }
  });
  test('their empty states are the designed Opening-soon panels (only when nothing is being searched or filtered)', () => {
    assert.match(src('app/shop.tsx'), /!error && !query && !category \? <PillarEmpty pillar="shop"/);
    assert.match(src('app/local-bookable-browse.tsx'), /!filter \? <View[^>]*><PillarEmpty pillar="book"/);
  });
  test('sign-in is required exactly at the account-dependent action: choosing a booking slot, and confirming a purchase', () => {
    const b = src('app/local-book-business.tsx');
    const slot = b.slice(b.indexOf('const handleSlotPress'), b.indexOf('const handleSlotPress') + 600);
    assert.match(slot, /if \(!profile\) \{[\s\S]*goToSignIn\(next\)/);
    assert.match(src('app/product-checkout.tsx'), /if \(!session\) return 'Sign in to buy/);
    assert.match(src('app/local-buy-unit.tsx'), /if \(!session \|\| !profile \|\| !item\) return;/);
  });
});

describe('Experiences — a real destination, not the directory', () => {
  test('Home and Local Experiences both open /local-experiences; the generic directory is no longer behind them', () => {
    const model = loadModule('components/home-local/model.ts');
    assert.equal(model.PILLAR_ROUTE.experiences, '/local-experiences');
    assert.match(src('components/home-local/LocalScreen.tsx'), /PILLAR_ROUTE\.experiences/);
    assert.match(src('components/home-local/HomeScreen.tsx'), /PILLAR_ROUTE\[p\]/);
    assert.ok(existsSync(join(REPO, 'app/local-experiences.tsx')));
    assert.match(src('app/_layout.tsx'), /<Stack\.Screen name="local-experiences" \/>/);
  });
  test('the screen lists real passes, has an intentional zero state, and supports Back', () => {
    const e = src('app/local-experiences.tsx');
    assert.match(e, /fetchActiveLocalPasses\(60\)/);
    assert.match(e, /<PillarEmpty pillar="experiences"/);
    assert.match(e, /onBack=\{\(\) => router\.back\(\)\}/);
    assert.match(e, /passesToMerch\(passes, fixtures\)/);
  });
  test('an experience opens the existing pass purchase flow for that pass; that screen exists', () => {
    const model = loadModule('components/home-local/model.ts');
    assert.equal(model.EXPERIENCE_ROUTE, '/local-buy-unit');
    assert.match(src('components/home-local/data.ts'), /params: \{ itemId: p\.id \}/);
    assert.ok(existsSync(join(REPO, 'app/local-buy-unit.tsx')));
  });
  test('a fixture pass is badged and a genuine one is not', () => {
    const mods = ['@/lib/supabase', '@/lib/local-api', '@/lib/products-api', '@/lib/book-api', '@/lib/shetland-today', '@/lib/cruise-api', '@/lib/concierge-api', '@/lib/discovery-fixtures', '@/lib/shifts-api'];
    const stubs: Record<string, unknown> = Object.fromEntries(mods.map((m) => [m, {}]));
    stubs['./model'] = { EXPERIENCE_ROUTE: '/local-buy-unit' };
    const { passesToMerch } = loadModule('components/home-local/data.ts', stubs);
    const pass = (id: string, biz: string) => ({ id, business_id: biz, name: id, price_pence: 100, uses_per_purchase: 1, valid_days: 1, image_url: null, business_name: 'B', business_logo_url: null, business_category: 'retail' });
    const out = passesToMerch([pass('fixture-pass', 'FIX'), pass('real-pass', 'REAL')], { business: new Set(['FIX']), hub: new Set() });
    assert.equal(out.find((m: any) => m.id === 'fixture-pass').test, true);
    assert.equal(out.find((m: any) => m.id === 'real-pass').test, false, 'genuine content is never classed as test');
    const none = passesToMerch([pass('fixture-pass', 'FIX')], { business: new Set(), hub: new Set() });
    assert.equal(none[0].test, false, 'for the public the set is empty, so nothing is labelled');
  });
});

describe('Plan my day — visitors only on Home, with a second way in', () => {
  const h = src('components/home-local/HomeScreen.tsx');
  test('Home renders the card only when the audience is "visiting", and routes to /plan-day', () => {
    assert.equal((h.match(/<PlanDayCard /g) ?? []).length, 1, 'rendered exactly once');
    assert.match(h, /audience === 'visiting' && <PlanDayCard onPress=\{\(\) => router\.push\('\/plan-day'\)\} \/>/);
  });
  test('it sits above For you and What\'s happening so a visitor sees it high on Home', () => {
    assert.ok(h.indexOf('<PlanDayCard onPress') < h.indexOf('forYou.length > 0'));
    assert.ok(h.indexOf('<PlanDayCard onPress') < h.indexOf('{e0 && ('));
  });
  test('the card is the V2 language: Fraunces title, gradient scrim, pill CTA', () => {
    const card = h.slice(h.indexOf('function PlanDayCard'));
    assert.match(card, /<DisplayText weight="bold"[^>]*>Plan my day<\/DisplayText>/);
    assert.match(card, /<Scrim /);
  });
  test('the cruise day screen links to the planner as a second route, and the screen exists', () => {
    assert.match(src('app/cruise-day.tsx'), /router\.push\('\/plan-day'\)/);
    assert.ok(existsSync(join(REPO, 'app/plan-day.tsx')));
  });
});

describe('Home top and Local gateway (approved structure)', () => {
  test('Home keeps identity, wallet, notifications, profile, search, audience and Shetland-now — wired to the real thing', () => {
    const h = src('components/home-local/HomeScreen.tsx');
    for (const needle of ['OneShetland', 'fetchWalletBalance', '<NotificationBell', "'/(tabs)/me'", "'/search'", 'saveAudience', 'data?.weather', '<EssentialAlerts']) assert.ok(h.includes(needle), needle);
    // Deliberate change (Notices & Alerts UI): the floating emergency-coloured AlertPill no longer claims the top of Home. The only red slot is
    // <EssentialAlerts> (get_essential_alerts); a business's partner_alerts update is a calm strip lower down.
    assert.ok(!h.includes('<AlertPill'));
  });
  test('Local keeps all six pillars, Featured locally (with a directory route and a fallback), commerce, Work and For businesses', () => {
    const l = src('components/home-local/LocalScreen.tsx');
    for (const p of ['Shop', 'Offers', 'Book', 'Experiences', 'Businesses', 'Rewards']) assert.match(l, new RegExp(`<PillarTile label="${p}"`), p);
    assert.equal((l.match(/<PillarTile /g) ?? []).length, 6);
    for (const p of PILLARS) assert.match(l, new RegExp(`pillar="${p}"`), p);
    assert.match(l, /Browse directory/);
    assert.doesNotMatch(l, /\(tabs\)\/services/, 'Directory is pushed (so Back returns to Local), not navigated to as a tab');
    assert.match(l, /router\.push\('\/local-businesses-browse' as never\)/);
    assert.match(l, /<LocalWork /);
    assert.match(l, /For businesses/i);
    assert.match(l, /PILLAR_CTA_ROUTE/);
  });
  test('low inventory: every pillar keeps its proposition panel; the rule is one function', () => {
    const model = loadModule('components/home-local/model.ts');
    assert.deepEqual([0, 1, 3, 4, 12, 13, 24].map((n) => model.density(n)), ['none', 'few', 'few', 'rail', 'rail', 'many', 'many']);
    assert.match(src('components/home-local/ui.tsx'), /d === 'none' && <PillarEmpty/);
    for (const p of PILLARS) assert.ok(model.PILLARS[p].emptyTitle && model.PILLARS[p].emptyBody && model.PILLARS[p].cta, p);
  });
  test('every "See all" and call to action has a destination that exists', () => {
    const model = loadModule('components/home-local/model.ts');
    for (const r of [...Object.values(model.PILLAR_ROUTE), model.PILLAR_CTA_ROUTE] as string[]) assert.ok(existsSync(join(REPO, 'app', `${r.slice(1)}.tsx`)), r);
  });
});
const PILLARS = ['shop', 'offers', 'book', 'experiences'];

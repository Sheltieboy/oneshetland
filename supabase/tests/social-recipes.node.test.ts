/**
 * social-recipes.node.test.ts — the seven newer Social Studio recipes (selection, scheduling, dedupe, freshness, safety).
 *
 * Runs the REAL shared module against an in-memory stand-in for the database. No network, no database, no Meta call, nothing is posted.
 * `now` is fixed so every date rule is deterministic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDb } from './_support/fake-svc.ts';
import * as R from '../functions/_shared/social-recipes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

// Wednesday 4 Nov 2026, 05:40 UTC == 05:40 London (GMT). The composer's real run time.
const NOW = new Date('2026-11-04T05:40:00Z');
const iso = (d: Date) => d.toISOString();
const ago = (days: number, from = NOW) => iso(new Date(from.getTime() - days * 86400_000));
const ahead = (days: number, from = NOW) => iso(new Date(from.getTime() + days * 86400_000));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seeded = () => { let x = 7; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

/* ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────── */
const notice = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: `Bus timetable change ${n}`, body: 'The 12 service will run an hour earlier from Monday while the road is resurfaced.', category: 'travel_transport',
  published_at: ago(1), expires_at: ahead(10), review_at: null, image_url: null, action_text: null, link_url: null, is_essential_active: false, publisher: { label: 'Shetland Islands Council' }, ...o });
const meta = (n: number, o: Record<string, any> = {}) => ({ id: U(n), is_person_notice: false, status: 'published', is_hidden: false, visibility: 'public', withdrawn_at: null, source_label: null, ...o });

function world(o: { notices?: any[]; metas?: any[]; alerts?: any[]; recipes?: Record<string, any> } = {}) {
  const db = new FakeDb();
  db.clock = () => iso(NOW);
  db.rpcs.get_public_notices = (a) => {
    const src = a.p_level === 'essential' ? (o.alerts ?? []) : (o.notices ?? []);
    return a.p_id ? src.filter((x: any) => x.id === a.p_id) : src.slice(0, a.p_limit);
  };
  db.rpcs.is_discovery_hidden = () => false;
  db.rpcs.campaign_payout_ready = () => true;
  const given = new Set((o.metas ?? []).map((m: any) => m.id));
  db.tables.notices = [...(o.metas ?? []), ...[...(o.notices ?? []), ...(o.alerts ?? [])].filter((n: any) => !given.has(n.id)).map((n: any) => meta(Number(n.id.slice(-12))))];
  db.tables.admin_config = [];
  const recipes = new Map<string, any>();
  for (const k of R.NEW_KINDS) recipes.set(k, { key: k, enabled: false, autopilot: false, config: {}, ...(o.recipes?.[k] ?? {}) });
  return { db, recipes };
}
const enable = (w: ReturnType<typeof world>, ...kinds: string[]) => kinds.forEach((k) => (w.recipes.get(k).enabled = true));
const compose = (w: ReturnType<typeof world>, extra: Record<string, any> = {}) => R.composeNewRecipes({ svc: w.db, now: NOW, recipes: w.recipes, rand: seeded(), ...extra });
const posts = (w: ReturnType<typeof world>) => w.db.table('social_posts');

/* ── 1. notices ───────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Notices & community updates', () => {
  test('a fresh public notice becomes a post linking to the original notice', async () => {
    const w = world({ notices: [notice(1)] });
    const c = await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW);
    assert.equal(c.length, 1);
    assert.match(c[0].caption, /^COMMUNITY NOTICE/);
    assert.ok(c[0].caption.includes('https://oneshetland.com/go/notice/' + U(1)));
    assert.equal(c[0].link_url, 'https://oneshetland.com/go/notice/' + U(1));
  });
  test('an official source is credited', async () => {
    const w = world({ notices: [notice(2)], metas: [meta(2, { source_label: 'Shetland Islands Council' })] });
    assert.match((await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW))[0].caption, /Source: Shetland Islands Council/);
  });
  test('person notices, hidden, withdrawn, non-public and draft notices are never used', async () => {
    const w = world({ notices: [notice(3), notice(4), notice(5), notice(6), notice(7)], metas: [
      meta(3, { is_person_notice: true }), meta(4, { is_hidden: true }), meta(5, { withdrawn_at: ago(1) }), meta(6, { visibility: 'members' }), meta(7, { status: 'draft' })] });
    assert.deepEqual(await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW), []);
  });
  test('funeral, death and other sensitive wording is excluded however it is phrased', async () => {
    const bad = ['Funeral service for Mr X', 'Notice of passing', 'Sad news: he passed away peacefully', 'Obituary', 'Condolences to the family', 'RIP Magnie', 'Burial at Lerwick cemetery', 'Missing person appeal'];
    const w = world({ notices: bad.map((t, i) => notice(100 + i, { title: t, body: 'Details inside.' })) });
    assert.deepEqual(await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW), []);
    assert.equal(R.isSensitiveText('Bus timetable and ferry changes'), false);
    assert.equal(R.isSensitiveText(null, undefined, ''), false);
  });
  test('sensitive text in the BODY or category also blocks it', async () => {
    const w = world({ notices: [notice(8, { body: 'Following the death of a local resident the hall is closed.' }), notice(9, { category: 'funeral' })] });
    assert.deepEqual(await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW), []);
  });
  test('freshness: older than the window, or about to expire, is not promoted', async () => {
    const w = world({ notices: [notice(10, { published_at: ago(9) }), notice(11, { expires_at: ahead(0.5) }), notice(12, { expires_at: ago(1) }), notice(13)] });
    assert.deepEqual((await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW)).map((c) => c.entity_id), [U(13)]);
  });
  test('an active Essential Alert is not duplicated as a community notice', async () => {
    const w = world({ notices: [notice(14, { is_essential_active: true })] });
    assert.deepEqual(await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW), []);
  });
  test('only an https image is attached', async () => {
    const w = world({ notices: [notice(15, { image_url: 'http://x/y.jpg' }), notice(16, { image_url: 'https://cdn.example/y.jpg' })] });
    const c = await R.selectNotices(w.db, R.DEFAULTS.notice_update, NOW);
    assert.deepEqual(c.map((x) => x.image_url), [null, 'https://cdn.example/y.jpg']);
  });
});

/* ── 2. essential alerts ──────────────────────────────────────────────────────────────────────────────────────── */
const alert = (n: number, o: Record<string, any> = {}) => notice(n, { title: 'A970 closed at Sellafirth', body: 'Road closed after a landslip. Follow the signed diversion.', action_text: 'Use the diversion via Mid Yell.', is_essential_active: true, review_at: ahead(1), expires_at: ahead(2), category: 'travel_transport', ...o });
describe('Essential alerts', () => {
  test('an active verified alert is drafted in the issuer’s words, plain, with a link to the original', async () => {
    const w = world({ alerts: [alert(20)] });
    const c = await R.selectAlerts(w.db, R.DEFAULTS.essential_alert, NOW);
    assert.equal(c.length, 1);
    assert.match(c[0].caption, /^ESSENTIAL ALERT\n/);
    assert.match(c[0].caption, /Use the diversion via Mid Yell\./);
    assert.match(c[0].caption, /Issued by Shetland Islands Council\./);
    assert.ok(c[0].caption.includes('/go/notice/' + U(20)));
    assert.doesNotMatch(c[0].caption, /[!🚨⚠️]|urgent|breaking|emergency|danger/i);
  });
  test('expired, expiring, review-due, withdrawn, hidden and not-active alerts are never selected', async () => {
    const w = world({ alerts: [alert(21, { expires_at: ago(1) }), alert(22, { expires_at: ahead(0.05) }), alert(23, { review_at: ago(1) }), alert(24, { review_at: null }), alert(25, { is_essential_active: false })],
      metas: [meta(26)] });
    assert.deepEqual(await R.selectAlerts(w.db, R.DEFAULTS.essential_alert, NOW), []);
    const w2 = world({ alerts: [alert(27), alert(28), alert(29)], metas: [meta(27, { withdrawn_at: ago(0.1) }), meta(28, { is_hidden: true }), meta(29, { status: 'withdrawn' })] });
    assert.deepEqual(await R.selectAlerts(w2.db, R.DEFAULTS.essential_alert, NOW), []);
  });
  test('an alert is NEVER auto-scheduled, even with autopilot forced on', async () => {
    const w = world({ alerts: [alert(30)], recipes: { essential_alert: { enabled: true, autopilot: true } } });
    const out = await compose(w);
    assert.equal(out.essential_alert, 1);
    assert.equal(posts(w)[0].status, 'draft');
  });
  test('the store itself refuses a scheduled alert (the DB constraint, mirrored by the fake)', async () => {
    const w = world();
    const r = await w.db.from('social_posts').insert({ kind: 'essential_alert', entity_id: 'x', status: 'scheduled', caption: 'c' });
    assert.match(String(r.error?.message), /essential_needs_human/);
  });
  test('the same alert is never queued twice, and a second alert waits out the gap', async () => {
    const w = world({ alerts: [alert(31), alert(32)], recipes: { essential_alert: { enabled: true } } });
    await compose(w);
    assert.equal(posts(w).length, 1);
    const again = await compose(w);
    assert.equal(posts(w).length, 1, 'rerun adds nothing');
    assert.match(String(again.skipped.essential_alert), /too soon|awaiting/);
  });
  test('caption is never AI-rewritten', async () => {
    const w = world({ alerts: [alert(33)], recipes: { essential_alert: { enabled: true, config: { polish: true } } } });
    let called = 0;
    await compose(w, { polish: async (t: string) => { called++; return t + ' 🚨 BREAKING'; } });
    assert.equal(called, 0);
    assert.doesNotMatch(posts(w)[0].caption, /BREAKING/);
  });
});

/* ── 3. memories ──────────────────────────────────────────────────────────────────────────────────────────────── */
const memory = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: 'Haymaking at Vidlin', body: 'We cut the hay by hand and turned it with wooden rakes, the whole township out in the long light of July evenings.', era: '1950s', place_name: 'Vidlin', visibility: 'public', is_hidden: false, parent_id: null, created_at: ago(5), ...o });
describe('Aald Memories', () => {
  test('only memories with an explicit promotion permission are used; none by default', async () => {
    const w = world(); w.db.tables.memories = [memory(40), memory(41)];
    assert.deepEqual(await R.selectMemories(w.db, R.DEFAULTS.aald_memory), []);
    w.db.tables.social_promotion_permissions = [{ entity_type: 'memory', entity_id: U(40), allowed: true }, { entity_type: 'memory', entity_id: U(41), allowed: false }];
    assert.deepEqual((await R.selectMemories(w.db, R.DEFAULTS.aald_memory)).map((c) => c.entity_id), [U(40)]);
  });
  test('private, hidden, reply, too-short and sensitive memories are excluded even when permitted', async () => {
    const w = world();
    const ms = [memory(42, { visibility: 'private' }), memory(43, { is_hidden: true }), memory(44, { parent_id: U(40) }), memory(45, { body: 'Short.' }), memory(46, { body: 'The funeral procession came down the old road past the kirk, hundreds following, a day nobody who was there ever forgot at all.' })];
    w.db.tables.memories = ms.filter((m) => m.visibility === 'public' && !m.is_hidden && !m.parent_id);   // the query filters these; predicate re-checks below
    w.db.tables.social_promotion_permissions = ms.map((m) => ({ entity_type: 'memory', entity_id: m.id, allowed: true }));
    assert.deepEqual(await R.selectMemories(w.db, R.DEFAULTS.aald_memory), []);
    for (const m of ms) assert.equal(R.memoryEligible(m as any, true, R.DEFAULTS.aald_memory).ok, false);
  });
  test('no image is attached (memory photos are private); the caption links to the memory and does not name the author', async () => {
    const w = world(); w.db.tables.memories = [memory(47)]; w.db.tables.social_promotion_permissions = [{ entity_type: 'memory', entity_id: U(47), allowed: true }];
    const [c] = await R.selectMemories(w.db, R.DEFAULTS.aald_memory);
    assert.equal(c.image_url, null);
    assert.ok(c.caption.includes('/go/memory/' + U(47)));
    assert.match(c.caption, /Haymaking at Vidlin \(1950s\)/);
  });
});

/* ── 4. businesses ────────────────────────────────────────────────────────────────────────────────────────────── */
const biz = (n: number, o: Record<string, any> = {}) => ({ id: U(n), name: 'Peerie Bakehoose', description: 'A family bakery in Lerwick making bread, bannocks and cakes every morning from local flour.', cover_url: 'https://cdn.example/c.jpg', logo_url: null, category: 'Bakery', is_claimed: true, is_active: true, ...o });
describe('Business spotlight', () => {
  test('a claimed, active, visible business with a description and image is eligible', async () => {
    const w = world(); w.db.tables.local_businesses = [biz(50)];
    const [c] = await R.selectBusinesses(w.db, R.DEFAULTS.business_spotlight, NOW);
    assert.equal(c.entity_id, U(50)); assert.equal(c.business_id, U(50));
    assert.ok(c.caption.includes('/go/business/' + U(50))); assert.equal(c.image_url, 'https://cdn.example/c.jpg');
  });
  test('unclaimed, inactive, hidden, opted-out, fixture-named, undescribed and image-less are all excluded', async () => {
    const w = world();
    w.db.tables.local_businesses = [biz(51, { is_claimed: false }), biz(52, { is_active: false }), biz(53), biz(54), biz(55, { name: 'ZZ TEST — Acceptance Fixture' }), biz(56, { name: 'DEMO Cafe' }), biz(57, { description: 'Nice.' }), biz(58, { cover_url: null, logo_url: null })];
    w.db.rpcs.is_discovery_hidden = (a: any) => a.p_id === U(53);
    w.db.tables.social_promotion_permissions = [{ entity_type: 'business', entity_id: U(54), allowed: false }];
    // the real query filters claimed/active at the database; the predicate re-checks everything
    const got = await R.selectBusinesses(w.db, R.DEFAULTS.business_spotlight, NOW);
    assert.deepEqual(got, []);
  });
  test('a business is not repeated within 90 days, and returns afterwards', async () => {
    const w = world({ recipes: { business_spotlight: { enabled: true } } }); w.db.tables.local_businesses = [biz(59)];
    const tue = new Date('2026-11-03T05:40:00Z');
    const run = (at: Date) => R.composeNewRecipes({ svc: w.db, now: at, recipes: w.recipes, rand: seeded() });
    w.db.clock = () => iso(tue);
    assert.equal((await run(tue)).business_spotlight, 1);
    posts(w)[0].status = 'posted';
    const later = new Date(tue.getTime() + 30 * 86400_000);   // a Thursday? force to a Tuesday
    const t2 = new Date('2026-12-01T05:40:00Z'); w.db.clock = () => iso(t2);
    assert.equal((await run(t2)).business_spotlight, 0, '28 days later: still inside 90');
    const t3 = new Date('2027-02-09T05:40:00Z'); w.db.clock = () => iso(t3);
    assert.equal((await run(t3)).business_spotlight, 1, '98 days later: allowed again');
    void later;
  });
});

/* ── 5. hubs ──────────────────────────────────────────────────────────────────────────────────────────────────── */
const hub = (n: number, o: Record<string, any> = {}) => ({ id: U(n), name: 'Lerwick Community Hall', description: 'Our hall hosts clubs, classes and community suppers every week. Everyone is welcome to come along.', cover_url: null, logo_url: 'https://cdn.example/l.png', area: 'Lerwick', join_mode: 'open', is_active: true, slug: 'lerwick-hall', ...o });
describe('Hubs & community', () => {
  test('an active public hub is promoted without a fundraiser line when it has none', async () => {
    const w = world(); w.db.tables.hubs = [hub(60)]; w.db.tables.hub_campaigns = [];
    const [c] = await R.selectHubs(w.db, R.DEFAULTS.hub_community, NOW);
    assert.ok(c.caption.includes('/go/hub/' + U(60))); assert.doesNotMatch(c.caption, /fundraising/);
  });
  test('a fundraiser is mentioned only while it can take donations', async () => {
    const mk = async (camp: any, ready: boolean) => { const w = world(); w.db.tables.hubs = [hub(61)]; w.db.tables.hub_campaigns = [camp]; w.db.rpcs.campaign_payout_ready = () => ready; return (await R.selectHubs(w.db, R.DEFAULTS.hub_community, NOW))[0].caption; };
    const live = { id: U(70), hub_id: U(61), title: 'New roof appeal', status: 'active', ends_at: ahead(10) };
    assert.match(await mk(live, true), /Currently fundraising: New roof appeal/);
    assert.doesNotMatch(await mk(live, false), /fundraising/, 'hub not payout-ready');
    assert.doesNotMatch(await mk({ ...live, status: 'closed' }, true), /fundraising/);
    assert.doesNotMatch(await mk({ ...live, ends_at: ago(1) }, true), /fundraising/, 'ended');
  });
  test('inactive, hidden, fixture, undescribed and opted-out hubs are excluded', async () => {
    const w = world(); w.db.tables.hubs = [hub(62, { is_active: false }), hub(63), hub(64, { name: 'ZZ TEST — Wallet Acceptance Hub' }), hub(65, { description: 'Hi' }), hub(66)];
    w.db.rpcs.is_discovery_hidden = (a: any) => a.p_id === U(63);
    w.db.tables.social_promotion_permissions = [{ entity_type: 'hub', entity_id: U(66), allowed: false }];
    assert.deepEqual(await R.selectHubs(w.db, R.DEFAULTS.hub_community, NOW), []);
  });
});

/* ── 6. games ─────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Games & challenges', () => {
  test('rotates least-recently-featured first and keeps one post per game per week', async () => {
    const w = world();
    w.db.tables.social_posts = [{ kind: 'game_challenge', entity_id: 'guess_da_wird:2026-W44', created_at: ago(5) }, { kind: 'game_challenge', entity_id: 'spik_sprint:2026-W43', created_at: ago(12) }];
    const c = await R.selectGames(w.db, R.DEFAULTS.game_challenge, NOW);
    assert.deepEqual(c.map((x) => x.entity_id.split(':')[0]).slice(0, 2), ['spik_snap', 'map_it'], 'never-featured games first');
    assert.match(c[0].entity_id, /:2026-W45$/);
  });
  test('copy never contains a daily answer, and the guard catches one if it ever did', () => {
    const all = Object.values(R.GAME_COPY).flatMap((g) => g.lines).join(' ');
    assert.doesNotMatch(all, /answer|solution|the word is/i);
    assert.equal(R.spoilsAnswer('Today’s word is glowerit — see if you can guess', ['glowerit']), true);
    assert.equal(R.spoilsAnswer('Test your Shetland words', ['glowerit']), false);
  });
  test('links go to the game page and nothing else is claimed', async () => {
    const w = world(); const [c] = await R.selectGames(w.db, { games: ['guess_da_wird'] }, NOW);
    assert.equal(c.link_url, 'https://oneshetland.com/go/games/guess-da-wird'); assert.match(c.caption, /^GUESS DA WIRD/);
  });
  test('an unknown game id in config is ignored', async () => {
    assert.deepEqual(await R.selectGames(world().db, { games: ['nope'] }, NOW), []);
  });
});

/* ── 7. cruise ────────────────────────────────────────────────────────────────────────────────────────────────── */
const visit = (n: number, o: Record<string, any> = {}) => ({ id: U(n), ship_name_cache: 'Marella Explorer', arrival_at: '2026-11-06T08:30:00Z', departure_at: '2026-11-06T17:00:00Z', visit_date: '2026-11-06', berth: 'Holmsgarth', status: 'scheduled', is_cruise_ship: true, last_verified: '2026-10-20', verification_source: 'lerwick_harbour', ...o });
describe('Cruise & visitor information', () => {
  test('a verified upcoming visit within the lead window is posted once per day, grouping ships', async () => {
    const w = world(); w.db.tables.cruise_visits = [visit(80), visit(81, { ship_name_cache: 'Azamara Quest', arrival_at: '2026-11-06T09:00:00Z', departure_at: '2026-11-06T18:00:00Z', berth: null })];
    const c = await R.selectCruise(w.db, R.DEFAULTS.cruise_visit, NOW);
    assert.equal(c.length, 1); assert.equal(c[0].entity_id, '2026-11-06');
    assert.match(c[0].caption, /Marella Explorer — in 08:30, away 17:00 \(Holmsgarth\)/); assert.match(c[0].caption, /Azamara Quest/);
    assert.ok(c[0].caption.includes('/go/cruise/2026-11-06'));
  });
  test('cancelled, postponed, unverified, stale-verified, past and non-cruise visits are excluded', async () => {
    const w = world(); w.db.tables.cruise_visits = [visit(82, { status: 'cancelled' }), visit(83, { status: 'postponed' }), visit(84, { verification_source: null }), visit(85, { last_verified: null }),
      visit(86, { last_verified: '2025-01-01' }), visit(87, { arrival_at: '2026-11-04T01:00:00Z', departure_at: '2026-11-04T04:00:00Z', visit_date: '2026-11-04' }), visit(88, { is_cruise_ship: false }), visit(89, { status: null })];
    assert.deepEqual(await R.selectCruise(w.db, R.DEFAULTS.cruise_visit, NOW), []);
  });
  test('visits beyond the lead window are not announced yet', async () => {
    const w = world(); w.db.tables.cruise_visits = [visit(90, { visit_date: '2026-11-20', arrival_at: '2026-11-20T08:00:00Z', departure_at: '2026-11-20T16:00:00Z' })];
    assert.deepEqual(await R.selectCruise(w.db, R.DEFAULTS.cruise_visit, NOW), []);
  });
  test('seasonal: with no visits the recipe simply does nothing', async () => {
    const w = world({ recipes: { cruise_visit: { enabled: true } } }); w.db.tables.cruise_visits = [];
    const out = await compose(w); assert.equal(out.cruise_visit, 0); assert.equal(posts(w).length, 0);
  });
});

/* ── 8. scheduling ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Slot allocation', () => {
  const base = { now: NOW, preferredHour: 12, taken: [] as Date[], gapMinutes: 120, maxPerDay: 3, windowStartHour: 8, windowEndHour: 20, horizonDays: 3 };
  const lh = (d: Date) => R.londonParts(d);
  test('uses the preferred hour when free', () => { const s = R.allocateSlot(base)!; assert.equal(lh(s).ymd, '2026-11-04'); assert.equal(lh(s).hour, 12); });
  test('keeps at least the gap from everything already queued', () => {
    const t = [R.londonInstant('2026-11-04', 12, 0)];
    const s = R.allocateSlot({ ...base, taken: t })!;
    assert.ok(Math.abs(s.getTime() - t[0].getTime()) >= 120 * 60_000);
  });
  test('respects the per-day cap, rolling to the next day', () => {
    const t = [R.londonInstant('2026-11-04', 9, 0), R.londonInstant('2026-11-04', 12, 0), R.londonInstant('2026-11-04', 18, 0)];
    assert.equal(lh(R.allocateSlot({ ...base, taken: t })!).ymd, '2026-11-05');
  });
  test('stays inside the posting window and never in the past', () => {
    for (let h = 0; h < 24; h += 3) { const s = R.allocateSlot({ ...base, preferredHour: h })!; const p = lh(s); assert.ok(p.hour >= 8 && p.hour * 60 + p.minute <= 20 * 60); assert.ok(s.getTime() >= NOW.getTime() + 30 * 60_000); }
  });
  test('an alert (no preferred hour) takes the first free slot at least 30 minutes away', () => {
    const early = new Date('2026-11-04T09:10:00Z'); const s = R.allocateSlot({ ...base, now: early, preferredHour: null })!;
    assert.ok(s.getTime() >= early.getTime() + 30 * 60_000);
  });
  test('returns null when the horizon is full', () => {
    const full = [0, 1, 2, 3].flatMap((d) => [9, 12, 18].map((h) => R.londonInstant(`2026-11-0${4 + d}`, h, 0)));
    assert.equal(R.allocateSlot({ ...base, taken: full }), null);
  });
  test('summer time: 12:00 London is 11:00 UTC in July and 12:00 UTC in January', () => {
    assert.equal(R.londonInstant('2026-07-15', 12, 0).toISOString(), '2026-07-15T11:00:00.000Z');
    assert.equal(R.londonInstant('2026-01-15', 12, 0).toISOString(), '2026-01-15T12:00:00.000Z');
    assert.equal(R.londonInstant('2026-03-29', 12, 0).toISOString(), '2026-03-29T11:00:00.000Z', 'clocks went forward that morning');
  });
  test('jitter never breaks the gap or the window', () => {
    for (let i = 0; i < 50; i++) {
      const t = [R.londonInstant('2026-11-04', 10, 0)];
      const s = R.allocateSlot({ ...base, taken: t, rand: seeded() })!;
      assert.ok(Math.abs(s.getTime() - t[0].getTime()) >= 120 * 60_000);
    }
  });
});

/* ── 9. orchestration: no flood, spacing, dedupe, backlog untouched ───────────────────────────────────────────── */
const backlog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `old-${i}`, kind: i % 5 === 0 ? 'jobs_roundup' : 'wird_of_day', entity_id: `old-${i}`, status: 'draft', caption: `old ${i}`, scheduled_for: ago(3 + i), created_at: ago(3 + i), error: null }));
describe('Composer orchestration', () => {
  test('all seven recipes are disabled by default and compose nothing', async () => {
    const w = world({ notices: [notice(1)], alerts: [alert(2)] }); const out = await compose(w);
    assert.equal(R.NEW_KINDS.reduce((s, k) => s + out[k], 0), 0); assert.equal(posts(w).length, 0);
  });
  test('enabling every recipe with abundant content yields a few spaced drafts, not a flood', async () => {
    const w = world({ notices: Array.from({ length: 30 }, (_, i) => notice(200 + i)), alerts: [alert(300), alert(301)] });
    w.db.tables.memories = Array.from({ length: 20 }, (_, i) => memory(400 + i)); w.db.tables.social_promotion_permissions = w.db.table('memories').map((m) => ({ entity_type: 'memory', entity_id: m.id, allowed: true }));
    w.db.tables.local_businesses = Array.from({ length: 20 }, (_, i) => biz(500 + i)); w.db.tables.hubs = Array.from({ length: 6 }, (_, i) => hub(600 + i));
    w.db.tables.cruise_visits = [visit(700)];
    enable(w, ...R.NEW_KINDS);
    const out = await compose(w);   // a Wednesday: memories, hubs run; business (Tue/Fri) and games (Thu/Sun) do not
    const made = posts(w);
    assert.ok(made.length <= 3, `one run is capped at a day's worth, got ${made.length}`);
    assert.ok(Object.values(out.skipped).some((r) => /run budget/.test(String(r))), 'the rest wait for later runs');
    const times = made.map((p) => new Date(p.scheduled_for).getTime()).sort();
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 120 * 60_000, 'gap respected');
    const perDay = new Map<string, number>(); made.forEach((p) => { const d = R.londonParts(new Date(p.scheduled_for)).ymd; perDay.set(d, (perDay.get(d) ?? 0) + 1); });
    assert.ok([...perDay.values()].every((n) => n <= 3));
    assert.ok(made.every((p) => p.status === 'draft'), 'autopilot is off');
    for (const k of R.NEW_KINDS) assert.ok(out[k] <= 1, `${k} at most one per run`);
  });
  test('the 125-post backlog is never approved, rescheduled, skipped or counted against the new recipes', async () => {
    const w = world({ notices: [notice(1)] });
    w.db.tables.social_posts = backlog(125); const snap = JSON.stringify(w.db.tables.social_posts);
    enable(w, 'notice_update');
    const out = await compose(w);
    assert.equal(out.notice_update, 1);
    assert.equal(JSON.stringify(w.db.tables.social_posts.slice(0, 125)), snap, 'every old row byte-identical');
    assert.equal(w.db.tables.social_posts.length, 126);
    assert.equal(w.db.log.filter((l) => l.op === 'update').every((l) => l.payload.n === 0 || l.table === 'social_recipes'), true, 'no existing post updated');
  });
  test('a second run the same day creates nothing more (dedupe + pending cap)', async () => {
    const w = world({ notices: Array.from({ length: 5 }, (_, i) => notice(10 + i)) }); enable(w, 'notice_update');
    await compose(w); const n1 = posts(w).length; const r2 = await compose(w); const r3 = await compose(w);
    assert.deepEqual([...r2.errors, ...r3.errors], [], 'duplicates are filtered before insert, not rejected by the unique index');
    assert.ok(posts(w).length <= n1 + 2); assert.equal(new Set(posts(w).map((p) => p.entity_id)).size, posts(w).length, 'no duplicate entity');
  });
  test('pending cap: unreviewed drafts stop further drafting instead of piling up', async () => {
    const w = world({ notices: Array.from({ length: 10 }, (_, i) => notice(20 + i)) }); enable(w, 'notice_update');
    w.db.tables.social_posts = [1, 2, 3].map((i) => ({ kind: 'notice_update', entity_id: `p${i}`, status: 'draft', scheduled_for: ahead(1), created_at: ago(1) }));
    const out = await compose(w); assert.equal(out.notice_update, 0); assert.match(out.skipped.notice_update, /awaiting/);
  });
  test('its own stale unreviewed drafts are retired, so they cannot become another backlog', async () => {
    const w = world(); enable(w, 'notice_update');
    w.db.tables.social_posts = [{ id: 's1', kind: 'notice_update', entity_id: 'a', status: 'draft', scheduled_for: ago(3), created_at: ago(4) }, { id: 'o1', kind: 'wird_of_day', entity_id: 'b', status: 'draft', scheduled_for: ago(3), created_at: ago(4) }];
    await compose(w);
    assert.equal(w.db.tables.social_posts.find((p) => p.id === 's1')!.status, 'skipped');
    assert.equal(w.db.tables.social_posts.find((p) => p.id === 'o1')!.status, 'draft', 'an older recipe’s draft is left alone');
  });
  test('weekday gating: Tue/Fri recipes do not run on a Wednesday; force overrides', async () => {
    const w = world(); w.db.tables.local_businesses = [biz(1)]; enable(w, 'business_spotlight');
    assert.equal((await compose(w)).business_spotlight, 0);
    assert.equal((await compose(w, { force: true })).business_spotlight, 1);
  });
  test('weekly limit for notices', async () => {
    const w = world({ notices: Array.from({ length: 8 }, (_, i) => notice(30 + i)) }); enable(w, 'notice_update');
    w.recipes.get('notice_update').config = { max_pending: 99, max_per_week: 2 };
    w.db.tables.social_posts = [1, 2].map((i) => ({ kind: 'notice_update', entity_id: `q${i}`, status: 'posted', scheduled_for: ago(2), created_at: ago(2), posted_at: ago(2) }));
    const out = await compose(w); assert.equal(out.notice_update, 0); assert.equal(out.skipped.notice_update, 'weekly limit');
  });
  test('autopilot ON only changes the status; spacing, caps and dedupe still apply', async () => {
    const w = world({ notices: [notice(1), notice(2)], recipes: { notice_update: { enabled: true, autopilot: true } } });
    const out = await compose(w); assert.equal(out.notice_update, 1); assert.equal(posts(w)[0].status, 'scheduled');
    assert.ok(new Date(posts(w)[0].scheduled_for).getTime() > NOW.getTime());
  });
  test('scheduled times are in the future and inside the window', async () => {
    const w = world({ notices: [notice(1)] }); enable(w, 'notice_update'); await compose(w);
    const t = new Date(posts(w)[0].scheduled_for); const p = R.londonParts(t);
    assert.ok(t.getTime() > NOW.getTime()); assert.ok(p.hour >= 8 && p.hour <= 20);
  });
  test('posts already queued by the older recipes occupy slots, so the new ones keep clear of them', async () => {
    const w = world({ notices: [notice(1)] }); enable(w, 'notice_update');
    const noon = R.londonInstant('2026-11-04', 12, 0);
    w.db.tables.social_posts = [{ kind: 'wird_of_day', entity_id: 'w', status: 'scheduled', scheduled_for: iso(noon), created_at: ago(0) }];
    await compose(w);
    const mine = posts(w).find((p) => p.kind === 'notice_update')!;
    assert.ok(Math.abs(new Date(mine.scheduled_for).getTime() - noon.getTime()) >= 120 * 60_000);
  });
  test('AI warm-up only for non-factual kinds, and a rewrite that loses the link is rejected', async () => {
    const w = world(); w.db.tables.hubs = [hub(1)]; w.recipes.get('hub_community').config = { polish: true }; enable(w, 'hub_community');
    await compose(w, { force: true, polish: async () => 'No link here' });
    assert.ok(posts(w)[0].caption.includes('/go/hub/'), 'original template kept');
    const w2 = world(); w2.db.tables.hubs = [hub(2)]; w2.recipes.get('hub_community').config = { polish: true }; enable(w2, 'hub_community');
    await compose(w2, { force: true, polish: async (t: string) => t.replace('HUBS & COMMUNITY 🤝', 'Out and about') });
    assert.match(posts(w2)[0].caption, /^Out and about/);
  });
  test('one recipe failing does not stop the others, and the error is reported', async () => {
    const w = world({ notices: [notice(1)] }); w.db.tables.hubs = [hub(1)]; enable(w, 'notice_update', 'hub_community');
    w.db.failRpcs.add('get_public_notices');
    const out = await compose(w, { force: true });
    assert.ok(out.errors.some((e) => e.startsWith('notice_update'))); assert.equal(out.hub_community, 1);
  });
  test('performance: bounded queries — no per-post fan-out beyond the candidate list', async () => {
    const w = world({ notices: Array.from({ length: 50 }, (_, i) => notice(1000 + i)) }); enable(w, 'notice_update');
    let calls = 0; const orig = w.db.from.bind(w.db); w.db.from = (t: string) => { calls++; return orig(t); };
    await compose(w);
    assert.ok(calls <= 12, `table queries per run: ${calls}`);
  });
});

describe('Database load', () => {
  test('a large directory costs a bounded number of lookups per run, not one per business', async () => {
    const w = world(); w.db.tables.local_businesses = Array.from({ length: 120 }, (_, i) => biz(2000 + i)); w.db.tables.hubs = Array.from({ length: 60 }, (_, i) => hub(3000 + i));
    let hiddenCalls = 0; w.db.rpcs.is_discovery_hidden = () => { hiddenCalls++; return false; };
    const b = await R.selectBusinesses(w.db, R.DEFAULTS.business_spotlight, NOW); const h = await R.selectHubs(w.db, R.DEFAULTS.hub_community, NOW);
    assert.ok(b.length <= 8 && h.length <= 8); assert.ok(hiddenCalls <= 16, `hidden-fixture lookups: ${hiddenCalls}`);
  });
  test('ineligible rows are rejected before any per-row lookup is made', async () => {
    const w = world(); w.db.tables.local_businesses = Array.from({ length: 50 }, (_, i) => biz(4000 + i, { description: 'x' }));
    let calls = 0; w.db.rpcs.is_discovery_hidden = () => { calls++; return false; };
    await R.selectBusinesses(w.db, R.DEFAULTS.business_spotlight, NOW); assert.equal(calls, 0);
  });
});

/* ── 10. publisher: re-checked at the moment of sending ───────────────────────────────────────────────────────── */
const queued = (kind: string, entity_id: string, caption = 'c') => ({ id: 'p', kind, entity_id, caption });
describe('Publish-time revalidation', () => {
  test('a notice that expired, was withdrawn or became sensitive since drafting is invalid', async () => {
    const w = world({ notices: [notice(1)] });
    assert.equal((await R.revalidatePost(w.db, queued('notice_update', U(1)), NOW)).state, 'valid');
    assert.equal((await R.revalidatePost(w.db, queued('notice_update', U(1)), new Date(NOW.getTime() + 20 * 86400_000))).state, 'invalid');
    w.db.table('notices').find((m) => m.id === U(1))!.withdrawn_at = ago(0.1);
    assert.equal((await R.revalidatePost(w.db, queued('notice_update', U(1)), NOW)).state, 'invalid');
    assert.equal((await R.revalidatePost(w.db, queued('notice_update', U(404)), NOW)).state, 'invalid', 'gone entirely');
  });
  test('an alert that ended, was withdrawn or is due review is invalid; a still-active one is valid', async () => {
    const w = world({ alerts: [alert(2)] });
    assert.equal((await R.revalidatePost(w.db, queued('essential_alert', U(2)), NOW)).state, 'valid');
    assert.equal((await R.revalidatePost(w.db, queued('essential_alert', U(2)), new Date(NOW.getTime() + 3 * 86400_000))).state, 'invalid');
    const w2 = world({ alerts: [alert(3, { is_essential_active: false })] });
    assert.equal((await R.revalidatePost(w2.db, queued('essential_alert', U(3)), NOW)).state, 'invalid');
  });
  test('a failed lookup is UNKNOWN (deferred), never silently valid or invalid', async () => {
    const w = world({ alerts: [alert(4)] }); w.db.failRpcs.add('get_public_notices');
    assert.equal((await R.revalidatePost(w.db, queued('essential_alert', U(4)), NOW)).state, 'unknown');
    const w2 = world(); w2.db.failTables.add('memories');
    assert.equal((await R.revalidatePost(w2.db, queued('aald_memory', U(5)), NOW)).state, 'unknown');
  });
  test('memory permission revoked, business unclaimed/opted-out, hub deactivated: invalid', async () => {
    const w = world(); w.db.tables.memories = [memory(6)]; w.db.tables.social_promotion_permissions = [{ entity_type: 'memory', entity_id: U(6), allowed: true }];
    assert.equal((await R.revalidatePost(w.db, queued('aald_memory', U(6)), NOW)).state, 'valid');
    w.db.tables.social_promotion_permissions[0].allowed = false;
    assert.equal((await R.revalidatePost(w.db, queued('aald_memory', U(6)), NOW)).state, 'invalid');
    const wb = world(); wb.db.tables.local_businesses = [biz(7)];
    assert.equal((await R.revalidatePost(wb.db, queued('business_spotlight', `${U(7)}:5`), NOW)).state, 'valid');
    wb.db.tables.local_businesses[0].is_claimed = false;
    assert.equal((await R.revalidatePost(wb.db, queued('business_spotlight', `${U(7)}:5`), NOW)).state, 'invalid');
    const wh = world(); wh.db.tables.hubs = [hub(8)]; wh.db.tables.hub_campaigns = [];
    assert.equal((await R.revalidatePost(wh.db, queued('hub_community', `${U(8)}:3`), NOW)).state, 'valid');
    wh.db.tables.hubs[0].is_active = false;
    assert.equal((await R.revalidatePost(wh.db, queued('hub_community', `${U(8)}:3`), NOW)).state, 'invalid');
  });
  test('a hub post advertising a fundraiser is invalid once that fundraiser cannot take donations', async () => {
    const w = world(); w.db.tables.hubs = [hub(9)];
    w.db.tables.hub_campaigns = [{ id: U(90), hub_id: U(9), title: 'New roof appeal', status: 'active', ends_at: ahead(5) }];
    const p = queued('hub_community', `${U(9)}:3`, 'x\n\nCurrently fundraising: New roof appeal\n\ny');
    assert.equal((await R.revalidatePost(w.db, p, NOW)).state, 'valid');
    w.db.rpcs.campaign_payout_ready = () => false;
    assert.equal((await R.revalidatePost(w.db, p, NOW)).state, 'invalid');
    w.db.rpcs.campaign_payout_ready = () => true; w.db.tables.hub_campaigns[0].status = 'closed';
    assert.equal((await R.revalidatePost(w.db, p, NOW)).state, 'invalid');
  });
  test('a cruise visit that is cancelled or has departed is invalid', async () => {
    const w = world(); w.db.tables.cruise_visits = [visit(10)];
    assert.equal((await R.revalidatePost(w.db, queued('cruise_visit', '2026-11-06'), NOW)).state, 'valid');
    w.db.tables.cruise_visits[0].status = 'cancelled';
    assert.equal((await R.revalidatePost(w.db, queued('cruise_visit', '2026-11-06'), NOW)).state, 'invalid');
    w.db.tables.cruise_visits[0].status = 'scheduled';
    assert.equal((await R.revalidatePost(w.db, queued('cruise_visit', '2026-11-06'), new Date('2026-11-07T00:00:00Z'))).state, 'invalid');
  });
  test('word of the day and hand-written posts are not re-checked at send time (nothing they say can go stale); the other original recipes now are', () => {
    for (const k of ['wird_of_day', 'custom']) assert.equal(R.REVALIDATED_KINDS.has(k), false);
    for (const k of ['whats_on_roundup', 'jobs_roundup', 'new_product', 'event_spotlight']) assert.equal(R.REVALIDATED_KINDS.has(k), true);
  });
});

/* ── 11. wiring: the existing pipeline is intact ──────────────────────────────────────────────────────────────── */
describe('Existing pipeline unchanged', () => {
  const pub = code(read('supabase/functions/social-publisher/index.ts'));
  const comp = code(read('supabase/functions/social-composer/index.ts'));
  test('publisher keeps the 48h stale guard and the 5-per-run cap, and revalidates BEFORE sending', () => {
    assert.match(pub, /const MAX_PER_RUN = 5;/); assert.match(pub, /const STALE_HOURS = 48;/);
    assert.ok(pub.indexOf('STALE_HOURS * 3600_000') < pub.indexOf('revalidatePost(svc, post, now)'), 'stale guard first');
    assert.ok(pub.indexOf('revalidatePost(svc, post, now)') < pub.indexOf('postToFacebook(pageId, token, post)'), 'revalidate before Meta');
    assert.match(pub, /social\.publishing_paused/);
  });
  test('publisher still publishes only approved/scheduled posts that are due, and still marks stale ones skipped', () => {
    assert.match(pub, /\.in\('status', \['approved', 'scheduled'\]\)/); assert.match(pub, /status: 'skipped', error: `stale: scheduled_for more than/);
  });
  test('composer: every existing recipe block, its weekday gate and its status rule are untouched (their hour now goes through the shared slot allocator)', () => {
    for (const marker of ["enabled('wird_of_day')", "enabled('whats_on_roundup')", "enabled('jobs_roundup')", "enabled('new_product')", "enabled('event_spotlight')", "isMonday || force", "isWednesday || force",
      "slotFor('wird_of_day', 8)", "slotFor('whats_on_roundup', 9)", "slotFor('jobs_roundup', 9)", "slotFor('new_product', 11)", "slotFor('event_spotlight', 18)"]) assert.ok(comp.includes(marker), marker);
    assert.match(comp, /status: statusFor\('wird_of_day'\)/);
  });
  test('composer calls the new recipes once, after the existing ones, and cannot let a failure break the run', () => {
    assert.ok(comp.indexOf("enabled('event_spotlight')") < comp.indexOf('composeNewRecipes('));
    assert.match(comp, /try \{\s*newRecipes = await composeNewRecipes/);
  });
  test('neither function can publish a new-kind post without going through revalidation', () => {
    assert.equal((pub.match(/postToFacebook\(/g) ?? []).length, 2, 'definition + the one guarded call');
  });
});

/* ── 12. the migration ────────────────────────────────────────────────────────────────────────────────────────── */
describe('Migration 20261202000000', () => {
  const sql = code(read('supabase/migrations/20261202000000_social_recipes_expansion.sql'));
  test('adds all six new kinds to the check and keeps the old ones', () => {
    for (const k of ['notice_update', 'essential_alert', 'aald_memory', 'hub_community', 'game_challenge', 'cruise_visit', 'wird_of_day', 'whats_on_roundup', 'event_spotlight', 'jobs_roundup', 'new_product', 'business_spotlight', 'custom']) assert.ok(sql.includes(`'${k}'`), k);
  });
  test('seeds exactly seven recipes, all disabled and autopilot off', () => {
    const seeds = [...sql.matchAll(/^\s*\('([a-z_]+)',\s*'[^']*',\s*(true|false),\s*(true|false),/gm)];
    assert.deepEqual(seeds.map((m) => m[1]).sort(), [...R.NEW_KINDS].sort());
    assert.ok(seeds.every((m) => m[2] === 'false' && m[3] === 'false'));
  });
  test('does not touch existing posts, existing recipes or their schedules', () => {
    assert.doesNotMatch(sql, /update\s+public\.social_posts|delete\s+from\s+public\.social_posts|update\s+public\.social_recipes|delete\s+from\s+public\.social_recipes/i);
    assert.match(sql, /on conflict \(key\) do nothing/);
  });
  test('essential alerts are locked off autopilot in the database', () => {
    assert.match(sql, /kind <> 'essential_alert' or status <> 'scheduled'/); assert.match(sql, /new\.key = 'essential_alert' and new\.autopilot is true/);
  });
  test('config defaults in the migration match the code defaults', () => {
    for (const k of R.NEW_KINDS) {
      const m = sql.match(new RegExp(`\\('${k}',[^']*'[^']*',\\s*false,\\s*false,\\s*'(\\{[^']*\\})'`));
      assert.ok(m, k); const cfg = JSON.parse(m![1]);
      for (const key of Object.keys(R.DEFAULTS[k])) if (key !== 'games') assert.deepEqual(cfg[key], (R.DEFAULTS[k] as any)[key], `${k}.${key}`);
    }
  });
});

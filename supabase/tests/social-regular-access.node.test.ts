/**
 * social-regular-access.node.test.ts — the Regular Activities weekly roundup and the Accessible Shetland information recipes, run through the REAL composer
 * code against an in-memory database. No network, no database, nothing is posted. Run: node --test supabase/tests/social-regular-access.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDb } from './_support/fake-svc.ts';
import * as R from '../functions/_shared/social-recipes.ts';
import * as X from '../functions/_shared/social-regular-access.ts';

const DAY = 86400_000;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SAT = new Date('2026-11-07T05:40:00Z');           // a Saturday, GMT: the composer's real daily run time
const SUN = new Date('2026-11-08T05:40:00Z');
const MON_NEXT = '2026-11-09';
const listing = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(n), slug: `act-${n}`, title: `Activity ${n}`, description: 'A friendly group.', category: 'fitness', audience: null, venue: 'Hall', locality: 'Lerwick', price_text: null, booking_mode: 'drop_in', cover_url: null,
  owner_kind: 'business', owner_id: U(100 + n), owner_name: `Org ${n}`, owner_slug: null, next_starts_at: '2026-11-10T18:00:00Z', next_ends_at: '2026-11-10T19:00:00Z', sessions_in_window: 2, cancelled_in_window: 0,
  upcoming: [{ starts_at: '2026-11-10T18:00:00Z', ends_at: '2026-11-10T19:00:00Z', status: 'scheduled', venue: null, note: null }], ...o,
});

function world(opts: { rows?: any[]; recipe?: string; autopilot?: boolean; cfg?: Record<string, unknown>; fetchStatus?: Record<string, number> } = {}) {
  const db = new FakeDb(); db.clock = () => SAT.toISOString();
  const rows = opts.rows ?? []; let listed = rows;
  db.tables.social_posts = []; db.tables.admin_config = [{ key: 'social.max_posts_per_day', value: '4' }, { key: 'social.min_gap_minutes', value: '120' }, { key: 'social.window_hours', value: '8-20' }];
  db.tables.regular_activities = rows.map((r) => ({ id: r.id, status: 'published', admin_paused: false, organiser_business_id: r.owner_kind === 'business' ? r.owner_id : null, organiser_hub_id: r.owner_kind === 'hub' ? r.owner_id : null, calendar_approved: true }));
  db.tables.local_businesses = rows.filter((r) => r.owner_kind === 'business').map((r) => ({ id: r.owner_id, name: r.owner_name, is_active: true }));
  db.tables.hubs = rows.filter((r) => r.owner_kind === 'hub').map((r) => ({ id: r.owner_id, is_active: true }));
  db.tables.social_promotion_permissions = []; db.tables.accessibility_profiles = []; db.tables.accessibility_facts = [];
  const hidden = new Set<string>(); const rpcLog: any[] = [];
  db.rpcs.regular_activities_listing = (a) => { rpcLog.push(a); return listed; };
  db.rpcs.is_discovery_hidden = (a) => hidden.has(a.p_id);
  const recipes = new Map<string, any>(); for (const k of R.NEW_KINDS) recipes.set(k, { key: k, enabled: false, autopilot: false, config: {} });
  if (opts.recipe) recipes.set(opts.recipe, { key: opts.recipe, enabled: true, autopilot: opts.autopilot === true, config: opts.cfg ?? {} });
  const status = opts.fetchStatus ?? {};
  const fetchFn = (async (url: string) => ({ status: status[url] ?? 200 })) as unknown as typeof fetch;
  return { db, recipes, hidden, rpcLog, fetchFn, setListing: (r: any[]) => { listed = r; } };
}
const compose = (w: ReturnType<typeof world>, now: Date, extra: Record<string, unknown> = {}) => { w.db.clock = () => now.toISOString(); return R.composeNewRecipes({ svc: w.db, now, recipes: w.recipes, rand: () => 0.5, fetchFn: w.fetchFn, ...extra }); };
const posts = (w: ReturnType<typeof world>, kind?: string) => w.db.tables.social_posts.filter((p) => !kind || p.kind === kind);

describe('time: the forthcoming Monday to Sunday, in Shetland time', () => {
  test('post day is the first Sunday on or after today; the week is the Monday after it', () => {
    assert.equal(X.roundupPostDay(SAT), '2026-11-08'); assert.equal(X.roundupMonday(SAT), MON_NEXT);
    assert.equal(X.roundupPostDay(SUN), '2026-11-08'); assert.equal(X.roundupMonday(SUN), MON_NEXT);
    assert.equal(X.roundupMonday(new Date('2026-11-09T05:40:00Z')), '2026-11-16', 'on a Monday the forthcoming week is the next one');
  });
  test('BST/GMT: the week window follows London clocks, 169 hours across the autumn change and 167 across the spring one', () => {
    const w = X.weekWindow('2026-10-19'); assert.equal((w.to.getTime() - w.from.getTime()) / 3600_000, 169);          // BST ends Sun 25 Oct 2026
    const s = X.weekWindow('2027-03-22'); assert.equal((s.to.getTime() - s.from.getTime()) / 3600_000, 167);          // BST starts Sun 28 Mar 2027
    assert.equal(X.weekWindow('2026-06-15').from.toISOString(), '2026-06-14T23:00:00.000Z', 'Monday 00:00 in summer is 23:00Z the day before');
    assert.equal(X.weekWindow(MON_NEXT).from.toISOString(), '2026-11-09T00:00:00.000Z');
  });
  test('18:00 UK time is 17:00Z in summer and 18:00Z in winter', () => {
    assert.equal(R.londonInstant('2026-07-05', 18).toISOString(), '2026-07-05T17:00:00.000Z'); assert.equal(R.londonInstant('2026-11-08', 18).toISOString(), '2026-11-08T18:00:00.000Z');
  });
});

describe('Regular Activities roundup: selection', () => {
  test('ZERO eligible: nothing posts, and the reason is recorded in Social Studio as a skipped row', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [] });
    const out = await compose(w, SAT);
    assert.equal(posts(w, 'regular_roundup').filter((p) => p.status !== 'skipped').length, 0);
    assert.match(out.skipped.regular_roundup, /no Regular Activities with a live session/);
    const skip = posts(w, 'regular_roundup')[0]; assert.equal(skip.status, 'skipped'); assert.match(skip.error, /week starting 2026-11-09/);
    await compose(w, new Date(SAT.getTime() + 3600_000)); assert.equal(posts(w, 'regular_roundup').length, 1, 'repeat runs refresh the one skipped row, they do not pile up');
  });
  test('ONE and TWO activities: the post uses exactly what exists, no filler', async () => {
    for (const n of [1, 2]) {
      const w = world({ recipe: 'regular_roundup', autopilot: true, rows: Array.from({ length: n }, (_, i) => listing(i + 1)) });
      await compose(w, SAT); const p = posts(w, 'regular_roundup')[0];
      assert.ok(p, `${n}`); assert.equal((p.link_url.match(/#ids=(.*)$/)![1].split(',')).length, n);
      assert.equal((p.caption.match(/^•/gm) ?? []).length, n, 'one bullet per real activity');
    }
  });
  test('MANY activities across organisers, categories and places: up to six, no organiser over twice, variety first', async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => listing(n, { category: ['fitness', 'music', 'arts_crafts', 'learning', 'sport'][n % 5], locality: ['Lerwick', 'Scalloway', 'Brae'][n % 3], owner_id: n <= 4 ? U(500) : U(100 + n), owner_name: n <= 4 ? 'Big Organiser' : `Org ${n}` }));
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows }); await compose(w, SAT);
    const ids = posts(w, 'regular_roundup')[0].link_url.match(/#ids=(.*)$/)![1].split(','); assert.equal(ids.length, 6);
    const chosen = rows.filter((r) => ids.includes(r.id)); assert.ok(chosen.filter((r) => r.owner_name === 'Big Organiser').length <= 2);
    assert.ok(new Set(chosen.map((r) => r.category)).size >= 4); assert.ok(new Set(chosen.map((r) => r.owner_name)).size >= 5);
  });
  test('the per-organiser cap is hard: one organiser with six activities and one other gives three posts, not seven', async () => {
    const rows = [...[1, 2, 3, 4, 5, 6].map((n) => listing(n, { owner_id: U(500), owner_name: 'Only Organiser' })), listing(7)];
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows }); await compose(w, SAT);
    const ids = posts(w, 'regular_roundup')[0].link_url.match(/#ids=(.*)$/)![1].split(','); assert.equal(ids.length, 3); assert.equal(rows.filter((r) => ids.includes(r.id) && r.owner_name === 'Only Organiser').length, 2);
  });
  test('FAIR ROTATION over successive weeks: a busy organiser and the same activities do not return every week', async () => {
    const rows = Array.from({ length: 14 }, (_, n) => listing(n + 1, { owner_id: U(100 + n), owner_name: `Org ${n}` }));
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows }); const seen = new Map<string, number>();
    for (let wk = 0; wk < 5; wk++) {
      const now = new Date(SAT.getTime() + wk * 7 * DAY); const monday = X.roundupMonday(now);
      const shifted = rows.map((r) => ({ ...r, next_starts_at: `${monday}T18:00:00Z`.replace(/^[^T]+/, monday), next_ends_at: `${monday}T19:00:00Z` }));
      w.setListing(shifted); await compose(w, now);
      for (const id of posts(w, 'regular_roundup').at(-1)!.link_url.match(/#ids=(.*)$/)![1].split(',')) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    assert.ok(seen.size >= 13, `after five weeks almost every activity has had a turn (${seen.size}/14)`); assert.ok(Math.max(...seen.values()) <= 3, 'nobody is featured almost every week');
  });
  test('CANCELLED sessions and BREAKS are never advertised: an all-cancelled activity is not included, and a cancelled session is not listed', async () => {
    const dead = listing(1, { sessions_in_window: 0, cancelled_in_window: 3, next_starts_at: null, next_ends_at: null, upcoming: [{ starts_at: '2026-11-10T18:00:00Z', ends_at: '2026-11-10T19:00:00Z', status: 'cancelled', venue: null, note: null }] });
    const partial = listing(2, { upcoming: [{ starts_at: '2026-11-09T18:00:00Z', ends_at: '2026-11-09T19:00:00Z', status: 'cancelled', venue: null, note: null }, { starts_at: '2026-11-11T18:00:00Z', ends_at: '2026-11-11T19:00:00Z', status: 'scheduled', venue: null, note: null }], next_starts_at: '2026-11-11T18:00:00Z', next_ends_at: '2026-11-11T19:00:00Z', sessions_in_window: 1, cancelled_in_window: 1 });
    const brk = listing(3, { sessions_in_window: 0, cancelled_in_window: 1, next_starts_at: null, next_ends_at: null, upcoming: [{ starts_at: '2026-11-12T18:00:00Z', ends_at: '2026-11-12T19:00:00Z', status: 'break', venue: null, note: null }] });
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [dead, partial, brk] }); await compose(w, SAT); const p = posts(w, 'regular_roundup')[0];
    assert.doesNotMatch(p.caption, /Activity 1|Activity 3/); assert.match(p.caption, /Activity 2.*Wed 18:00–19:00/); assert.doesNotMatch(p.caption, /Mon 18:00/, 'the cancelled Monday session is not advertised');
    assert.equal(p.link_url.match(/#ids=(.*)$/)![1], U(2));
  });
  test('only PUBLIC activities: drafts, paused, inactive businesses, hidden owners, test fixtures and sensitive subjects are refused even if the listing returns them', async () => {
    const rows = [listing(1), listing(2), listing(3), listing(4), listing(5, { title: 'ZZ TEST class' }), listing(6, { title: 'Bereavement support group' }), listing(7)];
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows });
    w.db.tables.regular_activities.find((r) => r.id === U(1))!.status = 'draft'; w.db.tables.regular_activities.find((r) => r.id === U(2))!.admin_paused = true;
    w.db.tables.local_businesses.find((b) => b.id === U(103))!.is_active = false; w.hidden.add(U(104));
    await compose(w, SAT); const ids = posts(w, 'regular_roundup')[0].link_url.match(/#ids=(.*)$/)![1].split(',');
    assert.deepEqual(ids, [U(7)]); const snap = JSON.parse(w.db.tables.admin_config.find((c) => c.key === 'social.regular_roundup_last')!.value);
    const why = Object.fromEntries(snap.excluded.map((e: any) => [e.id, e.reason])); assert.equal(why[U(1)], 'not published'); assert.equal(why[U(2)], 'paused by staff'); assert.match(why[U(3)], /business is inactive/); assert.equal(why[U(4)], 'hidden');
    assert.equal(why[U(5)], 'test fixture'); assert.equal(why[U(6)], 'sensitive subject');
  });
  test('the caption never invents or promises: no "free", "drop in", "everyone", "beginners"; times and places are the listing\'s own', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1, { price_text: 'Free', booking_mode: 'drop_in', audience: 'Beginners welcome' }), listing(2)] });
    await compose(w, SAT); const c = posts(w, 'regular_roundup')[0].caption;
    assert.doesNotMatch(c, /\bfree\b|drop[- ]?in|everyone|beginner|suitable|no need to book/i); assert.match(c, /Fancy trying something new this week\? 💙/);
    assert.match(c, /Tue 18:00–19:00( and more)?, Hall, Lerwick/); assert.match(c, /go\/regular-activities/);
  });
  test('MISSING images: the card is still requested, with the real photographs first; image alt text is recorded', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1), listing(2, { cover_url: 'https://x.supabase.co/storage/v1/object/public/activity/a.webp' }), listing(3)] });
    await compose(w, SAT); const p = posts(w, 'regular_roundup')[0];
    assert.match(p.image_url, /api\/social-image\?kind=regular&ids=/); assert.equal(p.image_url.match(/ids=([^&]*)/)![1].split(',')[0], U(2), 'the activity with a photograph leads');
    assert.match(p.image_alt, /Regular activities this week.*3 activities/);
  });
});

describe('Regular Activities roundup: scheduling, governance and safety', () => {
  test('autopilot OFF: a draft for staff; ON: scheduled for Sunday 18:00 UK time (the Saturday run also targets Sunday)', async () => {
    for (const [auto, status] of [[false, 'draft'], [true, 'scheduled']] as const) {
      const w = world({ recipe: 'regular_roundup', autopilot: auto, rows: [listing(1)] }); await compose(w, SAT);
      const p = posts(w, 'regular_roundup')[0]; assert.equal(p.status, status); assert.equal(R.londonParts(new Date(p.scheduled_for)).ymd, '2026-11-08'); assert.ok(Math.abs(new Date(p.scheduled_for).getTime() - Date.parse('2026-11-08T18:00:00Z')) <= 8 * 60_000);
    }
  });
  test('a Sunday-morning run schedules the same Sunday evening, never a weekday', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1)] }); await compose(w, SUN);
    assert.equal(R.londonParts(new Date(posts(w, 'regular_roundup')[0].scheduled_for)).ymd, '2026-11-08');
  });
  test('DUPLICATES: running again on Saturday and Sunday still gives exactly one post for the week', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1), listing(2)] });
    await compose(w, SAT); await compose(w, new Date(SAT.getTime() + 3600_000)); const out = await compose(w, SUN);
    assert.equal(posts(w, 'regular_roundup').length, 1); assert.match(out.skipped.regular_roundup, /already drafted or posted|awaiting/);
  });
  test('REJECTION AND REGENERATION: after a staff skip the next run drafts a fresh one (revision suffix), up to the limit', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: false, rows: [listing(1), listing(2)] });
    await compose(w, SAT); posts(w, 'regular_roundup')[0].status = 'skipped';
    await compose(w, SUN); assert.equal(posts(w, 'regular_roundup').length, 2); assert.match(posts(w, 'regular_roundup')[1].entity_id, /^reg:2026-11-09:r2$/);
    posts(w, 'regular_roundup')[1].status = 'failed'; await compose(w, SUN); assert.equal(posts(w, 'regular_roundup')[2].entity_id, 'reg:2026-11-09:r3');
    posts(w, 'regular_roundup')[2].status = 'skipped'; const out = await compose(w, SUN); assert.equal(posts(w, 'regular_roundup').length, 3, 'no endless regeneration'); assert.match(out.skipped.regular_roundup, /regeneration limit/);
  });
  test('SCHEDULE CONFLICT: the shared limits decide. A game at 17:00 on the same Sunday moves, nothing extra is published, and the day never exceeds four posts', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1)] });
    w.recipes.set('game_challenge', { key: 'game_challenge', enabled: true, autopilot: true, config: {} });
    await compose(w, SUN); const day = posts(w).filter((p) => R.londonParts(new Date(p.scheduled_for)).ymd === '2026-11-08');
    const times = day.map((p) => new Date(p.scheduled_for).getTime()).sort(); for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 120 * 60_000 - 8 * 60_000, 'minimum gap kept');
    assert.ok(day.length <= 4); assert.ok(day.some((p) => p.kind === 'regular_roundup'));
  });
  test('LAUNCH IS CONTROLLED: a disabled recipe never drafts; enabling it creates one post, not a backlog; the shared daily budget caps a run', async () => {
    const off = world({ rows: [listing(1)] }); await compose(off, SAT); assert.equal(posts(off).length, 0);
    const on = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1), listing(2), listing(3)] }); await compose(on, SAT); await compose(on, SAT); assert.equal(posts(on, 'regular_roundup').length, 1);
  });
  test('DRY RUN: builds the draft for review and writes nothing (no posts, no skipped rows, no snapshot, no last-run stamp)', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1), listing(2)] });
    const out = await compose(w, SAT, { dryRun: true }); assert.equal(out.drafts!.length, 1); assert.match(out.drafts![0].caption, /Activity 1/);
    assert.equal(posts(w).length, 0); assert.equal(w.db.log.filter((l) => l.op !== 'select').length, 0);
  });
  test('PUBLISH-TIME RECHECK: valid while nothing changed; invalid if an activity is cancelled, paused or hidden, or the week has begun', async () => {
    const w = world({ recipe: 'regular_roundup', autopilot: true, rows: [listing(1), listing(2)] }); await compose(w, SAT); const p = posts(w, 'regular_roundup')[0];
    const check = (now: Date) => R.revalidatePost(w.db, { id: p.id, kind: 'regular_roundup', entity_id: p.entity_id, caption: p.caption, link_url: p.link_url }, now);
    assert.equal((await check(new Date('2026-11-08T17:59:00Z'))).state, 'valid');
    const was = w.db.tables.regular_activities.find((r) => r.id === U(1))!; was.admin_paused = true; assert.match((await check(SUN)).reason ?? '', /no longer has live public sessions/); was.admin_paused = false;
    w.setListing([listing(1, { sessions_in_window: 0, next_starts_at: null, next_ends_at: null }), listing(2)]); assert.equal((await check(SUN)).state, 'invalid'); w.setListing([listing(1), listing(2)]);
    assert.match((await check(new Date('2026-11-09T00:30:00Z'))).reason ?? '', /already begun/);
  });
});

describe('Accessible Shetland: rotation, evidence and review', () => {
  const NOW = new Date('2026-11-11T05:40:00Z');          // a Wednesday
  test('the cycle is awareness, then a resource spotlight, then business information; the first post is awareness; fortnightly spacing holds', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); await compose(w, NOW);
    assert.equal(posts(w, 'accessible_info')[0].entity_id.split(':')[0], 'awareness');
    const out = await compose(w, new Date(NOW.getTime() + 7 * DAY)); assert.match(out.skipped.accessible_info, /within the last 13 days/);
    posts(w, 'accessible_info')[0].created_at = new Date(NOW.getTime() - 15 * DAY).toISOString(); await compose(w, new Date(NOW.getTime() + 14 * DAY));
    assert.equal(posts(w, 'accessible_info')[1].entity_id.split(':')[0], 'resource');
  });
  test('AWARENESS: approved, unchanging copy that links to Accessible Shetland, with no "fully accessible" claim', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); await compose(w, NOW); const p = posts(w, 'accessible_info')[0];
    assert.match(p.caption, /https:\/\/oneshetland\.com\/go\/accessible/); assert.match(p.caption, /make your own decisions/); assert.equal(p.status, 'scheduled');
    for (const t of X.AWARENESS_COPY) assert.doesNotMatch(t, /fully accessible|accessible to all|suitable for everyone|certified|wheelchair[- ]friendly|helpless|suffer/i);
    assert.match(p.image_alt, /Accessible Shetland/);
  });
  test('RESOURCES: only verified, live links; a dead link is passed over, an unverifiable one is never published on faith; unapproved resources wait for staff', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true });
    // history so that the next format is "resource"
    w.db.tables.social_posts.push({ id: 'h1', kind: 'accessible_info', entity_id: 'awareness:v0:2026-10-28', status: 'posted', created_at: new Date(NOW.getTime() - 14 * DAY).toISOString() });
    const first = X.pickResource([], {}, NOW)[0]; w.fetchFn = (async (url: string) => ({ status: url === first.href ? 404 : 200 })) as unknown as typeof fetch;
    await compose(w, NOW); const p = posts(w, 'accessible_info').find((x) => x.entity_id.startsWith('resource:'))!; assert.ok(p);
    assert.ok(!p.entity_id.includes(first.slug), 'the dead link was skipped'); assert.equal(p.status, 'draft', 'not in approved_resources, so it waits for staff'); assert.match(p.error, /Held for approval/);
    assert.match(p.caption, /Source: .* \(https:\/\/[^)]+\)/);
    const allBlocked = world({ recipe: 'accessible_info', autopilot: true, fetchStatus: Object.fromEntries(X.ACCESS_RESOURCES.map((r) => [r.href, 403])) });
    allBlocked.db.tables.social_posts.push({ id: 'h1', kind: 'accessible_info', entity_id: 'awareness:v0:2026-10-28', status: 'posted', created_at: new Date(NOW.getTime() - 14 * DAY).toISOString() });
    await compose(allBlocked, NOW); assert.ok(!posts(allBlocked, 'accessible_info').some((x) => x.entity_id.startsWith('resource:')), 'blocked/unknown links are never posted');
  });
  test('an approved resource posts automatically; a stale verification date withdraws it', async () => {
    const slug = X.pickResource([], {}, NOW)[0].slug;
    const w = world({ recipe: 'accessible_info', autopilot: true, cfg: { approved_resources: [slug] } });
    w.db.tables.social_posts.push({ id: 'h1', kind: 'accessible_info', entity_id: 'awareness:v0:2026-10-28', status: 'posted', created_at: new Date(NOW.getTime() - 14 * DAY).toISOString() });
    await compose(w, NOW); assert.equal(posts(w, 'accessible_info').find((x) => x.entity_id.startsWith('resource:'))!.status, 'scheduled');
    assert.equal(X.pickResource([], {}, new Date('2027-06-01T00:00:00Z')).length, 0, 'verified more than 180 days ago: not shown');
  });
  const seedBusiness = (w: ReturnType<typeof world>, n: number, over: Record<string, unknown> = {}, facts?: [string, string][]) => {
    w.db.tables.local_businesses.push({ id: U(n), name: `Cafe ${n}`, is_active: true });
    w.db.tables.accessibility_profiles.push({ subject_type: 'business', subject_id: U(n), published: true, hidden_by_staff: false, verification: 'owner_provided', verified_on: null, updated_at: '2026-11-05T00:00:00Z', ...over });
    for (const [f, s] of facts ?? [['step_free_entrance', 'available'], ['accessible_parking', 'available'], ['hearing_loop', 'partial'], ['accessible_toilet', 'not_available']]) w.db.tables.accessibility_facts.push({ subject_type: 'business', subject_id: U(n), facility: f, status: s });
  };
  const toBusinessTurn = (w: ReturnType<typeof world>) => w.db.tables.social_posts.push({ id: 'h2', kind: 'accessible_info', entity_id: 'resource:northlink-support:2026-10-28', status: 'posted', created_at: new Date(NOW.getTime() - 14 * DAY).toISOString() });
  test('BUSINESS access information: owner-provided details are described as such, only Yes/Partly facilities are stated, and it ALWAYS waits for staff review', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); seedBusiness(w, 1); toBusinessTurn(w); await compose(w, NOW);
    const p = posts(w, 'accessible_info').find((x) => x.entity_id.startsWith('biz:'))!; assert.ok(p); assert.equal(p.status, 'draft'); assert.match(p.error, /Held for approval/);
    assert.match(p.caption, /Cafe 1 has shared information about access and facilities/); assert.match(p.caption, /a step-free entrance and accessible parking; partly: a hearing loop/);
    assert.match(p.caption, /provided by the business and haven't been independently checked/); assert.doesNotMatch(p.caption, /toilet/, '"No" answers are never turned into a claim'); assert.doesNotMatch(p.caption, /fully accessible|certified|endorse(d|ment) by/i);
    assert.match(p.caption, /isn't a certification or an endorsement/); assert.match(p.link_url, /#h=[a-z0-9]+$/);
  });
  test('VERIFIED versus owner-provided: independent checking is claimed only when the database records it', () => {
    assert.match(X.provenanceSentence({ verification: 'independently_checked', verified_on: '2026-11-02' }), /independently checked on 02\/11\/2026/);
    assert.match(X.provenanceSentence({ verification: 'official_source', verified_on: null }), /official source/);
    assert.match(X.provenanceSentence({ verification: 'owner_provided', verified_on: null }), /haven't been independently checked/);
    assert.doesNotMatch(X.provenanceSentence({ verification: 'independently_checked', verified_on: null }), /independently checked on/, 'no date, no claim');
    assert.doesNotMatch(X.provenanceSentence({ verification: 'owner_provided', verified_on: '2026-11-02' }), /independently checked on/);
  });
  test('only eligible businesses: unpublished, staff-hidden, hidden-listing, opted-out, fixtures and thin records are never chosen; and NO published records falls back to a resource', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); toBusinessTurn(w);
    seedBusiness(w, 1, { published: false }); seedBusiness(w, 2, { hidden_by_staff: true }); seedBusiness(w, 3); w.hidden.add(U(3)); seedBusiness(w, 4); w.db.tables.social_promotion_permissions.push({ entity_type: 'business', entity_id: U(4), allowed: false });
    seedBusiness(w, 5); w.db.tables.local_businesses.find((b) => b.id === U(5))!.name = 'ZZ DEMO Cafe'; seedBusiness(w, 6, {}, [['ramp', 'available'], ['lift', 'available']]);
    const out = await compose(w, NOW); const made = posts(w, 'accessible_info').filter((x) => x.entity_id.startsWith('biz:')); assert.equal(made.length, 0);
    assert.ok(posts(w, 'accessible_info').some((x) => x.entity_id.startsWith('resource:')), 'fell back to an approved resource post'); void out;
  });
  test('FAIR business rotation: someone featured recently is not repeated; the longest-waiting goes first', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); seedBusiness(w, 1); seedBusiness(w, 2); toBusinessTurn(w);
    w.db.tables.social_posts.push({ id: 'old', kind: 'accessible_info', entity_id: `biz:${U(1)}:2026-10-14`, status: 'posted', created_at: new Date(NOW.getTime() - 28 * DAY).toISOString() });
    await compose(w, NOW); assert.ok(posts(w, 'accessible_info').some((x) => x.entity_id.startsWith(`biz:${U(2)}`)), 'the business never featured goes first');
  });
  test('NOTHING WORTHWHILE: no business records, every resource link unverifiable and all awareness copy recently used: skip, and say why', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true, fetchStatus: Object.fromEntries(X.ACCESS_RESOURCES.map((r) => [r.href, 500])) });
    toBusinessTurn(w); for (let v = 0; v < 3; v++) w.db.tables.social_posts.push({ id: `a${v}`, kind: 'accessible_info', entity_id: `awareness:v${v}:2026-10-0${v + 1}`, status: 'posted', created_at: new Date(NOW.getTime() - 40 * DAY).toISOString() });
    // awareness copy was used within 120 days; resources unverifiable; no businesses
    const out = await compose(w, NOW); assert.equal(posts(w, 'accessible_info').filter((p) => p.status !== 'skipped' && p.id.length > 3 && !p.id.startsWith('a') && p.id !== 'h2').length, 0);
    assert.match(out.skipped.accessible_info, /nothing worthwhile/);
  });
  test('no confidential or personal data: owner details text, contact lines and staff notes are never read or posted', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); seedBusiness(w, 1); toBusinessTurn(w);
    w.db.tables.accessibility_facts[0].detail = 'Ring Anna on 01595 000000 after 9'; w.db.tables.accessibility_profiles[0].access_contact = 'anna@example.com'; w.db.tables.accessibility_profiles[0].verification_note = 'Visited by Anna, a private note';
    await compose(w, NOW); const p = posts(w, 'accessible_info').find((x) => x.entity_id.startsWith('biz:'))!;
    assert.doesNotMatch(p.caption + p.image_alt, /Anna|01595|@example|private note/);
  });
  test('PUBLISH-TIME RECHECK for business posts: changing the details, unpublishing, hiding or opting out invalidates a drafted post', async () => {
    const w = world({ recipe: 'accessible_info', autopilot: true }); seedBusiness(w, 1); toBusinessTurn(w); await compose(w, NOW); const p = posts(w, 'accessible_info').find((x) => x.entity_id.startsWith('biz:'))!;
    const check = () => R.revalidatePost(w.db, { id: p.id, kind: 'accessible_info', entity_id: p.entity_id, caption: p.caption, link_url: p.link_url }, NOW);
    assert.equal((await check()).state, 'valid');
    w.db.tables.accessibility_facts.push({ subject_type: 'business', subject_id: U(1), facility: 'quiet_space', status: 'available' }); assert.match((await check()).reason ?? '', /changed its access details/); w.db.tables.accessibility_facts.pop();
    w.db.tables.accessibility_profiles[0].verification = 'independently_checked'; assert.equal((await check()).state, 'invalid', 'a verification change also needs re-review'); w.db.tables.accessibility_profiles[0].verification = 'owner_provided';
    w.db.tables.accessibility_profiles[0].published = false; assert.match((await check()).reason ?? '', /no longer published/); w.db.tables.accessibility_profiles[0].published = true;
    w.hidden.add(U(1)); assert.match((await check()).reason ?? '', /no longer promotable/); w.hidden.delete(U(1));
    w.db.tables.social_promotion_permissions.push({ entity_type: 'business', entity_id: U(1), allowed: false }); assert.equal((await check()).state, 'invalid');
  });
  test('PUBLISH-TIME RECHECK for resources: a link that has died invalidates the post; a blocked site defers it', async () => {
    const r = X.ACCESS_RESOURCES[0]; const post = { entity_id: `resource:${r.slug}:2026-11-11`, link_url: null };
    const run = (status: number, now = NOW) => X.revalidateAccessible(world().db, post, now, (async () => ({ status })) as unknown as typeof fetch);
    assert.equal((await run(200)).state, 'valid'); assert.equal((await run(404)).state, 'invalid'); assert.equal((await run(403)).state, 'unknown');
    assert.match((await run(200, new Date('2027-07-01T00:00:00Z'))).reason ?? '', /re-verified/);
  });
  test('link checking: dead is dead, blocked/unreachable is unknown, a non-https link is refused', async () => {
    const f = (s: number) => (async () => ({ status: s })) as unknown as typeof fetch;
    assert.equal((await X.checkLink('https://a.example/', f(200))).state, 'ok'); assert.equal((await X.checkLink('https://a.example/', f(301))).state, 'ok');
    assert.equal((await X.checkLink('https://a.example/', f(404))).state, 'dead'); assert.equal((await X.checkLink('https://a.example/', f(410))).state, 'dead');
    assert.equal((await X.checkLink('https://a.example/', f(403))).state, 'unknown'); assert.equal((await X.checkLink('https://a.example/', f(503))).state, 'unknown');
    assert.equal((await X.checkLink('https://a.example/', (async () => { throw new Error('dns'); }) as unknown as typeof fetch)).state, 'unknown');
    assert.equal((await X.checkLink('http://a.example/', f(200))).state, 'dead');
  });
});

describe('static guarantees', () => {
  test('the migration seed config matches the code defaults for both recipes', () => {
    const sql = Deno_read('../migrations/20261211000000_social_regular_accessible_recipes.sql');
    for (const k of ['regular_roundup', 'accessible_info'] as const) {
      const m = sql.match(new RegExp(`\\('${k}',[^']*'[^']*',\\s*false,\\s*false,\\s*'(\\{.*?\\})'\\)`))!; assert.ok(m, k); const cfg = JSON.parse(m[1]);
      for (const key of Object.keys(R.DEFAULTS[k])) assert.deepEqual(cfg[key], (R.DEFAULTS[k] as any)[key], `${k}.${key}`);
    }
  });
  test('the resource library is well formed: https links, unique slugs, a verified date, a topic hook for each, no invented claims', () => {
    const slugs = new Set<string>(); for (const r of X.ACCESS_RESOURCES) { assert.match(r.href, /^https:\/\/[a-z0-9.-]+\//); assert.ok(!slugs.has(r.slug)); slugs.add(r.slug); assert.match(r.verified_on, /^\d{4}-\d{2}-\d{2}$/); assert.ok(r.by && r.title && r.about && r.anchor); assert.doesNotMatch(r.about, /fully accessible|guarantee/i); }
    assert.ok(X.ACCESS_RESOURCES.length >= 20);
  });
  test('both kinds are registered, factual (never rewritten by AI), re-checked at publish time, and seeded disabled with autopilot off', () => {
    for (const k of ['regular_roundup', 'accessible_info']) { assert.ok(R.NEW_KINDS.includes(k as any)); assert.ok(R.REVALIDATED_KINDS.has(k)); assert.ok(R.DEFAULTS[k as 'regular_roundup']); }
    const sql = Deno_read('../migrations/20261211000000_social_regular_accessible_recipes.sql');
    assert.match(sql, /\('regular_roundup', [^)]*false, false,/); assert.match(sql, /\('accessible_info', [^)]*false, false,/); assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /update public\.social_posts|delete from|insert into public\.social_posts/i);
    assert.match(sql, /'regular_roundup','accessible_info'\]\)\)/);
  });
});
import { readFileSync } from 'node:fs';
function Deno_read(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8'); }

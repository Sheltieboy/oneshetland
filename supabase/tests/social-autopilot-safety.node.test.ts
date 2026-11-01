/**
 * social-autopilot-safety.node.test.ts — the fixes that let Autopilot run unattended.
 *
 *   JOBS      expired jobs are out of the count AND the list, and re-checked at send time
 *   EVENTS    nothing that has started (by the time the post goes OUT), been cancelled/hidden, or is awaiting hub calendar approval
 *   PRODUCTS  the Shop's own availableQty() rule + photo + not a fixture, re-checked at send time
 *   LIMITS    one shared allocator for all twelve recipes: max posts/day, minimum gap, window — the originals cannot bypass it
 *   KEPT      Essential alerts need a person, 48h stale guard, 5-per-run, pause, the 124-draft backlog and every queued post untouched
 *
 * Runs the REAL composer + shared module against an in-memory database. No network, no Meta, nothing is posted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDb } from './_support/fake-svc.ts';
import { loadComposer } from './_support/load-social-composer.ts';
import * as R from '../functions/_shared/social-recipes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const MON = new Date('2026-11-02T05:40:00Z');   // composer's real run time, Monday (What's On day)
const WED = new Date('2026-11-04T05:40:00Z');   // Wednesday (Jobs day)
const iso = (d: Date) => d.toISOString();
const plus = (h: number, from = MON) => iso(new Date(from.getTime() + h * 3600_000));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RECIPE_DEFAULTS: Record<string, any> = {
  wird_of_day: { hour: 8 }, whats_on_roundup: { weekday: 1, hour: 9, max_events: 8 }, jobs_roundup: { weekday: 3, hour: 9, max_jobs: 6 },
  new_product: { hour: 11, max_per_run: 2 }, event_spotlight: { hour: 18, max_per_run: 2 },
};

function world(opts: { on?: string[]; autopilot?: string[]; now?: Date } = {}) {
  const db = new FakeDb(); db.clock = () => iso(opts.now ?? MON);
  const on = opts.on ?? Object.keys(RECIPE_DEFAULTS);
  db.tables.social_recipes = [...Object.keys(RECIPE_DEFAULTS), ...R.NEW_KINDS].map((k) => ({ key: k, enabled: on.includes(k), autopilot: (opts.autopilot ?? []).includes(k), config: RECIPE_DEFAULTS[k] ?? {}, last_run_at: null }));
  db.tables.admin_config = [];
  db.tables.social_posts = [];
  db.tables.spik_dictionary = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, word: `wird${i}`, short_meaning: 'a meaning', example_sentence: 'An example.', part_of_speech: 'n', word_status: 'approved' }));
  db.tables.events = []; db.tables.jobs = []; db.tables.products = []; db.tables.product_variants = [];
  db.rpcs.is_discovery_hidden = () => false; db.rpcs.get_public_notices = () => []; db.rpcs.campaign_payout_ready = () => true;
  return db;
}
const run = async (db: FakeDb, at = MON, body: Record<string, unknown> = {}) => (await loadComposer(db))(at, body);
const posts = (db: FakeDb, kind?: string) => db.table('social_posts').filter((p) => !kind || p.kind === kind);
const ev = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: `Event ${n}`, starts_at: plus(30), venue: 'Hall', locality: 'Lerwick', status: 'published', is_hidden: false, organiser_hub_id: null, calendar_approved: null, ...o });
const job = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: `Job ${n}`, external_employer_name: 'Acme', locality: 'Lerwick', location: null, status: 'open', is_hidden: false, expires_at: plus(24 * 20, WED), posted_at: plus(-n, WED), ...o });
const prod = (n: number, o: Record<string, any> = {}) => ({ id: U(n), business_id: U(900), title: `Print ${n}`, price_pence: 1500, stock_mode: 'tracked', stock: 5, reserved: 0, is_active: true, sold_at: null, photos: ['https://cdn.example/p.jpg'], created_at: plus(-n), business: { name: 'Peerie Prints', is_active: true }, ...o });
const perDay = (db: FakeDb) => { const m = new Map<string, number>(); posts(db).forEach((p) => { const d = R.londonParts(new Date(p.scheduled_for)).ymd; m.set(d, (m.get(d) ?? 0) + 1); }); return m; };

/* ── JOBS ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Jobs roundup: expired jobs', () => {
  test('expired jobs are excluded from the list AND the count', async () => {
    const db = world({ on: ['jobs_roundup'], now: WED });
    db.tables.jobs = [job(1), job(2), job(3), job(4, { expires_at: plus(-5, WED) }), job(5, { expires_at: plus(-30, WED) })];
    await run(db, WED);
    const [p] = posts(db, 'jobs_roundup');
    assert.match(p.caption, /3 open roles/); assert.doesNotMatch(p.caption, /Job 4|Job 5/);
    assert.deepEqual(R.idsFromLink(p.link_url).sort(), [U(1), U(2), U(3)].sort());
  });
  test('a job that closes before the post goes out is not listed', async () => {
    const db = world({ on: ['jobs_roundup'], now: WED });
    db.tables.jobs = [job(1), job(2, { expires_at: plus(3, WED) })];   // closes 08:40, post is ~09:00 or later
    await run(db, WED);
    assert.match(posts(db, 'jobs_roundup')[0].caption, /1 open role\b/); assert.deepEqual(R.idsFromLink(posts(db)[0].link_url), [U(1)]);
  });
  test('closed and hidden jobs are excluded; with nothing live there is no post at all', async () => {
    const db = world({ on: ['jobs_roundup'], now: WED });
    db.tables.jobs = [job(1, { status: 'closed' }), job(2, { is_hidden: true }), job(3, { expires_at: plus(-1, WED) })];
    await run(db, WED); assert.equal(posts(db, 'jobs_roundup').length, 0);
  });
  test('open-ended jobs (no expiry) are still included', async () => {
    const db = world({ on: ['jobs_roundup'], now: WED }); db.tables.jobs = [job(1, { expires_at: null })];
    await run(db, WED); assert.equal(posts(db, 'jobs_roundup').length, 1);
  });
  test('publisher re-check: every listed job must still be open at send time', async () => {
    const db = world({ now: WED }); db.tables.jobs = [job(1), job(2)];
    const post = { id: 'p', kind: 'jobs_roundup', entity_id: '2026-W45', caption: 'x', link_url: R.withIds('https://oneshetland.com/go/jobs', [U(1), U(2)]) };
    assert.equal((await R.revalidatePost(db, post, WED)).state, 'valid');
    db.tables.jobs[1].expires_at = plus(-1, WED);
    assert.match(String((await R.revalidatePost(db, post, WED)).reason), /expired/);
    db.tables.jobs[1].expires_at = plus(100, WED); db.tables.jobs[1].status = 'filled';
    assert.equal((await R.revalidatePost(db, post, WED)).state, 'invalid');
    db.tables.jobs[1].status = 'open'; db.tables.jobs.pop();
    assert.equal((await R.revalidatePost(db, post, WED)).state, 'invalid', 'deleted');
    db.failTables.add('jobs'); assert.equal((await R.revalidatePost(db, post, WED)).state, 'unknown', 'lookup failure defers, never sends');
  });
  test('an older roundup with no recorded list falls back to "at least one job is still open"', async () => {
    const db = world({ now: WED }); db.tables.jobs = [job(1, { expires_at: plus(-1, WED) })];
    const post = { id: 'p', kind: 'jobs_roundup', entity_id: 'w', caption: 'x', link_url: 'https://oneshetland.com/go/jobs' };
    assert.equal((await R.revalidatePost(db, post, WED)).state, 'invalid');
    db.tables.jobs.push(job(2)); assert.equal((await R.revalidatePost(db, post, WED)).state, 'valid');
  });
});

/* ── EVENTS ───────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Events: What’s On and Event spotlight', () => {
  test('What’s On lists only events that have not started by the time the post goes out', async () => {
    const db = world({ on: ['whats_on_roundup'] });
    db.tables.events = [ev(1, { starts_at: plus(1.5) }) /* 07:10, before the 09:00+ post */, ev(2, { starts_at: plus(30) }), ev(3, { starts_at: plus(50) }), ev(4, { starts_at: plus(70) })];
    await run(db);
    const [p] = posts(db, 'whats_on_roundup'); const listed = R.idsFromLink(p.link_url);
    assert.ok(!listed.includes(U(1)), 'an event already over by 09:00 is not promoted'); assert.deepEqual(listed.sort(), [U(2), U(3), U(4)].sort());
    assert.ok(listed.every((id) => new Date(db.table('events').find((e) => e.id === id)!.starts_at).getTime() > new Date(p.scheduled_for).getTime()));
  });
  test('cancelled, draft, archived, hidden, unapproved hub and fixture events are excluded', async () => {
    const db = world({ on: ['whats_on_roundup'] });
    db.tables.events = [ev(1, { status: 'cancelled' }), ev(2, { status: 'draft' }), ev(3, { status: 'archived' }), ev(4, { is_hidden: true }), ev(5, { organiser_hub_id: U(9), calendar_approved: false }),
      ev(6, { title: 'ZZ TEST — Acceptance Event' }), ev(7, { title: 'DEMO gig' }), ev(8), ev(9), ev(10), ev(11, { organiser_hub_id: U(9), calendar_approved: true })];
    await run(db); assert.deepEqual(R.idsFromLink(posts(db, 'whats_on_roundup')[0].link_url).sort(), [U(8), U(9), U(10), U(11)].sort());
  });
  test('Event spotlight: an event that starts before the 18:00 post is not promoted; one that starts after is', async () => {
    const db = world({ on: ['event_spotlight'] });
    const prem = { subscription_tier: 'premium', name: 'Venue' };
    db.tables.events = [ev(1, { starts_at: plus(5), organiser_business_id: U(7), local_businesses: prem }) /* 10:40 */, ev(2, { starts_at: plus(15), organiser_business_id: U(7), local_businesses: prem }) /* 20:40 */];
    await run(db); assert.deepEqual(posts(db, 'event_spotlight').map((p) => p.entity_id), [U(2)]);
  });
  test('Event spotlight skips cancelled, hidden and unapproved-hub events', async () => {
    const db = world({ on: ['event_spotlight'] }); const prem = { subscription_tier: 'premium', name: 'Venue' };
    const base = { starts_at: plus(20), organiser_business_id: U(7), local_businesses: prem };
    db.tables.events = [ev(1, { ...base, status: 'cancelled' }), ev(2, { ...base, is_hidden: true }), ev(3, { ...base, organiser_hub_id: U(9), calendar_approved: false })];
    await run(db); assert.equal(posts(db, 'event_spotlight').length, 0);
  });
  test('publisher re-check: a promoted event that has since started, been cancelled or hidden is skipped', async () => {
    const db = world(); db.tables.events = [ev(1, { starts_at: plus(10) })];
    const spot = { id: 'p', kind: 'event_spotlight', entity_id: U(1), caption: 'x' };
    assert.equal((await R.revalidatePost(db, spot, MON)).state, 'valid');
    assert.match(String((await R.revalidatePost(db, spot, new Date(MON.getTime() + 11 * 3600_000))).reason), /already-started/);
    db.tables.events[0].status = 'cancelled'; assert.equal((await R.revalidatePost(db, spot, MON)).state, 'invalid');
    db.tables.events[0].status = 'published'; db.tables.events[0].is_hidden = true; assert.equal((await R.revalidatePost(db, spot, MON)).state, 'invalid');
  });
  test('publisher re-check: a roundup is skipped if ANY listed event is no longer promotable', async () => {
    const db = world(); db.tables.events = [ev(1, { starts_at: plus(10) }), ev(2, { starts_at: plus(12) })];
    const post = { id: 'p', kind: 'whats_on_roundup', entity_id: 'w', caption: 'x', link_url: R.withIds('https://oneshetland.com/go/whats-on', [U(1), U(2)]) };
    assert.equal((await R.revalidatePost(db, post, MON)).state, 'valid');
    db.tables.events[1].status = 'cancelled'; assert.match(String((await R.revalidatePost(db, post, MON)).reason), /cancelled|not-published/);
    db.tables.events[1].status = 'published'; db.tables.events.pop(); assert.equal((await R.revalidatePost(db, post, MON)).state, 'invalid');
  });
});

/* ── PRODUCTS ─────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Products: genuinely available only', () => {
  const run1 = async (rows: any[], variants: any[] = []) => { const db = world({ on: ['new_product'] }); db.tables.products = rows; db.tables.product_variants = variants; await run(db); return posts(db, 'new_product').map((p) => p.entity_id); };
  test('the Shop’s own availability rule: tracked stock minus reserved, one-offs, made-to-order, no-stock-limit', async () => {
    const got = await run1([
      prod(1, { stock: 3, reserved: 3 }) /* none left */, prod(2, { stock: 0 }), prod(3, { stock: 5, reserved: 2 }) /* ok */, prod(4, { stock_mode: 'one_off', reserved: 1 }) /* held */,
      prod(5, { stock_mode: 'one_off', reserved: 0 }) /* ok */, prod(6, { stock_mode: 'made_to_order', stock: 0 }) /* always buyable */,
    ]);
    assert.deepEqual(got.sort(), [U(3), U(5)].sort(), 'max_per_run caps it at 2; the available ones come first by recency');
  });
  test('inactive, sold, photo-less, hidden-business, inactive-business and fixture products are excluded', async () => {
    const got = await run1([
      prod(1, { is_active: false }), prod(2, { sold_at: plus(-1) }), prod(3, { photos: [] }), prod(4, { business: { name: 'Shop', is_active: false } }),
      prod(5, { title: 'ZZ TEST — Fixture Print' }), prod(6, { title: 'DEMO — Launch Test Product' }), prod(7, { business: { name: 'ZZ TEST — Fixture', is_active: true } }), prod(8, { business: { name: 'DEMO Co', is_active: true } }),
    ]);
    assert.deepEqual(got, []);
  });
  test('a business hidden as a fixture is excluded', async () => {
    const db = world({ on: ['new_product'] }); db.tables.products = [prod(1)]; db.rpcs.is_discovery_hidden = () => true;
    await run(db); assert.equal(posts(db, 'new_product').length, 0);
  });
  test('variants: sellable only if some active variant has stock left', () => {
    const p = prod(1, { stock: null }) as any;
    assert.equal(R.productPromotable(p, [{ stock: 2, reserved: 2, is_active: true }, { stock: 0, reserved: 0, is_active: true }], 'Shop', true, false).ok, false);
    assert.equal(R.productPromotable(p, [{ stock: 2, reserved: 1, is_active: true }], 'Shop', true, false).ok, true);
    assert.equal(R.productPromotable(p, [{ stock: 9, reserved: 0, is_active: false }], 'Shop', true, false).ok, true, 'no live variant stock info -> falls back to the product');
  });
  test('publisher re-check: a product sold out, sold or deactivated since drafting is skipped', async () => {
    const db = world(); db.tables.products = [prod(1)]; db.tables.local_businesses = [{ id: U(900), name: 'Peerie Prints', is_active: true }];
    const post = { id: 'p', kind: 'new_product', entity_id: U(1), caption: 'x' };
    assert.equal((await R.revalidatePost(db, post, MON)).state, 'valid');
    db.tables.products[0].stock = 5; db.tables.products[0].reserved = 5; assert.equal((await R.revalidatePost(db, post, MON)).state, 'invalid');
    db.tables.products[0].reserved = 0; db.tables.products[0].sold_at = plus(-1); assert.equal((await R.revalidatePost(db, post, MON)).state, 'invalid');
    db.tables.products[0].sold_at = null; db.tables.products[0].is_active = false; assert.equal((await R.revalidatePost(db, post, MON)).state, 'invalid');
  });
});

/* ── LIMITS ───────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('One shared limit for all twelve recipes', () => {
  const busy = () => {
    const db = world({ autopilot: ['wird_of_day', 'whats_on_roundup', 'new_product', 'event_spotlight'] });
    const prem = { subscription_tier: 'premium', name: 'Venue' };
    db.tables.events = [ev(1, { starts_at: plus(30) }), ev(2, { starts_at: plus(40) }), ev(3, { starts_at: plus(50) }), ev(10, { starts_at: plus(14), organiser_business_id: U(7), local_businesses: prem }), ev(11, { starts_at: plus(15), organiser_business_id: U(7), local_businesses: prem })];
    db.tables.products = [prod(1), prod(2), prod(3)];
    return db;
  };
  test('word + What’s On + 2 products + 2 spotlights can no longer pile onto one day: never more than 3 a day', async () => {
    const db = busy(); await run(db);
    assert.ok([...perDay(db).values()].every((n) => n <= 3), JSON.stringify([...perDay(db)])); assert.ok(posts(db).length <= 9);
  });
  test('every post is at least the minimum gap from every other, inside the posting window', async () => {
    const db = busy(); await run(db);
    const t = posts(db).map((p) => new Date(p.scheduled_for).getTime()).sort();
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 120 * 60_000, `gap ${(t[i] - t[i - 1]) / 60000} min`);
    for (const p of posts(db)) { const lp = R.londonParts(new Date(p.scheduled_for)); assert.ok(lp.hour >= 8 && lp.hour * 60 + lp.minute <= 20 * 60, p.kind + ' ' + p.scheduled_for); }
  });
  test('the original recipes keep their preferred hours when the day is free', async () => {
    const db = world({ on: ['wird_of_day'] }); await run(db);
    const lp = R.londonParts(new Date(posts(db, 'wird_of_day')[0].scheduled_for)); assert.equal(lp.ymd, '2026-11-02'); assert.ok(lp.hour === 8 || (lp.hour === 7 && lp.minute >= 53));
  });
  test('word of the day and What’s On are no longer an hour (or ten minutes) apart: they are spaced by the shared gap', async () => {
    const db = world({ on: ['wird_of_day', 'whats_on_roundup'] }); db.tables.events = [ev(1), ev(2), ev(3)]; await run(db);
    const t = ['wird_of_day', 'whats_on_roundup'].map((k) => new Date(posts(db, k)[0].scheduled_for).getTime()).sort();
    assert.ok(t[1] - t[0] >= 120 * 60_000);
  });
  test('posts already queued count against the day, new-recipe or old', async () => {
    const db = world({ on: ['wird_of_day'] });
    db.tables.social_posts = ['09:00', '12:00', '15:00'].map((h, i) => ({ id: `q${i}`, kind: 'custom', entity_id: `c${i}`, status: 'approved', scheduled_for: R.londonInstant('2026-11-02', Number(h.slice(0, 2)), 0).toISOString(), created_at: plus(-1), caption: 'x' }));
    const res = await run(db);
    const w = posts(db, 'wird_of_day')[0]; assert.ok(w, 'it is still composed'); assert.equal(R.londonParts(new Date(w.scheduled_for)).ymd, '2026-11-03', 'but on the next free day, not a 4th post today');
    void res;
  });
  test('when no slot exists in the next three days nothing is composed and the reason is reported, never forced', async () => {
    const db = world({ on: ['wird_of_day'] });
    db.tables.social_posts = [2, 3, 4, 5].flatMap((d) => [9, 12, 18].map((h) => ({ id: `q${d}${h}`, kind: 'custom', entity_id: `c${d}${h}`, status: 'approved', scheduled_for: R.londonInstant(`2026-11-0${d}`, h, 0).toISOString(), created_at: plus(-1), caption: 'x' })));
    const res = await run(db); assert.equal(posts(db, 'wird_of_day').length, 0); assert.ok(res.errors.some((e: string) => /daily posting limit/.test(e)));
  });
  test('the new recipes share the same context, so originals + new together stay within the cap', async () => {
    const db = busy(); db.tables.notices = []; db.rpcs.get_public_notices = (a: any) => (a.p_level === 'all' ? [{ id: U(50), title: 'Bus change', body: 'The 12 runs early.', category: 'travel_transport', published_at: plus(-24), expires_at: plus(300), is_essential_active: false, publisher: {} }] : []);
    db.tables.notices = [{ id: U(50), is_person_notice: false, status: 'published', is_hidden: false, visibility: 'public', withdrawn_at: null, source_label: null }];
    db.table('social_recipes').find((r) => r.key === 'notice_update')!.enabled = true;
    await run(db); assert.ok([...perDay(db).values()].every((n) => n <= 3));
  });
});

/* ── KEPT ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('Existing safeguards are untouched', () => {
  const backlog = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `old-${i}`, kind: i % 5 === 0 ? 'jobs_roundup' : 'wird_of_day', entity_id: `old-${i}`, status: 'draft', caption: `old ${i}`, scheduled_for: plus(-24 * (3 + i)), created_at: plus(-24 * (3 + i)), error: null, link_url: null }));
  test('the 124-draft backlog is byte-identical after a full composer pass, and nothing is approved or scheduled', async () => {
    const db = world({ autopilot: ['wird_of_day', 'whats_on_roundup', 'jobs_roundup', 'new_product', 'event_spotlight'] }); db.tables.social_posts = backlog(124); const snap = JSON.stringify(db.tables.social_posts);
    db.tables.events = [ev(1), ev(2), ev(3)]; db.tables.products = [prod(1)];
    await run(db);
    assert.equal(JSON.stringify(db.tables.social_posts.slice(0, 124)), snap);
    assert.ok(db.table('social_posts').slice(0, 124).every((p) => p.status === 'draft'));
    assert.equal(db.log.filter((l) => l.op === 'update' && l.table === 'social_posts').length, 0, 'the composer updates no post row at all');
  });
  test('the composer changes no recipe switch or schedule — only last_run_at', async () => {
    const db = world({ autopilot: ['wird_of_day'] }); const before = JSON.stringify(db.table('social_recipes').map((r) => ({ ...r, last_run_at: null })));
    db.tables.events = [ev(1), ev(2), ev(3)]; await run(db);
    assert.equal(JSON.stringify(db.table('social_recipes').map((r) => ({ ...r, last_run_at: null }))), before);
  });
  test('autopilot still only changes the status: scheduled on, draft off', async () => {
    const on = world({ on: ['wird_of_day'], autopilot: ['wird_of_day'] }); await run(on); assert.equal(posts(on)[0].status, 'scheduled');
    const off = world({ on: ['wird_of_day'] }); await run(off); assert.equal(posts(off)[0].status, 'draft');
  });
  test('Essential alerts are still always drafts, even with autopilot forced on', async () => {
    const db = world({ on: ['essential_alert'], autopilot: ['essential_alert'] });
    db.rpcs.get_public_notices = (a: any) => (a.p_level === 'essential' ? [{ id: U(60), title: 'A970 closed', body: 'Landslip.', action_text: 'Use the diversion.', category: 'travel_transport', published_at: plus(-2), expires_at: plus(48), review_at: plus(30), is_essential_active: true, publisher: { label: 'Council' } }] : []);
    db.tables.notices = [{ id: U(60), is_person_notice: false, status: 'published', is_hidden: false, visibility: 'public', withdrawn_at: null, source_label: null }];
    await run(db); const [p] = posts(db, 'essential_alert'); assert.equal(p.status, 'draft');
    const r = await db.from('social_posts').insert({ kind: 'essential_alert', entity_id: 'z', status: 'scheduled', caption: 'c' }); assert.match(String(r.error?.message), /essential_needs_human/);
  });
  test('publisher: 48h stale guard, 5-per-run, pause and "approved/scheduled only" are all still there, in the same order', () => {
    const pub = code(read('supabase/functions/social-publisher/index.ts'));
    assert.match(pub, /const MAX_PER_RUN = 5;/); assert.match(pub, /const STALE_HOURS = 48;/); assert.match(pub, /social\.publishing_paused/);
    assert.match(pub, /\.in\('status', \['approved', 'scheduled'\]\)/); assert.match(pub, /stale: scheduled_for more than/);
    const i = (x: string) => pub.indexOf(x);
    assert.ok(i('social.publishing_paused') < i('let due: PostRow[]') && i('STALE_HOURS * 3600_000') < i('revalidatePost(svc, post, now)') && i('revalidatePost(svc, post, now)') < i('postToFacebook(pageId, token, post)'));
  });
  test('the old and new kinds are all re-checked at send time; hand-written and word posts are not', () => {
    for (const k of ['jobs_roundup', 'whats_on_roundup', 'event_spotlight', 'new_product', 'essential_alert', 'notice_update']) assert.ok(R.REVALIDATED_KINDS.has(k), k);
    for (const k of ['wird_of_day', 'custom']) assert.equal(R.REVALIDATED_KINDS.has(k), false, k);
  });
  test('composer: every original recipe is still gated on its own enabled switch, weekday and status rule', () => {
    const c = code(read('supabase/functions/social-composer/index.ts'));
    for (const m of ["enabled('wird_of_day')", "enabled('whats_on_roundup')", "enabled('jobs_roundup')", "enabled('new_product')", "enabled('event_spotlight')", 'isMonday || force', 'isWednesday || force',
      "status: statusFor('wird_of_day')", "status: statusFor('whats_on_roundup')", "status: statusFor('jobs_roundup')", "status: statusFor('new_product')", "status: statusFor('event_spotlight')"]) assert.ok(c.includes(m), m);
  });
  test('no original recipe computes its own time any more: all five use the shared slot', () => {
    const c = code(read('supabase/functions/social-composer/index.ts'));
    assert.equal((c.match(/scheduled_for: jitter\(nextLondonHour\(/g) ?? []).length, 0);
    for (const k of ['wird_of_day', 'whats_on_roundup', 'jobs_roundup', 'new_product', 'event_spotlight']) assert.ok(c.includes(`slotFor('${k}'`), k);
  });
  test('daily gating still applies: What’s On only on Mondays, jobs only on Wednesdays (force overrides)', async () => {
    const tue = new Date('2026-11-03T05:40:00Z'); const db = world({ on: ['whats_on_roundup', 'jobs_roundup'], now: tue }); db.tables.events = [ev(1, { starts_at: plus(30, tue) })]; db.tables.jobs = [job(1)];
    await run(db, tue); assert.equal(posts(db).length, 0);
    await run(db, tue, { force: true }); assert.equal(posts(db).length, 2);
  });
});

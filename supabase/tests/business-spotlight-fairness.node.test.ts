/**
 * business-spotlight-fairness.node.test.ts — the Business Spotlight rotation: who is picked next, the 90-day rule, retries, sensitive listings,
 * the generated card, and the shared daily publishing limits. Includes a multi-month SIMULATION of 40+ businesses claiming over many weeks (a quiet
 * start, a burst, a long trickle), run through the REAL composer code against an in-memory database, with an independent oracle re-deriving the
 * expected pick at every step. No network, no database, nothing is posted.
 * Run: node --test supabase/tests/business-spotlight-fairness.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDb } from './_support/fake-svc.ts';
import * as R from '../functions/_shared/social-recipes.ts';

const DAY = 86400_000;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (d: Date | number) => new Date(d).toISOString();
const seeded = (seed = 7) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
const T0 = new Date('2026-11-09T05:40:00Z');                  // a Monday, GMT: the composer's real run time
const at = (offsetDays: number) => new Date(T0.getTime() + offsetDays * DAY);
const ymdOf = (d: Date) => R.londonParts(d).ymd;
const LONG = 'A family run business in Lerwick offering a friendly local service to customers across Shetland every week of the year.';

type Spec = { n: number; name: string; claimDay: number; description?: string; image?: boolean; category?: string; hidden?: boolean; optOut?: boolean; unclaimed?: boolean; sensitive?: boolean; badQuality?: boolean };
const row = (s: Spec) => ({
  id: U(s.n), name: s.name, description: s.description ?? LONG, category: s.category ?? 'Shop', is_active: true, is_claimed: !s.unclaimed,
  cover_url: s.image === false ? null : 'https://cdn.example/c.jpg', logo_url: null,
  claimed_at: iso(at(s.claimDay)), owner_activated_at: iso(at(s.claimDay)), created_at: iso(at(-200)),
});

function world(specs: Spec[], cfg: Record<string, unknown> = {}) {
  const db = new FakeDb(); db.clock = () => iso(T0);
  db.tables.local_businesses = specs.map(row); db.tables.social_posts = []; db.tables.admin_config = [];
  db.tables.social_promotion_permissions = specs.filter((s) => s.optOut).map((s) => ({ entity_type: 'business', entity_id: U(s.n), allowed: false }));
  const hidden = new Set(specs.filter((s) => s.hidden).map((s) => U(s.n)));
  let hiddenCalls = 0; db.rpcs.is_discovery_hidden = (a) => { hiddenCalls++; return hidden.has(a.p_id); };
  const recipes = new Map<string, any>();
  for (const k of R.NEW_KINDS) recipes.set(k, { key: k, enabled: false, autopilot: false, config: {} });
  recipes.set('business_spotlight', { key: 'business_spotlight', enabled: true, autopilot: true, config: cfg });
  return { db, recipes, hiddenCalls: () => hiddenCalls };
}
const compose = (w: ReturnType<typeof world>, now: Date, force = false) => { w.db.clock = () => iso(now); return R.composeNewRecipes({ svc: w.db, now, recipes: w.recipes, rand: seeded(), force }); };
const spots = (w: ReturnType<typeof world>) => w.db.table('social_posts').filter((p) => p.kind === 'business_spotlight');
const post = (w: ReturnType<typeof world>, o: Record<string, any>) => w.db.table('social_posts').push({ id: crypto.randomUUID(), kind: 'business_spotlight', entity_type: 'business', created_at: iso(T0), channels: ['facebook'], ...o });

/* ───────────────────────────────────── 1. the pure rules ───────────────────────────────────── */
describe('Rotation order (pure)', () => {
  const rk = (id: string, lane: R.SpotLane, claimedAt: string | null, lastPostedAt: string | null = null): R.SpotRank => ({ id, name: id, lane, claimedAt, lastPostedAt, sensitive: false });
  test('welcome first, oldest claim first; then never-featured, oldest claim first; then rotation, longest ago first', () => {
    const o = R.orderSpotlight([
      rk('r2', 'rotation', '2026-01-01', '2026-06-01'), rk('n2', 'new', '2026-09-02'), rk('w2', 'welcome', '2026-11-06'), rk('r1', 'rotation', '2026-01-01', '2026-05-01'),
      rk('n1', 'new', '2026-09-01'), rk('w1', 'welcome', '2026-11-05'),
    ], 0, 99).map((x) => x.id);
    assert.deepEqual(o, ['w1', 'w2', 'n1', 'n2', 'r1', 'r2']);
  });
  test('never more than two welcome picks in a row while anyone else is waiting; the other business comes from never-featured first, then rotation', () => {
    const w = [1, 2, 3, 4, 5].map((i) => rk('w' + i, 'welcome', `2026-11-0${i}`));
    const o = R.orderSpotlight([...w, rk('n1', 'new', '2026-08-01'), rk('r1', 'rotation', '2026-01-01', '2026-06-01')], 0, 2).map((x) => x.id);
    assert.deepEqual(o, ['w1', 'w2', 'n1', 'w3', 'w4', 'r1', 'w5']);
  });
  test('the streak carries over from earlier picks: after two welcome picks the next goes elsewhere', () => {
    const e = [rk('w1', 'welcome', '2026-11-05'), rk('n1', 'new', '2026-08-01')];
    assert.equal(R.orderSpotlight(e, 2, 2)[0].id, 'n1'); assert.equal(R.orderSpotlight(e, 1, 2)[0].id, 'w1');
  });
  test('with nobody else waiting, welcome picks may run on (the cap only protects others)', () => {
    assert.deepEqual(R.orderSpotlight([rk('a', 'welcome', '1'), rk('b', 'welcome', '2'), rk('c', 'welcome', '3')], 5, 2).map((x) => x.id), ['a', 'b', 'c']);
  });
  test('the order is deterministic: the same businesses in any input order give the same result, ties broken by id', () => {
    const base = ['c', 'a', 'b', 'd'].map((id) => rk(id, 'new', '2026-09-01'));
    const a = R.orderSpotlight(base, 0, 2).map((x) => x.id); const b = R.orderSpotlight([...base].reverse(), 0, 2).map((x) => x.id);
    assert.deepEqual(a, ['a', 'b', 'c', 'd']); assert.deepEqual(a, b);
  });
});

describe('What counts towards the 90 days, and what does not', () => {
  const cfg = {};
  const P = (status: string, daysAgo: number, id = U(1), extra: Record<string, any> = {}) => ({ entity_id: `${id}:x`, business_id: id, status, created_at: iso(at(-daysAgo)), posted_at: status === 'posted' ? iso(at(-daysAgo)) : null, scheduled_for: iso(at(-daysAgo)), ...extra });
  test('only a published post starts the 90 days', () => {
    const s = R.spotlightStates([P('posted', 10)], cfg).get(U(1))!; assert.equal(s.lastPostedAt, at(-10).getTime()); assert.equal(s.pending, false);
  });
  test('draft, approved and scheduled posts block a second pick (never selected twice) but record no 90-day history', () => {
    for (const st of ['draft', 'approved', 'scheduled']) { const s = R.spotlightStates([P(st, 1)], cfg).get(U(1))!; assert.equal(s.pending, true); assert.equal(s.lastPostedAt, null); }
  });
  test('a failed post cools off for 2 days; a skipped or rejected one for 7; neither starts the 90 days', () => {
    const f = R.spotlightStates([P('failed', 0)], cfg).get(U(1))!; assert.equal(f.coolUntil, at(2).getTime()); assert.equal(f.lastPostedAt, null);
    const k = R.spotlightStates([P('skipped', 0)], cfg).get(U(1))!; assert.equal(k.coolUntil, at(7).getTime()); assert.equal(k.lastPostedAt, null);
  });
  test('the business is read from business_id, or from the id before the colon on older rows', () => {
    const s = R.spotlightStates([{ entity_id: `${U(9)}:5`, status: 'posted', created_at: iso(at(-3)), posted_at: iso(at(-3)) }], cfg); assert.ok(s.get(U(9))?.lastPostedAt);
  });
  test('welcome streak counts only real picks, newest first, and only first-time businesses inside their welcome window', () => {
    const pool = new Map(([1, 2, 3, 4] as number[]).map((n) => [U(n), row({ n, name: 'B' + n, claimDay: n === 4 ? -60 : -3 }) as any]));
    const h = [P('posted', 9, U(4)), P('posted', 3, U(1)), P('failed', 2, U(9)), P('posted', 1, U(2))];   // 4 is old (not welcome); 1 and 2 are welcome; the failed one is ignored
    assert.equal(R.welcomeStreak(h as any, pool as any, cfg), 2);
    assert.equal(R.welcomeStreak([...h, P('posted', 0, U(4))] as any, pool as any, cfg), 0, 'a non-welcome pick resets it');
    assert.equal(R.welcomeStreak([P('posted', 5, U(1)), P('posted', 1, U(1))] as any, pool as any, cfg), 0, 'a repeat of the same business is not a welcome pick');
  });
});

describe('Selection against the database', () => {
  test('database row order is irrelevant: shuffling the table gives the same ranking', async () => {
    const specs = Array.from({ length: 30 }, (_, i) => ({ n: 100 + i, name: `Biz ${i}`, claimDay: -(i % 9) * 3 - 20 }));
    const a = world(specs); const b = world(specs); b.db.tables.local_businesses = [...b.db.tables.local_businesses].sort(() => 0.5 - Math.random()).reverse();
    const ra = await R.selectSpotlight(a.db, {}, at(0)); const rb = await R.selectSpotlight(b.db, {}, at(0));
    assert.deepEqual(ra.report.order.map((x) => x.id), rb.report.order.map((x) => x.id));
  });
  test('the WHOLE eligible pool is considered, past 120 and past the 500-row page size', async () => {
    const specs = Array.from({ length: 1203 }, (_, i) => ({ n: 1000 + i, name: `Pool ${i}`, claimDay: -400 + (i % 300) }));
    const w = world(specs); const r = await R.selectSpotlight(w.db, {}, at(0));
    assert.equal(r.report.counts.pool, 1203); assert.equal(r.report.counts.eligible, 1203);
    assert.ok(w.hiddenCalls() <= 16, `hidden-listing lookups are bounded (${w.hiddenCalls()}), not one per business`);
  });
  test('a missing photograph uses the generated card; a real photograph is kept', async () => {
    const w = world([{ n: 1, name: 'Photo Co', claimDay: -30 }, { n: 2, name: 'No Photo Co', claimDay: -29, image: false }]);
    const c = (await R.selectSpotlight(w.db, {}, at(0))).candidates; const by = (id: string) => c.find((x) => x.business_id === id)!;
    assert.equal(by(U(1)).image_url, 'https://cdn.example/c.jpg'); assert.equal(by(U(2)).image_url, `https://oneshetland.com/api/social-image?kind=business&id=${U(2)}`);
  });
  test('quality standards: no name, a short, thin or placeholder description, fixtures, unclaimed, hidden and opted-out businesses are never eligible', async () => {
    const w = world([
      { n: 1, name: 'Good Co', claimDay: -30 }, { n: 2, name: 'Ab', claimDay: -30 }, { n: 3, name: 'Short Co', claimDay: -30, description: 'Nice shop.' },
      { n: 4, name: 'Thin Co', claimDay: -30, description: 'Extraordinarily-comprehensive professional installation maintenance' }, { n: 5, name: 'Lorem Co', claimDay: -30, description: `${LONG} Lorem ipsum dolor` },
      { n: 6, name: 'ZZ TEST — Fixture', claimDay: -30 }, { n: 7, name: 'Unclaimed Co', claimDay: -30, unclaimed: true }, { n: 8, name: 'Hidden Co', claimDay: -30, hidden: true }, { n: 9, name: 'Opted Out Co', claimDay: -30, optOut: true },
    ]);
    const r = await R.selectSpotlight(w.db, {}, at(0)); assert.deepEqual(r.report.order.map((x) => x.id), [U(1)]);
    const why = Object.fromEntries(r.report.excluded.map((x) => [x.id, x.reason]));
    assert.equal(why[U(2)], 'no-name'); assert.equal(why[U(3)], 'no-description'); assert.equal(why[U(4)], 'thin-description'); assert.equal(why[U(5)], 'placeholder-text');
    assert.equal(why[U(6)], 'fixture'); assert.equal(why[U(8)], 'hidden'); assert.equal(why[U(9)], 'opted-out'); assert.equal(why[U(7)], undefined, 'an unclaimed business is not in the pool at all');
  });
  test('the existing opt-out table excludes only the spotlight: a business opted out there is skipped, while any other business is untouched', async () => {
    const w = world([{ n: 1, name: 'Opt Out Consultancy', claimDay: -30, optOut: true }, { n: 2, name: 'Other Co', claimDay: -30 }]);
    assert.deepEqual((await R.selectSpotlight(w.db, {}, at(0))).report.order.map((x) => x.id), [U(2)]);
    assert.doesNotMatch(R.selectSpotlight.toString() + R.businessEligible.toString(), /Darren|Consultancy/, 'no business is excluded by a hard-coded name');
  });
  test('sensitive listings are KEPT in the rotation but held as a draft for a person to approve, even with autopilot on', async () => {
    const w = world([{ n: 1, name: 'Bereavement Support Service', claimDay: -30 }, { n: 2, name: 'Lighthouse Counselling', claimDay: -29 }, { n: 3, name: 'Ordinary Bakery', claimDay: -28 }]);
    const r = await R.selectSpotlight(w.db, {}, at(0)); assert.equal(r.report.order.length, 3); assert.deepEqual(r.candidates.map((c) => c.needsApproval), [true, true, false]);
    const res = await compose(w, at(0)); assert.equal(res.business_spotlight, 1);
    const p = spots(w)[0]; assert.equal(p.status, 'draft', 'autopilot is on, but a sensitive business waits for approval'); assert.match(p.error, /sensitive/);
    assert.equal(p.business_id, U(1));
  });
  test('sensitive wording is recognised in name, description or category; ordinary wording is not', () => {
    for (const s of ['Funeral directors', 'Bereavement support', 'Counselling service', 'Grief and loss group', 'Mental health drop-in', 'Hospice care', 'Domestic abuse helpline', 'Cancer support', 'Samaritans listening']) assert.equal(R.businessSensitive({ name: s }), true, s);
    for (const s of ['GG Massage Therapy', 'Da Harbour Chippy', 'Shetland Wool Brokers', 'Haar Sauna', 'Northern Lights Fitness', 'Houlls Horses and Hounds']) assert.equal(R.businessSensitive({ name: s, description: 'We make bread, knit jumpers and keep horses on the croft.' }), false, s);
  });
});

describe('Publishing slots: drafts, approvals and the one-a-day rule', () => {
  const dayAt = (d: number, h: number) => iso(R.londonInstant(ymdOf(at(d)), h, 0));
  test('unapproved review-only drafts do not reserve slots; approved, scheduled and posted items do (nothing already approved or scheduled is displaced)', async () => {
    const w = world([]);
    post(w, { kind: 'aald_memory', entity_id: 'a1', status: 'draft', scheduled_for: dayAt(1, 13) });
    post(w, { kind: 'hub_community', entity_id: 'h1', status: 'draft', scheduled_for: dayAt(1, 15), error: null });
    post(w, { kind: 'notice_update', entity_id: 'n1', status: 'scheduled', scheduled_for: dayAt(1, 9) });
    post(w, { kind: 'jobs_roundup', entity_id: 'j1', status: 'approved', scheduled_for: dayAt(1, 11) });
    post(w, { kind: 'wird_of_day', entity_id: 'w1', status: 'posted', posted_at: iso(at(0)), scheduled_for: iso(at(0)) });
    const ctx = await R.loadSlotContext(w.db, at(0));
    assert.equal(ctx.taken.length, 3, 'scheduled + approved + posted-today'); assert.equal(ctx.draftTaken.length, 2, 'the two drafts are tracked apart');
    // an autopilot post can use the hour a review-only draft was parked at; a draft avoids both
    assert.equal(R.peekSlot(ctx, 13, () => 0.5, false)!.toISOString(), dayAt(1, 13) < iso(at(0)) ? '' : R.peekSlot(ctx, 13, () => 0.5, false)!.toISOString());
    const real = R.peekSlot(ctx, 13, () => 0.5, false)!, asDraft = R.peekSlot(ctx, 13, () => 0.5, true)!;
    assert.ok(Math.abs(real.getTime() - R.londonInstant(ymdOf(real), 13, 0).getTime()) <= 8 * 60_000, 'the real post gets its preferred 13:00 even though a draft sits there');
    assert.ok(!(Math.abs(asDraft.getTime() - Date.parse(dayAt(1, 13))) < 120 * 60_000 && ymdOf(asDraft) === ymdOf(at(1))), 'a draft keeps clear of the other draft');
  });
  test('a spotlight held for approval (sensitive) DOES keep its slot, so approving it later cannot break the daily limit', async () => {
    const w = world([]);
    post(w, { kind: 'business_spotlight', entity_id: 's:1', status: 'draft', scheduled_for: dayAt(1, 13), error: 'Held for approval: the listing touches a sensitive subject' });
    const ctx = await R.loadSlotContext(w.db, at(0)); assert.equal(ctx.taken.length, 1); assert.equal(ctx.draftTaken.length, 0);
  });
  test('only ONE Business Spotlight per day: a busy day pushes the next one to a different day, never a second on the same day', async () => {
    const w = world(Array.from({ length: 6 }, (_, i) => ({ n: 1 + i, name: `Biz ${i}`, claimDay: -40 })));
    for (let d = 0; d < 21; d++) { await compose(w, at(d)); for (const p of spots(w)) if (p.status === 'scheduled') p.status = 'posted', p.posted_at = p.scheduled_for; }
    const days = spots(w).map((p) => ymdOf(new Date(Date.parse(p.scheduled_for)))); assert.equal(new Set(days).size, days.length, `two on one day: ${days}`);
    // and a run on a day that already holds one defers rather than doubling up
    const w2 = world([{ n: 1, name: 'A Co', claimDay: -40 }, { n: 2, name: 'B Co', claimDay: -39 }]);
    post(w2, { kind: 'business_spotlight', entity_id: `${U(9)}:x`, business_id: U(9), status: 'scheduled', scheduled_for: dayAt(0, 13), entity_type: 'business' });
    await compose(w2, at(0)); const mine = spots(w2).find((p) => p.business_id === U(1))!; assert.notEqual(ymdOf(new Date(Date.parse(mine.scheduled_for))), ymdOf(at(0)));
  });
  test('the compose run never removes, skips or reschedules an approved or scheduled post of any kind (only its OWN stale, never-reviewed spotlight drafts are retired)', async () => {
    const w = world([{ n: 1, name: 'Only Co', claimDay: -40 }]);
    post(w, { kind: 'wird_of_day', entity_id: 'w', status: 'scheduled', scheduled_for: dayAt(1, 9) }); post(w, { kind: 'jobs_roundup', entity_id: 'j', status: 'approved', scheduled_for: dayAt(2, 9) });
    post(w, { kind: 'notice_update', entity_id: 'n', status: 'scheduled', scheduled_for: dayAt(-1, 12) });   // overdue but still scheduled: the publisher's business, not the composer's
    post(w, { kind: 'business_spotlight', entity_id: `${U(5)}:old`, business_id: U(5), status: 'scheduled', scheduled_for: dayAt(-3, 13), entity_type: 'business' });
    const before = JSON.stringify(w.db.table('social_posts').map((p) => [p.id, p.status, p.scheduled_for]));
    await compose(w, at(0)); const after = w.db.table('social_posts').filter((p) => !['b', 'x'].includes(p.entity_id) && p.business_id !== U(1));
    assert.equal(JSON.stringify(after.map((p) => [p.id, p.status, p.scheduled_for])), before, 'every pre-existing row is exactly as it was');
  });
  test('a failed or skipped business keeps its fair place: a business claimed 10 days ago that failed on day 0 is still welcome-lane on day 20, ahead of an older never-featured business', async () => {
    const w = world([{ n: 1, name: 'Failed Co', claimDay: -10 }, { n: 2, name: 'Older Co', claimDay: -60 }, { n: 3, name: 'Welcome Co', claimDay: 15 }]);
    post(w, { kind: 'business_spotlight', entity_id: `${U(1)}:2026-11-09`, business_id: U(1), status: 'failed', created_at: iso(at(0)), scheduled_for: iso(at(0)), entity_type: 'business' });
    const r = await R.selectSpotlight(w.db, {}, at(20)); const byId = Object.fromEntries(r.report.order.map((x, i) => [x.id, { i, lane: x.lane }]));
    assert.equal(byId[U(1)].lane, 'welcome', 'its welcome priority survived the cool-off and the backlog'); assert.ok(byId[U(1)].i < byId[U(2)].i, 'it is not sent to the back behind older never-featured businesses');
  });
});

describe('Composing', () => {
  test('a business already queued is never selected again, and entity ids are unique even when a business is retried', async () => {
    const w = world([{ n: 1, name: 'Only Co', claimDay: -30 }]);
    assert.equal((await compose(w, at(0))).business_spotlight, 1);
    assert.equal((await compose(w, at(1))).business_spotlight, 0, 'it is still queued/scheduled');
    spots(w)[0].status = 'failed';
    assert.equal((await compose(w, at(1))).business_spotlight, 0, 'cooling off for 2 days after a failure');
    assert.equal((await compose(w, at(3))).business_spotlight, 1, 'retried after the cool-off, not locked out for 90 days');
    const ids = spots(w).map((p) => p.entity_id); assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every((id) => id.startsWith(`${U(1)}:`)));
  });
  test('a skipped (rejected or stale) post cools off for 7 days, then the business is eligible again', async () => {
    const w = world([{ n: 1, name: 'Only Co', claimDay: -30 }]);
    await compose(w, at(0)); spots(w)[0].status = 'skipped';
    assert.equal((await compose(w, at(4))).business_spotlight, 0); assert.equal((await compose(w, at(8))).business_spotlight, 1);
  });
  test('only a published post blocks for 90 days; the exclusion ends on day 90', async () => {
    const w = world([{ n: 1, name: 'Only Co', claimDay: -300 }]);
    await compose(w, at(0)); const p = spots(w)[0]; p.status = 'posted'; p.posted_at = iso(at(0));
    assert.equal((await compose(w, at(84))).business_spotlight, 0, 'day 84');
    assert.equal((await compose(w, at(91))).business_spotlight, 1, 'day 91 (a Tuesday... or the next posting day): eligible again');
  });
  test('when the day has no free slot the candidate is kept for a later slot, not consumed', async () => {
    const w = world([{ n: 1, name: 'Waiting Co', claimDay: -30 }]);
    for (let d = 0; d <= 3; d++) for (const h of [8, 11, 14]) post(w, { kind: 'wird_of_day', entity_id: `fill:${d}:${h}`, status: 'scheduled', scheduled_for: iso(R.londonInstant(ymdOf(at(d)), h, 0)), entity_type: 'x' });
    const full = await compose(w, at(0)); assert.equal(full.business_spotlight, 0); assert.match(full.skipped.business_spotlight, /no free slot/);
    assert.equal(spots(w).length, 0);
    w.db.tables.social_posts = [];
    assert.equal((await compose(w, at(1))).business_spotlight, 1, 'next run it is still the pick');
  });
  test('only the configured days post: Monday, Tuesday, Thursday and Friday; Wednesday and the weekend do not', async () => {
    const w = world(Array.from({ length: 12 }, (_, i) => ({ n: 1 + i, name: `Biz ${i}`, claimDay: -40 })));
    const days: string[] = [];
    for (let d = 0; d < 14; d++) { const r = await compose(w, at(d)); if (r.business_spotlight) { days.push(R.londonParts(at(d)).weekday); for (const p of spots(w)) if (p.status === 'scheduled') p.status = 'posted', p.posted_at = p.scheduled_for; } }
    assert.deepEqual([...new Set(days)].sort(), ['Fri', 'Mon', 'Thu', 'Tue']);
    assert.equal(days.length, 8, 'four a week');
  });
  test('the administrator snapshot is written each run: the order, the exclusions with reasons, and recent picks', async () => {
    const w = world([{ n: 1, name: 'Good Co', claimDay: -2 }, { n: 2, name: 'Opted Co', claimDay: -2, optOut: true }]);
    await compose(w, at(0)); const snap = JSON.parse(w.db.table('admin_config').find((r) => r.key === 'social.spotlight_pool').value);
    // The snapshot is the selection AS THE RUN SAW IT (before the post was created).
    assert.equal(snap.counts.pool, 2); assert.deepEqual(snap.order.map((x: any) => x.id), [U(1)]); assert.equal(snap.order[0].lane, 'welcome');
    assert.deepEqual(snap.excluded.map((x: any) => [x.id, x.reason]), [[U(2), 'opted-out']]);
    await compose(w, at(1)); const next = JSON.parse(w.db.table('admin_config').find((r) => r.key === 'social.spotlight_pool').value);
    assert.deepEqual(next.excluded.map((x: any) => x.reason).sort(), ['already queued', 'opted-out'], 'the next run shows it queued');
  });
  test('autopilot safeguards are unchanged: an alert still cannot be scheduled, and a recipe with autopilot off still drafts', async () => {
    const w = world([{ n: 1, name: 'Good Co', claimDay: -30 }]); w.recipes.get('business_spotlight').autopilot = false;
    await compose(w, at(0)); assert.equal(spots(w)[0].status, 'draft');
    assert.equal(R.DEFAULTS.business_spotlight.max_pending, 3);
  });
  test('the prepared queue stays small: the pending brake of 3 still applies', async () => {
    const w = world(Array.from({ length: 8 }, (_, i) => ({ n: 1 + i, name: `Biz ${i}`, claimDay: -40 })), {}); w.recipes.get('business_spotlight').autopilot = false;
    for (let d = 0; d < 14; d++) await compose(w, at(d));
    assert.ok(spots(w).filter((p) => p.status === 'draft').length <= 3, 'never more than 3 waiting');
  });
});

/* ───────────────────────────────────── 2. the simulation ───────────────────────────────────── */
// The cast: a quiet launch group, a burst of 15 claims in three days, then a long trickle. Includes listings that must never post, sensitive ones, and some with no photograph.
const SPECS: Spec[] = []; { let n = 1;
  const add = (claimDay: number, count: number, extra: Partial<Spec> = {}) => { for (let i = 0; i < count; i++) SPECS.push({ n, name: `${extra.name ?? 'Business'} ${n}`, claimDay, ...extra }), n++; };
  add(0, 8); add(0, 2, { image: false }); add(1, 1, { name: 'Harbour Counselling', category: 'Counselling' });
  add(7, 6); add(8, 5); add(9, 4, { image: false }); add(9, 1, { name: 'Funeral Directors' });
  add(10, 1, { name: 'Opted Out Consultancy', optOut: true }); add(10, 1, { name: 'Hidden Listing', hidden: true }); add(10, 1, { name: 'Thin Listing', description: 'Nice shop here.' });
  add(14, 2); add(21, 1); add(24, 2); add(28, 1); add(35, 2); add(36, 1, { name: 'Bereavement Support', category: 'Bereavement' }); add(42, 1); add(49, 2); add(56, 1); add(63, 1); add(70, 2); add(84, 1); add(98, 2); add(112, 1);
}
const SENS = new Set(SPECS.filter((s) => /Counselling|Funeral|Bereavement/.test(s.name)).map((s) => U(s.n)));
const DAYS = 18 * 7;
type Load = Record<string, { hour: number; days: string[]; draft?: boolean }>;
// What the OTHER recipes really do (calibrated on production's first full autopilot week: word of the day daily, up to 4 notices, jobs and What's On weekly,
// games twice, a hub post, plus the review-only recipes whose DRAFTS still reserve slots). `draft` ones wait for a person: half are published, the rest retired.
const BEFORE: Load = {
  wird_of_day: { hour: 8, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, whats_on_roundup: { hour: 9, days: ['Mon'] }, event_spotlight: { hour: 18, days: ['Fri'] },
  jobs_roundup: { hour: 9, days: ['Wed'] }, new_product: { hour: 11, days: ['Tue'], draft: true }, notice_update: { hour: 12, days: ['Mon', 'Tue', 'Wed', 'Thu'] },
};
// composed AFTER the spotlight (the composer's order: alerts, notices, spotlights, then the review-only recipes, then games)
const AFTER: Load = { aald_memory: { hour: 19, days: ['Mon', 'Wed', 'Sat'], draft: true }, hub_community: { hour: 10, days: ['Wed', 'Sat'], draft: true }, game_challenge: { hour: 17, days: ['Thu', 'Sun'] } };
const LIGHT: Load = { wird_of_day: BEFORE.wird_of_day, whats_on_roundup: BEFORE.whats_on_roundup, jobs_roundup: BEFORE.jobs_roundup, notice_update: { hour: 12, days: ['Tue', 'Thu'] }, game_challenge: AFTER.game_challenge };

async function simulate(maxPerDay: number, before: Load, after: Load, approveMode: 'reslot' | 'asis' = 'reslot') {
  const w = world(SPECS); w.db.tables.admin_config = [{ key: 'social.max_posts_per_day', value: String(maxPerDay) }];
  const fail = seeded(11), human = seeded(23), claimMs = (s: Spec) => at(s.claimDay).getTime();
  const stats = { otherPlaced: 0, otherMoved: 0, otherLost: 0, spotPicks: 0, spotSlotSkips: 0, spotPosted: 0, spotFailed: 0 };
  const created = new Map<string, string>(); const pickLog: { id: string; lane: string; day: number; post: string }[] = []; const violations: string[] = [];
  const dayCounts = new Map<string, number>();
  const place = async (kinds: Load, now: Date, day: number) => {
    const wd = R.londonParts(now).weekday;
    for (const [kind, c] of Object.entries(kinds)) {
      if (!c.days.includes(wd)) continue;
      const ctx = await R.loadSlotContext(w.db, now);
      const slot = R.allocateSlot({ now, preferredHour: c.hour, taken: ctx.taken, gapMinutes: ctx.gapMinutes, maxPerDay: ctx.maxPerDay, windowStartHour: ctx.windowStartHour, windowEndHour: ctx.windowEndHour, horizonDays: 3, rand: seeded(day + c.hour) });
      if (!slot) { stats.otherLost++; continue; }
      stats.otherPlaced++; if (ymdOf(slot) !== ymdOf(now)) stats.otherMoved++;
      w.db.table('social_posts').push({ id: crypto.randomUUID(), kind, entity_type: 'x', entity_id: `${kind}:${ymdOf(now)}`, status: c.draft ? 'draft' : 'scheduled', scheduled_for: slot.toISOString(), created_at: now.toISOString(), channels: ['facebook'] });
    }
  };
  const expectedPick = (now: Date): string | null => {
    const rows = spots(w); const t = now.getTime();
    const waiting = rows.filter((p) => ['draft', 'approved', 'scheduled'].includes(p.status) && (!p.scheduled_for || Date.parse(p.scheduled_for) >= t - 48 * 3600_000)).length;
    if (waiting >= 3) return null;
    const hist = (id: string) => rows.filter((p) => p.business_id === id);
    const pool = SPECS.filter((s) => !s.unclaimed && claimMs(s) <= t && !s.optOut && !s.hidden && s.description === undefined).filter((s) => {
      const h = hist(U(s.n));
      if (h.some((p) => ['draft', 'approved', 'scheduled'].includes(p.status))) return false;
      if (h.some((p) => p.status === 'posted' && t - Date.parse(p.posted_at) < 90 * DAY)) return false;
      if (h.some((p) => p.status === 'failed' && t < Date.parse(p.scheduled_for) + 2 * DAY)) return false;
      if (h.some((p) => p.status === 'skipped' && t < Date.parse(p.scheduled_for) + 7 * DAY)) return false;
      return true;
    });
    // A failed or skipped attempt keeps its priority: the welcome window is judged at the business's FIRST attempt (or now, if it has had none).
    const lane = (s: Spec) => { const h = hist(U(s.n)); if (h.some((p) => p.status === 'posted')) return 'rotation'; const anchor = h.length ? Math.min(...h.map((p) => Date.parse(p.created_at))) : t; return anchor - claimMs(s) <= 14 * DAY ? 'welcome' : 'new'; };
    const last = (s: Spec) => Math.max(...hist(U(s.n)).filter((p) => p.status === 'posted').map((p) => Date.parse(p.posted_at)));
    const byClaim = (a: Spec, b: Spec) => a.claimDay - b.claimDay || U(a.n).localeCompare(U(b.n));
    const W = pool.filter((s) => lane(s) === 'welcome').sort(byClaim), N = pool.filter((s) => lane(s) === 'new').sort(byClaim);
    const Rr = pool.filter((s) => lane(s) === 'rotation').sort((a, b) => last(a) - last(b) || U(a.n).localeCompare(U(b.n)));
    // consecutive welcome picks among picks that really happened: a post that failed or was skipped never appeared, so it does not count
    const real = pickLog.filter((k) => { const st = rows.find((p) => p.id === k.post)?.status; return st === 'posted' || ['draft', 'approved', 'scheduled'].includes(st); });
    let streak = 0; for (let i = real.length - 1; i >= 0 && real[i].lane === 'welcome'; i--) streak++;
    const pick = streak >= 2 && N.length + Rr.length > 0 ? (N[0] ?? Rr[0]) : (W[0] ?? N[0] ?? Rr[0]);
    return pick ? `${U(pick.n)}|${lane(pick)}` : null;
  };
  for (let day = 0; day < DAYS; day++) {
    const now = at(day); w.db.tables.local_businesses = SPECS.filter((s) => claimMs(s) <= now.getTime()).map(row); w.db.clock = () => iso(now);
    await place(before, now, day);
    const seen = new Set(spots(w).map((p) => p.id)); const expected = expectedPick(now); const res = await compose(w, now);
    const fresh = spots(w).filter((p) => !seen.has(p.id)); assert.ok(fresh.length <= 1, `day ${day}: at most one pick per run`);
    const posting = ['Mon', 'Tue', 'Thu', 'Fri'].includes(R.londonParts(now).weekday);
    if (fresh.length) {
      const p = fresh[0]; stats.spotPicks++; assert.ok(posting, `day ${day}: only on posting days`);
      if (expected) { const [eid, el] = expected.split('|'); assert.equal(p.business_id, eid, `day ${day}: the oracle expected ${eid} (${el}) but ${p.business_id} was picked`); pickLog.push({ id: eid, lane: el, day, post: p.id }); }
      else violations.push(`day ${day}: a pick was made when the oracle expected none`);
      created.set(p.id, p.status);
      assert.equal(p.status, SENS.has(p.business_id) ? 'draft' : 'scheduled', `day ${day}: ${SENS.has(p.business_id) ? 'sensitive is held for a person' : 'ordinary is scheduled by autopilot'}`);
    } else if (posting && expected) { assert.match(res.skipped.business_spotlight ?? '', /no free slot/, `day ${day}: expected ${expected} but ${res.skipped.business_spotlight}`); stats.spotSlotSkips++; }
    await place(after, now, day);
    // people: approve held spotlight drafts after a day (70%), re-slotted; half of the other recipes' review-only drafts are published at their slot, the rest retired
    for (const p of w.db.table('social_posts')) {
      if (p.status !== 'draft') continue;
      if (p.kind === 'business_spotlight') {
        if (now.getTime() - Date.parse(p.created_at) >= DAY && human() < 0.7) {
          const ctx = await R.loadSlotContext(w.db, now);
          // approving keeps the draft's own day; if that time has passed it takes the next free slot on a day with no other spotlight
          const days = new Set(spots(w).filter((x) => x.id !== p.id && ['draft', 'approved', 'scheduled', 'posted'].includes(x.status)).map((x) => ymdOf(new Date(Date.parse(x.scheduled_for)))));
          const slot = Date.parse(p.scheduled_for) > now.getTime() + 30 * 60_000 ? new Date(p.scheduled_for) : R.allocateSlot({ now, preferredHour: 14, taken: ctx.taken, gapMinutes: ctx.gapMinutes, maxPerDay: ctx.maxPerDay, windowStartHour: ctx.windowStartHour, windowEndHour: ctx.windowEndHour, horizonDays: 3, excludeDays: days });
          if (slot) { p.status = 'scheduled'; p.scheduled_for = slot.toISOString(); }
        }
      } else if (Date.parse(p.scheduled_for) <= now.getTime() + 18 * 3600_000) {
        if (human() < 0.5) {
          if (approveMode === 'reslot') {   // a person approves it and it takes a real slot against everything committed
            const ctx = await R.loadSlotContext(w.db, now);
            const slot = R.allocateSlot({ now, preferredHour: 15, taken: ctx.taken, gapMinutes: ctx.gapMinutes, maxPerDay: ctx.maxPerDay, windowStartHour: ctx.windowStartHour, windowEndHour: ctx.windowEndHour, horizonDays: 3 });
            if (slot) { p.status = 'scheduled'; p.scheduled_for = slot.toISOString(); } else p.status = 'skipped';
          } else { p.status = 'posted'; p.posted_at = p.scheduled_for; }   // worst case: it goes out at the time it was drafted for
        } else p.status = 'skipped';
      }
    }
    const endOfDay = now.getTime() + 18 * 3600_000;
    for (const p of w.db.table('social_posts')) if (p.status === 'scheduled' && Date.parse(p.scheduled_for) <= endOfDay) {
      if (p.kind === 'business_spotlight' && fail() < 0.08) { p.status = 'failed'; p.error = 'Facebook said no'; stats.spotFailed++; }
      else { p.status = 'posted'; p.posted_at = p.scheduled_for; if (p.kind === 'business_spotlight') stats.spotPosted++; }
    }
  }
  for (const p of w.db.table('social_posts')) if (p.status === 'posted') { const d = ymdOf(new Date(Date.parse(p.posted_at))); dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1); }
  assert.deepEqual(violations, []);
  return { w, stats, created, pickLog, dayCounts };
}

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
function checkInvariants(name: string, sim: Awaited<ReturnType<typeof simulate>>, maxPerDay: number) {
  const { w, stats, created, pickLog } = sim; const SP = spots(w);
  // shared daily limits, for EVERY recipe
  const by = new Map<string, number[]>();
  for (const p of w.db.table('social_posts').filter((x) => x.status === 'posted')) { const t = Date.parse(p.posted_at); const lp = R.londonParts(new Date(t)); (by.get(lp.ymd) ?? by.set(lp.ymd, []).get(lp.ymd)!).push(t); assert.ok(lp.hour * 60 + lp.minute >= 8 * 60 && lp.hour * 60 + lp.minute <= 20 * 60, `${name} ${lp.ymd}: outside the window`); }
  let busiest = 0; for (const [d, ts] of by) { ts.sort((a, b) => a - b); busiest = Math.max(busiest, ts.length); assert.ok(ts.length <= maxPerDay, `${name} ${d}: ${ts.length} posts`); for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 120 * 60_000, `${name} ${d}: two posts ${(ts[i] - ts[i - 1]) / 60000} minutes apart`); }
  // at most ONE Business Spotlight on any day
  const perDay = new Map<string, number>(); for (const p of SP.filter((x) => ['posted', 'scheduled', 'approved', 'draft'].includes(x.status))) { const d = ymdOf(new Date(Date.parse(p.status === 'posted' ? p.posted_at : p.scheduled_for))); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
  for (const [d, n] of perDay) assert.ok(n <= 1, `${name}: ${n} Business Spotlights on ${d}`);
  // unique ids, never queued twice
  const ids = SP.map((p) => p.entity_id); assert.equal(new Set(ids).size, ids.length, 'duplicate (kind, entity_id)');
  const tl = SP.flatMap((p) => [{ t: Date.parse(p.created_at), d: 1 }, { t: Date.parse(p.status === 'posted' ? p.posted_at : p.scheduled_for) + 1, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0; for (const e of tl) { cur += e.d; peak = Math.max(peak, cur); } assert.ok(peak <= 3, `${name}: peak queue ${peak}`);
  // the 90-day rule
  let repeats = 0;
  for (const s of SPECS) { const t = SP.filter((p) => p.business_id === U(s.n) && p.status === 'posted').map((p) => Date.parse(p.posted_at)).sort((a, b) => a - b); for (let i = 1; i < t.length; i++) { assert.ok(t[i] - t[i - 1] >= 90 * DAY, `${name}: ${s.name} repeated after ${Math.round((t[i] - t[i - 1]) / DAY)} days`); repeats++; } }
  // never-eligible listings never post; sensitive ones only as drafts first; no-photo ones use the card
  const bad = new Set(SPECS.filter((s) => s.optOut || s.hidden || s.description !== undefined).map((s) => U(s.n))); assert.equal(SP.filter((p) => bad.has(p.business_id)).length, 0);
  for (const p of SP.filter((x) => SENS.has(x.business_id))) assert.equal(created.get(p.id), 'draft');
  for (const p of SP.filter((x) => SPECS.find((s) => U(s.n) === x.business_id)?.image === false)) assert.equal(p.image_url, `https://oneshetland.com/api/social-image?kind=business&id=${p.business_id}`);
  // failed sends are retried, never locked out
  const failed = SP.filter((p) => p.status === 'failed'); let retried = 0; const retryGaps: number[] = [];
  for (const f of failed) { const later = SP.filter((p) => p.business_id === f.business_id && Date.parse(p.created_at) > Date.parse(f.created_at)); if (later.length) { retried++; retryGaps.push((Date.parse(later[0].created_at) - Date.parse(f.created_at)) / DAY); } }
  // welcome cap and lanes
  let run = 0, worst = 0; for (const p of pickLog) { run = p.lane === 'welcome' ? run + 1 : 0; worst = Math.max(worst, run); }
  // fair waits
  const auto = SPECS.filter((s) => !s.optOut && !s.hidden && s.description === undefined && !SENS.has(U(s.n)));
  const first = new Map<string, number>(); for (const p of SP.filter((x) => x.status === 'posted')) { const t = Date.parse(p.posted_at); if (!first.has(p.business_id) || t < first.get(p.business_id)!) first.set(p.business_id, t); }
  const waits = auto.map((s) => ({ s, wait: first.has(U(s.n)) ? (first.get(U(s.n))! - at(s.claimDay).getTime()) / DAY : Infinity }));
  const wk = new Map<number, number>(); for (const p of SP) { const k = Math.floor((Date.parse(p.created_at) - T0.getTime()) / (7 * DAY)); wk.set(k, (wk.get(k) ?? 0) + 1); }
  const perWeek = [...wk.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const burst = waits.filter((x) => x.s.claimDay >= 7 && x.s.claimDay <= 10), trickle = waits.filter((x) => x.s.claimDay >= 21);
  const sens = SP.filter((p) => SENS.has(p.business_id));
  console.log(`# [${name}] shared limit ${maxPerDay}/day: busiest day ${busiest}; other recipes placed ${stats.otherPlaced}, pushed to a later day ${stats.otherMoved}, lost ${stats.otherLost}`);
  console.log(`# [${name}] spotlight picks per week: ${perWeek.join(' ')}; total ${stats.spotPicks}; sends ok ${stats.spotPosted}, failed ${stats.spotFailed} (retried ${retried}, after ${retryGaps.map((g) => g.toFixed(0)).join('/')} days); days with no free slot ${stats.spotSlotSkips}`);
  console.log(`# [${name}] first-feature wait in days (n=${waits.length}): median ${q(waits.map((x) => x.wait).filter(isFinite), 0.5).toFixed(0)}, p90 ${q(waits.map((x) => x.wait).filter(isFinite), 0.9).toFixed(0)}, max ${Math.max(...waits.map((x) => x.wait).filter(isFinite)).toFixed(0)}; never featured: ${waits.filter((x) => !isFinite(x.wait)).length}; burst median ${q(burst.map((x) => x.wait).filter(isFinite), 0.5).toFixed(0)} max ${Math.max(...burst.map((x) => x.wait).filter(isFinite)).toFixed(0)}; later claims median ${q(trickle.map((x) => x.wait).filter(isFinite), 0.5).toFixed(0)} max ${Math.max(...trickle.map((x) => x.wait).filter(isFinite)).toFixed(0)}`);
  console.log(`# [${name}] lanes used: welcome ${pickLog.filter((p) => p.lane === 'welcome').length}, new ${pickLog.filter((p) => p.lane === 'new').length}, rotation ${pickLog.filter((p) => p.lane === 'rotation').length}; longest welcome run ${worst}; 90-day repeats ${repeats} (all after 90+ days); sensitive: ${new Set(sens.map((p) => p.business_id)).size} businesses, ${sens.filter((p) => p.status === 'posted').length} approved and published`);
  return { waits, perWeek, retried, failed: failed.length, worst, repeats };
}

describe('Simulation: 40+ businesses over 18 weeks (quiet start, a 15-claim burst, a long trickle) through the real composer, with every other recipe sharing the daily limit', () => {
  test('production-like load, limit of 3 a day: every rule holds and four a week is still delivered', async () => {
    const sim = await simulate(3, BEFORE, AFTER); const r = checkInvariants('3/day, production-like', sim, 3);
    assert.equal(r.waits.filter((x) => !isFinite(x.wait)).length, 0, 'every eligible, non-sensitive business was featured within the 18 weeks');
    assert.ok(r.failed > 0 && r.retried >= r.failed - 4, 'sends failed and were retried');
    assert.ok(sim.pickLog.some((p) => p.lane === 'new'), 'the never-featured lane got turns during the burst');
    assert.ok(r.perWeek.slice(0, 10).every((c) => c >= 3), `about four a week even on a busy calendar, now that review-only drafts do not reserve slots: ${r.perWeek}`);
  });
  test('worst case for the draft change: if a person approves a review-only draft and it goes out at the time it was drafted for, how often does a day exceed the limit?', async () => {
    const sim = await simulate(4, BEFORE, AFTER, 'asis'); const over = [...sim.dayCounts.entries()].filter(([, n]) => n > 4);
    console.log(`# [4/day, drafts approved and published as-is] days over the limit of 4: ${over.length} of ${sim.dayCounts.size}${over.length ? ` (worst ${Math.max(...over.map((o) => o[1]))} posts)` : ''}; autopilot posts and every scheduled or approved post were still placed within the limit`);
    assert.ok(spots(sim.w).length > 0);
  });
  test('the same load with the limit raised to 4 a day for launch: four a week is delivered and the burst clears in weeks', async () => {
    const sim = await simulate(4, BEFORE, AFTER); const r = checkInvariants('4/day, production-like', sim, 4);
    assert.equal(r.waits.filter((x) => !isFinite(x.wait)).length, 0);
    assert.ok(r.perWeek.slice(0, 5).every((c) => c >= 3), `about four a week while there is a backlog: ${r.perWeek.slice(0, 5)}`);
    const later = r.waits.filter((x) => x.s.claimDay >= 21).map((x) => x.wait); assert.ok(Math.max(...later) <= 14, 'once the burst has cleared a new claim is featured within two weeks');
  });
  test('a lighter calendar (as in a quiet week for the other recipes) at 3 a day also delivers about four a week', async () => {
    const sim = await simulate(3, LIGHT, {}); const r = checkInvariants('3/day, light calendar', sim, 3);
    assert.equal(r.waits.filter((x) => !isFinite(x.wait)).length, 0);
    assert.ok(r.perWeek.slice(0, 4).every((c) => c >= 3), `${r.perWeek.slice(0, 4)}`);
  });
});

/**
 * social-event-occurrences.node.test.ts — Social Studio and events that run on several dates (Events Phase 1).
 *
 * Runs the REAL deployed-lineage composer and publisher (supabase/functions/social-composer, social-publisher) and the real
 * _shared/event-occurrence-dates.ts against an in-memory database. No network, no Meta, nothing is posted.
 *
 *   · a dated run is listed ONCE, under its NEXT LIVE date, never once per performance
 *   · cancelled and past dates are never advertised; a run with no live date is not advertised at all
 *   · one event_spotlight per production, ever (dedupe key = event id)
 *   · send time: a spotlight is skipped if the run lost every live date / was cancelled; nothing else is newly blocked
 *   · TOLERANT: with no event_occurrences table, or no rows for an event, behaviour is exactly the old behaviour
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDb } from './_support/fake-svc.ts';
import { loadComposer, loadPublisher } from './_support/load-social-fns.ts';
import { runState, listOncePerProduction, runBlocksPost, loadOccurrences } from '../functions/_shared/event-occurrence-dates.ts';

const MON = new Date('2026-11-02T05:40:00Z');
const iso = (d: Date) => d.toISOString();
const plusH = (h: number, from = MON) => iso(new Date(from.getTime() + h * 3600_000));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function world(on: string[], opts: { occurrenceTable?: boolean } = {}) {
  const db = new FakeDb(); db.clock = () => iso(MON);
  db.tables.social_recipes = ['wird_of_day', 'whats_on_roundup', 'event_spotlight', 'jobs_roundup', 'new_product']
    .map((k) => ({ key: k, enabled: on.includes(k), autopilot: false, config: {}, last_run_at: null }));
  db.tables.social_posts = []; db.tables.events = []; db.tables.admin_config = []; db.tables.event_occurrences = [];
  if (opts.occurrenceTable === false) db.failTables.add('event_occurrences');
  return db;
}
const ev = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: `Show ${n}`, starts_at: plusH(48), venue: 'Hall', locality: 'Lerwick', status: 'published', is_hidden: false, organiser_business_id: null, ...o });
const spotEv = (n: number, o: Record<string, any> = {}) => ev(n, { organiser_business_id: U(900), local_businesses: { subscription_tier: 'premium', name: 'Peerie Theatre' }, ...o });
const occ = (e: number, hours: number, status = 'scheduled') => ({ event_id: U(e), starts_at: plusH(hours), status });
const posts = (db: FakeDb, kind: string) => db.table('social_posts').filter((p) => p.kind === kind);
const run = async (db: FakeDb) => (await loadComposer(db))(MON);

describe('pure helper', () => {
  const after = MON;
  test('no rows = plain', () => assert.deepEqual(runState(undefined, after), { kind: 'plain' }));
  test('next live date skips cancelled and past', () => {
    const rows = [occ(1, -24), occ(1, 24, 'cancelled'), occ(1, 72), occ(1, 48)];
    assert.deepEqual(runState(rows, after), { kind: 'run', next: plusH(48) });
  });
  test('all cancelled or past = gone', () => assert.deepEqual(runState([occ(1, -5), occ(1, 30, 'cancelled')], after), { kind: 'gone' }));
  test("status 'changed' is still live", () => assert.equal(runState([occ(1, 30, 'changed')], after).kind, 'run'));
  test('listOncePerProduction: once, re-dated, plain untouched, gone dropped, window respected', () => {
    const plain = ev(1); const run1 = ev(2, { starts_at: plusH(24) }); const gone = ev(3);
    const map = new Map([[U(2), [occ(2, 24, 'cancelled'), occ(2, 96), occ(2, 120)]], [U(3), [occ(3, 30, 'cancelled')]]]);
    const out = listOncePerProduction([plain, run1, run1, gone], map, after);
    assert.deepEqual(out.map((e) => e.id), [U(1), U(2)]);
    assert.equal(out[0], plain);                         // same object: untouched
    assert.equal(out[1].starts_at, plusH(96));
    assert.deepEqual(listOncePerProduction([run1], map, after, new Date(plusH(90))), []);   // next live date is outside the window
  });
  test('runBlocksPost only ever fires for events that have occurrence rows', () => {
    assert.equal(runBlocksPost(undefined, { status: 'cancelled' }, MON), null);
    assert.equal(runBlocksPost([], { status: 'cancelled', is_hidden: true }, MON), null);
    assert.match(runBlocksPost([occ(1, 30)], { status: 'cancelled' }, MON)!, /cancelled/);
    assert.match(runBlocksPost([occ(1, 30, 'cancelled')], { status: 'published' }, MON)!, /no live date/);
    assert.equal(runBlocksPost([occ(1, 30)], { status: 'published', is_hidden: false }, MON), null);
  });
  test('loadOccurrences tolerates a missing table', async () => {
    const db = world([], { occurrenceTable: false });
    assert.equal((await loadOccurrences(db, [U(1)])).size, 0);
  });
});

describe('whats_on_roundup', () => {
  test('a 3-night run appears ONCE, with its next live date', async () => {
    const db = world(['whats_on_roundup']);
    db.tables.events = [ev(1, { title: 'Panto', starts_at: plusH(24) }), ev(2), ev(3, { starts_at: plusH(60) })];
    db.tables.event_occurrences = [occ(1, 24, 'cancelled'), occ(1, 50), occ(1, 74)];
    await run(db);
    const [p] = posts(db, 'whats_on_roundup');
    assert.equal(p.caption.split('Panto').length - 1, 1, 'listed once');
    assert.match(p.caption, /Panto/);
    assert.equal(db.table('social_posts').length, 1);
  });
  test('re-running the same week cannot post it twice (key = ISO week)', async () => {
    const db = world(['whats_on_roundup']); db.tables.events = [ev(1), ev(2), ev(3)];
    await run(db); const second = await run(db);
    assert.equal(posts(db, 'whats_on_roundup').length, 1);
    assert.ok(second.errors.length >= 0);
  });
  test('a run whose every date is cancelled is left out', async () => {
    const db = world(['whats_on_roundup']);
    db.tables.events = [ev(1, { title: 'Dead Run' }), ev(2), ev(3), ev(4)];
    db.tables.event_occurrences = [occ(1, 48, 'cancelled'), occ(1, 72, 'cancelled')];
    await run(db);
    const [p] = posts(db, 'whats_on_roundup'); assert.doesNotMatch(p.caption, /Dead Run/);
  });
  test('UNCHANGED for events without occurrences: same caption with and without the table', async () => {
    const mk = (tableMissing: boolean) => { const db = world(['whats_on_roundup'], { occurrenceTable: !tableMissing }); db.tables.events = [ev(1), ev(2), ev(3, { starts_at: plusH(60) })]; return db; };
    const a = mk(true), b = mk(false);
    await run(a); await run(b);
    const strip = (p: any) => ({ caption: p.caption, image_url: p.image_url, link_url: p.link_url, entity_id: p.entity_id });
    assert.deepEqual(strip(posts(a, 'whats_on_roundup')[0]), strip(posts(b, 'whats_on_roundup')[0]));
    assert.equal(posts(a, 'whats_on_roundup').length, 1);
  });
  test('table absent: no error is reported and the post is still made', async () => {
    const db = world(['whats_on_roundup'], { occurrenceTable: false }); db.tables.events = [ev(1), ev(2), ev(3)];
    const r = await run(db); assert.deepEqual(r.errors, []); assert.equal(posts(db, 'whats_on_roundup').length, 1);
  });
});

describe('event_spotlight', () => {
  test('uses the next live date and the event id as the dedupe key', async () => {
    const db = world(['event_spotlight']);
    db.tables.events = [spotEv(1, { title: 'Big Show', starts_at: plusH(24) })];
    db.tables.event_occurrences = [occ(1, 24, 'cancelled'), occ(1, 100), occ(1, 124)];
    await run(db);
    const ps = posts(db, 'event_spotlight'); assert.equal(ps.length, 1); assert.equal(ps[0].entity_id, U(1));
    const day = new Date(plusH(100)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
    assert.match(ps[0].caption, new RegExp(day));
  });
  test('a second run (or later date) never posts the same production again', async () => {
    const db = world(['event_spotlight']);
    db.tables.events = [spotEv(1)]; db.tables.event_occurrences = [occ(1, 48), occ(1, 72)];
    await run(db); await run(db); await (await loadComposer(db))(new Date(plusH(60)));
    assert.equal(posts(db, 'event_spotlight').length, 1);
  });
  test('a run with no live date is not spotlighted', async () => {
    const db = world(['event_spotlight']); db.tables.events = [spotEv(1)];
    db.tables.event_occurrences = [occ(1, 48, 'cancelled'), occ(1, 72, 'cancelled')];
    await run(db); assert.equal(posts(db, 'event_spotlight').length, 0);
  });
  test('UNCHANGED for a plain event, with or without the table', async () => {
    for (const present of [true, false]) {
      const db = world(['event_spotlight'], { occurrenceTable: present }); db.tables.events = [spotEv(1, { title: 'Plain' })];
      const r = await run(db); assert.deepEqual(r.errors, []);
      const [p] = posts(db, 'event_spotlight');
      assert.match(p.caption, /Plain/); assert.equal(p.link_url, `https://oneshetland.com/go/event/${U(1)}`);
    }
  });
});

describe('social-publisher send-time check', () => {
  const draft = (n: number) => ({ id: `post${n}`, kind: 'event_spotlight', entity_id: U(n), caption: 'x https://oneshetland.com', image_url: null, link_url: 'https://oneshetland.com/go/event/' + U(n), status: 'scheduled', scheduled_for: plusH(-1), channels: ['facebook'], posted_ids: {} });
  async function publish(db: FakeDb) {
    const { run: r, graph, restore } = await loadPublisher(db);
    try { const out = await r(MON); return { out, graph }; } finally { restore(); }
  }
  test('all dates cancelled since queuing: skipped, nothing sent to Meta', async () => {
    const db = world([]); db.tables.events = [spotEv(1)]; db.tables.social_posts = [draft(1)];
    db.tables.event_occurrences = [occ(1, 48, 'cancelled'), occ(1, 72, 'cancelled')];
    const { out, graph } = await publish(db);
    assert.equal(out.skipped, 1); assert.equal(graph.length, 0);
    assert.equal(db.table('social_posts')[0].status, 'skipped'); assert.match(db.table('social_posts')[0].error, /no live date/);
  });
  test('run cancelled as a whole: skipped', async () => {
    const db = world([]); db.tables.events = [spotEv(1, { status: 'cancelled' })]; db.tables.social_posts = [draft(1)];
    db.tables.event_occurrences = [occ(1, 48), occ(1, 72)];
    const { graph } = await publish(db); assert.equal(graph.length, 0);
  });
  test('one night cancelled but another live: still posts', async () => {
    const db = world([]); db.tables.events = [spotEv(1)]; db.tables.social_posts = [draft(1)];
    db.tables.event_occurrences = [occ(1, 48, 'cancelled'), occ(1, 72)];
    const { out, graph } = await publish(db); assert.equal(out.posted, 1); assert.equal(graph.length, 1);
  });
  test('a plain event (no occurrence rows) posts exactly as before, even if its status is odd', async () => {
    const db = world([]); db.tables.events = [spotEv(1, { status: 'cancelled' })]; db.tables.social_posts = [draft(1)];
    const { out, graph } = await publish(db); assert.equal(out.posted, 1); assert.equal(graph.length, 1);
  });
  test('table absent (migration not applied): posts exactly as before', async () => {
    const db = world([], { occurrenceTable: false }); db.tables.events = [spotEv(1)]; db.tables.social_posts = [draft(1)];
    const { out } = await publish(db); assert.equal(out.posted, 1);
  });
  test('other kinds are never touched by the check', async () => {
    const db = world([]); db.tables.social_posts = [{ ...draft(1), kind: 'whats_on_roundup', entity_id: '2026-W45' }];
    db.tables.event_occurrences = [occ(1, 48, 'cancelled')];
    const { out } = await publish(db); assert.equal(out.posted, 1);
  });
});

describe('source guards', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  test('no events select names a Phase-1 column (migration-independent)', () => {
    for (const f of ['supabase/functions/social-composer/index.ts', 'supabase/functions/social-publisher/index.ts', 'supabase/functions/_shared/event-occurrence-dates.ts'])
      assert.doesNotMatch(read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /is_dated_run|organiser_name|submission_id/);
  });
  test('Business Spotlight is not part of this deployed lineage and was not touched', () => {
    assert.doesNotMatch(read('supabase/functions/social-composer/index.ts'), /business_spotlight/);
  });
});

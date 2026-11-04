/**
 * social-notice-images.node.test.ts — category artwork for Social Studio notice posts.
 *
 * Real shared module + real composer + real publisher against an in-memory database. fetch is replaced: NOTHING reaches Meta, nothing is posted.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeDb } from './_support/fake-svc.ts';
import * as R from '../functions/_shared/social-recipes.ts';

const FN = join(dirname(fileURLToPath(import.meta.url)), '..', 'functions');
const WEB = process.env.WEB_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web-notice-images');
const NOW = new Date('2026-11-04T05:40:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const ahead = (d: number) => new Date(NOW.getTime() + d * 86400_000).toISOString();
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = 'https://oneshetland.com/social/notices/';
const CATEGORIES: Record<string, string> = {
  travel_transport: 'travel', health: 'health', public_services: 'council', consultations_funding: 'consultations',
  community: 'community', schools_education: 'community', appeals_volunteering: 'community', lost_found: 'community', other: 'community',
};

const notice = (n: number, o: Record<string, any> = {}) => ({ id: U(n), title: `Notice number ${n}`, body: 'Details of the change are on the OneShetland notice page.', category: 'community',
  published_at: ago(1), expires_at: ahead(10), review_at: null, image_url: null, action_text: null, link_url: null, is_essential_active: false, publisher: { label: 'Shetland Islands Council' }, ...o });
const meta = (n: number, o: Record<string, any> = {}) => ({ id: U(n), is_person_notice: false, status: 'published', is_hidden: false, visibility: 'public', withdrawn_at: null, source_label: null, ...o });
function world(notices: any[], metas: any[] = [], alerts: any[] = []) {
  const db = new FakeDb();
  db.rpcs.get_public_notices = (a: any) => {
    const src = a.p_level === 'essential' ? alerts : notices;
    return a.p_id ? src.filter((n) => n.id === a.p_id) : src;
  };
  db.tables.notices = [...notices, ...alerts].map((n) => metas.find((m) => m.id === n.id) ?? meta(Number(n.id.slice(-12))));
  db.tables.admin_config = [];
  return db;
}

describe('category → image mapping', () => {
  for (const [cat, file] of Object.entries(CATEGORIES)) {
    test(`${cat} → ${file}`, () => assert.equal(R.noticeCategoryImage(cat), `${BASE}notice-${file}.jpg`));
  }
  test('missing, empty, unknown or oddly-cased categories fall back to the Community Notice card', () => {
    for (const c of [null, undefined, '', '  ', 'something_new', 'funeral']) assert.equal(R.noticeCategoryImage(c), `${BASE}notice-community.jpg`);
    assert.equal(R.noticeCategoryImage(' HEALTH '), `${BASE}notice-health.jpg`);
  });
  test('every mapped image is an https URL on the OneShetland site', () => {
    for (const c of [...Object.keys(CATEGORIES), null]) assert.match(R.noticeCategoryImage(c), /^https:\/\/oneshetland\.com\/social\/notices\/notice-[a-z]+\.jpg$/);
  });
});

describe('composer: the right image is chosen for each notice', () => {
  test('every category gets its image on the candidate, and the link to the original notice is kept', async () => {
    const cats = Object.keys(CATEGORIES);
    const db = world(cats.map((c, i) => notice(i + 1, { category: c })));
    const out = await R.selectNotices(db, R.DEFAULTS.notice_update, NOW);
    assert.equal(out.length, cats.length);
    for (const c of out) {
      const cat = cats[Number(c.entity_id!.slice(-12)) - 1];
      assert.equal(c.image_url, `${BASE}notice-${CATEGORIES[cat]}.jpg`, cat);
      assert.equal(c.link_url, `https://oneshetland.com/go/notice/${c.entity_id}`);
      assert.ok(c.caption.includes(c.link_url!), 'link is in the caption too, so Facebook shows it under the photo');
    }
  });
  test('a notice with its own https image keeps it; a null category uses Community', async () => {
    const db = world([notice(1, { image_url: 'https://cdn.example/own.jpg', category: 'health' }), notice(2, { category: null })]);
    const out = await R.selectNotices(db, R.DEFAULTS.notice_update, NOW);
    assert.deepEqual(out.map((c) => c.image_url), ['https://cdn.example/own.jpg', `${BASE}notice-community.jpg`]);
  });
  test('funeral / person / sensitive notices are still never selected (so never get an image)', async () => {
    const db = world(
      [notice(1, { title: 'Funeral service for Mr X' }), notice(2), notice(3, { category: 'health', body: 'Following the death of a resident the hall is closed.' })],
      [meta(2, { is_person_notice: true })]);
    assert.deepEqual(await R.selectNotices(db, R.DEFAULTS.notice_update, NOW), []);
  });
  test('essential alerts get NO image', async () => {
    const db = world([], [], [notice(1, { title: 'A970 closed at Sellafirth', body: 'Road closed after a landslip.', category: 'travel_transport', is_essential_active: true, review_at: ahead(3), action_text: 'Use the diversion.' })]);
    const out = await R.selectAlerts(db, R.DEFAULTS.essential_alert, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].image_url, null);
  });
});

describe('a composed post is stored with the image; approval rules are unchanged', () => {
  test('notice_update draft carries image_url, stays draft with autopilot off', async () => {
    const db = world([notice(1, { category: 'health' })]);
    const recipes = new Map<string, any>(); for (const k of R.NEW_KINDS) recipes.set(k, { key: k, enabled: k === 'notice_update', autopilot: false, config: {} });
    await R.composeNewRecipes({ svc: db, now: NOW, recipes, rand: () => 0.5 });
    const p = db.table('social_posts');
    assert.equal(p.length, 1);
    assert.equal(p[0].image_url, `${BASE}notice-health.jpg`);
    assert.equal(p[0].status, 'draft');
    assert.equal(p[0].link_url, `https://oneshetland.com/go/notice/${U(1)}`);
  });
});

describe('publisher: image post to Facebook (mocked Graph API)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  let n = 0;
  async function load(db: FakeDb) {
    const dir = mkdtempSync(join(tmpdir(), 'publisher-'));
    mkdirSync(join(dir, 'social-publisher')); mkdirSync(join(dir, '_shared'));
    writeFileSync(join(dir, '_shared', 'social-recipes.ts'), readFileSync(join(FN, '_shared', 'social-recipes.ts'), 'utf8'));
    const src = readFileSync(join(FN, 'social-publisher', 'index.ts'), 'utf8')
      .replace(/import \{ serve \} from '[^']+';/, 'const serve = (h: any) => { (globalThis as any).__pubHandler = h; };')
      .replace(/import \{ createServiceClient \} from '[^']+';/, 'const createServiceClient = () => (globalThis as any).__db;')
      .replace(/import \{ requireCronSecret \} from '[^']+';/, 'const requireCronSecret = (_r: unknown, _c: unknown) => null;')
      .replace(/import \{ getConfig \} from '[^']+';/, 'const getConfig = async (_s: unknown, _k: string, d: string) => d;');
    writeFileSync(join(dir, 'social-publisher', 'index.ts'), src);
    (globalThis as any).__db = db;
    (globalThis as any).Deno = { env: { get: (k: string) => ({ META_PAGE_ID: 'PAGE1', META_PAGE_TOKEN: 'TOKEN' } as Record<string, string>)[k] } };
    await import(pathToFileURL(join(dir, 'social-publisher', 'index.ts')).href + `?v=${++n}`);
    return (globalThis as any).__pubHandler as (r: Request) => Promise<Response>;
  }
  const mockGraph = () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      calls.push({ url: String(input), body: init?.body as URLSearchParams });
      return new Response(JSON.stringify({ id: '1', post_id: 'PAGE1_999' }), { status: 200 });
    }) as typeof fetch;
    return calls;
  };
  const queued = (o: Record<string, any>) => ({ id: 'p1', kind: 'notice_update', entity_id: U(1), status: 'approved', channels: ['facebook'], posted_ids: {}, scheduled_for: null,
    caption: `COMMUNITY NOTICE\n\nRead the full notice: https://oneshetland.com/go/notice/${U(1)}`, link_url: `https://oneshetland.com/go/notice/${U(1)}`, ...o });

  test('a notice post with a category image goes to /photos with that url and the original-notice link in the caption', async () => {
    const db = world([notice(1, { category: 'travel_transport' })]); db.tables.social_posts = [queued({ image_url: `${BASE}notice-travel.jpg` })];
    const calls = mockGraph();
    const res = await (await load(db))(new Request('http://x/', { method: 'POST', body: '{}' }));
    const out = await res.json();
    assert.equal(out.posted, 1, JSON.stringify(out));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/PAGE1\/photos$/);
    assert.equal(calls[0].body.get('url'), `${BASE}notice-travel.jpg`);
    assert.ok(calls[0].body.get('caption')!.includes(`/go/notice/${U(1)}`));
    assert.equal(db.table('social_posts')[0].status, 'posted');
  });
  test('without an image the publisher still posts a link post (existing behaviour unchanged)', async () => {
    const db = world([notice(1)]); db.tables.social_posts = [queued({ image_url: null })];
    const calls = mockGraph();
    await (await load(db))(new Request('http://x/', { method: 'POST', body: '{}' }));
    assert.match(calls[0].url, /\/PAGE1\/feed$/);
    assert.equal(calls[0].body.get('link'), `https://oneshetland.com/go/notice/${U(1)}`);
  });
  test('send-time re-check still blocks a notice that became sensitive/withdrawn: no Graph call', async () => {
    const db = world([notice(1)], [meta(1, { withdrawn_at: ago(0.1) })]); db.tables.social_posts = [queued({ image_url: `${BASE}notice-community.jpg` })];
    const calls = mockGraph();
    const out = await (await (await load(db))(new Request('http://x/', { method: 'POST', body: '{}' }))).json();
    assert.equal(calls.length, 0); assert.equal(out.skipped, 1);
    assert.equal(db.table('social_posts')[0].status, 'skipped');
  });
});

describe('the image files', () => {
  const files = ['community', 'health', 'council', 'travel', 'consultations'];
  const dir = join(WEB, 'public', 'social', 'notices');
  test('all five 1200x630 JPEGs exist in the web repo public folder and every mapped name is covered', () => {
    for (const f of files) {
      const p = join(dir, `notice-${f}.jpg`);
      assert.ok(existsSync(p), p);
      const b = readFileSync(p);
      assert.deepEqual([...b.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic');
      assert.ok(statSync(p).size < 300_000, 'small enough for Facebook');
      // SOF0/SOF2 marker → height, width
      let i = 2, w = 0, h = 0;
      while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m === 0xc0 || m === 0xc2) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + b.readUInt16BE(i + 2); }
      assert.deepEqual([w, h], [1200, 630], f);
    }
    for (const c of [...Object.keys(CATEGORIES), null]) {
      const name = R.noticeCategoryImage(c).split('/').pop()!;
      assert.ok(existsSync(join(dir, name)), `${c} → ${name} exists`);
    }
  });
});

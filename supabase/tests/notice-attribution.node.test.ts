/**
 * notice-attribution.node.test.ts — Notices Stage 3A.2: the right publisher on every notice, in the app.
 *
 * Pure unit + contract tests. The REAL helper (lib/notice-publisher.ts, lib/notice-feed.ts) and the REAL readers (lib/concierge-api.ts,
 * lib/hubs-api.ts) run under node with a fake Supabase client that records every query. No network, no database, no notification.
 *
 * PRIVACY: a person's name is only ever what the notice_publisher_display RPC returns; the fake RPC below behaves like the database (it
 * releases a name only for an approved, public notice), and the tests prove the client never reads profiles.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const pub = loadModule('lib/notice-publisher.ts') as typeof import('../../lib/notice-publisher.ts');
const feed = loadModule('lib/notice-feed.ts', { './notice-publisher': pub }) as typeof import('../../lib/notice-feed.ts');
const { noticePublisher, safeSourceUrl, resolveKind } = pub;

const HUB = { id: 'hub-1', name: 'Voe Hall', logo_url: 'https://img/hub.png', brand_color: '#336699', slug: 'voe-hall' };
const BIZ = { id: 'biz-1', name: 'Bea Bakery', logo_url: 'https://img/biz.png', brand_color: '#aa5500', slug: 'bea-bakery' };

describe('publisher helper - every kind', () => {
  test('hub: name, "Posted by", logo, brand colour, link to the hub page', () => {
    const p = noticePublisher({ publisher_kind: 'hub', publisher_hub_id: 'hub-1', hub: HUB });
    assert.deepEqual([p.kind, p.label, p.byline, p.logo_url, p.brand_color, p.mark], ['hub', 'Voe Hall', 'Posted by Voe Hall', 'https://img/hub.png', '#336699', 'hub']);
    assert.deepEqual(p.destination, { type: 'hub', id: 'hub-1', slug: 'voe-hall' }); assert.equal(p.is_official_source, false);
  });
  test('business: name, "Posted by", logo, link to the business page', () => {
    const p = noticePublisher({ publisher_kind: 'business', publisher_business_id: 'biz-1', business: BIZ });
    assert.deepEqual([p.kind, p.label, p.byline, p.logo_url, p.mark], ['business', 'Bea Bakery', 'Posted by Bea Bakery', 'https://img/biz.png', 'business']);
    assert.deepEqual(p.destination, { type: 'business', id: 'biz-1', slug: 'bea-bakery' });
  });
  test('person with a display name: name, "Posted by", generic member mark, NO link', () => {
    const p = noticePublisher({ publisher_kind: 'person', publisher_user_id: 'u1', person_name: 'Ann' });
    assert.deepEqual([p.kind, p.label, p.byline, p.mark, p.destination, p.logo_url], ['person', 'Ann', 'Posted by Ann', 'person', null, null]);
  });
  test('person without a display name: "A OneShetland member" - the only generic member label', () => {
    for (const name of [undefined, null, '', '   ']) assert.equal(noticePublisher({ publisher_kind: 'person', publisher_user_id: 'u1', person_name: name }).label, 'A OneShetland member');
  });
  test('former member: publisher_user_id NULL (account gone) -> "Former member", no link', () => {
    const p = noticePublisher({ publisher_kind: 'person', publisher_user_id: null, person_name: 'Ann' });
    assert.deepEqual([p.label, p.byline, p.mark, p.destination], ['Former member', 'Posted by Former member', 'person', null]);
  });
  test('native OneShetland platform notice: "OneShetland" / "Posted by OneShetland", platform mark, no link', () => {
    const p = noticePublisher({ publisher_kind: 'platform', is_platform_notice: true, source: null });
    assert.deepEqual([p.kind, p.label, p.byline, p.mark, p.destination, p.is_official_source], ['platform', 'OneShetland', 'Posted by OneShetland', 'platform', null, false]);
  });
  test('official import: the database source_label, "Source: …", a valid source link; OneShetland is never the author', () => {
    const p = noticePublisher({ publisher_kind: 'platform', is_platform_notice: true, source: 'nhs_shetland', source_label: 'NHS Shetland', source_url: 'https://www.nhsshetland.scot.nhs.uk/x' });
    assert.deepEqual([p.label, p.byline, p.is_official_source, p.source_label, p.mark, p.destination], ['NHS Shetland', 'Source: NHS Shetland', true, 'NHS Shetland', 'official-source', null]);
    assert.equal(p.source_url, 'https://www.nhsshetland.scot.nhs.uk/x');
    assert.doesNotMatch(JSON.stringify(p), /Posted by OneShetland/); assert.notEqual(p.label, 'OneShetland');
    assert.equal(noticePublisher({ publisher_kind: 'platform', source: 'sic', source_label: 'Shetland Islands Council' }).byline, 'Source: Shetland Islands Council');
  });
  test('source link: only a valid http(s) URL is ever offered', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', 'not a url', '', null, undefined, '//x']) assert.equal(safeSourceUrl(bad as string), null, String(bad));
    assert.equal(safeSourceUrl('http://example.org/a'), 'http://example.org/a');
    assert.equal(noticePublisher({ publisher_kind: 'platform', source: 's', source_label: 'L', source_url: 'javascript:alert(1)' }).source_url, null);
  });
  test('an import without a label is still never attributed to OneShetland', () => {
    const p = noticePublisher({ publisher_kind: 'platform', source: 'x' }); assert.equal(p.label, 'Official source'); assert.notEqual(p.label, 'OneShetland'); assert.equal(p.is_official_source, true);
  });
});

describe('publisher helper - authority and incomplete data', () => {
  test('the DATABASE kind decides, not whichever join returned a row (a hub notice with a stray business embed is still a hub notice)', () => {
    const p = noticePublisher({ publisher_kind: 'hub', publisher_hub_id: 'hub-1', hub: HUB, business: BIZ });
    assert.equal(p.kind, 'hub'); assert.equal(p.label, 'Voe Hall'); assert.equal(p.destination?.type, 'hub');
    const q = noticePublisher({ publisher_kind: 'business', publisher_business_id: 'biz-1', hub: HUB, business: BIZ });
    assert.equal(q.kind, 'business'); assert.equal(q.label, 'Bea Bakery'); assert.equal(q.logo_url, 'https://img/biz.png');
    const o = noticePublisher({ publisher_kind: 'platform', source: 'nhs', source_label: 'NHS Shetland', hub: HUB, business: BIZ }); assert.equal(o.label, 'NHS Shetland'); assert.equal(o.logo_url, null);
  });
  test('without the kind column the flags it is generated from give the same answer', () => {
    assert.equal(resolveKind({ is_platform_notice: true }), 'platform'); assert.equal(resolveKind({ is_person_notice: true }), 'person');
    assert.equal(resolveKind({ publisher_hub_id: 'h' }), 'hub'); assert.equal(resolveKind({ publisher_business_id: 'b' }), 'business');
    assert.equal(resolveKind({ publisher_kind: 'bogus', publisher_hub_id: 'h' }), 'hub', 'an unknown kind value is ignored');
  });
  test('missing joined publisher data: accurate last-resort labels, the link still uses the publisher id from the row, never "Member"', () => {
    const h = noticePublisher({ publisher_kind: 'hub', publisher_hub_id: 'hub-9', hub: null });
    assert.deepEqual([h.label, h.byline, h.destination], ['Community hub', 'Posted by Community hub', { type: 'hub', id: 'hub-9', slug: null }]);
    const b = noticePublisher({ publisher_kind: 'business', publisher_business_id: 'biz-9', business: null });
    assert.deepEqual([b.label, b.destination], ['Local business', { type: 'business', id: 'biz-9', slug: null }]);
    assert.equal(noticePublisher({ publisher_kind: 'hub' }).destination, null, 'no id, no link');
    assert.equal(noticePublisher({ publisher_kind: 'hub', hub: { id: 'h', name: '   ' } }).label, 'Community hub', 'blank name');
  });
  test('event-generated and fundraiser-generated notices stay attributed to their originating hub (the campaign / event do not change the publisher)', () => {
    for (const extra of [{ event_id: 'e1' }, { campaign_id: 'c1' }, { event_id: 'e1', campaign_id: 'c1' }]) {
      const p = noticePublisher({ publisher_kind: 'hub', publisher_hub_id: 'hub-1', hub: HUB, ...extra } as never);
      assert.deepEqual([p.kind, p.label, p.destination?.id], ['hub', 'Voe Hall', 'hub-1']);
    }
  });
  test('a person name is ignored for every other kind (it cannot overwrite a hub, business, platform or import label)', () => {
    assert.equal(noticePublisher({ publisher_kind: 'hub', hub: HUB, person_name: 'Mallory' }).label, 'Voe Hall');
    assert.equal(noticePublisher({ publisher_kind: 'business', business: BIZ, person_name: 'Mallory' }).label, 'Bea Bakery');
    assert.equal(noticePublisher({ publisher_kind: 'platform', person_name: 'Mallory' }).label, 'OneShetland');
    assert.equal(noticePublisher({ publisher_kind: 'platform', source: 's', source_label: 'NHS Shetland', person_name: 'Mallory' }).label, 'NHS Shetland');
  });
  test('no combination of inputs can ever produce the literal label "Member" or an author-less guess', () => {
    const kinds = [undefined, 'hub', 'business', 'person', 'platform', 'bogus'];
    const bools = [undefined, null, true, false];
    const labels = new Set<string>();
    for (const publisher_kind of kinds) for (const is_platform_notice of bools) for (const is_person_notice of bools) for (const hid of [undefined, null, 'h']) for (const uid of [undefined, null, 'u'])
      for (const person_name of [undefined, null, '', 'Ann']) for (const source of [undefined, null, 'nhs']) for (const hub of [null, HUB]) {
        const p = noticePublisher({ publisher_kind, is_platform_notice, is_person_notice, publisher_hub_id: hid as never, publisher_user_id: uid as never, person_name, source, hub } as never);
        labels.add(p.label); assert.ok(p.label.trim().length > 0); assert.ok(p.byline.length > 0);
        assert.doesNotMatch(p.label, /^Member$/i);
      }
    assert.ok(!labels.has('Member'));
  });
  test('the helper never touches private data: it has no imports and no reference to profiles', () => {
    const src = rd('lib/notice-publisher.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); assert.doesNotMatch(src, /^import /m); assert.doesNotMatch(src, /profiles|display_name|full_name/, 'code (comments aside) never mentions private profile fields');
  });
  test('the shared helper files are byte-pinned: the website repo holds identical copies and pins the same hashes', async () => {
    const { createHash } = await import('node:crypto'); const sha = (f: string) => createHash('sha256').update(rd(f)).digest('hex');
    assert.equal(sha('lib/notice-publisher.ts'), '21ce1afc4438948ce6e529b161180871ccee74f51e12afe5a5d9904b3376120c');
    assert.equal(sha('lib/notice-feed.ts'), '40859ef8e8a0d0b326652efa189cb3364e11f28e4c00cda4d31d3e9b4d9388f7');
  });
  test('the edge copy is byte-identical (no competing attribution system)', () => { assert.equal(rd('supabase/functions/_shared/notice-publisher.ts'), rd('lib/notice-publisher.ts')); });
});

// ── a fake Supabase client: records every query; an RPC that behaves like the database ──────────────
type Row = Record<string, any>;
function fakeSupabase(tables: Record<string, Row[]>, approvedNames: Record<string, string>) {
  const queries: Array<{ table: string; calls: any[][] }> = []; const rpcCalls: Array<{ fn: string; args: any }> = []; let failRpc = false;
  const from = (table: string) => {
    const calls: any[][] = []; queries.push({ table, calls });
    const q: any = new Proxy({}, { get: (_t, prop: string) => prop === 'then'
      ? (ok: any, bad: any) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, bad)
      : (...args: any[]) => { calls.push([prop, ...args]); return q; } });
    return q;
  };
  return {
    queries, rpcCalls, setFailRpc: (v: boolean) => { failRpc = v; },
    client: {
      from,
      rpc: async (fn: string, args: any) => {
        rpcCalls.push({ fn, args }); if (failRpc) return { data: null, error: { message: 'boom' } };
        // like notice_publisher_display: the name is released only for an approved (public) notice
        const name = approvedNames[args.p_notice];
        return { data: { label: name ?? 'A OneShetland member' }, error: null };
      },
    },
  };
}
const chainOf = (q: { calls: any[][] }) => q.calls.map((c) => c.join(' '));

const ROWS: Row[] = [
  { id: 'n-hub', publisher_kind: 'hub', publisher_hub_id: 'hub-1', publisher_user_id: null, severity: 'community', title: 'Hall closed', body: 'b', locality: null, published_at: '2026-10-04T11:20:42Z', hub: HUB, business: null, campaign_id: null, event_id: null },
  { id: 'n-biz', publisher_kind: 'business', publisher_business_id: 'biz-1', severity: 'community', title: 'Sale', body: 'b', published_at: '2026-10-03T00:00:00Z', hub: null, business: BIZ },
  { id: 'n-person', publisher_kind: 'person', is_person_notice: true, publisher_user_id: 'u-ann', severity: 'community', title: 'Lost cat', body: 'b', published_at: '2026-10-02T00:00:00Z' },
  { id: 'n-person-noname', publisher_kind: 'person', is_person_notice: true, publisher_user_id: 'u-x', severity: 'community', title: 'Found keys', body: 'b', published_at: '2026-10-02T00:00:00Z' },
  { id: 'n-former', publisher_kind: 'person', is_person_notice: true, publisher_user_id: null, severity: 'community', title: 'Old', body: 'b', published_at: '2026-10-01T00:00:00Z' },
  { id: 'n-plat', publisher_kind: 'platform', is_platform_notice: true, source: null, severity: 'info', title: 'Welcome', body: 'b', published_at: '2026-09-30T00:00:00Z' },
  { id: 'n-nhs', publisher_kind: 'platform', is_platform_notice: true, source: 'nhs_shetland', source_label: 'NHS Shetland', source_url: 'https://nhs.example/a', severity: 'urgent', title: 'Prescriptions', body: 'b', published_at: '2026-09-29T00:00:00Z' },
  { id: 'n-event', publisher_kind: 'hub', publisher_hub_id: 'hub-1', severity: 'community', title: 'New event', body: 'b', published_at: '2026-09-28T00:00:00Z', hub: HUB, event_id: 'ev1', event: { id: 'ev1', title: 'Hub night', calendar_approved: true } },
  { id: 'n-fund', publisher_kind: 'hub', publisher_hub_id: 'hub-1', severity: 'community', title: 'Fundraiser', body: 'b', published_at: '2026-09-27T00:00:00Z', hub: HUB, campaign_id: 'camp1', campaign: { id: 'camp1', raised_pence: 1, goal_pence: 2, donor_count: 1, status: 'active' } },
];
const APPROVED = { 'n-person': 'Ann' };
const noopStubs = (client: unknown) => ({ './supabase': { supabase: client }, './seed-content': { todaysSpik: () => ({}) }, './notice-publisher': pub, './notice-feed': feed, './stripe-sca': { settleSavedCardPayment: async () => ({}) } });

describe('person names come only from the authorised RPC (privacy)', () => {
  test('loadPersonNames asks only for person notices that still have an author, never for hub / business / platform / former-member rows', async () => {
    const f = fakeSupabase({}, APPROVED);
    const names = await feed.loadPersonNames((fn, args) => f.client.rpc(fn, args), ROWS as never);
    assert.deepEqual(f.rpcCalls.map((c) => c.args.p_notice).sort(), ['n-person', 'n-person-noname']);
    assert.ok(f.rpcCalls.every((c) => c.fn === 'notice_publisher_display'));
    assert.deepEqual(names, { 'n-person': 'Ann', 'n-person-noname': 'A OneShetland member' });
  });
  test('an unapproved / non-public person notice yields no name (the RPC answers generically); a failing RPC leaves the approved fallback', async () => {
    const f = fakeSupabase({}, {});   // nothing approved
    const rows = [{ id: 'n-pending', publisher_kind: 'person', publisher_user_id: 'u-ann' }];
    const names = await feed.loadPersonNames((fn, args) => f.client.rpc(fn, args), rows);
    assert.equal(feed.attributionFor({ ...rows[0], publisher_kind: 'person' } as never, names).label, 'A OneShetland member', 'the real name is never in the answer');
    f.setFailRpc(true);
    const none = await feed.loadPersonNames((fn, args) => f.client.rpc(fn, args), rows); assert.deepEqual(none, {});
    assert.equal(feed.attributionFor(rows[0] as never, none).label, 'A OneShetland member');
    assert.deepEqual(await feed.loadPersonNames(async () => { throw new Error('network'); }, rows), {}, 'a thrown error is contained');
  });
  test('the readers never query profiles', () => {
    for (const f of ['lib/concierge-api.ts', 'lib/hubs-api.ts', 'lib/notice-feed.ts']) {
      const src = rd(f);
      if (f === 'lib/notice-feed.ts') assert.doesNotMatch(src, /from\(['"]profiles['"]\)|display_name|full_name/);
    }
    const api = loadModule('lib/concierge-api.ts', noopStubs(fakeSupabase({}, {}).client)); assert.ok(api.fetchHomeNotices);
  });
  test('the cap bounds how many RPC calls one page can make', async () => {
    const f = fakeSupabase({}, {}); const many = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, publisher_kind: 'person', publisher_user_id: 'u' }));
    await feed.loadPersonNames((fn, args) => f.client.rpc(fn, args), many as never); assert.equal(f.rpcCalls.length, 30);
  });
});

describe('publication filters on every public reader (client-side line; RLS stays the boundary)', () => {
  test('publicNoticeWindow: UTC instants, published only, started or unscheduled, not expired', () => {
    const w = feed.publicNoticeWindow('2026-11-01T12:00:00+01:00');
    assert.equal(w.nowIso, '2026-11-01T11:00:00.000Z'); assert.equal(w.status, 'published');
    assert.equal(w.startsOr, 'starts_at.is.null,starts_at.lte.2026-11-01T11:00:00.000Z'); assert.equal(w.expiresOr, 'expires_at.is.null,expires_at.gt.2026-11-01T11:00:00.000Z');
  });
  const needs = (chain: string[]) => {
    assert.ok(chain.includes('eq status published'), `status filter in: ${chain.join(' | ')}`);
    assert.ok(chain.some((c) => /^or starts_at\.is\.null,starts_at\.lte\.\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c)), 'start-time filter');
    assert.ok(chain.some((c) => /^or expires_at\.is\.null,expires_at\.gt\.\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c)), 'expiry filter');
  };
  test('app home + Notices screen (fetchHomeNotices): published, started, unexpired + the existing public / not-hidden rules', async () => {
    const f = fakeSupabase({ notices: ROWS }, APPROVED); const api = loadModule('lib/concierge-api.ts', noopStubs(f.client));
    await api.fetchHomeNotices({ limit: 50 });
    const q = f.queries.find((x) => x.table === 'notices')!; const c = chainOf(q);
    needs(c); assert.ok(c.includes('eq is_hidden false')); assert.ok(c.includes('eq visibility public'));
  });
  test('app local feed (fetchPublicNotices): same filters, public only', async () => {
    const f = fakeSupabase({ notices: ROWS }, APPROVED); const api = loadModule('lib/hubs-api.ts', noopStubs(f.client));
    await api.fetchPublicNotices(6);
    const c = chainOf(f.queries.find((x) => x.table === 'notices')!); needs(c); assert.ok(c.includes('eq visibility public')); assert.ok(c.includes('eq is_hidden false'));
  });
  test('app hub screens (fetchHubNotices): same filters, scoped to the hub, visibility left to RLS (members see members-only notices)', async () => {
    const f = fakeSupabase({ notices: ROWS }, APPROVED); const api = loadModule('lib/hubs-api.ts', noopStubs(f.client));
    await api.fetchHubNotices('hub-1');
    const c = chainOf(f.queries.find((x) => x.table === 'notices')!); needs(c); assert.ok(c.includes('eq publisher_hub_id hub-1')); assert.ok(!c.some((x) => x.startsWith('eq visibility')), 'no visibility filter: members-only notices still reach members');
  });
  test('management reads are separate: no public reader calls manage_notices, and none of the manage functions is used for a feed', () => {
    for (const f of ['lib/concierge-api.ts', 'lib/hubs-api.ts']) assert.doesNotMatch(rd(f), /manage_notices|manage_set_notice_status|manage_delete_notice/);
  });
});

describe('the readers map every publisher kind (app home feed, local feed)', () => {
  test('fetchHomeNotices: hub / business / person (named, unnamed, former) / platform / official / event / fundraiser', async () => {
    const f = fakeSupabase({ notices: ROWS }, APPROVED); const api = loadModule('lib/concierge-api.ts', noopStubs(f.client));
    const out = await api.fetchHomeNotices({ limit: 50 }); const by = Object.fromEntries(out.map((n: any) => [n.id, n]));
    assert.deepEqual([by['n-hub'].publisher, by['n-hub'].attribution.byline, by['n-hub'].logo_url, by['n-hub'].brand_color, by['n-hub'].hub_id, by['n-hub'].business_id], ['Voe Hall', 'Posted by Voe Hall', 'https://img/hub.png', '#336699', 'hub-1', null]);
    assert.deepEqual([by['n-biz'].publisher, by['n-biz'].attribution.byline, by['n-biz'].logo_url, by['n-biz'].hub_id, by['n-biz'].business_id], ['Bea Bakery', 'Posted by Bea Bakery', 'https://img/biz.png', null, 'biz-1']);
    assert.deepEqual([by['n-person'].publisher, by['n-person'].attribution.byline, by['n-person'].hub_id, by['n-person'].business_id], ['Ann', 'Posted by Ann', null, null]);
    assert.equal(by['n-person-noname'].publisher, 'A OneShetland member'); assert.equal(by['n-former'].publisher, 'Former member');
    assert.deepEqual([by['n-plat'].publisher, by['n-plat'].attribution.byline], ['OneShetland', 'Posted by OneShetland']);
    assert.deepEqual([by['n-nhs'].publisher, by['n-nhs'].attribution.byline, by['n-nhs'].attribution.source_url, by['n-nhs'].attribution.is_official_source], ['NHS Shetland', 'Source: NHS Shetland', 'https://nhs.example/a', true]);
    assert.deepEqual([by['n-event'].publisher, by['n-event'].hub_id, by['n-event'].event_id], ['Voe Hall', 'hub-1', 'ev1']);
    assert.deepEqual([by['n-fund'].publisher, by['n-fund'].hub_id, by['n-fund'].campaign_id, by['n-fund'].campaign.status], ['Voe Hall', 'hub-1', 'camp1', 'active']);
    assert.ok(!out.some((n: any) => n.publisher === 'Member'), 'no notice is labelled Member');
  });
  test('fetchPublicNotices: attribution attached to every row, the same answers', async () => {
    const f = fakeSupabase({ notices: ROWS }, APPROVED); const api = loadModule('lib/hubs-api.ts', noopStubs(f.client));
    const out = await api.fetchPublicNotices(20); const by = Object.fromEntries(out.map((n: any) => [n.id, n.attribution]));
    assert.deepEqual([by['n-hub'].label, by['n-biz'].label, by['n-person'].label, by['n-former'].label, by['n-plat'].label, by['n-nhs'].label], ['Voe Hall', 'Bea Bakery', 'Ann', 'Former member', 'OneShetland', 'NHS Shetland']);
    assert.equal(by['n-biz'].destination.type, 'business'); assert.equal(by['n-person'].destination, null); assert.equal(by['n-nhs'].destination, null);
    assert.ok(out.every((n: any) => n.attribution));
  });
  test('the production launch notice (hub "OneShetland", no campaign / event) is unchanged', async () => {
    const launch = [{ id: 'b1f87708', publisher_kind: 'hub', publisher_hub_id: '60b6614d', publisher_user_id: null, severity: 'info', title: 'OneShetland is getting ready to launch', body: 'We’re putting the final touches…', locality: null, published_at: '2026-10-04T11:20:42.106371+00:00', hub: { id: '60b6614d', name: 'OneShetland', logo_url: null, brand_color: null }, business: null, campaign_id: null, event_id: null }];
    const f = fakeSupabase({ notices: launch }, {}); const api = loadModule('lib/concierge-api.ts', noopStubs(f.client));
    const [n] = await api.fetchHomeNotices({ limit: 3 });
    assert.deepEqual([n.title, n.publisher, n.attribution.byline, n.severity, n.posted_at, n.hub_id, n.logo_url], ['OneShetland is getting ready to launch', 'OneShetland', 'Posted by OneShetland', 'info', '2026-10-04T11:20:42.106371+00:00', '60b6614d', null]);
  });
});

describe('business notice compatibility (createBusinessNotice has no caller today; its notices must render correctly when one exists)', () => {
  test('identity, branding, byline and navigation for a business notice through both app readers', async () => {
    const f = fakeSupabase({ notices: [ROWS[1]] }, {});
    const home = await loadModule('lib/concierge-api.ts', noopStubs(f.client)).fetchHomeNotices({ limit: 3 });
    const local = await loadModule('lib/hubs-api.ts', noopStubs(f.client)).fetchPublicNotices(6);
    for (const a of [home[0].attribution, local[0].attribution]) {
      assert.deepEqual([a.kind, a.label, a.byline, a.logo_url, a.mark], ['business', 'Bea Bakery', 'Posted by Bea Bakery', 'https://img/biz.png', 'business']);
      assert.deepEqual(a.destination, { type: 'business', id: 'biz-1', slug: 'bea-bakery' });
    }
    assert.equal(home[0].business_id, 'biz-1');
  });
});

describe('screens use the shared attribution (contract)', () => {
  const notices = rd('app/notices.tsx'), feedScreen = rd('app/local-combined-feed.tsx'), home = rd('components/home-local/HomeScreen.tsx'), api = rd('lib/concierge-api.ts'), hubs = rd('lib/hubs-api.ts');
  test('no notice reader or screen falls back to the literal "Member"', () => {
    for (const [name, src] of [['concierge-api', api], ['notices.tsx', notices], ['local-combined-feed', feedScreen], ['HomeScreen', home]] as const) assert.doesNotMatch(src, /:\s*'Member'\)|\?\?\s*'Member'|'Member'\)/, name);
    assert.doesNotMatch(api, /'Community hub' : r\.publisher_business_id/);
  });
  test('the Notices screen shows the byline, links a business, and offers "View at source" only from the attribution', () => {
    assert.match(notices, /n\.attribution\.byline/); assert.match(notices, /n\.business_id/); assert.match(notices, /View at source/); assert.match(notices, /n\.attribution\.source_url/);
    assert.match(notices, /router\.push\('\/\(tabs\)\/whats-on'\)/, 'the existing fallback destination is preserved');
  });
  test('NoticeCard renders attribution for every kind and only links an existing hub / business page', () => {
    assert.match(feedScreen, /notice\.attribution/); assert.match(feedScreen, /disabled=\{!hasDestination\}/); assert.match(feedScreen, /a\.byline/);
    assert.match(feedScreen, /d\?\.type === 'business'/); assert.doesNotMatch(feedScreen, /disabled=\{!hub\}/);
  });
  test('Home screen header shows the label, or "Source: …" for an official import', () => { assert.match(home, /is_official_source \? n\.attribution\.byline : n\.attribution\.label/); });
  test('every public reader applies the shared filters; the old expiry-only filter is gone from them', () => {
    assert.equal((api.match(/applyPublicNoticeFilters\(/g) ?? []).length, 1); assert.equal((hubs.match(/applyPublicNoticeFilters\(/g) ?? []).length, 2);
    assert.doesNotMatch(api + hubs, /expires_at\.is\.null,expires_at\.gt\.\$\{now\}/);
  });
  test('publishing, deletion and event / fundraiser notice creation are untouched', () => {
    for (const fn of ['createHubNotice', 'createBusinessNotice', 'deleteNotice']) assert.match(hubs, new RegExp(`export async function ${fn}`));
    assert.match(hubs, /publisher_hub_id: hubId,\n      severity: 'community',/); assert.match(hubs, /\.delete\(\)\.eq\('id', noticeId\)/);
    assert.match(rd('app/event-create.tsx'), /createHubNotice\(hubId, \{/); assert.match(rd('app/hub-campaigns.tsx'), /createHubNotice\(id, \{/);
  });
  test('account-deletion function and broadcast client are untouched by this stage', () => {
    assert.match(rd('supabase/functions/delete-account/index.ts'), /svc\.from\('notices'\)\.delete\(\)\.eq\('publisher_user_id', uid\)/);
    assert.match(rd('lib/notices-broadcast.ts'), /notify-community-notice/);
  });
});

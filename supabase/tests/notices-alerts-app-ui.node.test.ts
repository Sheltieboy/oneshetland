/**
 * notices-alerts-app-ui.node.test.ts — the app half of Notices & Alerts (LOCAL; pure unit tests, no network, no database).
 *
 * The REAL source (lib/notices-alerts.ts, lib/funeral-notices.ts, lib/notice-prefs.ts, lib/notices-alerts-api.ts) runs under node with a fake
 * Supabase client that records every RPC. Screens contain JSX and cannot be executed here, so their composition rules are pinned two ways:
 * the pure functions they call are run for real, and the screen source is checked for the wiring (clearly marked "source").
 * Nothing here can reach a real service: the fake client is the only client.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, readRepo } from './_support/load-source.ts';

// ── fake Supabase ────────────────────────────────────────────────────────────
type Call = { fn: string; args: any };
function fakeSupabase(responses: Record<string, any> = {}) {
  const calls: Call[] = [];
  const tables: Call[] = [];
  const client = {
    rpc: async (fn: string, args: any = {}) => {
      calls.push({ fn, args });
      const r = responses[fn];
      if (r instanceof Error) return { data: null, error: r };
      return { data: typeof r === 'function' ? r(args) : (r ?? null), error: null };
    },
    from: (table: string) => {
      const q: any = {
        select() { return q; }, eq() { return q; }, order() { return q; },
        then(res: any, rej: any) { tables.push({ fn: table, args: null }); const r = responses[`table:${table}`]; return Promise.resolve(r instanceof Error ? { data: null, error: { message: r.message } } : { data: r ?? [], error: null }).then(res, rej); },
      };
      return q;
    },
  };
  return { client, calls, tables };
}

const na = loadModule('lib/notices-alerts.ts') as any;
const fn = loadModule('lib/funeral-notices.ts', { './notices-alerts': na }) as any;
const load = (responses: Record<string, any> = {}) => {
  const f = fakeSupabase(responses);
  const prefs = loadModule('lib/notice-prefs.ts', { './supabase': { supabase: f.client } }) as any;
  const api = loadModule('lib/notices-alerts-api.ts', { './supabase': { supabase: f.client }, './notices-alerts': na, './funeral-notices': fn }) as any;
  return { ...f, prefs, api };
};

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over: Record<string, any> = {}) => ({
  id: U(1), title: 'Bins moved', body: 'Collections shift by a day.', action_text: null, severity: 'info', category: 'public_services',
  category_label: 'Council & public services', published_at: '2026-10-30T09:00:00Z', starts_at: null, expires_at: null, review_at: null,
  link_url: null, level: 'official', is_essential_active: false,
  publisher: { kind: 'official', label: 'Shetland Islands Council', byline: 'Issued by Shetland Islands Council', is_official_source: true, source_label: null, source_url: null },
  area_ids: ['lerwick'], area_names: ['Lerwick'], publisher_hub_id: null, publisher_business_id: null, event_id: null, campaign_id: null,
  image_url: null, publisher_logo_url: null, publisher_brand_color: null, hub_slug: null, business_slug: null, ...over,
});

// ── attribution adapter: all five kinds ──────────────────────────────────────
describe('RPC publisher -> attribution (all five kinds)', () => {
  test('hub: "Posted by", logo and colour from the row, hub mark', () => {
    const a = na.adaptPublisher({ kind: 'hub', label: 'Voe Hall', byline: 'Posted by Voe Hall' }, { publisher_hub_id: U(9), publisher_logo_url: 'https://img/h.png', publisher_brand_color: '336699' });
    assert.deepEqual([a.kind, a.label, a.byline, a.mark, a.logo_url, a.brand_color, a.is_official_source], ['hub', 'Voe Hall', 'Posted by Voe Hall', 'hub', 'https://img/h.png', '#336699', false]);
  });
  test('business: "Posted by", logo, business mark', () => {
    const a = na.adaptPublisher({ kind: 'business', label: 'Bea Bakery', byline: 'Posted by Bea Bakery' }, { publisher_business_id: U(8), publisher_logo_url: 'https://img/b.png' });
    assert.deepEqual([a.kind, a.byline, a.mark, a.logo_url], ['business', 'Posted by Bea Bakery', 'business', 'https://img/b.png']);
  });
  test('person: the database label, member mark, no logo or colour even if the row carried one', () => {
    const a = na.adaptPublisher({ kind: 'person', label: 'A OneShetland member', byline: 'Posted by A OneShetland member' }, { publisher_logo_url: 'https://x/y.png', publisher_brand_color: '#112233' });
    assert.deepEqual([a.kind, a.label, a.mark, a.logo_url, a.brand_color], ['person', 'A OneShetland member', 'person', null, null]);
  });
  test('platform (OneShetland): "Posted by OneShetland", platform mark, not an official source', () => {
    const a = na.adaptPublisher({ kind: 'platform', label: 'OneShetland', byline: 'Posted by OneShetland', is_official_source: false });
    assert.deepEqual([a.kind, a.label, a.byline, a.mark, a.is_official_source], ['platform', 'OneShetland', 'Posted by OneShetland', 'platform', false]);
  });
  test('official organisation: "Issued by …"; an import: "Source: …" with the official-source mark', () => {
    const o = na.adaptPublisher({ kind: 'official', label: 'NHS Shetland', byline: 'Issued by NHS Shetland', is_official_source: true });
    assert.deepEqual([o.kind, o.byline, o.mark, o.is_official_source], ['official', 'Issued by NHS Shetland', 'official', true]);
    const i = na.adaptPublisher({ kind: 'platform', label: 'NHS Shetland', byline: 'Source: NHS Shetland', is_official_source: true, source_label: 'NHS Shetland', source_url: 'https://www.nhsshetland.scot.nhs.uk/x' });
    assert.deepEqual([i.kind, i.byline, i.mark, i.source_url], ['platform', 'Source: NHS Shetland', 'official-source', 'https://www.nhsshetland.scot.nhs.uk/x']);
  });
  test('the label is never the bare word "Member"; malformed rows get an accurate fallback, never an invented person or organisation', () => {
    assert.equal(na.adaptPublisher({ kind: 'person', label: 'Member' }).label, 'A OneShetland member');
    assert.equal(na.adaptPublisher({ kind: 'person', label: ' member ' }).byline, 'Posted by A OneShetland member');
    assert.equal(na.adaptPublisher(null, { publisher_hub_id: U(1) }).label, 'Community hub');
    assert.equal(na.adaptPublisher(undefined, { publisher_business_id: U(2) }).label, 'Local business');
    assert.equal(na.adaptPublisher({}).byline, 'Posted by OneShetland');
    assert.equal(na.adaptPublisher({ kind: 'official' }).byline, 'Issued by Official organisation');
    assert.equal(na.adaptPublisher({ kind: 'bogus', label: 'X' }).kind, 'platform');
  });
  test('a source link is only ever a valid https URL', () => {
    for (const bad of ['http://x.org/a', 'javascript:alert(1)', 'ftp://x', 'not a url', '', '   ', null, undefined, 'data:text/html,hi']) assert.equal(na.adaptPublisher({ kind: 'platform', is_official_source: true, source_url: bad }).source_url, null, String(bad));
    assert.equal(na.adaptPublisher({ kind: 'platform', is_official_source: true, source_url: 'https://a.example/b?c=1' }).source_url, 'https://a.example/b?c=1');
    assert.equal(na.mapNoticeRow(row({ link_url: 'http://insecure.example' })).linkUrl, null);
    assert.equal(na.mapNoticeRow(row({ link_url: 'https://ok.example' })).linkUrl, 'https://ok.example/');
  });
});

describe('row -> notice model', () => {
  test('maps the contract fields; level and the active-essential flag come from the server', () => {
    const m = na.mapNoticeRow(row({ id: U(5), level: 'essential', is_essential_active: true, action_text: 'Avoid the road.', area_ids: ['voe', 'brae'], area_names: ['Voe', 'Brae'], review_at: '2026-11-01T00:00:00Z' }));
    assert.deepEqual([m.id, m.level, m.isEssential, m.actionText, m.areaNames, m.categoryLabel, m.publishedAt], [U(5), 'essential', true, 'Avoid the road.', ['Voe', 'Brae'], 'Council & public services', '2026-10-30T09:00:00Z']);
    assert.equal(na.mapNoticeRow(row()).isEssential, false);
    assert.equal(na.mapNoticeRow(row({ level: 'community' })).level, 'community');
  });
  test('get_essential_alerts rows (no level column) are essential by definition', () => {
    const r = row(); delete (r as any).level; delete (r as any).is_essential_active;
    const m = na.mapEssentialRow(r);
    assert.deepEqual([m.level, m.isEssential], ['essential', true]);
  });
  test('tolerates junk: non-array, rows without an id, missing arrays', () => {
    assert.deepEqual(na.mapRows(null), []); assert.deepEqual(na.mapRows({}), []);
    assert.equal(na.mapRows([null, {}, row()]).length, 1);
    const m = na.mapNoticeRow({ id: 'x', title: '  ', area_ids: 'nope', area_names: null });
    assert.deepEqual([m.title, m.body, m.areaIds, m.areaNames, m.destination], ['Notice', '', [], [], null]);
  });
});

// ── destination: campaign > event > hub > business > none ───────────────────
describe('destination precedence', () => {
  const hubRow = { publisher: { kind: 'hub', label: 'Voe Hall' }, publisher_hub_id: U(10) };
  const bizRow = { publisher: { kind: 'business', label: 'Bea' }, publisher_business_id: U(11) };
  const d = (over: any) => na.mapNoticeRow(row(over)).destination;
  test('campaign beats event beats hub', () => {
    assert.deepEqual(d({ ...hubRow, campaign_id: U(20), event_id: U(21) }), { type: 'campaign', id: U(20), route: { pathname: '/hub-campaign', params: { id: U(20) } } });
    assert.deepEqual(d({ ...hubRow, event_id: U(21) }), { type: 'event', id: U(21), route: { pathname: '/events/[id]', params: { id: U(21) } } });
  });
  test('event beats business too (a business notice about an event opens the event)', () => {
    assert.equal(d({ ...bizRow, event_id: U(21) }).type, 'event');
  });
  test('hub, then business, then none', () => {
    assert.deepEqual(d(hubRow), { type: 'hub', id: U(10), route: { pathname: '/hubs/[id]', params: { id: U(10) } } });
    assert.deepEqual(d(bizRow), { type: 'business', id: U(11), route: { pathname: '/local-business-detail', params: { id: U(11) } } });
    assert.equal(d({}), null);
  });
  test('an event only counts when its id is a real uuid; otherwise the next destination applies', () => {
    for (const bad of ['', '  ', 'not-a-uuid', '123', null]) assert.equal(d({ ...hubRow, event_id: bad }).type, 'hub', String(bad));
    assert.equal(d({ event_id: 'not-a-uuid' }), null);
  });
  test('person, OneShetland, import and verified organisation have no page even when ids are present', () => {
    for (const publisher of [{ kind: 'person', label: 'A OneShetland member' }, { kind: 'platform', label: 'OneShetland' }, { kind: 'platform', label: 'NHS', is_official_source: true }, { kind: 'official', label: 'Council' }])
      assert.equal(d({ publisher, publisher_hub_id: U(10), publisher_business_id: U(11) }), null, publisher.kind);
  });
});

// ── area query semantics ─────────────────────────────────────────────────────
describe('area semantics: null is not []', () => {
  test('areaArgs: all = null; one area = [id]; my areas = the list, and [] (Shetland-wide only) when none', () => {
    assert.equal(na.areaArgs({ mode: 'all' }, ['voe']), null);
    assert.deepEqual(na.areaArgs({ mode: 'area', areaId: 'voe' }, []), ['voe']);
    assert.deepEqual(na.areaArgs({ mode: 'mine' }, ['voe', 'brae']), ['voe', 'brae']);
    assert.deepEqual(na.areaArgs({ mode: 'mine' }, []), []);
    assert.deepEqual(na.areaArgs({ mode: 'mine' }, null), []);
    assert.notEqual(na.areaArgs({ mode: 'mine' }, []), null);
  });
  test('areaArgs returns a copy (the caller cannot mutate saved areas)', () => {
    const mine = ['voe']; const out = na.areaArgs({ mode: 'mine' }, mine); out.push('x'); assert.deepEqual(mine, ['voe']);
  });
  test('Home: a member with areas is filtered; a visitor or a member with none sees everything (null), never []', () => {
    assert.deepEqual(na.homeAreaArgs(['voe']), ['voe']);
    for (const none of [[], null, undefined]) assert.equal(na.homeAreaArgs(none as any), null);
  });
  test('the RPC receives null, [] and a list exactly as given', async () => {
    const t = load({ get_essential_alerts: [] });
    await t.api.loadEssentialAlerts(null); await t.api.loadEssentialAlerts([]); await t.api.loadEssentialAlerts(['voe']);
    assert.deepEqual(t.calls.map((c: Call) => c.args.p_area_ids), [null, [], ['voe']]);
    assert.ok(t.calls[0].args.p_area_ids === null);
  });
  test('areaSummary: first two names then +N; empty stays empty', () => {
    assert.equal(na.areaSummary([]), ''); assert.equal(na.areaSummary(['Voe']), 'Voe'); assert.equal(na.areaSummary(['Voe', 'Brae']), 'Voe, Brae');
    assert.equal(na.areaSummary(['Voe', 'Brae', 'Delting', 'Lerwick']), 'Voe, Brae +2');
  });
});

// ── Home composition ─────────────────────────────────────────────────────────
describe('Home composition', () => {
  const mk = (i: number, over: any = {}) => na.mapNoticeRow(row({ id: U(100 + i), title: `Notice ${i}`, published_at: `2026-10-${String(10 + i).padStart(2, '0')}T09:00:00Z`, ...over }));
  test('no essential alert: the slot is hidden (collapses, no gap)', () => {
    const c = na.composeHome([], [mk(1), mk(2)]);
    assert.equal(c.showEssential, false); assert.deepEqual(c.essential, []);
  });
  test('the slot comes only from get_essential_alerts, and never also appears in the card grid', () => {
    const ess = na.mapEssentialRow(row({ id: U(1), title: 'Road closed' }));
    const stillInGrid = [mk(1, { id: U(1), level: 'essential', is_essential_active: true }), mk(2, { id: U(1) }), mk(3, { id: U(300), level: 'essential', is_essential_active: true }), mk(4)];
    const c = na.composeHome([ess], stillInGrid);
    assert.equal(c.showEssential, true);
    assert.deepEqual(c.cards.map((n: any) => n.id), [U(104)], 'by id, by flag and by level');
    assert.ok(c.cards.every((n: any) => !n.isEssential && n.level !== 'essential'));
  });
  test('at most six cards, newest first (pinned order from the server is not kept)', () => {
    const notices = [mk(1), mk(9), mk(3), mk(8), mk(2), mk(7), mk(4), mk(6), mk(5)];
    const c = na.composeHome([], notices);
    assert.equal(c.cards.length, 6);
    assert.deepEqual(c.cards.map((n: any) => n.title), ['Notice 9', 'Notice 8', 'Notice 7', 'Notice 6', 'Notice 5', 'Notice 4']);
    assert.equal(na.composeHome([], notices, 3).cards.length, 3);
  });
  test('equal time keeps the server order (stable)', () => {
    const t = '2026-10-20T00:00:00Z';
    const c = na.composeHome([], [mk(1, { published_at: t }), mk(2, { published_at: t }), mk(3, { published_at: t })]);
    assert.deepEqual(c.cards.map((n: any) => n.title), ['Notice 1', 'Notice 2', 'Notice 3']);
  });
  test('the database returns level as an integer (1 essential, 2 official, 3 community); the words work too', () => {
    assert.deepEqual([1, 2, 3, '1', 'essential', 'official', 'community', null, 9].map((l) => na.levelOf(l)), ['essential', 'official', 'community', 'essential', 'essential', 'official', 'community', 'community', 'community']);
    assert.equal(na.mapNoticeRow(row({ level: 1, is_essential_active: true })).level, 'essential');
    assert.equal(na.mapNoticeRow(row({ level: 2 })).level, 'official');
    assert.equal(na.mapNoticeRow(row({ level: 3 })).level, 'community');
    const c = na.composeHome([], [na.mapNoticeRow(row({ id: U(1), level: 1, is_essential_active: true })), na.mapNoticeRow(row({ id: U(2), level: 3 }))]);
    assert.deepEqual(c.cards.map((n: any) => n.id), [U(2)]);
  });
  test('several essential alerts: the member\'s areas lead, then Shetland-wide, then the rest; newest first within a group; one in full, the rest as rows', () => {
    const e = (i: number, areas: string[], at: string) => na.mapEssentialRow(row({ id: U(600 + i), title: `Alert ${i}`, area_ids: areas, area_names: areas, published_at: at }));
    const road = e(1, ['voe', 'brae'], '2026-10-30T08:00:00Z'), power = e(2, ['hillswick'], '2026-10-31T08:00:00Z'), ferry = e(3, ['yell_unst_fetlar'], '2026-10-29T08:00:00Z'), wide = e(4, ['shetland_wide'], '2026-10-01T08:00:00Z'), road2 = e(5, ['brae'], '2026-10-31T09:00:00Z');
    const ids = (a: any[]) => a.map((n) => n.title);
    assert.deepEqual(ids(na.orderEssential([road, power, ferry], ['voe'])), ['Alert 1', 'Alert 2', 'Alert 3'], 'mine first, then newest of the rest');
    assert.deepEqual(ids(na.orderEssential([ferry, power, wide, road2, road], ['voe', 'brae'])), ['Alert 5', 'Alert 1', 'Alert 4', 'Alert 2', 'Alert 3']);
    assert.deepEqual(ids(na.orderEssential([road, power, ferry], null)), ['Alert 2', 'Alert 1', 'Alert 3'], 'no areas: newest first');
    assert.deepEqual(ids(na.orderEssential([road, power, ferry], [])), ['Alert 2', 'Alert 1', 'Alert 3']);
    const input = [road, power, ferry]; na.orderEssential(input, ['voe']); assert.deepEqual(ids(input), ['Alert 1', 'Alert 2', 'Alert 3'], 'does not mutate');
    const c = na.composeHome([road, power, ferry], [], 6, ['hillswick']);
    const { lead, others } = na.splitEssential(c.essential);
    assert.deepEqual([lead.title, ids(others)], ['Alert 2', ['Alert 1', 'Alert 3']]);
    assert.deepEqual(na.splitEssential([]), { lead: null, others: [] });
  });
  test('area hierarchy: the slot ranks an alert for a PARENT or CHILD of the member\'s area above an island-wide one, exactly as the database matches them; siblings do not match', () => {
    const parents = { shetland_wide: null, shetland_north: 'shetland_wide', voe: 'shetland_north', brae: 'shetland_north', lerwick_bressay: 'shetland_wide', lerwick: 'lerwick_bressay', bressay: 'lerwick_bressay' };
    assert.deepEqual([...na.areaNeighbourhood(['voe'], parents)].sort(), ['shetland_north', 'voe'], 'self + ancestors (never the island-wide root)');
    assert.deepEqual([...na.areaNeighbourhood(['shetland_north'], parents)].sort(), ['brae', 'shetland_north', 'voe'], 'a parent reaches its children');
    assert.deepEqual([...na.areaNeighbourhood(['lerwick'], parents)].sort(), ['lerwick', 'lerwick_bressay'], 'a sibling (bressay) is not included');
    const mk = (id: string, areaIds: string[], at: string) => na.mapNoticeRow(row({ id: U(Number(id)), area_ids: areaIds, area_names: areaIds, published_at: at, level: 1, is_essential_active: true }));
    const wide = mk('1', ['shetland_wide'], '2026-10-31T10:00:00Z'), parent = mk('2', ['shetland_north'], '2026-10-31T08:00:00Z'), exact = mk('3', ['voe'], '2026-10-31T07:00:00Z'), sibling = mk('4', ['brae'], '2026-10-31T11:00:00Z');
    const order = (areas: string[], p: unknown) => na.orderEssential([wide, parent, exact, sibling], areas, p).map((n: any) => n.id);
    assert.deepEqual(order(['voe'], parents), [exact.id, parent.id, wide.id, sibling.id], 'own area, then a parent/child area, then island-wide, then the rest');
    assert.deepEqual(order(['voe'], null), [exact.id, wide.id, sibling.id, parent.id], 'without the hierarchy only an exact area counts (the previous behaviour, kept as the fallback)');
    assert.deepEqual(order(['shetland_north'], parents), [parent.id, sibling.id, exact.id, wide.id], 'a parent-area member: the parent-area alert, then its children newest first, then island-wide');
    assert.deepEqual(order([], parents), [sibling.id, wide.id, parent.id, exact.id], 'no areas: only recency counts');
    assert.equal(na.composeHome([wide, parent, exact], [], 6, ['voe'], parents).essential[0].id, exact.id);
  });
  test('(source) the strip is ONE LINE always: fixed height, every Text numberOfLines={1}, capped text scaling, no wrapping, no body/what-to-do/source', () => {
    const e = readRepo('components/notices/EssentialAlerts.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match((e.match(/strip: \{[^}]*\}/) ?? [''])[0], /height: HEIGHT/); assert.match(e, /HEIGHT = 52/);
    const texts = e.match(/<Text [^>]*>/g) ?? []; assert.equal(texts.length, 2, 'headline and count only: no visible label');
    for (const t of texts) { assert.match(t, /numberOfLines=\{1\}/, t); assert.match(t, /maxFontSizeMultiplier=\{SCALE_CAP\}/, t); }
    assert.doesNotMatch(e, /numberOfLines=\{[2-9]\}|flexWrap|minHeight|flexDirection: 'column'/, 'nothing that can wrap or grow');
    assert.doesNotMatch(e, /lead\.body|actionText|attribution/, 'no body, what-to-do or source detail on Home');
    assert.doesNotMatch(e, /ESSENTIAL ALERT|'ALERT'|s\.label/, 'no visible label text'); assert.match(e, /Essential alert, \$\{shown\.length\} active/); assert.match(e, /'Essential alert\. '/, "'Essential alert' stays in the accessible name");
  });
  test('(source) the whole strip opens (one: the alert, several: the list); the x is a SIBLING control that never navigates; names, hint, hit area', () => {
    const e = readRepo('components/notices/EssentialAlerts.tsx');
    assert.match(e, /many \? onSeeAll\(\) : onOpen\(lead\)/);
    const main = e.slice(e.indexOf('<Pressable\n          onPress={() => (many'), e.indexOf('</Pressable>'));
    assert.doesNotMatch(main, /onDismiss|Dismiss Essential Alert/, 'the dismiss control is not inside the navigating pressable');
    assert.match(e, /onPress=\{onDismiss\} accessibilityRole="button" accessibilityLabel="Dismiss Essential Alert"/); assert.match(e, /close: \{ width: 48, height: HEIGHT/);
    assert.match(e, /accessibilityHint=\{many \? 'Opens all essential alerts' : 'Opens the full alert'\}/); assert.match(e, /Essential alert, \$\{shown\.length\} active\. Latest: /);
    assert.ok((e.match(/importantForAccessibility="no-hide-descendants"/g) ?? []).length >= 2, 'icon and text are hidden from the screen reader (the label covers them)');
    assert.equal((e.match(/<Pressable/g) ?? []).length, 2, 'the strip and the x; never a stack of cards');
  });
  test('dismissal logic: ids not a global switch; the whole active set is dismissed (no promotion of the 2nd); a NEW id brings the strip back; dismissed ids never return', () => {
    const D = loadModule('lib/essential-dismiss.ts') as any;
    const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const after = D.dismissAll([], three);
    assert.deepEqual(after, ['a', 'b', 'c']); assert.deepEqual(D.undismissed(three, after), []);
    assert.deepEqual(D.undismissed([...three, { id: 'd' }], after).map((x: any) => x.id), ['d']);
    assert.deepEqual(D.undismissed([{ id: 'a' }, { id: 'e' }], D.dismissAll(after, [{ id: 'd' }])).map((x: any) => x.id), ['e']);
    assert.deepEqual(D.dismissAll(['x'], [{ id: 'x' }, { id: 'y' }]), ['x', 'y']); assert.deepEqual(D.undismissed(null, []), []);
    for (const bad of [null, undefined, '', 'nope', '{}', '[1]']) assert.deepEqual(D.parseDismissed(bad), []);
    assert.deepEqual(D.parseDismissed('["ok",""]'), ['ok']); assert.equal(D.dismissAll([], Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i }))).length, 200);
  });
  test('(source) dismissal is device storage only: AsyncStorage, no network, no notice/preference call; nothing renders until the stored list is read', () => {
    const e = readRepo('components/notices/EssentialAlerts.tsx');
    assert.match(e, /AsyncStorage\.getItem\(DISMISSED_KEY\)/); assert.match(e, /AsyncStorage\.setItem\(DISMISSED_KEY/);
    assert.doesNotMatch(e, /supabase|fetch\(|rpc\(|notice_notification_prefs|set_my_notice|manage_|official_set/, 'presentation only');
    assert.match(e, /dismissed \? undismissed\(active, dismissed\) : \[\]/); assert.match(e, /if \(shown\.length === 0\) return null;/);
  });
  test('loadHomeNotices: queries the essential list and get_public_notices("all"), applies the member areas, and a failure of either collapses just that part', async () => {
    const ok = load({ get_essential_alerts: [row({ id: U(1), level: undefined })], get_public_notices: [row({ id: U(1), level: 'essential', is_essential_active: true }), row({ id: U(2), level: 'community' })] });
    const c = await ok.api.loadHomeNotices(['voe']);
    assert.deepEqual(ok.calls.map((x: Call) => [x.fn, x.args.p_area_ids]).sort(), [['get_essential_alerts', ['voe']], ['get_public_notices', ['voe']]]);
    assert.equal(ok.calls.find((x: Call) => x.fn === 'get_public_notices')!.args.p_level, 'all');
    assert.deepEqual([c.essential.length, c.cards.map((n: any) => n.id)], [1, [U(2)]]);
    const anon = load({ get_essential_alerts: [], get_public_notices: [] }); await anon.api.loadHomeNotices(null);
    assert.ok(anon.calls.every((x: Call) => x.args.p_area_ids === null));
    const none = load({ get_essential_alerts: new Error('down'), get_public_notices: [row({ id: U(3), level: 'community' })] });
    const part = await none.api.loadHomeNotices([]);
    assert.deepEqual([part.showEssential, part.cards.length], [false, 1]);
    assert.ok(none.calls.every((x: Call) => x.args.p_area_ids === null), 'a member with no areas is not narrowed to Shetland-wide-only on Home');
    const dead = load({ get_essential_alerts: new Error('a'), get_public_notices: new Error('b') });
    assert.deepEqual((await dead.api.loadHomeNotices(null)).cards, []);
  });
  test('precedence is documented and the old claimants are gone from the top (source)', () => {
    assert.deepEqual([...na.HOME_TOP_ORDER], ['essential-alert']);
    const home = readRepo('components/home-local/HomeScreen.tsx');
    assert.doesNotMatch(home, /AlertPill/); assert.doesNotMatch(home, /urgentChip|urgentNotice/);
    assert.ok(home.indexOf('<EssentialAlerts') < home.indexOf('<PlanDayCard onPress'), 'the Essential slot is above everything else in the scroll');
    assert.ok(home.indexOf('<EssentialAlerts') < home.indexOf('forYou.length > 0'));
    assert.ok(home.indexOf('style={s.partnerStrip}') > home.indexOf('Fae da isles'), 'the partner update is low on the page');
    assert.match(home, /View all notices/); assert.match(home, /noticeHome\.cards\.map/);
  });
  test('the partner update is calm wording, never emergency wording', () => {
    assert.deepEqual(na.partnerStripText({ business_name: 'Bea Bakery', message: 'Closed Monday' }), { who: 'Update from Bea Bakery', text: 'Closed Monday' });
    assert.equal(na.partnerStripText({}).who, 'Update from a local business');
    assert.doesNotMatch(readRepo('components/home-local/HomeScreen.tsx').slice(readRepo('components/home-local/HomeScreen.tsx').indexOf('9b')), /EMERGENCY|DISRUPTION|#DC2626|#FF3B30/);
  });
  test('(source) the Essential slot renders nothing when empty; the red treatment lives only there', () => {
    const e = readRepo('components/notices/EssentialAlerts.tsx');
    assert.match(e, /if \(shown\.length === 0\) return null;/);
    assert.doesNotMatch(e, /What to do|View at source|Affects:|attribution\.byline/, 'the Home strip is a summary only');
    const cards = readRepo('components/notices/NoticeCards.tsx');
    assert.doesNotMatch(cards.slice(0, cards.indexOf('listCardEssential: {')), /#B3261E|#DC2626|#EF4444/, 'Home cards carry no urgent colour');
  });
  test('(source) the six Home cards share one height and width', () => {
    const cards = readRepo('components/notices/NoticeCards.tsx');
    assert.match(cards, /minHeight: HOME_CARD_HEIGHT/); assert.match(cards, /numberOfLines=\{3\}/);
    assert.match(readRepo('components/home-local/HomeScreen.tsx'), /width=\{noticeW\}/);
  });
  test('formatNoticeTime: relative then dated', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    assert.equal(na.formatNoticeTime('2026-10-31T11:59:40Z', now), 'Just now');
    assert.equal(na.formatNoticeTime('2026-10-31T11:15:00Z', now), '45 min ago');
    assert.equal(na.formatNoticeTime('2026-10-31T09:00:00Z', now), '3 h ago');
    assert.equal(na.formatNoticeTime('2026-10-29T12:00:00Z', now), '2 d ago');
    assert.equal(na.formatNoticeTime('2026-10-01T12:00:00Z', now), '1 Oct 2026');
    assert.equal(na.formatNoticeTime(null, now), ''); assert.equal(na.formatNoticeTime('garbage', now), '');
  });
});

// ── filters and pagination ───────────────────────────────────────────────────
describe('Notices screen: filter and pagination state', () => {
  test('tabs are the five specified, in order', () => {
    assert.deepEqual(na.NOTICE_TABS.map((t: any) => t.label), ['All', 'Essential alerts', 'Health & official', 'Community', 'Deaths & funeral']);
  });
  test('each tab asks for its level; the funeral tab asks the funeral function', () => {
    const q = (tab: string) => na.buildQuery({ ...na.INITIAL_FILTER, tab }, [], 0);
    assert.deepEqual(['all', 'essential', 'official', 'community'].map((t) => q(t).args.p_level), ['all', 'essential', 'official', 'community']);
    assert.equal(q('funeral').fn, 'get_funeral_notices'); assert.equal(q('essential').fn, 'get_public_notices');
    assert.equal('p_level' in q('funeral').args, false);
  });
  test('the area scope and category reach the query; paging sets limit and offset', () => {
    let s = na.reduceFilter(na.INITIAL_FILTER, { type: 'scope', scope: { mode: 'area', areaId: 'voe' } });
    s = na.reduceFilter(s, { type: 'category', category: 'health' });
    assert.deepEqual(na.buildQuery(s, ['x'], 40).args, { p_level: 'all', p_area_ids: ['voe'], p_category: 'health', p_limit: 20, p_offset: 40 });
    assert.deepEqual(na.buildQuery(na.INITIAL_FILTER, null, 0).args.p_area_ids, null);
    assert.deepEqual(na.buildQuery({ ...na.INITIAL_FILTER, scope: { mode: 'mine' } }, ['a', 'b'], 0).args.p_area_ids, ['a', 'b']);
    assert.deepEqual(na.buildQuery({ ...na.INITIAL_FILTER, scope: { mode: 'mine' } }, [], 0).args.p_area_ids, []);
  });
  test('the funeral tab clears the category and ignores category taps; other filters survive a tab change', () => {
    let s = na.reduceFilter(na.INITIAL_FILTER, { type: 'category', category: 'health' });
    s = na.reduceFilter(s, { type: 'scope', scope: { mode: 'mine' } });
    const f = na.reduceFilter(s, { type: 'tab', tab: 'funeral' });
    assert.deepEqual([f.tab, f.category, f.scope], ['funeral', null, { mode: 'mine' }]);
    assert.equal(na.reduceFilter(f, { type: 'category', category: 'health' }).category, null);
    assert.equal(na.reduceFilter(s, { type: 'tab', tab: 'community' }).category, 'health');
  });
  test('appendPage appends and de-duplicates across pages; trimPage turns limit+1 into hasMore (an exact multiple of 20 ends cleanly)', () => {
    const a = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
    const p1 = na.appendPage([], a, true);
    assert.deepEqual([p1.items.length, p1.hasMore], [20, true]);
    const p2 = na.appendPage(p1.items, [{ id: 'n19' }, { id: 'n20' }, { id: 'n21' }], false);
    assert.deepEqual([p2.items.length, p2.hasMore], [22, false]);
    assert.deepEqual(na.appendPage([], [], false), { items: [], hasMore: false });
    const t = (n: number) => na.trimPage(Array.from({ length: n }, (_, i) => i), 20);
    assert.deepEqual([t(20).rows.length, t(20).hasMore], [20, false], 'exactly 20 rows: no empty Show more');
    assert.deepEqual([t(21).rows.length, t(21).hasMore], [20, true]);
    assert.deepEqual([t(0).rows.length, t(0).hasMore, t(7).hasMore], [0, false, false]);
  });
  test('loadNoticePage sends the built query and maps the result; an error is thrown for the error state', async () => {
    const t = load({ get_public_notices: [row()], get_funeral_notices: [{ id: U(1), full_name: 'A B' }] });
    const n = await t.api.loadNoticePage({ ...na.INITIAL_FILTER, tab: 'official' }, [], 20);
    assert.deepEqual([t.calls[0].fn, t.calls[0].args.p_level, t.calls[0].args.p_offset, t.calls[0].args.p_limit, n.notices.length, n.funeral.length, n.hasMore], ['get_public_notices', 'official', 20, 21, 1, 0, false]);
    const full = load({ get_public_notices: Array.from({ length: 21 }, (_, i) => row({ id: U(500 + i) })) });
    const pg = await full.api.loadNoticePage(na.INITIAL_FILTER, [], 0);
    assert.deepEqual([pg.notices.length, pg.hasMore], [20, true]);
    const exact = load({ get_public_notices: Array.from({ length: 20 }, (_, i) => row({ id: U(500 + i) })) });
    assert.equal((await exact.api.loadNoticePage(na.INITIAL_FILTER, [], 0)).hasMore, false);
    const f = await t.api.loadNoticePage({ ...na.INITIAL_FILTER, tab: 'funeral' }, [], 0);
    assert.deepEqual([t.calls[1].fn, f.notices.length, f.funeral.length, t.calls[1].args.p_limit], ['get_funeral_notices', 0, 1, 21]);
    await assert.rejects(load({ get_public_notices: new Error('boom') }).api.loadNoticePage(na.INITIAL_FILTER, [], 0));
  });
  test('categories fall back to the nine canonical ones when the table cannot be read; areas come from active physical areas', async () => {
    const t = load({ 'table:notice_categories': new Error('x') });
    assert.equal((await t.api.loadCategories()).length, 9);
    const ok = load({ 'table:notice_categories': [{ id: 'health', label: 'Health' }], 'table:areas': [{ id: 'voe', name_display: 'Voe', type: 'settlement', parent_id: 'delting' }] });
    assert.deepEqual(await ok.api.loadCategories(), [{ id: 'health', label: 'Health' }]);
    assert.deepEqual(await ok.api.loadAreas(), [{ id: 'voe', name: 'Voe', type: 'settlement', parentId: 'delting' }]);
  });
  test('Filters row: summary text while a filter is active; only the type tabs are sticky (source)', () => {
    assert.equal(na.filterSummary(null, null), ''); assert.equal(na.filterSummary('Voe', null), 'Voe'); assert.equal(na.filterSummary('Voe', 'Health'), 'Voe, Health'); assert.equal(na.filterSummary(null, 'Health'), 'Health');
    const s = readRepo('app/notices.tsx');
    assert.match(s, /stickyHeaderIndices=\{\[0\]\}/);
    const sticky = s.slice(s.indexOf('<View style={styles.filters}>'), s.indexOf('styles.filterBox'));
    assert.match(sticky, /NOTICE_TABS\.map/); assert.doesNotMatch(sticky, /Choose area|Any category|categoryOptions/, 'area and category are not in the sticky block');
    assert.match(s, /accessibilityState=\{\{ expanded: filtersOpen \}\}/); assert.match(s, /minHeight: 48/); assert.match(s, /filterSummary\(/);
    assert.ok(s.indexOf('Choose area') > s.indexOf('filtersOpen ? ('), 'area chips only inside the collapsible');
  });
  test('deep link: get_public_notice(p_id) by id; not public -> null; no paging scan remains', async () => {
    const t = load({ get_public_notice: [row({ id: U(77), level: 1, is_essential_active: true })] });
    const n = await t.api.loadPublicNotice(U(77));
    assert.deepEqual([t.calls[0].fn, t.calls[0].args, n.id, n.isEssential], ['get_public_notice', { p_id: U(77) }, U(77), true]);
    assert.equal(await load({ get_public_notice: [] }).api.loadPublicNotice(U(1)), null);
    await assert.rejects(load({ get_public_notice: new Error('down') }).api.loadPublicNotice(U(1)));
    const s = readRepo('app/notices.tsx');
    assert.match(s, /loadPublicNotice\(openId\)/); assert.doesNotMatch(s, /FIND_LINKED_PAGES|extraPages/);
    assert.match(s, /no longer current/);
  });
  test('(source) the screen uses get_public_notices through the API, keeps the back handler, admin broadcast and no What\'s On fallback', () => {
    const s = readRepo('app/notices.tsx');
    assert.match(s, /loadNoticePage/); assert.match(s, /Show more/); assert.match(s, /onBack=\{\(\) => \(router\.canGoBack\(\)/);
    assert.match(s, /isAdmin && isUrgent/); assert.match(s, /Send to everyone/); assert.doesNotMatch(s, /fetchHomeNotices|whats-on/);
    assert.match(s, /Notices did not load/); assert.match(s, /No notices right now/);
  });
});

// ── funeral view-models and submission ───────────────────────────────────────
describe('Deaths & funeral', () => {
  const pub = (over: any = {}) => ({ id: U(1), full_name: 'Margaret Jane Smith', preferred_name: 'Peggy', photo_url: null, born_on: '1941-03-12', died_on: '2026-10-03', announcement: 'Peacefully at home.', service_kind: null, service_venue: null, service_at: null, service_notes: null, family_requests: 'Family flowers only.', donation_info: 'Shetland Hospice', donation_url: 'https://hospice.example/give', area_id: 'voe', area_name: 'Voe', published_at: '2026-10-05T10:00:00Z', ...over });
  test('arrangements omitted when absent (service is null, nothing about a service)', () => {
    const m = fn.mapFuneralRow(pub());
    assert.equal(m.service, null);
    assert.deepEqual([m.fullName, m.knownAs, m.dates, m.areaName, m.familyRequests, m.donationUrl], ['Margaret Jane Smith', 'Peggy', '12 March 1941 \u2013 3 October 2026', 'Voe', 'Family flowers only.', 'https://hospice.example/give']);
    assert.doesNotMatch(JSON.stringify(m), /funeral service|venue/i);
  });
  test('arrangements present: kind, when, venue, notes', () => {
    const m = fn.mapFuneralRow(pub({ service_kind: 'funeral', service_venue: 'Voe Kirk', service_at: '2026-10-09T13:00:00', service_notes: 'Tea afterwards.' }));
    assert.deepEqual([m.service.kind, m.service.venue, m.service.notes], ['Funeral service', 'Voe Kirk', 'Tea afterwards.']);
    assert.match(m.service.when, /^9 October 2026 at \d\d:\d\d$/);
  });
  test('no private field is ever carried: contact, verification and submitter data on a row do not reach the model', () => {
    const m = fn.mapFuneralRow(pub({ submitter_phone: '07700900123', submitter_email: 'x@y.example', submitter_name: 'Zed', verification_method: 'phone', review_note: 'secret', submitter_id: U(7), family_authorised: true }));
    const json = JSON.stringify(m);
    for (const leak of ['07700900123', 'x@y.example', 'Zed', 'phone', 'secret', U(7)]) assert.ok(!json.includes(leak), leak);
    assert.deepEqual(Object.keys(m).sort(), ['announcement', 'areaName', 'donationInfo', 'donationUrl', 'dates', 'familyRequests', 'fullName', 'id', 'knownAs', 'photoUrl', 'publishedAt', 'service'].sort());
    const src = readRepo('lib/funeral-notices.ts').split('export type SubmissionForm')[0];
    assert.doesNotMatch(src.slice(src.indexOf('export function mapFuneralRow')), /submitter_|verification|review_note/);
  });
  test('only https photo and donation links; only a date of death shows as "Died …"; "known as" only when different', () => {
    const m = fn.mapFuneralRow(pub({ photo_url: 'http://x/p.jpg', donation_url: 'javascript:1', born_on: null, preferred_name: 'margaret jane smith' }));
    assert.deepEqual([m.photoUrl, m.donationUrl, m.dates, m.knownAs], [null, null, 'Died 3 October 2026', null]);
    assert.equal(fn.mapFuneralRow(pub({ photo_url: 'https://x/p.jpg' })).photoUrl, 'https://x/p.jpg');
  });
  test('(source) the template: serif name, ornamental rule, oval photo, no emergency colours, no animation', () => {
    const t = readRepo('components/notices/FuneralTemplate.tsx');
    assert.match(t, /Georgia/); assert.match(t, /OrnamentalRule/); assert.match(t, /OvalPortrait/); assert.match(t, /borderRadius: size/);
    assert.doesNotMatch(t, /Animated|useNativeDriver|#DC2626|#EF4444|#B3261E|#FF3B30/);
    assert.match(t, /f\.service \? \(/, 'service details only when present');
  });

  const form = (over: any = {}) => ({ ...fn.EMPTY_SUBMISSION, fullName: 'A B', submitterName: 'C D', submitterPhone: '01595 000000', familyAuthorised: true, ...over });
  test('only the contract-required fields are required; everything else may be blank', () => {
    assert.deepEqual(fn.validateSubmission(form()), []);
    assert.equal(fn.validateSubmission(fn.EMPTY_SUBMISSION).length, 4);
    assert.match(fn.validateSubmission(form({ submitterPhone: '' })).join(), /phone number or an email/);
    assert.deepEqual(fn.validateSubmission(form({ submitterPhone: '', submitterEmail: 'a@b.example' })), []);
    assert.match(fn.validateSubmission(form({ familyAuthorised: false })).join(), /authorised/);
  });
  test('dates and links are checked; a future death date and links in the announcement are refused', () => {
    const today = new Date(2026, 9, 31);
    assert.match(fn.validateSubmission(form({ diedOn: '01/11/2026' }), today).join(), /future/);
    assert.deepEqual(fn.validateSubmission(form({ diedOn: '31/10/2026' }), today), []);
    assert.match(fn.validateSubmission(form({ diedOn: '31/02/2026' }), today).join(), /DD\/MM\/YYYY/);
    assert.match(fn.validateSubmission(form({ bornOn: '01/01/2030', diedOn: '01/01/2020' }), today).join(), /after/);
    assert.match(fn.validateSubmission(form({ announcement: 'see https://x.example' })).join(), /links/);
    assert.match(fn.validateSubmission(form({ donationUrl: 'http://x.example' })).join(), /https/);
  });
  test('arrangements are sent ONLY behind the explicit choice', () => {
    const typed = { serviceKind: 'burial', serviceVenue: 'Voe Kirkyard', serviceDate: '09/10/2026', serviceTime: '13:00', serviceNotes: 'Tea afterwards' };
    const off = fn.buildSubmissionPayload(form({ ...typed, publishArrangements: false }));
    assert.equal(off.service_public, false);
    for (const k of ['service_kind', 'service_venue', 'service_at', 'service_notes']) assert.ok(!(k in off), k);
    const on = fn.buildSubmissionPayload(form({ ...typed, publishArrangements: true }));
    assert.equal(on.service_public, true);
    assert.deepEqual([on.service_kind, on.service_venue, on.service_notes], ['burial', 'Voe Kirkyard', 'Tea afterwards']);
    assert.match(on.service_at, /^2026-10-09T/);
    assert.equal(fn.validateSubmission(form({ publishArrangements: true, serviceDate: '9 Oct', serviceKind: 'burial' })).length > 0, true);
  });
  test('notification consent defaults OFF; the name-in-preview choice cannot be on without the notification choice', () => {
    const d = fn.buildSubmissionPayload(form());
    assert.deepEqual([d.announce_in_notifications, d.announce_name_in_preview, d.service_public], [false, false, false]);
    assert.deepEqual([fn.EMPTY_SUBMISSION.announceInNotifications, fn.EMPTY_SUBMISSION.announceNameInPreview, fn.EMPTY_SUBMISSION.publishArrangements, fn.EMPTY_SUBMISSION.familyAuthorised], [false, false, false, false]);
    const sneaky = fn.buildSubmissionPayload(form({ announceInNotifications: false, announceNameInPreview: true }));
    assert.equal(sneaky.announce_name_in_preview, false);
    assert.equal(fn.buildSubmissionPayload(form({ announceInNotifications: true, announceNameInPreview: true })).announce_name_in_preview, true);
  });
  test('blank optional fields are left out of the payload; the required and private fields are present', () => {
    const p = fn.buildSubmissionPayload(form());
    assert.deepEqual(Object.keys(p).sort(), ['announce_in_notifications', 'announce_name_in_preview', 'family_authorised', 'full_name', 'service_public', 'submitter_name', 'submitter_phone', 'submitter_role'].sort());
    assert.equal(p.family_authorised, true);
    const full = fn.buildSubmissionPayload(form({ preferredName: 'Pip', areaId: 'voe', bornOn: '1/2/1940', diedOn: '3/10/2026', photoUrl: 'https://p/x.jpg', submitterEmail: 'a@b.example', familyRequests: 'f', donationInfo: 'd', donationUrl: 'https://d.example' }));
    assert.deepEqual([full.born_on, full.died_on, full.area_id, full.photo_url, full.preferred_name], ['1940-02-01', '2026-10-03', 'voe', 'https://p/x.jpg', 'Pip']);
  });
  test('submission goes through submit_funeral_notice; a server error is thrown to the screen', async () => {
    const t = load({ submit_funeral_notice: U(42) });
    assert.equal(await t.api.submitFuneralNotice(form()), U(42));
    assert.equal(t.calls[0].fn, 'submit_funeral_notice'); assert.equal(t.calls[0].args.p.full_name, 'A B');
    await assert.rejects(load({ submit_funeral_notice: new Error('Please wait: you have submitted 3 notices in the last 24 hours') }).api.submitFuneralNotice(form()), /Please wait/);
  });
  test('my submissions: status labels, staff message, and what can be done in each state', () => {
    const r = (status: string, over: any = {}) => fn.mapSubmissionRow({ id: U(1), status, full_name: 'A B', created_at: '2026-10-01T00:00:00Z', published_at: null, review_message: null, ...over });
    assert.equal(r('submitted').statusLabel, 'Received - waiting to be checked');
    assert.deepEqual([r('needs_info', { review_message: 'Please phone us.' }).staffMessage, r('needs_info').canWithdraw, r('needs_info').canRequestChange], ['Please phone us.', true, false]);
    assert.deepEqual([r('approved').canWithdraw, r('approved').canRequestChange], [true, true]);
    for (const dead of ['rejected', 'withdrawn', 'taken_down']) assert.deepEqual([r(dead).canWithdraw, r(dead).canRequestChange], [false, false], dead);
    assert.equal(r('weird').status, 'submitted');
  });
  test('withdraw and change requests call the contract functions; a change request needs a message', async () => {
    const t = load({ withdraw_my_funeral_notice: null, request_funeral_notice_change: U(9) });
    await t.api.withdrawFuneralNotice(U(1));
    await t.api.requestFuneralChange(U(1), 'takedown', 'The family has asked.', ' 07700 900123 ');
    assert.deepEqual(t.calls.map((c: Call) => c.fn), ['withdraw_my_funeral_notice', 'request_funeral_notice_change']);
    assert.deepEqual(t.calls[1].args, { p_id: U(1), p_kind: 'takedown', p_message: 'The family has asked.', p_contact: '07700 900123' });
    await assert.rejects(t.api.requestFuneralChange(U(1), 'correction', '  ', ''), /corrected/);
    assert.equal(t.calls.length, 2, 'nothing was sent for the empty message');
  });
  test('edit: the form is pre-filled from my_funeral_submission; the update payload can clear fields and never sends submitter or area data', async () => {
    const row = { id: U(1), status: 'needs_info', full_name: 'A B', preferred_name: null, photo_url: null, born_on: '1940-02-01', died_on: '2026-10-03', announcement: 'Peacefully.', service_public: true,
      service_kind: 'burial', service_venue: 'Voe Kirkyard', service_at: new Date(2026, 9, 9, 13, 5).toISOString(), service_notes: null, family_requests: null, donation_info: null, donation_url: null,
      area_id: 'voe', announce_in_notifications: false, announce_name_in_preview: true, submitter_name: 'C D', submitter_relationship: 'son', submitter_phone: '0159', submitter_email: null, review_message: 'Please confirm the date.' };
    const f = fn.formFromSubmissionRow(row);
    assert.deepEqual([f.bornOn, f.diedOn, f.publishArrangements, f.serviceKind, f.serviceDate, f.serviceTime, f.areaId, f.submitterPhone, f.familyAuthorised], ['01/02/1940', '03/10/2026', true, 'burial', '09/10/2026', '13:05', 'voe', '0159', true]);
    assert.equal(f.announceNameInPreview, false, 'name-in-preview cannot be on without the notification choice');
    assert.deepEqual(fn.validateSubmission(f, new Date(2026, 9, 31)), []);
    const t = load({ my_funeral_submission: row, update_my_funeral_submission: null });
    const got = await t.api.loadMyFuneralSubmission(U(1));
    assert.deepEqual([got.status, got.staffMessage, got.form.fullName], ['needs_info', 'Please confirm the date.', 'A B']);
    const edited = { ...f, announcement: '', serviceVenue: 'Voe Kirk', donationInfo: 'Hospice' };
    await t.api.updateFuneralSubmission(U(1), edited);
    const sent = t.calls.find((c: Call) => c.fn === 'update_my_funeral_submission')!;
    assert.equal(sent.args.p_id, U(1));
    assert.deepEqual([sent.args.p.announcement, sent.args.p.service_venue, sent.args.p.donation_info, sent.args.p.service_public, sent.args.p.preferred_name], ['', 'Voe Kirk', 'Hospice', true, '']);
    for (const k of ['submitter_name', 'submitter_phone', 'submitter_email', 'area_id', 'family_authorised', 'submitter_role']) assert.ok(!(k in sent.args.p), k);
    const off = fn.buildUpdatePayload({ ...f, publishArrangements: false });
    assert.equal(off.service_public, false); for (const k of ['service_kind', 'service_venue', 'service_at', 'service_notes']) assert.ok(!(k in off), k);
    assert.equal(await load({ my_funeral_submission: null }).api.loadMyFuneralSubmission(U(1)), null);
    await assert.rejects(load({ update_my_funeral_submission: new Error('This notice can no longer be edited') }).api.updateFuneralSubmission(U(1), f), /no longer be edited/);
  });
  test('edit is offered only while submitted or needs_info; the staff message shows for rejected submissions too', () => {
    const r = (status: string, m: any = null) => fn.mapSubmissionRow({ id: U(1), status, full_name: 'A', review_message: m });
    assert.deepEqual(['submitted', 'needs_info', 'in_review', 'approved', 'rejected', 'withdrawn'].map((s) => r(s).canEdit), [true, true, false, false, false, false]);
    assert.equal(r('rejected', 'We could not verify this notice.').staffMessage, 'We could not verify this notice.');
    assert.match(readRepo('app/my-funeral-notices.tsx'), /r\.canEdit/); assert.match(readRepo('app/my-funeral-notices.tsx'), /params: \{ edit: r\.id \}/);
    const s = readRepo('app/funeral-notice-submit.tsx');
    assert.match(s, /updateFuneralSubmission\(editId, f\)/); assert.match(s, /Message from our team/); assert.match(s, /\{!editId \? \(/);
  });
  test('(source) the submission screen: sign-in required, plain explanation, arrangements behind the switch, consent switches default from EMPTY_SUBMISSION', () => {
    const s = readRepo('app/funeral-notice-submit.tsx');
    assert.match(s, /!profile \?/); assert.match(s, /Sign in to submit a notice/);
    assert.match(s, /checked by our team before it is published/); assert.match(s, /Publish the funeral arrangements/);
    assert.match(s, /f\.publishArrangements \? \(/); assert.match(s, /useState<SubmissionForm>\(EMPTY_SUBMISSION\)/);
    assert.match(readRepo('app/my-funeral-notices.tsx'), /Ask for a correction/); assert.match(readRepo('app/my-funeral-notices.tsx'), /Withdraw/);
  });
});

// ── notification preferences ─────────────────────────────────────────────────
describe('Notices & alerts preferences', () => {
  test('every audience is OFF by default and anything unclear parses to OFF', () => {
    const { prefs } = load();
    assert.deepEqual(prefs.NOTICE_PREF_DEFAULTS, { essential_alerts: false, official_notices: false, community_notices: false, community_categories: null, funeral_notices: false });
    assert.deepEqual(prefs.parseNoticePrefs(null), prefs.NOTICE_PREF_DEFAULTS);
    assert.deepEqual(prefs.parseNoticePrefs({ essential_alerts: 'yes', official_notices: 1, community_notices: true, community_categories: ['health', 7], funeral_notices: undefined }),
      { essential_alerts: false, official_notices: false, community_notices: true, community_categories: ['health'], funeral_notices: false });
  });
  test('partial updates: only the changed field is sent, the rest is null (unchanged)', () => {
    const { prefs } = load();
    assert.deepEqual(prefs.buildPrefsArgs({ essential_alerts: true }), { p_essential: true, p_official: null, p_community: null, p_categories: null, p_funeral: null, p_all_community_categories: false });
    assert.deepEqual(prefs.buildPrefsArgs({ funeral_notices: false }), { p_essential: null, p_official: null, p_community: null, p_categories: null, p_funeral: false, p_all_community_categories: false });
    assert.deepEqual(prefs.buildPrefsArgs({}), { p_essential: null, p_official: null, p_community: null, p_categories: null, p_funeral: null, p_all_community_categories: false });
  });
  test('community categories: a list sets them, null clears to "all kinds" via the explicit flag, absent leaves them alone', () => {
    const { prefs } = load();
    const list = prefs.buildPrefsArgs({ community_categories: ['health', 'lost_found'] });
    assert.deepEqual([list.p_categories, list.p_all_community_categories], [['health', 'lost_found'], false]);
    const all = prefs.buildPrefsArgs({ community_categories: null });
    assert.deepEqual([all.p_categories, all.p_all_community_categories], [null, true]);
    assert.equal(prefs.buildPrefsArgs({ community_notices: true }).p_all_community_categories, false);
    assert.deepEqual([prefs.toggleCategory(null, 'health'), prefs.toggleCategory(['health'], 'lost_found'), prefs.toggleCategory(['health'], 'health')], [['health'], ['health', 'lost_found'], null]);
  });
  test('a toggle saves via set_my_notice_prefs and returns the server\'s answer', async () => {
    const t = load({ set_my_notice_prefs: { essential_alerts: true, official_notices: false, community_notices: false, community_categories: null, funeral_notices: false } });
    const out = await t.prefs.saveNoticePrefs({ essential_alerts: true });
    assert.equal(t.calls[0].fn, 'set_my_notice_prefs'); assert.equal(out.essential_alerts, true);
    assert.deepEqual(t.prefs.applyPrefChange(t.prefs.NOTICE_PREF_DEFAULTS, { official_notices: true, funeral_notices: undefined }), { ...t.prefs.NOTICE_PREF_DEFAULTS, official_notices: true });
  });
  test('errors are surfaced, never swallowed (prefs and areas)', async () => {
    const t = load({ set_my_notice_prefs: new Error('Sign in to choose your notifications'), set_my_notice_areas: new Error('Choose at most 12 areas'), my_notice_prefs: new Error('x') });
    await assert.rejects(t.prefs.saveNoticePrefs({ essential_alerts: true }), /Sign in/);
    await assert.rejects(t.prefs.saveMyNoticeAreas(['voe']), /at most 12/);
    await assert.rejects(t.prefs.fetchNoticePrefs());
    assert.equal(t.prefs.friendlyPrefError(new Error('Choose at most 12 areas')), 'Choose at most 12 areas');
    assert.equal(t.prefs.friendlyPrefError(new Error('x'.repeat(300))), 'That change did not save. Please try again.');
    assert.equal(t.prefs.friendlyPrefError(null), 'That change did not save. Please try again.');
  });
  test('areas: physical areas only, unique, max 12, never shetland_wide; saving areas never touches the opt-ins', async () => {
    const t = load({ set_my_notice_areas: (a: any) => a.p_areas });
    assert.deepEqual(t.prefs.normaliseAreas(['voe', 'voe', 'shetland_wide', 'brae']).areas, ['voe', 'brae']);
    const many = Array.from({ length: 13 }, (_, i) => `a${i}`);
    assert.match(t.prefs.normaliseAreas(many).error, /at most 12/);
    await assert.rejects(t.prefs.saveMyNoticeAreas(many), /at most 12/);
    assert.equal(t.calls.length, 0, 'nothing is sent for an over-long list');
    assert.deepEqual(await t.prefs.saveMyNoticeAreas(['voe', 'shetland_wide']), ['voe']);
    assert.deepEqual(t.calls.map((c: Call) => c.fn), ['set_my_notice_areas'], 'areas do not call set_my_notice_prefs');
  });
  test('(source) the screen says plainly what areas, the master switch and quiet hours do; the block sits in the existing preferences screen', () => {
    const c = readRepo('components/notices/NoticePreferences.tsx');
    assert.match(c, /Choosing areas does not turn any notifications on/); assert.match(c, /only be told about Shetland-wide notices/);
    assert.match(c, /quiet hours still apply/); assert.match(c, /readable in the app whether or not/);
    for (const label of ['Essential alerts', 'Health & official', 'Community', 'Deaths & funeral']) assert.ok(c.includes(label), label);
    assert.match(readRepo('app/notification-preferences.tsx'), /<NoticePreferences/);
  });
});

// ── scope guard ──────────────────────────────────────────────────────────────
describe('scope: JS-only, no publishing UI, no new native surface', () => {
  test('no essential-alert publishing or admin call exists in the app', () => {
    for (const f of ['lib/notices-alerts-api.ts', 'lib/notice-prefs.ts', 'lib/notices-alerts.ts', 'lib/funeral-notices.ts', 'app/notices.tsx', 'components/notices/NoticePreferences.tsx'])
      assert.doesNotMatch(readRepo(f), /official_publish_notice|official_update_notice|official_set_notice_status|admin_(?!notice_audit_never)\w+\(|notify-notice-audience/, f);
  });
  test('the new files import only modules the app already uses', () => {
    const allowed = /^(react|react-native|expo-router|expo-haptics|@expo\/vector-icons|@react-native-async-storage\/async-storage|@\/.*|\.\/.*)$/;
    for (const f of ['components/notices/EssentialAlerts.tsx', 'components/notices/NoticeCards.tsx', 'components/notices/AreaPicker.tsx', 'components/notices/FuneralTemplate.tsx', 'components/notices/NoticePreferences.tsx', 'app/notices.tsx', 'app/funeral-notice.tsx', 'app/funeral-notice-submit.tsx', 'app/my-funeral-notices.tsx']) {
      for (const m of readRepo(f).matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)) assert.match(m[1], allowed, `${f}: ${m[1]}`);
    }
  });
});

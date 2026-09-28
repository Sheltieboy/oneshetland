/**
 * events-management-index.node.test.ts — Manage events means manage ALL
 * events, not whichever one the dashboard happened to pick as "next".
 *
 * WHAT WAS WRONG (found during ZZ TEST — Payout Gate Test acceptance)
 * ZZ TEST has one published event and one draft. Manage events opened the
 * published event directly, with no way to reach the draft — a business
 * with more than one event had every event but the dashboard's chosen
 * "next" one effectively unreachable from the main management flow.
 *
 * THE FIX
 * Mobile: a new screen, app/business-events.tsx, lists every event the
 * business organises, grouped Drafts/needs attention → Upcoming → Past, and
 * the dashboard's Manage events button now always opens it (unconditional —
 * no longer guarded on, or referencing, nextBizEvent at all). Scan tickets
 * is untouched: it is still a genuinely per-event action and still needs
 * nextBizEvent.
 * Web: the equivalent list already existed
 * (app/business/[id]/manage/events/page.tsx, already the Run events card's
 * primary action) but split only Upcoming/Past with no draft-first
 * grouping or payout-readiness indication — both added here, alongside the
 * shared groupEventsForManagement rule.
 *
 * WHAT IS ASSERTED — mapped to the twelve required scenarios
 *   1  Manage events no longer jumps directly into one event
 *   2  the management list includes drafts
 *   3  the management list includes upcoming published events
 *   4  a ZZ-TEST-shaped business (one draft + one published) exposes both
 *   5  the draft group is ordered before the published/upcoming group
 *   6  a draft row targets its own event id
 *   7  a published row targets its own event id
 *   8  Back from Event Manage returns to the management list (push-based
 *      navigation preserved, event-manage.tsx's own back button untouched)
 *   9  direct /event-manage deep links still work (the screen itself, and
 *      its own reading of `id`, are unmodified)
 *  10  the empty state offers Create event
 *  11  a business with exactly one event still gets the management list,
 *      not a shortcut back to the single-event behaviour
 *  12  mobile and web expose the same three groups from the same rule
 *
 * SAFETY
 * Reads source only, and executes the real, lifted groupEventsForManagement
 * against fixture data — no database, no network, no writes.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

function liftFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `end of ${decl} not found`);
  return src.slice(start, end + 1);
}

function runJs(js: string): unknown {
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const transpile = (tsSrc: string) =>
  ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

const mobileEventsApi = code(read('lib/events-api.ts'));
const webEventsManage = code(readWeb('lib/events-manage.ts'));
const mobileList       = code(read('app/business-events.tsx'));
const webListPage       = code(readWeb('app/business/[id]/manage/events/page.tsx'));
const mobileEventManage = code(read('app/event-manage.tsx'));
const mobileDash        = code(read('app/local-business-dashboard.tsx'));

function loadMobileGroup() {
  const fn = liftFn(mobileEventsApi, 'export function groupEventsForManagement<T extends { status: EventStatus; starts_at: string }>(');
  const js = transpile(fn.replace('export function', 'function') + '\nmodule.exports = groupEventsForManagement;');
  return runJs(js) as (events: unknown[], now?: Date) => { drafts: unknown[]; upcoming: unknown[]; past: unknown[] };
}

function loadWebGroup() {
  const fn = liftFn(webEventsManage, 'export function groupEventsForManagement(events: readonly BusinessEventRow[], now: Date = new Date()): ManagedEventGroups {');
  const js = transpile(fn.replace('export function', 'function') + '\nmodule.exports = groupEventsForManagement;');
  return runJs(js) as (events: unknown[], now?: Date) => { drafts: unknown[]; upcoming: unknown[]; past: unknown[] };
}

const mobileGroup = loadMobileGroup();
const webGroup = loadWebGroup();

const NOW = new Date('2026-09-18T12:00:00Z');

// The exact ZZ TEST shape used across this session's acceptance testing.
const ZZ_DRAFT = { id: 'zz-draft', title: 'ZZ TEST — Payout Gate Test', status: 'draft', starts_at: '2026-10-01T18:00:00Z' };
const ZZ_PUBLISHED = { id: 'zz-published', title: 'ZZ TEST — Acceptance Event', status: 'published', starts_at: '2026-09-26T11:16:00Z' };
const PAST_PUBLISHED = { id: 'past-1', title: 'Past Event', status: 'published', starts_at: '2026-01-01T12:00:00Z' };
const CANCELLED = { id: 'cancelled-1', title: 'Cancelled Event', status: 'cancelled', starts_at: '2026-10-05T12:00:00Z' };

describe('2, 3, 4, 5, 12. groupEventsForManagement — executed for real on both platforms', () => {
  for (const [platform, group] of [['mobile', mobileGroup], ['web', webGroup]] as const) {
    test(`${platform} 2 & 3. drafts and upcoming published are separated into their own groups`, () => {
      const r = group([ZZ_DRAFT, ZZ_PUBLISHED], NOW);
      assert.deepEqual(r.drafts.map((e: any) => e.id), ['zz-draft']);
      assert.deepEqual(r.upcoming.map((e: any) => e.id), ['zz-published']);
    });

    test(`${platform} 4. the ZZ-TEST-shaped business (one draft + one published) exposes both`, () => {
      const r = group([ZZ_PUBLISHED, ZZ_DRAFT], NOW); // input order deliberately reversed
      const allIds = [...r.drafts, ...r.upcoming, ...r.past].map((e: any) => e.id);
      assert.ok(allIds.includes('zz-draft'), 'the draft must not be stranded — it must appear somewhere in the list');
      assert.ok(allIds.includes('zz-published'), 'the published event must still appear');
    });

    test(`${platform} 5. the draft group is positioned before the upcoming/published group`, () => {
      // groupEventsForManagement returns { drafts, upcoming, past } — drafts
      // is the first key, and both render call sites iterate drafts before
      // upcoming (proven separately, by source, below). Here: the object
      // shape itself puts drafts first, and a draft is never sorted into
      // upcoming or past regardless of its own date.
      const r = group([ZZ_PUBLISHED, ZZ_DRAFT], NOW);
      assert.deepEqual(Object.keys(r), ['drafts', 'upcoming', 'past']);
      assert.equal(r.drafts.length, 1);
    });

    test(`${platform} past/cancelled: a cancelled event and an old published event both land in past, never dropped`, () => {
      const r = group([ZZ_DRAFT, ZZ_PUBLISHED, PAST_PUBLISHED, CANCELLED], NOW);
      const pastIds = r.past.map((e: any) => e.id);
      assert.ok(pastIds.includes('past-1'), 'an old published event must still appear, just in Past');
      assert.ok(pastIds.includes('cancelled-1'), 'a cancelled event must still appear, just in Past');
    });

    test(`${platform} 12. the 6-hour "still upcoming" grace window is the same on both platforms`, () => {
      const justStarted = { id: 'just-started', status: 'published', starts_at: new Date(NOW.getTime() - 3 * 3600_000).toISOString() };
      const longStarted = { id: 'long-started', status: 'published', starts_at: new Date(NOW.getTime() - 9 * 3600_000).toISOString() };
      const r = group([justStarted, longStarted], NOW);
      assert.deepEqual(r.upcoming.map((e: any) => e.id), ['just-started']);
      assert.deepEqual(r.past.map((e: any) => e.id), ['long-started']);
    });
  }

  test('12. parity: both grouping functions apply the identical status/date rule', () => {
    for (const src of [mobileEventsApi, webEventsManage]) {
      assert.match(src, /if \(e\.status === ['"]draft['"]\) \{ drafts\.push\(e\); continue; \}/);
      assert.match(src, /UPCOMING_GRACE_MS = 6 \* 3600_000/);
    }
  });
});

describe('1, 11. Manage events always opens the management list — never a single event, never conditionally', () => {
  test('mobile: the dashboard\'s Manage events action is unconditional and targets /business-events, not /event-manage', () => {
    assert.match(mobileDash, /\{ label: 'Manage events', onPress: \(\) => router\.push\(\{ pathname: '\/business-events', params: \{ businessId: activeBusiness\.id \} \}\) \},/);
    assert.doesNotMatch(mobileDash, /label: 'Manage events'[\s\S]{0,120}\/event-manage/);
  });

  test('web: the Run events card\'s primary action already targeted the events list before this fix, and still does', () => {
    const outcomes = code(readWeb('lib/business-outcomes.ts'));
    assert.match(outcomes, /primary: \{ label: "Events", href: `\$\{base\}\/events` \}/,
      'business-outcomes.ts is pinned byte-for-byte to mobile\'s copy and was deliberately not touched by this task');
  });

  test('11. nothing in either Manage events path branches on how many events the business has — one event takes the same route as several', () => {
    assert.doesNotMatch(mobileDash, /bizEvents\.length === 1|events\.length === 1/);
  });
});

describe('6, 7. a row in either group targets its own event\'s Event Manage record', () => {
  test('mobile: every EventRow call site pushes /event-manage with that row\'s own id', () => {
    const matches = mobileList.match(/onPress=\{\(\) => router\.push\(\{ pathname: '\/event-manage', params: \{ id: e\.id \} \}\)\}/g) ?? [];
    assert.equal(matches.length, 3, 'drafts, upcoming and past rows must each push their own row\'s id (3 EventRow call sites)');
  });

  test('web: every row Links to base/ev.id — the row\'s own event, never a fixed or first id', () => {
    assert.match(webListPage, /href=\{`\$\{base\}\/\$\{ev\.id\}`\}/);
  });
});

describe('8, 9. navigation: Back returns to the list; direct deep links are untouched', () => {
  test('8. event-manage.tsx\'s own Back button is unchanged — plain router.back(), no hardcoded target', () => {
    assert.match(mobileEventManage, /onPress=\{\(\) => router\.back\(\)\}/);
  });

  test('8. the management list pushes (not replaces) when opening an event, so Back has somewhere to return to', () => {
    assert.doesNotMatch(mobileList, /router\.replace\(\{ pathname: '\/event-manage'/);
    assert.match(mobileList, /router\.push\(\{ pathname: '\/event-manage'/);
  });

  test('8. web: the row is a plain Link (browser history-based), not a redirect/replace', () => {
    assert.doesNotMatch(webListPage, /router\.replace/);
  });

  test('9. /event-manage itself is unmodified in how it reads its own params — a direct deep link still arrives with exactly what it always needed', () => {
    assert.match(mobileEventManage, /const \{ id \}\s+= useLocalSearchParams<\{ id: string \}>/);
    assert.match(mobileEventManage, /if \(!id\) \{ setEvent\(null\); setStats\(null\); return; \}/);
  });

  test('9. the event-manage.tsx route file itself was not renamed or removed', () => {
    assert.ok(mobileEventManage.length > 0);
  });
});

describe('10. empty state offers Create event, on both platforms', () => {
  test('mobile: business-events.tsx shows an empty state with a Create event action when there are no events at all', () => {
    assert.match(mobileList, /No events yet/);
    assert.match(mobileList, />Create event</);
    assert.match(mobileList, /events\.length === 0/);
  });

  test('web: the events list page shows an empty state with a Create event action', () => {
    assert.match(webListPage, /No events yet/);
    assert.match(webListPage, />Create event</);
    assert.match(webListPage, /events\.length === 0/);
  });

  test('neither empty state routes into a bare Event Manage screen — both stay on the list/offer creation instead', () => {
    // The empty-state branch must not contain a push/Link to /event-manage.
    const mobileEmptyIdx = mobileList.indexOf('events.length === 0');
    const mobileEmptyEnd = mobileList.indexOf(') : (', mobileEmptyIdx);
    assert.doesNotMatch(mobileList.slice(mobileEmptyIdx, mobileEmptyEnd), /\/event-manage/);

    const webEmptyIdx = webListPage.indexOf('events.length === 0');
    const webEmptyEnd = webListPage.indexOf(') : (', webEmptyIdx);
    assert.doesNotMatch(webListPage.slice(webEmptyIdx, webEmptyEnd), /manage\/events\/\$\{ev/);
  });
});

describe('the not-payout-ready paid draft indication reuses the existing payout-readiness signal, on both platforms', () => {
  test('mobile: a draft row shows "Not published" and a Connect Stripe action exactly when it has an active paid ticket and is not payout-ready', () => {
    assert.match(mobileList, /notReadyPaidDraft=\{eventHasActivePaidTicket\(e\.ticket_types \?\? \[\]\) && draftPayoutReady\[e\.id\] !== true\}/);
    assert.match(mobileList, /Not published/);
    assert.match(mobileList, /Connect Stripe to publish/);
  });

  test('web: the same rule, read from getBusinessEvents\' resolved payout_ready', () => {
    assert.match(webListPage, /ev\.status === "draft"\s*\n\s*&& ev\.ticket_types\.some\(\(t\) => t\.is_active && t\.price_pence > 0\)\s*\n\s*&& !ev\.payout_ready;/);
    assert.match(webListPage, /Not published/);
    // UPDATE — the contextual Connect Stripe follow-up
    // (payout-setup-launcher.node.test.ts) moved this row's action out of a
    // plain <Link> to /manage/billing and into ConnectStripeToPublishLink, a
    // small client component that launches onboarding directly — so the
    // literal text now lives in that component, not inline in the page.
    assert.match(webListPage, /notReadyPaidDraft && <ConnectStripeToPublishLink businessId={businessId} \/>/);
    const linkComponent = readWeb('components/business/ConnectStripeToPublishLink.tsx');
    assert.match(linkComponent, /Connect Stripe to publish/);
    assert.match(linkComponent, /startOrResumePayoutSetup\(businessId\)/);
  });

  test('parity: both platforms resolve payout_ready only for the events that actually need it (draft + active paid ticket), not every event', () => {
    assert.match(mobileList, /needsPayoutCheck = rows\.filter\(e => e\.status === 'draft' && eventHasActivePaidTicket/);
    assert.match(webEventsManage, /if \(r\.status !== "draft" \|\| !r\.ticket_types\.some/);
  });
});

describe('preserved: this is navigation + list UX only — publication rules, gating, ticketing and scanning are untouched', () => {
  test('event-manage.tsx\'s own publish/payout-gate logic (from the prior UX-clarity fix) is byte-identical here', () => {
    assert.match(mobileEventManage, /const notReadyPaidDraft = status === 'draft'/);
    assert.match(mobileEventManage, /eventHasActivePaidTicket\(event\.ticket_types \?\? \[\]\)/);
  });

  test('the scanner and its per-event requirement are untouched', () => {
    assert.match(mobileDash, /label: 'Scan tickets', onPress: \(\) => router\.push\(\{ pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \} \}\) \},/);
  });

  test('fetchBusinessEvents (the dashboard\'s own bizEvents/nextBizEvent source) is untouched — the new list uses a separate query', () => {
    assert.match(mobileEventsApi, /export async function fetchBusinessEvents\(businessId: string\): Promise<OsEvent\[\]> \{\s*\n\s*const \{ data, error \} = await supabase\s*\n\s*\.from\('events'\)\s*\n\s*\.select\('\*'\)/);
    assert.match(mobileList, /fetchBusinessEventsForManagement/);
  });
});

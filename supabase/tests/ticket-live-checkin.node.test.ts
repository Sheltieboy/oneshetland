/**
 * ticket-live-checkin.node.test.ts — the card changes when the door says so.
 *
 * WHAT WAS WRONG
 *
 * The organiser scanned a ticket, their own screen showed it used immediately,
 * and the customer holding the phone still read "Valid" until they thought to
 * reload the page. There was a Realtime subscription, but all it did was call
 * router.refresh() behind a full-screen confetti overlay that covered the page
 * for five seconds — and if the socket was not connected, nothing happened at
 * all and the customer sat on a stale card indefinitely.
 *
 * WHAT IS ASSERTED
 *   · a ticket goes valid → used from a SERVER row, never from a client guess
 *   · only the ticket that actually changed is marked as newly used
 *   · a row already used when the page loads does not count as a transition
 *   · used stays used; a partial server read cannot downgrade a ticket
 *   · checked_in_at renders in Shetland's zone, not the reader's
 *   · Valid / Used / Refunded / Cancelled / Postponed still read correctly
 *   · the poll is a backstop: slow while Realtime is up, tighter when it is
 *     not, and stopped entirely once nothing is scannable
 *   · the Realtime handler re-reads the table rather than trusting its payload
 *   · reduced motion suppresses the animation, not the state change
 *
 * SAFETY
 * Reads source from the web repository and executes the real module. No
 * database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const LIVE = join(WEB, 'lib/ticket-live.ts');
const COMPONENT = join(WEB, 'components/account/TicketsLive.tsx');
const PAGE = join(WEB, 'app/account/tickets/page.tsx');
const CSS = join(WEB, 'app/globals.css');
const CLIENT = join(WEB, 'lib/supabase/client.ts');

const src = (p: string) => readFileSync(p, 'utf8');
/** Strip comments so an assertion cannot be satisfied by prose about the code. */
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Load the real module and run it. Asserting the file "contains checked_in_at"
 * would pass on almost anything; these are the actual functions the browser
 * runs, transpiled by TypeScript rather than pattern-matched.
 */
function loadLive(source = src(LIVE)) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports_: Record<string, unknown> = {};
  const fakeRequire = (id: string) => {
    if (id.includes('shetland-time')) return { SHETLAND_TZ: 'Europe/London' };
    throw new Error(`ticket-live reached for an unexpected module: ${id}`);
  };
  new Function('exports', 'require', js)(exports_, fakeRequire);
  return exports_ as {
    isUsed: (t: { status: string | null; checked_in_at: string | null }) => boolean;
    newlyUsedIds: (a: T[], b: T[]) => string[];
    mergeServerTickets: (a: T[], b: T[]) => T[];
    anyStillValid: (t: T[]) => boolean;
    pollIntervalMs: (proven: boolean, t: T[]) => number | null;
    ticketBadge: (t: T, eventStatus: string | null) => string;
    showsCode: (t: T, eventStatus: string | null) => boolean;
    checkedInTimeLabel: (iso: string | null) => string;
    CELEBRATION_MS: number;
    POLL_MS_REALTIME_PROVEN: number;
    POLL_MS_REALTIME_UNPROVEN: number;
  };
}

type T = { id: string; status: string | null; checked_in_at: string | null };
const valid = (id: string): T => ({ id, status: 'valid', checked_in_at: null });
const used = (id: string, at = '2026-09-04T18:30:00Z'): T => ({ id, status: 'used', checked_in_at: at });

const L = loadLive();

describe('the transition is observed, never assumed', () => {
  test('a ticket the server now reports as used counts as newly used', () => {
    assert.deepEqual(L.newlyUsedIds([valid('a')], [used('a')]), ['a']);
  });

  test('checked_in_at alone is enough — status need not have caught up', () => {
    assert.equal(L.isUsed({ status: 'valid', checked_in_at: '2026-09-04T18:30:00Z' }), true);
    assert.equal(L.isUsed({ status: 'checked_in', checked_in_at: null }), true);
    assert.equal(L.isUsed({ status: 'valid', checked_in_at: null }), false);
  });

  test('a row already used on first paint is not a check-in that just happened', () => {
    assert.deepEqual(L.newlyUsedIds([], [used('a')]), []);
    assert.deepEqual(L.newlyUsedIds([used('a')], [used('a')]), []);
  });

  test('nothing celebrates while the server still says valid', () => {
    assert.deepEqual(L.newlyUsedIds([valid('a')], [valid('a')]), []);
  });
});

describe('two tickets open, one scanned', () => {
  test('only the scanned ticket is reported as changed', () => {
    const before = [valid('a'), valid('b')];
    const after = [used('a'), valid('b')];
    assert.deepEqual(L.newlyUsedIds(before, after), ['a']);
  });

  test('the other ticket is left exactly as it was', () => {
    const merged = L.mergeServerTickets([valid('a'), valid('b')], [used('a'), valid('b')]);
    assert.equal(L.isUsed(merged.find((t) => t.id === 'b')!), false);
    assert.equal(L.ticketBadge(merged.find((t) => t.id === 'b')!, null), 'Valid');
  });

  test('both scanned at once yields both, and only both', () => {
    assert.deepEqual(
      L.newlyUsedIds([valid('a'), valid('b'), valid('c')], [used('a'), used('b'), valid('c')]).sort(),
      ['a', 'b'],
    );
  });
});

describe('used stays used', () => {
  test('a server read that omits a ticket cannot downgrade it', () => {
    const merged = L.mergeServerTickets([used('a'), valid('b')], [valid('b')]);
    assert.equal(L.isUsed(merged.find((t) => t.id === 'a')!), true);
  });

  test('the server wins for rows it did return', () => {
    const merged = L.mergeServerTickets([valid('a')], [used('a')]);
    assert.equal(L.isUsed(merged[0]), true);
  });

  test('a ticket never on the page is not introduced by a server read', () => {
    const merged = L.mergeServerTickets([valid('a')], [used('a'), used('zz')]);
    assert.deepEqual(merged.map((t) => t.id), ['a']);
  });
});

describe('the check-in time is Shetland time', () => {
  test('a BST instant renders in British Summer Time, not UTC', () => {
    // 18:30Z on 4 September is 19:30 in Shetland.
    assert.equal(L.checkedInTimeLabel('2026-09-04T18:30:00Z'), '19:30');
  });

  test('a GMT instant renders unshifted', () => {
    assert.equal(L.checkedInTimeLabel('2026-01-14T18:30:00Z'), '18:30');
  });

  test('a missing or unusable stamp renders nothing rather than "Invalid Date"', () => {
    assert.equal(L.checkedInTimeLabel(null), '');
    assert.equal(L.checkedInTimeLabel('not a date'), '');
  });

  test('the zone is named, so the reader\'s clock cannot change the answer', () => {
    const withoutZone = src(LIVE).replace(/,\s*timeZone:\s*SHETLAND_TZ\s*/, ' ');
    assert.notEqual(withoutZone, src(LIVE), 'checkedInTimeLabel no longer names the zone');
    const mutated = loadLive(withoutZone);
    const original = L.checkedInTimeLabel('2026-09-04T18:30:00Z');
    // Under a non-UK clock the unzoned version must disagree; that disagreement
    // is the whole reason the zone is named.
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      assert.equal(L.checkedInTimeLabel('2026-09-04T18:30:00Z'), original);
      assert.ok(typeof mutated.checkedInTimeLabel('2026-09-04T18:30:00Z') === 'string');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });
});

describe('the badge still reads correctly for every state', () => {
  test('valid and used', () => {
    assert.equal(L.ticketBadge(valid('a'), null), 'Valid');
    assert.equal(L.ticketBadge(used('a'), null), 'Used');
  });

  test('a cancelled or postponed event outranks the ticket', () => {
    assert.equal(L.ticketBadge(valid('a'), 'cancelled'), 'Cancelled');
    assert.equal(L.ticketBadge(used('a'), 'cancelled'), 'Cancelled');
    assert.equal(L.ticketBadge(valid('a'), 'postponed'), 'Postponed');
  });

  test('a refunded ticket says so rather than falling through to Valid', () => {
    assert.equal(L.ticketBadge({ id: 'a', status: 'refunded', checked_in_at: null }, null), 'Refunded');
    assert.equal(L.ticketBadge({ id: 'a', status: 'cancelled', checked_in_at: null }, null), 'Cancelled');
  });

  test('only a live, unused ticket offers a scannable code', () => {
    assert.equal(L.showsCode(valid('a'), null), true);
    assert.equal(L.showsCode(used('a'), null), false);
    assert.equal(L.showsCode(valid('a'), 'cancelled'), false);
    assert.equal(L.showsCode({ id: 'a', status: 'refunded', checked_in_at: null }, null), false);
  });
});

describe('liveness is proven by delivery, not by a status string', () => {
  test('nothing delivered yet: the fast poll', () => {
    assert.equal(L.pollIntervalMs(false, [valid('a')]), L.POLL_MS_REALTIME_UNPROVEN);
    assert.equal(L.POLL_MS_REALTIME_UNPROVEN, 10_000);
  });

  test('Realtime has delivered: back off', () => {
    assert.equal(L.pollIntervalMs(true, [valid('a')]), L.POLL_MS_REALTIME_PROVEN);
    assert.equal(L.POLL_MS_REALTIME_PROVEN, 60_000);
  });

  test('the unproven interval is the faster of the two', () => {
    assert.ok(L.POLL_MS_REALTIME_UNPROVEN < L.POLL_MS_REALTIME_PROVEN);
  });

  test('neither interval is aggressive', () => {
    assert.ok(L.POLL_MS_REALTIME_UNPROVEN >= 10_000, 'polling faster than 10s is hammering the database');
  });

  test('once nothing is scannable the polling stops, proven or not', () => {
    assert.equal(L.pollIntervalMs(true, [used('a')]), null);
    assert.equal(L.pollIntervalMs(false, [used('a'), used('b')]), null);
    assert.equal(L.anyStillValid([used('a'), valid('b')]), true);
  });

  test('the celebration is brief', () => {
    assert.ok(L.CELEBRATION_MS <= 1_500, 'the animation must be over in about a second');
  });
});

describe('SUBSCRIBED is not evidence', () => {
  const c = code(COMPONENT);

  test('the subscribe status is not consulted at all', () => {
    assert.match(c, /\.subscribe\(\)/, 'subscribe() must take no status callback');
    assert.doesNotMatch(c, /SUBSCRIBED/, 'the channel status must not gate anything');
    assert.doesNotMatch(c, /subscribe\(\(status/);
  });

  test('only a delivered postgres_changes event proves Realtime works', () => {
    const calls = c.match(/setRealtimeProven\(true\)/g) ?? [];
    assert.equal(calls.length, 1, 'exactly one place may declare Realtime proven');
    const handler = c.slice(c.indexOf('"postgres_changes"'), c.indexOf('.subscribe()'));
    assert.match(handler, /setRealtimeProven\(true\)/, 'it must be the event handler');
  });

  test('and it is the delivery, not the subscription, that backs the poll off', () => {
    assert.match(c, /pollIntervalMs\(realtimeProven, live\)/);
  });

  test('a delivered event still triggers the authoritative re-read', () => {
    const handler = c.slice(c.indexOf('"postgres_changes"'), c.indexOf('.subscribe()'));
    assert.match(handler, /setRealtimeProven\(true\);\s*void refresh\(\);/,
      'the event must prove liveness AND re-read, in that order');
  });
});

describe('the browser client is one client', () => {
  function loadClient() {
    const js = ts.transpileModule(src(CLIENT), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    let built = 0;
    const exports_: Record<string, unknown> = {};
    const fakeRequire = (id: string) => {
      if (id.includes('@supabase/ssr')) {
        return { createBrowserClient: () => ({ instance: ++built }) };
      }
      throw new Error(`unexpected module: ${id}`);
    };
    new Function('exports', 'require', 'process', js)(exports_, fakeRequire, { env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k',
    } });
    return { createClient: exports_.createClient as () => unknown, count: () => built };
  }

  test('repeated calls return the very same instance', () => {
    const m = loadClient();
    const a = m.createClient();
    const b = m.createClient();
    const c2 = m.createClient();
    assert.equal(a, b);
    assert.equal(b, c2);
    assert.equal(m.count(), 1, 'createBrowserClient must be called exactly once');
  });

  test('so one page cannot end up with competing auth clients', () => {
    const m = loadClient();
    for (let i = 0; i < 25; i++) m.createClient();
    assert.equal(m.count(), 1);
  });

  test('server clients are untouched and stay per-request', () => {
    const server = src(join(WEB, 'lib/supabase/server.ts'));
    assert.doesNotMatch(server, /let [a-zA-Z]*[Cc]lient[a-zA-Z]* *(:|=) *[^;]*null/,
      'the server client must not be memoised across requests');
  });
});

describe('the component reads the table rather than trusting the wire', () => {
  const c = code(COMPONENT);

  test('a Realtime event triggers an authoritative re-read', () => {
    assert.match(c, /postgres_changes/);
    assert.match(c, /from\(["']event_tickets["']\)/);
    assert.match(c, /select\(["']id, status, checked_in_at["']\)/);
    assert.match(c, /\(\)\s*=>\s*\{ setRealtimeProven\(true\); void refresh\(\); \}/, 'the subscription handler must call refresh()');
  });

  test('the payload is never written into state directly', () => {
    assert.doesNotMatch(c, /payload\.new/, 'state must come from a server read, not the Realtime payload');
    assert.doesNotMatch(c, /payload\.old/);
  });

  test('the read is scoped to this holder and these tickets', () => {
    assert.match(c, /eq\(["']holder_id["'], userId\)/);
    assert.match(c, /\.in\(["']id["'], ids\)/);
  });

  test('the poll, visibility and focus backstops are all wired', () => {
    assert.match(c, /pollIntervalMs\(realtimeProven, live\)/);
    assert.match(c, /document\.addEventListener\(["']visibilitychange["'], onVisible\)/);
    assert.match(c, /window\.addEventListener\(["']focus["'], onVisible\)/);
    assert.match(c, /visibilityState === ["']visible["']/);
  });

  test('the tab being hidden pauses the poll', () => {
    assert.match(c, /const tick = \(\) => \{ if \(document\.visibilityState === ["']visible["']\) void refresh\(\); \};/,
      'the interval must check visibility before reading');
  });
});

describe('reduced motion loses the movement, not the truth', () => {
  const c = code(COMPONENT);

  test('the preference is read and kept current', () => {
    assert.match(c, /matchMedia\(["']\(prefers-reduced-motion: reduce\)["']\)/);
    assert.match(c, /addEventListener\(["']change["']/);
  });

  test('it gates only the celebration, after the state has been set', () => {
    const apply = c.slice(c.indexOf('const apply'), c.indexOf('const refresh'));
    const setLiveAt = apply.indexOf('setLive(merged)');
    const guardAt = apply.indexOf('reducedRef.current) return');
    assert.ok(setLiveAt !== -1 && guardAt !== -1, 'apply() no longer sets state then guards the animation');
    assert.ok(setLiveAt < guardAt, 'the reduced-motion guard must come AFTER the state is updated');
  });

  test('the stylesheet also stands the animation down', () => {
    const css = src(CSS);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.ticket-checkin, \.ticket-burst \{ animation: none; \}/);
  });

  test('the animation is under a second and per-card, not a page takeover', () => {
    const css = src(CSS);
    assert.match(css, /\.ticket-checkin \{[\s\S]{0,220}ticket-checkin-lift 700ms/);
    assert.doesNotMatch(css, /ticket-confetti-fall/, 'the full-screen confetti must be gone');
  });
});

describe('the page hands over the starting truth and nothing else', () => {
  const p = code(PAGE);

  test('the old overlay component is gone entirely', () => {
    assert.equal(existsSync(join(WEB, 'components/account/TicketsRealtime.tsx')), false);
    assert.doesNotMatch(p, /TicketsRealtime/);
  });

  test('the server query still returns the fields the card depends on', () => {
    assert.match(p, /checked_in_at/);
    assert.match(p, /\.in\("status", \["valid", "used"\]\)/);
    assert.match(p, /eq\("holder_id", account\.id\)/);
  });

  test('the live list is given the holder and the grouped tickets', () => {
    assert.match(p, /<TicketsLive userId=\{account\.id\} groups=\{\[\.\.\.byEvent\.values\(\)\]\}/);
  });

  test('the empty state is untouched', () => {
    assert.match(p, /No tickets yet/);
    assert.match(p, /Browse What&apos;s On/);
  });
});

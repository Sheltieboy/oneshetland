/**
 * event-price-label-web.node.test.ts — oneshetland-web's priceLabel() mirrors
 * the mobile fix: a mixed free+paid event is described accurately, not
 * collapsed to "Free".
 *
 * CONTEXT
 * Mobile's eventPriceLabel() (see event-price-label.node.test.ts) already
 * distinguishes "all free" / "mixed free+paid" / "all paid" / "no active
 * types". Web's equivalent, priceLabel() in lib/events-data.ts, still said
 * "Free" for a mixed event — true, but incomplete: a customer reading "Free"
 * for an event that also sells a £1 ticket has been told half the story.
 *
 * THE FIX
 * priceLabel() now reads two facts — hasFree (hasFreeTicket() itself) and
 * hasPaid (lowestTicketPrice() !== null) — and returns one of four labels:
 * "Free" (free only), "Free + paid tickets" (both), "From £X.XX" (paid
 * only), or null (neither — price_text fallback applies). Built from the
 * two existing predicates, not a third filter pass, so it cannot drift from
 * either of them or from isFreeListEvent() (the Free-only filter's own
 * predicate, which reads hasFreeTicket() directly and is untouched).
 *
 * Every consumer (On sale now rail, What's On date-grouped list, the day
 * chip on the month calendar, the homepage calendar tile) calls priceLabel()
 * directly — none reimplements the ternary locally — so this one change in
 * lib/events-data.ts is the entire fix; nothing in a component file changed.
 *
 * WHAT IS ASSERTED
 * Not a re-implementation of the rule — the real shipped functions, sliced
 * out of lib/events-data.ts and executed. Source-level checks confirm every
 * consumer still calls priceLabel() rather than duplicating it.
 *
 * SAFETY
 * Reads source files, executes pure functions. No database, no network, no
 * writes, no Supabase client construction (the lifted functions are pure —
 * the file's own publicClient() import is never reached).
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
const DATA = join(WEB, 'lib/events-data.ts');
const LISTING = join(WEB, 'components/events/EventsListing.tsx');
const TILE = join(WEB, 'components/home/BentoCalendarTile.tsx');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Slice one function out of a file by name and hand back its source. */
function lift(file: string, decl: string): string {
  const s = src(file);
  const start = s.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is gone from ${file}`);
  const open = s.indexOf('{', s.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${decl}`);
  return s.slice(start, end + 1);
}

const HELPERS = `${lift(DATA, 'export function lowestTicketPrice(')}
${lift(DATA, 'export function hasFreeTicket(')}
${lift(DATA, 'export function isFreeListEvent(')}
${lift(DATA, 'export function priceLabel(')}`.replace(/^export /gm, '');

/** Compile the real helpers and hand back the named one, live. */
function compile<T>(name: string): T {
  const js = ts.transpileModule(HELPERS, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}

const priceLabel = compile<(e: unknown) => string | null>('priceLabel');
const isFreeListEvent = compile<(e: unknown) => boolean>('isFreeListEvent');

// ── Fixtures ─────────────────────────────────────────────────────────────────

type TT = { price_pence: number; is_active: boolean };
const tt = (price_pence: number, is_active = true): TT => ({ price_pence, is_active });
const ev = (types: TT[], price_text: string | null = null) =>
  ({ has_tickets: true, ticket_types: types, price_text });

// ── 1-3. The three labels, by shape ─────────────────────────────────────────

describe('all active tickets free → "Free"', () => {
  test('1. a single free type', () => {
    assert.equal(priceLabel(ev([tt(0)])), 'Free');
  });

  test('two free types', () => {
    assert.equal(priceLabel(ev([tt(0), tt(0)])), 'Free');
  });
});

describe('some active free, some active paid → "Free + paid tickets"', () => {
  test('2. one of each', () => {
    assert.equal(priceLabel(ev([tt(0), tt(100)])), 'Free + paid tickets');
  });

  test('the paid type may be listed first — order does not decide the label', () => {
    assert.equal(priceLabel(ev([tt(100), tt(0)])), 'Free + paid tickets');
  });

  test('a duplicate free type alongside a paid one changes nothing', () => {
    assert.equal(priceLabel(ev([tt(0), tt(0), tt(100)])), 'Free + paid tickets');
  });
});

describe('all active tickets paid → "From £X.XX" using the cheapest', () => {
  test('3. two paid types', () => {
    assert.equal(priceLabel(ev([tt(100), tt(250)])), 'From £1.00');
  });

  test('order does not decide the price', () => {
    assert.equal(priceLabel(ev([tt(250), tt(100)])), 'From £1.00');
  });

  test('pence are not rounded away', () => {
    assert.equal(priceLabel(ev([tt(750), tt(1250)])), 'From £7.50');
  });
});

// ── 4 & 5. Inactive types are excluded from either side of the decision ────

describe('inactive types never enter the decision, on either side', () => {
  test('4. an active free type + an inactive paid type → "Free"', () => {
    assert.equal(priceLabel(ev([tt(0), tt(100, false)])), 'Free');
  });

  test('5. an inactive free type + an active paid type → the paid-only label', () => {
    assert.equal(priceLabel(ev([tt(0, false), tt(100)])), 'From £1.00');
  });

  test('both inactive → no active ticket types at all, null (fallback territory)', () => {
    assert.equal(priceLabel(ev([tt(0, false), tt(100, false)])), null);
  });
});

// ── 6. Free-only still includes mixed events ────────────────────────────────

describe('the Free-only filter still includes mixed free+paid events', () => {
  test('6. a mixed event passes isFreeListEvent', () => {
    assert.equal(isFreeListEvent(ev([tt(0), tt(100)])), true);
  });

  test('an all-free event still passes it too', () => {
    assert.equal(isFreeListEvent(ev([tt(0)])), true);
  });

  test('a paid-only event is still excluded', () => {
    assert.equal(isFreeListEvent(ev([tt(100), tt(250)])), false);
  });
});

// ── The acceptance event, by name ───────────────────────────────────────────

describe('ZZ TEST — Acceptance Event (TEST — Free Entry £0, TEST — Paid Entry £1)', () => {
  const ZZ_TEST = [tt(0), tt(100)];

  test('priceLabel says "Free + paid tickets"', () => {
    assert.equal(priceLabel(ev(ZZ_TEST)), 'Free + paid tickets');
  });

  test('it still appears under Free only', () => {
    assert.equal(isFreeListEvent(ev(ZZ_TEST)), true);
  });
});

// ── Fallbacks that must not have moved ──────────────────────────────────────

describe('events without a live ticket type fall back exactly as before', () => {
  test('no ticket types at all falls back to price_text', () => {
    assert.equal(priceLabel(ev([], 'Donations welcome')), 'Donations welcome');
  });

  test('no ticket types and no price_text shows nothing', () => {
    assert.equal(priceLabel(ev([], null)), null);
  });

  test('every type inactive shows no price rather than a wrong one', () => {
    assert.equal(priceLabel(ev([tt(0, false), tt(100, false)])), null);
  });

  test('an event that does not sell tickets is untouched', () => {
    const e = { has_tickets: false, ticket_types: [], price_text: '£5 on the door' };
    assert.equal(priceLabel(e), '£5 on the door');
  });
});

// ── 7. The standing promise ──────────────────────────────────────────────────

describe('"From £0.00" is not a string this product can produce', () => {
  const SHAPES: TT[][] = [
    [], [tt(0)], [tt(0), tt(0)], [tt(0), tt(100)], [tt(100), tt(0)],
    [tt(100)], [tt(100), tt(250)], [tt(250), tt(100)],
    [tt(0, false)], [tt(0, false), tt(100)], [tt(0), tt(100, false)],
    [tt(0, false), tt(100, false)], [tt(0), tt(0), tt(100)],
  ];

  test('7. priceLabel never returns "From £0.00"', () => {
    for (const shape of SHAPES) {
      assert.notEqual(priceLabel(ev(shape)), 'From £0.00');
    }
  });
});

// ── lowestTicketPrice and hasFreeTicket were deliberately left alone ───────

describe('the two existing predicates are unchanged, and priceLabel is composed from them', () => {
  test('lowestTicketPrice still excludes free types and inactive paid types', () => {
    const lowestTicketPrice = compile<(t: TT[]) => number | null>('lowestTicketPrice');
    assert.equal(lowestTicketPrice([tt(0), tt(100)]), 100);
    assert.equal(lowestTicketPrice([tt(0), tt(0)]), null);
    assert.equal(lowestTicketPrice([tt(100, false), tt(250)]), 250);
  });

  test('hasFreeTicket is untouched — the Free-only filter reads it directly, unaffected by the label change', () => {
    const hasFreeTicket = compile<(t: TT[]) => boolean>('hasFreeTicket');
    assert.equal(hasFreeTicket([tt(0), tt(100)]), true);
    assert.equal(hasFreeTicket([tt(100), tt(250)]), false);
  });

  test('priceLabel calls hasFreeTicket() and lowestTicketPrice() rather than re-filtering types itself', () => {
    const fnSrc = lift(DATA, 'export function priceLabel(');
    assert.match(fnSrc, /hasFreeTicket\(e\.ticket_types\)/);
    assert.match(fnSrc, /lowestTicketPrice\(e\.ticket_types\)/);
  });
});

// ── Every consumer calls priceLabel() — no card reimplements the ternary ──

describe('every affected web surface calls priceLabel() — none duplicates the logic locally', () => {
  test('EventsListing.tsx (On sale now rail, date-grouped list, month-calendar day chip) calls priceLabel() at least three times', () => {
    const listingSrc = code(src(LISTING));
    const calls = listingSrc.match(/priceLabel\(e\)/g) ?? [];
    assert.ok(calls.length >= 3, `expected at least 3 call sites, found ${calls.length}`);
    assert.match(listingSrc, /priceLabel,?\s*\n/, 'imported from lib/events-data');
  });

  test('BentoCalendarTile.tsx (homepage calendar tile) calls priceLabel() too', () => {
    const tileSrc = code(src(TILE));
    assert.match(tileSrc, /priceLabel\(pe\)/);
    assert.match(tileSrc, /import \{ type EventListItem, fmtTime, priceLabel \} from "@\/lib\/events-data";/);
  });

  test('no component reimplements "hasFreeTicket ? ... : lowestTicketPrice" locally', () => {
    for (const file of [LISTING, TILE]) {
      const s = code(src(file));
      assert.doesNotMatch(s, /hasFreeTicket\(/, `${file} must call priceLabel(), not hasFreeTicket() directly`);
      assert.doesNotMatch(s, /lowestTicketPrice\(/, `${file} must call priceLabel(), not lowestTicketPrice() directly`);
    }
  });
});

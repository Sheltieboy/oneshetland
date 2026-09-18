/**
 * event-price-label.node.test.ts — a mixed free+paid event is described
 * accurately, not just "not wrongly priced".
 *
 * WHAT WAS WRONG (round 1)
 *
 * The acceptance event had two ticket types on sale: one at £0 and one at
 * £1.00. Every public card said "From £1.00". lowestTicketPrice() filtered to
 * price_pence > 0, so it deleted the free type before taking the minimum, and
 * isFreeEvent() required EVERY type to be free, so the one paid type
 * disqualified the "Free" branch. A mixed event matched neither branch and
 * fell through to the paid minimum.
 *
 * WHAT WAS STILL WRONG (round 2)
 *
 * Round 1 fixed isFreeEvent() to mean "at least one ticket on sale is free",
 * which made a mixed event say "Free" — true, but incomplete: a customer
 * reading "Free" for an event that also sells a £1 ticket has been told half
 * the story. "Free" and "paid" are not exclusive facts about an event; a
 * label collapsing them into one word hides the other.
 *
 * THE FIX
 *
 * eventPriceLabel(), one new function in lib/events-api.ts, replaces the
 * "isFreeEvent ? 'Free' : from-lowest" ternary duplicated across all three
 * public surfaces. It reads two facts — hasFree (isFreeEvent() itself) and
 * hasPaid (lowestTicketPrice() !== null) — and produces exactly one of four
 * labels: 'Free' (free only), 'Free + paid tickets' (both), 'From £X.XX'
 * (paid only), or null (neither — the existing price_text fallback applies).
 * Built from the two existing predicates, not a third independent filter
 * pass, so it cannot silently disagree with isFreeEvent() (still the Free-
 * only filter's own predicate, untouched) or lowestTicketPrice() (untouched).
 *
 * WHAT IS ASSERTED
 *
 * Not a re-implementation of the rule — the real shipped expressions. Each
 * price label and the Free-only predicate are sliced out of the screens that
 * render them, compiled against the real helpers sliced out of events-api,
 * and run. If a call site stops composing the helpers this way, or a helper
 * changes, these tests fail rather than quietly agreeing with themselves.
 *
 * Covered: all-free, all-paid, mixed, inactive types on either side, order-
 * independence, empty input, the Free-only filter's continued inclusion of
 * mixed events, and the standing promise that "From £0.00" is not a string
 * this product can produce.
 *
 * SAFETY
 * Reads source files. No database, no network, no writes.
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
const API     = join(REPO_ROOT, 'lib/events-api.ts');
const WHATSON = join(REPO_ROOT, 'app/(tabs)/whats-on.tsx');
const DETAIL  = join(REPO_ROOT, 'app/events/[id].tsx');

const src = (p: string) => readFileSync(p, 'utf8');

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

/**
 * Slice a statement or expression starting at `marker` and ending at the first
 * terminator that is not nested inside brackets, so an inline arrow or IIFE
 * comes out whole.
 */
function liftExpr(file: string, marker: string, terminator: string): string {
  const s = src(file);
  const start = s.indexOf(marker);
  assert.notEqual(start, -1, `${marker.slice(0, 48)}… is gone from ${file}`);
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === terminator && depth === 0) return s.slice(start, i);
    if (depth < 0) return s.slice(start, i);
  }
  assert.fail(`could not find the end of ${marker.slice(0, 48)}…`);
}

const HELPERS = `${lift(API, 'export function lowestTicketPrice(')}
${lift(API, 'export function isFreeEvent(')}
${lift(API, 'export function eventPriceLabel(')}`.replace(/^export /gm, '');

/** Compile the real helpers together with a real call site, and run it. */
function compile<T>(body: string, name: string): T {
  const js = ts.transpileModule(`${HELPERS}\n${body}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}

// ── Ticket-type fixtures ──────────────────────────────────────────────────────

type TT = { price_pence: number; is_active: boolean };
const tt = (price_pence: number, is_active = true): TT => ({ price_pence, is_active });

/** An event carrying ticket types, shaped the way the screens read it. */
const ev = (types: TT[], price_text: string | null = null) =>
  ({ has_tickets: true, ticket_types: types, price_text });

// ── The real shipped call sites ───────────────────────────────────────────────

/** app/(tabs)/whats-on.tsx — EventCard, the main What's On list row. */
const eventCardLabel = compile<(event: ReturnType<typeof ev>) => string | null>(
  `function eventCardLabel(event) {
     ${liftExpr(WHATSON, 'const priceLabel = (() => {', ';')};
     return priceLabel;
   }`,
  'eventCardLabel',
);

/** app/(tabs)/whats-on.tsx — TicketCard, the "On sale now" rail. */
const ticketCardLabel = compile<(event: ReturnType<typeof ev>) => string | null>(
  `function ticketCardLabel(event) {
     ${liftExpr(WHATSON, 'const priceLabel = event.ticket_types?.length', ';')};
     return priceLabel;
   }`,
  'ticketCardLabel',
);

/** app/events/[id].tsx — the price shown beside the buy CTA. */
const detailLabel = compile<(event: ReturnType<typeof ev>) => string | null>(
  `function detailLabel(event) {
     var ticketTypes = event.ticket_types || [];
     var hasTickets = !!event.has_tickets && ticketTypes.length > 0;
     ${liftExpr(DETAIL, 'const priceLabel     = hasTickets', ';')};
     return priceLabel;
   }`,
  'detailLabel',
);

/** app/(tabs)/whats-on.tsx — the Free-only predicate. Untouched by this fix. */
const freeOnly = compile<(e: ReturnType<typeof ev>) => boolean>(
  `const freeOnly = ${liftExpr(WHATSON, 'e => !e.has_tickets || (e.ticket_types?.length', ')')};`,
  'freeOnly',
);

/** Every public surface that prices an event from its ticket types. */
const SURFACES: Array<[string, (event: ReturnType<typeof ev>) => string | null]> = [
  ["What's On card", eventCardLabel],
  ['On sale now rail', ticketCardLabel],
  ['event detail CTA', detailLabel],
];

const label = (types: TT[]) => eventCardLabel(ev(types));

// ── 1-4. The four labels, by shape ──────────────────────────────────────────

describe('all active tickets free → "Free"', () => {
  test('1. a single free type: [0]', () => {
    assert.equal(label([tt(0)]), 'Free');
  });

  test('2. two free types: [0, 0]', () => {
    assert.equal(label([tt(0), tt(0)]), 'Free');
  });

  for (const [where, render] of SURFACES) {
    test(`${where} agrees`, () => {
      assert.equal(render(ev([tt(0)])), 'Free');
    });
  }
});

describe('some active free, some active paid → "Free + paid tickets"', () => {
  test('3. one of each: [0, 100]', () => {
    assert.equal(label([tt(0), tt(100)]), 'Free + paid tickets');
  });

  test('the paid type may be listed first — order does not decide the label', () => {
    assert.equal(label([tt(100), tt(0)]), 'Free + paid tickets');
  });

  test('a duplicate free type alongside a paid one changes nothing', () => {
    assert.equal(label([tt(0), tt(0), tt(100)]), 'Free + paid tickets');
  });

  for (const [where, render] of SURFACES) {
    test(`${where} says "Free + paid tickets", not just "Free"`, () => {
      assert.equal(render(ev([tt(0), tt(100)])), 'Free + paid tickets');
    });
  }
});

describe('all active tickets paid → "From £X.XX" using the cheapest', () => {
  test('4. two paid types: [100, 250]', () => {
    assert.equal(label([tt(100), tt(250)]), 'From £1.00');
  });

  test('cheapest last — order does not decide the price', () => {
    assert.equal(label([tt(250), tt(100)]), 'From £1.00');
  });

  test('the cheapest ticket wins even when it is not listed first', () => {
    assert.equal(label([tt(999), tt(100), tt(2500)]), 'From £1.00');
  });

  test('pence are not rounded away', () => {
    assert.equal(label([tt(750), tt(1250)]), 'From £7.50');
  });

  for (const [where, render] of SURFACES) {
    test(`${where} agrees on the paid label`, () => {
      assert.equal(render(ev([tt(100), tt(250)])), 'From £1.00');
    });
  }
});

// ── 5 & 6. Inactive types are excluded from either side of the decision ────

describe('inactive types never enter the decision, on either side', () => {
  test('5. an active free type + an inactive paid type → "Free" (the paid one does not count)', () => {
    assert.equal(label([tt(0), tt(100, false)]), 'Free');
  });

  test('6. an inactive free type + an active paid type → the paid-only label (the free one does not count)', () => {
    assert.equal(label([tt(0, false), tt(100)]), 'From £1.00');
  });

  test('both inactive → no active ticket types at all, null (fallback territory)', () => {
    assert.equal(label([tt(0, false), tt(100, false)]), null);
  });
});

// ── 7. Free-only still includes mixed events ────────────────────────────────

describe('the Free-only filter still includes mixed free+paid events — it genuinely offers a free ticket', () => {
  test('7. a mixed event passes the Free-only filter', () => {
    assert.equal(freeOnly(ev([tt(0), tt(100)])), true);
  });

  test('an all-free event still passes it too', () => {
    assert.equal(freeOnly(ev([tt(0)])), true);
  });

  test('a paid-only event is still excluded', () => {
    assert.equal(freeOnly(ev([tt(100), tt(250)])), false);
  });

  test('isFreeEvent() itself — the filter\'s own predicate — is untouched by this label change', () => {
    const isFreeEvent = compile<(t: TT[]) => boolean>('const _x = 0;', 'isFreeEvent');
    assert.equal(isFreeEvent([tt(0), tt(100)]), true);
    assert.equal(isFreeEvent([tt(100), tt(250)]), false);
  });
});

// ── The acceptance event, by name ───────────────────────────────────────────

describe('ZZ TEST — Acceptance Event (TEST — Free Entry £0, TEST — Paid Entry £1)', () => {
  const ZZ_TEST = [tt(0), tt(100)];

  for (const [where, render] of SURFACES) {
    test(`${where} says "Free + paid tickets"`, () => {
      assert.equal(render(ev(ZZ_TEST)), 'Free + paid tickets');
    });
  }

  test('it still appears under Free only', () => {
    assert.equal(freeOnly(ev(ZZ_TEST)), true);
  });
});

// ── 9. Fallbacks that must not have moved ───────────────────────────────────

describe('events without a live ticket type fall back exactly as before', () => {
  test('9a. no ticket types at all falls back to price_text', () => {
    assert.equal(eventCardLabel(ev([], 'Donations welcome')), 'Donations welcome');
  });

  test('9b. no ticket types and no price_text shows nothing', () => {
    assert.equal(eventCardLabel(ev([], null)), null);
  });

  test('9c. every type inactive shows no price rather than a wrong one', () => {
    assert.equal(label([tt(0, false), tt(100, false)]), null);
  });

  test('9d. an event that does not sell tickets is untouched', () => {
    const e = { has_tickets: false, ticket_types: [], price_text: '£5 on the door' };
    assert.equal(eventCardLabel(e as never), '£5 on the door');
  });
});

// ── 8. The standing promise ──────────────────────────────────────────────────

describe('"From £0.00" is not a string this product can produce', () => {
  const SHAPES: TT[][] = [
    [], [tt(0)], [tt(0), tt(0)], [tt(0), tt(100)], [tt(100), tt(0)],
    [tt(100)], [tt(100), tt(250)], [tt(250), tt(100)],
    [tt(0, false)], [tt(0, false), tt(100)], [tt(0), tt(100, false)],
    [tt(0, false), tt(100, false)], [tt(0), tt(0), tt(100)],
  ];

  for (const [where, render] of SURFACES) {
    test(`${where} never prices anything from zero`, () => {
      for (const shape of SHAPES) {
        assert.notEqual(render(ev(shape)), 'From £0.00');
      }
    });
  }

  test('a free ticket is always named, either alone or alongside "paid" — never priced', () => {
    for (const shape of SHAPES) {
      const out = label(shape);
      const hasFree = shape.some(t => t.is_active && t.price_pence === 0);
      const hasPaid = shape.some(t => t.is_active && t.price_pence > 0);
      if (hasFree && hasPaid) assert.equal(out, 'Free + paid tickets', JSON.stringify(shape));
      else if (hasFree) assert.equal(out, 'Free', JSON.stringify(shape));
    }
  });
});

// ── lowestTicketPrice was deliberately left alone ─────────────────────────────

describe('lowestTicketPrice still means cheapest PAID ticket', () => {
  const lowestTicketPrice = compile<(t: TT[]) => number | null>(
    'const _x = 0;', 'lowestTicketPrice',
  );

  test('free types are still excluded from it', () => {
    assert.equal(lowestTicketPrice([tt(0), tt(100)]), 100);
  });

  test('an all-free event has no paid minimum', () => {
    assert.equal(lowestTicketPrice([tt(0), tt(0)]), null);
  });

  test('inactive paid types are excluded', () => {
    assert.equal(lowestTicketPrice([tt(100, false), tt(250)]), 250);
  });
});

// ── eventPriceLabel is built from the two existing predicates, not a third filter ──

describe('eventPriceLabel composes isFreeEvent() and lowestTicketPrice() rather than re-filtering', () => {
  test('the function body reads as hasFree/hasPaid derived from the two existing helpers', () => {
    const fnSrc = lift(API, 'export function eventPriceLabel(');
    assert.match(fnSrc, /isFreeEvent\(types\)/);
    assert.match(fnSrc, /lowestTicketPrice\(types\)/);
    // No separate `types.filter(...)` inside eventPriceLabel itself — the
    // filtering already happened inside the two helpers it calls.
    assert.doesNotMatch(fnSrc, /types\.filter\(/);
  });

  test('lowestTicketPrice() itself is unchanged by this task', () => {
    const fnSrc = lift(API, 'export function lowestTicketPrice(');
    assert.match(fnSrc, /t\.is_active && t\.price_pence > 0/);
    assert.match(fnSrc, /Math\.min\(\.\.\.active\.map\(t => t\.price_pence\)\)/);
  });
});

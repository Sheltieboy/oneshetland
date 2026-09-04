/**
 * event-ticket-selector-max.node.test.ts — the buyer is told before, not after.
 *
 * WHAT WAS WRONG
 *
 * General admission on DEMO — Launch Test Event carries per_order_max = 2. The
 * customer modal happily let the quantity reach 3, and only on Continue did the
 * server answer "Max 2 General admission tickets per order". The refusal was
 * correct and stays exactly where it is; the selector simply should not have
 * offered a number that was always going to be refused.
 *
 * WHAT IS ASSERTED
 *   · the effective ceiling is the LOWER of the seller's per-order limit and
 *     what is actually left, so 1 remaining beats a limit of 2
 *   · unlimited inventory still respects the per-order limit
 *   · the + control stops there and is disabled; − is untouched
 *   · each ticket type is judged on its own numbers
 *   · the server's enforcement is not moved, weakened or duplicated
 *   · nothing claims to limit a person across orders
 *
 * SAFETY
 * Reads source from the web repository and executes the real helper. No
 * database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const DATA = join(WEB, 'lib/events-data.ts');
const MODAL = join(WEB, 'components/events/TicketModal.tsx');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Lift maxPerOrder and its dependency out of the real file and run them.
 * Asserting the file contains "Math.min" would pass on almost any arithmetic.
 */
function maxPerOrder(): (t: { quantity_available: number | null; quantity_sold: number; per_order_max: number }) => number {
  const s = src(DATA);
  const bodyOf = (name: string) => {
    const start = s.indexOf(`export function ${name}(`);
    assert.notEqual(start, -1, `${name} is gone from events-data`);
    const open = s.indexOf('{', s.indexOf('):', start));
    let depth = 0, end = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return s.slice(open + 1, end);
  };
  const remaining = `function ticketTypeRemaining(t) {${bodyOf('ticketTypeRemaining')}}`;
  return new Function('t', `${remaining}\n${bodyOf('maxPerOrder')}`) as never;
}

const T = (per_order_max: number, quantity_available: number | null, quantity_sold = 0) =>
  ({ per_order_max, quantity_available, quantity_sold });

describe('the selector stops where the server would refuse', () => {
  test('THE REPORTED CASE: a limit of 2 cannot become 3', () => {
    const cap = maxPerOrder()(T(2, null));
    assert.equal(cap, 2, `the selector would still allow ${cap}`);
    assert.ok(cap < 3, 'three tickets remain reachable in the selector');
  });

  test('a limit of 10 behaves as 10', () => {
    assert.equal(maxPerOrder()(T(10, null)), 10);
  });

  test('unlimited inventory still respects the per-order limit', () => {
    // quantity_available null means unlimited seats, never an unlimited basket.
    assert.equal(maxPerOrder()(T(2, null, 999)), 2);
  });

  test('1 seat remaining beats a limit of 2', () => {
    assert.equal(maxPerOrder()(T(2, 5, 4)), 1, 'the buyer could pick more than exist');
  });

  test('sold out is 0, so the + never opens', () => {
    assert.equal(maxPerOrder()(T(2, 5, 5)), 0);
    assert.equal(maxPerOrder()(T(2, 5, 99)), 0, 'oversold must not go negative');
  });

  test('the no-negatives guarantee lives in ticketTypeRemaining', () => {
    // maxPerOrder does not re-floor the number, so this is where the promise
    // is kept. Its other callers rely on it too, so pin it here rather than
    // repeating the clamp and pretending either place could be the source.
    const s = src(DATA);
    const i = s.indexOf('export function ticketTypeRemaining(');
    assert.notEqual(i, -1);
    const body = s.slice(i, s.indexOf('}', s.indexOf('return', i)));
    assert.match(body, /Math\.max\(0,/,
      'ticketTypeRemaining stopped clamping at zero, and nothing else does it now');
  });

  test('the lower ceiling always wins, whichever it is', () => {
    const cap = maxPerOrder();
    assert.equal(cap(T(2, 100, 0)), 2, 'the per-order limit is lower');
    assert.equal(cap(T(50, 3, 0)), 3, 'the remaining seats are lower');
  });

  test('a missing or nonsense limit still permits one ticket', () => {
    // per_order_max is NOT NULL with a default, so 0 should be impossible —
    // but a selector that silently offers zero tickets is worse than one that
    // offers one, and the server still has the final word.
    assert.equal(maxPerOrder()(T(0, null)), 1);
  });

  test('each ticket type is judged on its own numbers', () => {
    const cap = maxPerOrder();
    const adult = T(2, null), family = T(5, 4, 2), under5 = T(10, 0, 0);
    assert.equal(cap(adult), 2);
    assert.equal(cap(family), 2, 'family is capped by its 2 remaining, not by adult');
    assert.equal(cap(under5), 0);
  });
});

describe('the control uses that ceiling', () => {
  test('+ cannot exceed it and is disabled there', () => {
    const c = code(MODAL);
    assert.match(c, /const cap = maxPerOrder\(t\)/, 'the modal does not compute a ceiling');
    assert.match(c, /\[t\.id\]: Math\.min\(cap, \(q\[t\.id\] \?\? 0\) \+ 1\)/,
      'the + button still increments without a ceiling');
    assert.match(c, /disabled=\{\(qty\[t\.id\] \?\? 0\) >= cap\}/,
      'the + button is not disabled at the ceiling');
  });

  test('− is untouched', () => {
    const c = code(MODAL);
    assert.match(c, /\[t\.id\]: Math\.max\(0, \(q\[t\.id\] \?\? 0\) - 1\)/);
    assert.match(c, /disabled=\{\(qty\[t\.id\] \?\? 0\) === 0\}/,
      'the − button should still stop at zero, and only there');
  });

  test('the buyer is told the limit before meeting it', () => {
    assert.match(code(MODAL), /Max \{cap\} per order/, 'no helper text');
  });

  test('the modal is given the fields the rule needs', () => {
    const c = code(MODAL);
    for (const f of ['per_order_max', 'quantity_available', 'quantity_sold']) {
      assert.ok(c.includes(f), `the modal's ticket type lacks ${f}`);
    }
    assert.match(code(DATA), /per_order_max,is_active/, 'the public query does not select per_order_max');
  });
});

describe('the server remains the authority', () => {
  test('create-event-ticket-intent still refuses the line itself', () => {
    const c = readFileSync(join(REPO_ROOT, 'supabase/functions/create-event-ticket-intent/index.ts'), 'utf8');
    assert.match(c, /li\.quantity > type\.per_order_max/,
      'the server check moved or went — the UI is convenience, not enforcement');
    assert.match(c, /Max \$\{type\.per_order_max\} \$\{type\.name\} tickets per order/,
      'the refusal message changed');
  });

  test('the rule lives in one place, not copied into the modal', () => {
    const c = code(MODAL);
    assert.ok(!/per_order_max\s*[<>]/.test(c),
      'the modal is doing its own comparison instead of using maxPerOrder');
  });

  test('nothing claims a per-person limit across orders', () => {
    // Nothing counts a buyer's previous orders. Ten separate orders of two
    // remain possible, and no copy may imply otherwise.
    for (const p of [MODAL, DATA]) {
      assert.doesNotMatch(src(p), /per person|per customer|each customer|per buyer/i,
        `${p} promises a per-customer cap that nothing enforces`);
    }
  });
});

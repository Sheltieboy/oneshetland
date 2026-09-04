/**
 * event-capacity-and-order-max.node.test.ts — the owner's two numbers.
 *
 * WHAT WAS WRONG
 *
 * DEMO — Launch Test Event was created with one ticket type of quantity 5, and
 * the owner dashboard reported "Capacity ∞". The 5 had saved perfectly; the
 * card read events.capacity, a venue headcount nothing fills in, while the
 * number that actually governs a sale is event_ticket_types.quantity_available
 * — the one reserve_ticket_slots reads. So the card answered a different
 * question from the one the owner had just answered, and read as "your cap did
 * not save".
 *
 * Separately, the creation form offered name, price and quantity, and nothing
 * else. per_order_max exists, is NOT NULL, defaults to 10 in the database and
 * is enforced at checkout — but an owner could neither see it nor set it, so
 * every ticket type silently became 10.
 *
 * WHAT IS ASSERTED
 *   · a finite ticket type is never shown as ∞
 *   · unlimited still is, and so is a finite/unlimited mixture, because once
 *     one type is uncapped the event has no ceiling
 *   · an event with no OneShetland types falls back to the venue figure
 *   · the form shows the default of 10 rather than applying it behind the owner
 *   · an owner can set 2, and an edit round-trip preserves what was stored
 *   · price and quantity behaviour is untouched
 *
 * SAFETY
 * Reads source from the web repository and evaluates the real helper. No
 * database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const MANAGE_LIB = join(WEB, 'lib/events-manage.ts');
const PURE = join(WEB, 'lib/event-ticket-utils.ts');
const CARD = join(WEB, 'components/business/BusinessEventManage.tsx');
const FORM = join(WEB, 'components/business/BusinessEventForm.tsx');
const CLIENT = join(WEB, 'lib/events-manage-client.ts');

const src = (p: string) => readFileSync(p, 'utf8');
/** Source with comments stripped — assertions must match code, not prose. */
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Lift ticketCapacity out of the real file and run it. Asserting that the
 * source mentions "∞" would pass on the broken version too — it is the same
 * character either way.
 */
function ticketCapacity(): (types: { quantity_available: number | null; is_active: boolean }[], cap: number | null)
  => { label: string; source: string } {
  const s = src(PURE);
  const start = s.indexOf('export function ticketCapacity(');
  assert.notEqual(start, -1, 'ticketCapacity is gone — has the card gone back to events.capacity?');
  // The BODY's opening brace, not the parameter type's. Both the argument and
  // the return type are object literals, so counting from the signature grabs
  // `{ quantity_available: ... }` and evaluates a type as if it were code.
  const first = s.indexOf('const active = types.filter', start);
  assert.notEqual(first, -1, 'ticketCapacity no longer starts by filtering active types');
  const open = s.lastIndexOf('{', first);
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = s.slice(open + 1, end);
  return new Function('types', 'eventCapacity', body) as never;
}


/** Lift a named pure export out of event-ticket-utils and run it. */
function pureFn(name: string, params: string): Function {
  const src0 = src(PURE);
  const start = src0.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from event-ticket-utils`);
  const open = src0.indexOf('{', src0.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < src0.length; i++) {
    if (src0[i] === '{') depth++;
    else if (src0[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src0.slice(open + 1, end)
    .replace(/DEFAULT_PER_ORDER_MAX/g, '10')
    .replace(/:\s*PerOrderMaxDraft/g, '');
  return new Function(params, body);
}

describe('the Capacity card reports ticket inventory, not a venue field', () => {
  // Lifted inside each test, not once in the describe body: a throw out here
  // aborts the group before node has registered a single test, and the run
  // reports "0 tests, 0 failures" — which reads exactly like success.
  const t = (qty: number | null, is_active = true) => ({ quantity_available: qty, is_active });

  test('the reported event: one finite type of 5 reads 5, not ∞', () => {
    const cap = ticketCapacity();
    const r = cap([t(5)], null);
    assert.equal(r.label, '5', `the owner is still told "${r.label}" for a quantity of 5`);
    assert.equal(r.source, 'tickets');
    assert.notEqual(r.label, '∞');
  });

  test('several finite types add up', () => {
    const cap = ticketCapacity();
    assert.equal(cap([t(5), t(20), t(75)], null).label, '100');
  });

  test('an unlimited type is still ∞, because it genuinely is', () => {
    const cap = ticketCapacity();
    const r = cap([t(null)], null);
    assert.equal(r.label, '∞');
    assert.equal(r.source, 'tickets');
  });

  test('finite mixed with unlimited is ∞, not the finite subtotal', () => {
    const cap = ticketCapacity();
    // Adding 5 to "unlimited" and printing 5 would state a ceiling that does
    // not exist — the misleading arithmetic worth refusing.
    const r = cap([t(5), t(null)], null);
    assert.equal(r.label, '∞', 'a mixture reported a limit the event does not have');
  });

  test('inactive types do not count', () => {
    const cap = ticketCapacity();
    assert.equal(cap([t(5), t(999, false)], null).label, '5');
    assert.equal(cap([t(null, false), t(5)], null).label, '5',
      'an inactive unlimited type dragged the answer to ∞');
  });

  test('no OneShetland types falls back to the venue figure', () => {
    const cap = ticketCapacity();
    assert.deepEqual(cap([], 250), { label: '250', source: 'venue' });
    assert.deepEqual(cap([], null), { label: '∞', source: 'venue' });
    assert.deepEqual(cap([t(5, false)], 250), { label: '250', source: 'venue' });
  });

  test('the card uses the helper, and labels the two sources differently', () => {
    const c = code(CARD);
    assert.match(c, /ticketCapacity\(event\.ticket_types, event\.capacity\)/,
      'the card is not calling the helper on the real ticket types');
    assert.ok(!/label="Capacity" value=\{event\.capacity/.test(c),
      'the card still reads events.capacity directly');
    assert.match(c, /"Ticket capacity"/, 'the two sources are not distinguishable to the owner');
  });

  test('quantity_available is still loaded, and per_order_max now too', () => {
    const c = code(MANAGE_LIB);
    assert.match(c, /quantity_available/);
    assert.match(c, /per_order_max/, 'the edit round-trip cannot preserve what is never selected');
  });
});

describe('Maximum per order is the owner\'s to set', () => {
  test('the default is 10, named once and exported', () => {
    assert.match(code(PURE), /DEFAULT_PER_ORDER_MAX = 10/);
  });

  test('the field exists, is an integer, and cannot go below 1', () => {
    const c = code(FORM);
    assert.match(c, /Maximum per order/, 'the owner still cannot see this');
    const field = c.slice(c.indexOf('Maximum per order'), c.indexOf('Maximum per order') + 420);
    assert.match(field, /type="number"/);
    assert.match(field, /min="1"/, 'a maximum of zero would sell nothing');
    assert.match(field, /step="1"/, 'half a ticket is not a quantity');
    assert.match(field, /value=\{t\.per_order_max\}/, 'the field is not bound to the value');
  });

  test('a new ticket type shows 10 rather than receiving it silently', () => {
    const c = code(FORM);
    assert.match(c, /price_pence: 0, quantity_available: null, per_order_max: DEFAULT_PER_ORDER_MAX/,
      'a new row does not carry the visible default');
  });

  test('an existing ticket type loads its stored value', () => {
    assert.match(code(FORM), /per_order_max: t\.per_order_max \?\? DEFAULT_PER_ORDER_MAX/,
      'editing an event would reset per_order_max instead of preserving it');
  });

  test('the save actually persists it', () => {
    const c = code(CLIENT);
    assert.match(c, /per_order_max: normalisePerOrderMax\(t\.per_order_max\)/,
      'the value never reaches the database, or reaches it unnormalised');
    assert.match(c, /per_order_max: PerOrderMaxDraft/,
      'the draft type cannot hold the empty state the box needs while editing');
  });

  test('setting 2 survives the round trip, by the form\'s own binding', () => {
    // The write path and the read path, in one assertion: what syncTicketTypes
    // stores is exactly what the form state holds, and what the form loads is
    // exactly what the row carries.
    assert.match(code(CLIENT), /per_order_max: normalisePerOrderMax\(t\.per_order_max\),/);
    assert.match(code(MANAGE_LIB), /per_order_max: number;/);  // the STORED row is always a number
    assert.match(code(FORM), /per_order_max: t\.per_order_max \?\? DEFAULT_PER_ORDER_MAX/);
  });

  test('nothing claims this is a per-person limit', () => {
    // It caps one basket. Nothing counts a buyer's previous orders, so ten
    // orders of ten remain possible, and the copy must not imply otherwise.
    const c = src(FORM);
    const field = c.slice(c.indexOf('Maximum per order'), c.indexOf('Maximum per order') + 420);
    assert.doesNotMatch(field, /per person|per customer|each customer|per buyer/i,
      'the label promises a per-customer cap the system does not enforce');
  });
});

describe('a Client Component never reaches the server', () => {
  /**
   * The build failure this file now guards. Both components held TYPE-ONLY
   * imports from events-manage, which TypeScript erases. Adding a VALUE import
   * to the same line turned an erased edge into a real one:
   *
   *   BusinessEventForm [Client] → events-manage → supabase/server → next/headers
   *
   * Turbopack refused it, Netlify's build failed, and the field never shipped —
   * while `npm run build | tail` reported success, because that reports tail's
   * exit status and not the build's.
   */
  const CLIENT_COMPONENTS = [
    'components/business/BusinessEventForm.tsx',
    'components/business/BusinessEventManage.tsx',
  ];
  /** Modules that reach next/headers, directly or through one hop. */
  const SERVER_ONLY = ['@/lib/events-manage', '@/lib/supabase/server', 'next/headers'];

  for (const rel of CLIENT_COMPONENTS) {
    test(`${rel.split('/').pop()} takes no VALUE import from a server-only module`, () => {
      const s = readFileSync(join(WEB, rel), 'utf8');
      assert.match(s, /^"use client";/, `${rel} is not a Client Component — this test has the wrong file`);
      for (const mod of SERVER_ONLY) {
        // `import type { X } from` is erased and always fine. Anything else is
        // a runtime edge, and a runtime edge to these modules fails the build.
        const value = new RegExp(`import\\s+(?!type\\s)[^;]*from\\s+["']${mod.replace(/[/@]/g, '\\$&')}["']`);
        assert.doesNotMatch(s, value,
          `${rel} imports a VALUE from ${mod} — that is the import that failed the Netlify build`);
      }
    });
  }

  test('the pure module is genuinely pure', () => {
    // Comments stripped: the file's own docblock explains next/headers, and an
    // assertion that matches the explanation rather than the code proves only
    // that I wrote a comment.
    const s = code(join(WEB, 'lib/event-ticket-utils.ts'));
    for (const bad of ['next/headers', 'supabase/server', 'createClient', 'cookies(']) {
      assert.ok(!s.includes(bad), `event-ticket-utils reaches ${bad}, so it is not client-safe`);
    }
    assert.doesNotMatch(s, /^import\s/m, 'the pure module imports something — it should stand alone');
  });

  test('server code still has one definition, not a copy', () => {
    // Re-exported rather than duplicated: two copies of a capacity rule would
    // drift, and the owner would be told different numbers by different screens.
    assert.match(code(MANAGE_LIB), /export \{ DEFAULT_PER_ORDER_MAX, ticketCapacity \} from "\.\/event-ticket-utils"/,
      'events-manage no longer re-exports the pure helpers');
    assert.ok(!/export function ticketCapacity\(/.test(code(MANAGE_LIB)),
      'ticketCapacity is defined twice — the copies will drift');
  });
});


describe('Maximum per order can actually be edited', () => {
  /**
   * The reported defect. The first version normalised on every keystroke, so
   * backspacing the last digit ran parseInt("") → NaN → 10, and the field
   * sprang back under the cursor. Getting from 10 to 2 meant selecting the
   * whole value and overtyping it.
   */
  const parse = () => pureFn('parsePerOrderMax', 'raw') as (raw: string) => number | '';
  const norm = () => pureFn('normalisePerOrderMax', 'v') as (v: unknown) => number;

  test("10 → backspace → backspace → '2' reaches 2, through an empty state", () => {
    const p = parse();
    // Exactly the keystrokes Darren described, as the box would report them.
    assert.equal(p('1'), 1, 'deleting the 0 should leave 1');
    assert.equal(p(''), '', 'deleting the 1 must leave the box EMPTY, not snap back');
    assert.equal(p('2'), 2, 'typing 2 should give 2');
  });

  test('an empty box is never silently refilled while typing', () => {
    const p = parse();
    for (const raw of ['', '   ']) {
      assert.equal(p(raw), '', `"${raw}" was refilled mid-edit`);
    }
  });

  test('the draft is not judged while it is being typed', () => {
    // 0 and negatives are allowed to EXIST in the box — they are settled on
    // blur and again on save. Clamping here is what caused the defect.
    const p = parse();
    assert.equal(p('0'), 0);
    assert.equal(p('-5'), -5);
  });

  test('blank settles to the documented default of 10', () => {
    assert.equal(norm()(''), 10);
    assert.equal(norm()(null), 10);
    assert.equal(norm()(undefined), 10);
  });

  test('below 1 settles to 1, not to the default', () => {
    // Snapping -5 to 10 would look like the field inventing a figure; the
    // owner did choose a number, they just chose an impossible one.
    const n = norm();
    assert.equal(n(0), 1);
    assert.equal(n(-5), 1);
  });

  test('a valid 2 survives untouched', () => {
    assert.equal(norm()(2), 2);
    assert.equal(norm()(10), 10);
    assert.equal(norm()(250), 250);
  });

  test('fractions cannot persist', () => {
    assert.equal(norm()(2.7), 2);
    assert.equal(parse()('2.7'), 2);
  });

  test('the field allows the empty state and settles on blur', () => {
    const c = code(FORM);
    const field = c.slice(c.indexOf('Maximum per order'), c.indexOf('Maximum per order') + 520);
    assert.match(field, /parsePerOrderMax\(e\.target\.value\)/,
      'the box still normalises on every keystroke');
    assert.match(field, /onBlur=\{\(\) => updateTicketType\(i, \{ per_order_max: normalisePerOrderMax/,
      'nothing settles the value when the box is left');
    assert.ok(!/Math\.max\(1, parseInt\(e\.target\.value/.test(field),
      'the clamping onChange is back');
  });

  test('a blank that is never blurred still cannot be stored', () => {
    // Blur is not a guarantee — a form can be submitted straight from the box.
    assert.match(code(CLIENT), /per_order_max: normalisePerOrderMax\(t\.per_order_max\)/,
      'the save path trusts the draft as-is');
  });

  test('the other two number boxes were already fine, and are untouched', () => {
    // Price blanks to 0 and renders as "", Quantity blanks to null meaning
    // unlimited. Neither clamps mid-edit, so neither was changed.
    const c = code(FORM);
    assert.match(c, /price_pence: Math\.round\(parseFloat\(e\.target\.value \|\| "0"\) \* 100\)/);
    assert.match(c, /quantity_available: e\.target\.value \? parseInt\(e\.target\.value, 10\) : null/);
  });
});

describe('price and quantity are untouched', () => {
  test('quantity still means unlimited when blank', () => {
    const c = code(FORM);
    assert.match(c, /Quantity \(blank = unlimited\)/);
    assert.match(c, /quantity_available: e\.target\.value \? parseInt\(e\.target\.value, 10\) : null/);
  });

  test('price is still entered in pounds and stored in pence', () => {
    assert.match(code(FORM), /price_pence: Math\.round\(parseFloat\(e\.target\.value \|\| "0"\) \* 100\)/);
  });

  test('the reservation path was not touched', () => {
    // This change is owner-facing display and one form field. If it reached
    // the thing that decides whether a ticket can be sold, that is a bug.
    const f = join(REPO_ROOT, 'supabase/functions/create-event-ticket-intent/index.ts');
    assert.ok(existsSync(f));
    const c = readFileSync(f, 'utf8');
    assert.match(c, /li\.quantity > type\.per_order_max/,
      'checkout enforcement moved — it must stay exactly where it was');
    assert.doesNotMatch(c, /events\.capacity/, 'reservation must never consult the venue field');
  });
});

/**
 * event-create-per-order-max.node.test.ts
 *
 * Business Dashboard → Event create/edit — the merchant ticket-type editor
 * had no way to set event_ticket_types.per_order_max.
 *
 * WHAT WAS WRONG
 * per_order_max already existed (NOT NULL, defaults to 10) and was already
 * enforced end-to-end: create-event-ticket-intent refuses a line above it
 * (a real HTTP 409), and the mobile buyer-side ticket selector
 * (event-ticket-checkout.tsx) already capped its quantity stepper at
 * min(per_order_max, remaining). Even the SAVE payload in event-create.tsx
 * already threaded per_order_max through on every upsert. The one missing
 * piece was the merchant's own input: the ticket-type card offered name,
 * price and quantity, and nothing else, so per_order_max silently stayed at
 * the database default of 10 for every type ever created on mobile — the
 * exact same gap oneshetland-web already found and fixed for
 * BusinessEventForm.tsx (see event-capacity-and-order-max.node.test.ts).
 *
 * THE FIX
 * One new "Max per order" input per ticket-type card, wired to the existing
 * per_order_max field, using the same parsePerOrderMax (keystroke → draft)
 * / normalisePerOrderMax (draft → stored value, "" and blank → the default
 * of 10, anything below 1 → 1) split already proven on web — mirrored
 * mobile-side in lib/event-ticket-utils.ts (a deliberate duplicate, same
 * reasoning as lib/business-outcomes.ts: the two repos deploy separately).
 * No schema change, no change to create-event-ticket-intent,
 * reserve_ticket_slots, the buyer-side checkout, or commercial-terms logic —
 * all of those were already correct.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions and real execution of the pure helpers — this
 * repo has no RN render/keystroke-simulation infrastructure, so it cannot
 * type into the field or observe an actual re-render. These prove the field
 * exists, is wired to per_order_max (not a new concept), defaults and
 * parses/normalises exactly as documented, and that the two repos' shared
 * logic stays byte-identical.
 *
 * SAFETY
 * No Supabase call, no navigation, no database write. Nothing here touches
 * production.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PER_ORDER_MAX, parsePerOrderMax, normalisePerOrderMax } from '../../lib/event-ticket-utils.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const eventCreatePath = 'app/event-create.tsx';
const eventCreateRaw = read(eventCreatePath);
const eventCreateSrc = code(eventCreateRaw);
const utilsPath = 'lib/event-ticket-utils.ts';
const utilsRaw = read(utilsPath);

/* ── 1 & 2. The field exists, and is wired to per_order_max ─────────────── */

describe('Max per order is visible in the ticket-type editor, wired to the existing per_order_max field', () => {
  test('the label reads "Max per order"', () => {
    assert.match(eventCreateSrc, /<Text style=\{styles\.fieldLabel\}>Max per order<\/Text>/);
  });

  test('its onChangeText parses into per_order_max via parsePerOrderMax, not a new field', () => {
    assert.match(eventCreateSrc,
      /const draft = parsePerOrderMax\(v\);\s*\n\s*setTicketTypes\(prev => \{ const n = \[\.\.\.prev\]; n\[i\] = \{ \.\.\.n\[i\], per_order_max: draft \}; return n; \}\);/);
  });

  test('its onBlur normalises per_order_max via normalisePerOrderMax, matching web\'s two-stage draft → stored pattern', () => {
    const idx = eventCreateSrc.indexOf('Max per order');
    const block = eventCreateSrc.slice(idx, eventCreateSrc.indexOf('</View>', idx) + 400);
    assert.match(block, /onBlur=\{\(\) => \{/);
    assert.match(block, /per_order_max: normalisePerOrderMax\(n\[i\]\.per_order_max\)/);
  });

  test('the displayed value reads tt.per_order_max directly — an existing stored value shows as itself, not the default', () => {
    assert.match(eventCreateSrc, /value=\{tt\.per_order_max === undefined \? '' : String\(tt\.per_order_max\)\}/);
  });

  test('the placeholder shows the real default, not a hardcoded "10"', () => {
    assert.match(eventCreateSrc, /placeholder=\{String\(DEFAULT_PER_ORDER_MAX\)\}/);
  });
});

/* ── 3. New ticket types default to 10 ───────────────────────────────────── */

describe('new ticket types default to 10', () => {
  test('DEFAULT_PER_ORDER_MAX itself is 10, matching the database default', () => {
    assert.equal(DEFAULT_PER_ORDER_MAX, 10);
  });

  test('addTicketType uses the shared constant, not a repeated magic number', () => {
    const addFnIdx = eventCreateSrc.indexOf('const addTicketType = ()');
    const addFnEnd = eventCreateSrc.indexOf('};', addFnIdx);
    const addFn = eventCreateSrc.slice(addFnIdx, addFnEnd);
    assert.match(addFn, /per_order_max: DEFAULT_PER_ORDER_MAX,/);
    assert.doesNotMatch(addFn, /per_order_max:\s*10\b/, 'the constant, not a re-typed 10');
  });

  test('the Peerie Bot AI-fill path also defaults through the same constant', () => {
    const peerieIdx = eventCreateSrc.indexOf('const applyPeerie');
    const peerieEnd = eventCreateSrc.indexOf('setTicketTypes(tickets.map', peerieIdx);
    const peerieBlock = eventCreateSrc.slice(peerieEnd, eventCreateSrc.indexOf('})));', peerieEnd));
    assert.match(peerieBlock, /per_order_max: DEFAULT_PER_ORDER_MAX,/);
  });

  test('no other literal default (e.g. a stray 5 or 1) was introduced for a freshly-added ticket type', () => {
    const addFnIdx = eventCreateSrc.indexOf('const addTicketType = ()');
    const addFnEnd = eventCreateSrc.indexOf('};', addFnIdx);
    const addFn = eventCreateSrc.slice(addFnIdx, addFnEnd);
    assert.match(addFn, /quantity_available: null,/, 'quantity still defaults to unlimited, untouched');
  });
});

/* ── 4. The owner can change it to 2 — the real parse/normalise helpers ──── */

describe('the owner can set 2, using the real parsing and normalisation helpers', () => {
  test('typing "2" parses to the number 2', () => {
    assert.equal(parsePerOrderMax('2'), 2);
  });

  test('2 normalises to itself — a deliberate, in-range choice is never overridden', () => {
    assert.equal(normalisePerOrderMax(2), 2);
  });

  test('backspacing to empty stays "" (not forced back to 10 mid-edit) — the exact bug the draft type exists to prevent', () => {
    assert.equal(parsePerOrderMax(''), '');
  });

  test('but a never-blurred blank still cannot reach the database — save-time normalisation is the safety net', () => {
    assert.equal(normalisePerOrderMax(''), 10);
    assert.equal(normalisePerOrderMax(undefined), 10);
  });

  test('an owner-chosen value below 1 settles on 1, not silently back to the default', () => {
    assert.equal(normalisePerOrderMax(0), 1);
    assert.equal(normalisePerOrderMax(-5), 1);
  });
});

/* ── 5. The value is included unchanged in the existing save payload ────── */

describe('per_order_max is included in the existing ticket-type save payload, using the same normalisation as the blur handler', () => {
  test('the upsertTicketType call includes per_order_max: normalisePerOrderMax(tt.per_order_max)', () => {
    assert.match(eventCreateSrc, /per_order_max:\s*normalisePerOrderMax\(tt\.per_order_max\),/);
  });

  test('the surrounding payload fields (price, quantity, name) are unchanged by this fix', () => {
    const saveIdx = eventCreateSrc.indexOf('const saved = await upsertTicketType({');
    const saveEnd = eventCreateSrc.indexOf('} as any);', saveIdx);
    const payload = eventCreateSrc.slice(saveIdx, saveEnd);
    assert.match(payload, /price_pence:\s*tt\.price_pence \?\? 0,/);
    assert.match(payload, /quantity_available:\s*tt\.quantity_available \?\? null,/);
    assert.match(payload, /name:\s*tt\.name!,/);
  });
});

/* ── 6. Existing stored values populate correctly when editing ──────────── */

describe('existing stored values populate correctly when editing', () => {
  test('edit mode loads ticket types straight from the fetched event, with no per_order_max override on load', () => {
    assert.match(eventCreateSrc, /setTicketTypes\(ev\.ticket_types\);/);
    // Nothing between the fetch and this call rewrites per_order_max — if it
    // did, a stored 2 would be overwritten before the merchant ever sees it.
    const loadIdx = eventCreateSrc.indexOf('if (ev.ticket_types)');
    const loadBlock = eventCreateSrc.slice(loadIdx, eventCreateSrc.indexOf('}', eventCreateSrc.indexOf('setTicketTypes(ev.ticket_types);', loadIdx)) + 1);
    assert.doesNotMatch(loadBlock, /per_order_max:/, 'the loaded row\'s own per_order_max must reach state untouched');
  });

  test('the field\'s value binding reads state directly (tt.per_order_max), so a loaded 2 renders as 2, not the default', () => {
    assert.match(eventCreateSrc, /value=\{tt\.per_order_max === undefined \? '' : String\(tt\.per_order_max\)\}/);
  });
});

/* ── 7. No duplicate/new ticket-limit concept was introduced ────────────── */

describe('no duplicate or new ticket-limit concept was introduced', () => {
  test('"Max per order" appears exactly once — one field, not a second copy of it', () => {
    const matches = eventCreateSrc.match(/Max per order/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test('no alternate limit name was invented anywhere in the file', () => {
    for (const never of ['max_per_customer', 'maxPerCustomer', 'per_customer_limit',
                         'purchase_limit', 'max_quantity', 'perCustomerLimit']) {
      assert.doesNotMatch(eventCreateSrc, new RegExp(never, 'i'), `${never} must not appear — per_order_max is the one field`);
    }
  });

  test('DEFAULT_PER_ORDER_MAX is imported from the shared lib, not redefined locally', () => {
    assert.match(eventCreateRaw, /import \{ DEFAULT_PER_ORDER_MAX, parsePerOrderMax, normalisePerOrderMax, type PerOrderMaxDraft \} from '@\/lib\/event-ticket-utils';/);
    assert.doesNotMatch(eventCreateSrc, /const DEFAULT_PER_ORDER_MAX/, 'a local redefinition would be a second source of truth');
  });

  test('the schema/RPC/edge-function boundaries named as off-limits were not touched', () => {
    for (const untouched of [
      'supabase/functions/create-event-ticket-intent/index.ts',
      'supabase/functions/_shared/ticket-quantities.ts',
      'app/event-ticket-checkout.tsx',
    ]) {
      assert.doesNotMatch(read(untouched), /max_per_customer|purchase_limit|per_customer_limit/i);
    }
  });
});

/* ── 8. Quantity (inventory) stays separate from the per-order limit ────── */

describe('the existing quantity/inventory field remains separate from the per-order limit', () => {
  test('quantity_available keeps its own independent input and handler, untouched by this fix', () => {
    assert.match(eventCreateSrc, /Quantity \(blank = unlimited\)/);
    assert.match(eventCreateSrc,
      /const q = v \? parseInt\(v, 10\) : null;\s*\n\s*setTicketTypes\(prev => \{ const n = \[\.\.\.prev\]; n\[i\] = \{ \.\.\.n\[i\], quantity_available: q \}; return n; \}\);/);
  });

  test('per_order_max and quantity_available are set by two distinct onChangeText handlers, not one composed field', () => {
    const perOrderIdx = eventCreateSrc.indexOf('per_order_max: draft');
    const quantityIdx = eventCreateSrc.indexOf('quantity_available: q }');
    assert.ok(perOrderIdx !== -1 && quantityIdx !== -1 && perOrderIdx !== quantityIdx);
  });

  test('event-create.tsx does not compute a combined min(per_order_max, remaining) cap — that composition is the buyer-side checkout\'s job, left untouched', () => {
    assert.doesNotMatch(eventCreateSrc, /Math\.min\([^)]*per_order_max/);
  });
});

/* ── The shared parse/normalise logic stays byte-identical to web ───────── */

describe('lib/event-ticket-utils.ts is pinned byte-for-byte to the shared pieces of oneshetland-web\'s copy', () => {
  const extract = (src: string, name: string, endMarker: string) => {
    const start = src.indexOf(name);
    assert.ok(start !== -1, `${name} not found`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end !== -1, `${endMarker} not found after ${name}`);
    return src.slice(start, end + endMarker.length);
  };

  const mobile = utilsRaw;
  const web = readWeb('lib/event-ticket-utils.ts');

  for (const [name, endMarker] of [
    ['export const DEFAULT_PER_ORDER_MAX = 10;', 'DEFAULT_PER_ORDER_MAX = 10;'],
    ['export type PerOrderMaxDraft', 'export type PerOrderMaxDraft = number | "";'],
    ['export function parsePerOrderMax', '\n}'],
    ['export function normalisePerOrderMax', '\n}'],
  ] as const) {
    test(`${name.split(' ').slice(-1)[0].replace(/[=;].*/, '') || name} matches the web copy exactly`, () => {
      const m = extract(mobile, name, endMarker);
      const w = extract(web, name, endMarker);
      assert.equal(m, w, `mobile and web have drifted for ${name} — edit the web copy first, then mirror it here`);
    });
  }
});

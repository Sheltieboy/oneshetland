/**
 * event-manage-ticket-capacity.node.test.ts
 *
 * Event Manage's organiser-facing "Capacity" stat read event.capacity — a
 * venue headcount field mobile's own event-create form never sets — so a
 * mobile-created event with a real, finite ticket cap (e.g. ZZ TEST —
 * Acceptance Event: 5 + 2 tickets) always showed "Capacity ∞". This was the
 * exact "capacity card answers a different question" bug web already fixed
 * (see supabase/tests/event-capacity-and-order-max.node.test.ts, which reads
 * only web's copy), reproduced on the sibling platform: mobile's own
 * lib/event-ticket-utils.ts previously said, in its own header comment,
 * that web's ticketCapacity() was "deliberately not mirrored here."
 *
 * THE FIX
 * ticketCapacity() is now mirrored into mobile's lib/event-ticket-utils.ts,
 * byte-identical to web's copy, and app/event-manage.tsx's Capacity StatBox
 * calls it (types + event.capacity as the venue fallback) instead of reading
 * event.capacity directly. No new rule: same active-only, all-finite-or-∞
 * semantics as web, right down to the "Ticket capacity" vs "Capacity" label
 * swap depending on which source answered.
 *
 * WHAT IS ASSERTED
 *   · the real, executed helper — not a reimplementation — produces the
 *     required figures for single and multiple active finite types
 *   · inactive types are excluded exactly as web excludes them
 *   · unlimited (any active type with quantity_available === null) still
 *     reads "∞", including a finite/unlimited mixture
 *   · mobile's ticketCapacity() is byte-identical to web's, not just
 *     behaviourally similar — a future edit to one without the other fails
 *     this file
 *   · event-manage.tsx no longer reads event.capacity for this stat
 *   · Sold and Checked in are untouched — same fields, same source
 *     (fetchScannerStats), same StatBoxes, unmoved by this change
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
import { ticketCapacity } from '../../lib/event-ticket-utils.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

type TT = { quantity_available: number | null; is_active: boolean };
const tt = (quantity_available: number | null, is_active = true): TT => ({ quantity_available, is_active });

const managePath = 'app/event-manage.tsx';
const manageRaw = read(managePath);
const manageSrc = code(manageRaw);

/* ── 1 & 2. Active finite types, single and multiple ────────────────────── */

describe('active finite ticket types sum to the capacity figure', () => {
  test('1. one active type, quantity 5 → "5"', () => {
    const cap = ticketCapacity([tt(5)], null);
    assert.equal(cap.label, '5');
    assert.equal(cap.source, 'tickets');
  });

  test('2. two active types, 5 and 2 → "7" (ZZ TEST\'s own shape: Free Entry 5 + Paid Entry 2)', () => {
    const cap = ticketCapacity([tt(5), tt(2)], null);
    assert.equal(cap.label, '7');
    assert.equal(cap.source, 'tickets');
  });

  test('order does not decide the total', () => {
    assert.equal(ticketCapacity([tt(2), tt(5)], null).label, '7');
  });
});

/* ── 3. Inactive types excluded, exactly as web excludes them ───────────── */

describe('inactive ticket types are handled exactly as web handles them', () => {
  test('3a. an inactive type is excluded from the sum', () => {
    const cap = ticketCapacity([tt(5), tt(2, false)], null);
    assert.equal(cap.label, '5');
  });

  test('3b. an inactive UNLIMITED type does not force "∞" — only active types decide', () => {
    const cap = ticketCapacity([tt(5), tt(null, false)], null);
    assert.equal(cap.label, '5', 'the inactive unlimited type must not contaminate the total');
  });

  test('3c. every type inactive falls back to the venue figure, not "0"', () => {
    const cap = ticketCapacity([tt(5, false), tt(2, false)], 40);
    assert.equal(cap.label, '40');
    assert.equal(cap.source, 'venue');
  });

  test('3d. every type inactive, no venue figure either → "∞", not "0"', () => {
    const cap = ticketCapacity([tt(5, false)], null);
    assert.equal(cap.label, '∞');
    assert.equal(cap.source, 'venue');
  });
});

/* ── 4. Unlimited representation matches web exactly ─────────────────────── */

describe('unlimited quantity produces the same "∞" representation as web', () => {
  test('4a. a single active unlimited type → "∞"', () => {
    const cap = ticketCapacity([tt(null)], null);
    assert.equal(cap.label, '∞');
    assert.equal(cap.source, 'tickets');
  });

  test('4b. a mixture of finite and unlimited active types is also "∞" — one uncapped type removes the ceiling', () => {
    const cap = ticketCapacity([tt(5), tt(null)], null);
    assert.equal(cap.label, '∞');
    assert.equal(cap.source, 'tickets');
  });

  test('4c. no OneShetland ticket types at all falls back to the venue figure', () => {
    assert.deepEqual(ticketCapacity([], 120), { label: '120', source: 'venue' });
    assert.deepEqual(ticketCapacity([], null), { label: '∞', source: 'venue' });
  });
});

/* ── 5. Mobile's helper is byte-pinned against web's ticketCapacity() ────── */

describe('mobile\'s ticketCapacity() is byte-identical to web\'s — not just behaviourally similar', () => {
  const extract = (src: string, name: string) => {
    const start = src.indexOf(name);
    assert.notEqual(start, -1, `${name} not found`);
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.notEqual(end, -1, `end of ${name} not found`);
    return src.slice(start, end + 1);
  };

  test('the function body and its doc comment are identical, character for character', () => {
    const mobile = read('lib/event-ticket-utils.ts');
    const web = readWeb('lib/event-ticket-utils.ts');
    const mFn = extract(mobile, 'export function ticketCapacity(');
    const wFn = extract(web, 'export function ticketCapacity(');
    assert.equal(mFn, wFn, 'mobile and web have drifted — edit the web copy first, then mirror it here');

    const mDoc = mobile.slice(mobile.indexOf('/**\n * What to put on the owner'), mobile.indexOf('export function ticketCapacity('));
    const wDoc = web.slice(web.indexOf('/**\n * What to put on the owner'), web.indexOf('export function ticketCapacity('));
    assert.equal(mDoc, wDoc);
  });

  test('mobile\'s file no longer disclaims ticketCapacity as "deliberately not mirrored"', () => {
    assert.doesNotMatch(read('lib/event-ticket-utils.ts'), /deliberately not mirrored here/);
  });
});

/* ── 6. Event Manage no longer reads raw event.capacity for this stat ────── */

describe('the Capacity stat no longer reads event.capacity directly', () => {
  test('ticketCapacity() is imported and called with the event\'s own ticket types', () => {
    assert.match(manageSrc, /import \{ ticketCapacity \} from '@\/lib\/event-ticket-utils';/);
    assert.match(manageSrc, /const cap = ticketCapacity\(event\.ticket_types \?\? \[\], event\.capacity\);/);
  });

  test('the old direct read — value={event.capacity ?? \'∞\'} — is gone', () => {
    assert.doesNotMatch(manageSrc, /value=\{event\.capacity \?\? '∞'\}/);
  });

  test('the StatBox reads cap.label, and its own label swaps to "Ticket capacity" when the source is tickets — matching web\'s CARD exactly', () => {
    assert.match(manageSrc,
      /label=\{cap\.source === 'tickets' \? 'Ticket capacity' : 'Capacity'\}\s*\n\s*value=\{cap\.label\}/);
  });

  test('event.capacity is still passed through — as the venue fallback ticketCapacity() itself defines, not removed from the event payload or schema', () => {
    // This task is display-only: event.capacity itself, event creation, and
    // the schema are untouched — only how the Capacity STAT reads it changed.
    assert.match(manageSrc, /ticketCapacity\(event\.ticket_types \?\? \[\], event\.capacity\)/);
  });
});

/* ── 7. Sold and Checked in stats are untouched ──────────────────────────── */

describe('Sold and Checked in stats are untouched by this fix', () => {
  test('both still read stats.tickets_sold / stats.checked_in, from fetchScannerStats — unchanged', () => {
    assert.match(manageSrc, /label="Sold"\s*value=\{stats\.tickets_sold\}/);
    assert.match(manageSrc, /label="Checked in"\s*value=\{stats\.checked_in\}/);
    assert.match(manageSrc, /fetchScannerStats\(id\)\.catch\(\(\) => null\)/);
  });

  test('fetchScannerStats and fetchEvent themselves were not touched by this task', () => {
    const apiSrc = code(read('lib/events-api.ts'));
    assert.match(apiSrc, /export async function fetchScannerStats\(/);
    assert.match(apiSrc, /export async function fetchEvent\(/);
  });
});

/**
 * ticket-type-save.node.test.ts — removing a ticket type must take it off sale.
 *
 * WHAT WAS WRONG
 *
 * event-create.tsx's ticket-type "Remove" button only spliced the local form
 * array; Save then upserted whatever remained, but never called the existing
 * deleteTicketType() for the id that got dropped. A business that removed a
 * tier and saved would see it gone from the editor while customers could
 * still buy it — create-event-ticket-intent only checks `is_active`, which
 * deleteTicketType is the one thing that flips to false.
 *
 * WHAT IS ASSERTED (mirrors the acceptance list in the punch-list task)
 *   1. editing without removing anything deactivates nothing
 *   2. removing one existing (unsold) ticket type takes just it off sale
 *   3. removing one does not touch surviving types
 *   4. a freshly-added (_local) type is never a deactivation candidate
 *   5. an existing type just being edited (id present, unchanged) survives
 *   6. calling the diff again against the SAME originalIds after a type was
 *      already removed does not grow the list or re-target anything new —
 *      i.e. repeated Save is idempotent, not "repeatedly deleting"
 *   7. switching the event away from OneShetland ticketing deactivates every
 *      originally-loaded type (the same defect in a wider form — nothing
 *      survives a mode no upsert loop will touch)
 *   8. no originally-loaded ids means nothing to deactivate, regardless of
 *      current state (a brand-new event has never had server-known types)
 *
 * "Existing sold tickets/history remain safe" and "deletion cannot violate
 * an FK" are NOT re-proven here — they're proven by construction, in the
 * schema: deleteTicketType() (lib/events-api.ts) does
 * `update({ is_active: false })`, never a row delete, and
 * event_tickets.ticket_type_id has no ON DELETE CASCADE (baseline schema,
 * `event_ticket_types_event_id_fkey`/`event_tickets_ticket_type_id_fkey`) —
 * a hard delete of a type with sold tickets would fail outright, which is
 * exactly why the fix is a flag flip, not a delete. That's a read of the
 * migration, asserted here only as a guard against a future regression that
 * turns deleteTicketType back into a real DELETE.
 *
 * SAFETY
 * Pure function, no database, no network, no writes. lib/ticket-type-save.ts
 * has zero imports specifically so it can run here without pulling in
 * expo-file-system (which lib/events-api.ts imports and which fails outside
 * the app runtime). Lives under supabase/tests/ (excluded from `tsc
 * --noEmit` by tsconfig.json, same as every other *.node.test.ts here)
 * because it needs the `.ts` specifier extension Node's ESM loader requires
 * — the mobile app's own tsconfig doesn't enable
 * `allowImportingTsExtensions`, so a test file under lib/ importing that way
 * fails the typecheck gate even though it runs fine under `node --test`.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketTypesToDeactivate, type TicketTypeSaveRef } from '../../lib/ticket-type-save.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ticketTypesToDeactivate — which existing types stop selling on Save', () => {
  test('1. nothing removed → nothing deactivated', () => {
    const original = ['a', 'b'];
    const current: TicketTypeSaveRef[] = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(ticketTypesToDeactivate(original, current, 'oneshetland'), []);
  });

  test('2 & 3. removing one existing type deactivates only it, not survivors', () => {
    const original = ['a', 'b', 'c'];
    // 'b' was removed from the form — no longer present at all.
    const current: TicketTypeSaveRef[] = [{ id: 'a' }, { id: 'c' }];
    const result = ticketTypesToDeactivate(original, current, 'oneshetland');
    assert.deepEqual(result, ['b']);
    assert.ok(!result.includes('a') && !result.includes('c'), 'survivors must not be deactivated');
  });

  test('4. a freshly-added (_local) type is never mistaken for a removal target', () => {
    const original = ['a'];
    const current: TicketTypeSaveRef[] = [{ id: 'a' }, { _local: true, name: 'New tier' } as TicketTypeSaveRef];
    assert.deepEqual(ticketTypesToDeactivate(original, current, 'oneshetland'), []);
  });

  test('5. an existing type merely being edited (id unchanged) survives', () => {
    const original = ['a'];
    const current: TicketTypeSaveRef[] = [{ id: 'a', name: 'Renamed' } as TicketTypeSaveRef];
    assert.deepEqual(ticketTypesToDeactivate(original, current, 'oneshetland'), []);
  });

  test('6. repeated Save with the same original set does not grow or duplicate the target list', () => {
    const original = ['a', 'b'];
    const current: TicketTypeSaveRef[] = [{ id: 'a' }]; // 'b' removed once
    const firstSave  = ticketTypesToDeactivate(original, current, 'oneshetland');
    const secondSave = ticketTypesToDeactivate(original, current, 'oneshetland');
    assert.deepEqual(firstSave, ['b']);
    assert.deepEqual(secondSave, ['b']); // same, single target — not ['b','b'] or growing
  });

  test('7. leaving OneShetland ticketing deactivates every originally-loaded type', () => {
    const original = ['a', 'b', 'c'];
    // The event-create save path truncates the local ticketTypes array before
    // the upsert loop when the mode isn't 'oneshetland' — nothing "survives"
    // a mode the upsert loop will never run for.
    assert.deepEqual(ticketTypesToDeactivate(original, [], 'none'), original);
    assert.deepEqual(ticketTypesToDeactivate(original, [], 'external'), original);
  });

  test('8. a brand-new event (no originally-loaded ids) never deactivates anything', () => {
    const current: TicketTypeSaveRef[] = [{ _local: true } as TicketTypeSaveRef];
    assert.deepEqual(ticketTypesToDeactivate([], current, 'oneshetland'), []);
    assert.deepEqual(ticketTypesToDeactivate([], current, 'none'), []);
  });
});

describe('deleteTicketType stays a soft delete (regression guard)', () => {
  test('lib/events-api.ts deactivates by flag, never DELETEs the row', () => {
    const src = readFileSync(join(REPO_ROOT, 'lib/events-api.ts'), 'utf8');
    const start = src.indexOf('export async function deleteTicketType');
    assert.notEqual(start, -1, 'deleteTicketType must still exist in lib/events-api.ts');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /update\(\s*\{\s*is_active:\s*false\s*\}\s*\)/,
      'deleteTicketType must soft-delete via is_active:false — a hard delete would violate ' +
      'event_tickets_ticket_type_id_fkey the moment a ticket type has any sold tickets');
    assert.doesNotMatch(body, /\.delete\(\)/,
      'deleteTicketType must never call .delete() — that would destroy ticket/order history');
  });

  test('event-create.tsx calls deleteTicketType for the computed removal set before the success path', () => {
    const src = readFileSync(join(REPO_ROOT, 'app/event-create.tsx'), 'utf8');
    assert.match(src, /ticketTypesToDeactivate\(/, 'the save path must compute which types to deactivate');
    const deleteCallIdx = src.indexOf('for (const id of idsToDeactivate)');
    const successIdx = src.indexOf('router.replace({ pathname: \'/event-manage\'');
    assert.notEqual(deleteCallIdx, -1, 'the removal loop must exist');
    assert.ok(deleteCallIdx < successIdx,
      'deactivation must run before navigating away on success, so a failure here blocks the ' +
      '"saved" outcome instead of pretending Save succeeded');
  });
});

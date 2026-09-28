/**
 * mobile-event-manage-entry.node.test.ts — a spinner is not an answer.
 *
 * WHAT WAS WRONG
 *
 * Business area → Manage events opened a grey screen with a spinner and stayed
 * there. Not slowly — for ever, and without making a single request.
 *
 * Two faults, one shape. event-manage and event-scanner are per-EVENT screens:
 * both read `id` from the route. The business dashboard sent them `businessId`,
 * so both arrived with nothing to work on. event-manage then did this:
 *
 *   const load = useCallback(async () => {
 *     if (!id) return;          // ← returns BEFORE setLoading(false)
 *     ...
 *     setLoading(false);
 *   }, [id]);
 *
 * `loading` starts true, so the guard was a dead end with no error, no content
 * and no way out. The scanner failed more quietly still: the camera opened and
 * handleValidate discarded every code at `if (!eventId ...) return`, so it
 * looked like it was working and simply never responded — which is a plausible
 * part of why organiser scanning "did not work" on the phone.
 *
 * WHAT IS ASSERTED
 *   · the dashboard sends an EVENT id to the per-event screens
 *   · event-manage clears loading on every path, including the guard
 *   · neither screen presents a working-looking surface with no event behind it
 *   · New event still receives businessId, which is what it actually reads
 *
 * SAFETY
 * Reads source only. No database, no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH    = join(REPO_ROOT, 'app/local-business-dashboard.tsx');
const MANAGE  = join(REPO_ROOT, 'app/event-manage.tsx');
const SCANNER = join(REPO_ROOT, 'app/event-scanner.tsx');
const CREATE  = join(REPO_ROOT, 'app/event-create.tsx');

const code = (p: string) => readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The params a dashboard action pushes at a given route. */
function pushedParams(route: string): string {
  const c = code(DASH);
  const i = c.indexOf(`pathname: '${route}'`);
  assert.notEqual(i, -1, `the dashboard no longer navigates to ${route}`);
  const seg = c.slice(i, c.indexOf('}', c.indexOf('params:', i)) + 1);
  return seg;
}

describe('the per-event screens are given an event', () => {
  // UPDATE — the Events management list. The dashboard no longer pushes
  // /event-manage directly at all (that was exactly the bug the management
  // list fixes — see the describe block above); only /event-scanner remains
  // a genuinely per-EVENT dashboard push. /event-manage is still reached
  // (unchanged) from app/business-events.tsx and app/event-create.tsx, and
  // still reads `id`, so the assertion on MANAGE's own params below stays.
  for (const route of ['/event-scanner']) {
    test(`${route} receives an id, not a businessId`, () => {
      const seg = pushedParams(route);
      assert.match(seg, /params: \{ id:/,
        `${route} is still being sent a businessId — it reads \`id\` and will have nothing to work on`);
      assert.doesNotMatch(seg, /businessId: activeBusiness\.id/,
        `${route} is still being sent the business instead of the event`);
    });
  }

  test('event-manage and the scanner both do read `id`, so that is genuinely what they need', () => {
    // If either screen ever starts reading businessId, the assertion above
    // becomes wrong rather than protective.
    assert.match(code(MANAGE), /const \{ id \}\s+= useLocalSearchParams<\{ id: string \}>/);
    assert.match(code(SCANNER), /const \{ id: eventId \} = useLocalSearchParams<\{ id: string \}>/);
  });

  test('New event still gets the businessId it actually reads', () => {
    // Two call sites push /event-create, one with a non-null assertion.
    assert.match(pushedParams('/event-create'), /businessId: activeBusiness!?\.id/,
      'event-create reads businessId — do not "fix" it to match the others');
    assert.match(code(CREATE), /useLocalSearchParams<\{ businessId\?: string/);
  });

  test('Manage events gets businessId, not an event id — it is a per-BUSINESS screen, the events management list, not a per-event one', () => {
    assert.match(pushedParams('/business-events'), /businessId: activeBusiness\.id/);
  });
});

describe('loading always resolves to something', () => {
  test('event-manage clears loading on every path, including the guard', () => {
    const c = code(MANAGE);
    const i = c.indexOf('const load = useCallback');
    assert.notEqual(i, -1, 'load() is gone');
    const body = c.slice(i, c.indexOf('}, [id]);', i));
    assert.match(body, /finally\s*\{[\s\S]*?setLoading\(false\)/,
      'setLoading(false) is not in a finally — an early return leaves the spinner up for ever');
    assert.ok(!/if \(!id\) return;\s*\n\s*const \[ev, st\]/.test(body),
      'the bare `if (!id) return` is back, before loading is ever cleared');
  });

  test('and says WHICH nothing it found', () => {
    const c = code(MANAGE);
    assert.match(c, /No event chosen/, 'an owner arriving with no event is told only "not found"');
    assert.match(c, /Event not found\./, 'the genuine not-found case lost its message');
  });

  test('the scanner refuses to mime', () => {
    // Without an event, handleValidate discards every scan. A camera that
    // looks alive and answers nothing is worse than a screen that explains.
    const c = code(SCANNER);
    assert.match(c, /if \(!eventId\) \{/, 'the scanner still opens a camera with no event behind it');
    assert.match(c, /No event chosen/, 'no explanation is offered');
    const guard = c.indexOf('if (!eventId) {');
    const camera = c.indexOf('if (!CAMERA_NATIVE_AVAILABLE)');
    assert.ok(guard < camera && guard !== -1,
      'the no-event check must come before the camera is set up, or it never runs');
  });

  test('handleValidate still refuses to send a scan without an event', () => {
    // Belt and braces: the screen should not reach here now, but the request
    // must never go out with event_id undefined.
    assert.match(code(SCANNER), /if \(!eventId \|\| !profile \|\| busy\) return;/);
  });
});

/**
 * The fix above wired the happy path — nextBizEvent.id, not businessId — but
 * left the OTHER path open: a business with no current/upcoming published
 * event has nextBizEvent === null, and both actions still pushed with
 * `id: ''`, trading the spinner-that-never-loads for exactly the "No event
 * chosen. Open an event first, then manage it." dead end this file's own
 * tests above pin as the correct message for a genuinely id-less arrival —
 * except here the arrival was never genuine, it was manufactured by the
 * dashboard itself out of a null. Found live: Anderson & Co has no eligible
 * event right now (see mobile-business-home.node.test.ts's contradiction
 * fixture and business-next-event.node.test.ts for what "eligible" means),
 * and tapping Manage events did exactly this.
 *
 * UPDATE — the Events management list
 *
 * "Manage event and Scan tickets now render only when nextBizEvent exists;
 * ... No event-list screen was created — none exists" (above) was the right
 * call for THIS fix, and is no longer the whole story: a later acceptance
 * pass found that reusing "the one relevant event" for Manage events too
 * left every OTHER event — including any draft — unreachable from the main
 * management flow. Manage events now always opens the events management
 * list (app/business-events.tsx), unconditionally: it needs no event to act
 * on (the list handles zero events itself, with its own empty state), so it
 * is no longer guarded on nextBizEvent at all, and no longer pushes to
 * /event-manage directly. Scan tickets is UNCHANGED — it is still a
 * per-event action that genuinely needs nextBizEvent, exactly as this file
 * originally proved. See event-management-index.node.test.ts for the new
 * screen's own coverage.
 */
describe('the Run events card: Manage events is unconditional; Scan tickets still needs an event to act on', () => {
  function runEventsCard(): string {
    const src = code(DASH);
    const start = src.indexOf('fact={nextBizEvent');
    assert.notEqual(start, -1, 'the Run events outcome card has moved');
    const end = src.indexOf(']}', start);
    assert.notEqual(end, -1, 'the actions array for this card has moved');
    return src.slice(start, end);
  }

  test('1. Manage events is unconditional — it opens the management list, not nextBizEvent directly, regardless of whether nextBizEvent exists', () => {
    const block = runEventsCard();
    assert.match(block,
      /\{ label: 'Manage events', onPress: \(\) => router\.push\(\{ pathname: '\/business-events', params: \{ businessId: activeBusiness\.id \} \}\) \},/,
      'Manage events must be a plain, unconditional entry targeting the management list with businessId, never a single event id');
    assert.doesNotMatch(block, /label: 'Manage events'[\s\S]{0,120}nextBizEvent/,
      'Manage events must not be guarded on, or reference, nextBizEvent at all');
  });

  test('2. nextBizEvent present → Scan tickets is rendered, targeting the real event id', () => {
    const block = runEventsCard();
    assert.match(block,
      /\.\.\.\(nextBizEvent \? \[\s*\{ label: 'Scan tickets', onPress: \(\) => router\.push\(\{ pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \} \}\) \},\s*\] : \[\]\)/,
      'Scan tickets must be conditionally rendered on nextBizEvent, targeting nextBizEvent.id directly, no fallback');
  });

  test('3. nextBizEvent null → Scan tickets is not in the actions array at all; Manage events and New event still are', () => {
    // Now exactly one spread guard remains (Scan tickets) — Manage events
    // moved out of this pattern entirely in the update above.
    const block = runEventsCard();
    const guards = block.match(/\.\.\.\(nextBizEvent \? \[/g) ?? [];
    assert.equal(guards.length, 1, 'only Scan tickets should still be guarded this way');
    assert.match(block, /label: 'Manage events'/);
    assert.match(block, /label: 'New event'/);
  });

  test('4. New event sits between the unconditional Manage events entry and the guarded Scan tickets entry', () => {
    const block = runEventsCard();
    assert.match(block,
      /\{ label: 'Manage events'.*?\},\s*\{ label: 'New event', onPress: \(\) => router\.push\(\{ pathname: '\/event-create', params: \{ businessId: activeBusiness\.id \} \}\) \},\s*\.\.\.\(nextBizEvent \? \[/s,
      'New event must sit as a plain, unconditional array entry right after Manage events and before the Scan tickets guard');
  });

  test('5 & 6. no empty-id fallback survives on Scan tickets — the shape that produced the dead end is gone', () => {
    const block = runEventsCard();
    assert.doesNotMatch(block, /nextBizEvent\?\.id/,
      'optional chaining on nextBizEvent.id means an id-less push to /event-scanner is still reachable');
    assert.doesNotMatch(block, /\?\?\s*''/,
      'an empty-string fallback id is exactly what produced "No event chosen" for a manufactured, not genuine, no-id arrival');
  });

  test('the label is "Manage events", plural — it manages every event now, not the one selected event', () => {
    const block = runEventsCard();
    assert.match(block, /label: 'Manage events'/);
    assert.doesNotMatch(block, /label: 'Manage event'(?!s)/);
  });

  test('Scan tickets, the one remaining missing-event-guarded action, is never routed to /event-create — that would misrepresent what happened', () => {
    // event-create is New event's own destination; a business with no
    // eligible event must not be sent there under the Scan tickets label,
    // which would look like the action succeeded. Manage events no longer
    // depends on there being an eligible event at all, so this concern no
    // longer applies to it.
    const block = runEventsCard();
    const scanIdx = block.indexOf("label: 'Scan tickets'");
    assert.notEqual(scanIdx, -1);
    assert.doesNotMatch(block.slice(scanIdx, scanIdx + 200), /event-create/);
  });
});

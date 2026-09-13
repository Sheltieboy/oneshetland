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
  for (const route of ['/event-manage', '/event-scanner']) {
    test(`${route} receives an id, not a businessId`, () => {
      const seg = pushedParams(route);
      assert.match(seg, /params: \{ id:/,
        `${route} is still being sent a businessId — it reads \`id\` and will have nothing to work on`);
      assert.doesNotMatch(seg, /businessId: activeBusiness\.id/,
        `${route} is still being sent the business instead of the event`);
    });
  }

  test('both screens do read `id`, so that is genuinely what they need', () => {
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
 * Manage event and Scan tickets now render only when nextBizEvent exists;
 * New event needs no event and is unaffected either way. No event-list
 * screen was created — none exists, and this task's product bar is explicit
 * that hiding the id-less actions is correct, not a placeholder for one.
 */
describe('the Run events card: Manage event / Scan tickets only render when there is an event to act on', () => {
  function runEventsCard(): string {
    const src = code(DASH);
    const start = src.indexOf('fact={nextBizEvent');
    assert.notEqual(start, -1, 'the Run events outcome card has moved');
    const end = src.indexOf(']}', start);
    assert.notEqual(end, -1, 'the actions array for this card has moved');
    return src.slice(start, end);
  }

  test('1. nextBizEvent present → Manage event is rendered, targeting the real event id', () => {
    const block = runEventsCard();
    assert.match(block,
      /\.\.\.\(nextBizEvent \? \[\s*\{ label: 'Manage event', onPress: \(\) => router\.push\(\{ pathname: '\/event-manage', params: \{ id: nextBizEvent\.id \} \}\) \},\s*\] : \[\]\)/,
      'Manage event must be conditionally rendered on nextBizEvent, targeting nextBizEvent.id directly, no fallback');
  });

  test('2. nextBizEvent present → Scan tickets is rendered, targeting the real event id', () => {
    const block = runEventsCard();
    assert.match(block,
      /\.\.\.\(nextBizEvent \? \[\s*\{ label: 'Scan tickets', onPress: \(\) => router\.push\(\{ pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \} \}\) \},\s*\] : \[\]\)/,
      'Scan tickets must be conditionally rendered on nextBizEvent, targeting nextBizEvent.id directly, no fallback');
  });

  test('3. nextBizEvent null → neither action is in the actions array at all', () => {
    // Both are array SPREADS — ...(null ? [x] : []) contributes nothing, so
    // when nextBizEvent is null these are not merely styled as hidden, they
    // never reach OutcomeCard's actions.map at all.
    const block = runEventsCard();
    const guards = block.match(/\.\.\.\(nextBizEvent \? \[/g) ?? [];
    assert.equal(guards.length, 2, 'exactly Manage event and Scan tickets must be guarded this way — nothing more, nothing less');
  });

  test('4. New event remains rendered in both states — it sits outside either guard', () => {
    const block = runEventsCard();
    assert.match(block,
      /\] : \[\]\),\s*\{ label: 'New event', onPress: \(\) => router\.push\(\{ pathname: '\/event-create', params: \{ businessId: activeBusiness\.id \} \}\) \},\s*\.\.\.\(nextBizEvent \? \[/,
      'New event must sit as a plain, unconditional array entry between the two guarded actions, unaffected by nextBizEvent');
  });

  test('5 & 6. no empty-id fallback survives in this card — the shape that produced the dead end is gone', () => {
    const block = runEventsCard();
    assert.doesNotMatch(block, /nextBizEvent\?\.id/,
      'optional chaining on nextBizEvent.id means an id-less push to /event-manage or /event-scanner is still reachable');
    assert.doesNotMatch(block, /\?\?\s*''/,
      'an empty-string fallback id is exactly what produced "No event chosen" for a manufactured, not genuine, no-id arrival');
  });

  test('the label is "Manage event", singular — it always manages the one selected event, never a list', () => {
    const block = runEventsCard();
    assert.match(block, /label: 'Manage event'(?!s)/);
    assert.doesNotMatch(block, /label: 'Manage events'/);
  });

  test('neither missing-event action was routed to /event-create — that would misrepresent what happened', () => {
    // event-create is New event's own destination; a business with no
    // eligible event must not be sent there under the Manage event or Scan
    // tickets label, which would look like those actions succeeded.
    const block = runEventsCard();
    const manageIdx = block.indexOf("label: 'Manage event'");
    const scanIdx = block.indexOf("label: 'Scan tickets'");
    assert.notEqual(manageIdx, -1);
    assert.notEqual(scanIdx, -1);
    assert.doesNotMatch(block.slice(manageIdx, manageIdx + 200), /event-create/);
    assert.doesNotMatch(block.slice(scanIdx, scanIdx + 200), /event-create/);
  });
});

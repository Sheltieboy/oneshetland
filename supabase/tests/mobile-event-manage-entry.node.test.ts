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

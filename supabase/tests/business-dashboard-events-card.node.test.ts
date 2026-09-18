/**
 * business-dashboard-events-card.node.test.ts
 *
 * The Events launch exception has been retired.
 *
 * A previous phase temporarily gated the Events OutcomeCard on
 * `(isWorking(3) || outcomes[3]?.state === 'available')` because a freshly
 * claimed business had no other path to discover Events while unused. Now
 * that "Add to your business" (business-dashboard-add-capability-chooser.
 * node.test.ts) covers every unused capability — Events included — that
 * exception is no longer needed: Events reverts to the same plain
 * `isWorking(3)` gate used by Sell/Bookings/Retention, and a business with
 * zero events discovers it through the chooser instead of a permanently
 * visible empty card.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/component test
 * infrastructure. These prove the exception's condition and comment are
 * genuinely gone and Events matches the other three cards; they cannot
 * render the screen.
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const dashboardPath = 'app/local-business-dashboard.tsx';
const dashboardRaw = read(dashboardPath);
const dashboardSrc = code(dashboardRaw);

describe('Events card reverted to plain isWorking(3), same as Sell/Bookings/Retention', () => {
  test('the guard is exactly {isWorking(3) && (', () => {
    assert.match(dashboardSrc, /\{isWorking\(3\) && \(/);
  });

  test('the retired "available" exception condition no longer appears anywhere', () => {
    assert.doesNotMatch(dashboardSrc, /isWorking\(3\)\s*\|\|\s*outcomes\[3\]\?\.state === 'available'/);
  });

  test('the retired launch-exception comment is gone', () => {
    assert.doesNotMatch(dashboardRaw, /Launch exception, Events only/);
  });

  test('cards 1, 2, 3 and 4 are now gated identically — plain isWorking(N)', () => {
    assert.match(dashboardSrc, /\{isWorking\(1\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(2\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(3\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(4\) && \(/);
  });
});

describe('a business with zero events (eventsOutcome state "available") is no longer shown a permanent empty card', () => {
  test('outcomes[3] with state "available" fails isWorking(3), so the card does not render', () => {
    // isWorking = (i) => !!outcomes[i] && outcomes[i].state !== 'available'
    assert.match(dashboardSrc, /const isWorking = \(i: number\) => !!outcomes\[i\] && outcomes\[i\]\.state !== 'available';/);
  });
});

describe('the events card itself, once shown, is otherwise unchanged', () => {
  test('"New event" still routes to /event-create with the active business id', () => {
    assert.match(dashboardSrc, /pathname: '\/event-create', params: \{ businessId: activeBusiness\.id \}/);
  });

  test('Manage event and Scan tickets still route to the correct per-event screens with the real event id', () => {
    assert.match(dashboardSrc, /pathname: '\/event-manage', params: \{ id: nextBizEvent\.id \}/);
    assert.match(dashboardSrc, /pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \}/);
  });
});

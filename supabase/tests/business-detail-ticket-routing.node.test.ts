/**
 * business-detail-ticket-routing.node.test.ts — the payout-readiness gate
 * cannot be bypassed from a business profile.
 *
 * WHAT WAS WRONG
 *
 * Every ticket entry point in the app deliberately routes through the event
 * detail screen (`/events/[id]`) first, because that screen is the one place
 * that resolves `event_payout_ready` and only shows a working Buy CTA when
 * the organiser can actually be paid — otherwise it shows "Tickets coming
 * soon". app/(tabs)/whats-on.tsx does this correctly, with a comment saying
 * so. app/local-business-detail.tsx's "Upcoming events" section did not: its
 * Tickets pill routed straight to /event-ticket-checkout, skipping the gate
 * entirely. The server still refused the purchase (create-event-ticket-intent
 * returns 409 for a payout-not-ready organiser), so no money was ever at
 * risk — but a customer who found an event via a business profile could
 * select tickets, enter checkout, and only then hit a generic "Could not
 * complete booking" failure with no upfront warning: a needless dead end in
 * a core purchase path, worst right at launch while organisers are still
 * completing Stripe onboarding.
 *
 * WHAT IS ASSERTED
 *   · local-business-detail.tsx's ticket entry point now routes through
 *     /events/[id], the same canonical gate whats-on.tsx uses
 *   · it no longer routes straight to /event-ticket-checkout
 *   · the event id is passed through under the param name events/[id] reads
 *   · no payout-readiness logic was duplicated into local-business-detail —
 *     it stays a pure navigation change, event-detail remains the one gate
 *   · the row's own tap target (not just the ticket pill) already used the
 *     canonical route and is unchanged by this fix
 *   · the event-detail screen itself still resolves payout_ready and only
 *     offers a working Buy CTA when it's true, otherwise a non-navigating
 *     "Tickets coming soon" state — i.e. the gate this fix now reaches is
 *     the real one, not a further dead end
 *
 * SAFETY
 * Reads source only. No database, no network, no writes.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DETAIL      = join(REPO_ROOT, 'app/local-business-detail.tsx');
const WHATS_ON    = join(REPO_ROOT, 'app/(tabs)/whats-on.tsx');
const EVENT_ID    = join(REPO_ROOT, 'app/events/[id].tsx');

const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const code = (p: string) => strip(readFileSync(p, 'utf8'));

/** The "Upcoming events" ticket-pill onPress block in local-business-detail.tsx. */
function ticketPillBlock(): string {
  const c = code(DETAIL);
  const anchor = c.indexOf("ev.has_tickets ?");
  assert.notEqual(anchor, -1, 'the Upcoming events ticket pill (ev.has_tickets ?) must still exist');
  return c.slice(anchor, anchor + 700);
}

describe('business-detail Upcoming events "Tickets" pill', () => {
  test('routes through /events/[id], the canonical payout-gated route', () => {
    const block = ticketPillBlock();
    assert.match(block, /pathname:\s*'\/events\/\[id\]'/,
      'must route through the event detail screen, which resolves payout_ready');
    assert.match(block, /params:\s*\{\s*id:\s*ev\.id\s*\}/,
      'must pass the event id under the param name events/[id] reads');
  });

  test('no longer routes straight to /event-ticket-checkout', () => {
    const block = ticketPillBlock();
    assert.doesNotMatch(block, /\/event-ticket-checkout/,
      'the direct-to-checkout bypass must be gone');
  });

  test('matches the canonical pattern already used in whats-on.tsx', () => {
    const whatsOnCode = code(WHATS_ON);
    const whatsOnAnchor = whatsOnCode.indexOf('event.has_tickets &&');
    assert.notEqual(whatsOnAnchor, -1, 'whats-on.tsx canonical ticket button must still exist to compare against');
    const whatsOnBlock = whatsOnCode.slice(whatsOnAnchor, whatsOnAnchor + 500);
    assert.match(whatsOnBlock, /pathname:\s*'\/events\/\[id\]'/);

    // Both entry points now resolve to the same destination screen.
    const detailBlock = ticketPillBlock();
    assert.match(detailBlock, /pathname:\s*'\/events\/\[id\]'/);
  });

  test('no payout-readiness logic was duplicated into local-business-detail.tsx', () => {
    const c = code(DETAIL);
    assert.doesNotMatch(c, /payout_ready/,
      'local-business-detail.tsx must not re-implement the gate — event-detail stays the one place that decides');
  });

  test('other business-detail navigation is unchanged: the row itself already used the canonical route', () => {
    const c = code(DETAIL);
    // The outer event-row TouchableOpacity (tapping anywhere but the pill)
    // routes to /events/[id] — this was already correct and this fix must
    // not have touched it or duplicated it into something new.
    const rowAnchor = c.indexOf('style={styles.eventRow}');
    assert.notEqual(rowAnchor, -1, 'the Upcoming events row must still exist');
    const rowBlock = c.slice(rowAnchor, rowAnchor + 300);
    assert.match(rowBlock, /pathname:\s*'\/events\/\[id\]'/,
      'the row tap target must still route to event detail, same as before this fix');
  });
});

describe('the canonical gate this fix now reaches actually gates', () => {
  test('event detail resolves payout_ready and only offers a working Buy CTA when true', () => {
    const c = code(EVENT_ID);
    assert.match(c, /payout_ready/, 'event-detail must still resolve payout readiness');
    assert.match(c, /Tickets coming soon/, 'a not-ready organiser must still get a non-navigating state, not a dead end');
  });
});

/**
 * business-profile-tickets-intent.node.test.ts — the business-profile
 * "Tickets" button continues straight to ticket selection, without ever
 * bypassing the canonical event-detail readiness gate.
 *
 * WHAT WAS QUESTIONED (not a defect — a UX gap)
 *
 * From the public business profile, tapping the event card and tapping the
 * separate "Tickets" pill both opened the same event-detail page — safe
 * (the payout-readiness gate always ran there), but a button labelled
 * "Tickets" implies it should open ticket selection directly, and the
 * customer had to tap "Get tickets" again once they arrived.
 *
 * THE FIX
 *
 * The Tickets button now passes autoOpenTickets=1 on the SAME route
 * (/events/[id]) it already used — never routing to /event-ticket-checkout
 * directly. events/[id].tsx reads that intent, and once the event has
 * finished loading, evaluates the exact same five-term readiness expression
 * that already gates the Get tickets button (hasTickets, ticketsOnSale,
 * !isCancelled, !isOwner, payoutReady) — not a second copy of it, the exact
 * same const values, computed once and read from both places. If eligible,
 * it calls the same existing openTicketCheckout() the button's onPress
 * already used. If not, it does nothing: the visitor is simply left on the
 * normal event page. The intent is consumed exactly once, via a useRef
 * guard mirroring the dashboard's tab=payments one-shot jump.
 *
 * WHAT IS ASSERTED — mapped to the twelve required scenarios
 *   1  normal event-card tap carries no autoOpenTickets intent
 *   2  the Tickets button passes autoOpenTickets=1, on /events/[id] — never
 *      /event-ticket-checkout directly
 *   3  the intent waits for loading to finish before doing anything
 *   4  an eligible event calls the existing openTicketCheckout()
 *   5  payout-not-ready does not continue
 *   6  a cancelled event does not continue
 *   7  tickets-off-sale does not continue
 *   8  the owner does not continue
 *   9  the intent is consumed exactly once
 *  10  no direct business-detail → /event-ticket-checkout route exists
 *  11  the existing manual Get tickets button is unchanged
 *  12  a repeat invocation with the intent already consumed cannot reopen
 *      ticket selection, regardless of what the gate values are by then —
 *      the one-shot guard is unconditional, not merely "same inputs again"
 *
 * SAFETY
 * Reads source only, and executes the real extracted effect body (not
 * text-adjacency guesses) against a parameter matrix — no database, no
 * network, no writes. No backend/payout/eligibility/auth logic is touched
 * or re-implemented here; every scenario proves the ONE existing gate is
 * read, never a parallel one.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DETAIL  = join(REPO_ROOT, 'app/local-business-detail.tsx');
const EVENT   = join(REPO_ROOT, 'app/events/[id].tsx');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (p: string) => strip(readFileSync(p, 'utf8'));
const raw  = (p: string) => readFileSync(p, 'utf8');

/* ── 1 & 2 — business-profile navigation ──────────────────────────────────── */

describe('business-profile navigation: card vs Tickets button', () => {
  const src = code(DETAIL);

  test('1. the event card/title tap carries no autoOpenTickets intent', () => {
    const anchor = src.indexOf("onPress={() => router.push({ pathname: '/events/[id]', params: { id: ev.id } })}");
    assert.notEqual(anchor, -1, 'the plain event-card push has changed shape or moved');
  });

  test('2. the Tickets button passes autoOpenTickets=1 on /events/[id] — the same canonical route, not checkout', () => {
    assert.match(src, /pathname: '\/events\/\[id\]', params: \{ id: ev\.id, autoOpenTickets: '1' \}/,
      'the Tickets button must still land on the canonical event page, carrying the auto-open intent');
  });

  test('10. no direct business-detail → /event-ticket-checkout route exists', () => {
    assert.doesNotMatch(raw(DETAIL), /event-ticket-checkout/,
      'the business profile must never route straight to checkout, bypassing the event-detail gate');
  });
});

/* ── 11 — the manual path is unchanged ────────────────────────────────────── */

describe('the existing manual Get tickets button is unchanged', () => {
  test('11. Get tickets still renders only when payoutReady, and still calls the same openTicketCheckout', () => {
    const src = code(EVENT);
    const anchor = src.indexOf('payoutReady ? (');
    assert.notEqual(anchor, -1, 'the payout-ready branch has moved');
    const block = src.slice(anchor, src.indexOf('Tickets coming soon', anchor));
    assert.match(block, /onPress=\{openTicketCheckout\}/);
    assert.match(block, />Get tickets</);
  });
});

/* ── the auto-open intent itself ──────────────────────────────────────────── */

describe('events/[id]: the auto-open-tickets intent', () => {
  const src = code(EVENT);

  test('the route reads autoOpenTickets alongside id, from the same params object', () => {
    assert.match(src, /const \{ id, autoOpenTickets \} = useLocalSearchParams<\{ id: string; autoOpenTickets\?: string \}>\(\);/);
  });

  test('the readiness values the intent reads are the SAME consts the Get tickets button renders from — not a second copy', () => {
    // hasTickets/ticketsOnSale/isCancelled/isOwner/payoutReady must each be
    // declared exactly once in the whole file. Two declarations of any of
    // them would mean the auto-open path and the button could silently
    // diverge over time even if they agree today.
    for (const name of ['hasTickets', 'ticketsOnSale', 'isCancelled', 'isOwner', 'payoutReady']) {
      const decls = src.match(new RegExp(`const ${name}\\b`, 'g')) ?? [];
      assert.equal(decls.length, 1, `${name} must be declared exactly once — found ${decls.length}`);
    }
  });

  test('openTicketCheckout is declared exactly once and is the same function used by both the intent and the button', () => {
    const decls = src.match(/const openTicketCheckout = /g) ?? [];
    assert.equal(decls.length, 1);
    const calls = src.match(/openTicketCheckout\(\)/g) ?? [];
    // One call inside the auto-open effect, one as the button's bare onPress
    // reference (not a call — see the "unchanged" test above), so exactly
    // one *call* site plus one *reference* site is expected.
    assert.equal(calls.length, 1, 'openTicketCheckout() should be actually CALLED from exactly one place: the auto-open effect');
  });

  /**
   * Executes the real extracted effect body — not a rewritten approximation
   * of it — against a parameter matrix. body/decl below must stay in sync
   * with the source; if the effect's shape changes, the anchor assertions
   * below fail loudly rather than silently testing stale logic.
   */
  function extractEffectBody(): string {
    const decl = 'const consumedAutoOpenTickets = useRef(false);\n  useEffect(() => {';
    const declAnchor = src.indexOf(decl);
    assert.notEqual(declAnchor, -1, 'the auto-open effect has moved or changed shape');
    const bodyStart = declAnchor + decl.length;
    const bodyEnd = src.indexOf('}, [loading, autoOpenTickets,', declAnchor);
    assert.notEqual(bodyEnd, -1, 'the effect\'s dependency array has changed shape');
    const body = src.slice(bodyStart, bodyEnd);
    assert.doesNotMatch(body, /:\s*(boolean|string|number)\b/, 'body slice must be plain JS, or new Function below cannot parse it');
    return body;
  }

  function run(
    ref: { current: boolean },
    params: {
      loading: boolean; autoOpenTickets: string | undefined;
      hasTickets: boolean; ticketsOnSale: boolean; isCancelled: boolean; isOwner: boolean; payoutReady: boolean;
    },
  ) {
    const body = extractEffectBody();
    let called = 0;
    const openTicketCheckout = () => { called += 1; };
    // eslint-disable-next-line no-new-func
    new Function(
      'consumedAutoOpenTickets', 'loading', 'autoOpenTickets',
      'hasTickets', 'ticketsOnSale', 'isCancelled', 'isOwner', 'payoutReady', 'openTicketCheckout',
      body,
    )(
      ref, params.loading, params.autoOpenTickets,
      params.hasTickets, params.ticketsOnSale, params.isCancelled, params.isOwner, params.payoutReady, openTicketCheckout,
    );
    return { called, consumed: ref.current };
  }

  const ELIGIBLE = { loading: false, autoOpenTickets: '1', hasTickets: true, ticketsOnSale: true, isCancelled: false, isOwner: false, payoutReady: true };

  test('3. the intent waits until loading finishes — it does nothing, and is not consumed, while loading', () => {
    const ref = { current: false };
    const r = run(ref, { ...ELIGIBLE, loading: true });
    assert.equal(r.called, 0, 'must not open tickets while the event is still loading');
    assert.equal(r.consumed, false, 'must not consume the intent while loading — a later render (loading=false) must still get a chance');
  });

  test('4. an eligible event calls the existing openTicketCheckout() exactly once', () => {
    const ref = { current: false };
    const r = run(ref, ELIGIBLE);
    assert.equal(r.called, 1);
    assert.equal(r.consumed, true);
  });

  test('5. payout-not-ready does not continue', () => {
    const ref = { current: false };
    const r = run(ref, { ...ELIGIBLE, payoutReady: false });
    assert.equal(r.called, 0, 'must not open tickets for an organiser who cannot yet receive payouts');
  });

  test('6. a cancelled event does not continue', () => {
    const ref = { current: false };
    const r = run(ref, { ...ELIGIBLE, isCancelled: true });
    assert.equal(r.called, 0);
  });

  test('7. tickets-off-sale does not continue', () => {
    const ref = { current: false };
    const r = run(ref, { ...ELIGIBLE, ticketsOnSale: false });
    assert.equal(r.called, 0);
  });

  test('8. the owner does not continue', () => {
    const ref = { current: false };
    const r = run(ref, { ...ELIGIBLE, isOwner: true });
    assert.equal(r.called, 0, 'an organiser viewing their own event must never be auto-routed into buying a ticket from it');
  });

  test('9. the intent is consumed exactly once — a second invocation with the same ref does nothing further', () => {
    const ref = { current: false };
    const first = run(ref, ELIGIBLE);
    assert.equal(first.called, 1);
    const second = run(ref, ELIGIBLE); // same ref object, now already consumed
    assert.equal(second.called, 0, 'a second effect run must not call openTicketCheckout again');
    // Total across both invocations is exactly one call — not "once per
    // invocation", genuinely once for the whole ref's lifetime.
  });

  test('12. once consumed, no invocation reopens ticket selection — even if the gate values would now allow it, or autoOpenTickets is still \'1\'', () => {
    // Simulates the state after Back from ticket selection: the ref carries
    // forward (it is a ref, not state — it survives re-renders without
    // resetting), so any later effect re-run — from an unrelated dependency
    // change, a remount-free re-navigation, or genuinely retrying the same
    // eligible params — must still be inert. This is the one-shot guard
    // proven unconditionally, not merely "the same inputs return the same
    // no-op".
    const ref = { current: true }; // already consumed from an earlier point in this screen's lifetime
    const r = run(ref, ELIGIBLE); // fully eligible, autoOpenTickets still '1'
    assert.equal(r.called, 0, 'an already-consumed intent must never reopen ticket selection, regardless of current gate values');
  });

  test('the guard order is: consumed-check, then loading-check, then intent-check, then mark-consumed, then the gate', () => {
    const body = extractEffectBody();
    const iConsumedGuard = body.indexOf('if (consumedAutoOpenTickets.current) return;');
    const iLoadingGuard  = body.indexOf('if (loading) return;');
    const iIntentGuard   = body.indexOf("if (autoOpenTickets !== '1') return;");
    const iMarkConsumed  = body.indexOf('consumedAutoOpenTickets.current = true;');
    const iGate          = body.indexOf('if (hasTickets && ticketsOnSale && !isCancelled && !isOwner && payoutReady)');
    for (const idx of [iConsumedGuard, iLoadingGuard, iIntentGuard, iMarkConsumed, iGate]) assert.notEqual(idx, -1);
    assert.ok(iConsumedGuard < iLoadingGuard && iLoadingGuard < iIntentGuard && iIntentGuard < iMarkConsumed && iMarkConsumed < iGate,
      'the guards must run in this order, or the one-shot/loading semantics above are not actually what the source does');
  });
});

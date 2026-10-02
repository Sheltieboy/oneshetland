/**
 * ticket-lifecycle.node.test.ts
 *
 * A Wallet-funded £1.96 ticket was refunded and then vanished from the customer's
 * My Tickets — the list asked only for valid/used rows, so the customer lost the
 * record of what they paid and what came back. My Tickets now has two tabs,
 * Upcoming and Past, split by one shared rule (lib/ticket-lifecycle.ts) that both
 * the mobile app and the web use.
 *
 * WHAT THIS FILE PINS
 *   - the rule: which tab, which label, and whether a code may be shown, for every
 *     status × event-state combination the spec names
 *   - the money lines: the refunded £1.96 Wallet order reads exactly as the
 *     customer needs, and only the BUYER is ever shown amounts
 *   - the two platforms cannot disagree: the helper is byte-identical and the same
 *     matrix gives the same answer through each copy
 *   - the wiring: both fetches ask for history, both screens use the shared rule
 *     rather than their own date comparison, and a dead ticket never gets a code
 *   - the ENTITLEMENT rule is untouched: history adds `refunded` and nothing else
 *
 * Pure: no database, no network, no service key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mobile from '../../lib/ticket-lifecycle.ts';
// @ts-ignore — the web repo's copy, loaded by relative path so the two can be compared.
import * as web from '../../../oneshetland-web/lib/ticket-lifecycle.ts';
// @ts-ignore — the web repo's ownership constant (pure, import-free).
import { OWNED_TICKET_STATUSES } from '../../../oneshetland-web/lib/event-ticket-utils.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO, '..', 'oneshetland-web');
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');
/** Source with comments stripped, so a comment can neither satisfy nor break a contract. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { ticketLifecycle, splitTickets, ticketHistoryLines, paymentMethodFromRef, eventEndMs,
  HISTORY_TICKET_STATUSES, DEFAULT_EVENT_DURATION_MS } = mobile;

const NOW = Date.parse('2026-10-02T15:00:00Z');
const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** An event that starts `startOffset` from NOW and (optionally) ends `endOffset` from NOW. */
const ev = (startOffset: number, endOffset: number | null = null, status = 'published') =>
  ({ starts_at: iso(startOffset), ends_at: endOffset === null ? null : iso(endOffset), status });

const FUTURE = ev(4 * 24 * HOUR);

describe('which tab, which words, whether a code may be shown', () => {
  const life = (t: Parameters<typeof ticketLifecycle>[0]) => ticketLifecycle(t, NOW)!;

  test('a valid ticket for a future event is Upcoming, Valid, and shows its code', () => {
    const l = life({ status: 'valid', event: FUTURE });
    assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['upcoming', 'valid', 'Valid', true]);
  });

  test('a free ticket is just a valid ticket: Upcoming', () => {
    // free-ness lives on the order, not the ticket — the lifecycle needs nothing extra
    assert.equal(life({ status: 'valid', event: FUTURE }).bucket, 'upcoming');
  });

  test('a REFUNDED ticket for a FUTURE event is Past immediately, says Refunded, and shows NO code', () => {
    const l = life({ status: 'refunded', event: FUTURE });
    assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['past', 'refunded', 'Refunded', false]);
  });

  test('refunded outranks everything about the event: cancelled, ended or running, it says Refunded', () => {
    for (const event of [ev(-30 * 24 * HOUR), ev(4 * 24 * HOUR, null, 'cancelled'), ev(-HOUR, HOUR)]) {
      const l = life({ status: 'refunded', event });
      assert.deepEqual([l.bucket, l.label, l.showCode], ['past', 'Refunded', false]);
    }
  });

  test('a CHECKED-IN ticket is Past, says Checked in, and shows no code — by status or by the scan stamp', () => {
    for (const t of [{ status: 'used', event: FUTURE }, { status: 'valid', checked_in_at: iso(-HOUR), event: FUTURE }]) {
      const l = life(t);
      assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['past', 'checked_in', 'Checked in', false]);
    }
  });

  test('a ticket for a CANCELLED event is Past with no code, even though its own row still says valid', () => {
    const l = life({ status: 'valid', event: ev(4 * 24 * HOUR, null, 'cancelled') });
    assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['past', 'event_cancelled', 'Event cancelled', false]);
  });

  test('an ENDED event moves its never-checked-in ticket to Past with no code — the ticket status alone is not trusted', () => {
    const l = life({ status: 'valid', event: ev(-3 * 24 * HOUR, -3 * 24 * HOUR + 2 * HOUR) });
    assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['past', 'event_ended', 'Event ended', false]);
  });

  test('an event with no end time is treated as running for six hours, so an event in progress is still Upcoming', () => {
    assert.equal(DEFAULT_EVENT_DURATION_MS, 6 * HOUR);
    assert.equal(life({ status: 'valid', event: ev(-HOUR) }).bucket, 'upcoming');
    assert.equal(life({ status: 'valid', event: ev(-5 * HOUR - 59 * 60_000) }).bucket, 'upcoming');
    assert.equal(life({ status: 'valid', event: ev(-6 * HOUR) }).bucket, 'past');
  });

  test('an event with an end time is over at that time, not before and not by the six-hour default', () => {
    assert.equal(life({ status: 'valid', event: ev(-2 * HOUR, 30 * 60_000) }).bucket, 'upcoming');
    assert.equal(life({ status: 'valid', event: ev(-2 * HOUR, 0) }).bucket, 'past');
    // a long event: ends 3 days in, started 2 days ago — well past six hours but still running
    assert.equal(life({ status: 'valid', event: ev(-2 * 24 * HOUR, 24 * HOUR) }).bucket, 'upcoming');
  });

  test('an end time earlier than the start is nonsense and is ignored', () => {
    assert.equal(eventEndMs({ starts_at: iso(0), ends_at: iso(-HOUR) }), NOW + 6 * HOUR);
  });

  test('"ended" is asked at the moment of asking — the same ticket changes tab as the clock passes the end', () => {
    const t = { status: 'valid', event: ev(HOUR, 3 * HOUR) };
    assert.equal(ticketLifecycle(t, NOW)!.bucket, 'upcoming');
    assert.equal(ticketLifecycle(t, NOW + 3 * HOUR)!.bucket, 'past');
  });

  test('a postponed event keeps its ticket Upcoming but shows no code until a date is set', () => {
    const l = life({ status: 'valid', event: ev(4 * 24 * HOUR, null, 'postponed') });
    assert.deepEqual([l.bucket, l.state, l.label, l.showCode], ['upcoming', 'postponed', 'Postponed', false]);
  });

  test('an archived event is over', () => {
    assert.equal(life({ status: 'valid', event: ev(4 * 24 * HOUR, null, 'archived') }).bucket, 'past');
  });

  test('a valid ticket whose event cannot be read stays Upcoming rather than being buried', () => {
    assert.equal(life({ status: 'valid', event: null }).bucket, 'upcoming');
  });

  test('tickets that were never a purchase have no lifecycle at all — they are not history', () => {
    for (const status of ['pending_payment', 'cancelled', '', null, undefined, 'VALID', 'checked_in']) {
      assert.equal(ticketLifecycle({ status: status as never, event: FUTURE }, NOW), null, String(status));
    }
  });

  test('ONLY a live ticket ever gets a code: exactly one state shows one', () => {
    const states = new Set<string>();
    const cases = [
      { status: 'valid', event: FUTURE }, { status: 'refunded', event: FUTURE }, { status: 'used', event: FUTURE },
      { status: 'valid', event: ev(4 * 24 * HOUR, null, 'cancelled') }, { status: 'valid', event: ev(-3 * 24 * HOUR) },
      { status: 'valid', event: ev(4 * 24 * HOUR, null, 'postponed') },
    ];
    for (const c of cases) { const l = life(c); if (l.showCode) states.add(l.state); }
    assert.deepEqual([...states], ['valid']);
  });
});

describe('splitting into the two tabs', () => {
  type T = { id: string; status: string; checked_in_at?: string | null; event: ReturnType<typeof ev> };
  const tickets: T[] = [
    { id: 'soon', status: 'valid', event: ev(1 * 24 * HOUR) },
    { id: 'later', status: 'valid', event: ev(9 * 24 * HOUR) },
    { id: 'refunded-future', status: 'refunded', event: ev(2 * 24 * HOUR) },
    { id: 'scanned', status: 'used', event: ev(-1 * 24 * HOUR) },
    { id: 'old-valid', status: 'valid', event: ev(-30 * 24 * HOUR) },
    { id: 'cancelled-event', status: 'valid', event: ev(3 * 24 * HOUR, null, 'cancelled') },
    { id: 'unpaid', status: 'pending_payment', event: ev(3 * 24 * HOUR) },
    { id: 'abandoned', status: 'cancelled', event: ev(3 * 24 * HOUR) },
  ];
  const { upcoming, past } = splitTickets(tickets, (t) => t, NOW);

  test('Upcoming is the usable tickets, soonest event first', () => {
    assert.deepEqual(upcoming.map((t) => t.id), ['soon', 'later']);
  });

  test('Past is everything terminal, most recent event first — and the refunded future ticket is in it', () => {
    assert.deepEqual(past.map((t) => t.id), ['cancelled-event', 'refunded-future', 'scanned', 'old-valid']);
  });

  test('unpaid and abandoned rows are in neither tab', () => {
    const all = [...upcoming, ...past].map((t) => t.id);
    assert.ok(!all.includes('unpaid') && !all.includes('abandoned'));
  });

  test('every history ticket is in exactly one tab', () => {
    assert.equal(upcoming.length + past.length, tickets.filter((t) => (HISTORY_TICKET_STATUSES as readonly string[]).includes(t.status)).length);
    assert.equal(upcoming.filter((u) => past.includes(u)).length, 0);
  });
});

describe('what the customer paid, and what came back', () => {
  const day = (i: string) => new Date(i).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
  const BUYER = 'buyer-1';
  // The real shape of order bc622739…: one ticket, paid from the Wallet, then refunded.
  const refundedWallet = {
    buyer_id: BUYER, status: 'refunded', total_pence: 196, tickets_count: 1,
    paid_at: '2026-10-02T13:03:43.618Z', refunded_at: '2026-10-02T14:14:02.541Z', stripe_payment_intent_id: 'wallet_0b7e9c1a-1111-2222-3333-444455556666',
  };

  test('the £1.96 Wallet order reads: 1 ticket, £1.96 paid with the Wallet, £1.96 refunded to the Wallet, with its date', () => {
    const l = ticketHistoryLines(refundedWallet, BUYER, day);
    assert.equal(l.quantity, '1 ticket');
    assert.equal(l.paid, '£1.96 paid with OneShetland Wallet');
    assert.equal(l.refund, '£1.96 refunded to your OneShetland Wallet · 2 Oct 2026');
  });

  test('the amount is the ORDER total (what was charged, fees included), not the ticket\'s own £1.00 price', () => {
    assert.match(ticketHistoryLines(refundedWallet, BUYER, day).paid!, /£1\.96/);
    assert.doesNotMatch(JSON.stringify(ticketHistoryLines(refundedWallet, BUYER, day)), /£1\.00/);
  });

  test('a card order says card, and the refund goes back to the card', () => {
    const l = ticketHistoryLines({ ...refundedWallet, stripe_payment_intent_id: 'pi_3Abc' }, BUYER, day);
    assert.equal(l.paid, '£1.96 paid by card');
    assert.match(l.refund!, /^£1\.96 refunded to your card · /);
  });

  test('a free order shows Free and no refund amount', () => {
    const l = ticketHistoryLines({ buyer_id: BUYER, status: 'refunded', total_pence: 0, tickets_count: 2, stripe_payment_intent_id: null }, BUYER, day);
    assert.deepEqual(l, { quantity: '2 tickets', paid: 'Free', refund: null });
  });

  test('a paid-and-used order shows what was paid and NO refund line', () => {
    const l = ticketHistoryLines({ ...refundedWallet, status: 'paid', refunded_at: null }, BUYER, day);
    assert.equal(l.refund, null);
    assert.equal(l.paid, '£1.96 paid with OneShetland Wallet');
  });

  test('an unrecognised payment reference is reported as simply "paid" — never guessed as card or wallet', () => {
    const l = ticketHistoryLines({ ...refundedWallet, stripe_payment_intent_id: 'mystery_1' }, BUYER, day);
    assert.equal(l.paid, '£1.96 paid');
    assert.equal(l.refund, '£1.96 refunded · 2 Oct 2026');
    assert.equal(paymentMethodFromRef('mystery_1', 196), null);
  });

  test('a missing refund date is simply omitted', () => {
    assert.equal(ticketHistoryLines({ ...refundedWallet, refunded_at: null }, BUYER, day).refund, '£1.96 refunded to your OneShetland Wallet');
  });

  test('ONLY THE BUYER sees amounts: a gifted ticket (no order), another user\'s order, or no viewer all get nothing', () => {
    const none = { quantity: null, paid: null, refund: null };
    assert.deepEqual(ticketHistoryLines(null, BUYER, day), none);
    assert.deepEqual(ticketHistoryLines(undefined, BUYER, day), none);
    // an organiser or admin who holds a ticket someone else bought can READ that order — it is not theirs to be shown as paid
    assert.deepEqual(ticketHistoryLines(refundedWallet, 'organiser-9', day), none);
    assert.deepEqual(ticketHistoryLines(refundedWallet, null, day), none);
    assert.deepEqual(ticketHistoryLines({ ...refundedWallet, buyer_id: null }, BUYER, day), none);
  });

  test('payment rails are read from the reference, and free is decided by the total', () => {
    assert.equal(paymentMethodFromRef('wallet_abc', 500), 'wallet');
    assert.equal(paymentMethodFromRef('pi_abc', 500), 'card');
    assert.equal(paymentMethodFromRef('pi_abc', 0), 'free');
    assert.equal(paymentMethodFromRef(null, 0), 'free');
    assert.equal(paymentMethodFromRef(null, 500), null);
  });

  test('the refunded ticket, end to end: Past, Refunded, no code, £1.96 paid and refunded, no longer valid', () => {
    const l = ticketLifecycle({ status: 'refunded', event: ev(4 * 24 * HOUR) }, NOW)!;
    const m = ticketHistoryLines(refundedWallet, BUYER, day);
    assert.deepEqual([l.bucket, l.label, l.showCode], ['past', 'Refunded', false]);
    assert.ok(m.paid && m.refund);
  });
});

describe('mobile and web cannot disagree', () => {
  test('the helper is byte-identical in both repos', () => {
    assert.equal(read(REPO, 'lib/ticket-lifecycle.ts'), read(WEB, 'lib/ticket-lifecycle.ts'));
  });

  test('the same matrix gives the same tab, label and code decision through each copy', () => {
    const cases = [
      { status: 'valid', event: FUTURE },
      { status: 'refunded', event: FUTURE },
      { status: 'used', event: FUTURE },
      { status: 'valid', checked_in_at: iso(-HOUR), event: FUTURE },
      { status: 'valid', event: ev(4 * 24 * HOUR, null, 'cancelled') },
      { status: 'valid', event: ev(4 * 24 * HOUR, null, 'postponed') },
      { status: 'valid', event: ev(-3 * 24 * HOUR) },
      { status: 'valid', event: ev(-HOUR) },
      { status: 'valid', event: ev(-2 * HOUR, HOUR) },
      { status: 'pending_payment', event: FUTURE },
      { status: 'cancelled', event: FUTURE },
      { status: 'valid', event: null },
    ];
    for (const c of cases) assert.deepEqual(mobile.ticketLifecycle(c, NOW), web.ticketLifecycle(c, NOW), JSON.stringify(c));
    const a = mobile.splitTickets(cases, (c: (typeof cases)[number]) => c, NOW);
    const b = web.splitTickets(cases, (c: (typeof cases)[number]) => c, NOW);
    assert.deepEqual(a, b);
  });

  test('both platforms read the same HISTORY statuses, and both screens split with the shared rule', () => {
    assert.deepEqual(mobile.HISTORY_TICKET_STATUSES, web.HISTORY_TICKET_STATUSES);

    const mScreen = code(read(REPO, 'app/my-event-tickets.tsx'));
    const wScreen = code(read(WEB, 'components/account/TicketsLive.tsx'));
    assert.match(mScreen, /splitTickets\(/);
    assert.match(wScreen, /splitTickets\(/);
    // neither re-derives the tab from a date of its own
    assert.doesNotMatch(mScreen, /starts_at\s*(>=|<|>|<=)\s*now|starts\s*(>=|<)\s*now/);
    assert.doesNotMatch(wScreen, /starts_at\s*(>=|<|>|<=)/);
  });

  test('both platforms fetch HISTORY (valid, used, refunded) for the holder — not the ownership list', () => {
    const mApi = code(read(REPO, 'lib/events-api.ts'));
    const mFn = mApi.slice(mApi.indexOf('export async function fetchMyEventTickets'), mApi.indexOf('export async function fetchMyUpcomingEventTickets'));
    assert.match(mFn, /\.eq\('holder_id', userId\)/);
    assert.match(mFn, /\.in\('status', \[\.\.\.HISTORY_TICKET_STATUSES\]\)/);
    assert.doesNotMatch(mFn, /'valid', 'used'\]/);

    const wPage = code(read(WEB, 'app/account/tickets/page.tsx'));
    assert.match(wPage, /\.eq\("holder_id", account\.id\)/);
    assert.match(wPage, /\.in\("status", \[\.\.\.HISTORY_TICKET_STATUSES\]\)/);
  });

  test('both fetches also read the event END time and the buyer\'s own order, and nothing about anyone else', () => {
    const mApi = code(read(REPO, 'lib/events-api.ts'));
    const wPage = code(read(WEB, 'app/account/tickets/page.tsx'));
    for (const s of [mApi.slice(mApi.indexOf('export async function fetchMyEventTickets'), mApi.indexOf('export async function fetchMyUpcomingEventTickets')), wPage]) {
      assert.match(s, /ends_at/);
      assert.match(s, /event_ticket_orders\(buyer_id, status, total_pence, tickets_count, paid_at, refunded_at, stripe_payment_intent_id\)/);
      // no purchaser identity: no profile, email or name of whoever bought it
      assert.doesNotMatch(s, /event_ticket_orders\([^)]*(email|full_name|profiles)/);
    }
  });
});

describe('the money lines can never take the list down', () => {
  test('if reading the order fails, both platforms retry WITHOUT it — the customer still sees every ticket, refunded ones included', () => {
    const mApi = code(read(REPO, 'lib/events-api.ts'));
    const mFn = mApi.slice(mApi.indexOf('export async function fetchMyEventTickets'), mApi.indexOf('export async function fetchMyUpcomingEventTickets'));
    assert.match(mFn, /if \(!full\.error\) return/);
    assert.match(mFn, /const bare = await query\(base\)/);
    assert.doesNotMatch(mFn.slice(mFn.indexOf('const bare')), /event_ticket_orders/, 'the retry must not ask for the order again');

    const wPage = code(read(WEB, 'app/account/tickets/page.tsx'));
    assert.match(wPage, /if \(error\) \{[\s\S]*\(\{ data, error \} = await query\(BASE\)\)/);
    assert.doesNotMatch(wPage.slice(wPage.indexOf('const BASE')).split('const ORDER')[0], /event_ticket_orders/);
  });
});

describe('entitlement is untouched', () => {
  test('history is ownership plus REFUNDED and nothing else', () => {
    assert.deepEqual([...OWNED_TICKET_STATUSES].sort(), ['used', 'valid']);
    assert.deepEqual(
      [...HISTORY_TICKET_STATUSES].filter((s) => !(OWNED_TICKET_STATUSES as readonly string[]).includes(s)),
      ['refunded'],
    );
    for (const never of ['pending_payment', 'cancelled']) assert.ok(!(HISTORY_TICKET_STATUSES as readonly string[]).includes(never));
  });

  test('For You and social stats still use the ownership constant, not history', () => {
    assert.match(code(read(WEB, 'lib/for-you.server.ts')), /OWNED_TICKET_STATUSES/);
    assert.doesNotMatch(code(read(WEB, 'lib/for-you.server.ts')), /HISTORY_TICKET_STATUSES/);
  });

  test('the event-ticket-utils ownership constant did not gain refunded', () => {
    assert.doesNotMatch(code(read(WEB, 'lib/event-ticket-utils.ts')), /OWNED_TICKET_STATUSES\s*=\s*\[[^\]]*refunded/);
  });
});

describe('a dead ticket never shows a code or a share link', () => {
  const mTicket = code(read(REPO, 'app/my-event-ticket.tsx'));
  const wLive = code(read(WEB, 'components/account/TicketsLive.tsx'));

  test('mobile: the QR credential and the backup code are gated on the lifecycle, not on status alone', () => {
    assert.match(mTicket, /const isLive\s*=\s*life\?\.showCode === true/);
    assert.match(mTicket, /const credential\s*=\s*isLive \? ticketQrCredential\(/);
    assert.match(mTicket, /\{isLive && \(\s*<View style=\{styles\.backupSection\}>/);
  });

  test('mobile: the share button (which carries the backup code) exists only for a live ticket', () => {
    assert.match(mTicket, /rightElement=\{isLive \? \(/);
  });

  test('mobile: a refunded ticket gets an explicit "no longer valid" banner and placeholder, never "QR not available — use backup code"', () => {
    assert.match(mTicket, /refunded:\s*'This ticket was refunded and is no longer valid'/);
    assert.match(mTicket, /refunded:\s*\{ icon: 'undo'/);
  });

  test('web: both the QR and the printed backup code render only when the lifecycle allows', () => {
    assert.match(wLive, /t\.backup_code && life\.showCode && <TicketQR code=\{t\.backup_code\} \/>/);
    assert.match(wLive, /t\.backup_code && life\.showCode && \(\s*<span/);
    // and the old unconditional printing is gone
    assert.doesNotMatch(wLive, /\{row\.backup_code && \(\s*<span/);
  });

  test('web: a ticket being celebrated is held in Upcoming until the celebration ends, then files itself under Past', () => {
    assert.match(wLive, /celebrating\[t\.id\]\s*\?\s*\{ status: "valid", checked_in_at: null/);
  });

  test('both tabs exist on both platforms, named Upcoming and Past', () => {
    assert.match(code(read(REPO, 'app/my-event-tickets.tsx')), /'Upcoming'[\s\S]*'Past'/);
    assert.match(wLive, /"Upcoming"[\s\S]*"Past"/);
    assert.match(wLive, /role="tablist"/);
  });
});

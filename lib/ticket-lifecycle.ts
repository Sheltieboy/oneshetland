/**
 * ticket-lifecycle.ts — which tab a customer's ticket belongs on, and what it says.
 *
 * "My Tickets" has two tabs, Upcoming and Past. A ticket is Upcoming only while
 * it can still be used. The moment it cannot — refunded, void, checked in, the
 * event cancelled or over — it moves to Past, where it stays as a record rather
 * than vanishing. A refunded ticket used to disappear altogether because the
 * list only asked for valid/used rows.
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART
 *
 *   Ownership  — "does this person hold a ticket?"  valid | used. This is
 *                OWNED_TICKET_STATUSES / holds_ticket_for() and is NOT changed
 *                by anything here: a refunded ticket is still not owned.
 *   History    — "what tickets has this person ever had?"  valid | used | refunded.
 *                That is HISTORY_TICKET_STATUSES and is used by My Tickets only.
 *
 * pending_payment (checkout started, never paid) and cancelled (abandoned) were
 * never a purchase, so they are in neither set.
 *
 * Whether an event has ended is read from the event itself (ends_at, else its
 * start plus a default duration) at the moment of asking — never from a copied
 * flag, so it cannot go stale. Nothing here touches the database.
 *
 * This file exists in BOTH repos (the mobile app's lib/ and the web app's lib/)
 * and must stay byte-identical, so both platforms sort the same ticket into the
 * same tab. A test in the mobile repo fails if they differ.
 */

/** Tickets that belong in a customer's history: bought, used, or bought and since refunded. */
export const HISTORY_TICKET_STATUSES = ['valid', 'used', 'refunded'] as const;

/**
 * How long an event with no end time is treated as running. The same six hours
 * the organiser's event list gives an event that has started (groupEventsForManagement).
 */
export const DEFAULT_EVENT_DURATION_MS = 6 * 3600_000;

export interface LifecycleEvent {
  starts_at?: string | null;
  ends_at?: string | null;
  status?: string | null;
}

export interface LifecycleTicket {
  status: string | null | undefined;
  checked_in_at?: string | null;
  event?: LifecycleEvent | null;
}

export type TicketState =
  | 'valid'
  | 'postponed'
  | 'checked_in'
  | 'refunded'
  | 'void'
  | 'event_cancelled'
  | 'event_ended';

export type TicketBucket = 'upcoming' | 'past';

export interface TicketLifecycle {
  bucket: TicketBucket;
  state: TicketState;
  /** The one headline status shown on the ticket. */
  label: string;
  /** Whether a scannable QR / backup code may be shown. Only a live ticket. */
  showCode: boolean;
}

const STATE_LABEL: Record<TicketState, string> = {
  valid: 'Valid',
  postponed: 'Postponed',
  checked_in: 'Checked in',
  refunded: 'Refunded',
  void: 'Void',
  event_cancelled: 'Event cancelled',
  event_ended: 'Event ended',
};

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When the event stops being usable, in epoch ms, or null if its start is unknown.
 * An end time earlier than the start is nonsense and is ignored.
 */
export function eventEndMs(event: LifecycleEvent | null | undefined): number | null {
  const start = toMs(event?.starts_at);
  if (start === null) return null;
  const end = toMs(event?.ends_at);
  return end !== null && end >= start ? end : start + DEFAULT_EVENT_DURATION_MS;
}

/**
 * The lifecycle of one ticket right now, or null when the ticket is not part of
 * a customer's history at all (pending_payment, cancelled-before-payment, unknown).
 *
 * Precedence — the most specific fact about the TICKET wins, then the event:
 *   refunded → void → checked in → event cancelled → event ended → postponed → valid
 * so a refunded ticket for a cancelled event says Refunded, and a ticket that was
 * scanned says Checked in even if the event later ran over.
 */
export function ticketLifecycle(t: LifecycleTicket, now: Date | number = Date.now()): TicketLifecycle | null {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const done = (state: TicketState, bucket: TicketBucket): TicketLifecycle => ({
    bucket, state, label: STATE_LABEL[state], showCode: state === 'valid',
  });

  if (t.status === 'refunded') return done('refunded', 'past');
  if (t.status !== 'valid' && t.status !== 'used') return null;

  if (t.status === 'used' || t.checked_in_at) return done('checked_in', 'past');

  const eventStatus = t.event?.status;
  if (eventStatus === 'cancelled') return done('event_cancelled', 'past');
  if (eventStatus === 'archived') return done('event_ended', 'past');

  const end = eventEndMs(t.event);
  if (end !== null && nowMs >= end) return done('event_ended', 'past');

  if (eventStatus === 'postponed') return done('postponed', 'upcoming');
  return done('valid', 'upcoming');
}

/**
 * Split tickets into the two tabs. Tickets that are not history are dropped.
 * Upcoming is soonest event first; Past is most recent event first.
 */
export function splitTickets<T>(
  items: readonly T[],
  pick: (item: T) => LifecycleTicket,
  now: Date | number = Date.now(),
): { upcoming: T[]; past: T[] } {
  const upcoming: { item: T; at: number }[] = [];
  const past: { item: T; at: number }[] = [];
  for (const item of items) {
    const t = pick(item);
    const life = ticketLifecycle(t, now);
    if (!life) continue;
    const entry = { item, at: toMs(t.event?.starts_at) ?? 0 };
    (life.bucket === 'upcoming' ? upcoming : past).push(entry);
  }
  upcoming.sort((a, b) => a.at - b.at);
  past.sort((a, b) => b.at - a.at);
  return { upcoming: upcoming.map((e) => e.item), past: past.map((e) => e.item) };
}

/* ── what the customer paid, and what came back ───────────────────────────── */

export type PaidWith = 'wallet' | 'card' | 'free' | null;

/** The slice of the buyer's own order row that history needs. */
export interface HistoryOrder {
  /** Who paid. Compared with the viewer: only the buyer is shown what was paid. */
  buyer_id?: string | null;
  status: string | null | undefined;
  total_pence: number;
  tickets_count: number;
  paid_at?: string | null;
  refunded_at?: string | null;
  stripe_payment_intent_id?: string | null;
}

/**
 * Which rail paid, from the order's payment reference: `wallet_<ledger id>` is the
 * OneShetland Wallet, a Stripe `pi_…` is a card, and a zero total is free. Anything
 * else is unknown — and unknown is reported as unknown, never guessed.
 */
export function paymentMethodFromRef(ref: string | null | undefined, totalPence: number): PaidWith {
  if (totalPence <= 0) return 'free';
  if (ref && ref.startsWith('wallet_')) return 'wallet';
  if (ref && ref.startsWith('pi_')) return 'card';
  return null;
}

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

export interface HistoryLines {
  /** "1 ticket" / "2 tickets" — the order's size. */
  quantity: string | null;
  /** "£1.96 paid with OneShetland Wallet". */
  paid: string | null;
  /** "£1.96 refunded to your OneShetland Wallet · 2 Oct 2026". Only for a refunded order. */
  refund: string | null;
}

/**
 * The money lines on a Past ticket. They describe what the VIEWER paid, so they
 * appear only when the order is the viewer's own: a holder who was given the
 * ticket cannot read the order at all, and an organiser or admin who holds a
 * ticket someone else bought CAN read it (they may see their event's orders) but
 * did not pay it — both get nulls and the screen shows only the status, never a
 * guessed or borrowed amount. The order total is what was charged; the ticket's
 * own price_pence excludes fees and is not used here.
 */
export function ticketHistoryLines(
  order: HistoryOrder | null | undefined,
  viewerId: string | null | undefined,
  formatDate: (iso: string) => string,
): HistoryLines {
  if (!order || !viewerId || order.buyer_id !== viewerId) return { quantity: null, paid: null, refund: null };

  const n = order.tickets_count;
  const quantity = n > 0 ? `${n} ticket${n === 1 ? '' : 's'}` : null;
  const method = paymentMethodFromRef(order.stripe_payment_intent_id, order.total_pence);

  let paid: string | null;
  if (method === 'free') paid = 'Free';
  else if (method === 'wallet') paid = `${money(order.total_pence)} paid with OneShetland Wallet`;
  else if (method === 'card') paid = `${money(order.total_pence)} paid by card`;
  else paid = `${money(order.total_pence)} paid`;

  let refund: string | null = null;
  if (order.status === 'refunded' && order.total_pence > 0) {
    const to = method === 'wallet' ? ' to your OneShetland Wallet' : method === 'card' ? ' to your card' : '';
    const on = order.refunded_at ? ` · ${formatDate(order.refunded_at)}` : '';
    refund = `${money(order.total_pence)} refunded${to}${on}`;
  }
  return { quantity, paid, refund };
}

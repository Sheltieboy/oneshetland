/**
 * ticket-quantities.ts — the quantity contract for buying event tickets.
 *
 * Lives here rather than inline in create-event-ticket-intent so the rules can
 * be tested directly (see supabase/tests/ticket-quantities.node.test.ts), the
 * same way _shared/commission.ts is. A validator that cannot be tested without
 * a Stripe key and a live event is a validator nobody re-checks.
 *
 * WHAT WENT WRONG
 * The only check on a line item's quantity was an upper bound —
 * `li.quantity > type.per_order_max`. Everything below is a case that passed it:
 *
 *   Adult x1 @ £12, Child x-2 @ £6   → basket sums to £0, takes the free path,
 *                                      issues a real, valid £12 ticket
 *   quantity: 1.5                    → charges for 1.5 but the row loop is
 *                                      `i < li.quantity`, so it issues 2
 *   quantity: "2"                    → coerces through the comparison, then
 *                                      `0 + "2"` makes the ticket count "02"
 *   quantity: [2]                    → same coercion
 *
 * The request body is hostile input, not a typed object. `typeof` has to come
 * first: `"2" >= 1` and `[2] >= 1` are both true.
 */

/** One line of a ticket order, as it arrives from an untrusted client. */
export interface RawLineItem {
  ticket_type_id?: unknown;
  quantity?: unknown;
  attendee_name?: unknown;
  attendee_email?: unknown;
}

/** A line item that has passed the contract. */
export interface ValidLineItem {
  ticket_type_id: string;
  quantity: number;
  /** Optional attendee details, normalised to a trimmed string or null. */
  attendee_name: string | null;
  attendee_email: string | null;
}

/** Attendee fields reach event_tickets, so they are coerced rather than trusted. */
const MAX_ATTENDEE_FIELD = 200;
function optionalText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_ATTENDEE_FIELD);
}

export type QuantityCheck =
  | { ok: true; items: ValidLineItem[] }
  | { ok: false; error: string };

/**
 * At most this many distinct ticket types in one order. Bounds the work done
 * before anything is reserved, and keeps the total arithmetic far inside
 * Number.MAX_SAFE_INTEGER: 20 lines x per_order_max (10 in production today)
 * x a price in pence cannot get near 2^53.
 */
export const MAX_LINE_ITEMS = 20;

/**
 * Enforce the quantity contract:
 *   - the payload is a non-empty array of objects
 *   - ticket_type_id is a non-empty string
 *   - quantity is a *number*, a safe integer, and at least 1
 *   - each ticket type appears at most once
 *
 * Per-type limits (per_order_max, sale windows) need the database rows and stay
 * in the edge function; this is everything that can be decided from the request
 * alone, so it can run before any reservation, order or ticket row exists.
 */
export function checkLineItems(lineItems: unknown): QuantityCheck {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { ok: false, error: 'Choose at least one ticket' };
  }
  if (lineItems.length > MAX_LINE_ITEMS) {
    return { ok: false, error: 'Too many ticket types in one order' };
  }

  const seen = new Set<string>();
  const items: ValidLineItem[] = [];

  for (const raw of lineItems as RawLineItem[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Invalid ticket selection' };
    }
    if (typeof raw.ticket_type_id !== 'string' || raw.ticket_type_id.length === 0) {
      return { ok: false, error: 'Invalid ticket selection' };
    }
    // typeof BEFORE any comparison — see the header note.
    if (typeof raw.quantity !== 'number' || !Number.isSafeInteger(raw.quantity) || raw.quantity < 1) {
      return { ok: false, error: 'Ticket quantities must be whole numbers of at least 1' };
    }
    if (seen.has(raw.ticket_type_id)) {
      return { ok: false, error: 'Each ticket type may only appear once per order' };
    }
    seen.add(raw.ticket_type_id);
    items.push({
      ticket_type_id: raw.ticket_type_id,
      quantity:       raw.quantity,
      attendee_name:  optionalText(raw.attendee_name),
      attendee_email: optionalText(raw.attendee_email),
    });
  }

  return { ok: true, items };
}

/** The database's view of a ticket type — only what pricing needs. */
export interface PricedType { id: string; price_pence: number }

export type TotalsResult =
  | { ok: true; totalPence: number; totalTickets: number; allFree: boolean }
  | { ok: false; error: string };

/**
 * Total an already-validated basket against DATABASE prices.
 *
 * `allFree` is computed from what the ticket types cost, never from the total
 * landing on zero. That distinction is the fix: a basket summing to £0 because
 * one line was negative is no longer constructible, but keying the free path on
 * arithmetic would still be the wrong shape — one genuinely priced ticket type
 * in the basket must mean payment, whatever the sum says.
 */
export function totalOrder(items: ValidLineItem[], types: PricedType[]): TotalsResult {
  let totalPence = 0;
  let totalTickets = 0;
  let allFree = true;

  for (const li of items) {
    const type = types.find((t) => t.id === li.ticket_type_id);
    if (!type) return { ok: false, error: 'One or more ticket types unavailable' };
    if (!Number.isSafeInteger(type.price_pence) || type.price_pence < 0) {
      return { ok: false, error: 'One or more ticket types is misconfigured' };
    }
    if (type.price_pence > 0) allFree = false;

    const line = type.price_pence * li.quantity;
    if (!Number.isSafeInteger(line)) return { ok: false, error: 'That order is too large to process' };
    totalPence += line;
    totalTickets += li.quantity;
  }

  if (!Number.isSafeInteger(totalPence) || totalPence < 0) {
    return { ok: false, error: 'That order is too large to process' };
  }
  if (!Number.isSafeInteger(totalTickets) || totalTickets < 1) {
    return { ok: false, error: 'That order is too large to process' };
  }

  return { ok: true, totalPence, totalTickets, allFree };
}

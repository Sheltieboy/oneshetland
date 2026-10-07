/**
 * ticket-payment-binding.ts — does this Stripe payment genuinely belong to this ticket order?
 *
 * Pure: no network, no database. Imported by the three places that act on the answer, so they cannot disagree:
 *
 *   refund-payment        before it refunds a card and reverses the organiser's transfer
 *   confirm-event-tickets before it marks an order paid on the buyer's say-so
 *   fulfilEventTickets    before the webhook marks an order paid
 *
 * WHY IT EXISTS
 *
 * refund-payment used to read stripe_payment_intent_id off the order row and refund it, trusting that the row had been written
 * by our own checkout. The row's INSERT policy let any signed-in user write one themselves (migration 20261116000000 closes
 * that), so the identifier on a row is evidence of nothing. The only thing a caller cannot forge is what OUR server stamped
 * onto the PaymentIntent when it created it: create-event-ticket-intent sets metadata type / order_id / event_id / buyer_id
 * and derives the amount from database prices. A payment belongs to an order if and only if those agree with the order.
 *
 * A mismatch is never "close enough": the money would be refunded (or the tickets released) against the wrong payment.
 */

export interface TicketOrderFacts {
  id: string;
  event_id: string;
  buyer_id: string;
  total_pence: number;
}

/** The fields of a Stripe PaymentIntent this check reads. */
export interface PaymentFacts {
  amount?: unknown;
  currency?: unknown;
  metadata?: Record<string, string> | null;
}

export type Binding = { ok: true } | { ok: false; reason: string };

export const TICKET_CURRENCY = 'gbp';

export function paymentBelongsToTicketOrder(order: TicketOrderFacts, pi: PaymentFacts): Binding {
  const meta = pi.metadata ?? {};
  if (meta.type !== 'event_tickets') return { ok: false, reason: 'the payment was not created for event tickets' };
  if (meta.order_id !== order.id) return { ok: false, reason: 'the payment was created for a different order' };
  if (meta.event_id !== order.event_id) return { ok: false, reason: 'the payment was created for a different event' };
  if (meta.buyer_id !== order.buyer_id) return { ok: false, reason: 'the payment was made by a different buyer' };
  if (typeof pi.amount !== 'number' || !Number.isInteger(pi.amount) || pi.amount !== order.total_pence) {
    return { ok: false, reason: 'the payment amount does not equal the order total' };
  }
  if (typeof pi.currency !== 'string' || pi.currency.toLowerCase() !== TICKET_CURRENCY) {
    return { ok: false, reason: 'the payment currency is not the ticket currency' };
  }
  return { ok: true };
}

/**
 * How much of a ticket payment can still be refunded. A ticket order is refunded in full, so the only safe request is
 * exactly what remains: nothing already refunded elsewhere (the Stripe Dashboard, an earlier partial) is refunded twice.
 */
export function refundableOnTicketPayment(amount: unknown, alreadyRefunded: unknown): number {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return 0;
  const done = typeof alreadyRefunded === 'number' && Number.isInteger(alreadyRefunded) && alreadyRefunded > 0 ? alreadyRefunded : 0;
  return Math.max(0, amount - done);
}

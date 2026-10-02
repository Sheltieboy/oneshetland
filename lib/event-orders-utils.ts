/**
 * event-orders-utils.ts — pure helpers for the organiser's ticket-order screen.
 *
 * No React Native, no Supabase and no path aliases, so the exact words the
 * organiser reads before money moves can be tested directly.
 *
 * This file exists in BOTH repos (the mobile app's lib/ and the web app's lib/)
 * and must stay byte-identical: the organiser sees the same refund confirmation
 * on either. A test in the mobile repo fails if they differ.
 */

export interface OrderTicketLike {
  ticket_type: string | null;
  status: string;
  checked_in_at: string | null;
}

export interface OrderLike {
  id: string;
  status: string;
  total_pence: number;
  tickets_count: number;
  checked_in_count: number;
  purchaser: { name: string | null; email: string | null };
  tickets: OrderTicketLike[];
}

export const pounds = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

export function purchaserLabel(o: Pick<OrderLike, 'purchaser'>): string {
  return o.purchaser.name?.trim() || o.purchaser.email?.trim() || 'Unknown purchaser';
}

/** "2 × Standard, 1 × VIP" — grouped by ticket type, in first-seen order. */
export function ticketSummary(o: Pick<OrderLike, 'tickets' | 'tickets_count'>): string {
  if (!o.tickets.length) return `${o.tickets_count} ticket${o.tickets_count === 1 ? '' : 's'}`;
  const counts = new Map<string, number>();
  for (const t of o.tickets) {
    const k = t.ticket_type?.trim() || 'Ticket';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${n} × ${k}`).join(', ');
}

export type OrderBadge = { label: string; tone: 'ok' | 'warn' | 'muted' | 'danger' };

/** The one headline status for an order. A refunded order is never shown as merely "paid". */
export function orderStatusBadge(o: Pick<OrderLike, 'status' | 'total_pence'>): OrderBadge {
  if (o.status === 'refunded') return { label: 'Refunded', tone: 'danger' };
  if (o.status === 'paid') return o.total_pence > 0 ? { label: 'Paid', tone: 'ok' } : { label: 'Free', tone: 'muted' };
  if (o.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  return { label: o.status, tone: 'muted' };
}

export function checkedInLabel(o: Pick<OrderLike, 'checked_in_count' | 'tickets_count'>): string | null {
  if (o.checked_in_count <= 0) return null;
  return `${o.checked_in_count} of ${o.tickets_count} checked in`;
}

export function ticketStatusLabel(status: string): string {
  switch (status) {
    case 'valid': return 'Valid';
    case 'used': return 'Checked in';
    case 'refunded': return 'Void — refunded';
    case 'cancelled': return 'Cancelled';
    case 'pending_payment': return 'Awaiting payment';
    default: return status;
  }
}

/**
 * The confirmation shown BEFORE money moves. It must say: how much, to whom,
 * which tickets, and that those tickets stop being valid. It also warns when
 * some tickets have already been used, because the refund still goes ahead
 * for the whole order.
 */
export function refundConfirmation(o: OrderLike): { title: string; message: string; confirmLabel: string } {
  const amount = pounds(o.total_pence);
  const who = o.purchaser.name?.trim()
    ? `${o.purchaser.name.trim()}${o.purchaser.email ? ` (${o.purchaser.email})` : ''}`
    : (o.purchaser.email?.trim() || 'the purchaser');
  const used = o.checked_in_count;
  const lines = [
    `You are about to refund ${amount} to ${who}.`,
    `Tickets: ${ticketSummary(o)}.`,
    o.tickets_count === 1
      ? 'The ticket will no longer be valid and cannot be used to enter.'
      : `All ${o.tickets_count} tickets in this order will no longer be valid and cannot be used to enter.`,
  ];
  if (used > 0) {
    lines.push(`${used === 1 ? '1 ticket has' : `${used} tickets have`} already been checked in; that attendance stays on record, but the money for the whole order is still refunded.`);
  }
  lines.push('The whole order is refunded, the payment is taken back from your event payout, and this cannot be undone.');
  return { title: 'Refund this order?', message: lines.join('\n\n'), confirmLabel: `Refund ${amount}` };
}

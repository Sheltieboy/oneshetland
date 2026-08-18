/**
 * ticket-receipt.ts — the ticket purchase receipt, in ONE place.
 *
 * FOUR different places mark a ticket order paid:
 *   • create-event-ticket-intent — free orders
 *   • create-event-ticket-intent — paid from wallet balance
 *   • create-event-ticket-intent — saved card charged off-session
 *   • confirm-event-tickets / _shared/fulfilment.ts — the interactive card flow
 *
 * Chasing "the" path is how this went unsent twice: whichever one gets there
 * first marks the order paid, and every other path then short-circuits on
 * `already paid` — including, as it turned out, the two I had added the receipt
 * to. The webhook log said it plainly: "fulfil event_tickets: already paid".
 *
 * So this is IDEMPOTENT instead. Call it from anywhere, as often as you like;
 * it checks whether a receipt for this order has already gone out and does
 * nothing if so. That makes "call it everywhere" the correct, safe answer.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from './send-email.ts';

const SITE = 'https://oneshetland.com';
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;

export async function sendTicketReceipt(
  svc: SupabaseClient,
  orderId: string,
  buyerId: string,
): Promise<void> {
  try {
    // Already sent one for this order? Then stop. This is what makes it safe to
    // call from every path that can mark an order paid.
    const { data: prior } = await svc
      .from('email_log')
      .select('id')
      .eq('template_key', 'events.tickets_confirmed')
      .eq('metadata->>order_id', orderId)
      .limit(1);
    if (prior && prior.length) return;

    const { data: order } = await svc
      .from('event_ticket_orders')
      .select('id, event_id, tickets_count, total_pence, platform_fee_pence')
      .eq('id', orderId).maybeSingle();
    if (!order) return;

    const { data: event } = await svc
      .from('events')
      .select('title, starts_at, venue, locality, organiser_business_id, organiser_hub_id')
      .eq('id', order.event_id).maybeSingle();
    if (!event) return;

    const { data: u } = await svc.auth.admin.getUserById(buyerId);
    const email = u?.user?.email;
    if (!email) return;

    const meta = u?.user?.user_metadata ?? {};
    const buyerName =
      (meta.first_name as string | undefined) ??
      (meta.full_name as string | undefined)?.split(' ')[0] ?? 'there';

    const { data: tix } = await svc
      .from('event_tickets').select('backup_code').eq('order_id', orderId);
    const codes = (tix ?? [])
      .map((t: { backup_code: string | null }) => t.backup_code)
      .filter(Boolean) as string[];

    let organiser = 'the organiser';
    if (event.organiser_business_id) {
      const { data: b } = await svc.from('local_businesses').select('name').eq('id', event.organiser_business_id).maybeSingle();
      if (b?.name) organiser = b.name;
    } else if (event.organiser_hub_id) {
      const { data: h } = await svc.from('hubs').select('name').eq('id', event.organiser_hub_id).maybeSingle();
      if (h?.name) organiser = h.name;
    }

    const fee = order.platform_fee_pence ?? 0;
    const total = order.total_pence ?? 0;

    await sendEmail(svc, {
      templateKey: 'events.tickets_confirmed',
      recipientEmail: email,
      recipientId: buyerId,
      variables: {
        buyer_name:   buyerName,
        event_title:  event.title,
        // Europe/London: an event at 8pm must not read as 7pm in the email
        // somebody is using to decide when to set off.
        event_when:   new Date(event.starts_at).toLocaleString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long',
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
        }),
        event_where:  [event.venue, event.locality].filter(Boolean).join(', ') || 'See the event page',
        ticket_count: `${order.tickets_count} ticket${order.tickets_count !== 1 ? 's' : ''}`,
        ticket_codes: codes.length
          ? codes.map(c => `<strong style="font-family:Menlo,Consolas,monospace;background:#F0F2F5;padding:8px 16px;border-radius:6px;font-size:18px;letter-spacing:2px;color:#032F4C;display:inline-block;margin:4px">${c}</strong>`).join('')
          : '<span style="color:#6B7280">Open your account to see your tickets.</span>',
        tickets_total:  gbp(total - fee),
        booking_fee:    gbp(fee),
        total_paid:     gbp(total),
        tickets_url:    `${SITE}/account/tickets`,
        organiser_name: organiser,
      },
      metadata: { order_id: orderId, event_id: order.event_id },
    });
  } catch (e) {
    // A receipt must never fail fulfilment — the tickets are valid and the money
    // is taken either way.
    console.error('[ticket-receipt] failed:', e);
  }
}

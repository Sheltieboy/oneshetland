/**
 * booking-notify-auth.ts — who may make notify-booking fire for a given booking.
 *
 * notify-booking checked only that the caller was signed in. booking_id came
 * straight from the request body, so any account could ask it to tell a real
 * business owner or a real customer about a booking that was never theirs —
 * notification spam in OneShetland's name, from a member, about someone else's
 * appointment.
 *
 * The gate ties the caller to the booking's two genuine parties: the customer
 * who made it, or the business that was booked.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export type BookingNotifyEvent = 'created' | 'cancelled';

export async function authoriseBookingNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; bookingId: unknown },
): Promise<NotifyDecision> {
  const { event, bookingId } = input;
  if (!event || !bookingId) return denyNotify(400, 'booking_id and event required');
  if (caller.isServiceRole) return { ok: true };
  // An event this gate doesn't recognise is left to the handler's own
  // "unknown event" 400 — this is an authorisation check, not a schema one.
  if (event !== 'created' && event !== 'cancelled') return { ok: true };
  if (!isUuid(bookingId)) return denyNotify(400, 'booking_id and event required');

  const { data: booking } = await svc
    .from('book_bookings').select('customer_id, business_id')
    .eq('id', bookingId).maybeSingle();
  if (!booking) return denyNotify(404, 'booking not found');
  if (booking.customer_id === caller.userId) return { ok: true };

  const { data: biz } = await svc
    .from('local_businesses').select('owner_id')
    .eq('id', booking.business_id).maybeSingle();
  if ((biz as { owner_id?: string } | null)?.owner_id === caller.userId) return { ok: true };

  return denyNotify(403, 'Not allowed');
}

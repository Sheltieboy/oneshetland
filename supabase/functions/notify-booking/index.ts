import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';

/**
 * notify-booking
 *
 * Booking notifications (the booking flow is otherwise client-side and silent):
 *   event 'created'   → notify the business OWNER of the new booking.
 *   event 'cancelled' → notify the OTHER party (if the customer cancelled, tell
 *                       the owner; if the owner cancelled, tell the customer).
 *
 * Body: { booking_id: string, event: 'created' | 'cancelled' }
 * Fire-and-forget — best effort, never blocks the caller.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const londonWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { booking_id, event } = await req.json();
    if (!booking_id || !event) return json({ error: 'booking_id and event required' }, 400);

    const svc = createServiceClient();

    const { data: b } = await svc
      .from('book_bookings')
      .select('id, business_id, service_id, customer_id, starts_at, cancelled_by')
      .eq('id', booking_id)
      .maybeSingle();
    if (!b) return json({ error: 'booking not found' }, 404);

    const [{ data: biz }, { data: svcRow }, { data: cust }] = await Promise.all([
      svc.from('local_businesses').select('owner_id, name').eq('id', b.business_id).maybeSingle(),
      svc.from('book_services').select('name').eq('id', b.service_id).maybeSingle(),
      svc.from('profiles').select('full_name').eq('id', b.customer_id).maybeSingle(),
    ]);

    const bizName     = biz?.name ?? 'the business';
    const serviceName = svcRow?.name ?? 'an appointment';
    const custName    = cust?.full_name ?? 'A customer';
    const when        = londonWhen(b.starts_at);

    if (event === 'created') {
      if (!biz?.owner_id) return json({ ok: true, notified: 0 });
      await sendUserPush(svc, {
        userId:     biz.owner_id,
        module:     'business',
        categoryId: 'business.new_booking',
        title:      'New booking 📅',
        body:       `${custName} booked ${serviceName} on ${when}.`,
        data:       { screen: 'local-business-dashboard', booking_id: b.id },
      });
      return json({ ok: true, notified: 1 });
    }

    if (event === 'cancelled') {
      const cancelledByCustomer = b.cancelled_by === b.customer_id;
      if (cancelledByCustomer) {
        // Tell the owner.
        if (!biz?.owner_id) return json({ ok: true, notified: 0 });
        await sendUserPush(svc, {
          userId:     biz.owner_id,
          module:     'business',
          categoryId: 'business.booking_cancelled',
          title:      'Booking cancelled',
          body:       `${custName} cancelled their ${serviceName} on ${when}.`,
          data:       { screen: 'local-business-dashboard', booking_id: b.id },
        });
      } else {
        // Owner cancelled — tell the customer.
        await sendUserPush(svc, {
          userId:     b.customer_id,
          module:     'bookings',
          categoryId: 'bookings.cancelled',
          title:      'Booking cancelled',
          body:       `Your ${serviceName} at ${bizName} on ${when} has been cancelled.`,
          data:       { screen: 'local-my-bookings', booking_id: b.id },
        });
      }
      return json({ ok: true, notified: 1 });
    }

    return json({ error: 'unknown event' }, 400);
  } catch (err) {
    console.error('[notify-booking]', err);
    return json({ error: safeError('notify-booking', err) }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * notify-event-update
 *
 * When an organiser posts an update on an event (cancellation, venue/time
 * change, weather, urgent info), tell everyone holding a valid ticket. This was
 * previously silent — a cancelled event never reached the people who'd paid.
 *
 * Body: { update_id: string }
 * Module 'events'. Cancellations / changes are urgent (bypass quiet hours).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const URGENT_KINDS = ['urgent', 'cancellation', 'venue_change', 'time_change', 'weather'];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { update_id } = await req.json();
    if (!update_id) return json({ error: 'update_id required' }, 400);
    const svc = createServiceClient();

    const { data: upd } = await svc
      .from('event_updates').select('event_id, title, body, kind').eq('id', update_id).maybeSingle();
    if (!upd) return json({ error: 'update not found' }, 404);

    const { data: ev } = await svc
      .from('events').select('title').eq('id', upd.event_id).maybeSingle();
    const eventTitle = (ev as { title?: string } | null)?.title ?? 'your event';

    // Everyone holding a valid ticket.
    const { data: tickets } = await svc
      .from('event_tickets').select('holder_id').eq('event_id', upd.event_id).eq('status', 'valid');
    const ids = [...new Set((tickets ?? []).map(t => t.holder_id).filter(Boolean) as string[])];
    if (ids.length === 0) return json({ ok: true, notified: 0 });

    const cancelled = upd.kind === 'cancellation';
    const title = cancelled ? `${eventTitle} — cancelled` : `${eventTitle}: ${upd.title}`;
    const body  = cancelled
      ? `Sorry — "${eventTitle}" has been cancelled. ${upd.body}`.trim()
      : upd.body;

    const { sent } = await sendUserPushBulk(svc, ids, {
      module:     'events',
      categoryId: cancelled ? 'events.cancelled' : 'events.update',
      urgent:     URGENT_KINDS.includes(upd.kind),
      title,
      body,
      data: { event_id: upd.event_id, screen: 'my-event-tickets' },
    });
    return json({ ok: true, notified: sent });
  } catch (err) {
    console.error('[notify-event-update]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

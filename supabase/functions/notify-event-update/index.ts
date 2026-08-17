import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';
import { sendEmail } from '../_shared/send-email.ts';

/**
 * notify-event-update
 *
 * When an organiser posts an update on an event (cancellation, venue/time
 * change, weather, urgent info), tell everyone holding a valid ticket.
 *
 * THREE CHANNELS, AND WHY.
 * Push and the on-site inbox alone were not enough. Push reaches nobody today —
 * the app is unpublished, so push_tokens is empty — and the inbox only works for
 * somebody who comes back to the site. The person who most needs to hear that an
 * event is cancelled is a visitor who bought one ticket, is not a regular, and
 * will never look again. That is what email is for, and it is why cancellations
 * ignore quiet hours and notification preferences: this is not marketing, it is
 * the thing they paid for not happening.
 *
 * Email is sent for every kind of update. It is capped at one send per holder
 * per update by the caller creating exactly one event_updates row.
 *
 * Body: { update_id: string }
 * Module 'events'. Cancellations / changes are urgent (bypass quiet hours).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const URGENT_KINDS = ['urgent', 'cancellation', 'venue_change', 'time_change', 'weather'];
const SITE = 'https://oneshetland.com';

/** "Saturday 20 June at 7:00pm", in Shetland's timezone. */
function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'See the event page';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'See the event page';
  // Europe/London, not UTC — an event at 8pm must not read as 7pm in an email
  // somebody is using to decide whether to set off.
  return d.toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

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
      .from('events')
      .select('title, starts_at, venue, locality, organiser_business_id, organiser_hub_id')
      .eq('id', upd.event_id).maybeSingle();
    const eventTitle = (ev as { title?: string } | null)?.title ?? 'your event';

    // Who to name as the organiser in the email. Falls back to OneShetland
    // rather than leaving a blank where a name should be.
    let organiserName = 'The organiser';
    if (ev?.organiser_business_id) {
      const { data: b } = await svc.from('local_businesses').select('name').eq('id', ev.organiser_business_id).maybeSingle();
      if (b?.name) organiserName = b.name;
    } else if (ev?.organiser_hub_id) {
      const { data: h } = await svc.from('hubs').select('name').eq('id', ev.organiser_hub_id).maybeSingle();
      if (h?.name) organiserName = h.name;
    }

    // Everyone holding a valid ticket.
    const { data: tickets } = await svc
      .from('event_tickets').select('holder_id').eq('event_id', upd.event_id).eq('status', 'valid');
    const ids = [...new Set((tickets ?? []).map(t => t.holder_id).filter(Boolean) as string[])];
    if (ids.length === 0) return json({ ok: true, notified: 0, emailed: 0 });

    const cancelled = upd.kind === 'cancellation';
    const title = cancelled ? `${eventTitle} — cancelled` : `${eventTitle}: ${upd.title}`;
    const body  = cancelled
      ? `Sorry — "${eventTitle}" has been cancelled. ${upd.body}`.trim()
      : upd.body;

    // ── Push + on-site inbox ────────────────────────────────────────────────
    const { sent } = await sendUserPushBulk(svc, ids, {
      module:     'events',
      categoryId: cancelled ? 'events.cancelled' : 'events.update',
      urgent:     URGENT_KINDS.includes(upd.kind),
      title,
      body,
      data: { event_id: upd.event_id, screen: 'my-event-tickets' },
    });

    // ── Email ───────────────────────────────────────────────────────────────
    // Addresses live on auth.users, not profiles, so they come from the admin
    // API one at a time. Ticket counts per event are small; if that ever stops
    // being true this wants batching.
    const where = [ev?.venue, ev?.locality].filter(Boolean).join(', ') || 'See the event page';
    const when  = formatWhen(ev?.starts_at as string | undefined);
    let emailed = 0;

    for (const uid of ids) {
      try {
        const { data: u } = await svc.auth.admin.getUserById(uid);
        const email = u?.user?.email;
        if (!email) continue;

        const meta = u?.user?.user_metadata ?? {};
        const firstName =
          (meta.first_name as string | undefined) ??
          (meta.full_name as string | undefined)?.split(' ')[0] ??
          'there';

        const res = await sendEmail(svc, {
          templateKey: cancelled ? 'events.cancelled' : 'events.update',
          recipientEmail: email,
          recipientId: uid,
          variables: {
            recipient_name: firstName,
            organiser_name: organiserName,
            event_title:    eventTitle,
            update_title:   upd.title ?? '',
            update_body:    upd.body ?? '',
            event_when:     when,
            event_where:    where,
            event_url:      `${SITE}/whats-on/${upd.event_id}`,
            tickets_url:    `${SITE}/account/tickets`,
          },
          metadata: { event_id: upd.event_id, update_id, kind: upd.kind },
        });
        if (res.ok) emailed++;
      } catch (e) {
        // One bad address must not stop the rest of the room being told.
        console.error(`[notify-event-update] email failed for ${uid}:`, e);
      }
    }

    return json({ ok: true, notified: sent, emailed });
  } catch (err) {
    console.error('[notify-event-update]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

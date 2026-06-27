import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * notify-hub-content
 *
 * Tells a hub's active members when the hub posts something new:
 *   event 'notice' { hub_id, ref_id, title } → "New notice from {hub}"
 *   event 'event'  { hub_id, ref_id, title } → "{hub} has a new event"
 *
 * Module 'hubs'. Members can mute via the Hubs toggle. Fire-and-forget.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { event, hub_id, ref_id, title } = await req.json();
    if (!event || !hub_id) return json({ error: 'event and hub_id required' }, 400);
    const svc = createServiceClient();

    const { data: hub } = await svc.from('hubs').select('name').eq('id', hub_id).maybeSingle();
    const hubName = (hub as { name?: string } | null)?.name ?? 'your hub';

    // Active, non-expired members.
    const nowIso = new Date().toISOString();
    const { data: members } = await svc
      .from('hub_members').select('user_id')
      .eq('hub_id', hub_id).eq('status', 'active')
      .or(`paid_until.is.null,paid_until.gt.${nowIso}`);
    const ids = [...new Set((members ?? []).map(m => m.user_id).filter(Boolean) as string[])];
    if (ids.length === 0) return json({ ok: true, notified: 0 });

    const isEvent = event === 'event';
    const data = isEvent
      ? { event_id: ref_id, hub_id }
      : { hub_id };
    const { sent } = await sendUserPushBulk(svc, ids, {
      module:     'hubs',
      categoryId: isEvent ? 'hubs.new_event' : 'hubs.new_notice',
      title:      isEvent ? `${hubName} — new event` : `New notice from ${hubName}`,
      body:       title ?? (isEvent ? 'A new event has been added.' : 'A new notice has been posted.'),
      data,
    });
    return json({ ok: true, notified: sent });
  } catch (err) {
    console.error('[notify-hub-content]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

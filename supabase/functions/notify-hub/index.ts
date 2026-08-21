import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-hub
 *
 * Push notifications for hub membership events:
 *   join_request   → notify hub admins (someone asked to join)
 *   membership_paid→ notify hub admins (a paid member joined)
 *   approved       → notify the member (their request was approved)
 *
 * Body: { event: 'join_request' | 'membership_paid' | 'approved', hub_id, user_id }
 * Fire-and-forget — best effort, never blocks the caller.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { event, hub_id, user_id } = await req.json();
    if (!event || !hub_id) return json({ error: 'event and hub_id required' }, 400);

    const { data: hub } = await svc.from('hubs').select('name').eq('id', hub_id).maybeSingle();
    const hubName = hub?.name ?? 'your hub';

    // Actor's display name (the person joining), when relevant.
    let actorName = 'Someone';
    if (user_id) {
      const { data: p } = await svc.from('profiles').select('full_name').eq('id', user_id).maybeSingle();
      if (p?.full_name) actorName = p.full_name;
    }

    // Resolve recipient user ids.
    let recipientIds: string[] = [];
    if (event === 'approved') {
      if (!user_id) return json({ error: 'user_id required' }, 400);
      recipientIds = [user_id];
    } else {
      // Admins (owner/committee) of the hub.
      const { data: admins } = await svc
        .from('hub_members')
        .select('user_id')
        .eq('hub_id', hub_id)
        .in('role', ['owner', 'committee'])
        .eq('status', 'active');
      recipientIds = (admins ?? []).map(a => a.user_id);
    }

    let title = '', body = '', categoryId = '';
    if (event === 'join_request')         { title = 'New member request'; body = `${actorName} asked to join ${hubName}.`;          categoryId = 'hubs.member_request'; }
    else if (event === 'membership_paid') { title = 'New member 🎉';       body = `${actorName} joined ${hubName} as a paying member.`; categoryId = 'hubs.member_joined'; }
    else if (event === 'approved')        { title = "You're in 🎉";        body = `You're now a member of ${hubName}.`;                categoryId = 'hubs.membership_approved'; }
    else return json({ error: 'unknown event' }, 400);

    // Preference-aware: honours each recipient's hubs toggle + quiet hours,
    // and logs to their inbox.
    const { sent } = await sendUserPushBulk(svc, recipientIds, {
      module: 'hubs',
      categoryId,
      title,
      body,
      data: { hub_id, type: 'hub_membership' },
    });

    return json({ ok: true, notified: sent });
  } catch (err) {
    console.error('[notify-hub]', err);
    return json({ error: safeError('notify-hub', err) }, 500);
  }
});

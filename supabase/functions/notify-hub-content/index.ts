import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { authoriseHubContentNotify } from '../_shared/hub-content-notify-auth.ts';
import { isUuid } from '../_shared/notify-decision.ts';
import { runDispatch, noticePushText } from '../_shared/notice-dispatch.ts';

/**
 * notify-hub-content
 *
 * Tells a hub's active members when the hub posts something new:
 *   event 'notice' { hub_id, ref_id, title } → "New notice from {hub}"
 *   event 'event'  { hub_id, ref_id, title } → "{hub} has a new event"
 *
 * Module 'hubs'. Members can mute via the Hubs toggle. Fire-and-forget.
 *
 * R2 (Notices & Alerts): the 'notice' event used to announce WHATEVER ref_id and title the caller sent, with no check that the notice exists, belongs to the
 * hub, or is live. It now announces only a notice the DATABASE says is dispatchable to hub members (published, started, unexpired, not hidden, public or
 * members-only, a hub notice - never an official import, never a pending / withdrawn / resolved / scheduled / committee-only one), takes the text from the
 * stored notice (the caller's `title` is ignored), and announces it ONCE (a repeat call, or one after an edit, is refused with 409). The 'event' event is unchanged.
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
    // The gateway's verify_jwt accepts the PUBLIC ANON KEY, so it is a shape
    // check, not an authorisation check. This is the authorisation check.
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    // Owning a resource is permission to notify about it, not permission to
    // do so without limit. A service-role caller is our own backend, not the
    // internet, so it is not throttled.
    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('notify-hub-content', userSubject(caller.userId), ['notify_fanout', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    const { event, hub_id, ref_id, title } = await req.json();
    if (!event || !hub_id) return json({ error: 'event and hub_id required' }, 400);
    if (event !== 'notice' && event !== 'event') return json({ error: 'Unknown event' }, 400);
    const svc = createServiceClient();

    // Only the hub's owner or admin may push to its whole membership.
    const decision = await authoriseHubContentNotify(svc, caller, { event, hubId: hub_id });
    if (!decision.ok) return json({ error: decision.error }, decision.status);

    const { data: hub } = await svc.from('hubs').select('name').eq('id', hub_id).maybeSingle();
    const hubName = (hub as { name?: string } | null)?.name ?? 'your hub';

    if (event === 'notice') {
      if (!isUuid(ref_id)) return json({ error: 'ref_id (the notice) is required' }, 400);
      const { data: notice } = await svc.from('notices').select('id, title, publisher_hub_id').eq('id', ref_id).maybeSingle();
      if (!notice) return json({ error: 'That notice does not exist' }, 404);
      if ((notice as { publisher_hub_id?: string }).publisher_hub_id !== hub_id) return json({ error: 'That notice does not belong to this hub' }, 400);
      const text = noticePushText('hub', notice as { title: string }, hubName);
      const outcome = await runDispatch({
        rpc: (fn, args) => svc.rpc(fn, args) as never,
        authorise: async () => ({ ok: true as const }),                       // the hub-owner / admin check above already ran
        send: (userId) => sendUserPush(svc, {
          userId, module: 'hubs', categoryId: 'hubs.new_notice', title: text.title, body: text.body, data: { hub_id, notice_id: ref_id }, urgent: false,
        }),
      }, { type: 'notice', id: ref_id, kind: 'hub', by: caller.isServiceRole ? null : caller.userId });
      return outcome.ok ? json({ ok: true, notified: outcome.sent }) : json({ error: outcome.error }, outcome.status);
    }

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
    return json({ error: safeError('notify-hub-content', err) }, 500);
  }
});

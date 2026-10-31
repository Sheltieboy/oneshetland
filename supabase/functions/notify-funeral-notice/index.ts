import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { isUuid } from '../_shared/notify-decision.ts';
import { runDispatch } from '../_shared/notice-dispatch.ts';

/**
 * notify-funeral-notice — announce ONE approved funeral notice, once, to members who separately opted in to funeral announcements and follow its area.
 *
 *   body { funeral_id }
 *
 * Staff (administrator or moderator) only, and only for a notice the FAMILY approved for notification (announce_in_notifications). The text is produced by the
 * database (funeral_notification_text): discreet by default ("A notice has been published for the <area> area"), a name only if the family said so. It is
 * never combined with emergency alerts, never urgent (quiet hours apply), and cannot repeat. Preview content is whatever that function returns - nothing from
 * the request.
 */
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;
    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('notify-funeral-notice', userSubject(caller.userId), ['notify_fanout', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }
    const { funeral_id } = await req.json().catch(() => ({}));
    if (!isUuid(funeral_id)) return json({ error: 'funeral_id is required' }, 400);
    const svc = createServiceClient();
    const { data: rows } = await svc.rpc('funeral_notification_text', { p_id: funeral_id });
    const text = (rows as { title: string; body: string }[] | null)?.[0];
    if (!text) return json({ error: 'That notice does not exist' }, 404);

    const outcome = await runDispatch({
      rpc: (fn, args) => svc.rpc(fn, args) as never,
      authorise: async () => {
        if (caller.isServiceRole) return { ok: true as const };
        const { data } = await svc.rpc('can_dispatch_funeral', { p_user: caller.userId });
        return data === true ? { ok: true as const } : { ok: false as const, status: 403, error: 'Not allowed' };
      },
      send: (userId) => sendUserPush(svc, {
        userId, module: 'notices', categoryId: 'notices.funeral', title: text.title, body: text.body,
        data: { screen: 'notices', tab: 'funeral', funeral_id }, urgent: false,
      }),
    }, { type: 'funeral', id: funeral_id, kind: 'funeral', by: caller.isServiceRole ? null : caller.userId });
    return outcome.ok ? json(outcome) : json({ error: outcome.error }, outcome.status);
  } catch (err) {
    console.error('[notify-funeral-notice]', err);
    return json({ error: safeError('notify-funeral-notice', err) }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { isUuid } from '../_shared/notify-decision.ts';
import { runDispatch, noticePushText, AUDIENCE_KINDS, type DispatchKind } from '../_shared/notice-dispatch.ts';

/**
 * notify-notice-audience — announce ONE notice, ONCE, to the members who opted in to that audience and follow its areas.
 *
 *   body { notice_id, kind }   kind: 'essential' | 'official' | 'community'
 *
 * Nothing in the request chooses recipients, text or urgency. The caller's authority is decided by the database (can_dispatch_notice: a 'publisher' member
 * of the notice's verified organisation holding the live Essential Alert entitlement; any member of that organisation for an official notice; the hub
 * owner / committee or business owner for a community notice; a platform administrator for any). Eligibility, the once-only claim, the audience and the
 * per-member deduplication are all database functions (see _shared/notice-dispatch.ts). Official IMPORTS can never be announced (refused in four places).
 * Quiet hours, the master switch, the notices toggle and device tokens are applied per member by sendUserPush; this function never sets `urgent`.
 * Editing or resolving a notice never calls this: it is a separate, deliberate request.
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
      const limited = await enforceRateLimit('notify-notice-audience', userSubject(caller.userId), ['notify_fanout', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }
    const { notice_id, kind } = await req.json().catch(() => ({}));
    if (!isUuid(notice_id) || !(AUDIENCE_KINDS as readonly string[]).includes(kind)) return json({ error: 'notice_id and a valid kind are required' }, 400);
    const svc = createServiceClient();
    const { data: notice } = await svc.from('notices').select('id, title, body, action_text').eq('id', notice_id).maybeSingle();
    if (!notice) return json({ error: 'That notice does not exist' }, 404);
    const text = noticePushText(kind as DispatchKind, notice as { title: string; body?: string; action_text?: string });

    const outcome = await runDispatch({
      rpc: (fn, args) => svc.rpc(fn, args) as never,
      authorise: async () => {
        if (caller.isServiceRole) return { ok: true as const };
        const { data } = await svc.rpc('can_dispatch_notice', { p_user: caller.userId, p_notice: notice_id, p_kind: kind });
        return data === true ? { ok: true as const } : { ok: false as const, status: 403, error: 'Not allowed' };
      },
      send: (userId) => sendUserPush(svc, {
        userId, module: 'notices', categoryId: `notices.${kind}`, title: text.title, body: text.body,
        data: { screen: 'notices', notice_id }, urgent: false,                 // quiet hours are honoured; there is no bypass here
      }),
    }, { type: 'notice', id: notice_id, kind: kind as DispatchKind, by: caller.isServiceRole ? null : caller.userId });
    return outcome.ok ? json(outcome) : json({ error: outcome.error }, outcome.status);
  } catch (err) {
    console.error('[notify-notice-audience]', err);
    return json({ error: safeError('notify-notice-audience', err) }, 500);
  }
});

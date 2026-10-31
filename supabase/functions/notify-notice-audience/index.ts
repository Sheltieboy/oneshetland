import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { handleNoticeAudience } from '../_shared/notice-audience.ts';

/**
 * notify-notice-audience — announce ONE notice, ONCE, to the members who opted in to that audience and follow its areas.
 *
 *   body { notice_id, kind }   kind: 'essential' | 'official' | 'community' | 'member'
 *
 * The behaviour is in _shared/notice-audience.ts (shared with the local tests); this file only supplies the Deno environment: the verified caller, the
 * service-role client, the per-user rate limit and the existing push sender (sendUserPush, which still applies the master switch, the notices module toggle,
 * quiet hours and device tokens, and is ALWAYS called with urgent:false: there is no quiet-hours bypass here).
 * kind 'member' = a moderator's deliberate "Notify opted-in members" for an approved personal notice. Only staff may; approving never calls this.
 */
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

serve(async (req) => {
  try {
    const svc = createServiceClient();
    return await handleNoticeAudience(req, {
      cors: corsHeaders,
      authenticate: (r) => requireCaller(r, corsHeaders),
      limit: async (caller) => {
        const limited = await enforceRateLimit('notify-notice-audience', userSubject(caller.userId), ['notify_fanout', 'notify_any'], corsHeaders);
        return 'denied' in limited ? limited.denied : null;
      },
      rpc: (fn, args) => svc.rpc(fn, args) as never,
      loadNotice: async (id) => { const { data } = await svc.from('notices').select('id, title, body, action_text').eq('id', id).maybeSingle(); return (data as never) ?? null; },
      push: (userId, text, ctx) => sendUserPush(svc, {
        userId, module: 'notices', categoryId: `notices.${ctx.kind}`, title: text.title, body: text.body,
        data: { screen: 'notices', notice_id: ctx.noticeId }, urgent: false,
      }),
    });
  } catch (err) {
    console.error('[notify-notice-audience]', err);
    return new Response(JSON.stringify({ error: safeError('notify-notice-audience', err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

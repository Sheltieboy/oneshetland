import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { broadcastRefusal } from '../_shared/notice-broadcast.ts';

/**
 * notify-community-notice — the island-wide urgent channel.
 *
 * Business alerts reach a business's own loyalty customers, and hub notices
 * reach that hub's members. Neither can say "the Sumburgh road is shut" to
 * everyone. This can.
 *
 * Because it can reach everyone, it is deliberately hard to fire:
 *   • platform admins only (profiles.role = 'admin');
 *   • the notice must already be published, public, visible and unexpired,
 *     with severity 'urgent' — you broadcast an existing notice rather than
 *     composing a new message here, so what people get is what they'll read.
 *     "Published" means status = 'published' AND started (starts_at null or
 *     past), checked here on the authoritative row (this function reads with
 *     the service role, so row-level security does not do it for us), and
 *     checked AGAIN inside the claim so a notice withdrawn a moment after the
 *     first read is not sent. Nothing in the request but notice_id is trusted;
 *   • an official IMPORTED notice (notices.source IS NOT NULL) can never be
 *     sent, in any state — imports are silent by product rule — and that is
 *     checked on the authoritative row and again inside the claim;
 *   • `broadcast_at` is claimed before sending, so a double-tap or a retry
 *     can't push the island twice;
 *   • sent urgent, which bypasses quiet hours. That is the whole point of the
 *     channel and also why it is admin-only — a 3am push had better be worth
 *     waking folk for.
 *
 * Recipients are everyone with a registered device who hasn't switched the
 * `notices` module off.
 *
 * Body: { notice_id }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    // Counted against notify_any as well as its own route: the aggregate only
    // means anything if every notification path claims it.
    const limited = await enforceRateLimit('notify-community-notice', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Platform admins only.
    const { data: me } = await svc.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role !== 'admin') return json({ error: 'Admins only' }, 403);

    const { notice_id } = await req.json();
    if (!notice_id) return json({ error: 'notice_id required' }, 400);

    const { data: notice } = await svc
      .from('notices')
      .select('id, title, body, severity, visibility, is_hidden, status, starts_at, expires_at, source, locality, broadcast_at')
      .eq('id', notice_id)
      .maybeSingle();

    if (!notice) return json({ error: 'Notice not found' }, 404);
    // One clock reading for both the check and the claim, as an absolute instant.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const refusal = broadcastRefusal(notice, nowMs);
    if (refusal) return json(refusal.status === 409 ? { error: refusal.error, sent: 0 } : { error: refusal.error }, refusal.status);

    // Claim it BEFORE sending. If the send then fails we've lost a broadcast
    // rather than sent two — the safer way round when the whole island is on
    // the other end.
    const { data: claimed, error: claimErr } = await svc
      .from('notices')
      .update({ broadcast_at: nowIso, broadcast_by: user.id })
      .eq('id', notice.id)
      .is('broadcast_at', null)
      // Same eligibility, enforced by the database in the same statement as the claim: if the notice was withdrawn, hidden,
      // expired or made non-public between the read above and now, nothing is claimed and nothing is sent.
      .is('source', null)   // official imports are silent: the same rule, enforced in the claim itself
      .eq('severity', 'urgent').eq('visibility', 'public').eq('is_hidden', false).eq('status', 'published')
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .select('id')
      .maybeSingle();
    if (claimErr) return json({ error: claimErr.message }, 500);
    if (!claimed) {
      // Lost the claim: either it was already sent, or it stopped being eligible a moment ago.
      const { data: again } = await svc.from('notices').select('broadcast_at').eq('id', notice.id).maybeSingle();
      if (!again) return json({ error: 'Notice not found' }, 404);
      if (again.broadcast_at) return json({ error: 'Already sent to everyone', sent: 0 }, 409);
      return json({ error: 'That notice is no longer available to send', sent: 0 }, 409);
    }

    // Everyone with a device: the legacy profiles.push_token and the
    // multi-device push_tokens table both count.
    const recipients = new Set<string>();
    const { data: withCol } = await svc.from('profiles').select('id').not('push_token', 'is', null);
    for (const r of withCol ?? []) recipients.add(r.id as string);
    const { data: toks } = await svc.from('push_tokens').select('user_id');
    for (const r of toks ?? []) if (r.user_id) recipients.add(r.user_id as string);

    const where = notice.locality ? `${notice.locality}: ` : '';
    const body = (notice.body ?? '').trim();
    const res = await sendUserPushBulk(svc, [...recipients], {
      module:     'notices',
      categoryId: 'notices.urgent',
      title:      `⚠️ ${notice.title}`,
      body:       where + (body.length > 160 ? `${body.slice(0, 157)}…` : body || 'Tap for details.'),
      data:       { screen: 'notices', notice_id: notice.id },
      urgent:     true,
    });

    return json({ ok: true, notice_id: notice.id, recipients: recipients.size, sent: res.sent });
  } catch (err) {
    console.error('[notify-community-notice]', err);
    return json({ error: safeError('notify-community-notice', err) }, 500);
  }
});

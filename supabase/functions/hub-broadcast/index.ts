import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * hub-broadcast
 *
 * A hub owner/committee messages the whole active membership via push and/or
 * email. Admin-only. Best-effort per recipient.
 *
 * Body: { hub_id, title, message, channel: 'push' | 'email' | 'both' }
 */
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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('hub-broadcast', userSubject(user.id), ['notify_broadcast', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { hub_id, title, message, channel = 'push' } = await req.json();
    if (!hub_id || !title?.trim() || !message?.trim()) {
      return json({ error: 'hub_id, title and message are required' }, 400);
    }

    // Authorisation: caller must be an owner/committee of this hub.
    const { data: isAdmin } = await svc.rpc('is_hub_admin', { p_hub: hub_id, p_user: user.id });
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);

    const { data: hub } = await svc.from('hubs').select('name').eq('id', hub_id).maybeSingle();
    const hubName = hub?.name ?? 'your hub';

    // Active members (not expired).
    const nowIso = new Date().toISOString();
    const { data: members } = await svc
      .from('hub_members')
      .select('user_id')
      .eq('hub_id', hub_id)
      .eq('status', 'active')
      .or(`paid_until.is.null,paid_until.gt.${nowIso}`);
    const ids = (members ?? []).map(m => m.user_id);
    if (ids.length === 0) return json({ ok: true, push: 0, email: 0 });

    let pushCount = 0, emailCount = 0;

    // Push (preference-aware: honours each member's hubs toggle + quiet hours
    // and logs to their inbox).
    if (channel === 'push' || channel === 'both') {
      const res = await sendUserPushBulk(svc, ids, {
        module:     'hubs',
        categoryId: 'hubs.broadcast',
        title:      `${hubName}: ${title}`,
        body:       message,
        data:       { hub_id, type: 'hub_broadcast' },
      });
      pushCount = res.sent;
    }

    // Email (via Postmark). Member email lives in auth.users.
    if (channel === 'email' || channel === 'both') {
      const apiKey = Deno.env.get('POSTMARK_API_KEY') ?? '';
      if (apiKey) {
        const html =
          `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">` +
          `<h2 style="color:#0F1C26">${escapeHtml(title)}</h2>` +
          `<p style="color:#374151;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</p>` +
          `<p style="color:#9CA3AF;font-size:12px;margin-top:24px">Sent to members of ${escapeHtml(hubName)} via OneShetland Hubs.</p></div>`;
        await Promise.all(ids.map(async (uid) => {
          try {
            const { data: u } = await svc.auth.admin.getUserById(uid);
            const email = u?.user?.email;
            if (!email) return;
            const res = await fetch('https://api.postmarkapp.com/email', {
              method: 'POST',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': apiKey },
              body: JSON.stringify({
                From: 'OneShetland <orders@oneshetland.com>',
                To: email,
                Subject: `${hubName}: ${title}`,
                HtmlBody: html,
                MessageStream: 'outbound',
              }),
            });
            if (res.ok) emailCount++;
          } catch { /* skip this recipient */ }
        }));
      }
    }

    return json({ ok: true, push: pushCount, email: emailCount, members: ids.length });
  } catch (err) {
    console.error('[hub-broadcast]', err);
    return json({ error: safeError('hub-broadcast', err) }, 500);
  }
});

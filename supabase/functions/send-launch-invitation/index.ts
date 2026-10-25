import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { launchInvitationSend, resolveReplyTo, validMessageStream, validSender, type CampaignFacts, type SendDeps } from '../_shared/launch-invitation-send.ts';
import { postmarkSend } from '../_shared/launch-invitation-postmark.ts';

/**
 * send-launch-invitation
 *
 * Sends ONE launch-partner invitation email: the saved draft for one campaign, to that campaign's saved contact, with
 * that campaign's own private link. It is not a general email relay — there is no field for a recipient, subject, body
 * or sender in the request; those are all read from the database.
 *
 * Body: { campaign_id: uuid, invite_token: string, confirm: { confirm: true, recipient: string, subject: string } }
 *   invite_token  the private link's token (shown to the administrator once, when generated; the database keeps only a hash)
 *   confirm       what the administrator saw in the confirmation dialog; it must still match what is saved
 *
 * ADMIN ONLY. Every database call runs AS the calling administrator (their JWT), so the existing admin gates on those
 * functions apply — this function holds no service-role key and no parallel permission system.
 *
 * Secrets (Supabase function secrets — never exposed to the browser or the web host):
 *   POSTMARK_API_KEY       the existing transactional-email server token
 *   LAUNCH_OUTREACH_FROM   "OneShetland <hello@oneshetland.com>"
 *   LAUNCH_OUTREACH_MESSAGE_STREAM  REQUIRED. The id of the dedicated Postmark stream for Launch Partner outreach (e.g. "launch-partners"). Missing, malformed,
 *                          or one of Postmark's shared streams ('outbound', 'broadcast', 'broadcasts', 'inbound') => the function sends NOTHING and says why.
 *                          There is no default and no fallback to the transactional stream.
 *   LAUNCH_OUTREACH_REPLY_TO (optional) otherwise the bare address of LAUNCH_OUTREACH_FROM
 *   LAUNCH_SITE_ORIGIN     (optional) defaults to https://oneshetland.com
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    // The gateway accepts the public anon key as a JWT; this is the real check.
    const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const limited = await enforceRateLimit('send-launch-invitation', userSubject(user.id), ['email_send'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { data: me } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role !== 'admin') return json({ error: 'Forbidden — admins only' }, 403);

    const raw = await req.text();
    if (raw.length > 4000) return json({ error: 'Request too large' }, 413);
    let body: { campaign_id?: unknown; invite_token?: unknown; confirm?: { confirm?: unknown; recipient?: unknown; subject?: unknown } | null };
    try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const from = validSender(Deno.env.get('LAUNCH_OUTREACH_FROM'));
    const apiKey = Deno.env.get('POSTMARK_API_KEY') ?? '';
    const replyTo = resolveReplyTo(from, Deno.env.get('LAUNCH_OUTREACH_REPLY_TO'));
    const messageStream = validMessageStream(Deno.env.get('LAUNCH_OUTREACH_MESSAGE_STREAM'));
    if (!messageStream) console.error('[send-launch-invitation] LAUNCH_OUTREACH_MESSAGE_STREAM is missing or not allowed — launch sends are disabled');

    const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data as T;
    };

    const deps: SendDeps = {
      origin: Deno.env.get('LAUNCH_SITE_ORIGIN') || 'https://oneshetland.com',
      from: apiKey ? from : null,         // no key => "not configured", before anything is read or reserved
      replyTo: apiKey ? replyTo : null,
      messageStream,                      // null => "no dedicated stream" => nothing is read, reserved or sent
      now: () => new Date(),
      log: (l) => console.error(`[send-launch-invitation] ${l}`),
      async getCampaign(id): Promise<CampaignFacts | null> {
        const c = await rpc<{
          id: string; slug: string; business_id: string; business?: { name?: string }; stage: string; sent_at?: string | null;
          contact_email?: string | null; email_subject?: string | null; email_opening?: string | null; email_body?: string | null;
          invitation?: { status?: string; expires_at?: string | null };
          outreach?: { id?: string } | null;      // present when Launch Partner outreach to this business / address has been stopped
        } | null>('admin_launch_partner_get', { p_id: id });
        if (!c) return null;
        return {
          id: c.id, slug: c.slug, businessId: c.business_id, businessName: c.business?.name ?? '', stage: c.stage, sentAt: c.sent_at ?? null,
          contactEmail: c.contact_email ?? null, subject: c.email_subject ?? null, opening: c.email_opening ?? null, body: c.email_body ?? null,
          invitation: { status: c.invitation?.status ?? 'none', expiresAt: c.invitation?.expires_at ?? null },
          outreachStopped: !!c.outreach,
        };
      },
      async resolveToken(slug, token) {
        const r = await rpc<string | null>('launch_invite_resolve', { p_slug: slug, p_token: token });
        return typeof r === 'string' ? r : null;
      },
      async claimSend(id) { return await rpc<{ ok: true } | { ok: false; reason: 'already_sent' | 'not_ready' | 'send_in_progress' | 'do_not_contact' }>('admin_launch_partner_claim_send', { p_id: id }); },
      async releaseSend(id) { await rpc('admin_launch_partner_release_send', { p_id: id }); },
      async markSent(id, note) { await rpc('admin_launch_partner_mark_sent', { p_id: id, p_note: note }); },
      send: (m) => postmarkSend(fetch as never, apiKey, m),
    };

    const result = await launchInvitationSend({ campaignId: body.campaign_id, token: body.invite_token, confirmation: body.confirm ?? null }, deps);
    // Business refusals are 200 with ok:false so the web client can show the reason; nothing secret is ever in the answer.
    return json(result);
  } catch (err) {
    console.error('[send-launch-invitation]', err);
    return json({ error: safeError('send-launch-invitation', err) }, 500);
  }
});

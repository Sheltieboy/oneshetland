import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-trade-response
 *
 * Closes the loop on Get it done. Two kinds, both sent AFTER the database change has happened:
 *   kind 'interested'  -> the RESIDENT hears that a named trade is interested. Caller must own the matched business.
 *   kind 'shared'      -> the TRADE hears the resident chose to share their details. Caller must be the brief's author.
 * Neither push carries any contact detail: the resident's number is only ever read in the app, by the trade, after the resident shared it.
 * Each push is sent at most once per match (interest_notified_at / share_notified_at), so re-calling it cannot pester anyone.
 * dry_run:true authorises the same way and reports who WOULD be told, sending nothing and stamping nothing.
 *
 * Body: { match_id: string, kind: 'interested' | 'shared', dry_run?: boolean }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const limited = await enforceRateLimit('notify-trade-response', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { match_id, kind, dry_run } = await req.json().catch(() => ({}));
    if (!match_id || (kind !== 'interested' && kind !== 'shared')) return json({ error: 'match_id and kind are required' }, 400);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { data: m } = await svc
      .from('trade_brief_matches')
      .select('id, status, brief_id, business_id, contact_shared_at, interest_notified_at, share_notified_at, local_businesses(owner_id, name), trade_briefs(author_id, title, location_text)')
      .eq('id', match_id)
      .single();
    if (!m) return json({ ok: true, sent: 0 });
    const one = <T,>(v: unknown) => (Array.isArray(v) ? v[0] : v) as T | null;
    const biz = one<{ owner_id: string | null; name: string }>(m.local_businesses);
    const brief = one<{ author_id: string; title: string; location_text: string }>(m.trade_briefs);
    if (!biz || !brief) return json({ ok: true, sent: 0 });

    if (kind === 'interested') {
      if (biz.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);                // only the trade that answered
      if (m.status !== 'interested') return json({ ok: true, sent: 0, reason: 'not_interested' });
      if (m.interest_notified_at) return json({ ok: true, sent: 0, reason: 'already_sent' });
      if (dry_run) return json({ ok: true, dry_run: true, would_notify: 'resident', sent: 0 });
      const r = await sendUserPush(svc, {
        userId: brief.author_id, module: 'community', categoryId: 'community.trade_reply',
        title: 'A trade is interested in your job',
        body: `${biz.name} can help with: ${brief.title}. Open My jobs to decide whether to share your details.`,
        data: { kind: 'trade_interested', briefId: m.brief_id, matchId: m.id },
      });
      if (r.status === 'sent') await svc.from('trade_brief_matches').update({ interest_notified_at: new Date().toISOString() }).eq('id', m.id);
      return json({ ok: true, sent: r.status === 'sent' ? 1 : 0, reason: r.reason });
    }

    // kind === 'shared'
    if (brief.author_id !== user.id) return json({ error: 'Forbidden' }, 403);               // only the resident
    if (!m.contact_shared_at) return json({ ok: true, sent: 0, reason: 'not_shared' });
    if (m.share_notified_at) return json({ ok: true, sent: 0, reason: 'already_sent' });
    if (!biz.owner_id) return json({ ok: true, sent: 0, reason: 'no_owner' });
    if (dry_run) return json({ ok: true, dry_run: true, would_notify: 'trade', sent: 0 });
    const r = await sendUserPush(svc, {
      userId: biz.owner_id, module: 'business', categoryId: 'business.lead',
      title: 'A customer shared their details',
      body: `${brief.title} · ${brief.location_text}. Open the lead to contact them.`,
      data: { kind: 'trade_lead_shared', briefId: m.brief_id, matchId: m.id, businessId: m.business_id },
    });
    if (r.status === 'sent') await svc.from('trade_brief_matches').update({ share_notified_at: new Date().toISOString() }).eq('id', m.id);
    return json({ ok: true, sent: r.status === 'sent' ? 1 : 0, reason: r.reason });
  } catch (err) {
    console.error('[notify-trade-response]', err);
    return json({ ok: false }, 200);       // never fail loudly: the reply/share has already been recorded
  }
});

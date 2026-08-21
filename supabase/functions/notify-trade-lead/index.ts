import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-trade-lead
 *
 * Tells the trades a brief was just sent to that it exists.
 *
 * Without this the whole feature is a page nobody opens. A tradesperson is up a
 * ladder, not refreshing a dashboard — a lead they see three days later is a
 * lead somebody else already took, and the person waiting concludes OneShetland
 * doesn't work.
 *
 * Deliberately NOT a database trigger. A trigger would fire inside the insert
 * transaction, so a slow or failing push would slow down or roll back the
 * posting of the brief itself — and the brief matters far more than the
 * notification. Called after the fact instead, and a failure here is logged and
 * swallowed.
 *
 * The push carries NO contact details, only the shape of the job. Contact is
 * released on acceptance, and a notification is exactly the kind of place that
 * rule gets quietly broken.
 *
 * Caller must be signed in AND be the brief's author. This ran unauthenticated
 * with verify_jwt off, so anyone who could reach the URL with a brief_id could
 * re-fire the push at every matched trade, as often as they liked — matches stay
 * 'sent' until answered, so the same people were notified every time. The push
 * carries no contact details, which limited it to pestering rather than leaking.
 *
 * Deploy: supabase functions deploy notify-trade-lead
 * Body: { brief_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

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
    const limited = await enforceRateLimit('notify-trade-lead', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { brief_id } = await req.json().catch(() => ({}));
    if (!brief_id) return json({ error: 'brief_id is required' }, 400);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: brief } = await svc
      .from('trade_briefs')
      .select('id, title, trades, scale, urgency, location_text, author_id')
      .eq('id', brief_id)
      .single();
    if (!brief) return json({ ok: true, sent: 0 });

    // Only the person who posted the brief may announce it. Both callers (app
    // lib/trades-api.ts and web lib/trades-actions.ts) invoke this immediately
    // after inserting the brief as that same signed-in user, so nothing
    // legitimate is turned away.
    if (brief.author_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // Only those who haven't already answered — re-running this must not
    // pester somebody who already said no.
    const { data: matches } = await svc
      .from('trade_brief_matches')
      .select('id, business_id, status, local_businesses(owner_id, name)')
      .eq('brief_id', brief_id)
      .eq('status', 'sent');

    let sent = 0;
    for (const m of (matches ?? []) as Record<string, unknown>[]) {
      const raw = m.local_businesses;
      const biz = (Array.isArray(raw) ? raw[0] : raw) as { owner_id?: string } | null;
      const ownerId = biz?.owner_id;
      if (!ownerId) continue;

      const urgent = brief.urgency === 'emergency';
      const result = await sendUserPush(svc, {
        userId: ownerId,
        module: 'business',
        categoryId: 'business.lead',
        title: urgent ? 'Urgent job near you' : 'A job for you',
        // Enough to decide whether to open it, and nothing that identifies
        // the person who posted it.
        body: `${brief.title} · ${brief.location_text}`,
        data: { kind: 'trade_lead', briefId: brief.id, matchId: m.id, businessId: m.business_id },
        urgent,
      });
      if (result.status === 'sent') sent++;
    }

    return json({ ok: true, sent });
  } catch (err) {
    console.error('[notify-trade-lead]', err);
    // Never fail loudly: the brief is already posted and visible in the app.
    return json({ ok: false }, 200);
  }
});

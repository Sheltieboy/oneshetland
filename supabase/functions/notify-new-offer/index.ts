import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-new-offer
 *
 * Pushes a notification to every follower of a business when they post a new offer.
 *
 * Body: { offer_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // The caller must own the business this announces. Without it any signed-in
    // user could re-fire the fan-out at a business's entire customer base, as
    // often as they liked — the content is legitimate, the repetition is the
    // abuse. Both callers invoke this as the owner immediately after creating
    // the row, so nothing legitimate is turned away.
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
    const limited = await enforceRateLimit('notify-new-offer', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;
    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { offer_id } = await req.json();
    if (!offer_id) return json({ error: 'offer_id required' }, 400);

    const { data: offer } = await svc
      .from('local_offers')
      .select('id, business_id, title')
      .eq('id', offer_id)
      .single();
    if (!offer) return json({ error: 'Offer not found' }, 404);
    // Only the business owner may fire this fan-out.
    const { data: ownerRow } = await svc
      .from('local_businesses').select('owner_id').eq('id', offer.business_id).maybeSingle();
    if (!ownerRow || ownerRow.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);


    const { data: business } = await svc
      .from('local_businesses')
      .select('name')
      .eq('id', offer.business_id)
      .single();

    const { data: followers } = await svc
      .from('local_business_follows')
      .select('user_id')
      .eq('business_id', offer.business_id);

    if (!followers || followers.length === 0) {
      return json({ ok: true, notified: 0 });
    }

    const userIds = followers.map(f => f.user_id);

    // Notify each follower — the helper honours preferences / quiet hours
    // and resolves their push token.
    await sendUserPushBulk(svc, userIds, {
      module:     'offers',
      categoryId: 'offers.new_offer',
      title:      `🎁 New offer at ${business?.name ?? 'Local'}`,
      body:       offer.title,
      data:       { screen: 'local-offers', offer_id },
    });

    return json({ ok: true, notified: userIds.length });
  } catch (err) {
    console.error('[notify-new-offer]', err);
    return json({ error: safeError('notify-new-offer', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

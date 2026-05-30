import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

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
    const { data: profiles } = await svc
      .from('profiles')
      .select('id, push_token')
      .in('id', userIds);

    let notified = 0;
    for (const p of profiles ?? []) {
      if (p.push_token) {
        await sendPush(
          p.push_token,
          `🎁 New offer at ${business?.name ?? 'Local'}`,
          offer.title,
          { screen: 'local-offers', offer_id },
        );
        notified++;
      }
    }

    return json({ ok: true, notified });
  } catch (err) {
    console.error('[notify-new-offer]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

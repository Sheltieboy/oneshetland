import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-hub-donation
 *
 * Verifies the donation PaymentIntent, then records the donation + (if the hub
 * is a charity and the donor opted in) the Gift Aid declaration, via the atomic
 * record_hub_donation RPC. Idempotent on the PaymentIntent.
 *
 * Body: { payment_intent_id, message?, anonymous?, gift_aid? {first_name,last_name,address,postcode,title?} }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { payment_intent_id, message = null, anonymous = false, gift_aid = null } = await req.json();
    if (!payment_intent_id) return json({ error: 'payment_intent_id required' }, 400);

    // Already recorded?
    const { data: existing } = await svc.from('hub_donations').select('id')
      .eq('stripe_payment_intent_id', payment_intent_id).maybeSingle();
    if (existing) return json({ ok: true });

    const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } });
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? `Stripe retrieve failed (HTTP ${piRes.status})`);

    if (pi.metadata?.type !== 'hub_donation') return json({ error: 'Not a donation payment' }, 400);
    if (pi.metadata?.user_id !== user.id)      return json({ error: 'Forbidden' }, 403);
    if (pi.status !== 'succeeded')             return json({ error: 'Payment not completed' }, 402);

    // Gift Aid only counts at charity hubs that have a charity number on file,
    // and when a complete declaration is given.
    const { data: hub } = await svc.from('hubs').select('is_charity, charity_number').eq('id', pi.metadata.hub_id).maybeSingle();
    const charityEligible = !!hub?.is_charity && !!hub?.charity_number;
    const ga = (charityEligible && gift_aid && gift_aid.first_name && gift_aid.last_name && gift_aid.address && gift_aid.postcode)
      ? gift_aid : null;

    const { error: rpcErr } = await svc.rpc('record_hub_donation', {
      p_campaign: pi.metadata.campaign_id,
      p_hub:      pi.metadata.hub_id,
      p_user:     user.id,
      p_amount:   parseInt(pi.metadata.face_pence ?? '0', 10) || 0,
      p_fee:      parseInt(pi.metadata.fee_pence ?? '0', 10) || 0,
      p_message:  message ? String(message).slice(0, 280) : null,
      p_anon:     !!anonymous,
      p_pi:       payment_intent_id,
      p_gift_aid: !!ga,
      p_title:    ga?.title ?? null,
      p_first:    ga?.first_name ?? null,
      p_last:     ga?.last_name ?? null,
      p_address:  ga?.address ?? null,
      p_postcode: ga?.postcode ?? null,
    });
    if (rpcErr) throw rpcErr;

    return json({ ok: true, gift_aid: !!ga });
  } catch (err) {
    console.error('[confirm-hub-donation]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

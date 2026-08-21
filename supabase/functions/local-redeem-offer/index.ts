import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-redeem-offer
 *
 * Records that a user claimed an offer + increments the offer's redemption count.
 * Enforces single-use (one redemption per user per offer) via the PK constraint.
 * Enforces validity dates and max_redemptions.
 *
 * Body: { offer_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { offer_id } = await req.json();
    if (!offer_id) return json({ error: 'offer_id required' }, 400);

    const { data: offer } = await svc
      .from('local_offers')
      .select('*')
      .eq('id', offer_id)
      .single();

    if (!offer) return json({ error: 'Offer not found' }, 404);
    if (!offer.is_active) return json({ error: 'Offer no longer active' }, 410);

    const now = Date.now();
    if (new Date(offer.valid_from).getTime() > now) return json({ error: 'Offer not started yet' }, 400);
    if (new Date(offer.valid_until).getTime() < now) return json({ error: 'Offer has expired' }, 410);

    if (offer.max_redemptions && offer.redemption_count >= offer.max_redemptions) {
      return json({ error: 'All redemptions used' }, 410);
    }

    // Try to insert — PK constraint blocks double-redemption per user
    const { error: insertErr } = await svc
      .from('local_offer_redemptions')
      .insert({ offer_id, user_id: user.id });

    if (insertErr) {
      if (insertErr.code === '23505') return json({ error: "You've already used this offer" }, 409);
      return json({ error: insertErr.message }, 500);
    }

    await svc
      .from('local_offers')
      .update({ redemption_count: offer.redemption_count + 1 })
      .eq('id', offer_id);

    return json({ ok: true });
  } catch (err) {
    console.error('[local-redeem-offer]', err);
    return json({ error: safeError('local-redeem-offer', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

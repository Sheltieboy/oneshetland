import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-nfc-stamp
 *
 * Called when a customer taps the business's NFC tile.
 * The app sends the business's nfc_token plus the user's current GPS.
 * Server validates the user is within range of the business location before
 * stamping (anti-fraud: prevents armchair stamping from a copied URL).
 *
 * Body: { token: string, lat: number, lng: number }
 * Returns: { ok, stamps, needed, reward_ready, business_name }
 */
const MAX_DISTANCE_M = 150;       // Customer must be within 150m of business
const MIN_STAMP_GAP_HOURS = 4;     // No more than 1 stamp per business per 4hrs

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

    const { token, lat, lng } = await req.json();
    if (!token || typeof lat !== 'number' || typeof lng !== 'number') {
      return json({ error: 'token + lat + lng required' }, 400);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, lat, lng, nfc_status, nfc_activated_at')
      .eq('nfc_token', token)
      .maybeSingle();

    if (!business) return json({ error: 'NFC tile not recognised' }, 404);
    if (business.owner_id === user.id) {
      return json({ error: "You can't stamp your own business" }, 403);
    }

    // Distance check
    if (business.lat == null || business.lng == null) {
      return json({ error: 'Business location not set — admin needs to fix this' }, 500);
    }
    const distance = haversineMeters(lat, lng, Number(business.lat), Number(business.lng));
    if (distance > MAX_DISTANCE_M) {
      return json({
        error: `You need to be at ${business.name} to use this tile.`,
        distance_m: Math.round(distance),
      }, 403);
    }

    // Loyalty program
    const { data: program } = await svc
      .from('local_loyalty_programs')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!program) return json({ error: `${business.name} hasn't set up a loyalty programme yet` }, 404);

    // Get or create card
    let { data: card } = await svc
      .from('local_loyalty_cards')
      .select('*')
      .eq('user_id', user.id)
      .eq('program_id', program.id)
      .maybeSingle();

    if (!card) {
      const { data: newCard, error } = await svc
        .from('local_loyalty_cards')
        .insert({
          user_id: user.id,
          program_id: program.id,
          business_id: business.id,
        })
        .select('*')
        .single();
      if (error) return json({ error: error.message }, 500);
      card = newCard;
    }

    // Rate limit
    if (card.last_stamp_at) {
      const hoursAgo = (Date.now() - new Date(card.last_stamp_at).getTime()) / 3_600_000;
      if (hoursAgo < MIN_STAMP_GAP_HOURS) {
        const wait = Math.ceil(MIN_STAMP_GAP_HOURS - hoursAgo);
        return json({ error: `Already stamped recently — try again in ${wait}hr` }, 429);
      }
    }

    const newStamps = (card.stamps_collected ?? 0) + 1;
    const needed = program.stamps_required ?? 10;
    const rewardReady = program.type === 'stamps' && newStamps >= needed;

    await svc
      .from('local_loyalty_cards')
      .update({
        stamps_collected: newStamps,
        last_stamp_at: new Date().toISOString(),
      })
      .eq('id', card.id);

    await svc.from('local_loyalty_transactions').insert({
      card_id: card.id,
      user_id: user.id,
      business_id: business.id,
      type: 'stamp',
      amount: 1,
      note: 'NFC tap',
    });

    // Mark NFC as activated on first ever successful tap
    if (business.nfc_status !== 'active') {
      await svc
        .from('local_businesses')
        .update({
          nfc_status: 'active',
          nfc_activated_at: business.nfc_activated_at ?? new Date().toISOString(),
        })
        .eq('id', business.id);
    }

    // Push if reward ready
    if (rewardReady) {
      const { data: profile } = await svc
        .from('profiles')
        .select('push_token')
        .eq('id', user.id)
        .single();
      if (profile?.push_token) {
        await sendPush(
          profile.push_token,
          `🎉 Reward unlocked at ${business.name}!`,
          program.stamp_reward ?? 'Show this card next time you visit.',
          { screen: 'local-my-cards' },
        );
      }
    }

    return json({
      ok: true,
      stamps: newStamps,
      needed,
      reward_ready: rewardReady,
      business_name: business.name,
      business_id: business.id,
    });
  } catch (err) {
    console.error('[local-nfc-stamp]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

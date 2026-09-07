import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

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

    // Counted against notify_any as well as its own route: the aggregate only
    // means anything if every notification path claims it.
    const limited = await enforceRateLimit('local-nfc-stamp', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

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

    // One transaction: the card is created-or-locked, the four-hour gap is
    // evaluated while that lock is held, the increment is self-referential and
    // the ledger row is written alongside it. The read-then-write this
    // replaces let two taps both pass the gap and lose one increment between
    // them — reproduced, and visible in production as a card holding fewer
    // stamps than its own ledger.
    //
    // Everything above this line stays here: proximity, the owner block and
    // the rate limiter are edge concerns, not database ones.
    const { data: earned, error: earnErr } = await svc.rpc('loyalty_earn_stamp', {
      p_user:            user.id,
      p_business:        business.id,
      p_min_gap_seconds: MIN_STAMP_GAP_HOURS * 3600,
    });
    if (earnErr) {
      console.error('[local-nfc-stamp] loyalty_earn_stamp failed', earnErr);
      return json({ error: "Couldn't save your stamp." }, 500);
    }
    const outcome = earned as {
      ok: boolean; error?: string; wait_seconds?: number;
      stamps_collected?: number; stamps_required?: number; reward_ready?: boolean;
    };
    if (!outcome?.ok) {
      if (outcome?.error === 'too_soon') {
        const wait = Math.ceil((outcome.wait_seconds ?? 0) / 3600);
        return json({ error: `Already stamped recently — try again in ${wait}hr` }, 429);
      }
      if (outcome?.error === 'no_stamp_program') {
        return json({ error: `${business.name} hasn't set up a loyalty programme yet` }, 404);
      }
      return json({ error: "Couldn't save your stamp." }, 500);
    }
    const newStamps = outcome.stamps_collected ?? 0;
    const needed = outcome.stamps_required ?? 10;
    const rewardReady = outcome.reward_ready === true;

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

    // Push if reward ready (preference-aware).
    if (rewardReady) {
      await sendUserPush(svc, {
        userId:     user.id,
        module:     'loyalty',
        categoryId: 'loyalty.reward_ready',
        title:      `🎉 Reward unlocked at ${business.name}!`,
        body:       program.stamp_reward ?? 'Show this card next time you visit.',
        data:       { screen: 'local-my-cards' },
      });
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
    return json({ error: safeError('local-nfc-stamp', err) }, 500);
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

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { normaliseUkPostcode } from '../_shared/uk-postcode.ts';
import { enforceRateLimit, GLOBAL_SUBJECT } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * calculate-fee
 *
 * Given two UK postcodes, returns the delivery fee based on road-estimated
 * distance and the current pricing config (price per mile + minimum fee).
 *
 * Uses postcodes.io (free, no API key) for lat/lng, then Haversine for
 * straight-line distance, corrected by a road factor (default 1.4×).
 *
 * Body: { pickup_postcode: string, destination_postcode: string }
 * Response: { fee_pence: number, distance_miles: number, breakdown: object }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Public by design (the app quotes with the anon key), and every request makes
  // this function call postcodes.io twice. One ceiling for the whole endpoint, for
  // the same reason as oneshetland-feed: a per-IP bucket would key on a header the
  // caller can forge. Generous for real use, and it stops an abuser getting our
  // shared egress address rate-limited by postcodes.io.
  const limited = await enforceRateLimit('calculate-fee', GLOBAL_SUBJECT, ['calculate_fee_global'], corsHeaders);
  if ('denied' in limited) return limited.denied;

  try {
    const body = await req.json().catch(() => ({}));

    // A postcode is a postcode or it is refused. Nothing else reaches the URL.
    // The shared validator (also the Gift Aid rule) assumes a string, so the type
    // and a sane length are checked first; it returns the canonical "ZE1 0AA".
    const valid = (v: unknown) => (typeof v === 'string' && v.length <= 12 ? normaliseUkPostcode(v) : null);
    const p1 = valid(body?.pickup_postcode)?.replace(' ', '') ?? null;
    const p2 = valid(body?.destination_postcode)?.replace(' ', '') ?? null;
    if (!p1 || !p2) {
      return new Response(
        JSON.stringify({ error: 'pickup_postcode and destination_postcode must be valid UK postcodes' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Look up both postcodes in parallel via postcodes.io (free, no key required).
    // Encoded, no redirects followed, and bounded in time.
    const lookup = (pc: string) => fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    const [r1, r2] = await Promise.all([lookup(p1), lookup(p2)]);

    if (!r1.ok || !r2.ok) {
      return new Response(
        JSON.stringify({ error: 'Could not look up one or both postcodes' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const d1 = await r1.json();
    const d2 = await r2.json();

    if (!d1.result?.latitude || !d2.result?.latitude) {
      return new Response(
        JSON.stringify({ error: 'Invalid postcode or no coordinates returned' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { latitude: lat1, longitude: lon1 } = d1.result;
    const { latitude: lat2, longitude: lon2 } = d2.result;

    // Haversine straight-line distance in km
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    const straightLineKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Fetch pricing config from Supabase
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    );

    const { data: config } = await supabase
      .from('delivery_pricing_config')
      .select('price_per_mile_pence, min_fee_pence, road_correction_factor')
      .single();

    const pricePerMilePence = config?.price_per_mile_pence ?? 95;
    const minFeePence       = config?.min_fee_pence ?? 400;
    const correctionFactor  = Number(config?.road_correction_factor ?? 1.40);

    // Apply road correction and convert to miles
    const estimatedRoadMiles = straightLineKm * 0.621371 * correctionFactor;

    // Calculate fee, apply minimum
    const distanceFee = Math.round(estimatedRoadMiles * pricePerMilePence);
    const feePence    = Math.max(minFeePence, distanceFee);

    return new Response(
      JSON.stringify({
        fee_pence: feePence,
        distance_miles: Math.round(estimatedRoadMiles * 10) / 10, // 1 decimal place
        breakdown: {
          straight_line_miles: Math.round(straightLineKm * 0.621371 * 10) / 10,
          road_correction_factor: correctionFactor,
          estimated_road_miles: Math.round(estimatedRoadMiles * 10) / 10,
          price_per_mile_pence: pricePerMilePence,
          min_fee_pence: minFeePence,
          distance_fee_pence: distanceFee,
          applied_minimum: feePence === minFeePence,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[calculate-fee]', err);
    return new Response(
      JSON.stringify({ error: safeError('calculate-fee', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

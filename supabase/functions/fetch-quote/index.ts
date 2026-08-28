import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * fetch-quote — what a Fetch delivery costs, decided here.
 *
 * The price used to be worked out in the customer's browser and written
 * straight into the row, so a twelve-mile delivery could be posted for a penny
 * and the driver who accepted it made the trip for nothing. The browser may
 * still show a figure; it is a preview, and this is the number.
 *
 * Two shapes:
 *   { pickup_address, destination_address }  → quote only, writes nothing.
 *       For the composer, so the customer sees the real price BEFORE
 *       committing to anything.
 *   { request_id }                           → prices that stored request.
 *       Owner-only, and only while it is still pending — once a driver has
 *       accepted, the price is locked and this refuses.
 *
 * Distance comes from Google Geocoding with a SERVER key. The browser's Places
 * key is NEXT_PUBLIC and referrer-restricted, so it is deliberately not reused:
 * a key the client holds is a key the client can lie with.
 *
 * Env: GOOGLE_GEOCODING_API_KEY (server-only)
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

    // Every quote geocodes two addresses, and Google bills per request. The
    // ceiling is on the caller, before anything is read, so an account cannot
    // sit on this endpoint and spend the platform's money.
    const limited = await enforceRateLimit('fetch-quote', userSubject(user.id), ['fetch_quote', 'fetch_quote_day'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json().catch(() => ({}));
    const requestId = typeof body?.request_id === 'string' ? body.request_id : null;

    let pickup: string | null = null;
    let destination: string | null = null;

    if (requestId) {
      const { data: r } = await svc
        .from('delivery_requests')
        .select('id, customer_id, status, pickup_location, pickup_name, destination_address, destination_area, base_fee_pence')
        .eq('id', requestId)
        .maybeSingle();
      if (!r) return json({ error: 'Request not found' }, 404);
      if (r.customer_id !== user.id) return json({ error: 'Forbidden' }, 403);

      // The price is locked when a driver accepts. Re-pricing a matched
      // delivery would move the number under a driver who agreed to the old
      // one, and under a customer who has already been shown it.
      if (r.status !== 'pending') {
        return json({ error: 'This delivery has already been accepted — its price is fixed.', code: 'PRICE_LOCKED' }, 409);
      }
      pickup      = r.pickup_location || r.pickup_name;
      destination = r.destination_address || r.destination_area;
    } else {
      pickup      = typeof body?.pickup_address === 'string' ? body.pickup_address : null;
      destination = typeof body?.destination_address === 'string' ? body.destination_address : null;
    }

    if (!pickup || !destination) {
      return json({ error: 'A collection and a delivery address are both needed to price a delivery.' }, 400);
    }

    const miles = await straightLineMiles(pickup, destination);

    // Price and commission both from server configuration. `miles` null means
    // we could not measure the distance — see measuredFallback below.
    const { data: baseRows, error: baseErr } = await svc.rpc('fetch_base_fee_pence', {
      p_straight_miles: miles ?? 0,
    });
    if (baseErr) throw baseErr;
    const basePence = Number(baseRows);

    const fetchCfg = await getCommissionConfig(svc, 'fetch');
    const servicePence = calculateCommission(basePence, fetchCfg, 'fetch').fee_pence;

    if (requestId) {
      const { error: upErr } = await svc
        .from('delivery_requests')
        .update({ base_fee_pence: basePence })
        .eq('id', requestId)
        .eq('status', 'pending');       // never re-price something already accepted
      if (upErr) {
        console.error('[fetch-quote] could not store the price', upErr);
        return json({ error: 'Could not price this delivery. Please try again.' }, 500);
      }
    }

    return json({
      base_fee_pence:    basePence,
      service_fee_pence: servicePence,
      total_pence:       basePence + servicePence,
      miles:             miles == null ? null : Math.round(miles * 10) / 10,
      /** false when the distance could not be measured and the minimum was used. */
      measured:          miles != null,
    });
  } catch (err) {
    console.error('[fetch-quote]', err);
    return json({ error: safeError('fetch-quote', err) }, 500);
  }
});

/**
 * Straight-line miles between two addresses, geocoded server-side.
 *
 * Returns null rather than throwing when it cannot measure — no key
 * configured, an address Google cannot place, Google unreachable. The caller
 * then prices at the configured MINIMUM, which is the safe direction to be
 * wrong in: the customer is never overcharged for a distance nobody verified,
 * and Fetch keeps working rather than going dark. It is logged loudly, because
 * a platform quietly charging its minimum for every delivery is a problem the
 * driver pays for.
 */
async function straightLineMiles(from: string, to: string): Promise<number | null> {
  const key = Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? '';
  if (!key) {
    console.error('[fetch-quote] GOOGLE_GEOCODING_API_KEY is not set — pricing at the configured minimum.');
    return null;
  }
  try {
    const [a, b] = await Promise.all([geocode(from, key), geocode(to, key)]);
    if (!a || !b) {
      console.error(`[fetch-quote] could not geocode ${!a ? 'the collection' : 'the delivery'} address — pricing at the minimum.`);
      return null;
    }
    return haversineMiles(a.lat, a.lng, b.lat, b.lng);
  } catch (e) {
    console.error('[fetch-quote] geocoding failed — pricing at the minimum:', e);
    return null;
  }
}

async function geocode(address: string, key: string): Promise<{ lat: number; lng: number } | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  // Shetland is in the UK; restricting the region stops a same-named village
  // on another continent turning a two-mile hop into a transatlantic quote.
  url.searchParams.set('components', 'country:GB');
  url.searchParams.set('key', key);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const loc = data?.results?.[0]?.geometry?.location;
  if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') return null;
  return { lat: loc.lat, lng: loc.lng };
}

/** Great-circle distance in miles. The road correction is applied in SQL. */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

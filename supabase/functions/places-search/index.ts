import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { safeError } from '../_shared/safe-error.ts';
import { parseAutocompleteParams, parseDetailsParams, buildGoogleUrl } from '../_shared/places-params.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * places-search — Google Places Autocomplete/Details on OUR key, for a real
 * signed-in caller only.
 *
 * WHY THIS EXISTS
 *
 * The Google key baked into both apps is the same key, and it is (correctly)
 * HTTP-referrer restricted — the only restriction Google offers a browser can
 * prove. A native app's REST call carries no referrer a server can verify, so
 * Google refuses it outright (REQUEST_DENIED). There is no key restriction that
 * is both secure AND works for a bare fetch() from React Native: an
 * "app restriction" only binds to Google's own native SDK request signing, not
 * to a plain HTTPS call this library makes, so it would be unverifiable in
 * practice — a raw unrestricted mobile key was the only alternative, and that
 * is broadly usable by anyone who extracts it from the app bundle.
 *
 * So the call moves server-side, on a key that never ships in any app bundle,
 * gated the same way the other costed/abusable endpoints are (ai-cover-letter,
 * notify-hub): a REAL signed-in caller, and a rate limit, before anything is
 * spent. Every business/event/shift/delivery screen that uses address search
 * already requires an account.
 *
 * ROUTING
 *   GET .../places-search/place/autocomplete/json?input=...
 *   GET .../places-search/place/details/json?placeid=...
 * mirrors the exact paths the react-native-google-places-autocomplete library
 * builds by default, so it can be pointed here via its own `requestUrl` prop
 * with NO change to any screen's field-mapping/onPress logic — the one part of
 * this feature that is fragile and worth not touching five times.
 *
 * Every parameter is validated against the one shape the app's own query
 * objects send (_shared/places-params.ts) before it reaches Google; nothing
 * from the request — including the client's own harmless `key` value — is
 * forwarded as-is. The key, the input text and the response body are never
 * logged; only the outcome (found / not found / denied) is.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('places-search', userSubject(caller.userId), ['places_search', 'places_search_day'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    const serverKey = Deno.env.get('GOOGLE_PLACES_SERVER_KEY');
    if (!serverKey) return json({ status: 'UNAVAILABLE', error_message: 'Address search is not configured' }, 503);

    const url = new URL(req.url);
    const isDetails = url.pathname.endsWith('/place/details/json');
    const isAutocomplete = !isDetails && url.pathname.endsWith('/place/autocomplete/json');
    if (!isDetails && !isAutocomplete) return json({ error: 'not found' }, 404);

    let googleUrl: string;
    if (isAutocomplete) {
      const p = parseAutocompleteParams(url.searchParams);
      if (!p) return json({ status: 'INVALID_REQUEST', predictions: [] }, 200); // the widget reads `status`, not HTTP code
      googleUrl = buildGoogleUrl('https://maps.googleapis.com/maps/api/place/autocomplete/json', p, serverKey);
    } else {
      const p = parseDetailsParams(url.searchParams);
      if (!p) return json({ status: 'INVALID_REQUEST', result: null }, 200);
      googleUrl = buildGoogleUrl('https://maps.googleapis.com/maps/api/place/details/json', p, serverKey);
    }

    const res = await fetch(googleUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      console.error(`[places-search] Google HTTP ${res.status}`);
      return json({ status: 'UNKNOWN_ERROR', error_message: 'Address search failed' }, 200);
    }

    // Pass through only the shape the widget reads. Google's own error_message
    // can name our project/key configuration — logged, never returned.
    if (body.status && body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
      if (body.error_message) console.error(`[places-search] ${body.status}: ${body.error_message}`);
      return json({ status: body.status, predictions: [], result: null }, 200);
    }
    return json(isAutocomplete ? { status: body.status, predictions: body.predictions ?? [] } : { status: body.status, result: body.result ?? null });
  } catch (err) {
    console.error('[places-search]', safeError('places-search', err));
    return json({ status: 'UNKNOWN_ERROR', error_message: 'Address search failed' }, 200);
  }
});

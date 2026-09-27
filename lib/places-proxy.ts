/**
 * places-proxy.ts — points GooglePlacesAutocomplete at OUR Edge Function
 * instead of Google directly.
 *
 * The mobile Google key is HTTP-referrer restricted (correctly — see the 25
 * Sep security re-audit), so a bare device fetch to Google is refused. The
 * library's own `requestUrl` prop lets it hit a different base URL while
 * keeping every existing onPress/fetchDetails field-mapping untouched: it
 * still requests `${url}/place/autocomplete/json` and `${url}/place/details/json`
 * with the same query shape, so `places-search` (see supabase/functions) mirrors
 * those two paths exactly.
 *
 * `query.key` is still required by the library to build a valid request but is
 * IGNORED server-side — PLACES_QUERY_KEY is a label, not a credential, so the
 * real mobile Google key never needs to appear in this call at all.
 *
 * Headers are read fresh by the library on every request (not just once), so
 * passing the current session's access token here keeps each call correctly
 * authenticated as it refreshes — no polling or extra wiring needed.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

export const PLACES_QUERY_KEY = 'proxied';

export function placesRequestUrl(accessToken: string | null | undefined) {
  return {
    url: `${SUPABASE_URL}/functions/v1/places-search`,
    useOnPlatform: 'all' as const,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    },
  };
}

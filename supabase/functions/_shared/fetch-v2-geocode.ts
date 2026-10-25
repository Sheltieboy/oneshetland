/**
 * fetch-v2-geocode.ts — server-side geocoding for Fetch v2 (docs/FETCH_V2_IMPLEMENTATION.md, Step 4).
 *
 * Coordinates are only ever produced here, from Google Geocoding with the SERVER key (GOOGLE_GEOCODING_API_KEY), never taken from a
 * client. A Places place_id from the client's autocomplete is accepted as a *reference* and resolved here; free text and a postcode
 * are the fallback. Results are restricted to Great Britain so a same-named village elsewhere cannot be chosen.
 *
 * Contract: resolves to coordinates, to null when Google cannot place the query (the caller answers `location_unresolved`), or throws
 * GeocodeUnavailable when Google cannot be asked at all. The key never appears in a result or an error message.
 */

export type LatLng = { lat: number; lng: number };
export type GeocodeQuery = { place_id: string } | { address: string };
export type Geocoder = (q: GeocodeQuery) => Promise<LatLng | null>;
// deno-lint-ignore no-explicit-any
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export class GeocodeUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Location lookup unavailable (${reason})`);
    this.reason = reason;
  }
}

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

export function googleGeocoder(key: string, fetchImpl: FetchLike): Geocoder {
  return async (q) => {
    if (!key) throw new GeocodeUnavailable('not_configured');
    const url = new URL(ENDPOINT);
    if ('place_id' in q) url.searchParams.set('place_id', q.place_id);
    else {
      url.searchParams.set('address', q.address);
      url.searchParams.set('components', 'country:GB');
    }
    url.searchParams.set('key', key);

    let res;
    try {
      res = await fetchImpl(url.toString());
    } catch {
      throw new GeocodeUnavailable('network');
    }
    if (!res.ok) throw new GeocodeUnavailable(`http_${res.status}`);
    const body = await res.json().catch(() => null);
    const status = body?.status;
    if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND' || status === 'INVALID_REQUEST') return null;
    if (status !== 'OK') throw new GeocodeUnavailable(typeof status === 'string' ? status.toLowerCase() : 'bad_response');
    const loc = body?.results?.[0]?.geometry?.location;
    if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number' || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    return { lat: loc.lat, lng: loc.lng };
  };
}

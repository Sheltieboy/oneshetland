/**
 * places-params.ts — the only shape Places Autocomplete/Details parameters may
 * take before they are forwarded to Google, and with our own key.
 *
 * Nothing from the caller reaches the outbound URL unvalidated: a fixed host
 * means this is not a way to reach another server, but an anonymous or
 * malicious value (huge input, arbitrary `types`, garbage `location`) is still
 * unbounded cost and unbounded output for no legitimate reason. Each optional
 * value is checked against the one shape the app's own query objects ever send;
 * anything else is dropped rather than failing the whole search, so a stray or
 * future param never blocks an address lookup — it just loses its bias.
 */

export type AutocompleteParams = {
  input: string;
  language?: string;
  components?: string;
  location?: string;
  radius?: string;
  types?: string;
};

export type DetailsParams = {
  placeid: string;
  language?: string;
};

const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const COMPONENTS = /^country:[a-z]{2}$/;
const LOCATION = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const RADIUS = /^[1-9][0-9]{0,6}$/; // 1–9,999,999 (Google caps effective use around 50km anyway)
const PLACE_TYPES = new Set(['address', 'geocode', 'establishment', '(regions)', '(cities)']);
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

function pick(v: unknown, re: RegExp): string | undefined {
  return typeof v === 'string' && re.test(v) ? v : undefined;
}

/** Returns the validated autocomplete params, or null if `input` itself is unusable. */
export function parseAutocompleteParams(q: URLSearchParams): AutocompleteParams | null {
  const input = (q.get('input') ?? '').trim();
  if (input.length < 2 || input.length > 200) return null;
  const types = q.get('types') ?? undefined;
  return {
    input,
    language: pick(q.get('language'), LANGUAGE),
    components: pick(q.get('components'), COMPONENTS),
    location: pick(q.get('location'), LOCATION),
    radius: pick(q.get('radius'), RADIUS),
    types: typeof types === 'string' && PLACE_TYPES.has(types) ? types : undefined,
  };
}

/** Returns the validated details params, or null if `placeid` itself is unusable. */
export function parseDetailsParams(q: URLSearchParams): DetailsParams | null {
  const placeid = q.get('placeid') ?? '';
  if (!PLACE_ID.test(placeid)) return null;
  return { placeid, language: pick(q.get('language'), LANGUAGE) };
}

/** Builds the Google URL from ALREADY-VALIDATED params plus our own server key. Never the caller's. */
export function buildGoogleUrl(
  base: 'https://maps.googleapis.com/maps/api/place/autocomplete/json' | 'https://maps.googleapis.com/maps/api/place/details/json',
  params: Record<string, string | undefined>,
  serverKey: string,
): string {
  const u = new URL(base);
  u.searchParams.set('key', serverKey);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * uk-postcode.ts — the only shape a postcode may take before it goes anywhere.
 *
 * calculate-fee used to strip spaces and paste whatever it was sent straight
 * into a URL path on postcodes.io. The host was fixed, so this was not a way
 * to reach other servers, but it was unbounded input from an anonymous caller:
 * any length, any characters (`/`, `?`, `#`, `..`), and a non-string crashed the
 * handler. A postcode is 5–7 letters and digits; anything else is refused.
 */

// Outward code (A9, A99, A9A, AA9, AA99, AA9A) + inward code (9AA), spaces optional.
const UK_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

/** Returns the canonical no-space upper-case postcode, or null if it is not one. */
export function normaliseUkPostcode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 12) return null;
  const compact = input.replace(/\s+/g, '').toUpperCase();
  return UK_POSTCODE.test(compact) ? compact : null;
}

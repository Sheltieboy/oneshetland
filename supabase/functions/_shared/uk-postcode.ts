/**
 * HMRC requires a valid home address and postcode for a Gift Aid claim, so the
 * postcode is validated rather than stored as typed — and it is REJECTED rather
 * than silently dropped, so the donor learns their Gift Aid did not apply.
 *
 * Lifted out of confirm-hub-donation unchanged when Gift Aid validation moved
 * to the point the donation attempt is created, so that both the browser path
 * and the webhook path judge a postcode by exactly the same rule.
 */
export function normaliseUkPostcode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  // Outward (2–4 chars) + inward (digit + 2 letters). Excludes letters that
  // never appear in those positions, per the official UK pattern.
  const re = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/;
  const m = compact.match(re);
  if (!m) return null;
  return `${m[1]} ${m[2]}`;
}

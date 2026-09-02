/**
 * shetland-time.ts — one timezone, named once.
 *
 * A booking belongs to a Shetland business at a Shetland hour. The instant is
 * stored correctly as timestamptz; what varies is who formats it. Without an
 * explicit zone, `toLocaleString` answers with whatever clock the machine
 * running it keeps — the phone's, wherever its owner happens to be. A customer
 * checking their appointment from abroad would have been told the wrong hour,
 * and the web dashboard was already an hour out for the whole of BST because a
 * server rendered it in UTC.
 *
 * So every booking-facing formatter names the zone. Not an offset: BST and GMT
 * differ, and the timezone database is the only thing that knows which applies
 * on a given date.
 *
 * Mirrored in oneshetland-web/lib/shetland-time.ts.
 */
export const SHETLAND_TZ = 'Europe/London';

/** The Shetland calendar day an instant falls on, as YYYY-MM-DD — sortable, and
 *  stable wherever the reader is. Grouping slots by the device's day put an
 *  early appointment under the wrong tab for anyone outside the UK. */
export const shetlandDayKey = (d: Date): string =>
  d.toLocaleDateString('en-CA', { timeZone: SHETLAND_TZ });

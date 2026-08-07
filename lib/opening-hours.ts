/**
 * Opening hours — one definition of the shape, the parsing and the wording.
 *
 * The column is jsonb: { mon: "09:00-17:00", tue: "Closed", … }. Historically
 * it took free text ("7am - 12noon Monday to Saturday"), and some rows still
 * will, so everything here tolerates a value it can't parse rather than
 * throwing it away — it just can't be reasoned about.
 *
 * The editor writes the canonical "HH:MM-HH:MM" form. That matters because the
 * visitor planner has to answer "is this open at 14:20 on a Tuesday", and you
 * cannot ask that of "opens when the boat's in".
 *
 * Kept in step with the web's lib/opening-hours.ts — same shape, same rules.
 */

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type OpeningHoursMap = Partial<Record<DayKey, string>>;

export const DAYS: { key: DayKey; label: string; short: string }[] = [
  { key: 'mon', label: 'Monday',    short: 'Mon' },
  { key: 'tue', label: 'Tuesday',   short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday',  short: 'Thu' },
  { key: 'fri', label: 'Friday',    short: 'Fri' },
  { key: 'sat', label: 'Saturday',  short: 'Sat' },
  { key: 'sun', label: 'Sunday',    short: 'Sun' },
];

export const CLOSED = 'Closed';

/** Minutes since midnight, or null if it isn't a canonical HH:MM-HH:MM range. */
export function parseRange(value: string | undefined | null): { open: number; close: number } | null {
  if (!value) return null;
  const m = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  let close = Number(m[3]) * 60 + Number(m[4]);
  // A closing time at or before opening means past midnight (a bar till 1am).
  if (close <= open) close += 24 * 60;
  return { open, close };
}

/** Mon=0 … Sun=6, matching DAYS. JS getDay() is Sun=0, hence the shift. */
export function dayKeyFor(date: Date): DayKey {
  return DAYS[(date.getDay() + 6) % 7].key;
}

/**
 * Is it open at this moment? `null` means "we don't know" — no hours recorded,
 * or free text we can't read. Never guess: show "check times" for null, which
 * is a far better answer than a confident wrong one.
 */
export function isOpenAt(hours: OpeningHoursMap | null | undefined, when: Date): boolean | null {
  if (!hours) return null;
  const value = hours[dayKeyFor(when)];
  if (!value) return null;
  if (value.trim().toLowerCase() === CLOSED.toLowerCase()) return false;
  const range = parseRange(value);
  if (!range) return null;
  const mins = when.getHours() * 60 + when.getMinutes();
  return mins >= range.open && mins < range.close;
}

/** "09:00" → "9am", "17:30" → "5.30pm" — UK English, no leading zero. */
function prettyTime(mins: number): string {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}.${String(m).padStart(2, '0')}${suffix}`;
}

/** Human wording for one day. Unparseable free text is shown as written. */
export function formatDay(value: string | undefined | null): string {
  if (!value) return '—';
  if (value.trim().toLowerCase() === CLOSED.toLowerCase()) return CLOSED;
  const range = parseRange(value);
  if (!range) return value;
  return `${prettyTime(range.open)} – ${prettyTime(range.close)}`;
}

/** True when at least one day has been filled in. */
export function hasAnyHours(hours: OpeningHoursMap | null | undefined): boolean {
  return !!hours && DAYS.some(d => !!hours[d.key]);
}

/** Split "HH:MM" into its parts, for a date-picker. */
export function toHM(value: string, fallback = '09:00'): { h: number; m: number } {
  const src = /^(\d{2}):(\d{2})$/.test(value) ? value : fallback;
  const [h, m] = src.split(':').map(Number);
  return { h, m };
}

export function fromHM(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

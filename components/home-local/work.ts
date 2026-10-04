/**
 * work.ts — the "Work" model behind the Home and Local screens: jobs AND shifts as one proposition.
 *
 * Formal jobs (permanent, fixed-term, apprenticeship) and casual shifts (cover, one-off, today / tonight / this week)
 * sit together under "Work in Shetland". Home and Local curate a few of each; the whole inventory lives in the Work
 * tab (`/(tabs)/jobs`, with its Shifts pill).
 *
 * Only REAL rows ever reach this model. There is no sample or fallback content: no real shift → no shift (jobs only);
 * neither → a short gateway. An urgency label (TODAY / TONIGHT / TOMORROW / THIS WEEK) is derived from the shift's real
 * start time, never from a flag, and a shift further out than that gets no label — only its date.
 */

export interface WorkShift { kind: 'shift'; id: string; title: string; employer: string; where: string; startAt: string; endAt: string; rate: string }
export interface WorkJob { kind: 'job'; id: string; title: string; employer: string | null; where: string | null; pay: string | null; contract: string | null }
export interface WorkSet { shifts: WorkShift[]; jobs: WorkJob[] }
/* ── London time without Intl (Hermes-proof): BST runs from the last Sunday of March to the last Sunday of October,
      both at 01:00 UTC ─────────────────────────────────────────────────────────────────────────────────────── */
const lastSunday = (y: number, month0: number) => {
  const last = new Date(Date.UTC(y, month0 + 1, 0, 1));
  return Date.UTC(y, month0, last.getUTCDate() - last.getUTCDay(), 1);
};
const offsetMs = (ms: number) => {
  const y = new Date(ms).getUTCFullYear();
  return ms >= lastSunday(y, 2) && ms < lastSunday(y, 9) ? 3_600_000 : 0;
};
export interface LondonParts { y: number; m: number; day: number; hour: number; minute: number; dow: number }
export function londonParts(d: Date): LondonParts {
  const l = new Date(d.getTime() + offsetMs(d.getTime()));
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, day: l.getUTCDate(), hour: l.getUTCHours(), minute: l.getUTCMinutes(), dow: l.getUTCDay() };
}
const dayNumber = (d: Date) => { const t = londonParts(d); return Math.round(Date.UTC(t.y, t.m - 1, t.day) / 86_400_000); };

export type Urgency = 'TODAY' | 'TONIGHT' | 'TOMORROW' | 'THIS WEEK' | null;
/**
 * Derived from the real start time, in London time. From 17:00 today is TONIGHT; in progress or earlier today is TODAY;
 * tomorrow is TOMORROW; two to six days out is THIS WEEK; anything later (or already over) gets no label.
 */
export function shiftUrgency(startAt: string, endAt: string, now: Date): Urgency {
  if (new Date(endAt) <= now) return null;
  const start = new Date(startAt);
  const diff = dayNumber(start) - dayNumber(now);
  if (diff <= 0) return londonParts(start).hour >= 17 ? 'TONIGHT' : 'TODAY';
  if (diff === 1) return 'TOMORROW';
  if (diff <= 6) return 'THIS WEEK';
  return null;
}
const p2 = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => { const t = londonParts(new Date(iso)); return `${p2(t.hour)}:${p2(t.minute)}`; };
export const clockRange = (a: string, b: string) => `${clock(a)}–${clock(b)}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sat 10 Oct" — the date line when there is no urgency label to carry the "when". */
export const shortDate = (iso: string) => { const t = londonParts(new Date(iso)); return `${DOW[t.dow]} ${t.day} ${MON[t.m - 1]}`; };

export const orderShifts = (shifts: WorkShift[], now: Date) => shifts.filter((s) => new Date(s.endAt) > now).sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));

/** The Work content: real jobs and real shifts, the latter dropped once over and ordered most imminent first. */
export function buildWork(live: WorkSet, now: Date = new Date()): WorkSet {
  return { jobs: live.jobs, shifts: orderShifts(live.shifts, now) };
}

/** Which Work tab "See all jobs & shifts" opens: the Shifts pill only when there is nothing but shifts to show. */
export const workTab = (w: WorkSet): 'jobs' | 'shifts' => (w.jobs.length === 0 && w.shifts.length > 0 ? 'shifts' : 'jobs');

/** Home: one timely shift + up to three jobs (two once a shift takes its place). */
export function curateHome(w: WorkSet): { shifts: WorkShift[]; jobs: WorkJob[]; moreShifts: number } {
  if (w.shifts.length === 0) return { shifts: [], jobs: w.jobs.slice(0, 3), moreShifts: 0 };
  if (w.jobs.length === 0) return { shifts: w.shifts.slice(0, 2), jobs: [], moreShifts: Math.max(0, w.shifts.length - 2) };
  return { shifts: w.shifts.slice(0, 1), jobs: w.jobs.slice(0, 2), moreShifts: w.shifts.length - 1 };
}
/** Local: one or two shifts, then jobs, compact (three items in all on a phone). */
export function curateLocal(w: WorkSet): { shifts: WorkShift[]; jobs: WorkJob[] } {
  const shifts = w.shifts.slice(0, 2);
  return { shifts, jobs: w.jobs.slice(0, 4 - shifts.length) };
}

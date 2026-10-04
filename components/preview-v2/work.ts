/**
 * work.ts — the "Work" model for App Home V2 / Local V2 (mirrors the web preview's lib/preview-work.ts).
 * PREVIEW ONLY: nothing here is wired into a shipped screen and nothing writes anywhere.
 *
 * Work is ONE proposition — formal jobs (permanent, fixed-term, apprenticeship) and casual shifts (cover, one-off,
 * today / tonight / this week) under "Work in Shetland". Home and Local curate a few of each; the whole inventory
 * lives in the Work tab (`/(tabs)/jobs`, with its Shifts pill).
 *
 * Honesty rules: live reads real jobs and real shifts and NEVER invents a shift; seed / populated shifts are INVENTED
 * preview data (a made-up "Sample …" employer); an urgency label is derived from the shift's real start time, never
 * from a flag, and a shift further out than that gets no label — only its date.
 */
import type { PreviewState } from './model';

export interface WorkShift { kind: 'shift'; id: string; title: string; employer: string; where: string; startAt: string; endAt: string; rate: string; sample?: boolean }
export interface WorkJob { kind: 'job'; id: string; title: string; employer: string | null; where: string | null; pay: string | null; contract: string | null; sample?: boolean }
export interface WorkSet { shifts: WorkShift[]; jobs: WorkJob[] }
/** `?work=` — a preview-only override to see the combinations. Ignored in the live state (live never fabricates). */
export type WorkMix = 'both' | 'jobs' | 'shifts' | 'none';

export const parseMix = (v?: string): WorkMix | undefined => (['both', 'jobs', 'shifts', 'none'] as const).find((m) => m === v);

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
/** The instant at which London's wall clock reads (today + offsetDays) hh:mm. */
export function londonInstant(now: Date, offsetDays: number, hh: number, mm = 0): Date {
  const t = londonParts(now);
  const wall = Date.UTC(t.y, t.m - 1, t.day + offsetDays, hh, mm);
  const first = wall - offsetMs(wall);
  return new Date(wall - offsetMs(first));
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

/* ── Invented preview data ───────────────────────────────────────────────────── */
const at = (now: Date, off: number, from: [number, number], to: [number, number]) => ({ startAt: londonInstant(now, off, ...from).toISOString(), endAt: londonInstant(now, off, ...to).toISOString() });
/** Days to the next Saturday whose shift is still ahead (this Saturday until 17:00, then the next). */
function nextSaturdayOffset(now: Date): number {
  let off = (6 - londonParts(now).dow + 7) % 7;
  if (off === 0 && londonInstant(now, 0, 17) <= now) off = 7;
  return off;
}
export const SEED_SHIFT_RATE = '£13.50/hr';
const seedShift = (now: Date): WorkShift => ({ kind: 'shift', id: 'sample-shift-cafe-cover', title: 'Saturday café cover', employer: 'Sample Café', where: 'Lerwick', ...at(now, nextSaturdayOffset(now), [11, 0], [17, 0]), rate: SEED_SHIFT_RATE, sample: true });
function populatedShifts(now: Date): WorkShift[] {
  const mk = (id: string, title: string, employer: string, where: string, off: number, f: [number, number], t: [number, number], rate: string): WorkShift => ({ kind: 'shift', id, title, employer, where, ...at(now, off, f, t), rate, sample: true });
  return orderShifts([
    mk('sample-shift-kp', 'Kitchen porter, evening service', 'Sample Bistro', 'Lerwick', 0, [18, 0], [23, 0], '£12.80/hr'),
    mk('sample-shift-lunch', 'Lunch service cover', 'Sample Café', 'Lerwick', 0, [11, 30], [15, 30], '£12.50/hr'),
    mk('sample-shift-steward', 'Event steward, craft fair', 'Sample Events Co.', 'Brae', 1, [12, 0], [18, 0], '£12.00/hr'),
    mk('sample-shift-relief', 'Weekend feed relief', 'Sample Salmon Farm', 'Scalloway', 3, [7, 0], [15, 0], '£14.00/hr'),
    mk('sample-shift-cover', 'Saturday café cover', 'Sample Café', 'Lerwick', nextSaturdayOffset(now), [11, 0], [17, 0], SEED_SHIFT_RATE),
  ], now);
}
const J = (id: string, title: string, employer: string, where: string, pay: string, contract: string): WorkJob => ({ kind: 'job', id, title, employer, where, pay, contract, sample: true });
const SEED_JOBS: WorkJob[] = [
  J('sample-job-chef', 'Chef de partie', 'Sample Bistro', 'Lerwick', '£14.20/hr', 'permanent'),
  J('sample-job-apprentice', 'Apprentice electrician', 'Sample Electrical', 'Scalloway', 'Apprentice rates', 'apprenticeship'),
  J('sample-job-host', 'Seasonal visitor-centre host', 'Sample Heritage Trust', 'Sumburgh', '£11.90/hr', 'fixed-term'),
];
const FULL_JOBS: WorkJob[] = [
  ...SEED_JOBS,
  J('sample-job-care', 'Care assistant', 'Sample Care Group', 'Lerwick', '£12.60/hr', 'permanent'),
  J('sample-job-joiner', 'Apprentice joiner', 'Sample Joinery', 'Whiteness', 'Apprentice rates', 'apprenticeship'),
  J('sample-job-office', 'Office administrator', 'Sample Marine Services', 'Lerwick', '£24,500 a year', 'permanent'),
  J('sample-job-fish', 'Processing operative', 'Sample Seafoods', 'Whalsay', '£12.10/hr', 'fixed-term'),
  J('sample-job-driver', 'HGV driver', 'Sample Haulage', 'Sullom Voe', '£15.80/hr', 'permanent'),
];

/** The Work content a preview state shows. `live` is real production rows; other states are invented sample data. */
export function buildWork(state: PreviewState, mix: WorkMix | undefined, live: WorkSet, now: Date = new Date()): WorkSet {
  if (state === 'live') return { jobs: live.jobs, shifts: orderShifts(live.shifts, now) };
  if (state === 'empty') return { jobs: [], shifts: [] };
  const demo: WorkSet = state === 'seed' ? { jobs: SEED_JOBS, shifts: orderShifts([seedShift(now)], now) } : { jobs: FULL_JOBS, shifts: populatedShifts(now) };
  if (mix === 'none') return { jobs: [], shifts: [] };
  if (mix === 'jobs') return { jobs: demo.jobs, shifts: [] };
  if (mix === 'shifts') return { jobs: [], shifts: demo.shifts };
  return demo;
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

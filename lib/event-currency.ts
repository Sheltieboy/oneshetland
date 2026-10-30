/**
 * event-currency.ts — which events count as "on now or still to come".
 *
 * ONE RULE, EVERYWHERE
 * An event is CURRENT when it has not finished:
 *   · it has an end time and that end has not passed          (ends_at >= now), OR
 *   · it has no end time and it has not started yet           (starts_at >= now)
 *
 * The web What's On list already worked this way; the Home strip, the Local feed,
 * hub and business event lists, the planner and the mobile app still asked only
 * "has it started?" (`starts_at >= now`) and so dropped an event the instant it
 * began — a three-day festival or a six-week exhibition vanished from every one
 * of those surfaces while it was actually running.
 *
 * Deliberately NOT changed by this rule: an event with no end time keeps the
 * point-in-time behaviour (it leaves the lists when it starts). We do not invent
 * an end for it, and an old one-day event can never come back.
 *
 * TIME
 * Everything here compares absolute instants (the UTC `timestamptz` values the
 * database stores), so "now" is the same moment for a phone in Lerwick, a server
 * on UTC and a test. Local-calendar questions ("today", "this week") are the only
 * place a zone matters — see londonRangeEnd, which names Europe/London rather than
 * trusting the machine's clock (the zone convention is lib/shetland-time.ts).
 *
 * This module has no imports on purpose: the suites that execute it run under
 * `node --test`, whose resolver needs file extensions. The identical file lives
 * in both repos (oneshetland-web/lib and oneshetland-delivers/lib); each repo's
 * test pins the same golden behaviour so the copies cannot drift unnoticed.
 */

/** Shetland's timezone (mirrors SHETLAND_TZ in lib/shetland-time.ts; a test pins them equal). */
const SHETLAND_TZ = "Europe/London";

export type EventWindow = { starts_at: string; ends_at?: string | null };

const toMs = (v: Date | number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
};

/**
 * PostgREST `or(...)` body selecting current events. Use as `.or(currentEventsFilter(nowIso))`.
 * It is ANDed with every other filter on the query, so status / is_hidden / hub-approval
 * filters (and RLS, which is applied by the database regardless) are untouched.
 */
export function currentEventsFilter(nowIso: string): string {
  return `ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${nowIso})`;
}

/** Same rule as currentEventsFilter, evaluated in memory (lists already fetched, tests). */
export function isCurrentEvent(e: EventWindow, now: Date | number = new Date()): boolean {
  const n = toMs(now);
  const start = toMs(e.starts_at);
  const end = toMs(e.ends_at);
  if (n === null) return false;
  if (end !== null) return end >= n;
  return start !== null && start >= n;
}

/** Started and not finished — the "on now" part of current. An event with no end time is never ongoing. */
export function isOngoingEvent(e: EventWindow, now: Date | number = new Date()): boolean {
  const n = toMs(now);
  const start = toMs(e.starts_at);
  const end = toMs(e.ends_at);
  return n !== null && start !== null && end !== null && start <= n && end >= n;
}

/**
 * PostgREST `or(...)` body selecting events that are on at some point inside [from, to]
 * (the planner's window): started by `to`, and either not finished by `from` or — with no
 * end time — starting inside the window. A multi-day event that began before the window
 * but is still running qualifies; a finished one does not.
 */
export function overlapsWindowFilter(fromIso: string, toIso: string): string {
  return (
    `and(starts_at.lte.${toIso},ends_at.gte.${fromIso}),` +
    `and(ends_at.is.null,starts_at.gte.${fromIso},starts_at.lte.${toIso})`
  );
}

export function overlapsWindow(e: EventWindow, from: Date | number | string, to: Date | number | string): boolean {
  const f = toMs(from);
  const t = toMs(to);
  const start = toMs(e.starts_at);
  const end = toMs(e.ends_at);
  if (f === null || t === null || start === null) return false;
  if (end !== null) return start <= t && end >= f;
  return start >= f && start <= t;
}

/**
 * Sensible order for a current list: what is on now first (it started earliest), then what is
 * coming, soonest first. That is simply start-time order, which is what every query already
 * asks the database for — this exists for lists assembled or merged in memory. Ties break on
 * id so the result never depends on arrival order.
 */
export function compareCurrentEvents(a: EventWindow & { id?: string }, b: EventWindow & { id?: string }): number {
  const d = (toMs(a.starts_at) ?? 0) - (toMs(b.starts_at) ?? 0);
  if (d !== 0) return d;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/* ── Shetland calendar boundaries ─────────────────────────────────────────── */

const partsIn = (ms: number) => {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: SHETLAND_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const o: Record<string, string> = {};
  for (const x of p) o[x.type] = x.value;
  return {
    y: Number(o.year), m: Number(o.month), d: Number(o.day),
    h: Number(o.hour), mi: Number(o.minute), s: Number(o.second),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday),
  };
};

/** Milliseconds London is ahead of UTC at this instant (0 in winter, 3,600,000 in summer). */
const londonOffsetMs = (ms: number): number => {
  const p = partsIn(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** The instant of London local midnight at the start of y-m-d (month is 1-based; overflow rolls over). */
const londonMidnight = (y: number, m: number, d: number): number => {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - londonOffsetMs(guess);
  t = guess - londonOffsetMs(t);
  return t;
};

export type EventRange = "today" | "week" | "month" | "all";

/**
 * Upper bound (ISO) of a "Today / This week / This month" filter in SHETLAND time:
 * the last millisecond of today, of this Sunday, or of this month. "today" therefore means the
 * Shetland day on any server or phone, including the hour after midnight BST that a UTC
 * server's 23:59 cut-off used to get wrong. Undefined for "all".
 */
export function londonRangeEnd(range: EventRange, now: Date | number = new Date()): string | undefined {
  if (range === "all") return undefined;
  const n = toMs(now) ?? Date.now();
  const p = partsIn(n);
  let endExclusive: number;
  if (range === "today") endExclusive = londonMidnight(p.y, p.m, p.d + 1);
  else if (range === "week") endExclusive = londonMidnight(p.y, p.m, p.d + ((7 - p.dow) % 7) + 1);
  else endExclusive = londonMidnight(p.y, p.m + 1, 1);
  return new Date(endExclusive - 1).toISOString();
}

/** The Shetland calendar day (YYYY-MM-DD) an instant falls on — the same on any machine. */
export const londonDayKey = (d: Date | number | string): string =>
  new Date(toMs(d) ?? 0).toLocaleDateString("en-CA", { timeZone: SHETLAND_TZ });

/**
 * Is this current event on during today's Shetland day? Starts today, or began earlier and is still
 * running into today. Used for the "n on today" count so a festival in its second day is counted.
 */
export function isOnToday(e: EventWindow, now: Date | number = new Date()): boolean {
  if (!isCurrentEvent(e, now)) return false;
  const today = londonDayKey(now);
  const startDay = londonDayKey(e.starts_at);
  const endDay = toMs(e.ends_at) !== null ? londonDayKey(e.ends_at as string) : startDay;
  return startDay <= today && today <= endDay;
}

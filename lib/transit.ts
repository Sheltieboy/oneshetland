/**
 * transit.ts — Shetland public-transport journey planner (buses + ferries).
 *
 * IMPORTANT: published TIMETABLE data, not a live feed. Source: SIC bus guides
 * 2024–25 + inter-island ferry timetables. Sailings/departures can change, run
 * late, or (for some ferries) need pre-booking — always shown with that caveat.
 *
 * This is a GTFS-lite model: stops, trips (an ordered list of timed calls), and
 * a planner that chains a Lerwick bus to a connecting ferry to answer "what's my
 * last way home tonight?". The SIC timetables already mark the designed
 * bus↔ferry connections (code FERT = waits for the ferry at Toft), so the chain
 * mirrors real connections rather than inventing them.
 *
 * ROLLOUT: North Mainland (Service 23/21) + Yell/Unst/Fetlar ferry are encoded
 * first as the reviewable template. West/South/Lerwick-Scalloway + Bressay/
 * Whalsay ferries follow in the same shape. Keep web + app copies identical.
 */

export type TransitMode = 'bus' | 'ferry';

/** Coarse areas — an event's location and a user's "home" both resolve to one. */
export type TransitArea =
  | 'lerwick'          // Lerwick town
  | 'central'          // Tingwall, Girlsta, Nesting, Gott
  | 'scalloway'        // Scalloway, Burra, Trondra
  | 'north-mainland'   // Voe, Brae, Mossbank, Toft, Hillswick, Sullom
  | 'west-mainland'    // Aith, Bixter, Walls, Sandness
  | 'south-mainland'   // Cunningsburgh, Sandwick, Bigton, Sumburgh
  | 'yell'             // Yell
  | 'unst'             // Unst
  | 'fetlar'           // Fetlar
  | 'whalsay'          // Whalsay (+ Skerries)
  | 'bressay';         // Bressay

export interface TransitStop {
  id: string;
  name: string;
  area: TransitArea;
  /** true for ferry terminals where a bus→ferry transfer can happen. */
  ferryTerminal?: boolean;
}

/** Which days a trip runs. `days` is an explicit set of JS weekdays (0=Sun…6=Sat). */
export interface DayFlags {
  days: number[];
  schoolOnly?: boolean;   // Sch — term time only
  holidayOnly?: boolean;  // NSch — school holidays only
}

export interface Trip {
  id: string;
  service: string;        // "23", "Yell ferry"
  mode: TransitMode;
  routeLabel: string;     // "Service 23 · Lerwick → Toft"
  days: DayFlags;
  /** Ordered timed calls. time is 24h "HH:MM"; times < 04:00 are treated as
   *  after-midnight (belonging to the previous service evening). */
  calls: { stop: string; time: string }[];
  /** Ferry only: sailings at/after this time need pre-booking (not turn-up). */
  bookableFrom?: string;
  /** Ferry only: this specific sailing is booking-only (turn-up not guaranteed). */
  bookable?: boolean;
}

/* ── Time helpers ─────────────────────────────────────────────────────────── */

/** Minutes since midnight, with after-midnight times (<04:00) pushed to +1440
 *  so an 00:30 sailing sorts *after* a 23:00 one on the same evening. */
export function toMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  const v = h * 60 + m;
  return v < 240 ? v + 1440 : v;
}

export function fmtMins(mins: number): string {
  const v = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** Europe/London weekday (0=Sun…6=Sat) + minutes-since-midnight for an ISO time.
 *  Shetland is Europe/London, so this is correct regardless of the device/server
 *  timezone the code runs in. */
export function londonWhen(iso: string | null | undefined): { weekday: number; minutes: number } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wk: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wk[get('weekday')];
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { weekday, minutes: hour * 60 + minute };
}

/* ── Day evaluation ───────────────────────────────────────────────────────── */

/** Does a trip run on the given weekday? schoolTerm defaults to true (term time
 *  covers most of the year); only matters for Sch/NSch daytime trips. */
export function tripRunsOn(days: DayFlags, weekday: number, schoolTerm = true): boolean {
  if (!days.days.includes(weekday)) return false;
  if (days.schoolOnly && !schoolTerm) return false;
  if (days.holidayOnly && schoolTerm) return false;
  return true;
}

/* ── Planner ──────────────────────────────────────────────────────────────── */

export interface JourneyLeg {
  mode: TransitMode;
  service: string;
  routeLabel: string;
  fromStop: string;
  toStop: string;
  fromName: string; // human stop name to board at
  toName: string;   // human stop name to alight at
  depart: string;   // "HH:MM"
  arrive: string;   // "HH:MM"
  bookable?: boolean; // ferry leg needs pre-booking
}

export interface Journey {
  legs: JourneyLeg[];
  departMins: number;
  arriveMins: number;
  /** true if any leg needs pre-booking (ferry). */
  needsBooking: boolean;
}

const MIN_TRANSFER_MINS = 5; // buses/ferries advise being present ~5 min before
const MAX_LEGS = 5;

export interface PlanContext {
  stops: Record<string, TransitStop>;
  trips: Trip[];
}

interface Label {
  arriveMins: number;
  prevStop: string | null;
  viaTrip: string | null;
  boardStop: string | null;
  boardMins: number | null;
}

/** Stop ids belonging to an area. */
export function stopsInArea(ctx: PlanContext, area: TransitArea): string[] {
  return Object.values(ctx.stops).filter((s) => s.area === area).map((s) => s.id);
}

/**
 * Earliest-arrival label-setting over the whole network for one service day.
 * Seeds every start stop at startMins, then relaxes trips (riding to all later
 * calls), transferring between different trips at shared stops (MIN_TRANSFER).
 * Handles multi-leg chains up to MAX_LEGS (bus→ferry→bus→…). Returns the best
 * arrival label for every reachable stop.
 */
export function earliestArrival(
  ctx: PlanContext,
  startStops: string[],
  startMins: number,
  weekday: number,
  schoolTerm = true,
): Map<string, Label> {
  const trips = ctx.trips.filter((t) => tripRunsOn(t.days, weekday, schoolTerm));
  const best = new Map<string, Label>();
  for (const s of startStops) {
    best.set(s, { arriveMins: startMins, prevStop: null, viaTrip: null, boardStop: null, boardMins: null });
  }
  for (let pass = 0; pass < MAX_LEGS; pass++) {
    let changed = false;
    for (const trip of trips) {
      for (let i = 0; i < trip.calls.length - 1; i++) {
        const c = trip.calls[i];
        const cur = best.get(c.stop);
        if (!cur || cur.viaTrip === trip.id) continue; // unreached, or already on this trip
        const boardMins = toMins(c.time);
        const need = cur.viaTrip ? MIN_TRANSFER_MINS : 0; // transfer only between vehicles
        if (boardMins < cur.arriveMins + need) continue;
        for (let j = i + 1; j < trip.calls.length; j++) {
          const d = trip.calls[j];
          const arr = toMins(d.time);
          if (arr < boardMins) continue;
          const ex = best.get(d.stop);
          if (!ex || arr < ex.arriveMins) {
            best.set(d.stop, { arriveMins: arr, prevStop: c.stop, viaTrip: trip.id, boardStop: c.stop, boardMins });
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return best;
}

function reconstruct(ctx: PlanContext, best: Map<string, Label>, destStop: string): Journey | null {
  const legs: JourneyLeg[] = [];
  let stop: string | null = destStop;
  let guard = 0;
  while (stop && guard++ < MAX_LEGS + 2) {
    const label = best.get(stop);
    if (!label || !label.viaTrip || label.boardStop == null || label.boardMins == null) break;
    const trip = ctx.trips.find((t) => t.id === label.viaTrip);
    if (!trip) break;
    const bookable = trip.mode === 'ferry'
      ? (trip.bookable === true || (trip.bookableFrom ? label.boardMins >= toMins(trip.bookableFrom) : false))
      : false;
    legs.unshift({
      mode: trip.mode,
      service: trip.service,
      routeLabel: trip.routeLabel,
      fromStop: label.boardStop,
      toStop: stop,
      fromName: ctx.stops[label.boardStop]?.name ?? label.boardStop,
      toName: ctx.stops[stop]?.name ?? stop,
      depart: fmtMins(label.boardMins),
      arrive: fmtMins(label.arriveMins),
      bookable,
    });
    stop = label.prevStop;
  }
  if (!legs.length) return null;
  return {
    legs,
    departMins: toMins(legs[0].depart),
    arriveMins: toMins(legs[legs.length - 1].arrive),
    needsBooking: legs.some((l) => l.bookable),
  };
}

/** The earliest journey from any origin-area stop to the destination area,
 *  departing at/after floorMins. Returns null if none. */
export function planEarliestJourney(
  ctx: PlanContext,
  opts: { originArea: TransitArea; destArea: TransitArea; weekday: number; floorMins: number; schoolTerm?: boolean },
): Journey | null {
  const { originArea, destArea, weekday, floorMins, schoolTerm = true } = opts;
  const best = earliestArrival(ctx, stopsInArea(ctx, originArea), floorMins, weekday, schoolTerm);
  return bestDest(ctx, best, { area: destArea });
}

/** The LAST viable journey home: the latest departure from the origin area that
 *  still reaches the destination area, departing at/after floorMins. */
export function planLastJourney(
  ctx: PlanContext,
  opts: { originArea?: TransitArea; originStops?: string[]; destArea?: TransitArea; destStops?: string[]; weekday: number; floorMins: number; schoolTerm?: boolean },
): Journey | null {
  const { originArea, destArea, weekday, floorMins, schoolTerm = true } = opts;
  const destSel = opts.destStops ? { set: new Set(opts.destStops) } : { area: destArea };
  const originStops = new Set(opts.originStops ?? (originArea ? stopsInArea(ctx, originArea) : []));
  const runningTrips = ctx.trips.filter((t) => tripRunsOn(t.days, weekday, schoolTerm));
  // Candidate departure times = any trip call leaving an origin-area stop.
  const deps = new Set<number>();
  for (const t of runningTrips) {
    for (let i = 0; i < t.calls.length - 1; i++) {
      if (originStops.has(t.calls[i].stop)) {
        const m = toMins(t.calls[i].time);
        if (m >= floorMins) deps.add(m);
      }
    }
  }
  for (const dep of [...deps].sort((a, b) => b - a)) {
    const best = earliestArrival(ctx, [...originStops], dep, weekday, schoolTerm);
    const j = bestDest(ctx, best, destSel);
    if (j) return j; // iterating latest-first → first hit is the last way home
  }
  return null;
}

/**
 * Guard against transcription artifacts: a bus leg between two DIFFERENT areas
 * can't take under ~5 min (the shortest real inter-area hop is the 7-min Bressay
 * ferry). A sub-5-min bus area-crossing means a mis-aligned timetable cell, so we
 * reject that journey and let the planner fall back to a real one.
 */
function isPlausible(ctx: PlanContext, j: Journey): boolean {
  for (const leg of j.legs) {
    if (leg.mode !== 'bus') continue;
    if (ctx.stops[leg.fromStop]?.area === ctx.stops[leg.toStop]?.area) continue;
    const d = (toMins(leg.arrive) - toMins(leg.depart) + 1440) % 1440;
    if (d < 5) return false;
  }
  return true;
}

/** Candidate dest stops (in an area, or an explicit set), earliest arrival first. */
function destCandidates(ctx: PlanContext, best: Map<string, Label>, opts: { area?: TransitArea; set?: Set<string>; cap?: number }): string[] {
  const rows: { sid: string; arr: number }[] = [];
  for (const [sid, label] of best) {
    if (!label.viaTrip) continue;
    if (opts.area && ctx.stops[sid]?.area !== opts.area) continue;
    if (opts.set && !opts.set.has(sid)) continue;
    if (opts.cap != null && label.arriveMins > opts.cap) continue;
    rows.push({ sid, arr: label.arriveMins });
  }
  return rows.sort((a, b) => a.arr - b.arr).map((r) => r.sid);
}

/** Plausible journeys to the destination, preferring fewer legs (cleaner routes). */
function plausibleJourneys(ctx: PlanContext, best: Map<string, Label>, opts: { area?: TransitArea; set?: Set<string>; cap?: number }): Journey[] {
  return destCandidates(ctx, best, opts)
    .map((sid) => reconstruct(ctx, best, sid))
    .filter((j): j is Journey => !!j && isPlausible(ctx, j));
}

/** The earliest, fewest-leg plausible journey into the destination (area or stops). */
function bestDest(ctx: PlanContext, best: Map<string, Label>, sel: { area?: TransitArea; set?: Set<string> }): Journey | null {
  const cands = plausibleJourneys(ctx, best, sel);
  cands.sort((a, b) => a.legs.length - b.legs.length || a.arriveMins - b.arriveMins);
  return cands[0] ?? null;
}

/**
 * The journey that gets you TO the destination in time: the latest departure
 * from the origin whose arrival is at/before arriveByMins (cut it as fine as the
 * timetable allows). destStops pins a precise arrival point (the event's stop);
 * otherwise any stop in destArea counts. Returns null if you can't make it.
 */
export function planArriveBy(
  ctx: PlanContext,
  opts: {
    originArea?: TransitArea; originStops?: string[];
    destArea?: TransitArea; destStops?: string[];
    arriveByMins: number; weekday: number; schoolTerm?: boolean;
  },
): Journey | null {
  const { arriveByMins, weekday, schoolTerm = true } = opts;
  const originStops = opts.originStops ?? (opts.originArea ? stopsInArea(ctx, opts.originArea) : []);
  const destSet = new Set(opts.destStops ?? (opts.destArea ? stopsInArea(ctx, opts.destArea) : []));
  const oSet = new Set(originStops);
  const running = ctx.trips.filter((t) => tripRunsOn(t.days, weekday, schoolTerm));
  const deps = new Set<number>();
  for (const t of running) {
    for (let i = 0; i < t.calls.length - 1; i++) {
      if (oSet.has(t.calls[i].stop)) {
        const m = toMins(t.calls[i].time);
        if (m <= arriveByMins) deps.add(m);
      }
    }
  }
  for (const dep of [...deps].sort((a, b) => b - a)) {
    const best = earliestArrival(ctx, originStops, dep, weekday, schoolTerm);
    // For the latest workable departure, take the fewest-leg plausible arrival
    // (then latest arrival) — avoids both bad-cell hops and pointless transfers.
    const cands = plausibleJourneys(ctx, best, { set: destSet, cap: arriveByMins });
    cands.sort((a, b) => a.legs.length - b.legs.length || b.arriveMins - a.arriveMins);
    if (cands[0]) return cands[0];
  }
  return null;
}

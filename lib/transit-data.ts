/**
 * transit-data.ts — the Shetland transit network + the "Getting home" planner
 * API used by the event page.
 *
 * The network ({stops, trips}) is GENERATED from the SIC bus guides 2024–25 and
 * the inter-island ferry timetables by scripts/normalize-transit — do not edit
 * transit-network.json by hand; re-run the normaliser when timetables change.
 * Published timetable data, not a live feed. Keep web + app copies identical.
 */
import {
  planLastJourney, planArriveBy, stopsInArea, londonWhen,
  type Trip, type TransitStop, type TransitArea, type Journey, type PlanContext,
} from './transit';
import network from './transit-network.json';

export const STOPS = network.stops as Record<string, TransitStop>;
export const TRIPS = network.trips as Trip[];
const CTX: PlanContext = { stops: STOPS, trips: TRIPS };

export const AREA_LABELS: Record<TransitArea, string> = {
  lerwick: 'Lerwick',
  central: 'Central Mainland',
  scalloway: 'Scalloway & Burra',
  'north-mainland': 'North Mainland',
  'west-mainland': 'West Mainland',
  'south-mainland': 'South Mainland',
  yell: 'Yell',
  unst: 'Unst',
  fetlar: 'Fetlar',
  whalsay: 'Whalsay',
  bressay: 'Bressay',
};

/** Hub areas — for events here we plan OUTWARD to the isles/rural areas. */
const HUB_AREAS: TransitArea[] = ['lerwick', 'central'];
/** Outward destinations shown for a hub event (order = display order). */
const OUTWARD_DESTS: TransitArea[] = [
  'north-mainland', 'west-mainland', 'south-mainland', 'scalloway',
  'bressay', 'whalsay', 'yell', 'unst', 'fetlar',
];

/** Weekdays (0=Sun…6=Sat) that have any bus service in the network. */
const BUS_DAYS = new Set<number>();
for (const t of TRIPS) if (t.mode === 'bus') for (const d of t.days.days) BUS_DAYS.add(d);
export function hasBusData(weekday: number): boolean {
  return BUS_DAYS.has(weekday);
}

/** Locality/venue keyword → area. Primary signal (most events have a locality). */
// Exact venue → area, user-verified. Checked before keywords (authoritative).
const VENUE_OVERRIDES: Record<string, TransitArea> = {
  'carnegie hall': 'lerwick',
  'gulberwick hall': 'south-mainland',
  'ness boating club': 'south-mainland',
  'brae': 'north-mainland',
  'voe': 'north-mainland',
  'vidlin': 'north-mainland',
};

const AREA_KEYWORDS: [RegExp, TransitArea][] = [
  // Lerwick — town names + the main venues (whose names don't contain "Lerwick").
  [/\b(lerwick|clickimin|breiwick|sound|mareel|islesburgh|garrison|town hall|shetland library|shetland museum|\bmuseum\b|british legion|\blegion\b|bod of gremista|north ness|staney hill|hayfield|gilbertson|anderson high|gilbert bain|kveldsro|grand hotel|lerwick hotel)\b/, 'lerwick'],
  [/\b(scalloway|burra|hamnavoe|trondra|houss|papil)\b/, 'scalloway'],
  [/\b(tingwall|gott|girlsta|nesting|whiteness|weisdale|wormadale|skellister)\b/, 'central'],
  [/\b(voe|brae|mossbank|toft|hillswick|sullom|vidlin|laxo|ollaberry|north roe|muckle roe|delting|northmavine|eshaness)\b/, 'north-mainland'],
  [/\b(aith|bixter|walls|sandness|west burrafirth|twatt|effirth|reawick|skeld|sand)\b/, 'west-mainland'],
  [/\b(cunningsburgh|gulberwick|sandwick|levenwick|bigton|boddam|sumburgh|virkie|dunrossness|quendale|hoswick|channerwick|toab|exnaboe|ness boating)\b/, 'south-mainland'],
  [/\b(unst|baltasound|uyeasound|haroldswick|saxavord|belmont|norwick|muness)\b/, 'unst'],
  [/\b(fetlar|houbie|funzie)\b/, 'fetlar'],
  [/\b(yell|ulsta|mid yell|gutcher|cullivoe|sellafirth|burravoe|aywick)\b/, 'yell'],
  [/\b(whalsay|symbister|skerries)\b/, 'whalsay'],
  [/\b(beosetter|kirkabister|heogan|bressay)\b/, 'bressay'],
];

/**
 * Resolve an event to a transit area from its locality/venue text (primary) then
 * lat/lng (fallback). Returns null when we can't place it confidently — the UI
 * then stays silent rather than planning from the wrong place.
 */
export function detectEventArea(
  locality: string | null | undefined,
  venue: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): TransitArea | null {
  const venueKey = (venue ?? '').trim().toLowerCase();
  if (VENUE_OVERRIDES[venueKey]) return VENUE_OVERRIDES[venueKey];
  const text = `${locality ?? ''} ${venue ?? ''}`.toLowerCase();
  for (const [re, area] of AREA_KEYWORDS) if (re.test(text)) return area;
  if (typeof lat === 'number' && typeof lng === 'number') {
    if (lat >= 60.72) return 'unst';
    if (lat >= 60.60 && lng >= -0.95) return 'fetlar';
    if (lat >= 60.48) return 'yell';
    if (lat >= 60.30 && lat <= 60.45 && lng >= -1.05) return 'whalsay';
    if (lat <= 60.10) return 'south-mainland';
    if (lng <= -1.33 && lat <= 60.40) return 'west-mainland';
    if (lat >= 60.33) return 'north-mainland';
    if (lng >= -1.15 && lng <= -1.05 && lat >= 60.10 && lat <= 60.18) return 'bressay';
    if (lng <= -1.24 && lat >= 60.11 && lat <= 60.17) return 'scalloway';
    if (lat >= 60.11 && lat <= 60.19 && lng >= -1.2 && lng <= -1.1) return 'lerwick';
    return 'central';
  }
  return null;
}

/** Generic venue/stop-name words to ignore when matching an event to a stop. */
const STOP_STOPWORDS = new Set([
  'hall', 'school', 'road', 'junction', 'terminal', 'church', 'shop', 'street', 'centre', 'center',
  'park', 'pier', 'jetty', 'crossroads', 'area', 'primary', 'health', 'public', 'community', 'leisure',
  'sports', 'social', 'club', 'hotel', 'market', 'cross', 'business', 'estate', 'college', 'lower',
  'upper', 'north', 'south', 'east', 'west', 'opp', 'arrive', 'depart', 'road.',
]);

/**
 * Best-matching stop id for an event, from its locality/venue text — so an outer
 * event plans from its OWN stop (e.g. Cunningsburgh, Baltasound) rather than the
 * whole area (which would pick the stop nearest Lerwick). Restricted to the
 * event's area to avoid cross-Shetland name clashes (Sandwick vs West Sandwick).
 * Returns null if unsure.
 */
export function detectEventStop(
  locality: string | null | undefined,
  venue: string | null | undefined,
  area: TransitArea | null,
): string | null {
  const text = `${locality ?? ''} ${venue ?? ''}`.toLowerCase();
  if (!text.trim()) return null;
  // Exact name match first — handles short place-names ("Voe") the token pass skips.
  const exact = (venue ?? locality ?? '').trim().toLowerCase();
  if (exact) {
    for (const s of Object.values(STOPS)) {
      if (area && s.area !== area) continue;
      if (s.name.toLowerCase() === exact) return s.id;
    }
  }
  let best: string | null = null;
  let bestLen = 0;
  for (const s of Object.values(STOPS)) {
    if (area && s.area !== area) continue; // only match within the event's own area
    const tokens = s.name.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4 && !STOP_STOPWORDS.has(t));
    for (const tok of tokens) {
      if (text.includes(tok) && tok.length > bestLen) {
        bestLen = tok.length;
        best = s.id;
      }
    }
  }
  return best;
}

export interface HomeOption {
  area: TransitArea;
  label: string;
  journey: Journey;
  /** true when the last journey home departs before the event is due to end. */
  leavesBeforeEnd: boolean;
}

export interface WaysHome {
  /** How the list reads: outward from a hub event, or inward to the hub. */
  mode: 'from-hub' | 'to-hub';
  options: HomeOption[];
}

/**
 * The last way home for an event, anchored on the event's OWN area:
 *  • hub event (Lerwick/central) → last journeys OUT to each isle/rural area
 *  • outer event                 → last journey IN to Lerwick (the cutoff to leave)
 * Times are computed in Europe/London. Returns null when nothing plannable.
 */
export function lastWaysHome(
  eventArea: TransitArea | null,
  startsAt: string | null | undefined,
  endsAt?: string | null,
  originStop?: string | null,
): WaysHome | null {
  if (!eventArea) return null;
  const when = londonWhen(startsAt);
  if (!when) return null;
  const endWhen = endsAt ? londonWhen(endsAt) : null;
  const endMins = endWhen ? endWhen.minutes : when.minutes + 180;
  // Plan the LAST journey of the day (floor at the whole day), then flag whether
  // it departs before the event ends — island connections often dry up in the
  // afternoon, and "the last way off leaves at 16:05" is the useful answer.
  const floor = 0;
  const opt = (area: TransitArea, journey: Journey): HomeOption => ({
    area, label: AREA_LABELS[area], journey, leavesBeforeEnd: journey.departMins < endMins,
  });

  if (HUB_AREAS.includes(eventArea)) {
    const options: HomeOption[] = [];
    for (const dest of OUTWARD_DESTS) {
      const j = planLastJourney(CTX, { originArea: 'lerwick', destArea: dest, weekday: when.weekday, floorMins: floor });
      if (j) options.push(opt(dest, j));
    }
    return options.length ? { mode: 'from-hub', options } : null;
  }

  // Anchor on the event's own stop when we can match one (so an elongated area
  // like South/West Mainland plans from the event, not the stop nearest Lerwick).
  const useStop = originStop && STOPS[originStop] ? [originStop] : undefined;
  const j = planLastJourney(CTX, useStop
    ? { originStops: useStop, destArea: 'lerwick', weekday: when.weekday, floorMins: floor }
    : { originArea: eventArea, destArea: 'lerwick', weekday: when.weekday, floorMins: floor });
  return j ? { mode: 'to-hub', options: [opt('lerwick', j)] } : null;
}

export { STOPS as TRANSIT_STOPS };

/* ── Picker-driven planner (user chooses their exact stop) ─────────────────── */

const AREA_ORDER: TransitArea[] = ['lerwick', 'central', 'scalloway', 'north-mainland', 'west-mainland', 'south-mainland', 'bressay', 'whalsay', 'yell', 'unst', 'fetlar'];

export interface StopOption { id: string; name: string; area: TransitArea; areaLabel: string; }

/**
 * Every stop the user can pick as their home stop, grouped by area then name.
 * Selecting a precise stop (not a coarse area) is what makes the plan exact.
 */
export const STOP_OPTIONS: StopOption[] = Object.values(STOPS)
  .map((s) => ({ id: s.id, name: s.name, area: s.area, areaLabel: AREA_LABELS[s.area] }))
  .sort((a, b) =>
    (AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area)) || a.name.localeCompare(b.name),
  );

/** A sensible default home stop (Lerwick's Viking Bus Station, else any Lerwick stop). */
export const DEFAULT_STOP: string =
  (STOPS['viking-bus-station'] && 'viking-bus-station') ||
  STOP_OPTIONS.find((s) => s.area === 'lerwick')?.id ||
  STOP_OPTIONS[0]?.id || '';

/** Pick a representative stop for an area (for defaulting from a profile's home area). */
export function defaultStopForArea(area: TransitArea | null | undefined): string {
  if (!area) return DEFAULT_STOP;
  return STOP_OPTIONS.find((s) => s.area === area)?.id ?? DEFAULT_STOP;
}

export interface TravelResult {
  journey: Journey | null;
  /** getting-home only: the last way home leaves before the event is due to end. */
  leavesBeforeEnd?: boolean;
  /** getting-home only: the last feasible way home leaves before the event even
   *  STARTS — so it's a hard cutoff (leave early / lift / stay over), not a
   *  post-event journey. */
  departsBeforeStart?: boolean;
  /** true when origin and event are the same area — no ferry/bus needed. */
  local?: boolean;
}

const eventOriginStops = (eventArea: TransitArea, eventStop: string | null | undefined): string[] =>
  eventStop && STOPS[eventStop] ? [eventStop] : stopsInArea(CTX, eventArea);

/** Whether the home stop is at/beside the event (same stop, or both in one area). */
function isLocal(homeStop: string, eventArea: TransitArea, eventStop: string | null | undefined): boolean {
  if (eventStop && homeStop === eventStop) return true;
  return STOPS[homeStop]?.area === eventArea;
}

/**
 * Getting THERE: from the user's chosen stop to the event, arriving before it
 * starts. Targets the event's AREA (arrive anywhere in it, walk the last bit),
 * so it doesn't fail when buses don't call the exact venue stop.
 */
export function planThere(
  homeStop: string,
  eventArea: TransitArea,
  eventStop: string | null | undefined,
  startsAt: string | null | undefined,
): TravelResult {
  if (!STOPS[homeStop]) return { journey: null };
  if (isLocal(homeStop, eventArea, eventStop)) return { journey: null, local: true };
  const when = londonWhen(startsAt);
  if (!when) return { journey: null };
  const journey = planArriveBy(CTX, {
    originStops: [homeStop],
    destArea: eventArea,
    arriveByMins: when.minutes,
    weekday: when.weekday,
  });
  return { journey };
}

/**
 * Getting HOME: from the event to the user's chosen stop, the last feasible way
 * of the day. `departsBeforeStart`/`leavesBeforeEnd` say how it relates to the event.
 */
export function planHomeTo(
  eventArea: TransitArea,
  eventStop: string | null | undefined,
  homeStop: string,
  startsAt: string | null | undefined,
  endsAt?: string | null,
): TravelResult {
  if (!STOPS[homeStop]) return { journey: null };
  if (isLocal(homeStop, eventArea, eventStop)) return { journey: null, local: true };
  const when = londonWhen(startsAt);
  if (!when) return { journey: null };
  // The LAST feasible way home of the day (floor at midnight). We then say how it
  // relates to the event: a normal after-event journey, one you'd leave early for,
  // or a hard cutoff that departs before the event even starts.
  const journey = planLastJourney(CTX, {
    originStops: eventOriginStops(eventArea, eventStop),
    destStops: [homeStop],
    weekday: when.weekday,
    floorMins: 0,
  });
  if (!journey) return { journey: null };
  const endMins = endsAt ? (londonWhen(endsAt)?.minutes ?? when.minutes + 180) : when.minutes + 180;
  return {
    journey,
    leavesBeforeEnd: journey.departMins < endMins,
    departsBeforeStart: journey.departMins < when.minutes,
  };
}

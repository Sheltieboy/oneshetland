/**
 * ferry-timetable.ts — curated last-ferry data for the "Getting there" panel.
 *
 * IMPORTANT: this is the *published timetable*, not a live feed. Times are the
 * last GUARANTEED turn-up sailing FROM the Mainland terminal TO each island —
 * we deliberately do NOT headline booking-only late sailings (marked * on the
 * SIC timetables), because those don't run unless pre-booked and quoting them
 * could strand someone. Always shown with a "timetabled times" caveat.
 *
 * Source: Shetland Islands Council inter-island ferry timetables
 *   - Yell/Unst/Fetlar — effective 4 Jul 2026
 *   - Bressay/Whalsay/Skerries/Papa Stour/Foula/Fair Isle — effective 6 Oct 2025
 *
 * Scope: the three single-leg commuter isles (Bressay, Whalsay, Yell). Multi-leg
 * (Unst/Fetlar via Yell) and booking-only routes (Skerries, Papa Stour, Foula,
 * Fair Isle) are intentionally omitted from the headline — see FERRY_MORE_INFO.
 *
 * Keep in sync with the web copy at oneshetland-web/lib/ferry-timetable.ts.
 */

export type FerryDayBucket = "monThu" | "fri" | "sat" | "sun";

export interface FerryRoute {
  /** Island people are heading back to. */
  island: string;
  /** Mainland terminal the sailing departs from. */
  from: string;
  /** Island terminal it arrives at. */
  to: string;
  /** Last guaranteed turn-up departure (24h "HH:MM") per day bucket. */
  last: Record<FerryDayBucket, string>;
  /** Whether a later booking-only sailing exists (shown as a caveat). */
  hasLaterBookable?: boolean;
}

/** Last turn-up sailings from the Mainland to each commuter isle. */
export const FERRY_ROUTES: FerryRoute[] = [
  {
    island: "Bressay",
    from: "Lerwick",
    to: "Bressay",
    last: { monThu: "23:00", fri: "01:00", sat: "01:00", sun: "23:00" },
  },
  {
    island: "Whalsay",
    from: "Laxo",
    to: "Symbister",
    last: { monThu: "23:30", fri: "00:30", sat: "00:30", sun: "23:30" },
  },
  {
    island: "Yell",
    from: "Toft",
    to: "Ulsta",
    last: { monThu: "22:00", fri: "22:00", sat: "22:00", sun: "22:00" },
    hasLaterBookable: true,
  },
];

export const FERRY_MORE_INFO =
  "Unst, Fetlar, Skerries, Papa Stour, Foula and Fair Isle run by booking — ferry.shetland.gov.uk";

/** Island localities where a "last ferry back" prompt makes no sense. */
const ISLAND_LOCALITIES = [
  "yell", "unst", "fetlar", "whalsay", "bressay", "skerries", "out skerries",
  "papa stour", "foula", "fair isle",
];

/**
 * Whether an event is at/near the Lerwick hub, where "last ferry/bus home to the
 * isles" is the correct reading. Everywhere else (islands, other Mainland areas)
 * a Lerwick-origin journey home is wrong, so the planner stays hidden until the
 * location-anchored, full-network version lands. Uses locality keywords + a
 * Lerwick lat/lng box so it catches venues like "Clickimin" that aren't "Lerwick".
 */
export function eventNearLerwick(
  locality: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  const loc = (locality ?? "").trim().toLowerCase();
  if (/\b(lerwick|gulberwick|sound|breiwick|clickimin|staney hill|nederdale)\b/.test(loc)) return true;
  if (typeof lat === "number" && typeof lng === "number" && lat >= 60.11 && lat <= 60.19 && lng >= -1.2 && lng <= -1.08) {
    return true;
  }
  return false;
}

/** Map a JS weekday (0=Sun … 6=Sat) to the timetable's day bucket. */
export function ferryDayBucket(weekday: number): FerryDayBucket {
  if (weekday === 0) return "sun";
  if (weekday === 5) return "fri";
  if (weekday === 6) return "sat";
  return "monThu";
}

export interface LastFerry {
  island: string;
  time: string;
  hasLaterBookable: boolean;
}

/**
 * The last turn-up ferries back to the commuter isles for a given event date.
 * Returns null when the event is itself on a ferry-served island (no point
 * telling an islander the last boat home to their own island).
 */
export function lastFerriesForEvent(
  startsAt: string | null | undefined,
  locality: string | null | undefined,
): LastFerry[] | null {
  if (locality && ISLAND_LOCALITIES.includes(locality.trim().toLowerCase())) {
    return null;
  }
  const d = startsAt ? new Date(startsAt) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const bucket = ferryDayBucket(d.getDay());
  return FERRY_ROUTES.map((r) => ({
    island: r.island,
    time: r.last[bucket],
    hasLaterBookable: !!r.hasLaterBookable,
  }));
}

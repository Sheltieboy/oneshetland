/**
 * event-categories.ts — one logical category per kind of event, whatever is stored.
 *
 * WHY
 * The event forms (web and app) offer twelve categories. The 56 original events were created
 * earlier, under an older vocabulary ("Music & Gigs", "Family & Kids", "Heritage & Culture"…),
 * and the database still holds those words. The web filter chips are built from the stored values,
 * so a visitor would have seen "Music" AND "Music & Gigs" as two separate choices, and picking
 * "Music" (an exact match) hid every legacy gig. The app's chips were the static twelve, so its
 * legacy events could not be reached by any chip at all.
 *
 * Stored values are NOT rewritten (a later clean-up may do that). This module maps at read time:
 *   · normaliseCategory()  — what a stored value is called to the user
 *   · storedValuesFor()    — every stored value a chosen category must match in a query
 *   · uniqueCategories()   — chips, one per logical category
 *
 * THE MAPPING IS DERIVED FROM PRODUCTION, NOT FROM CODE
 * No legacy name appears anywhere in the code. It was read from the 56 original events (15 distinct
 * values; query recorded in the Stage 4A.5A report) and checked against the event titles, using the same
 * judgements the Stage 4A imports applied (comedy, books, drama, museum events → "Arts & Culture").
 * Two are judgement calls, both on events that have already happened:
 *   · "Charity & Community" → Community   (quiz night, coffee morning, variety concert)
 *   · "Sports & Outdoors"   → Sport       (a walking group, a parasport festival, a race, a rally)
 * An UNKNOWN value (anything not listed) is left exactly as stored: it keeps its own chip and its own
 * label rather than being silently bucketed, and nothing here throws on it.
 *
 * No imports, identical copy in both repos — see lib/event-currency.ts for why.
 */

/** The twelve categories the event forms offer (mirrors EVENT_CATEGORIES in events-data / events-api). */
export const CURRENT_EVENT_CATEGORIES = [
  "Music", "Arts & Culture", "Market", "Community", "Outdoors", "Sport",
  "Family", "Food & Drink", "Charity", "Business", "Festival", "Other",
] as const;

/** LEGACY stored value → current category. Exactly the legacy values found on the original events. */
export const LEGACY_CATEGORY_MAP: Readonly<Record<string, string>> = {
  "Art & Exhibitions": "Arts & Culture",
  "Charity & Community": "Community",
  "Cinema": "Arts & Culture",
  "Comedy": "Arts & Culture",
  "Family & Kids": "Family",
  "Festivals & Celebrations": "Festival",
  "Heritage & Culture": "Arts & Culture",
  "Literature": "Arts & Culture",
  "Music & Gigs": "Music",
  "Sports & Outdoors": "Sport",
  "Theatre": "Arts & Culture",
};

const key = (s: string) => s.trim().toLowerCase();

const CURRENT_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  CURRENT_EVENT_CATEGORIES.map((c) => [key(c), c]),
);
const LEGACY_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_CATEGORY_MAP).map(([legacy, current]) => [key(legacy), current]),
);

/**
 * The category a stored value belongs to, as the user should see it. null for no category
 * (missing, empty, or not a string). Matching ignores case and surrounding spaces; an unknown
 * value is returned trimmed but otherwise unchanged.
 */
export function normaliseCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return CURRENT_BY_KEY[key(t)] ?? LEGACY_BY_KEY[key(t)] ?? t;
}

/**
 * Every stored value that a query for `category` must match: the current name plus each legacy
 * name that maps to it. Accepts a legacy or current name; an unknown category matches only itself.
 * Empty array for no category (callers then apply no category filter).
 */
export function storedValuesFor(category: unknown): string[] {
  const logical = normaliseCategory(category);
  if (!logical) return [];
  const out = [logical];
  for (const [legacy, current] of Object.entries(LEGACY_CATEGORY_MAP)) {
    if (current === logical) out.push(legacy);
  }
  return out;
}

/** True when two stored values are the same logical category (a null/empty never matches). */
export function sameCategory(a: unknown, b: unknown): boolean {
  const x = normaliseCategory(a);
  return x !== null && x === normaliseCategory(b);
}

/**
 * One chip per logical category, alphabetical (the order the web chips already used). Input is the
 * stored values of whatever events are being shown; nulls and blanks are skipped.
 */
export function uniqueCategories(stored: Iterable<unknown>): string[] {
  const set = new Set<string>();
  for (const v of stored) {
    const c = normaliseCategory(v);
    if (c) set.add(c);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

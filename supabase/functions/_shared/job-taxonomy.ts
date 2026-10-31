/**
 * job-taxonomy.ts — one vocabulary for jobs: categories, contract types, Shetland areas, closing dates.
 *
 * WHY
 * Jobs are about to come from many sources (the council feed today; NHS, charities, UHI, marine and energy employers, direct postings
 * next). Every one of them has to land in the same words, or the filters, cards and dashboards drift apart. The Stage 1 audit found
 * the vocabulary existed only inside the web UI, the database held no category at all (30 of 30 jobs NULL), and "Temporary" was being
 * filed as "casual". This module is the single definition; web, app and the sync function each carry an identical copy, pinned by a
 * parity test (as lib/event-categories.ts does).
 *
 * RULES
 *  · Nothing here guesses. categoryFromTitle() returns a category only when exactly ONE category's unambiguous words appear; otherwise
 *    null. areaForLocation() matches explicit place tokens only; "Shetland (see advert)" is Shetland-wide, anything unknown is null.
 *  · A null/unknown category is a normal state, not an error: nothing here throws.
 *  · Closing dates are shown in Shetland time (Europe/London), never the viewer's or server's zone.
 *
 * No imports, so `node --test` and Deno load it directly.
 */

/* ── Categories ───────────────────────────────────────────────────────────── */

export const JOB_CATEGORIES = [
  "Hospitality", "Maritime", "Aquaculture", "Energy", "Care", "Health",
  "Retail", "Trades", "Construction", "Tourism", "Education", "Public sector",
  "Office & admin", "Transport", "Crofting", "Other",
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

const CAT_BY_KEY: Readonly<Record<string, JobCategory>> = Object.fromEntries(JOB_CATEGORIES.map((c) => [c.toLowerCase(), c]));

/** The canonical category for a stored value (case/space-insensitive), or null for missing/unknown. */
export function normaliseJobCategory(raw: unknown): JobCategory | null {
  if (typeof raw !== "string") return null;
  return CAT_BY_KEY[raw.trim().toLowerCase()] ?? null;
}

/** Stored values that count as `category` in a query (canonical only; a null/unknown category yields no filter). */
export function jobCategoryFilterValue(raw: unknown): JobCategory | null {
  return normaliseJobCategory(raw);
}

/** Chips: the canonical categories that at least one live job has, in the canonical order. Unknown/null values are ignored. */
export function jobCategoriesInUse(stored: Iterable<unknown>): JobCategory[] {
  const seen = new Set<JobCategory>();
  for (const v of stored) { const c = normaliseJobCategory(v); if (c) seen.add(c); }
  return JOB_CATEGORIES.filter((c) => seen.has(c));
}

/**
 * FRAMEWORK for Stage 3 — deterministic and conservative. Each rule lists whole words that only make sense in one category.
 * A title matching rules of exactly one category gets it; matching none or several gives null. Not used to rewrite existing rows.
 */
const TITLE_RULES: ReadonlyArray<readonly [JobCategory, RegExp]> = [
  ["Care", /\b(social care|care assistant|care worker|carer|support worker|care home|care centre)\b/i],
  ["Health", /\b(nurse|nursing|midwife|doctor|gp|physiotherapist|pharmacist|radiographer|dentist|clinician|paramedic)\b/i],
  ["Education", /\b(teacher|lecturer|head teacher|learning support|classroom|nursery|early learning|tutor)\b/i],
  ["Maritime", /\b(deckhand|skipper|mariner|seafarer|ship'?s? (cook|master|engineer)|ferry crew|harbour)\b/i],
  ["Aquaculture", /\b(fish farm|salmon|hatchery|aquaculture|mussel)\b/i],
  ["Energy", /\b(wind farm|turbine|oil and gas|offshore (installation|worker)|power station|sullom voe terminal)\b/i],
  ["Hospitality", /\b(chef|barista|waiter|waitress|bar staff|kitchen porter|hotel receptionist)\b/i],
  ["Retail", /\b(shop assistant|sales assistant|retail assistant|cashier|checkout)\b/i],
  ["Construction", /\b(bricklayer|joiner|plasterer|roofer|labourer|groundworker|site manager)\b/i],
  ["Transport", /\b(hgv|lgv|pcv|bus driver|taxi driver|van driver|courier|delivery driver)\b/i],
  ["Crofting", /\b(croft|crofter|shepherd|farm hand|farmhand)\b/i],
  ["Office & admin", /\b(administrator|administrative|receptionist|office manager|bookkeeper|secretary|clerical)\b/i],
];
export function categoryFromTitle(title: unknown): JobCategory | null {
  if (typeof title !== "string" || !title.trim()) return null;
  const hits = TITLE_RULES.filter(([, re]) => re.test(title)).map(([c]) => c);
  return hits.length === 1 ? hits[0] : null;
}

/* ── Contract types ───────────────────────────────────────────────────────── */

export const JOB_CONTRACT_TYPES = ["full-time", "part-time", "casual", "temporary", "apprenticeship", "volunteer", "freelance"] as const;
export type JobContractType = (typeof JOB_CONTRACT_TYPES)[number];

export const JOB_CONTRACT_LABELS: Readonly<Record<JobContractType, string>> = {
  "full-time": "Full-time", "part-time": "Part-time", casual: "Casual", temporary: "Temporary",
  apprenticeship: "Apprenticeship", volunteer: "Volunteer", freelance: "Freelance",
};

/** Label for a stored contract type; an unknown value is shown capitalised rather than hidden or thrown on. */
export function contractLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const k = raw.trim().toLowerCase();
  if ((JOB_CONTRACT_TYPES as readonly string[]).includes(k)) return JOB_CONTRACT_LABELS[k as JobContractType];
  const t = raw.trim().replace(/[-_]+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ── Shetland areas ───────────────────────────────────────────────────────── */

export const JOB_AREAS = [
  "Lerwick", "Scalloway", "Bressay", "Burra", "South Mainland", "Westside", "North Mainland", "Brae / Sullom Voe",
  "Whalsay", "Yell", "Unst", "Fetlar", "Shetland-wide", "Offshore / marine", "Remote / hybrid",
] as const;
export type JobArea = (typeof JOB_AREAS)[number];

/** Explicit place tokens only. Ambiguous or unknown places are deliberately absent (they map to null). */
const AREA_TOKENS: ReadonlyArray<readonly [JobArea, RegExp]> = [
  ["Lerwick", /\b(lerwick|north ness|gilbert bain|anderson high|islesburgh|montfield|grantfield|newcraigielea|annsbrae)\b/i],
  ["Scalloway", /\bscalloway\b/i],
  ["Bressay", /\bbressay\b/i],
  ["Burra", /\b(burra|hamnavoe)\b/i],
  ["South Mainland", /\b(levenwick|sandwick|cunningsburgh|dunrossness|sumburgh|virkie|bigton|quarff|gulberwick)\b/i],
  ["Westside", /\b(aith|walls|sandness|bixter|weisdale|happy ?hansel|skeld|clousta)\b/i],
  ["North Mainland", /\b(vidlin|(?<!sullom )voe|lunnasting|nesting|delting|mossbank|northmavine|hillswick|ollaberry|lunna)\b/i],
  ["Brae / Sullom Voe", /\b(brae|sullom)\b/i],
  ["Whalsay", /\b(whalsay|symbister)\b/i],
  ["Yell", /\b(yell|cullivoe|mid yell|burravoe|gutcher)\b/i],
  ["Unst", /\b(unst|baltasound|uyeasound|haroldswick)\b/i],
  ["Fetlar", /\bfetlar\b/i],
  ["Offshore / marine", /\b(offshore|at sea|mv )/i],
];
/** The area a free-text location or title names, or null when it names none (never inferred from nothing). */
export function areaForLocation(text: unknown): JobArea | null {
  if (typeof text !== "string" || !text.trim()) return null;
  if (/shetland \(see advert\)/i.test(text)) return "Shetland-wide";
  const hits = AREA_TOKENS.filter(([, re]) => re.test(text)).map(([a]) => a);
  const uniq = [...new Set(hits)];
  // "Mid Yell" also hits the generic Yell rule; one distinct area is the only unambiguous answer.
  return uniq.length === 1 ? uniq[0] : null;
}

/* ── Closing dates ────────────────────────────────────────────────────────── */

const TZ = "Europe/London";
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });

/** Employer postings with no explicit closing date close this many days after publication (mirrors the database default). */
export const EMPLOYER_DEFAULT_DAYS = 30;
export function defaultExpiryIso(from: Date | number = new Date(), days: number = EMPLOYER_DEFAULT_DAYS): string {
  const t = from instanceof Date ? from.getTime() : from;
  return new Date(t + days * 86_400_000).toISOString();
}

/** "Closes 6 Nov" / "Closes in 3 days" (2-5 days out) / "Closes today" / "Closes tomorrow" / "Closed 2 Nov"; "" when there is no closing date (nothing is invented). */
export function closingLabel(expiresAt: unknown, now: Date | number = new Date()): string {
  if (typeof expiresAt !== "string" || !expiresAt) return "";
  const e = new Date(expiresAt).getTime();
  if (!Number.isFinite(e)) return "";
  const n = now instanceof Date ? now.getTime() : now;
  const short = new Date(e).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: TZ });
  if (e < n) return `Closed ${short}`;
  const today = dayKey(n), closes = dayKey(e), tomorrow = dayKey(n + 86_400_000);
  if (closes === today) return "Closes today";
  if (closes === tomorrow) return "Closes tomorrow";
  // Subtle urgency inside the last working week; further out it is just the date.
  const days = Math.round((Date.parse(closes) - Date.parse(today)) / 86_400_000);
  if (days >= 2 && days <= 5) return `Closes in ${days} days`;
  return `Closes ${short}`;
}

/** True when a job is past its closing instant (a null closing date never expires). */
export const isJobExpired = (expiresAt: unknown, now: Date | number = new Date()): boolean => {
  if (typeof expiresAt !== "string" || !expiresAt) return false;
  const e = new Date(expiresAt).getTime();
  return Number.isFinite(e) && e <= (now instanceof Date ? now.getTime() : now);
};

/** YYYY-MM-DD of the Shetland day an instant falls on. */
export const shetlandDateOf = (v: Date | number | string): string => dayKey(new Date(v).getTime());

/** The instant a job advertised as closing on `ymd` (YYYY-MM-DD) actually closes: 23:59:59 Shetland time that day. null for a bad date. */
export function closingInstantForDate(ymd: unknown): string | null {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  // 23:59:59 local is 22:59:59 or 23:59:59 UTC (BST / GMT); take the later one that is still that Shetland day.
  for (const hour of [23, 22]) {
    const t = Date.UTC(y, m - 1, d, hour, 59, 59);
    if (dayKey(t) === ymd) return new Date(t).toISOString();
  }
  return null;
}

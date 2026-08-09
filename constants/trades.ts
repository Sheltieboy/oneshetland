/**
 * Trades — the vocabulary shared by the brief form, the matcher, the business
 * settings and Peerie Bot.
 *
 * One definition, because a key that exists on one side and not the other is a
 * trade that silently never matches. The RN twin is constants/trades.ts in the app repo — a key that exists
 * on one side and not the other is a trade that silently never matches.
 */

export type TradeKey =
  | "joiner" | "builder" | "plumber" | "electrician" | "roofer"
  | "painter" | "plasterer" | "groundworks" | "drainage" | "heating"
  | "windows" | "flooring" | "tiling" | "fencing" | "landscaping"
  | "mechanic" | "welder" | "chimney" | "damp" | "handyman" | "other";

export const TRADES: { key: TradeKey; label: string; blurb: string }[] = [
  { key: "joiner",      label: "Joiner / carpenter", blurb: "Doors, kitchens, decking, repairs" },
  { key: "builder",     label: "Builder",            blurb: "Extensions, walls, general building" },
  { key: "plumber",     label: "Plumber",            blurb: "Leaks, bathrooms, pipework" },
  { key: "electrician", label: "Electrician",        blurb: "Rewiring, sockets, faults, EICRs" },
  { key: "roofer",      label: "Roofer",             blurb: "Slates, felt, leaks, guttering" },
  { key: "painter",     label: "Painter / decorator", blurb: "Inside and out" },
  { key: "plasterer",   label: "Plasterer",          blurb: "Skimming, boarding, rendering" },
  { key: "groundworks", label: "Groundworks / digger", blurb: "Drives, foundations, drainage runs" },
  { key: "drainage",    label: "Drains",             blurb: "Blockages, septic tanks, soakaways" },
  { key: "heating",     label: "Heating / oil",      blurb: "Boilers, stoves, oil tanks, servicing" },
  { key: "windows",     label: "Windows & glazing",  blurb: "Replacements, repairs, broken units" },
  { key: "flooring",    label: "Flooring",           blurb: "Laminate, vinyl, carpet, timber" },
  { key: "tiling",      label: "Tiling",             blurb: "Bathrooms, kitchens, floors" },
  { key: "fencing",     label: "Fencing & walls",    blurb: "Fences, gates, dykes" },
  { key: "landscaping", label: "Garden & landscaping", blurb: "Paths, patios, planting, clearance" },
  { key: "mechanic",    label: "Mechanic",           blurb: "Cars, vans, plant, MOT prep" },
  { key: "welder",      label: "Welding & fabrication", blurb: "Steelwork, gates, repairs" },
  { key: "chimney",     label: "Chimney sweep",      blurb: "Sweeping, liners, stoves" },
  { key: "damp",        label: "Damp & insulation",  blurb: "Damp, condensation, insulation" },
  { key: "handyman",    label: "Handyperson",        blurb: "The list of wee jobs" },
  { key: "other",       label: "Something else",     blurb: "Tell us and we'll work it out" },
];

export const TRADE_LABEL: Record<string, string> =
  Object.fromEntries(TRADES.map((t) => [t.key, t.label]));

export const isTradeKey = (v: unknown): v is TradeKey =>
  typeof v === "string" && TRADES.some((t) => t.key === v);

/* ── How soon ─────────────────────────────────────────────────────────────── */

export type Urgency = "emergency" | "weeks" | "months" | "flexible";

export const URGENCIES: { key: Urgency; label: string; blurb: string }[] = [
  { key: "emergency", label: "It's an emergency", blurb: "Water coming in, no heat, unsafe" },
  { key: "weeks",     label: "Next few weeks",    blurb: "Soon, but it can wait a bit" },
  { key: "months",    label: "Next few months",   blurb: "Planning ahead" },
  { key: "flexible",  label: "No rush",           blurb: "Whenever somebody has room" },
];

/* ── How big ──────────────────────────────────────────────────────────────── */

export type Scale = "small" | "day" | "multi_day" | "project" | "unsure";

export const SCALES: { key: Scale; label: string; blurb: string }[] = [
  { key: "small",     label: "A wee job",     blurb: "An hour or two" },
  { key: "day",       label: "About a day",   blurb: "" },
  { key: "multi_day", label: "A few days",    blurb: "" },
  { key: "project",   label: "A big project", blurb: "Weeks or more" },
  { key: "unsure",    label: "No idea",       blurb: "That's fine — say what you need and we'll size it" },
];

/* ── Availability: the scarce fact ────────────────────────────────────────── */

export type Availability = "now" | "weeks" | "months" | "booked_up" | "emergency";

export const AVAILABILITY: { key: Availability; label: string; blurb: string; tone: string }[] = [
  { key: "now",       label: "Taking work on now",  blurb: "You can start within a couple of weeks", tone: "emerald" },
  { key: "weeks",     label: "A few weeks out",     blurb: "", tone: "emerald" },
  { key: "months",    label: "A few months out",    blurb: "", tone: "amber" },
  { key: "emergency", label: "Emergencies only",    blurb: "Booked, but you'll turn out for urgent work", tone: "amber" },
  { key: "booked_up", label: "Not taking anything on", blurb: "You'll stop receiving briefs until you change this", tone: "rose" },
];

export const AVAILABILITY_LABEL: Record<string, string> =
  Object.fromEntries(AVAILABILITY.map((a) => [a.key, a.label]));

/**
 * Availability set in March and never touched is a lie by June.
 *
 * Past this, a trade reads as "hasn't said" and stops matching. It's the same
 * rule as opening_hours_until, and for the same reason: silence is honest,
 * a stale promise isn't. Short enough to mean something, long enough that a
 * busy joiner isn't nagged fortnightly.
 */
export const AVAILABILITY_TTL_DAYS = 45;

export function availabilityIsFresh(setAt: string | null | undefined): boolean {
  if (!setAt) return false;
  const age = Date.now() - new Date(setAt).getTime();
  return age < AVAILABILITY_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/** What actually counts, given staleness. Null = hasn't said / gone stale. */
export function effectiveAvailability(
  value: string | null | undefined,
  setAt: string | null | undefined,
): Availability | null {
  if (!value || !availabilityIsFresh(setAt)) return null;
  return value as Availability;
}

/* ── Credentials — SELF-DECLARED, always labelled as such ─────────────────── */

export const CREDENTIALS: { key: string; label: string }[] = [
  { key: "insured",     label: "Public liability insurance" },
  { key: "gas_safe",    label: "Gas Safe registered" },
  { key: "niceic",      label: "NICEIC / SELECT registered" },
  { key: "oftec",       label: "OFTEC registered" },
  { key: "cscs",        label: "CSCS carded" },
  { key: "vat",         label: "VAT registered" },
  { key: "waste",       label: "Waste carrier licence" },
];

export const CREDENTIAL_LABEL: Record<string, string> =
  Object.fromEntries(CREDENTIALS.map((c) => [c.key, c.label]));

/**
 * The line that has to appear wherever credentials do.
 *
 * The moment we route work to somebody, people assume we've checked them. We
 * haven't, and saying so plainly is the only honest position — and the one
 * that keeps us out of a dispute we'd have no business being in.
 */
export const CREDENTIALS_DISCLAIMER =
  "These are what the business has told us, not something OneShetland has checked. Ask to see certificates and insurance before work starts.";

/* ── What a free listing gets ─────────────────────────────────────────────── */

/**
 * Leads per calendar month on the free tier.
 *
 * Not a geography limit — Shetland is far too small for that to mean anything.
 * Volume is the honest axis: enough that a free listing genuinely rings, few
 * enough that somebody making a living from it has a reason to pay.
 *
 * Note what paid does NOT buy: an earlier look. The whole point is to break the
 * concentration where a handful of firms get every job, and selling a head
 * start to whoever can afford it rebuilds exactly that. Paid buys tools and
 * volume; the ORDER is set by who has room and who answers.
 */
export const FREE_LEADS_PER_MONTH = 3;

export const hasUnlimitedLeads = (tier: string | null | undefined) =>
  tier === "pro" || tier === "premium";

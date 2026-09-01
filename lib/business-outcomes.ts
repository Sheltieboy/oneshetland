/*
 * Copied from oneshetland-web. The two repos deploy separately, so this is a
 * deliberate duplicate rather than a shared package — and supabase/tests pins
 * the two copies byte-for-byte, the same way lib/listing-tiers.ts already is.
 * Re-deriving these rules on mobile instead of copying them is exactly how
 * Bookings came to be advertised as Premium.
 *
 * Edit the web copy first, then mirror it here, or the pin fails.
 */
/**
 * business-outcomes.ts — the five things a business owner is actually trying to do.
 *
 * Pure, derived on every load, stores nothing. Be found, sell things, take
 * bookings, run events, keep customers coming back. Everything else on the
 * business is either a system layer (money, growth) or a different product
 * (work).
 *
 * Two rules run through all of it.
 *
 * An unused capability is not unfinished work. A shop that has never wanted to
 * sell online is not 80% of a shop, so "available" is a calm, neutral, finished
 * state and never a task. Only NEEDS YOU raises its voice, and it is not this
 * file's job to compete with it.
 *
 * Live means live TO A CUSTOMER. A product flagged active on a business whose
 * Premium lapsed is not on sale — the read policy hides it — so calling it live
 * here would have Home disagree with the shop's own listing. Effective
 * entitlement decides, never the configured tier.
 */

import { beFound, type BeFoundInput } from './be-found';

export type OutcomeKey = "found" | "sell" | "bookings" | "events" | "retention";

/**
 * neutral — available, started, configured, ready. All perfectly fine states.
 * positive — genuinely live to customers, or complete.
 * There is deliberately no warning tone: urgency belongs to NEEDS YOU.
 */
export type OutcomeTone = "neutral" | "positive";

export type Outcome = {
  key: OutcomeKey;
  /** Machine state, for tests and for a later mobile implementation. */
  state: string;
  title: string;
  blurb: string;
  /** One line of truth about where this business actually is. */
  status: string;
  tone: OutcomeTone;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
};

/**
 * null anywhere means "we could not read it", never zero. A failed count must
 * not become a confident "no products" — see outcomeUnknown below.
 */
export type OutcomeData = {
  products: number | null; productsActive: number | null;
  passes: number | null; passesActive: number | null;
  services: number | null; availability: number | null;
  events: number | null; eventsUpcoming: number | null;
  offers: number | null; offersLive: number | null;
  loyalty: number | null; loyaltyActive: number | null;
  meetsPro: boolean | null; meetsPremium: boolean | null;
};

const n = (v: number | null) => v ?? 0;
const unknown = (...v: (number | boolean | null)[]) => v.some((x) => x === null);
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** What a row says when its own data could not be read. Neutral, and honest. */
function asUnknown(o: Omit<Outcome, "status" | "tone" | "state">): Outcome {
  return { ...o, state: "unknown", status: "Couldn't load this just now", tone: "neutral" };
}

/* ── Be found ─────────────────────────────────────────────────────────────── */

export function foundOutcome(business: BeFoundInput, base: string, slug: string): Outcome {
  const f = beFound(business);
  const missing = f.missingEssential.length + f.missingImprovements.length;
  // Deliberately not "Live". is_active is moderation state with no owner
  // control, so READY says the listing is usable, not that it is published.
  const status =
    f.state === "incomplete" ? "Customers still need some basic information"
    : f.state === "ready"    ? `Ready — ${plural(missing, "way")} to improve your profile`
    :                          "Complete";
  return {
    key: "found", state: f.state,
    title: "Be found",
    blurb: "Your page on OneShetland — how folk find you and know what you are.",
    status, tone: f.state === "good" ? "positive" : "neutral",
    primary: { label: "Edit profile", href: `${base}/profile` },
    secondary: { label: "View as a customer", href: `/directory/${slug}` },
  };
}

/* ── Sell things ──────────────────────────────────────────────────────────── */

export function sellOutcome(d: OutcomeData, base: string): Outcome {
  const shell = {
    key: "sell" as const,
    title: "Sell things",
    blurb: "Products, passes and packs people can buy from you.",
    primary: { label: "Products", href: `${base}/products` },
    secondary: { label: "Passes & packs", href: `${base}/passes` },
  };
  if (unknown(d.products, d.passes, d.productsActive, d.passesActive, d.meetsPremium)) return asUnknown(shell);

  const total = n(d.products) + n(d.passes);
  const flagged = n(d.productsActive) + n(d.passesActive);
  if (total === 0) {
    return { ...shell, state: "available", tone: "neutral",
             status: "Not selling on OneShetland" };
  }
  if (flagged > 0 && d.meetsPremium) {
    return { ...shell, state: "live", tone: "positive",
             status: `${plural(flagged, "item")} on sale` };
  }
  // Saved. If something is flagged active but Premium has lapsed it is NOT on
  // sale — the read policy hides it — so say why rather than call it published.
  return {
    ...shell, state: "saved", tone: "neutral",
    status: flagged > 0 && !d.meetsPremium
      ? `${plural(total, "item")} saved — Premium needed to publish`
      : `${plural(total, "item")} saved`,
  };
}

/* ── Take bookings ────────────────────────────────────────────────────────── */

export function bookingsOutcome(
  d: OutcomeData, acceptsBookings: boolean, base: string,
): Outcome {
  const shell = {
    key: "bookings" as const,
    title: "Take bookings",
    blurb: "Let folk book your time without ringing round.",
    primary: { label: "Bookings", href: `${base}/bookings` },
    secondary: { label: "Services", href: `${base}/services` },
  };
  if (unknown(d.services, d.availability, d.meetsPro)) return asUnknown(shell);

  if (n(d.services) === 0) {
    return { ...shell, state: "available", tone: "neutral", status: "Not taking bookings" };
  }
  if (acceptsBookings && d.meetsPro) {
    return { ...shell, state: "live", tone: "positive", status: "Taking bookings" };
  }
  if (acceptsBookings && !d.meetsPro) {
    return { ...shell, state: "saved", tone: "neutral",
             status: "Bookings setup saved — Pro needed to take bookings" };
  }
  if (n(d.availability) === 0) {
    // Services without availability is a real gap: nobody can book anything.
    return { ...shell, state: "setup", tone: "neutral",
             status: `${plural(n(d.services), "service")} — availability not set` };
  }
  return { ...shell, state: "ready", tone: "neutral", status: "Ready to switch on" };
}

/* ── Run events ───────────────────────────────────────────────────────────── */

export function eventsOutcome(d: OutcomeData, base: string): Outcome {
  const shell = {
    key: "events" as const,
    title: "Run events",
    blurb: "Put something on, and sell tickets if you want to.",
    primary: { label: "Events", href: `${base}/events` },
    secondary: { label: "New event", href: `${base}/events/new` },
  };
  if (unknown(d.events, d.eventsUpcoming)) return asUnknown(shell);

  // events.status is published | cancelled | archived. There is no draft, so
  // there is no draft state here either.
  if (n(d.events) === 0) {
    return { ...shell, state: "available", tone: "neutral", status: "No events yet" };
  }
  if (n(d.eventsUpcoming) > 0) {
    return { ...shell, state: "upcoming", tone: "positive",
             status: `${plural(n(d.eventsUpcoming), "upcoming event")}` };
  }
  // Plainly, with no nudge. A business between seasons has not failed at anything.
  return { ...shell, state: "none_upcoming", tone: "neutral", status: "No upcoming events" };
}

/* ── Keep customers coming back ───────────────────────────────────────────── */

export function retentionOutcome(d: OutcomeData, base: string): Outcome {
  const shell = {
    key: "retention" as const,
    title: "Keep customers coming back",
    blurb: "Offers and a loyalty card, for folk who have been once already.",
    primary: { label: "Offers", href: `${base}/offers` },
    secondary: { label: "Loyalty", href: `${base}/loyalty` },
  };
  if (unknown(d.offers, d.offersLive, d.loyalty, d.loyaltyActive, d.meetsPro)) return asUnknown(shell);

  const total = n(d.offers) + n(d.loyalty);
  const flagged = n(d.offersLive) + n(d.loyaltyActive);
  if (total === 0) {
    // The one outcome whose SETUP is tier-gated on the server, so the one place
    // a plan may be named up front — otherwise the manager simply refuses and
    // the owner is never told why.
    return { ...shell, state: "available", tone: "neutral",
             status: d.meetsPro ? "Nothing running" : "Part of Pro — a reason for folk to come back" };
  }
  if (flagged > 0 && d.meetsPro) {
    return { ...shell, state: "live", tone: "positive", status: `${plural(flagged, "thing")} running` };
  }
  return {
    ...shell, state: "saved", tone: "neutral",
    status: flagged > 0 && !d.meetsPro ? "Set up — Pro needed to run it" : "Set up, not running",
  };
}

/* ── The five, in a fixed order ───────────────────────────────────────────── */

export function businessOutcomes(
  business: BeFoundInput & { accepts_bookings?: boolean | null; slug?: string | null; id: string },
  d: OutcomeData, base: string,
): Outcome[] {
  const slug = business.slug || business.id;
  // Fixed order, never sorted by state: an owner learns where things are, and a
  // Home that rearranges itself has to be read from scratch every time.
  return [
    foundOutcome(business, base, slug),
    sellOutcome(d, base),
    bookingsOutcome(d, business.accepts_bookings === true, base),
    eventsOutcome(d, base),
    retentionOutcome(d, base),
  ];
}

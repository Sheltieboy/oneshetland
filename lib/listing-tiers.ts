/**
 * listing-tiers.ts — THE tier model. One map decides what every tier gets,
 * everywhere: public listing richness, management page access, and the plan
 * comparison on the marketing page.
 *
 * ⚠️ KEEP IN SYNC with oneshetland-web/lib/listing-tiers.ts — there is no shared
 * package, so this file is mirrored across the app and web repos. If you change
 * the tier ladder or feature map here, make the identical change there.
 *
 * WHY THIS FILE IS THE ONLY PLACE.
 * "What does a tier get?" used to be answered in four places that disagreed —
 * PLAN_FEATURES, FEATURE_MIN_TIER, LISTING_LADDER and nine hand-written
 * tierMeets() gates — plus an add-on system that billed but never enforced. A
 * business could fully manage Events on Free and then find them hidden on its
 * own listing. Everything now derives from TIER_FEATURES below, so the four
 * cannot drift apart again. See oneshetland-web/docs/tier-model.md.
 *
 * THE PRINCIPLE. The island's shared sections are free; your own trading
 * operation is paid. What's On and Work only work if they are full, so Jobs and
 * Events are free — an event has value to Shetland even if no ticket sells. A
 * shop does not.
 *
 * Listing features govern DISPLAY only and must not drive any in-app purchase
 * flow (App Store compliance — selling is web-only). A business is shown
 * everything its tier unlocks that it has legitimately filled in; higher-tier
 * elements are omitted for lower tiers, empty ones for everyone.
 */

export type ListingTier = "free" | "pro" | "premium";

const TIER_RANK: Record<ListingTier, number> = { free: 0, pro: 1, premium: 2 };

/** Elements of a public listing. */
export type ListingFeature =
  | "coverPhoto"      // full-bleed cover/banner photo (else category-themed)
  | "description"     // description / "about" story
  | "extraContacts"   // website, email (beyond the single free phone contact)
  | "mapPin"          // embedded location map
  | "gallery"         // photo gallery — capped on free, see FREE_GALLERY_LIMIT
  | "offers"          // current offers surfaced on the listing
  | "loyalty"         // loyalty card surfaced on the listing
  | "hiring"          // open shifts / jobs surfaced on the listing
  | "wallet"          // wallet / cashback surfaced on the listing
  | "events"          // upcoming events + their tickets, surfaced on the listing
  | "services"        // services catalogue
  | "bookable"        // "Book online" CTA, passes and unit items
  | "featuredBadge";  // "★ Featured" badge

/** Screens under /business/<id>/manage. */
export type ManageFeature =
  | "jobs" | "eventsManage"
  | "till" | "nfc" | "enquiries" | "analytics"
  | "products" | "orders" | "passes" | "bookings" | "schedule"
  | "alerts";

export type Feature = ListingFeature | ManageFeature;

/**
 * The lowest tier that unlocks each feature. A tier unlocks a feature when its
 * rank is >= the feature's rank, so premium inherits pro, and pro inherits free.
 *
 * Free    — "Be found". A proper local business page, plus the two things that
 *           fill the island's shared sections: Jobs and Events & ticketing.
 * Pro     — "Turn finders into regulars". The counter tools.
 * Premium — "Sell as much as you like". Your own trading operation.
 */
export const TIER_FEATURES: Record<Feature, ListingTier> = {
  /* Free — a page worth claiming. Description, cover photo and contacts sit
     here deliberately: 527 of 529 listed businesses are unclaimed, and putting
     "say what you do" behind £12 is what kept them that way. */
  coverPhoto:    "free",
  description:   "free",
  extraContacts: "free",
  mapPin:        "free",
  gallery:       "free",   // capped — see FREE_GALLERY_LIMIT
  hiring:        "free",
  jobs:          "free",
  events:        "free",
  eventsManage:  "free",

  /* Pro — the counter. */
  offers:        "pro",
  loyalty:       "pro",
  till:          "pro",
  nfc:           "pro",
  wallet:        "pro",
  enquiries:     "pro",
  analytics:     "pro",

  /* Premium — your own shop. */
  products:      "premium",
  orders:        "premium",
  services:      "premium",
  bookings:      "premium",
  schedule:      "premium",
  passes:        "premium",
  bookable:      "premium",
  featuredBadge: "premium",

  /* Premium AND admin approval AND an accepted usage policy. The tier is the
     cheapest of the three gates — see docs/tier-model.md. */
  alerts:        "premium",
};

/**
 * Photos a Free listing may show, on top of the free cover photo. Pro and above
 * are unlimited. A cap rather than a lock: a maker with three good photos is
 * still a proper listing, and the fourth is a reason to upgrade.
 */
export const FREE_GALLERY_LIMIT = 3;

/** How many gallery photos this tier may show. null = unlimited. */
export function galleryLimit(tier: string | null | undefined): number | null {
  return normaliseTier(tier) === "free" ? FREE_GALLERY_LIMIT : null;
}

/** Normalise any stored tier string to a known ListingTier (defaults to free). */
export function normaliseTier(tier: string | null | undefined): ListingTier {
  return tier === "pro" || tier === "premium" ? tier : "free";
}

/** Does this business's tier unlock this feature? */
export function tierUnlocks(tier: string | null | undefined, feature: Feature): boolean {
  return TIER_RANK[normaliseTier(tier)] >= TIER_RANK[TIER_FEATURES[feature]];
}

/** Human label for a tier — used in owner upgrade hints and plan comparisons. */
export const TIER_LABEL: Record<ListingTier, string> = {
  free:    "Free",
  pro:     "Pro",
  premium: "Premium",
};

export const TIER_PRICE: Record<ListingTier, string> = {
  free:    "£0",
  pro:     "£12/mo",
  premium: "£29/mo",
};

/** Annual Premium — twelve months for the price of ten. Phase 4; no billing yet. */
export const PREMIUM_ANNUAL_PRICE = "£290/yr";

/** One line per tier for the plans page and the billing screen. */
export const TIER_PITCH: Record<ListingTier, { headline: string; blurb: string }> = {
  free: {
    headline: "Be found",
    blurb:
      "A proper page for your business — your story, photos, hours, contacts and map. " +
      "Post jobs and shifts, and sell event tickets, at no monthly cost.",
  },
  pro: {
    headline: "Turn finders into regulars",
    blurb:
      "Everything in Free, plus the counter tools: offers, a loyalty card, tap-to-stamp, " +
      "Local Wallet payments, enquiries and your own numbers.",
  },
  premium: {
    headline: "Sell as much as you like",
    blurb:
      "Everything in Pro, plus your own shop: products and orders, services, bookings, " +
      "passes, and a featured spot on the OneShetland home screen.",
  },
};

/**
 * The plan comparison, in reading order. Generated from TIER_FEATURES rather
 * than hand-listed, because the hand-listed version never mentioned products,
 * services, passes or orders — i.e. everything Premium actually sold.
 */
export const PLAN_COMPARISON: { label: string; feature: Feature }[] = [
  { label: "Your story, photos and contacts", feature: "description" },
  { label: "Map pin and directions",          feature: "mapPin" },
  { label: "Jobs and shifts",                 feature: "jobs" },
  { label: "Events and ticketing",            feature: "eventsManage" },
  { label: "Time-limited offers",             feature: "offers" },
  { label: "Loyalty stamps and points",       feature: "loyalty" },
  { label: "Tap-to-stamp NFC tile",           feature: "nfc" },
  { label: "Local Wallet payments",           feature: "wallet" },
  { label: "Customer enquiries",              feature: "enquiries" },
  { label: "Your analytics",                  feature: "analytics" },
  { label: "Products and orders",             feature: "products" },
  { label: "Services and bookings",           feature: "bookings" },
  { label: "Passes and packs",                feature: "passes" },
  { label: "Featured homepage spot",          feature: "featuredBadge" },
];

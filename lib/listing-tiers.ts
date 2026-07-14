/**
 * listing-tiers.ts — single source of truth for how RICH a business's public
 * Directory listing is, gated by its subscription tier.
 *
 * ⚠️ KEEP IN SYNC with oneshetland-web/lib/listing-tiers.ts — there is no shared
 * package, so this file is mirrored across the app and web repos. If you change
 * the tier ladder or feature map here, make the identical change there.
 *
 * This only governs DISPLAY richness of the public listing page. It does NOT
 * sell anything and must not drive any in-app purchase flow (App Store
 * compliance — selling is web-only). A business is shown everything its current
 * tier unlocks that it has legitimately filled in; higher-tier-only elements are
 * simply omitted for lower tiers, and empty ones are omitted for everyone.
 */

export type ListingTier = 'free' | 'pro' | 'premium';

const TIER_RANK: Record<ListingTier, number> = { free: 0, pro: 1, premium: 2 };

/** Every gate-able element of a public listing. */
export type ListingFeature =
  | 'coverPhoto'      // full-bleed cover/banner photo (else category-themed)
  | 'description'     // description / "about" story
  | 'extraContacts'   // website, email (beyond the single free phone contact)
  | 'mapPin'          // embedded location map
  | 'offers'          // current offers surfaced on the listing
  | 'loyalty'         // loyalty card surfaced on the listing
  | 'hiring'          // open shifts / jobs surfaced on the listing
  | 'wallet'          // wallet / cashback surfaced on the listing
  | 'featuredBadge'   // "★ Featured" badge
  | 'gallery'         // photo gallery
  | 'events'          // upcoming events surfaced on the listing
  | 'services'        // services catalogue
  | 'tickets'         // tickets / passes / unit items
  | 'addonSections';  // richer add-on sections (products, membership, enquiries…)

/**
 * The lowest tier that unlocks each feature. A tier unlocks a feature when its
 * rank is >= the feature's required rank (so premium inherits pro, etc.).
 *
 * Free  → name, category, area, logo, opening hours, one contact (phone), verified badge, claim.
 * Pro   → + description, cover photo, extra contacts, map pin, offers, loyalty, hiring, wallet.
 * Premium → + featured badge, gallery, events, services, tickets, richer add-on sections.
 */
export const FEATURE_MIN_TIER: Record<ListingFeature, ListingTier> = {
  description:    'pro',
  coverPhoto:     'pro',
  extraContacts:  'pro',
  mapPin:         'pro',
  offers:         'pro',
  loyalty:        'pro',
  hiring:         'pro',
  wallet:         'pro',
  featuredBadge:  'premium',
  gallery:        'premium',
  events:         'premium',
  services:       'premium',
  tickets:        'premium',
  addonSections:  'premium',
};

/** Normalise any stored tier string to a known ListingTier (defaults to free). */
export function normaliseTier(tier: string | null | undefined): ListingTier {
  return tier === 'pro' || tier === 'premium' ? tier : 'free';
}

/** Does this business's tier unlock this listing feature? */
export function tierUnlocks(tier: string | null | undefined, feature: ListingFeature): boolean {
  return TIER_RANK[normaliseTier(tier)] >= TIER_RANK[FEATURE_MIN_TIER[feature]];
}

/** Human label for the tier that unlocks a feature — used in owner upgrade hints. */
export const TIER_LABEL: Record<ListingTier, string> = {
  free:    'Free',
  pro:     'Pro',
  premium: 'Premium',
};

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
 * be-found.ts — is this listing good enough for a customer to use?
 *
 * Pure, and deliberately not a score. 26% of the directory has a description
 * and 20% has opening hours, so a percentage would greet almost every claimed
 * import with "you are 20% complete" — a number that is discouraging, tells the
 * owner nothing about what to do, and never reaches 100 for a business that
 * legitimately has no website. Facts and an ordered list of gaps instead.
 *
 * name, category and address are NOT NULL on local_businesses, so they are
 * always present and are not milestones. What actually varies is the five
 * below.
 *
 * is_active is NOT read here, on purpose. It is moderation state with no owner
 * control on either platform, so it must never make an owner's listing look
 * unfinished for something they cannot do anything about.
 */

import { hasAnyHours, type OpeningHoursMap as OpeningHours } from './opening-hours';

export type BeFoundState = "incomplete" | "ready" | "good";

/** Ordered by how much a customer misses it. */
export type BeFoundGap = "contact" | "map_pin" | "description" | "image" | "opening_hours";

export type BeFoundInput = {
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  lat?: number | null;
  lng?: number | null;
  description?: string | null;
  logo_url?: string | null;
  cover_url?: string | null;
  opening_hours?: OpeningHours | null;
};

export type BeFoundFacts = {
  hasContactMethod: boolean;
  hasMapPin: boolean;
  hasDescription: boolean;
  hasImage: boolean;
  hasOpeningHours: boolean;
  /** Missing essentials, most useful first. Non-empty means state is incomplete. */
  missingEssential: BeFoundGap[];
  /** Missing nice-to-haves, most useful first. */
  missingImprovements: BeFoundGap[];
  state: BeFoundState;
};

const filled = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

/**
 * A pin is only a pin if it could actually be somewhere. Null Island (0,0) is
 * what a failed import writes, not a shop, and putting a marker in the Atlantic
 * is worse than showing no map at all.
 */
export function hasValidPin(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function beFound(b: BeFoundInput): BeFoundFacts {
  const hasContactMethod = filled(b.phone) || filled(b.website) || filled(b.email);
  const hasMapPin = hasValidPin(b.lat, b.lng);
  const hasDescription = filled(b.description);
  const hasImage = filled(b.logo_url) || filled(b.cover_url);
  const hasOpeningHours = hasAnyHours(b.opening_hours);

  const missingEssential: BeFoundGap[] = [];
  if (!hasContactMethod) missingEssential.push("contact");
  if (!hasMapPin) missingEssential.push("map_pin");

  const missingImprovements: BeFoundGap[] = [];
  if (!hasDescription) missingImprovements.push("description");
  if (!hasImage) missingImprovements.push("image");
  if (!hasOpeningHours) missingImprovements.push("opening_hours");

  const state: BeFoundState =
    missingEssential.length > 0 ? "incomplete" : missingImprovements.length > 0 ? "ready" : "good";

  return {
    hasContactMethod, hasMapPin, hasDescription, hasImage, hasOpeningHours,
    missingEssential, missingImprovements, state,
  };
}

/** What the owner is told, once, about each gap. */
export const BE_FOUND_COPY: Record<BeFoundGap, { title: string; body: string }> = {
  contact: {
    title: "Add a way customers can contact you",
    body: "A phone number, website or email. Right now there's no way to get in touch with you.",
  },
  map_pin: {
    title: "Set your location on the map",
    body: "Drop a pin so customers can find their way to you.",
  },
  description: {
    title: "Say what you do",
    body: "A couple of lines is plenty. It's the first thing folk read.",
  },
  image: {
    title: "Add a photo",
    body: "A logo or a cover photo. A listing with a picture gets looked at more.",
  },
  opening_hours: {
    title: "Add your opening hours",
    body: "So nobody turns up on a day you're shut.",
  },
};

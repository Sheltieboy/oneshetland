/**
 * geography.ts — the client-side contract for OneShetland's canonical geography.
 *
 * WHY
 * Stage 1 found 8+ unrelated area lists (regions, transit, two Local lists, two profile pickers, Jobs areas, free text). The database now holds ONE
 * vocabulary (public.areas + public.place_aliases) and ONE resolver (public.resolve_geography). This file is the thin, dependency-free client side
 * of that contract, so web, app and edge functions all speak the same words. NOTHING IMPORTS IT YET: Stage 2A deliberately changes no behaviour.
 *
 * RULES
 *  · The database is the source of truth. This file does not carry the alias list — it carries the normaliser (kept identical to
 *    public.geo_normalise, proven by test) and the shape of an answer.
 *  · "shetland_wide" is a SCOPE ("relevant to everyone"), not a place and not "unknown". An address that says only "Shetland" is unresolved.
 *  · Remote / Hybrid / Offshore / Marine are work context: status "non_geographic", never a locality.
 *  · Only status === "resolved" may be used as a location. Everything else keeps the original text and goes to review.
 *
 * No imports, so `node --test` and Deno load it directly (same convention as lib/job-taxonomy.ts).
 */

export const SHETLAND_WIDE = "shetland_wide" as const;

/** The seven official localities (HSCP annual performance report 2024-25), in display order. */
export const GEO_LOCALITIES = [
  "lerwick_bressay", "shetland_central", "shetland_north", "shetland_south", "shetland_west", "whalsay_skerries", "yell_unst_fetlar",
] as const;
export type GeoLocalityId = (typeof GEO_LOCALITIES)[number];

export type GeoStatus = "resolved" | "unresolved" | "ambiguous" | "invalid" | "non_geographic";
export type GeoKind = "place" | "area" | "scope" | "ambiguous" | "non_geographic" | "invalid" | "unspecified";

export interface GeoResolution {
  /** Exactly what was passed in (preserved so callers can keep their original text). */
  input: string | null;
  normalised: string;
  status: GeoStatus;
  /** Why this status (e.g. exact_alias, no_match, ambiguous_alias, unspecified_within_shetland, confidence_below_high). */
  reason: string;
  /** Set only when status === "resolved". */
  area_id: string | null;
  area_type: "shetland" | "locality" | "settlement" | "island" | "area" | "site" | null;
  /** The top-level locality the area sits in (the area itself when it is a locality; null for shetland_wide). */
  locality_id: string | null;
  is_shetland_wide: boolean;
  confidence: "high" | "medium" | "low" | null;
  kind: GeoKind | null;
  alias_id: number | null;
  /** Possible meanings when ambiguous, or the unconfirmed candidate when confidence was below high. Never to be used as a location. */
  candidate_ids: string[];
}

/**
 * Mirrors public.geo_normalise(): trim, lower-case, accent-fold, "&" -> "and", apostrophes removed, everything else that is not a-z/0-9 becomes one space,
 * and a trailing ", Shetland[ Islands][, Scotland|UK|United Kingdom]" qualifier is dropped. Deliberately NOT fuzzy.
 */
export function normaliseGeoText(input: unknown): string {
  let s = typeof input === "string" ? input.trim().toLowerCase() : "";
  s = s.replace(/,\s*shetland(\s+islands)?(\s*,\s*(scotland|uk|united kingdom))*\s*$/, "");
  s = s.replace(/&/g, " and ").replace(/’/g, "").replace(/'/g, "");
  s = s.replace(/[àáâãäåèéêëìíîïòóôõöùúûüñç]/g, (c) => "aaaaaaeeeeiiiiooooouuuunc"["àáâãäåèéêëìíîïòóôõöùúûüñç".indexOf(c)]);
  return s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Only a RESOLVED answer is a usable location. */
export const isResolvedGeography = (r: GeoResolution | null | undefined): r is GeoResolution & { area_id: string } =>
  !!r && r.status === "resolved" && !!r.area_id;

/** "shetland_wide" (deliberately everyone) | "area" (a specific place/locality) | null (unknown, ambiguous, invalid or work context). */
export function geographyScope(r: GeoResolution | null | undefined): "shetland_wide" | "area" | null {
  if (!isResolvedGeography(r)) return null;
  return r.is_shetland_wide ? "shetland_wide" : "area";
}

/** A canonical record as returned by public.geography_area(). Pending places (Foula, Papa Stour) and inactive rows are never returned. */
export interface GeoArea {
  id: string; slug: string; name_official: string; name_display: string;
  type: "shetland" | "locality" | "settlement" | "island" | "area" | "site";
  parent_id: string | null; locality_id: string | null; is_physical: boolean; is_shetland_wide: boolean;
  confidence: "high" | "medium" | "low"; boundary_ref: string | null;
}

/** Any client with a Supabase-style rpc(), injected so this file stays dependency-free. */
export type GeoRpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** Ask the database to resolve a value. A failed call degrades to "unresolved" — it never guesses. */
export async function resolveGeography(client: GeoRpcClient, input: string | null | undefined): Promise<GeoResolution> {
  const fallback: GeoResolution = {
    input: input ?? null, normalised: normaliseGeoText(input), status: "unresolved", reason: "resolver_unavailable", area_id: null, area_type: null,
    locality_id: null, is_shetland_wide: false, confidence: null, kind: null, alias_id: null, candidate_ids: [],
  };
  try {
    const { data, error } = await client.rpc("resolve_geography", { p_input: input ?? "" });
    if (error || !data || typeof data !== "object") return fallback;
    return data as GeoResolution;
  } catch { return fallback; }
}

/** Fetch one canonical area (and, through locality_id, its Level 1 parent). null when unknown, inactive or pending. */
export async function getCanonicalArea(client: GeoRpcClient, id: string): Promise<GeoArea | null> {
  try {
    const { data, error } = await client.rpc("geography_area", { p_id: id });
    return !error && data && typeof data === "object" ? (data as GeoArea) : null;
  } catch { return null; }
}

/** The Level 1 locality ID for an area ID, or null (shetland_wide has none; neither does a pending place). */
export async function getParentLocality(client: GeoRpcClient, id: string): Promise<string | null> {
  try {
    const { data, error } = await client.rpc("geography_locality", { p_id: id });
    return !error && typeof data === "string" ? data : null;
  } catch { return null; }
}

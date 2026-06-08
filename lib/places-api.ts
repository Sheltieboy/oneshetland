/**
 * lib/places-api.ts
 *
 * Lightweight place search backed by the game_shetland_places table
 * (migrations 035 + 036) — ~200 verified Shetland locations covering
 * settlements, islands, voes, lochs, beaches, headlands, lighthouses,
 * brochs, sounds and landmarks.
 *
 * Using the local table rather than an external geocoder gives us:
 *   - zero network surprises (no API key, no rate limit, no 429s)
 *   - Shetland-curated results (typing "Hillswick" can't accidentally
 *     surface a Hillswick in North Yorkshire)
 *   - alt-name awareness ("Esha Ness" finds "Eshaness")
 *
 * If the user types something we don't have, we degrade gracefully —
 * returning an empty list rather than crashing the search box.
 */

import { supabase } from './supabase';

export interface ShetlandPlace {
  id:        string;
  name:      string;
  alt_names: string[] | null;
  category:  string;
  region:    string | null;
  lat:       number;
  lng:       number;
}

/**
 * Search the seed places dataset. Ranks prefix matches above substring
 * matches, then by name length (shorter first — "Yell" beats "Yell Sound"
 * when you type "Yell").
 */
export async function searchPlaces(query: string, limit = 8): Promise<ShetlandPlace[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  // Two parallel queries: prefix match on name + prefix match on alt_names.
  // De-duped client-side.
  const prefix = `${q}%`;
  const sub    = `%${q}%`;

  const { data, error } = await supabase
    .from('game_shetland_places')
    .select('id, name, alt_names, category, region, lat, lng')
    .eq('is_active', true)
    .or(
      `name.ilike.${prefix},name.ilike.${sub}`,
    )
    .limit(limit * 2);

  if (error) {
    // Don't blow up the search box — surface as empty.
    return [];
  }

  const rows = (data ?? []) as ShetlandPlace[];

  // Rank: prefix on name → prefix on any alt_name → substring on name → other.
  const lcq = q.toLowerCase();
  const score = (p: ShetlandPlace) => {
    const nameLower = p.name.toLowerCase();
    if (nameLower.startsWith(lcq)) return 0;
    if (p.alt_names?.some(a => a.toLowerCase().startsWith(lcq))) return 1;
    if (nameLower.includes(lcq)) return 2;
    if (p.alt_names?.some(a => a.toLowerCase().includes(lcq))) return 3;
    return 4;
  };

  return rows
    .sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa !== sb)                return sa - sb;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/**
 * Human-friendly category labels for the search result rows.
 * Maps the DB enum to display strings.
 */
export const PLACE_CATEGORY_LABEL: Record<string, string> = {
  settlement: 'Village',
  island:     'Island',
  voe:        'Voe',
  loch:       'Loch',
  beach:      'Beach',
  headland:   'Headland',
  hill:       'Hill',
  lighthouse: 'Lighthouse',
  broch:      'Broch',
  sound:      'Sound',
  geo:        'Geo',
  landmark:   'Landmark',
};

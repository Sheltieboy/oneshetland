import type { ImageSourcePropType } from 'react-native';

/**
 * cruise-ship-images — local fallback photos for cruise ships that don't yet
 * have a remote `cruise_ships.image_url`. Keyed by ship slug (which matches the
 * asset filename, e.g. "crystal-serenity" → assets/crystal-serenity.jpg). Add a
 * ship here by dropping its photo in assets/ (named as the slug) and adding a
 * line below. The DB image_url always wins when present.
 */
const LOCAL_SHIP_IMAGES: Record<string, ImageSourcePropType> = {
  'crystal-serenity': require('../assets/crystal-serenity.jpg'),
  'msc-virtuosa': require('../assets/msc-virtuosa.jpeg'),
  'viking-mira': require('../assets/viking-mira.jpg'),
};

function slugify(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a ship's image: the remote image_url if it has one, otherwise a
 * bundled local asset matched by slug (or the slugified name), else null so the
 * caller can render its placeholder.
 */
export function shipImageSource(
  ship?: { slug?: string | null; name?: string | null; image_url?: string | null } | null,
): ImageSourcePropType | null {
  if (ship?.image_url) return { uri: ship.image_url };
  const key = ship?.slug || slugify(ship?.name);
  return (key && LOCAL_SHIP_IMAGES[key]) || null;
}

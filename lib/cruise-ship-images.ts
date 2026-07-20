import type { ImageSourcePropType } from 'react-native';

/**
 * cruise-ship-images — curated local photos for specific cruise ships, keyed by
 * ship slug (matching the asset filename, e.g. "crystal-serenity" →
 * assets/crystal-serenity.jpg). Add a ship by dropping its photo in assets/
 * (named as the slug) and adding a line below.
 *
 * These ships' DB `image_url` points to placeholder files in storage, so a
 * curated local photo listed here takes PRECEDENCE over image_url. Remove a
 * ship from this map once a real image_url is set for it in the database.
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
 * Resolve a ship's image: a curated local asset if we have one (wins over
 * image_url, which is a placeholder for these ships), else the remote
 * image_url, else null so the caller can render its placeholder.
 */
export function shipImageSource(
  ship?: { slug?: string | null; name?: string | null; image_url?: string | null } | null,
): ImageSourcePropType | null {
  const key = ship?.slug || slugify(ship?.name);
  if (key && LOCAL_SHIP_IMAGES[key]) return LOCAL_SHIP_IMAGES[key];
  if (ship?.image_url) return { uri: ship.image_url };
  return null;
}

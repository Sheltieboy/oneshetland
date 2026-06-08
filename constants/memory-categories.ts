/**
 * constants/memory-categories.ts
 *
 * Canonical category set for the Memories section.
 *
 * The DB stores tag SLUGS (e.g. 'fishing'); labels and icons live here so
 * we can rebrand without a migration. Order in CATEGORIES is the display
 * order on the picker — keep the most-used at the top.
 */

export interface MemoryCategory {
  slug:        string;        // stored in DB (memories.tags)
  label:       string;        // shown in UI
  icon:        string;        // FontAwesome5 name
  /** Hex colour used for the chip when active. Defaults to the section rose. */
  color?:      string;
}

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  { slug: 'fishing',      label: 'Fishing',              icon: 'fish' },
  { slug: 'crofting',     label: 'Crofting',             icon: 'tractor' },
  { slug: 'textiles',     label: 'Knitting & textiles',  icon: 'tshirt' },
  { slug: 'boats',        label: 'Boats & sailing',      icon: 'ship' },
  { slug: 'music',        label: 'Music & dance',        icon: 'music' },
  { slug: 'up-helly-aa',  label: 'Up Helly Aa',          icon: 'fire',         color: '#E0722A' },
  { slug: 'spik',         label: 'Spik & dialect',       icon: 'comment-dots', color: '#12B3D6' },
  { slug: 'folklore',     label: 'Folklore',             icon: 'hat-wizard' },
  { slug: 'family',       label: 'Family',               icon: 'users' },
  { slug: 'school',       label: 'School days',          icon: 'graduation-cap' },
  { slug: 'wartime',      label: 'Wartime',              icon: 'shield-alt' },
  { slug: 'wildlife',     label: 'Wildlife',             icon: 'feather' },
  { slug: 'faith',        label: 'Faith & kirk',         icon: 'church' },
  { slug: 'trade',        label: 'Trade & shops',        icon: 'store' },
];

/** Map for O(1) lookup by slug — used when rendering tags on detail/list cards. */
export const MEMORY_CATEGORY_BY_SLUG: Record<string, MemoryCategory> = Object.fromEntries(
  MEMORY_CATEGORIES.map(c => [c.slug, c]),
);

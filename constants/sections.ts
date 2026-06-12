/**
 * sections.ts
 *
 * Canonical brand identity for every section of the OneShetland app.
 *
 * RULE: whenever you build a new screen, component, or tab for one of these
 * sections, import its palette from here — never hard-code colours inline.
 * This keeps the whole app visually consistent with the OneShetland brand.
 *
 * Usage:
 *   import { SECTIONS } from '@/constants/sections';
 *   const s = SECTIONS.events;
 *   <View style={{ borderLeftColor: s.color }} />
 *   <FontAwesome5 name={s.icon} color={s.color} />
 */

export interface SectionBrand {
  /** Primary brand colour for this section */
  color: string;
  /** Light tint (backgrounds, badges, chip fills) */
  light: string;
  /** FontAwesome5 icon name */
  icon: string;
  /** Display label used in headers, tabs, cards */
  label: string;
  /** One-line description shown in "live" or "coming soon" cards */
  description: string;
  /** Whether this section is live in the current build */
  live: boolean;
}

export const SECTIONS = {

  shifts: {
    color:       '#E8A020',
    light:       '#FEF9E7',
    icon:        'briefcase',
    label:       'Shifts',
    description: 'Find and post short-notice work across Shetland',
    live:        true,
  },

  spik: {
    color:       '#12B3D6',
    light:       '#E0F7FC',
    icon:        'book',
    label:       'Spik',
    description: 'Shetland dialect dictionary',
    live:        true,
  },

  fetch: {
    color:       '#E0722A',
    light:       '#FFEDD5',
    icon:        'shipping-fast',
    label:       'Fetch',
    description: 'Community delivery',
    live:        true,
  },

  local: {
    color:       '#7C3AED',   // deep violet — fresh, premium, distinct from other sections
    light:       '#F3E8FF',
    icon:        'map-pin',
    label:       'Marketplace',
    description: 'Shops, services, loyalty and bookings from Shetland businesses',
    live:        true,
  },

  games: {
    color:       '#10B981',   // emerald — playful, distinct from every other section
    light:       '#D1FAE5',
    icon:        'gamepad',
    label:       'Games',
    description: 'Learn the dialect through play — solo and head-to-head',
    live:        true,
  },

  events: {
    color:       '#D4921A',
    light:       '#FEF3C7',
    icon:        'calendar-alt',
    label:       "What's On",
    description: 'Events, gigs and things to do across Shetland',
    live:        true,
  },

  services: {
    color:       '#6B47BF',
    light:       '#EDE9FE',
    icon:        'store',
    label:       'Services',
    description: 'The Shetland business and services directory',
    live:        false,
  },

  news: {
    color:       '#0E6EA6',
    light:       '#DBEAFE',
    icon:        'newspaper',
    label:       'News',
    description: 'Local news from across the islands',
    live:        false,
  },

  notices: {
    color:       '#C53B2F',
    light:       '#FEE2E2',
    icon:        'bullhorn',
    label:       'Notices',
    description: 'Community notices and announcements',
    live:        false,
  },

  jobs: {
    color:       '#2A8B5C',
    light:       '#D1FAE5',
    icon:        'briefcase',
    label:       'Jobs',
    description: 'Employment opportunities across Shetland',
    live:        false,
  },

  cruise: {
    color:       '#E0722A',   // shares fetch orange — nautical/visitor warmth
    light:       '#FFEDD5',
    icon:        'ship',
    label:       'Cruise Visitor',
    description: 'A dedicated guide for cruise visitors',
    live:        false,
  },

  tourism: {
    color:       '#2A8B5C',   // shares jobs green — outdoors/landscape
    light:       '#D1FAE5',
    icon:        'map-marker-alt',
    label:       'Tourism Guide',
    description: "Explore Shetland's best places and experiences",
    live:        false,
  },

  community: {
    color:       '#6B47BF',   // shares services purple — people/groups
    light:       '#EDE9FE',
    icon:        'users',
    label:       'Hubs',
    description: 'A simple branded home for Shetland clubs, groups and community organisations',
    live:        true,
  },

  memories: {
    color:       '#9F1239',   // rose-800 — warm, nostalgic, distinct from every other section
    light:       '#FFE4E6',
    icon:        'book-open',
    label:       'Memories',
    description: 'A living map of Shetland, pinned with stories, voices, photos and films',
    live:        true,
  },

  daBoats: {
    color:       '#1E3A8A',   // deep maritime blue — distinct from brand navy
    light:       '#DBEAFE',
    icon:        'ship',
    label:       'Da Boats',
    description: 'Shetland LK-registered vessels through the years',
    live:        true,
  },

} as const satisfies Record<string, SectionBrand>;

export type SectionKey = keyof typeof SECTIONS;

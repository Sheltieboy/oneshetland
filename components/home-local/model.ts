/**
 * model.ts — the shared shapes behind the Home and Local screens (components/home-local).
 *
 * Commerce is one item type — a Merch — shaped by its pillar (Shop · Offers · Book · Experiences). The screens read
 * only REAL inventory; how a pillar looks depends on how much of it there is (see density()), but the pillar itself
 * is always on the page.
 */
import type { PhotoKey } from './images';

export type Pillar = 'shop' | 'offers' | 'book' | 'experiences';
export type Crop = { cx: number; cy: number; z: number };

/** Where tapping an item goes: an existing screen and its params. */
export interface MerchRoute { pathname: string; params?: Record<string, string> }

export interface Merch {
  id: string;
  pillar: Pillar;
  title: string;
  business: string;
  price?: string;
  badge?: string;
  meta?: string;
  /** A real remote image. */
  uri?: string;
  photo?: PhotoKey;
  crop?: Crop;
  route?: MerchRoute;
  /** A test / acceptance fixture. Only ever present for an administrator; always shown with <TestBadge/>. */
  test?: boolean;
}

export const PILLARS: Record<Pillar, {
  label: string; short: string; color: string; deep: string; photo: PhotoKey; crop: Crop;
  emptyTitle: string; emptyBody: string; cta: string; heading: string;
}> = {
  shop: {
    label: 'Shop', heading: 'Shop from Shetland', short: 'Made here, bought from the maker', color: '#7C3AED', deep: '#3B0764', photo: 'shopping', crop: { cx: 0.5, cy: 0.5, z: 1 },
    emptyTitle: "Shetland's makers are moving in", emptyBody: 'Knitwear, gin, smoked salmon and silver — bought direct from the people who make it. The first shops open here soon.',
    cta: 'Sell on OneShetland',
  },
  offers: {
    label: 'Offers', heading: 'Offers', short: 'Local deals and rewards', color: '#D97706', deep: '#78350F', photo: 'street', crop: { cx: 0.12, cy: 0.6, z: 1.9 },
    emptyTitle: 'Local deals are on their way', emptyBody: 'Shops and cafés will post their offers here — a free coffee, a discount on a cake box, a bit off the haircut.',
    cta: 'Post an offer',
  },
  book: {
    label: 'Book', heading: 'Book local', short: 'Pick a service, pick a slot', color: '#059669', deep: '#064E3B', photo: 'cafe', crop: { cx: 0.5, cy: 0.45, z: 1.1 },
    emptyTitle: 'Booking is opening up', emptyBody: 'Hair, beauty, therapies, repairs — see the free slots and book without the phone tag.',
    cta: 'Take bookings',
  },
  experiences: {
    label: 'Experiences', heading: 'Experiences & passes', short: 'Passes and things to do', color: '#0E7490', deep: '#164E63', photo: 'jarlshof', crop: { cx: 0.5, cy: 0.5, z: 1 },
    emptyTitle: 'Days out, coming soon', emptyBody: 'Guided walks, boat trips, workshops and multi-visit passes — buy once, use more than once.',
    cta: 'List an experience',
  },
};
export const PILLAR_ORDER: Pillar[] = ['shop', 'offers', 'book', 'experiences'];

/** An experience / pass opens the existing pass purchase flow (the same one the business page uses). */
export const EXPERIENCE_ROUTE = '/local-buy-unit';

/** Where each pillar's "See all" goes (all existing screens). */
export const PILLAR_ROUTE: Record<Pillar, string> = {
  shop: '/shop',
  offers: '/local-offers',
  book: '/local-bookable-browse',
  experiences: '/local-experiences',
};

/** The empty-pillar call to action ("Sell on OneShetland", "Post an offer"…) starts business onboarding. */
export const PILLAR_CTA_ROUTE = '/local-business-register';

/** Inventory band → how a pillar is presented. One rule for every surface. */
export type Density = 'none' | 'few' | 'rail' | 'many';
export function density(n: number): Density {
  return n === 0 ? 'none' : n <= 3 ? 'few' : n <= 12 ? 'rail' : 'many';
}

export const emptyCommerce = (): Record<Pillar, Merch[]> => ({ shop: [], offers: [], book: [], experiences: [] });

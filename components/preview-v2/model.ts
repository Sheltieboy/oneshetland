/**
 * model.ts — the App Home V2 / Local V2 design previews (routes /preview/home-v2, /preview/local-v2).
 *
 * PREVIEW ONLY. Not linked from the app, not part of any shipped build. It mirrors the web preview's model so the
 * two can be judged side by side: four content states, two viewers, the same inventory bands.
 *
 *   live   — real inventory read from production (today: no genuine commerce)
 *   empty  — pre-launch proposition state
 *   seed   — the launch seed: a handful of INVENTED sample items
 *   full   — a populated marketplace of invented sample items
 *
 *   public — acceptance / ZZ / demo commerce never appears
 *   admin  — QA: those fixtures appear, each visibly tagged TEST / QA
 */
import type { PhotoKey } from './images';

export type PreviewState = 'live' | 'empty' | 'seed' | 'full';
export type PreviewViewer = 'public' | 'admin';
export type Pillar = 'shop' | 'offers' | 'book' | 'experiences';
export type Crop = { cx: number; cy: number; z: number };

export interface Merch {
  id: string;
  pillar: Pillar;
  title: string;
  business: string;
  price?: string;
  badge?: string;
  meta?: string;
  photo?: PhotoKey;
  /** A real remote image (live data). */
  uri?: string;
  crop?: Crop;
  tag?: 'TEST' | 'QA';
  category?: string;
}

export const STATES: { key: PreviewState; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'empty', label: 'Pre-launch' },
  { key: 'seed', label: 'Seed' },
  { key: 'full', label: 'Populated' },
];

export const PILLARS: Record<Pillar, {
  label: string; short: string; color: string; deep: string; photo: PhotoKey; crop: Crop;
  emptyTitle: string; emptyBody: string; cta: string; cats: string[]; heading: string;
}> = {
  shop: {
    label: 'Shop', heading: 'Shop from Shetland', short: 'Made here, bought from the maker', color: '#7C3AED', deep: '#3B0764', photo: 'shopping', crop: { cx: 0.5, cy: 0.5, z: 1 },
    emptyTitle: "Shetland's makers are moving in", emptyBody: 'Knitwear, gin, smoked salmon and silver — bought direct from the people who make it. The first shops open here soon.',
    cta: 'Sell on OneShetland', cats: ['Knitwear', 'Food & drink', 'Craft', 'Art & prints', 'Home', 'Gifts'],
  },
  offers: {
    label: 'Offers', heading: 'Offers', short: 'Local deals and rewards', color: '#D97706', deep: '#78350F', photo: 'street', crop: { cx: 0.12, cy: 0.6, z: 1.9 },
    emptyTitle: 'Local deals are on their way', emptyBody: 'Shops and cafés will post their offers here — a free coffee, a discount on a cake box, a bit off the haircut.',
    cta: 'Post an offer', cats: ['Food & drink', 'Shops', 'Services', 'This week'],
  },
  book: {
    label: 'Book', heading: 'Book local', short: 'Pick a service, pick a slot', color: '#059669', deep: '#064E3B', photo: 'cafe', crop: { cx: 0.5, cy: 0.45, z: 1.1 },
    emptyTitle: 'Booking is opening up', emptyBody: 'Hair, beauty, therapies, repairs — see the free slots and book without the phone tag.',
    cta: 'Take bookings', cats: ['Hair & beauty', 'Wellbeing', 'Repairs', 'Lessons'],
  },
  experiences: {
    label: 'Experiences', heading: 'Experiences & passes', short: 'Passes and things to do', color: '#0E7490', deep: '#164E63', photo: 'jarlshof', crop: { cx: 0.5, cy: 0.5, z: 1 },
    emptyTitle: 'Days out, coming soon', emptyBody: 'Guided walks, boat trips, workshops and multi-visit passes — buy once, use more than once.',
    cta: 'List an experience', cats: ['Heritage', 'Wildlife', 'Boat trips', 'Workshops'],
  },
};
export const PILLAR_ORDER: Pillar[] = ['shop', 'offers', 'book', 'experiences'];

type Base = Omit<Merch, 'id' | 'pillar'>;
const SHOP: Base[] = [
  { title: 'Fair Isle yoke jumper', business: 'Sample Knitwear Studio', price: '£185', photo: 'shopping', crop: { cx: 0.24, cy: 0.2, z: 2.3 }, category: 'Knitwear' },
  { title: 'Harbour art print', business: 'Sample Print Studio', price: '£22', photo: 'boats', crop: { cx: 0.62, cy: 0.5, z: 1.5 }, category: 'Art & prints' },
  { title: 'Shetland dry gin, 70cl', business: 'Sample Distillery', price: '£38', photo: 'shopping', crop: { cx: 0.44, cy: 0.38, z: 2.6 }, category: 'Food & drink' },
  { title: 'Hand-knitted mittens', business: 'Sample Knitwear Studio', price: '£42', photo: 'shopping', crop: { cx: 0.12, cy: 0.68, z: 2.4 }, category: 'Knitwear' },
  { title: 'Smoked salmon, whole side', business: 'Sample Smokehouse', price: '£24', photo: 'shopping', crop: { cx: 0.46, cy: 0.76, z: 2.4 }, category: 'Food & drink' },
  { title: 'Silver drop earrings', business: 'Sample Silversmith', price: '£58', photo: 'shopping', crop: { cx: 0.82, cy: 0.86, z: 2.8 }, category: 'Gifts' },
  { title: 'Blue cheese, 250g', business: 'Sample Dairy', price: '£9', photo: 'shopping', crop: { cx: 0.69, cy: 0.56, z: 2.6 }, category: 'Food & drink' },
  { title: 'Brown crab, dressed', business: 'Sample Fishmonger', price: '£11', photo: 'shopping', crop: { cx: 0.88, cy: 0.52, z: 2.4 }, category: 'Food & drink' },
  { title: 'Oatcakes, tin of 12', business: 'Sample Bakehouse', price: '£6', photo: 'shopping', crop: { cx: 0.16, cy: 0.9, z: 2.6 }, category: 'Food & drink' },
  { title: 'Wool, 4-ply skein', business: 'Sample Spinners', price: '£14', photo: 'shopping', crop: { cx: 0.08, cy: 0.3, z: 2.8 }, category: 'Craft' },
  { title: 'Mussels, 1kg net', business: 'Sample Shellfish Co.', price: '£8', photo: 'shopping', crop: { cx: 0.72, cy: 0.2, z: 2.4 }, category: 'Food & drink' },
  { title: 'Handmade pottery jug', business: 'Sample Pottery', price: '£36', photo: 'shopping', crop: { cx: 0.53, cy: 0.17, z: 2.9 }, category: 'Home' },
];
const OFFERS: Base[] = [
  { title: '10% off any cake box', business: 'Sample Bakehouse', badge: '10% off', meta: 'Until 31 Oct' },
  { title: 'Free coffee with any pastry', business: 'Sample Café', badge: 'Free coffee', meta: 'Weekdays before 11' },
  { title: 'Two-for-one on fish suppers', business: 'Sample Chip Shop', badge: '2 for 1', meta: 'Tuesdays' },
  { title: '£5 off a cut & finish', business: 'Sample Hair Studio', badge: '£5 off', meta: 'New clients' },
  { title: '20% off knitting wool', business: 'Sample Spinners', badge: '20% off', meta: 'This week only' },
  { title: 'Free delivery in Lerwick', business: 'Sample Grocer', badge: 'Free delivery', meta: 'Orders over £25' },
  { title: 'Kids eat free at weekends', business: 'Sample Bistro', badge: 'Kids free', meta: 'Sat & Sun' },
  { title: 'Buy a mug, get a refill free', business: 'Sample Roasters', badge: 'Free refill', meta: 'All month' },
];
const BOOK: Base[] = [
  { title: 'Cut & finish', business: 'Sample Hair Studio', price: 'from £32', meta: '45 min', badge: 'Next: Tue 10:30' },
  { title: 'Deep tissue massage', business: 'Sample Therapies', price: 'from £55', meta: '60 min', badge: 'Next: Wed 14:00' },
  { title: 'Bike service & safety check', business: 'Sample Cycles', price: 'from £45', meta: '90 min', badge: 'Next: Thu 09:00' },
  { title: 'Gel manicure', business: 'Sample Beauty Room', price: 'from £28', meta: '50 min', badge: 'Next: Tue 16:15' },
  { title: 'Fiddle lesson, 1-to-1', business: 'Sample Music Room', price: '£20', meta: '30 min', badge: 'Next: Sat 11:00' },
  { title: 'Boiler check', business: 'Sample Heating', price: 'from £70', meta: '60 min', badge: 'Next: Mon 08:30' },
  { title: 'Barber — skin fade', business: 'Sample Barbers', price: 'from £18', meta: '30 min', badge: 'Next: Today 15:45' },
  { title: 'Reflexology', business: 'Sample Therapies', price: 'from £42', meta: '45 min', badge: 'Next: Fri 12:00' },
];
const EXP: Base[] = [
  { title: 'Guided prehistoric site visit', business: 'Sample Heritage Tours', price: '£12', meta: '2 hours · small groups', photo: 'jarlshof', crop: { cx: 0.5, cy: 0.55, z: 1.15 } },
  { title: 'Lighthouse & headland tour', business: 'Sample Coast Guides', price: '£9', meta: '90 minutes', photo: 'lighthouse', crop: { cx: 0.62, cy: 0.5, z: 1.1 } },
  { title: 'Iron Age village day pass', business: 'Sample Heritage Tours', price: '£10', meta: '5 visits · valid 12 months', photo: 'scatness', crop: { cx: 0.5, cy: 0.5, z: 1.05 } },
  { title: 'Working harbour walk', business: 'Sample Fishing Heritage', price: '£7', meta: '60 minutes', photo: 'boats', crop: { cx: 0.55, cy: 0.55, z: 1.1 } },
  { title: 'Peat & croft stories', business: 'Sample Croft Museum', price: '£6', meta: '45 minutes', photo: 'memory', crop: { cx: 0.5, cy: 0.5, z: 1.1 } },
  { title: 'Evening coastal wildlife cruise', business: 'Sample Sea Trips', price: '£55', meta: '3 hours', photo: 'cruise', crop: { cx: 0.5, cy: 0.5, z: 1.1 } },
];
const BASES: Record<Pillar, Base[]> = { shop: SHOP, offers: OFFERS, book: BOOK, experiences: EXP };
const COUNTS = { seed: { shop: 3, offers: 2, book: 2, experiences: 3 }, full: { shop: 24, offers: 22, book: 20, experiences: 21 } } as const;

const QA: Merch[] = [
  { id: 'qa-print', pillar: 'shop', title: 'Hamnavoe Lighthouse Print', business: 'ZZ TEST — Acceptance Fixture', price: '£1', tag: 'QA' },
  { id: 'qa-demo-product', pillar: 'shop', title: 'DEMO — Launch Test Product', business: 'Anderson & Co (demo seed)', price: '£1', tag: 'TEST' },
  { id: 'qa-booking', pillar: 'book', title: 'ZZ - Test booking', business: 'ZZ TEST — Acceptance Fixture', price: '£1', meta: '30 min', badge: 'QA slot', tag: 'QA' },
  { id: 'qa-wallet-pass', pillar: 'experiences', title: 'ZZ TEST — Wallet Pass', business: 'ZZ TEST — Acceptance Fixture', price: '£1', meta: '1 use · valid 1 day', tag: 'QA' },
  { id: 'qa-demo-pass', pillar: 'experiences', title: 'ZZ - Demo Pass', business: 'ZZ TEST — Acceptance Fixture', price: '£1', meta: '1 use · valid 10 days', tag: 'QA' },
];

function sample(pillar: Pillar, n: number): Merch[] {
  const base = BASES[pillar];
  return Array.from({ length: n }, (_, i) => {
    const b = base[i % base.length];
    const round = Math.floor(i / base.length);
    return { ...b, id: `${pillar}-${i}`, pillar, title: round ? `${b.title} — ${['small', 'large', 'gift set'][round % 3]}` : b.title };
  });
}

export function buildCommerce(state: PreviewState, viewer: PreviewViewer, real: Record<Pillar, Merch[]>): Record<Pillar, Merch[]> {
  const empty = { shop: [], offers: [], book: [], experiences: [] } as Record<Pillar, Merch[]>;
  const base: Record<Pillar, Merch[]> =
    state === 'live' ? real : state === 'empty' ? empty
      : { shop: sample('shop', COUNTS[state].shop), offers: sample('offers', COUNTS[state].offers), book: sample('book', COUNTS[state].book), experiences: sample('experiences', COUNTS[state].experiences) };
  if (viewer !== 'admin') return base;
  const out = { ...base };
  for (const q of QA) out[q.pillar] = [q, ...out[q.pillar].filter((m) => m.id !== q.id)];
  return out;
}

export type Density = 'none' | 'few' | 'rail' | 'many';
export const density = (n: number): Density => (n === 0 ? 'none' : n <= 3 ? 'few' : n <= 12 ? 'rail' : 'many');

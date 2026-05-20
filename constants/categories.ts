export const DELIVERY_CATEGORIES = [
  {
    slug: 'takeaway',
    name: 'Takeaway',
    icon: '🍕',
    description: 'Food from restaurants, cafés, and takeaways',
  },
  {
    slug: 'pharmacy',
    name: 'Pharmacy collection',
    icon: '💊',
    description: 'Prescriptions and over-the-counter items',
  },
  {
    slug: 'small-parcel',
    name: 'Small parcel',
    icon: '📦',
    description: 'Packages that fit in a car boot',
  },
  {
    slug: 'shop-collection',
    name: 'Shop collection',
    icon: '🛍️',
    description: 'Items purchased from Lerwick shops',
  },
  {
    slug: 'supermarket-click-collect',
    name: 'Supermarket click-and-collect',
    icon: '🛒',
    description: 'Pre-ordered grocery shopping',
  },
  {
    slug: 'other',
    name: 'Other small collection',
    icon: '📫',
    description: 'Anything else that fits our guidelines',
  },
] as const;

export type CategorySlug = (typeof DELIVERY_CATEGORIES)[number]['slug'];

export function getCategoryName(slug: string): string {
  return DELIVERY_CATEGORIES.find((c) => c.slug === slug)?.name ?? slug;
}

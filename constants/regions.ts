export const REGIONS = [
  { slug: 'lerwick', name: 'Lerwick' },
  { slug: 'bressay', name: 'Bressay' },
  { slug: 'burra', name: 'Burra' },
  { slug: 'central-mainland', name: 'Central Mainland' },
  { slug: 'fair-isle', name: 'Fair Isle' },
  { slug: 'fetlar', name: 'Fetlar' },
  { slug: 'muckle-roe', name: 'Muckle Roe' },
  { slug: 'north-mainland', name: 'North Mainland' },
  { slug: 'northmavine', name: 'Northmavine' },
  { slug: 'out-skerries', name: 'Out Skerries' },
  { slug: 'scalloway', name: 'Scalloway' },
  { slug: 'south-mainland', name: 'South Mainland' },
  { slug: 'trondra', name: 'Trondra' },
  { slug: 'unst', name: 'Unst' },
  { slug: 'west-mainland', name: 'West Mainland' },
  { slug: 'whalsay', name: 'Whalsay' },
  { slug: 'yell', name: 'Yell' },
] as const;

export type RegionSlug = (typeof REGIONS)[number]['slug'];

export function getRegionName(slug: string): string {
  return REGIONS.find((r) => r.slug === slug)?.name ?? slug;
}

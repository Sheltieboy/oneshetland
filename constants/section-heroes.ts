/**
 * section-heroes.ts — the single registry of hero photos for the section
 * landing banners (TabScreenHeader / SectionHero).
 *
 * React Native bundles images through STATIC require() calls at build time, so
 * a photo can't be auto-discovered from the folder — every one must be listed
 * here explicitly, AND the file must exist (a require() of a missing file
 * breaks the build). Any section without an entry falls back to its tinted
 * gradient, which still looks intentional.
 *
 * TO ADD A HERO: drop the image in assets/section-heroes/ and add one line
 * below using its EXACT filename (mind the extension — .jpg vs .jpeg).
 */
export const SECTION_HEROES: Record<string, any> = {
  memories:  require('@/assets/section-heroes/memories.jpg'),
  daBoats:   require('@/assets/section-heroes/da-boats.jpg'),
  events:    require('@/assets/section-heroes/events.jpg'),
  local:     require('@/assets/section-heroes/local.jpeg'),    // note: .jpeg
  directory: require('@/assets/section-heroes/directory.jpg'),
  fetch:     require('@/assets/section-heroes/fetch.jpeg'),    // note: .jpeg
  jobs:      require('@/assets/section-heroes/jobs.webp'),     // note: .webp
  // Add as you create them (the file must exist before uncommenting):
  // spik:      require('@/assets/section-heroes/spik.jpg'),
  // shifts:    require('@/assets/section-heroes/shifts.jpg'),
  // community: require('@/assets/section-heroes/community.jpg'),
  // games:     require('@/assets/section-heroes/games.jpg'),
};

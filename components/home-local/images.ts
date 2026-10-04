/**
 * Photography for the Home and Local screens (brand assets, also used by the web). Metro needs static require() paths, so the
 * map is explicit. Aspect ratios are what CropImage uses to compute an exact crop.
 */
export type Photo = { src: number; w: number; h: number };

export const PHOTOS = {
  shopping:  { src: require('../../assets/home-local/shopping.jpg'),     w: 1600, h: 900 },
  street:    { src: require('../../assets/home-local/local-street.jpg'), w: 1000, h: 681 },
  cafe:      { src: require('../../assets/home-local/cafe.jpg'),         w: 1000, h: 1000 },
  jarlshof:  { src: require('../../assets/home-local/jarlshof.jpg'),     w: 1000, h: 561 },
  lighthouse:{ src: require('../../assets/home-local/lighthouse.jpg'),   w: 1000, h: 659 },
  scatness:  { src: require('../../assets/home-local/scatness.jpg'),     w: 1000, h: 1000 },
  boats:     { src: require('../../assets/home-local/boats.jpg'),        w: 1000, h: 666 },
  memory:    { src: require('../../assets/home-local/memory.jpg'),       w: 1000, h: 707 },
  concert:   { src: require('../../assets/home-local/concert.jpg'),      w: 1000, h: 667 },
  cruise:    { src: require('../../assets/home-local/cruise.jpg'),       w: 1000, h: 800 },
} as const satisfies Record<string, Photo>;

export type PhotoKey = keyof typeof PHOTOS;

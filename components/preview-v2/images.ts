/**
 * Preview-only photography (brand assets already used by the web). Metro needs static require() paths, so the
 * map is explicit. Aspect ratios are what CropImage uses to compute an exact crop.
 */
export type Photo = { src: number; w: number; h: number };

export const PHOTOS = {
  shopping:  { src: require('../../assets/preview-v2/shopping.jpg'),     w: 1600, h: 900 },
  street:    { src: require('../../assets/preview-v2/local-street.jpg'), w: 1000, h: 681 },
  cafe:      { src: require('../../assets/preview-v2/cafe.jpg'),         w: 1000, h: 1000 },
  jarlshof:  { src: require('../../assets/preview-v2/jarlshof.jpg'),     w: 1000, h: 561 },
  lighthouse:{ src: require('../../assets/preview-v2/lighthouse.jpg'),   w: 1000, h: 659 },
  scatness:  { src: require('../../assets/preview-v2/scatness.jpg'),     w: 1000, h: 1000 },
  boats:     { src: require('../../assets/preview-v2/boats.jpg'),        w: 1000, h: 666 },
  memory:    { src: require('../../assets/preview-v2/memory.jpg'),       w: 1000, h: 707 },
  concert:   { src: require('../../assets/preview-v2/concert.jpg'),      w: 1000, h: 667 },
  cruise:    { src: require('../../assets/preview-v2/cruise.jpg'),       w: 1000, h: 800 },
} as const satisfies Record<string, Photo>;

export type PhotoKey = keyof typeof PHOTOS;

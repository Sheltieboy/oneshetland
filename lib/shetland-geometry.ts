/**
 * lib/shetland-geometry.ts
 *
 * Hand-tuned simplified polygon outlines for the Shetland archipelago.
 * Used by the Map It game to render an on-brand SVG map without depending
 * on heavy GeoJSON loads or a native map library.
 *
 * Geographic span used to size the viewport:
 *   Lat:  59.45°N (Fair Isle south) → 60.90°N (Out Stack)
 *   Lng: -2.20°W (Foula west)       → -0.55°W (Out Skerries east)
 *
 * Polygons are approximate — accurate enough to be unmistakably Shetland,
 * not so detailed that they slow the render. Tuned for visual recognition.
 */

// ── Viewport bounds ──────────────────────────────────────────────────────────
//
// Coordinates of the bounding box the map renders. Slightly padded so the
// outermost islands (Fair Isle, Foula, Out Stack) don't touch the edges.

export const VIEW_BOUNDS = {
  minLat: 59.45,
  maxLat: 60.92,
  minLng: -2.30,
  maxLng: -0.55,
};

// ── Projection ───────────────────────────────────────────────────────────────
//
// Simple equirectangular projection. For a small region like Shetland the
// distortion is negligible — better than full Mercator for this scale and
// much easier to invert when the user taps. We adjust the X scale by the
// cosine of the centre latitude so islands look the right shape (otherwise
// they'd appear stretched east-west).

const CENTRE_LAT = (VIEW_BOUNDS.minLat + VIEW_BOUNDS.maxLat) / 2;
const COS_CENTRE = Math.cos(CENTRE_LAT * Math.PI / 180);

/** Convert lat/lng → (x, y) within a canvas of the given width/height. */
export function latLngToXY(lat: number, lng: number, w: number, h: number): { x: number; y: number } {
  const fx = (lng - VIEW_BOUNDS.minLng) * COS_CENTRE / ((VIEW_BOUNDS.maxLng - VIEW_BOUNDS.minLng) * COS_CENTRE);
  const fy = 1 - (lat - VIEW_BOUNDS.minLat) / (VIEW_BOUNDS.maxLat - VIEW_BOUNDS.minLat);
  return { x: fx * w, y: fy * h };
}

/** Inverse projection — used when the user taps the map. */
export function xyToLatLng(x: number, y: number, w: number, h: number): { lat: number; lng: number } {
  const lat = VIEW_BOUNDS.minLat + (1 - y / h) * (VIEW_BOUNDS.maxLat - VIEW_BOUNDS.minLat);
  const lng = VIEW_BOUNDS.minLng + (x / w) * (VIEW_BOUNDS.maxLng - VIEW_BOUNDS.minLng);
  return { lat, lng };
}

// ── Haversine distance (km) ──────────────────────────────────────────────────

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; // km
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Island polygons ──────────────────────────────────────────────────────────
//
// Each island is a list of lat/lng vertices defining its outline.  Order is
// counter-clockwise (so when rendered with the y-axis flipped, they appear
// the right way round).  Counts kept small (~12–25 vertices per island) for
// performance.

export interface Island {
  name:   string;
  region: string;
  points: Array<{ lat: number; lng: number }>;
}

export const ISLANDS: Island[] = [
  // ─── Mainland — the big Y-shaped island ────────────────────────────────────
  {
    name: 'Mainland',
    region: 'mainland',
    points: [
      // Start at Sumburgh Head (south-east tip) and work clockwise round the coast.
      { lat: 59.852, lng: -1.272 },  // Sumburgh Head
      { lat: 59.870, lng: -1.300 },  // West Voe of Sumburgh
      { lat: 59.880, lng: -1.345 },  // Quendale
      { lat: 59.940, lng: -1.345 },  // Spiggie / Bigton
      { lat: 59.975, lng: -1.355 },  // St Ninian's neck
      { lat: 60.005, lng: -1.345 },  // Maywick area
      { lat: 60.085, lng: -1.395 },  // Burra side (west burra peninsula entrance)
      { lat: 60.130, lng: -1.475 },  // Skeld / Reawick
      { lat: 60.230, lng: -1.625 },  // Sandness south
      { lat: 60.305, lng: -1.680 },  // Sandness north / Watsness
      { lat: 60.355, lng: -1.620 },  // Walls / Bridge of Walls
      { lat: 60.395, lng: -1.500 },  // Aith area NW
      { lat: 60.440, lng: -1.500 },  // Northmavine SW (Eshaness peninsula entrance)
      { lat: 60.480, lng: -1.640 },  // Eshaness cliffs
      { lat: 60.540, lng: -1.500 },  // North Roe west
      { lat: 60.605, lng: -1.420 },  // Uyea / Ronas Hill west
      { lat: 60.630, lng: -1.330 },  // Sandvoe / North Roe east
      { lat: 60.580, lng: -1.205 },  // Yell Sound coast
      { lat: 60.490, lng: -1.140 },  // Toft / Mossbank
      { lat: 60.440, lng: -1.080 },  // Vidlin / Lunna
      { lat: 60.385, lng: -1.060 },  // South of Vidlin
      { lat: 60.330, lng: -1.115 },  // Brae east
      { lat: 60.270, lng: -1.125 },  // Catfirth area
      { lat: 60.200, lng: -1.105 },  // Lerwick north
      { lat: 60.155, lng: -1.135 },  // Lerwick
      { lat: 60.110, lng: -1.180 },  // Gulberwick
      { lat: 60.040, lng: -1.210 },  // Cunningsburgh
      { lat: 59.990, lng: -1.230 },  // Sandwick
      { lat: 59.940, lng: -1.245 },  // Levenwick area
      { lat: 59.890, lng: -1.265 },  // Sumburgh area
    ],
  },

  // ─── Mavis Grind / North Mainland narrow — let me close the gap a bit ─
  // (handled by main outline above — Mavis Grind is just a narrow neck)

  // ─── Yell ────────────────────────────────────────────────────────────────
  {
    name: 'Yell',
    region: 'yell',
    points: [
      { lat: 60.480, lng: -1.150 },  // SW (Ulsta)
      { lat: 60.520, lng: -1.230 },  // West Sandwick
      { lat: 60.600, lng: -1.240 },  // West coast
      { lat: 60.660, lng: -1.140 },  // North west
      { lat: 60.735, lng: -1.020 },  // Gloup
      { lat: 60.715, lng: -0.940 },  // Cullivoe area NE
      { lat: 60.620, lng: -0.940 },  // Otterswick
      { lat: 60.560, lng: -0.985 },  // East coast
      { lat: 60.515, lng: -1.045 },  // Burravoe area
      { lat: 60.490, lng: -1.110 },  // SE
    ],
  },

  // ─── Unst ────────────────────────────────────────────────────────────────
  {
    name: 'Unst',
    region: 'unst',
    points: [
      { lat: 60.690, lng: -0.970 },  // Belmont SW
      { lat: 60.715, lng: -0.965 },  // Uyeasound
      { lat: 60.760, lng: -0.940 },  // West coast
      { lat: 60.830, lng: -0.910 },  // Hermaness
      { lat: 60.840, lng: -0.860 },  // Saxa Vord area
      { lat: 60.815, lng: -0.780 },  // Norwick / Skaw
      { lat: 60.745, lng: -0.780 },  // East coast
      { lat: 60.700, lng: -0.860 },  // Muness
      { lat: 60.685, lng: -0.950 },  // SE
    ],
  },

  // ─── Fetlar ──────────────────────────────────────────────────────────────
  {
    name: 'Fetlar',
    region: 'fetlar',
    points: [
      { lat: 60.610, lng: -0.900 },  // West
      { lat: 60.635, lng: -0.870 },  // NW
      { lat: 60.640, lng: -0.790 },  // NE
      { lat: 60.620, lng: -0.755 },  // Funzie east
      { lat: 60.595, lng: -0.790 },  // South coast east
      { lat: 60.590, lng: -0.870 },  // South coast west
    ],
  },

  // ─── Whalsay ─────────────────────────────────────────────────────────────
  {
    name: 'Whalsay',
    region: 'whalsay',
    points: [
      { lat: 60.330, lng: -1.000 },  // SW
      { lat: 60.345, lng: -1.010 },  // West
      { lat: 60.390, lng: -0.985 },  // NW
      { lat: 60.395, lng: -0.940 },  // North
      { lat: 60.370, lng: -0.910 },  // NE
      { lat: 60.335, lng: -0.940 },  // SE
    ],
  },

  // ─── Bressay (just east of Lerwick) ──────────────────────────────────────
  {
    name: 'Bressay',
    region: 'bressay',
    points: [
      { lat: 60.090, lng: -1.080 },  // S
      { lat: 60.105, lng: -1.105 },  // SW
      { lat: 60.165, lng: -1.110 },  // NW
      { lat: 60.200, lng: -1.075 },  // N
      { lat: 60.160, lng: -1.020 },  // NE
      { lat: 60.110, lng: -1.030 },  // SE
    ],
  },

  // ─── Noss (small, east of Bressay) ───────────────────────────────────────
  {
    name: 'Noss',
    region: 'bressay',
    points: [
      { lat: 60.130, lng: -1.020 },
      { lat: 60.145, lng: -1.030 },
      { lat: 60.165, lng: -1.005 },
      { lat: 60.155, lng: -0.985 },
      { lat: 60.135, lng: -0.985 },
    ],
  },

  // ─── Foula (way out west, alone) ─────────────────────────────────────────
  {
    name: 'Foula',
    region: 'foula',
    points: [
      { lat: 60.105, lng: -2.080 },
      { lat: 60.115, lng: -2.105 },
      { lat: 60.140, lng: -2.105 },
      { lat: 60.155, lng: -2.075 },
      { lat: 60.140, lng: -2.045 },
      { lat: 60.110, lng: -2.050 },
    ],
  },

  // ─── Papa Stour (off west mainland) ──────────────────────────────────────
  {
    name: 'Papa Stour',
    region: 'papa stour',
    points: [
      { lat: 60.315, lng: -1.720 },
      { lat: 60.345, lng: -1.730 },
      { lat: 60.355, lng: -1.690 },
      { lat: 60.340, lng: -1.660 },
      { lat: 60.320, lng: -1.680 },
    ],
  },

  // ─── Out Skerries (Bruray + Housay clustered) ───────────────────────────
  {
    name: 'Bruray',
    region: 'out skerries',
    points: [
      { lat: 60.415, lng: -0.755 },
      { lat: 60.430, lng: -0.760 },
      { lat: 60.430, lng: -0.730 },
      { lat: 60.420, lng: -0.730 },
    ],
  },
  {
    name: 'Housay',
    region: 'out skerries',
    points: [
      { lat: 60.413, lng: -0.770 },
      { lat: 60.428, lng: -0.770 },
      { lat: 60.425, lng: -0.755 },
      { lat: 60.415, lng: -0.755 },
    ],
  },

  // ─── Fair Isle (south, alone) ────────────────────────────────────────────
  {
    name: 'Fair Isle',
    region: 'fair isle',
    points: [
      { lat: 59.510, lng: -1.660 },
      { lat: 59.530, lng: -1.670 },
      { lat: 59.555, lng: -1.640 },
      { lat: 59.550, lng: -1.595 },
      { lat: 59.520, lng: -1.590 },
      { lat: 59.500, lng: -1.625 },
    ],
  },

  // ─── Mousa (off south mainland) ──────────────────────────────────────────
  {
    name: 'Mousa',
    region: 'mousa',
    points: [
      { lat: 59.990, lng: -1.190 },
      { lat: 60.010, lng: -1.195 },
      { lat: 60.015, lng: -1.165 },
      { lat: 59.995, lng: -1.160 },
    ],
  },

  // ─── Burra (W & E joined by bridge — render as one shape) ───────────────
  {
    name: 'Burra',
    region: 'central',
    points: [
      { lat: 60.025, lng: -1.330 },
      { lat: 60.060, lng: -1.380 },
      { lat: 60.130, lng: -1.360 },
      { lat: 60.130, lng: -1.310 },
      { lat: 60.090, lng: -1.300 },
      { lat: 60.050, lng: -1.320 },
    ],
  },

  // ─── Trondra (small, just south of central mainland) ────────────────────
  {
    name: 'Trondra',
    region: 'central',
    points: [
      { lat: 60.110, lng: -1.320 },
      { lat: 60.135, lng: -1.330 },
      { lat: 60.140, lng: -1.295 },
      { lat: 60.120, lng: -1.290 },
    ],
  },

  // ─── Muckle Roe (just west of north mainland) ────────────────────────────
  {
    name: 'Muckle Roe',
    region: 'north mainland',
    points: [
      { lat: 60.365, lng: -1.490 },
      { lat: 60.405, lng: -1.495 },
      { lat: 60.410, lng: -1.430 },
      { lat: 60.385, lng: -1.405 },
      { lat: 60.365, lng: -1.430 },
    ],
  },
];

/**
 * lib/boats-stats.ts
 *
 * Aggregate stats for the Da Boats landing — computed client-side from the
 * vessel_search rows the screen already loads (~467 boats), so no extra
 * round-trips. Also a gazetteer of boat-building towns: builder strings in the
 * archive embed the yard's town ("…in Buckie", "Macduff Shipyards", "in Skagen"),
 * so we match those to map coordinates and plot where Shetland's fleet was built.
 */

import { hullMaterialLabel, type VesselSearchRow, type VesselMetric } from './boats-api';

// ── Build-place gazetteer ────────────────────────────────────────────────────
// Each entry matches if any alias appears (case-insensitive) in the builder
// string. Ordered roughly by how specific the alias is.

export interface BuildPlace {
  key:   string;
  label: string;
  lat:   number;
  lng:   number;
  aliases: string[];
}

const BUILD_PLACES: BuildPlace[] = [
  // ── North-East Scotland (the heart of it) ──
  { key: 'buckie',       label: 'Buckie',        lat: 57.676, lng: -2.965, aliases: ['buckie', 'jones buckie', 'herd & mackenzie', 'herd and mackenzie'] },
  { key: 'macduff',      label: 'Macduff',       lat: 57.671, lng: -2.497, aliases: ['macduff'] },
  { key: 'fraserburgh',  label: 'Fraserburgh',   lat: 57.693, lng: -2.005, aliases: ['fraserburgh'] },
  { key: 'sandhaven',    label: 'Sandhaven',     lat: 57.700, lng: -2.040, aliases: ['sandhaven', 'forbes'] },
  { key: 'peterhead',    label: 'Peterhead',     lat: 57.508, lng: -1.784, aliases: ['peterhead'] },
  { key: 'aberdeen',     label: 'Aberdeen',      lat: 57.149, lng: -2.094, aliases: ['aberdeen', 'hall russell'] },
  { key: 'banff',        label: 'Banff',         lat: 57.665, lng: -2.529, aliases: ['banff'] },
  { key: 'whitehills',   label: 'Whitehills',    lat: 57.679, lng: -2.581, aliases: ['whitehills'] },
  // ── East / Fife / Borders ──
  { key: 'stmonans',     label: 'St Monans',     lat: 56.206, lng: -2.766, aliases: ['st monans', 'st. monans', 'miller'] },
  { key: 'anstruther',   label: 'Anstruther',    lat: 56.221, lng: -2.699, aliases: ['anstruther'] },
  { key: 'arbroath',     label: 'Arbroath',      lat: 56.561, lng: -2.583, aliases: ['arbroath'] },
  { key: 'eyemouth',     label: 'Eyemouth',      lat: 55.872, lng: -2.090, aliases: ['eyemouth', 'coastal marine'] },
  // ── West coast ──
  { key: 'campbeltown',  label: 'Campbeltown',   lat: 55.425, lng: -5.606, aliases: ['campbeltown'] },
  { key: 'girvan',       label: 'Girvan',        lat: 55.245, lng: -4.857, aliases: ['girvan', 'noble'] },
  // ── England / Wales ──
  { key: 'whitby',       label: 'Whitby',        lat: 54.486, lng: -0.613, aliases: ['whitby', 'parkol'] },
  { key: 'penryn',       label: 'Penryn',        lat: 50.169, lng: -5.107, aliases: ['penryn', 'cygnus'] },
  { key: 'appledore',    label: 'Appledore',     lat: 51.057, lng: -4.193, aliases: ['appledore', 'bideford'] },
  // ── Shetland & Orkney (home-built) ──
  { key: 'lerwick',      label: 'Lerwick',       lat: 60.155, lng: -1.145, aliases: ['lerwick', 'hay & co', 'malakoff'] },
  { key: 'scalloway',    label: 'Scalloway',     lat: 60.133, lng: -1.276, aliases: ['scalloway'] },
  // ── Nordic & beyond ──
  { key: 'skagen',       label: 'Skagen (DK)',     lat: 57.721, lng: 10.583, aliases: ['skagen', 'karstensen'] },
  { key: 'flekkefjord',  label: 'Flekkefjord (NO)', lat: 58.297, lng: 6.661,  aliases: ['flekkefjord'] },
  { key: 'maloy',        label: 'Måløy (NO)',      lat: 61.936, lng: 5.113,  aliases: ['måløy', 'maloy', 'solund'] },
  { key: 'simek',        label: 'Flekkefjord (NO)', lat: 58.297, lng: 6.661,  aliases: ['simek'] },
  { key: 'istanbul',     label: 'Istanbul (TR)',   lat: 41.008, lng: 28.978, aliases: ['istanbul', 'sedef', 'tersan'] },
  { key: 'gdansk',       label: 'Gdańsk (PL)',     lat: 54.352, lng: 18.646, aliases: ['gdansk', 'gdańsk', 'poland'] },
  { key: 'iceland',      label: 'Iceland',         lat: 64.146, lng: -21.94, aliases: ['reykjav', 'iceland', 'akureyri'] },
];

export function matchBuildPlace(builder: string | null): BuildPlace | null {
  if (!builder) return null;
  const b = builder.toLowerCase();
  for (const p of BUILD_PLACES) {
    if (p.aliases.some(a => b.includes(a))) return p;
  }
  return null;
}

/**
 * Tidy the raw, often-messy builder string for display. The town (shown as a
 * chip) and trailing fragments after ";" or " in <Town>" are dropped:
 *   "Jones Buckie Slip in Buckie; James N"        → "Jones Buckie Slip"
 *   "Campbeltown Shipyard in Campbeltown"          → "Campbeltown Shipyard"
 *   "Langsten Slip; Sedef Shipbuilding in Istanbul"→ "Langsten Slip"
 *   "Macduff Shipyards Ltd"                         → unchanged
 */
export function cleanBuilderName(name: string): string {
  let s = name.split(';')[0].trim();
  // Drop a trailing " in <Place…>" clause.
  s = s.replace(/\s+in\s+[A-Za-zÅÄÖØÆåäöøæ].*$/u, '').trim();
  // Trim dangling punctuation / lone trailing initials.
  s = s.replace(/[\s,;:–-]+$/u, '').trim();
  return s || name;
}

// ── Fleet stats ──────────────────────────────────────────────────────────────

export interface CountBucket { key: string; label: string; count: number; }
export interface BuildPlaceCount extends BuildPlace { count: number; }

/** Rich per-yard stats for the "Busiest yards" cards. */
export interface BuilderStat {
  name:        string;            // raw builder string (also the filter key)
  displayName: string;            // tidied for display
  count:       number;            // boats built
  yearMin:     number | null;
  yearMax:     number | null;
  place:       BuildPlace | null; // matched build town
  photos:      number;            // total photos across this yard's boats
  hullTop:     string | null;     // dominant hull material label
  withPhotos:  number;            // boats that have at least one photo
  avgLength:   number | null;     // mean length (m) across boats with a measurement
  maxEngine:   number | null;     // most powerful engine (kW)
  heroUrl:     string | null;     // a representative boat photo
}

export interface FleetStats {
  total:       number;
  withPhotos:  number;
  yearMin:     number | null;
  yearMax:     number | null;
  builderCount: number;
  decades:     CountBucket[];          // chronological
  hulls:       CountBucket[];          // desc by count
  topBuilders: BuilderStat[];          // desc by count, top 10, with rich stats
  buildPlaces: BuildPlaceCount[];      // desc by count
  placedBoats: number;                 // boats matched to a build place
}

function decadeOf(year: number): string {
  return `${Math.floor(year / 10) * 10}s`;
}

export function computeFleetStats(
  rows: VesselSearchRow[],
  opts?: { metrics?: Record<string, VesselMetric>; heroes?: Record<string, string> },
): FleetStats {
  const metrics = opts?.metrics ?? {};
  const heroes  = opts?.heroes ?? {};
  const years = rows.map(r => r.built_year).filter((y): y is number => !!y);
  const yearMin = years.length ? Math.min(...years) : null;
  const yearMax = years.length ? Math.max(...years) : null;

  // Decades
  const decadeMap = new Map<string, number>();
  for (const y of years) decadeMap.set(decadeOf(y), (decadeMap.get(decadeOf(y)) ?? 0) + 1);
  const decades: CountBucket[] = [...decadeMap.entries()]
    .map(([k, count]) => ({ key: k, label: k, count }))
    .sort((a, b) => parseInt(a.key) - parseInt(b.key));

  // Hulls
  const hullMap = new Map<string, number>();
  for (const r of rows) {
    if (!r.hull_material) continue;
    const code = r.hull_material.toUpperCase();
    hullMap.set(code, (hullMap.get(code) ?? 0) + 1);
  }
  const hulls: CountBucket[] = [...hullMap.entries()]
    .map(([code, count]) => ({ key: code, label: hullMaterialLabel(code) ?? code, count }))
    .sort((a, b) => b.count - a.count);

  // Builders — rich per-yard aggregation.
  const builderAcc = new Map<string, VesselSearchRow[]>();
  for (const r of rows) {
    const b = (r.builder ?? '').trim();
    if (!b) continue;
    if (!builderAcc.has(b)) builderAcc.set(b, []);
    builderAcc.get(b)!.push(r);
  }
  const topBuilders: BuilderStat[] = [...builderAcc.entries()]
    .map(([name, brows]) => {
      const yrs = brows.map(x => x.built_year).filter((y): y is number => !!y);
      // Dominant hull
      const hullCounts = new Map<string, number>();
      for (const x of brows) {
        if (!x.hull_material) continue;
        const c = x.hull_material.toUpperCase();
        hullCounts.set(c, (hullCounts.get(c) ?? 0) + 1);
      }
      const hullTopCode = [...hullCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      // Length / engine from the measurements map.
      const lengths = brows.map(x => metrics[x.id]?.length).filter((n): n is number => !!n);
      const engines = brows.map(x => metrics[x.id]?.engine).filter((n): n is number => !!n);
      const avgLength = lengths.length ? lengths.reduce((s, n) => s + n, 0) / lengths.length : null;
      const maxEngine = engines.length ? Math.max(...engines) : null;

      // Representative photo: the most-photographed boat that has a loaded hero.
      const heroUrl = [...brows]
        .sort((a, b) => (b.media_asset_count ?? 0) - (a.media_asset_count ?? 0))
        .map(x => heroes[x.id])
        .find(Boolean) ?? null;

      return {
        name,
        displayName: cleanBuilderName(name),
        count:      brows.length,
        yearMin:    yrs.length ? Math.min(...yrs) : null,
        yearMax:    yrs.length ? Math.max(...yrs) : null,
        place:      matchBuildPlace(name),
        photos:     brows.reduce((s, x) => s + (x.media_asset_count ?? 0), 0),
        withPhotos: brows.filter(x => (x.media_asset_count ?? 0) > 0).length,
        hullTop:    hullMaterialLabel(hullTopCode),
        avgLength,
        maxEngine,
        heroUrl,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Build places (map)
  const placeMap = new Map<string, BuildPlaceCount>();
  let placedBoats = 0;
  for (const r of rows) {
    const place = matchBuildPlace(r.builder);
    if (!place) continue;
    placedBoats++;
    const existing = placeMap.get(place.key);
    if (existing) existing.count++;
    else placeMap.set(place.key, { ...place, count: 1 });
  }
  const buildPlaces = [...placeMap.values()].sort((a, b) => b.count - a.count);

  return {
    total:        rows.length,
    withPhotos:   rows.filter(r => (r.media_asset_count ?? 0) > 0).length,
    yearMin,
    yearMax,
    builderCount: builderAcc.size,
    decades,
    hulls,
    topBuilders,
    buildPlaces,
    placedBoats,
  };
}

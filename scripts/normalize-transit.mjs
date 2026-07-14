/**
 * normalize-transit.mjs — turn the raw per-region transcription JSON into one
 * normalized transit network ({stops, trips}) the planner consumes.
 *
 * Run:  node normalize-transit.mjs
 * Writes: transit-network.json into both repos' lib/ dirs, prints stats +
 * any stops that fell back to region-default area (for review).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// Raw per-region transcriptions live alongside this script; outputs go to both
// repos' lib/ dirs. Re-run with `node scripts/normalize-transit.mjs` after editing
// any transit-raw/*.json (e.g. a timetable refresh).
const HERE = new URL('.', import.meta.url).pathname;
const RAW = `${HERE}transit-raw`;
const OUT_APP = `${HERE}../lib/transit-network.json`;
const OUT_WEB = `${HERE}../../oneshetland-web/lib/transit-network.json`;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hhmm = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}`;

// ── Stop → area ─────────────────────────────────────────────────────────────
const REGION_DEFAULT = {
  'bus-north_mainland': 'north-mainland',
  'bus-north_isles': 'yell',
  'bus-west_mainland': 'west-mainland',
  'bus-south_mainland': 'south-mainland',
  'bus-lerwick_scalloway': 'lerwick',
};
// Lerwick hub stops (recur across region files as the town/terminus end).
const LERWICK_STOPS = new Set([
  'viking bus station', 'esplanade', 'king harald street', 'north road', 'north road (bolts)',
  'anderson high school', 'shetland hotel', 'shetland college', 'holmsgarth', 'harrison square',
  'tesco', 'gremista', 'lerwick', 'clickimin', 'sound', 'staney hill', 'gilbertson road',
  'commercial street', 'town hall',
].map(slug));
// Ferry terminals + a few cross-region stops (name-slug → {area, terminal}).
const OVERRIDES = {
  voe: { area: 'north-mainland' },   // Mainland Voe (Service 23/19), not a Yell stop
  brae: { area: 'north-mainland' },
  // ── User-verified corrections (authoritative) ──
  burravoe: { area: 'yell' },
  hoofields: { area: 'lerwick' },
  voxter: { area: 'north-mainland' },
  'westerloch-junction': { area: 'lerwick' },
  ackrigarth: { area: 'lerwick' },
  // ── Ferry terminals ──
  toft: { area: 'north-mainland', terminal: true },
  ulsta: { area: 'yell', terminal: true },
  gutcher: { area: 'yell', terminal: true },
  belmont: { area: 'unst', terminal: true },
  'hamars-ness': { area: 'fetlar', terminal: true },
  'h-ness': { area: 'fetlar', terminal: true },
  symbister: { area: 'whalsay', terminal: true },
  laxo: { area: 'north-mainland', terminal: true },
  vidlin: { area: 'north-mainland', terminal: true },
  bressay: { area: 'bressay', terminal: true },
};
// Place-name keyword → area (applied to each stop name; strong in Shetland).
const KEYWORDS = [
  // Lerwick streets/landmarks that recur on inbound routes (must win over region default).
  [/lochside|nordavatn|colonial place|jrj|freefield|clickimin|gilbert bain|holmsgarth|gremista|staney hill|sea road|anderson high|shetland college|shetland hotel|viking bus|harrison square|king harald|esplanade|north road|knab|slates road|burgh road|scalloway road/, 'lerwick'],
  [/scalloway|burra|hamnavoe|trondra|blydoit|hoofields|houss|papil|port arthur|bridge end|meal/, 'scalloway'],
  [/bressay|beosetter|kirkabister|heogan|\bnoss\b|ackrigarth|gunnista|aith ness/, 'bressay'],
  [/whalsay|symbister|skerries/, 'whalsay'],
  [/\b(unst|baltasound|uyeasound|haroldswick|saxavord|belmont|norwick|clivocast|muness|setters hill|valsgarth)\b/, 'unst'],
  [/\b(fetlar|houbie|funzie|hamars ness)\b/, 'fetlar'],
  [/\b(yell|ulsta|gutcher|mid yell|cullivoe|sellafirth|burravoe|aywick|camb|gossabrough|otterswick|west sandwick|gutcher)\b/, 'yell'],
  [/aith|bixter|walls|sandness|tresta|twatt|effirth|gruting|selivoe|sellivoe|bridge of walls|west burrafirth/, 'west-mainland'],
  [/cunningsburgh|sandwick|levenwick|bigton|boddam|sumburgh|virkie|dunrossness|quendale|hoswick|channerwick|toab|exnaboe|scatness|grutness/, 'south-mainland'],
  [/mossbank|toft|hillswick|sullom|vidlin|laxo|ollaberry|muckle roe|north roe|heylor|eshaness|urafirth/, 'north-mainland'],
  [/tingwall|girlsta|nesting|whiteness|weisdale|gott|wormadale|skellister|catfirth/, 'central'],
];
const areaFor = (name, region) => {
  const id = slug(name);
  if (OVERRIDES[id]) return OVERRIDES[id];
  if (LERWICK_STOPS.has(id)) return { area: 'lerwick' };
  const low = name.toLowerCase();
  for (const [re, area] of KEYWORDS) if (re.test(low)) return { area };
  return { area: REGION_DEFAULT[region] ?? 'central', fallback: true };
};

// ── Day-codes → weekday set ─────────────────────────────────────────────────
const RANGE = {
  'monday-friday': [1, 2, 3, 4, 5], 'monday-saturday': [1, 2, 3, 4, 5, 6],
  'monday-thursday': [1, 2, 3, 4], 'tuesday-friday': [2, 3, 4, 5], 'tuesday-thursday': [2, 3, 4],
  'monday-sunday': [0, 1, 2, 3, 4, 5, 6], monday: [1], tuesday: [2], wednesday: [3], thursday: [4],
  friday: [5], saturday: [6], sunday: [0],
};
const dayGroupDays = (g) => (g ? RANGE[g.toLowerCase().trim()] : null) ?? null;
const EXCLUDE_CODES = new Set(['DAR', 'AF', 'ATu', 'OnReq', 'ORQ', 'Dial-a-Ride']);
// Apply a footnote code to a weekday set + school flags. Returns null to drop trip.
function applyCode(code, days, flags) {
  if (EXCLUDE_CODES.has(code)) return null;
  const only = (arr) => days.filter((d) => arr.includes(d));
  const drop = (arr) => days.filter((d) => !arr.includes(d));
  switch (code) {
    case 'F': return only([5]);
    case 'NF': return drop([5]);
    case 'Sat': return only([6]);
    case 'NSat': return drop([6]);
    case 'Tu': return only([2]);
    case 'NTu': return drop([2]);
    case 'Th': return only([4]);
    case 'NTh': return drop([4]);
    case 'W': return only([3]);
    case 'M': return only([1]);
    case 'MWF': return only([1, 3, 5]);
    case 'MW': return only([1, 3]);
    case 'TTF': return only([2, 4, 5]);
    case 'FSat': return only([5, 6]);
    case 'MWFS': case 'MWFSat': return only([1, 3, 5, 6]);
    case 'Sch': flags.schoolOnly = true; return days;
    case 'NSch': flags.holidayOnly = true; return days;
    default: return days; // unknown/among connection codes (FER, CON4, T6, MR, FERT…) → no day change
  }
}

// ── Build ───────────────────────────────────────────────────────────────────
const stops = {};
const trips = [];
const stats = { files: 0, trips: 0, dropped: 0, ferryTrips: 0, fallbackStops: new Set() };

function addStop(name, region) {
  const id = slug(name);
  if (!id) return null;
  if (!stops[id]) {
    const { area, terminal, fallback } = areaFor(name, region);
    stops[id] = { id, name, area, ...(terminal ? { ferryTerminal: true } : {}) };
    if (fallback) stats.fallbackStops.add(`${name} [${region}] → ${area}`);
  }
  return id;
}

for (const file of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
  const data = JSON.parse(readFileSync(`${RAW}/${file}`, 'utf8'));
  stats.files++;
  const source = data.source;

  if (data.services) {
    // Bus file
    for (const svc of data.services) {
      const region = source;
      for (const t of svc.trips ?? []) {
        const codes = t.codes ?? [];
        let days = dayGroupDays(svc.dayGroup);
        if (!days) {
          // No printed day-group: derive from codes if possible, else assume Mon-Sat.
          days = [1, 2, 3, 4, 5, 6];
        }
        const flags = {};
        let dropped = false;
        for (const c of codes) {
          const next = applyCode(c, days, flags);
          if (next === null) { dropped = true; break; }
          days = next;
        }
        if (dropped || days.length === 0) { stats.dropped++; continue; }
        const calls = (t.calls ?? [])
          .filter((c) => /^\d{4}$/.test(c.time))
          .map((c) => ({ stop: addStop(c.stop, region), time: hhmm(c.time) }))
          .filter((c) => c.stop);
        if (calls.length < 2) { stats.dropped++; continue; }
        trips.push({
          id: `b-${slug(svc.service)}-${svc.direction ?? 'x'}-${trips.length}`,
          service: svc.service,
          mode: 'bus',
          routeLabel: `Service ${svc.service}${svc.name ? ' · ' + svc.name.replace(/\s+/g, ' ').trim() : ''}`,
          days: { days: [...new Set(days)].sort(), ...flags },
          calls,
        });
        stats.trips++;
      }
    }
  } else if (data.routes) {
    // Ferry file
    const jt = data.journeyMins ?? {};
    for (const r of data.routes) {
      const region = 'ferry';
      const fromId = addStop(r.from, region);
      const toId = addStop(r.to, region);
      if (!fromId || !toId) continue;
      const days = dayGroupDays(r.dayGroup) ?? [1, 2, 3, 4, 5, 6];
      const jmins = jt[r.route] ?? jt[Object.keys(jt).find((k) => r.route?.includes(k)) ?? ''] ?? 15;
      for (const dep of r.departures ?? []) {
        if (!/^\d{4}$/.test(dep.time)) continue;
        const flags = dep.flags ?? [];
        const bookable = flags.includes('booking');
        // Per-sailing day restrictions (e.g. FO = Friday only on the Bressay late runs).
        let depDays = days;
        if (flags.includes('FO')) depDays = depDays.filter((d) => d === 5);
        if (flags.includes('SO')) depDays = depDays.filter((d) => d === 6);
        if (depDays.length === 0) continue;
        const depM = parseInt(dep.time.slice(0, 2)) * 60 + parseInt(dep.time.slice(2));
        const arrM = (depM + jmins) % 1440;
        const arr = `${String(Math.floor(arrM / 60)).padStart(2, '0')}:${String(arrM % 60).padStart(2, '0')}`;
        trips.push({
          id: `f-${slug(r.route)}-${slug(r.from)}-${dep.time}-${trips.length}`,
          service: `${r.route} ferry`,
          mode: 'ferry',
          routeLabel: `${r.route} ferry · ${r.from} → ${r.to}`,
          days: { days: [...new Set(depDays)].sort() },
          calls: [{ stop: fromId, time: hhmm(dep.time) }, { stop: toId, time: arr }],
          ...(bookable ? { bookable: true } : {}),
        });
        stats.trips++; stats.ferryTrips++;
      }
    }
  }
}

const network = { stops, trips };
writeFileSync(OUT_APP, JSON.stringify(network));
writeFileSync(OUT_WEB, JSON.stringify(network));

// Which weekdays have any bus service, and which areas exist.
const busDays = new Set();
for (const t of trips) if (t.mode === 'bus') for (const d of t.days.days) busDays.add(d);
const areas = new Set(Object.values(stops).map((s) => s.area));

console.log(`files=${stats.files} stops=${Object.keys(stops).length} trips=${stats.trips} (ferry=${stats.ferryTrips}) dropped=${stats.dropped}`);
console.log('bus weekdays:', [...busDays].sort());
console.log('areas:', [...areas].sort());
console.log(`fallback-area stops (${stats.fallbackStops.size}):`);
for (const s of [...stats.fallbackStops].sort()) console.log('  ', s);

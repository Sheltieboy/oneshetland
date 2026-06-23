/**
 * cruise-api.ts — Cruise Visits data for the app.
 * Mirrors the web's lib/cruise-data.ts. Public reads via the shared client.
 *
 * Time handling: stored arrival/departure are timestamptz (returned as UTC).
 * The app's JSC engine can't be relied on for Intl timeZone, so we convert to
 * Shetland (Europe/London) time manually with the BST/GMT rule.
 */
import { supabase } from '@/lib/supabase';

export type Barometer = 'quiet' | 'busy' | 'very_busy' | 'peak';

export type CruiseShip = {
  id: string; name: string; slug: string | null; vessel_type: string | null;
  cruise_line: string | null; image_url: string | null;
  length_label: string | null; length_m: number | null; default_pax: number | null;
  imo: string | null; mmsi: string | null; is_large_ship: boolean;
};

export type CruiseVisit = {
  id: string; ship_id: string | null; ship_name_cache: string | null;
  arrival_at: string | null; departure_at: string | null; visit_date: string | null;
  from_location: string | null; to_location: string | null;
  berth: string | null; berth_area_group: string | null; is_tender: boolean;
  time_in_port_hours: number | null;
  est_pax: number | null; est_pax_label: string | null; est_passenger_range: string | null;
  status: string; headline_text: string | null; social_caption: string | null;
  ship: CruiseShip | null;
};

export type CruiseDay = {
  visit_date: string; ships_count: number; total_est_pax: number;
  total_footfall_score: number; max_time_in_port_hours: number | null;
  multi_ship: boolean; barometer: Barometer;
};

export const BARO: Record<Barometer, { label: string; color: string; tint: string }> = {
  quiet:     { label: 'Quiet',     color: '#1AA188', tint: 'rgba(26,161,136,0.14)' },
  busy:      { label: 'Busy',      color: '#C98A2E', tint: 'rgba(224,160,48,0.16)' },
  very_busy: { label: 'Very busy', color: '#E7825C', tint: 'rgba(231,130,92,0.16)' },
  peak:      { label: 'Peak',      color: '#C0392B', tint: 'rgba(192,57,43,0.14)' },
};
export const baro = (b?: string | null) => BARO[(b as Barometer)] ?? BARO.quiet;

/** A marquee ship photo for the section header (served from cruise-media). */
export const CRUISE_HERO =
  'https://nkrtmakxygkvxuxriiil.supabase.co/storage/v1/object/public/cruise-media/viking-neptune.webp';

export type CruiseDayRich = CruiseDay & { lead_image: string | null; lead_ship: string | null };

const VISIT_COLS =
  'id, ship_id, ship_name_cache, arrival_at, departure_at, visit_date, from_location, to_location, berth, berth_area_group, is_tender, time_in_port_hours, est_pax, est_pax_label, est_passenger_range, status, headline_text, social_caption, ship:cruise_ships(id,name,slug,vessel_type,cruise_line,image_url,length_label,length_m,default_pax,imo,mmsi,is_large_ship)';

// ── time / date helpers (no Intl dependency) ──
function ukIsBST(d: Date): boolean {
  const y = d.getUTCFullYear();
  const lastSun = (m: number) => { const x = new Date(Date.UTC(y, m + 1, 0)); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x.getUTCDate(); };
  const start = Date.UTC(y, 2, lastSun(2), 1, 0, 0);
  const end = Date.UTC(y, 9, lastSun(9), 1, 0, 0);
  const t = d.getTime();
  return t >= start && t < end;
}
export function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const local = new Date(d.getTime() + (ukIsBST(d) ? 3_600_000 : 0));
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function fmtDateLong(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function fmtDateShort(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}
export function monthLabel(month: string): string {
  const d = new Date(month + '-01T12:00:00Z');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function hoursAshore(v: { time_in_port_hours: number | null; arrival_at: string | null; departure_at: string | null }): number | null {
  if (v.time_in_port_hours) return v.time_in_port_hours;
  if (v.arrival_at && v.departure_at) return Math.round(((+new Date(v.departure_at) - +new Date(v.arrival_at)) / 3_600_000) * 10) / 10;
  return null;
}
export function trackUrl(ship?: { name: string; imo: string | null; mmsi: string | null } | null): string {
  if (!ship) return 'https://www.marinetraffic.com/';
  if (ship.mmsi) return `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}`;
  if (ship.imo) return `https://www.marinetraffic.com/en/ais/details/ships/imo:${ship.imo}`;
  return `https://www.marinetraffic.com/en/data/?asset_type=vessels&quicksearch=${encodeURIComponent(ship.name)}`;
}
export function ashorePlan(hours: number | null): string {
  if (hours != null && hours < 5) return 'Short call — keep it close: Commercial Street and the Lodberries, the Shetland Museum & Archives, and a café or knitwear shop before you head back aboard.';
  return "A full day ashore: Commercial Street and the Lodberries, the Shetland Museum & Archives, lunch at a local café, knitwear and craft shops, and the Knab clifftop walk if the weather's fair.";
}

// ── queries ──
export async function getUpcomingDays(limit = 60): Promise<CruiseDay[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase.from('cruise_day_summary').select('*').gte('visit_date', today).order('visit_date', { ascending: true }).limit(limit);
  return (data ?? []) as CruiseDay[];
}
/** Upcoming days enriched with the day's lead ship photo. */
export async function getUpcomingDaysRich(limit = 40): Promise<CruiseDayRich[]> {
  const days = await getUpcomingDays(limit);
  if (days.length === 0) return [];
  const dates = days.map((d) => d.visit_date);
  const lead: Record<string, { pax: number; img: string; name: string | null }> = {};
  const { data } = await supabase
    .from('cruise_visits')
    .select('visit_date, est_pax, ship:cruise_ships(name,image_url)')
    .in('visit_date', dates)
    .neq('status', 'cancelled');
  for (const v of (data ?? []) as unknown as { visit_date: string; est_pax: number | null; ship: { name: string | null; image_url: string | null } | null }[]) {
    const img = v.ship?.image_url;
    if (!img) continue;
    const pax = v.est_pax ?? 0;
    if (!lead[v.visit_date] || pax > lead[v.visit_date].pax) lead[v.visit_date] = { pax, img, name: v.ship?.name ?? null };
  }
  return days.map((d) => ({ ...d, lead_image: lead[d.visit_date]?.img ?? null, lead_ship: lead[d.visit_date]?.name ?? null }));
}

export async function getMonthDays(month: string): Promise<Record<string, CruiseDay>> {
  const start = `${month}-01`;
  const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  const end = d.toISOString().slice(0, 10);
  const out: Record<string, CruiseDay> = {};
  const { data } = await supabase.from('cruise_day_summary').select('*').gte('visit_date', start).lt('visit_date', end);
  for (const r of (data ?? []) as CruiseDay[]) out[r.visit_date] = r;
  return out;
}
export type CruiseHomeCard = {
  date: string; isToday: boolean; barometer: Barometer;
  ships_count: number; total_est_pax: number;
  thumbs: { id: string; name: string; image: string | null }[];
};

/** "In port today" card — today if ships are in, otherwise the next call. */
export async function getCruiseHomeCard(): Promise<CruiseHomeCard | null> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: t } = await supabase.from('cruise_day_summary').select('*').eq('visit_date', today).maybeSingle();
  let day = (t ?? null) as CruiseDay | null;
  if (!day) {
    const { data: n } = await supabase.from('cruise_day_summary').select('*').gt('visit_date', today).order('visit_date', { ascending: true }).limit(1);
    day = (n?.[0] ?? null) as CruiseDay | null;
  }
  if (!day) return null;
  const { data: vis } = await supabase
    .from('cruise_visits')
    .select('id, est_pax, ship:cruise_ships(name,image_url)')
    .eq('visit_date', day.visit_date)
    .neq('status', 'cancelled')
    .order('est_pax', { ascending: false, nullsFirst: false })
    .limit(6);
  const thumbs = ((vis ?? []) as unknown as { id: string; ship: { name: string | null; image_url: string | null } | null }[])
    .map((v) => ({ id: v.id, name: v.ship?.name ?? 'Ship', image: v.ship?.image_url ?? null }));
  return { date: day.visit_date, isToday: day.visit_date === today, barometer: day.barometer, ships_count: day.ships_count, total_est_pax: day.total_est_pax, thumbs };
}

export async function getCruiseDay(date: string): Promise<{ summary: CruiseDay | null; visits: CruiseVisit[] }> {
  const [{ data: sum }, { data: vis }] = await Promise.all([
    supabase.from('cruise_day_summary').select('*').eq('visit_date', date).maybeSingle(),
    supabase.from('cruise_visits').select(VISIT_COLS).eq('visit_date', date).neq('status', 'cancelled').order('arrival_at', { ascending: true }),
  ]);
  return { summary: (sum ?? null) as CruiseDay | null, visits: (vis ?? []) as unknown as CruiseVisit[] };
}
export async function getCruiseVisit(id: string): Promise<{ visit: CruiseVisit | null; day: CruiseDay | null }> {
  const { data } = await supabase.from('cruise_visits').select(VISIT_COLS).eq('id', id).maybeSingle();
  const visit = (data ?? null) as unknown as CruiseVisit | null;
  let day: CruiseDay | null = null;
  if (visit?.visit_date) {
    const { data: d } = await supabase.from('cruise_day_summary').select('*').eq('visit_date', visit.visit_date).maybeSingle();
    day = (d ?? null) as CruiseDay | null;
  }
  return { visit, day };
}

// ════════════════════════════════════════════════════════════════════════════
// Stats + maps (mirror of the web's cruise-stats.ts)
// ════════════════════════════════════════════════════════════════════════════

export const LERWICK: [number, number] = [60.155, -1.145];
const PORTS: Record<string, [number, number]> = {
  lerwick: LERWICK,
  aberdeen: [57.144, -2.094], invergordon: [57.69, -4.17], kirkwall: [58.985, -2.96],
  stromness: [58.96, -3.30], scrabster: [58.61, -3.55], thurso: [58.59, -3.52],
  rosyth: [56.02, -3.44], leith: [55.98, -3.17], dundee: [56.46, -2.97], greenock: [55.95, -4.76],
  liverpool: [53.41, -3.0], holyhead: [53.31, -4.63], belfast: [54.60, -5.93],
  dover: [51.13, 1.31], southampton: [50.90, -1.40],
  stornoway: [58.21, -6.39], ullapool: [57.90, -5.16], skye: [57.27, -6.21],
  'st kilda': [57.81, -8.57], hebrides: [57.76, -7.01], westray: [59.29, -2.96], orkney: [58.98, -2.96],
  bergen: [60.39, 5.32], haugesund: [59.41, 5.27], stavanger: [58.97, 5.73],
  alesund: [62.47, 6.15], maloy: [61.94, 5.11], kristiansund: [63.11, 7.73],
  olden: [61.84, 6.81], flam: [60.86, 7.11], lysefjorden: [59.0, 6.6], sojnefjord: [61.1, 6.5],
  honningsvaag: [70.98, 25.97], volda: [62.15, 6.07],
  amsterdam: [52.38, 4.90], rotterdam: [51.95, 4.14], hamburg: [53.55, 9.99],
  bremerhaven: [53.54, 8.58], copenhagen: [55.68, 12.57], aarhus: [56.15, 10.21], skagen: [57.72, 10.58],
  reykjavik: [64.15, -21.94], akureyri: [65.69, -18.10], seydisfjordur: [65.26, -14.0],
  djupivogur: [64.66, -14.28], heimaey: [63.44, -20.27],
  torshavn: [62.01, -6.77], klaksvik: [62.23, -6.59], tvoroyri: [61.55, -6.80], runavik: [62.11, -6.72], vagur: [61.47, -6.81],
  noss: [60.14, -1.02], mousa: [60.0, -1.18], foula: [60.13, -2.07], 'fair isle': [59.53, -1.63],
  'papa stour': [60.32, -1.70], baltasound: [60.75, -0.86], symbister: [60.34, -1.02], scalloway: [60.13, -1.27],
};
export function portCoord(name?: string | null): [number, number] | null {
  if (!name) return null;
  return PORTS[name.toLowerCase().trim()] ?? null;
}
export type RoutePoint = { name: string; lat: number; lng: number; kind: 'from' | 'lerwick' | 'to' };
export function routePoints(from?: string | null, to?: string | null): RoutePoint[] {
  const pts: RoutePoint[] = [];
  const f = portCoord(from);
  if (f && from) pts.push({ name: from, lat: f[0], lng: f[1], kind: 'from' });
  pts.push({ name: 'Lerwick', lat: LERWICK[0], lng: LERWICK[1], kind: 'lerwick' });
  const t = portCoord(to);
  if (t && to) pts.push({ name: to, lat: t[0], lng: t[1], kind: 'to' });
  return pts;
}

export type SeasonStats = {
  totalCalls: number; totalPax: number; distinctShips: number;
  biggestShip: { name: string; length_m: number } | null;
  peakDays: number; busiestDay: { date: string; pax: number } | null;
  byMonth: { month: string; calls: number; pax: number }[];
};
export async function getSeasonStats(): Promise<SeasonStats | null> {
  const [{ data: visits }, { data: ships }, { data: dsum }] = await Promise.all([
    supabase.from('cruise_visits').select('visit_date, est_pax, ship_id').neq('status', 'cancelled'),
    supabase.from('cruise_ships').select('name, length_m'),
    supabase.from('cruise_day_summary').select('visit_date, barometer, total_est_pax'),
  ]);
  const v = (visits ?? []) as { visit_date: string | null; est_pax: number | null; ship_id: string | null }[];
  if (v.length === 0) return null;
  const byMonthMap: Record<string, { calls: number; pax: number }> = {};
  let totalPax = 0; const shipIds = new Set<string>();
  for (const r of v) {
    totalPax += r.est_pax ?? 0;
    if (r.ship_id) shipIds.add(r.ship_id);
    const m = (r.visit_date ?? '').slice(0, 7);
    if (m) { (byMonthMap[m] ??= { calls: 0, pax: 0 }); byMonthMap[m].calls++; byMonthMap[m].pax += r.est_pax ?? 0; }
  }
  const byMonth = Object.entries(byMonthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, x]) => ({ month, ...x }));
  const shipsArr = (ships ?? []) as { name: string; length_m: number | null }[];
  const biggest = shipsArr.filter((s) => s.length_m).sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0))[0];
  const days = (dsum ?? []) as { visit_date: string; barometer: string; total_est_pax: number }[];
  const busiest = days.slice().sort((a, b) => b.total_est_pax - a.total_est_pax)[0];
  return {
    totalCalls: v.length, totalPax, distinctShips: shipIds.size,
    biggestShip: biggest ? { name: biggest.name, length_m: biggest.length_m as number } : null,
    peakDays: days.filter((d) => d.barometer === 'peak').length,
    busiestDay: busiest ? { date: busiest.visit_date, pax: busiest.total_est_pax } : null,
    byMonth,
  };
}

export type Origin = { name: string; lat: number; lng: number; count: number };
export async function getSeasonOrigins(): Promise<Origin[]> {
  const { data } = await supabase.from('cruise_visits').select('from_location').neq('status', 'cancelled');
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as { from_location: string | null }[]) {
    if (r.from_location) counts[r.from_location] = (counts[r.from_location] ?? 0) + 1;
  }
  const out: Origin[] = [];
  for (const [name, count] of Object.entries(counts)) { const c = portCoord(name); if (c) out.push({ name, lat: c[0], lng: c[1], count }); }
  return out.sort((a, b) => b.count - a.count);
}

export type OtherCall = { id: string; visit_date: string | null; est_pax: number | null };
export async function getShipOtherCalls(shipId: string, excludeVisitId: string): Promise<OtherCall[]> {
  const { data } = await supabase
    .from('cruise_visits').select('id, visit_date, est_pax')
    .eq('ship_id', shipId).neq('status', 'cancelled').order('visit_date', { ascending: true });
  return ((data ?? []) as OtherCall[]).filter((c) => c.id !== excludeVisitId);
}

// ── Time-scope selector (Season / Today / This weekend / This week) ──
export type CruiseScope = 'season' | 'today' | 'weekend' | 'week';
export const SCOPES: { key: CruiseScope; label: string }[] = [
  { key: 'season', label: 'Season' },
  { key: 'today', label: 'Today' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'week', label: 'Next 7 days' },
];

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowMon0(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}
export function scopeRange(scope: CruiseScope, today: string): { from: string; to: string; label: string } | null {
  if (scope === 'today') return { from: today, to: today, label: 'Today' };
  if (scope === 'week') {
    return { from: today, to: addDaysISO(today, 6), label: 'Next 7 days' };
  }
  if (scope === 'weekend') {
    const dow = dowMon0(today);
    if (dow === 5) return { from: today, to: addDaysISO(today, 1), label: 'This weekend' };
    if (dow === 6) return { from: today, to: today, label: 'This weekend' };
    const sat = addDaysISO(today, 5 - dow);
    return { from: sat, to: addDaysISO(sat, 1), label: 'This weekend' };
  }
  return null;
}

export type ScopeStats = {
  calls: number; pax: number; distinctShips: number;
  busiestDay: { date: string; pax: number } | null;
  firstIn: string | null; lastOut: string | null;
};
export type ScopeData = {
  daysByDate: Record<string, CruiseDayRich>;
  visits: CruiseVisit[];
  stats: ScopeStats;
  origins: Origin[];
};
export async function getScopeData(from: string, to: string): Promise<ScopeData> {
  const [{ data: sum }, { data: vis }] = await Promise.all([
    supabase.from('cruise_day_summary').select('*').gte('visit_date', from).lte('visit_date', to).order('visit_date', { ascending: true }),
    supabase.from('cruise_visits').select(VISIT_COLS).gte('visit_date', from).lte('visit_date', to).neq('status', 'cancelled').order('arrival_at', { ascending: true }),
  ]);
  const visits = (vis ?? []) as unknown as CruiseVisit[];

  const lead: Record<string, { pax: number; img: string; name: string | null }> = {};
  for (const v of visits) {
    const img = v.ship?.image_url;
    if (!img || !v.visit_date) continue;
    const pax = v.est_pax ?? 0;
    if (!lead[v.visit_date] || pax > lead[v.visit_date].pax) lead[v.visit_date] = { pax, img, name: v.ship?.name ?? null };
  }
  const days = ((sum ?? []) as CruiseDay[]).map((d) => ({ ...d, lead_image: lead[d.visit_date]?.img ?? null, lead_ship: lead[d.visit_date]?.name ?? null }));
  const daysByDate: Record<string, CruiseDayRich> = {};
  for (const d of days) daysByDate[d.visit_date] = d;

  let pax = 0; const shipIds = new Set<string>(); const arrivals: string[] = []; const departures: string[] = [];
  for (const v of visits) {
    pax += v.est_pax ?? 0;
    if (v.ship_id) shipIds.add(v.ship_id);
    if (v.arrival_at) arrivals.push(v.arrival_at);
    if (v.departure_at) departures.push(v.departure_at);
  }
  const busiest = days.slice().sort((a, b) => b.total_est_pax - a.total_est_pax)[0];
  const stats: ScopeStats = {
    calls: visits.length, pax, distinctShips: shipIds.size,
    busiestDay: busiest ? { date: busiest.visit_date, pax: busiest.total_est_pax } : null,
    firstIn: arrivals.sort()[0] ?? null, lastOut: departures.sort().slice(-1)[0] ?? null,
  };
  const counts: Record<string, number> = {};
  for (const v of visits) if (v.from_location) counts[v.from_location] = (counts[v.from_location] ?? 0) + 1;
  const origins: Origin[] = [];
  for (const [name, count] of Object.entries(counts)) { const c = portCoord(name); if (c) origins.push({ name, lat: c[0], lng: c[1], count }); }
  origins.sort((a, b) => b.count - a.count);

  return { daysByDate, visits, stats, origins };
}

/** Which focused scopes actually have ships, so empty pills can be disabled. */
export async function getScopeAvailability(today: string): Promise<Record<Exclude<CruiseScope, 'season'>, boolean>> {
  const out: Record<Exclude<CruiseScope, 'season'>, boolean> = { today: false, weekend: false, week: false };
  const horizon = scopeRange('week', today); // next 7 days covers today + weekend
  if (!horizon) return out;
  const { data } = await supabase.from('cruise_day_summary').select('visit_date').gte('visit_date', horizon.from).lte('visit_date', horizon.to);
  const set = new Set(((data ?? []) as { visit_date: string }[]).map((r) => r.visit_date));
  const has = (scope: Exclude<CruiseScope, 'season'>) => {
    const r = scopeRange(scope, today);
    return r ? datesBetween(r.from, r.to).some((d) => set.has(d)) : false;
  };
  return { today: has('today'), weekend: has('weekend'), week: has('week') };
}

/** Inclusive list of YYYY-MM-DD dates from `from` to `to`. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < 60 && cur <= to; i++) { out.push(cur); cur = addDaysISO(cur, 1); }
  return out;
}

export function londonHours(iso?: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const local = new Date(d.getTime() + (ukIsBST(d) ? 3_600_000 : 0));
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}
export function monthShort(month: string): string {
  return MONTHS[new Date(month + '-01T12:00:00Z').getUTCMonth()].slice(0, 3);
}

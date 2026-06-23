/**
 * import-cruise.mjs — WordPress/ACF cruise export → Supabase
 *
 *   cd ~/Claude/oneshetland-delivers
 *   node scripts/import-cruise.mjs cruise.csv [imagesBaseUrl]
 *
 * Expects a CSV whose headers are the ACF field names (see the SQL pivot in the
 * chat). `imagesBaseUrl` is optional — if given, ship_image filenames are
 * fetched from there (e.g. https://oldsite.com/wp-content/uploads/cruise/) and
 * uploaded to the cruise-media bucket; otherwise the filename is kept as-is.
 *
 * Reads the service-role key from ./service_key.txt and URL from ./.env.
 * Run once on empty cruise tables (there's no natural unique key on visits).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [csvPath, imagesDir, imagesUrl] = process.argv.slice(2);
if (!csvPath) { console.error('Usage: node scripts/import-cruise.mjs cruise.csv [localImagesDir] [imagesBaseUrl]'); process.exit(1); }

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const getEnv = k => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const URL = getEnv('EXPO_PUBLIC_SUPABASE_URL');
const KEY = fs.readFileSync(path.join(ROOT, 'service_key.txt'), 'utf8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.includes('PASTE_YOUR')).sort((a, b) => b.length - a.length)[0];
const projectRef = URL.match(/https:\/\/([a-z0-9]+)\./)?.[1];
const claims = (() => { try { return JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString()); } catch { return {}; } })();
if (claims.role !== 'service_role' || claims.ref !== projectRef) { console.error('✗ Service key invalid for this project. Aborting.'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'content-type': 'application/json' };

// ── tiny RFC4180-ish CSV parser (handles quotes, escaped quotes, newlines) ───
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(c => c !== '')).map(r => Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? '').trim()])));
}

// ── helpers ──
const v = s => (s == null || s === '' ? null : s);
const bool = s => /^(1|true|yes)$/i.test(String(s ?? '').trim());
const num = s => { const n = parseFloat(String(s ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const intp = s => { const n = parseInt(String(s ?? '').replace(/[^\d\-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
// UK clocks: BST from last Sun Mar 01:00 to last Sun Oct 01:00
function lastSunday(year, month0) { const d = new Date(Date.UTC(year, month0 + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getUTCDate(); }
function ukOffset(y, mo, d) { // mo 1-12
  const marchEnd = lastSunday(y, 2), octEnd = lastSunday(y, 9);
  const afterMar = (mo > 3) || (mo === 3 && d >= marchEnd);
  const beforeOct = (mo < 10) || (mo === 10 && d < octEnd);
  return (afterMar && beforeOct) ? '+01:00' : '+00:00';
}
// parse "d/m/Y H:i" (or "d/m/Y") -> ISO timestamptz string, or null
function toISO(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [_, d, mo, y, hh = '00', mm = '00'] = m;
  const Y = +y, Mo = +mo, D = +d;
  const off = ukOffset(Y, Mo, D);
  const p = n => String(n).padStart(2, '0');
  return `${Y}-${p(Mo)}-${p(D)}T${p(+hh)}:${p(+mm)}:00${off}`;
}
function dateISO(s) { const iso = toISO(s); return iso ? iso.slice(0, 10) : null; } // yyyy-mm-dd

async function rest(method, pathq, body, extraHeaders = {}) {
  const r = await fetch(`${URL}/rest/v1/${pathq}`, { method, headers: { ...H, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${pathq} -> ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

// Map the original import CSV's friendly headers -> canonical field names.
// (Falls back to the canonical name, so a pivot-query CSV also works.)
const COLS = {
  ship_name: 'Name', vessel_type: 'vessel_type', ship_image: 'ship_image',
  length: 'Length', est_pax: 'Est. Pax', est_passenger_range: 'est_passenger_range', agent: 'Agent',
  arrival_datetime: 'Arrival Date & Time', from_location: 'From',
  departure_datetime: 'Departure Date & Time', destination: 'Destination', berth: 'Berth',
  berth_area_group: 'berth_area_group', time_in_port_hours: 'time_in_port_hours',
  ships_same_day: 'ships_same_day', is_multi_ship_day: 'is_multi_ship_day',
  est_footfall_score: 'est_footfall_score', port_load_score: 'port_load_score',
  is_cruise_ship: 'is_cruise_ship', is_large_ship: 'is_large_ship', is_repeat_ship: 'is_repeat_ship',
  status: 'status', last_verified: 'last_verified', verification_source: 'verification_source',
  headline_text: 'headline_text', social_caption: 'social_caption',
};

// ── run ──
const rawRows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
const rows = rawRows.map(raw => {
  const o = {};
  for (const [canon, col] of Object.entries(COLS)) o[canon] = raw[col] ?? raw[canon] ?? null;
  return o;
});
console.log(`Parsed ${rows.length} rows from ${csvPath}`);

const shipCache = new Map(); // key -> id
async function uploadShipImage(slug, filename) {
  if (!filename) return null;
  let buf = null;
  // 1) local folder (preferred)
  if (imagesDir) {
    const fp = path.join(imagesDir, filename);
    if (fs.existsSync(fp)) buf = fs.readFileSync(fp);
  }
  // 2) live URL fallback
  if (!buf && imagesUrl) {
    try { const res = await fetch(imagesUrl.replace(/\/$/, '') + '/' + filename); if (res.ok) buf = Buffer.from(await res.arrayBuffer()); } catch {}
  }
  if (!buf) return null;
  const ext = (filename.split('.').pop() || 'webp').toLowerCase();
  const key = `${slug}.${ext}`;
  const up = await fetch(`${URL}/storage/v1/object/cruise-media/${key}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'content-type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext), 'x-upsert': 'true' },
    body: buf,
  });
  if (up.status !== 200) return null;
  return `${URL}/storage/v1/object/public/cruise-media/${key}`;
}
async function ensureShip(r) {
  const name = v(r.ship_name) || v(r.post_title) || 'Unknown vessel';
  const key = (v(r.imo) || name).toLowerCase();
  if (shipCache.has(key)) return shipCache.get(key);
  const slug = slugify(name);
  const image_url = await uploadShipImage(slug, v(r.ship_image)) || v(r.ship_image);
  const ship = {
    name, slug, vessel_type: v(r.vessel_type), cruise_line: v(r.cruise_line),
    image_url, length_label: v(r.length), length_m: num(r.length),
    default_pax: intp(r.est_pax), imo: v(r.imo), mmsi: v(r.mmsi),
    is_large_ship: bool(r.is_large_ship),
  };
  // upsert on slug so re-runs reuse the same ship
  const out = await rest('POST', 'cruise_ships?on_conflict=slug', ship,
    { Prefer: 'resolution=merge-duplicates,return=representation' });
  const id = out?.[0]?.id;
  shipCache.set(key, id);
  return id;
}

let ok = 0, fail = 0; const dates = new Set();
for (const r of rows) {
  try {
    const ship_id = await ensureShip(r);
    const arrival_at = toISO(r.arrival_datetime);
    const departure_at = toISO(r.departure_datetime);
    const estPaxNum = intp(r.est_pax);
    const visit = {
      ship_id, ship_name_cache: v(r.ship_name) || v(r.post_title),
      arrival_at, departure_at,
      from_location: v(r.from_location), to_location: v(r.destination),
      berth: v(r.berth), berth_area_group: v(r.berth_area_group),
      time_in_port_hours: num(r.time_in_port_hours),
      est_pax: estPaxNum,
      est_pax_label: (v(r.est_pax) && estPaxNum == null) ? v(r.est_pax) : null,
      est_passenger_range: v(r.est_passenger_range),
      ships_same_day: intp(r.ships_same_day),
      is_multi_ship_day: bool(r.is_multi_ship_day),
      est_footfall_score: intp(r.est_footfall_score),
      port_load_score: intp(r.port_load_score),
      is_cruise_ship: r.is_cruise_ship === undefined ? true : bool(r.is_cruise_ship),
      is_repeat_ship: bool(r.is_repeat_ship),
      status: v(r.status) || 'scheduled',
      last_verified: dateISO(r.last_verified),
      verification_source: v(r.verification_source),
      agent: v(r.agent),
      headline_text: v(r.headline_text), social_caption: v(r.social_caption),
    };
    // upsert on (ship_id, arrival_at) so re-running never duplicates
    await rest('POST', 'cruise_visits?on_conflict=ship_id,arrival_at', visit, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (arrival_at) dates.add(arrival_at.slice(0, 10));
    ok++;
  } catch (e) { fail++; console.log('  ✗', r.ship_name || r.post_title, '—', e.message); }
}

// recompute same-day counts / multi-ship flags per date
for (const d of dates) {
  try { await rest('POST', 'rpc/recompute_cruise_day', { target: d }); } catch (e) { console.log('  recompute', d, e.message); }
}

console.log(`\nDone. Visits imported: ${ok} | failed: ${fail} | ships: ${shipCache.size} | days recomputed: ${dates.size}`);
console.log('When finished with imports, delete service_key.txt.');

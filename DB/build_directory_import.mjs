#!/usr/bin/env node
/**
 * build_directory_import.mjs
 *
 * Turns the first-party Shetland businesses CSV into a Supabase import
 * (DB/import_directory.sql) of *unclaimed* directory listings.
 *
 * Seeding model (see migration 062):
 *   - source = 'csv', is_claimed = false, owner_id = NULL, is_verified = false
 *   - name + description come from the CSV (ours — no ToS issue)
 *   - lat/lng + place_id come from a ONE-TIME Google Places lookup, IF a key is
 *     provided. place_id is the only Places field we're allowed to store
 *     indefinitely; we store coords purely to drop a map pin.
 *
 * Usage:
 *   # names + descriptions only (no Google):
 *   node DB/build_directory_import.mjs
 *
 *   # with one-time geocode (place_id + lat/lng):
 *   GOOGLE_MAPS_API_KEY=xxxx node DB/build_directory_import.mjs
 *
 * Then run DB/import_directory.sql against the database.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = process.env.CSV_PATH ||
  '/Users/darrenfullerton/Documents/Darrenfullerton.com/Websites/OneShetland/build/wordpress/Data-dump/Shetland-service.csv.csv';
const OUT_PATH = join(__dirname, 'import_directory.sql');
const API_KEY  = process.env.GOOGLE_MAPS_API_KEY || '';

// ── Minimal CSV parser (handles quoted fields + embedded commas/quotes) ────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Fix mojibake from the WordPress export (√© etc.) ───────────────────────────
const MOJIBAKE = [
  ['n√©e gibson architects', 'Née Gibson Architects'],
  ['The Harbour Caf√©', 'The Harbour Café'],
  ['√©', 'é'], ['√®', 'è'], ['√§', 'ä'], ['√∂', 'ö'], ['√º', 'ü'],
];
function fixText(s) {
  let out = (s ?? '').trim();
  for (const [bad, good] of MOJIBAKE) out = out.split(bad).join(good);
  return out;
}

// ── Category guesser from name + description ───────────────────────────────────
const CATEGORY_RULES = [
  ['food_drink',    /caf[eé]|restaurant|takeaway|chippy|chip shop|coffee|bar\b|kitchen|bakery|juice|food|cuisine|larder|dining|baking/i],
  ['accommodation', /hotel|guest house|guesthouse|b&b|bed and breakfast|accommodation|lets|rooms/i],
  ['tourism',       /tour|visitor|heritage|historic|museum|adventure|attraction|wool adventures/i],
  ['services',      /salon|beauty|hair|barber|therap|counsel|dental|optometr|accountan|solicitor|legal|engineer|architect|survey|consult|finance|insurance|marketing|web|software|app|cleaning|repair|garage|hire|funeral|estate agent|letting|bank|post office|telecom|broadband|fuel|transport|taxi|net mending|massage|wellbeing|tattoo|nails/i],
  ['retail',        /shop|store|retail|jewell|knitwear|wool|clothing|footwear|shoes|gift|craft|book|camera|music|diy|hardware|department|pharmacy|chemist|florist|newsagent|off licence|soap|sportswear|instruments/i],
];
function guessCategory(name, desc) {
  const hay = `${name} ${desc}`;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return 'other';
}

// ── Slug ───────────────────────────────────────────────────────────────────────
function slugify(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── SQL string escaping ────────────────────────────────────────────────────────
const sql = (v) => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const num = (v) => (v == null || Number.isNaN(v)) ? 'NULL' : String(v);

// ── Google Places Text Search (one-time; place_id + lat/lng only) ──────────────
async function geocode(name) {
  if (!API_KEY) return null;
  const q = encodeURIComponent(`${name}, Shetland, UK`);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&region=uk&key=${API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const hit = data.results?.[0];
    if (!hit) return null;
    return {
      place_id: hit.place_id ?? null,
      lat: hit.geometry?.location?.lat ?? null,
      lng: hit.geometry?.location?.lng ?? null,
    };
  } catch (e) {
    console.warn(`  geocode failed for "${name}": ${e.message}`);
    return null;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ───────────────────────────────────────────────────────────────────────
const raw = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(raw);
const header = rows.shift(); // Company, Description
console.log(`Parsed ${rows.length} rows (header: ${header.join(', ')})`);

const seen = new Set();
const records = [];
for (const r of rows) {
  const name = fixText(r[0]);
  if (!name) continue;
  let desc = fixText(r[1]);
  if (desc === '#N/A' || desc === '') desc = null;

  let slug = slugify(name);
  let s = slug, n = 2;
  while (seen.has(s)) s = `${slug}-${n++}`;
  seen.add(s);

  records.push({ name, description: desc, category: guessCategory(name, desc || ''), slug: s });
}
console.log(`Cleaned to ${records.length} businesses`);

if (API_KEY) {
  console.log('Geocoding via Google Places (one-time place_id + lat/lng)…');
  for (const rec of records) {
    const g = await geocode(rec.name);
    if (g) { rec.place_id = g.place_id; rec.lat = g.lat; rec.lng = g.lng; }
    process.stdout.write(g ? '.' : 'x');
    await sleep(120); // be gentle on the API
  }
  process.stdout.write('\n');
} else {
  console.log('No GOOGLE_MAPS_API_KEY — emitting names/descriptions only (lat/lng NULL).');
}

// ── Emit SQL ───────────────────────────────────────────────────────────────────
const lines = [];
lines.push('-- import_directory.sql  (generated by DB/build_directory_import.mjs)');
lines.push('-- Seeds the Directory with first-party Shetland businesses as UNCLAIMED listings.');
lines.push('-- Idempotent on slug: re-running updates name/description/category, never clobbers');
lines.push('-- a listing once it has been claimed (owner_id set).');
lines.push('BEGIN;');
lines.push('');
for (const r of records) {
  lines.push(
    `INSERT INTO public.local_businesses (name, description, category, slug, address, source, is_claimed, is_verified, is_active, owner_id, place_id, lat, lng)`
  );
  lines.push(
    `VALUES (${sql(r.name)}, ${sql(r.description)}, ${sql(r.category)}, ${sql(r.slug)}, ${sql('Shetland')}, 'csv', false, false, true, NULL, ${sql(r.place_id ?? null)}, ${num(r.lat ?? null)}, ${num(r.lng ?? null)})`
  );
  lines.push(
    `ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = COALESCE(EXCLUDED.description, public.local_businesses.description), category = EXCLUDED.category` +
    `, place_id = COALESCE(public.local_businesses.place_id, EXCLUDED.place_id)` +
    `, lat = COALESCE(public.local_businesses.lat, EXCLUDED.lat), lng = COALESCE(public.local_businesses.lng, EXCLUDED.lng)` +
    ` WHERE public.local_businesses.owner_id IS NULL;`
  );
  lines.push('');
}
lines.push('COMMIT;');

writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`Wrote ${OUT_PATH} (${records.length} businesses)`);

/**
 * generate-logos.mjs — OneShetland business logos
 *
 * Run from the app root:
 *     cd ~/Claude/oneshetland-delivers
 *     node scripts/generate-logos.mjs
 *
 * Requires: Google Chrome (for monogram text rendering), ffmpeg (for resizing
 * real logos), the service-role key in ./service_key.txt (gitignored), and the
 * project URL in ./.env.
 *
 *   1. CURATED   — real logos for verified businesses (ffmpeg resize, overwrite).
 *   2. MONOGRAMS — clean serif-initial tile (rendered by headless Chrome) for
 *      every business still without a logo.
 *
 * Safe to re-run: monograms only fill logo_url that is null, so a real logo
 * (yours or an owner's) is never clobbered. Verifies the key belongs to the
 * OneShetland project before writing anything.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = path.join(ROOT, '..', 'oneshetland-web', 'public', 'brand', '_build', 'playfair.ttf');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oslogo-'));

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const getEnv = k => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const URL = getEnv('EXPO_PUBLIC_SUPABASE_URL');
const KEY = fs.readFileSync(path.join(ROOT, 'service_key.txt'), 'utf8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.includes('PASTE_YOUR'))
  .sort((a, b) => b.length - a.length)[0];
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

// ── Safety checks ─────────────────────────────────────────────────────────────
const projectRef = URL.match(/https:\/\/([a-z0-9]+)\./)?.[1];
const claims = (() => { try { return JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString()); } catch { return {}; } })();
if (claims.role !== 'service_role' || claims.ref !== projectRef) {
  console.error(`✗ Key check failed (role=${claims.role}, ref=${claims.ref}, project=${projectRef}). Aborting.`); process.exit(1);
}
if (!fs.existsSync(FONT)) { console.error('✗ Font not found at', FONT); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error('✗ Chrome not found at', CHROME); process.exit(1); }
const FONT_B64 = fs.readFileSync(FONT).toString('base64');

// ── Curated real logos (verified direct image URLs). Extend as we vet more. ───
const CURATED = {
  'jamiesons of shetland': 'https://www.jamiesonsofshetland.co.uk/cdn/shop/files/newlogo.png?width=512',
  'shetland soap':         'https://shetlandsoap.co.uk/cdn/shop/files/Soap-Logo-02.png?width=512',
};

const PAL = ['0B5E86', '3E63B0', '19B3A6', 'D79A3B', 'E7825C', '8F5AA8'];
const STOP = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'to', 'ltd', 'llp']);
function initials(name) {
  const n = name.replace(/^the\s+/i, '').trim();
  const w = n.split(/[\s&\-.,()]+/).filter(x => x && !STOP.has(x.toLowerCase()));
  const i = w.length >= 2 ? (w[0][0] + w[1][0]) : (w[0] || n).slice(0, 1);
  return (i.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'S').slice(0, 2);
}
function colour(b) {
  if (b.brand_color && /^#?[0-9a-fA-F]{6}$/.test(b.brand_color)) return b.brand_color.replace('#', '');
  let h = 0; for (const c of b.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PAL[h % PAL.length];
}
function monogramPng(b, outPng) {
  const ini = initials(b.name), hex = colour(b), fz = ini.length >= 2 ? 220 : 300;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:PF;src:url('data:font/ttf;base64,${FONT_B64}') format('truetype');}
html,body{margin:0;padding:0}
.t{width:512px;height:512px;background:#${hex};display:flex;align-items:center;justify-content:center;
   font-family:PF,serif;color:#fff;font-size:${fz}px;font-weight:600;letter-spacing:1px}
</style></head><body><div class="t">${ini}</div></body></html>`;
  const htmlF = path.join(TMP, b.id + '.html');
  fs.writeFileSync(htmlF, html);
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=512,512',
    '--screenshot=' + outPng, 'file://' + htmlF], { stdio: 'ignore' });
}
async function uploadAndSet(biz, pngPath, prefix) {
  const storagePath = `${biz.id}/logo/${prefix}-${crypto.randomUUID()}.png`;
  const up = await fetch(`${URL}/storage/v1/object/business-media/${storagePath}`, {
    method: 'POST', headers: { ...H, 'content-type': 'image/png', 'x-upsert': 'true' },
    body: fs.readFileSync(pngPath),
  });
  if (up.status !== 200) throw new Error('upload ' + up.status + ' ' + await up.text());
  const pub = `${URL}/storage/v1/object/public/business-media/${storagePath}`;
  const pa = await fetch(`${URL}/rest/v1/local_businesses?id=eq.${biz.id}`, {
    method: 'PATCH', headers: { ...H, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ logo_url: pub }),
  });
  if (pa.status !== 204) throw new Error('patch ' + pa.status);
}

const all = await (await fetch(`${URL}/rest/v1/local_businesses?select=id,name,brand_color,logo_url&limit=2000`, { headers: H })).json();
console.log(`Loaded ${all.length} businesses.`);

// 1) Curated real logos (ffmpeg resize works without freetype)
let curated = 0;
for (const b of all) {
  const key = Object.keys(CURATED).find(k => b.name.toLowerCase().includes(k));
  if (!key) continue;
  try {
    const r = await fetch(CURATED[key], { headers: { 'user-agent': 'Mozilla/5.0' } });
    const src = path.join(TMP, b.id + '_src'); fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
    const out = path.join(TMP, b.id + '.png');
    execFileSync('ffmpeg', ['-y', '-i', src, '-vf',
      'scale=460:460:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',
      '-frames:v', '1', out], { stdio: 'ignore' });
    await uploadAndSet(b, out, 'logo');
    curated++; console.log('  ✓ real logo:', b.name);
  } catch (e) { console.log('  ✗ curated failed:', b.name, e.message); }
}

// 2) Monograms (headless Chrome)
const todo = all.filter(b => !b.logo_url && !Object.keys(CURATED).some(k => b.name.toLowerCase().includes(k)));
console.log(`\nGenerating ${todo.length} monograms via Chrome…`);
let ok = 0, fail = 0;
for (const b of todo) {
  const out = path.join(TMP, b.id + '.png');
  try { monogramPng(b, out); await uploadAndSet(b, out, 'monogram'); ok++; if (ok % 20 === 0) console.log(`  …${ok}`); }
  catch (e) { fail++; console.log('  ✗', b.name, e.message); }
}
console.log(`\nDone. Real logos: ${curated} | monograms: ${ok} | failed: ${fail}`);
console.log('When finished, delete service_key.txt.');

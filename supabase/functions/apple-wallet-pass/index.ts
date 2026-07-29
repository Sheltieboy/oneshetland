// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import forge from 'npm:node-forge@1.3.1';
import { zipSync, zlibSync } from 'npm:fflate@0.8.2';

/**
 * apple-wallet-pass — generates a signed .pkpass for the caller's loyalty card.
 *
 * PUBLIC identifiers (safe to keep in code):
 *   Pass Type ID : pass.com.oneshetland.app
 *   Team ID      : 4D33WNWW9F
 *
 * SECRETS (set with `supabase secrets set …`, never committed):
 *   APPLE_PASS_CERT_P12_BASE64  — base64 of your pass_certificate.p12
 *   APPLE_PASS_CERT_PASSWORD    — the .p12 export password
 *   APPLE_WWDR_PEM              — Apple WWDR G4 certificate, PEM text
 *
 * Call: GET|POST with `card_id` (query param or JSON body) + the user's JWT in
 * Authorization. Returns the .pkpass (application/vnd.apple.pkpass). Add `debug=1`
 * to get a plain-text error instead of a generic 500 while wiring it up.
 */

const PASS_TYPE_ID = 'pass.com.oneshetland.app';
const TEAM_ID = '4D33WNWW9F';
const ORG = 'OneShetland';
const BG = 'rgb(124, 58, 237)';   // OneShetland local purple

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalizeTiers(raw: unknown): { stamps: number; reward: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => ({ stamps: Number(t?.stamps), reward: String(t?.reward ?? '') }))
    .filter((t) => Number.isFinite(t.stamps) && t.stamps > 0)
    .sort((a, b) => a.stamps - b.stamps);
}

// ── Minimal solid-colour PNG (Apple requires icon.png; artwork can improve later) ──
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0); body.set(data, typeBytes.length);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc32(body));
  return out;
}
function solidPng(size: number, r: number, g: number, b: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour type 2 (RGB)
  const stride = size * 3;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = zlibSync(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const bin = (u: Uint8Array): string => forge.util.binary.raw.encode(u);
const unbin = (s: string): Uint8Array => forge.util.binary.raw.decode(s);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const url = new URL(req.url);
  const debug = url.searchParams.get('debug') === '1';
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    // The single member card — its QR carries the member_code that any shop's
    // till scans. One pass per person, works everywhere.
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: memberCode, error: mcErr } = await svc.rpc('ensure_member_code', { p_user: user.id });
    if (mcErr || !memberCode) return json({ error: 'Could not load your member code' }, 500);
    const { data: prof } = await svc.from('profiles').select('display_name, full_name').eq('id', user.id).maybeSingle();
    const memberName = prof?.display_name || prof?.full_name || 'Member';

    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      organizationName: ORG,
      description: 'OneShetland loyalty card',
      serialNumber: `member-${memberCode}`,
      backgroundColor: BG,
      foregroundColor: 'rgb(255,255,255)',
      labelColor: 'rgb(255,255,255)',
      logoText: 'Shop Local Shetland',
      barcodes: [{ format: 'PKBarcodeFormatQR', message: String(memberCode), messageEncoding: 'iso-8859-1', altText: String(memberCode) }],
      storeCard: {
        primaryFields: [{ key: 'member', label: 'MEMBER', value: memberName }],
        secondaryFields: [{ key: 'code', label: 'CODE', value: String(memberCode) }],
        auxiliaryFields: [{ key: 'hint', label: '', value: 'Show at any Shetland shop' }],
      },
    };

    // ── Assemble + sign the bundle ──────────────────────────────────────────
    const icon = solidPng(58, 124, 58, 237);
    const icon2x = solidPng(116, 124, 58, 237);
    const logo = solidPng(160, 124, 58, 237);
    const passBytes = new TextEncoder().encode(JSON.stringify(passJson));
    const files: Record<string, Uint8Array> = {
      'pass.json': passBytes, 'icon.png': icon, 'icon@2x.png': icon2x, 'logo.png': logo,
    };

    const manifest: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
      manifest[name] = forge.md.sha1.create().update(bin(bytes)).digest().toHex();
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

    const p12b64 = Deno.env.get('APPLE_PASS_CERT_P12_BASE64');
    const p12pass = Deno.env.get('APPLE_PASS_CERT_PASSWORD') ?? '';
    const wwdrPem = Deno.env.get('APPLE_WWDR_PEM');
    if (!p12b64 || !wwdrPem) return json({ error: 'Signing secrets not configured' }, 500);

    const p12Asn1 = forge.asn1.fromDer(forge.util.decode64(p12b64));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, p12pass);
    const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
      ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
    const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
    if (!keyBag?.key || !certBag?.cert) return json({ error: 'Could not read certificate/key from .p12' }, 500);
    // APPLE_WWDR_PEM may hold one OR several WWDR intermediates. Apple pass
    // signing needs the RSA intermediate (G4); newer ECDSA ones (e.g. G6) can't
    // be parsed by forge, so skip any that fail rather than aborting.
    const wwdrCerts = (wwdrPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [])
      .map((block) => { try { return forge.pki.certificateFromPem(block); } catch { return null; } })
      .filter((c): c is ReturnType<typeof forge.pki.certificateFromPem> => c !== null);
    if (wwdrCerts.length === 0) return json({ error: 'No usable (RSA) WWDR certificate — use the WWDR G4 cert' }, 500);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(bin(manifestBytes));
    p7.addCertificate(certBag.cert);
    for (const c of wwdrCerts) p7.addCertificate(c);
    p7.addSigner({
      key: keyBag.key,
      certificate: certBag.cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date().toString() },
      ],
    });
    p7.sign({ detached: true });
    const signature = unbin(forge.asn1.toDer(p7.toAsn1()).getBytes());

    const pkpass = zipSync({
      'pass.json': passBytes,
      'manifest.json': manifestBytes,
      'signature': signature,
      'icon.png': icon,
      'icon@2x.png': icon2x,
      'logo.png': logo,
    });

    return new Response(pkpass, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': 'attachment; filename="oneshetland.pkpass"',
      },
    });
  } catch (err) {
    console.error('[apple-wallet-pass]', err);
    return json({ error: 'Could not generate pass' }, 500);
  }
});

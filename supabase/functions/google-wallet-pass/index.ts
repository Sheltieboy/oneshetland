// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

/**
 * google-wallet-pass — returns a "Save to Google Wallet" link for the caller's
 * loyalty card. Google Wallet has no file: we sign a JWT (RS256) with the
 * service-account key that embeds the loyalty class + object, and the client
 * opens https://pay.google.com/gp/v/save/<jwt>.
 *
 * PUBLIC (safe in code):
 *   Issuer ID : 338800000023174515
 * SECRET (set with `supabase secrets set`, never committed):
 *   GOOGLE_WALLET_SA_JSON — the full service-account JSON key (client_email + private_key)
 *
 * Call: GET|POST with `card_id` + the user's JWT in Authorization.
 * Returns { saveUrl }. Add `debug=1` for a plain-text error while wiring up.
 */

const ISSUER_ID = '338800000023174515';
const ORG = 'OneShetland';
const BG = '#7c3aed';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const b64url = (bytes: Uint8Array): string => {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlStr = (str: string): string => b64url(new TextEncoder().encode(str));

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function normalizeTiers(raw: unknown): { stamps: number; reward: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => ({ stamps: Number(t?.stamps), reward: String(t?.reward ?? '') }))
    .filter((t) => Number.isFinite(t.stamps) && t.stamps > 0)
    .sort((a, b) => a.stamps - b.stamps);
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

    // The single member card — its QR carries the member_code every shop scans.
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: memberCode, error: mcErr } = await svc.rpc('ensure_member_code', { p_user: user.id });
    if (mcErr || !memberCode) return json({ error: 'Could not load your member code' }, 500);
    const { data: prof } = await svc.from('profiles').select('display_name, full_name').eq('id', user.id).maybeSingle();
    const memberName = prof?.display_name || prof?.full_name || 'OneShetland member';

    const suffix = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '');
    const classId = `${ISSUER_ID}.member`;
    const objectId = `${ISSUER_ID}.member_${suffix(user.id)}`;

    const loyaltyClass: Record<string, unknown> = {
      id: classId,
      issuerName: ORG,
      programName: 'Shop Local Shetland',
      reviewStatus: 'UNDER_REVIEW',
      hexBackgroundColor: BG,
    };

    const loyaltyObject = {
      id: objectId,
      classId,
      state: 'ACTIVE',
      accountName: memberName,
      accountId: String(memberCode),
      barcode: { type: 'QR_CODE', value: String(memberCode), alternateText: String(memberCode) },
      textModulesData: [{ header: 'Your card', body: 'Show at any taking-part Shetland shop to collect or redeem.' }],
      hexBackgroundColor: BG,
    };

    // ── Sign the Save-to-Wallet JWT (RS256) with the service account key ──────
    const saJsonStr = Deno.env.get('GOOGLE_WALLET_SA_JSON');
    if (!saJsonStr) return json({ error: 'Google Wallet secret not configured' }, 500);
    const sa = JSON.parse(saJsonStr);

    const claims = {
      iss: sa.client_email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: ['https://oneshetland.netlify.app'],
      payload: { loyaltyClasses: [loyaltyClass], loyaltyObjects: [loyaltyObject] },
    };
    const header = { alg: 'RS256', typ: 'JWT' };
    const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;

    const key = await crypto.subtle.importKey(
      'pkcs8', pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput)));
    const jwt = `${signingInput}.${b64url(sig)}`;

    return json({ saveUrl: `https://pay.google.com/gp/v/save/${jwt}` });
  } catch (err) {
    console.error('[google-wallet-pass]', err);
    const msg = safeError('google-wallet-pass', err);
    return json({ error: debug ? msg : 'Could not create pass' }, 500);
  }
});

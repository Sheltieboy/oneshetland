/**
 * funeral-enquiry.ts — the trusted entry point for the ANONYMOUS "Contact us about this announcement" form.
 *
 * WHY THIS EXISTS
 * The database function submit_funeral_enquiry used to be callable by `anon` straight through PostgREST. Everything on the web page (the honeypot, the
 * validation) could be skipped by a script, and the only protection was a shared quota (3 per announcement per day, 20 per hour for the whole site), which
 * let one script block every genuine family. Now the function is service-role only and THIS is the only way in:
 *
 *   browser → handleFuneralEnquiry → (1) origin check  (2) validate  (3) trusted client key  (4) cheap per-client attempt cap
 *           → (5) Turnstile verified SERVER-SIDE (Cloudflare siteverify; hostname, action, announcement bound; single use)
 *           → (6) per-client limits, then the shared limits (a client is stopped by its OWN allowance before it can spend a shared one)
 *           → (7) submit_funeral_enquiry (service role) → staff review queue as before.
 *
 * Everything outside the handler (environment, fetch) is injected so the SAME code runs in the Edge Function and in the local tests, where Cloudflare is a
 * mock and Supabase is the isolated acceptance backend. Nothing here ever calls Cloudflare or Supabase except through `deps.fetch`.
 *
 * PRIVACY: the client's address is never stored. It is turned into a keyed hash (HMAC-SHA-256 with a secret salt, truncated) used only as a rate-limit
 * subject; those rows hold a hash and a counter and are purged by the existing purge_rate_limits job after 2 days. Message and contact are passed to the
 * database function and are never logged. Failures are logged by CODE only.
 */
import { verifyTurnstile, type TurnstileFailure } from './turnstile-verify.ts';

export const ENQUIRY_ACTION = 'funeral-enquiry';           // the Turnstile widget's declared action for this form
const KINDS = new Set(['correction', 'takedown', 'enquiry']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Names of the rate_limit_policies rows (ceilings live in the DATABASE, migration 20261129070000, not here). */
export const LIMITS = {
  attempt: 'funeral_enquiry_ip_attempt',              // any request from a client, including failed verification
  ipHour: 'funeral_enquiry_ip_hour',
  ipDay: 'funeral_enquiry_ip_day',
  ipAnnouncement: 'funeral_enquiry_ip_announcement',
  announcement: 'funeral_enquiry_announcement',        // shared, but only reachable by clients that passed their own limits
  global: 'funeral_enquiry_global',                    // circuit breaker, not a per-family quota
} as const;

export interface EnquiryDeps {
  env: (key: string) => string | undefined;
  fetch: typeof fetch;
  now?: () => number;
}

const MESSAGES: Record<string, string> = {
  invalid_input: 'Please check the form and try again.',
  verification_required: 'Please complete the security check and try again.',
  verification_failed: 'The security check did not pass. Please try again.',
  verification_expired: 'The security check has expired. Please complete it again and send.',
  verification_unavailable: 'We could not complete the security check just now. Your message has not been sent. Please try again in a few minutes, or contact us by telephone.',
  rate_limited: 'There have been a lot of requests from your connection. Please wait a while and try again, or contact us by telephone.',
  unknown_notice: 'We could not find that announcement. It may have been taken down.',
  forbidden: 'This request is not allowed.',
  unavailable: 'We could not send your message just now. Please try again in a few minutes, or contact us by telephone.',
};

const VERIFY_CODE: Record<TurnstileFailure, [number, string]> = {
  missing: [400, 'verification_required'],
  invalid: [400, 'verification_failed'],
  expired_or_reused: [400, 'verification_expired'],
  wrong_hostname: [400, 'verification_failed'],
  wrong_action: [400, 'verification_failed'],
  wrong_cdata: [400, 'verification_failed'],
  stale: [400, 'verification_expired'],
  unavailable: [503, 'verification_unavailable'],
};

function expandV6(s: string): string[] | null {
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  let parts: string[];
  if (dbl >= 0) {
    const head = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
    const tail = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  } else parts = s.split(':');
  return parts.length === 8 && parts.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? parts : null;
}

/** A client is keyed by its IPv4 address, or by the /64 of an IPv6 address (one home can rotate the rest of the address at will). */
export function normaliseIp(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => Number(p) <= 255)) return s;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return normaliseIp(mapped[1]);
  const v6 = expandV6(s);
  return v6 ? `${v6.slice(0, 4).map((x) => x.padStart(4, '0')).join(':')}::/64` : null;
}

/** Trusted address: Supabase's edge sits behind Cloudflare, which sets cf-connecting-ip and cannot be overridden by the caller. The LAST entry of
 *  x-forwarded-for (added by the nearest proxy) is the fallback; the first entry is client-supplied and is never used. */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) { const parts = xff.split(',').map((p) => p.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
  return null;
}

async function hmacKey(salt: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function handleFuneralEnquiry(req: Request, deps: EnquiryDeps): Promise<Response> {
  const allowedOrigins = (deps.env('FUNERAL_ENQUIRY_ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const origin = req.headers.get('origin') ?? '';
  const cors: Record<string, string> = allowedOrigins.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' }
    : { Vary: 'Origin' };
  const reply = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, error: code, message: MESSAGES[code] ?? MESSAGES.unavailable, ...extra }),
      { status, headers: { ...cors, ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const log = (code: string) => console.warn(`[submit-funeral-enquiry] ${code}`);

  // Fail closed on any missing configuration: nothing is accepted by a half-configured function.
  const secret = deps.env('TURNSTILE_SECRET_KEY'), salt = deps.env('FUNERAL_ENQUIRY_IP_SALT');
  const hostnames = (deps.env('TURNSTILE_ALLOWED_HOSTNAMES') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const supaUrl = deps.env('SUPABASE_URL'), serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !salt || !hostnames.length || !allowedOrigins.length || !supaUrl || !serviceKey) { log('not_configured'); return reply(503, 'unavailable'); }

  if (req.method === 'OPTIONS') return allowedOrigins.includes(origin) ? new Response(null, { status: 204, headers: cors }) : reply(403, 'forbidden');
  if (req.method !== 'POST') return reply(405, 'forbidden');
  if (!allowedOrigins.includes(origin)) { log('origin_refused'); return reply(403, 'forbidden'); }

  const raw = await req.text().catch(() => '');
  if (raw.length === 0 || raw.length > 8192) return reply(raw.length > 8192 ? 413 : 400, 'invalid_input');
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('shape'); } catch { return reply(400, 'invalid_input'); }

  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
  const id = typeof b.announcement_id === 'string' && UUID.test(b.announcement_id) ? b.announcement_id.toLowerCase() : null;
  const kind = typeof b.kind === 'string' && KINDS.has(b.kind) ? b.kind : null;
  const message = str(b.message, 1000), contact = str(b.contact, 200);
  const name = b.contact_name == null || b.contact_name === '' ? '' : str(b.contact_name, 120);
  const relationship = b.relationship == null || b.relationship === '' ? '' : str(b.relationship, 120);
  if (!id || !kind || message === null || message.length < 5 || contact === null || contact.length < 5 || name === null || relationship === null) return reply(400, 'invalid_input');

  // A bot that fills the hidden field is told it worked and nothing is stored or verified (the same behaviour as the page).
  if (typeof b.website === 'string' && b.website.trim() !== '') return reply(200, 'ok');

  const rawIp = clientIp(req);
  const ip = rawIp ? normaliseIp(rawIp) : null;
  if (!rawIp || !ip) { log('no_client_address'); return reply(400, 'verification_failed'); }   // cannot rate-limit what we cannot identify: refuse
  const key = await hmacKey(salt, ip);

  const claim = async (subject: string, actions: string[]): Promise<{ allowed: boolean; retry: number } | null> => {
    try {
      const res = await deps.fetch(`${supaUrl}/rest/v1/rpc/claim_rate_limits`, {
        method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_subject: subject, p_actions: actions }),
      });
      if (!res.ok) return null;
      const rows = await res.json() as { allowed: boolean; retry_after_secs: number }[];
      const v = Array.isArray(rows) ? rows[0] : undefined;
      return v ? { allowed: v.allowed, retry: Math.max(1, v.retry_after_secs || 60) } : null;
    } catch { return null; }
  };
  const limited = (c: { retry: number }) => reply(429, 'rate_limited', { retry_after: c.retry }, { 'Retry-After': String(c.retry) });

  // (4) Cheap cap per client BEFORE we spend a Cloudflare call, so failed/garbage attempts from one address cannot be unlimited.
  const attempt = await claim(`ip:${key}`, [LIMITS.attempt]);
  if (!attempt) { log('limiter_unavailable'); return reply(503, 'unavailable'); }
  if (!attempt.allowed) { log('attempt_limited'); return limited(attempt); }

  // (5) The token, verified by Cloudflare from here. Bound to this form (action), this site (hostname) and this announcement (cData).
  const v = await verifyTurnstile({
    secret, token: b.turnstile_token, remoteIp: rawIp, expectedAction: ENQUIRY_ACTION, expectedCData: id,
    allowedHostnames: hostnames, fetchImpl: deps.fetch, now: deps.now,
  });
  if (!v.ok) { log(`verify_${v.code}`); const [status, code] = VERIFY_CODE[v.code]; return reply(status, code); }

  // (6) Per-client allowances first (they protect the shared ones), then the shared announcement allowance, then the site-wide breaker.
  for (const [subject, actions] of [
    [`ip:${key}`, [LIMITS.ipHour, LIMITS.ipDay]],
    [`ipa:${key}:${id}`, [LIMITS.ipAnnouncement]],
    [`ann:${id}`, [LIMITS.announcement]],
    ['global', [LIMITS.global]],
  ] as [string, string[]][]) {
    const c = await claim(subject, actions);
    if (!c) { log('limiter_unavailable'); return reply(503, 'unavailable'); }
    if (!c.allowed) { log(`limited_${actions[0]}`); return limited(c); }
  }

  // (7) The authorised database mechanism: service role only. The database repeats its own backstop checks.
  let res: Response;
  try {
    res = await deps.fetch(`${supaUrl}/rest/v1/rpc/submit_funeral_enquiry`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: id, p_kind: kind, p_message: message, p_contact: contact, p_contact_name: name || null, p_relationship: relationship || null }),
    });
  } catch { log('db_unreachable'); return reply(503, 'unavailable'); }
  if (res.ok) return reply(200, 'ok');
  const err = await res.json().catch(() => ({})) as { code?: string };
  if (err.code === 'P0002') return reply(404, 'unknown_notice');
  if (err.code === '22023') return reply(400, 'invalid_input');
  if (err.code === '54000') return reply(429, 'rate_limited', { retry_after: 3600 }, { 'Retry-After': '3600' });
  log(`db_error_${err.code ?? res.status}`);
  return reply(503, 'unavailable');
}

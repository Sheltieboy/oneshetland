/**
 * turnstile-verify.ts — SERVER-SIDE verification of a Cloudflare Turnstile token, through Cloudflare's official siteverify endpoint.
 *
 * The browser widget proves nothing by itself: a token is only evidence once Cloudflare has confirmed it, from the server, with the secret key. This module
 * is the only place that does that for the funeral enquiry form. It FAILS CLOSED: if Cloudflare cannot be reached, answers oddly, or the secret is wrong,
 * the result is "unavailable" and the caller refuses the request. Nothing here trusts a client-side result.
 *
 * What is checked, beyond Cloudflare's own `success`:
 *   - the token is present and a plausible size (Cloudflare's limit is 2048 characters);
 *   - REUSE and EXPIRY: Cloudflare answers `timeout-or-duplicate` for a token that was already redeemed or is older than 5 minutes. We also refuse a
 *     `challenge_ts` older than the token lifetime, in case an answer is replayed or a mock/proxy ever returns success for an old challenge;
 *   - the HOSTNAME the widget ran on is one of ours (a token solved on someone else's site is refused);
 *   - the ACTION the widget declared is the one this form uses (a token from the sign-in form cannot be replayed here);
 *   - optionally the cData (we bind the token to ONE announcement).
 *
 * The secret is passed in by the caller from an environment secret. It never appears in a response or a log.
 */

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Turnstile tokens live 300 s; a little slack for clock skew and network time. */
export const TOKEN_MAX_AGE_MS = 300_000 + 30_000;

export type TurnstileFailure =
  | 'missing' | 'invalid' | 'expired_or_reused' | 'wrong_hostname' | 'wrong_action' | 'wrong_cdata' | 'stale' | 'unavailable';
export type TurnstileResult = { ok: true; hostname: string } | { ok: false; code: TurnstileFailure };

export interface TurnstileCheck {
  secret: string;
  token: unknown;
  remoteIp?: string;
  expectedAction: string;
  expectedCData?: string;
  allowedHostnames: string[];
  fetchImpl: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export async function verifyTurnstile(c: TurnstileCheck): Promise<TurnstileResult> {
  if (!c.secret) return { ok: false, code: 'unavailable' };                          // misconfigured: never "allow"
  if (typeof c.token !== 'string' || c.token.trim() === '') return { ok: false, code: 'missing' };
  if (c.token.length > 2048) return { ok: false, code: 'invalid' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs ?? 5000);
  let body: Record<string, unknown>;
  try {
    const res = await c.fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: c.secret, response: c.token, ...(c.remoteIp ? { remoteip: c.remoteIp } : {}) }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, code: 'unavailable' };
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'unavailable' };                                      // network error, timeout, bad JSON: fail closed
  } finally {
    clearTimeout(timer);
  }
  if (!body || typeof body !== 'object') return { ok: false, code: 'unavailable' };

  if (body.success !== true) {
    const codes = Array.isArray(body['error-codes']) ? (body['error-codes'] as unknown[]).map(String) : [];
    if (codes.includes('timeout-or-duplicate')) return { ok: false, code: 'expired_or_reused' };
    if (codes.includes('missing-input-response')) return { ok: false, code: 'missing' };
    // our own configuration is wrong, or Cloudflare is failing: not the visitor's fault, and never a pass
    if (codes.some((x) => x === 'internal-error' || x === 'missing-input-secret' || x === 'invalid-input-secret' || x === 'bad-request')) return { ok: false, code: 'unavailable' };
    return { ok: false, code: 'invalid' };
  }

  const hostname = typeof body.hostname === 'string' ? body.hostname.toLowerCase() : '';
  if (!hostname || !c.allowedHostnames.map((h) => h.toLowerCase()).includes(hostname)) return { ok: false, code: 'wrong_hostname' };
  if (body.action !== c.expectedAction) return { ok: false, code: 'wrong_action' };
  if (c.expectedCData !== undefined && body.cdata !== c.expectedCData) return { ok: false, code: 'wrong_cdata' };

  const ts = typeof body.challenge_ts === 'string' ? Date.parse(body.challenge_ts) : NaN;
  const now = (c.now ?? Date.now)();
  if (!Number.isFinite(ts) || now - ts > TOKEN_MAX_AGE_MS || ts - now > 60_000) return { ok: false, code: 'stale' };

  return { ok: true, hostname };
}

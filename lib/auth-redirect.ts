/**
 * auth-redirect — "return to where you were after signing in".
 *
 * Callers send users to sign-in with a `next` param (the path to return to).
 * The root layout (app/_layout.tsx) reads `next` once a session appears and
 * navigates there instead of Home. `sanitizeNext` guards against open-redirects
 * and junk values — only INTERNAL absolute paths (a single leading slash) are
 * allowed; anything else (protocol-relative `//host`, `http(s)://`, empty)
 * falls back to the default Home destination.
 */
export function sanitizeNext(next?: string | string[] | null): string | null {
  const raw = Array.isArray(next) ? next[0] : next;
  if (!raw || typeof raw !== 'string') return null;
  let s = raw;
  try { s = decodeURIComponent(raw); } catch { /* use raw */ }
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  return s;
}

/**
 * emailRedirectTo for signup/resend confirmation — the HTTPS web callback,
 * not a bare oneshetland-fetch:// scheme.
 *
 * A bare custom scheme has no fallback on any device that isn't running this
 * app: opened on a laptop or another phone it dead-ends (about:blank), even
 * though Supabase confirms the account correctly server-side regardless.
 * oneshetland.com/auth/callback already works from any device (verifies via
 * token_hash server-side, no browser-held PKCE verifier needed) and lands on
 * /auth/confirmed, which offers "Open OneShetland" — a plain link carrying no
 * session credentials. app/auth/confirm.tsx already handles that token-less
 * deep link correctly (routes to sign-in), so same-device confirmation still
 * works exactly as before.
 */
export function emailConfirmationRedirectTo(next?: string | null): string {
  const confirmedPage = `/auth/confirmed${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return `https://oneshetland.com/auth/callback?next=${encodeURIComponent(confirmedPage)}`;
}

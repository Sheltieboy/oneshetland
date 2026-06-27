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

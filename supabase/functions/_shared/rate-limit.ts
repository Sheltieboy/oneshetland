/**
 * rate-limit.ts — the abuse ceiling for endpoints that cost money or reach
 * real people.
 *
 * WHY THIS EXISTS
 *
 * Step 14 established that these endpoints require a real account. That stops
 * an anonymous stranger; it does not stop one free account from asking for a
 * hub broadcast, a driver fan-out or a paid transcription in a loop. Nothing
 * in the system counted how often anything was asked for.
 *
 * WHERE THE LIMITS LIVE
 *
 * Not here. A call site names an ACTION; the ceiling for that action is a row
 * in public.rate_limit_policies, and claim_rate_limits enforces it. A call
 * site cannot ask for a bigger allowance, and every limit in the product can
 * be read — or raised — in one table. An action nobody has classified is
 * denied rather than allowed.
 *
 * FAILING CLOSED
 *
 * If the limiter itself cannot be reached, these routes reject with 503. The
 * alternative — treating a broken limiter as "no limit" — means the one moment
 * the database is struggling is the moment anyone may send unlimited email.
 * That is backwards, so it does not do that.
 *
 * WHAT A CALLER IS TOLD
 *
 * 429 and `{"error":"Too many requests"}`, plus Retry-After. Never which
 * action tripped, never how many are left, never anything about the limiter's
 * shape — that is operator detail and it goes to the log.
 */

export type RateLimitResult = { ok: true } | { denied: Response };

/** `user:<uuid>` — an account, resolved from the JWT server-side. */
export const userSubject = (userId: string) => `user:${userId}`;

/** `global` — one ceiling for a whole endpoint, where no caller identity is trustworthy. */
export const GLOBAL_SUBJECT = 'global';

/**
 * `email:<sha256>` — for the password-reset path, where there is no account
 * yet. The address itself is never stored: two requests for the same address
 * land in the same bucket without the bucket revealing whose it is.
 */
export async function emailSubject(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `email:${hex.slice(0, 32)}`;
}

/**
 * Claims one slot against every named action, all or nothing.
 *
 * Returns `{ ok: true }` to carry on, or `{ denied }` with the Response to
 * return unchanged. Actions are claimed together so a caller that trips its
 * aggregate ceiling does not also burn its per-route allowance.
 */
export async function enforceRateLimit(
  scope: string,
  subject: string,
  actions: string[],
  corsHeaders: Record<string, string>,
): Promise<RateLimitResult> {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const json = (b: unknown, s: number, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, ...extra, 'Content-Type': 'application/json' } });

  // No service credential means the claim cannot be made at all. Refuse.
  if (!url || !serviceKey) {
    console.error(`[${scope}] rate limit: service credentials unavailable`);
    return { denied: json({ error: 'Service unavailable' }, 503) };
  }

  let rows: { allowed: boolean; blocked_action: string | null; retry_after_secs: number }[];
  try {
    const res = await fetch(`${url}/rest/v1/rpc/claim_rate_limits`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_subject: subject, p_actions: actions }),
    });
    if (!res.ok) {
      console.error(`[${scope}] rate limit: claim failed HTTP ${res.status}`);
      return { denied: json({ error: 'Service unavailable' }, 503) };
    }
    rows = await res.json();
  } catch (err) {
    console.error(`[${scope}] rate limit: claim threw`, err);
    return { denied: json({ error: 'Service unavailable' }, 503) };
  }

  const verdict = Array.isArray(rows) ? rows[0] : undefined;
  if (!verdict) {
    console.error(`[${scope}] rate limit: claim returned nothing`);
    return { denied: json({ error: 'Service unavailable' }, 503) };
  }

  if (!verdict.allowed) {
    const retry = Math.max(1, verdict.retry_after_secs || 60);
    // The action that tripped is operator detail, so it is logged, not returned.
    console.warn(`[${scope}] rate limited: ${verdict.blocked_action} retry_after=${retry}s`);
    return { denied: json({ error: 'Too many requests' }, 429, { 'Retry-After': String(retry) }) };
  }

  return { ok: true };
}

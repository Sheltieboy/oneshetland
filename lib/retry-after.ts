/**
 * Reads a `Retry-After` header, in whole seconds, from the Response a failed
 * supabase.functions.invoke call carries as `error.context`.
 *
 * enforceRateLimit() (supabase/functions/_shared/rate-limit.ts) sends the exact
 * seconds until its current window resets — anything from 1 to the window
 * length (an hour for the Stripe-onboarding actions), not a fixed minute.
 * Where the header is not readable (a browser blocks non-safelisted response
 * headers cross-origin unless the server lists them in
 * Access-Control-Expose-Headers, which it does not) this returns undefined and
 * the caller falls back to its own default rather than guessing.
 *
 * Numeric seconds only; an HTTP-date form is treated as unavailable.
 */
export function retryAfterSecsFrom(ctx: unknown): number | undefined {
  const raw = (ctx as { headers?: { get?: (name: string) => string | null } } | null | undefined)
    ?.headers?.get?.('Retry-After');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/**
 * cron-auth.ts — the scheduler's credential check, in one place, failing closed.
 *
 * WHAT WAS WRONG
 *
 * Four Edge Functions are deployed with verify_jwt=false, because pg_cron calls
 * them through pg_net with no Authorization header at all — only Content-Type
 * and a shared `x-cron-secret`. Their own guard was the whole boundary, and all
 * four wrote it like this:
 *
 *   const secret = Deno.env.get('CRON_SECRET');
 *   if (secret && req.headers.get('x-cron-secret') !== secret) return 403;
 *
 * Read the condition when `secret` is undefined: `secret &&` is falsy, the
 * whole test is skipped, and the request proceeds. The endpoint is MORE
 * permissive with no server secret than with one. Absent configuration removed
 * the only lock on the door.
 *
 * That is backwards, and it is the failure mode you least want, because it is
 * silent: nothing errors, nothing logs, the function just starts answering
 * everybody. One of these sends notifications, one posts publicly to Facebook,
 * one imports jobs, and reminder-runner invokes the billing meter.
 *
 * CRON_SECRET is set on the project today, so this was never exploitable
 * through the live configuration. The point is that it should not depend on
 * that. An authentication boundary that only works while a variable happens to
 * be present is not a boundary.
 *
 * THE TWO FAILURES ARE DIFFERENT AND ARE REPORTED DIFFERENTLY
 *
 *   no server secret   → 503, and a server-side log. This is OUR fault. The
 *                        caller may be perfectly legitimate; we cannot tell,
 *                        so we refuse to do privileged work at all.
 *   bad/absent header  → 401. This is the CALLER's problem, and the response
 *                        says nothing else — not whether the header was
 *                        missing rather than wrong, not the expected length.
 *
 * Collapsing those into one status would hide a misconfiguration behind what
 * looks like ordinary rejected traffic.
 *
 * WHY ONE HELPER AND NOT FOUR CHECKS
 *
 * There were four hand-written copies of the same rule and they had already
 * drifted — three returned 403, one returned 401. Four copies of a security
 * decision is four chances to fix it in three places. The import style matches
 * the existing shared modules (send-push, wallet-ledger), which the same four
 * functions already use, so bundling behaviour is unchanged.
 *
 * TESTABILITY IS PART OF THE DESIGN
 *
 * `decideCronAuth` is pure: two strings in, a verdict out, no Deno, no Request,
 * no Response. The case that actually failed open — server secret missing — is
 * therefore testable directly, from Node, without deleting the production
 * secret to reproduce it. That was the deciding constraint on the shape of
 * this file.
 */

export type CronAuthOutcome =
  | { ok: true }
  | { ok: false; status: 503; reason: 'server-secret-missing' }
  | { ok: false; status: 401; reason: 'caller-credential-invalid' };

/**
 * Constant-time string comparison.
 *
 * Honest about what this is worth: CRON_SECRET is a 32-character high-entropy
 * value, and remote timing analysis across the Supabase gateway against a
 * JavaScript string compare is not a practical attack. This is here because it
 * costs six lines and removes the question, not because it closes a hole that
 * was measured.
 *
 * It still leaks LENGTH via the early return — deliberately, since comparing
 * unequal-length inputs cannot be made constant-time without hashing, and the
 * async digest that would need is not worth it at this threat level. The
 * fail-closed behaviour above is the fix; this is an adjunct.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The decision, with no I/O of any kind.
 *
 * `expected` is whatever the environment yielded — undefined, null, '' and a
 * string of spaces are all treated as "not configured", because a secret that
 * is blank is not a secret and an empty-string comparison would otherwise
 * happily match an empty header.
 */
export function decideCronAuth(
  expected: string | undefined | null,
  provided: string | undefined | null,
): CronAuthOutcome {
  if (typeof expected !== 'string' || expected.trim().length === 0) {
    return { ok: false, status: 503, reason: 'server-secret-missing' };
  }
  if (typeof provided !== 'string' || provided.length === 0) {
    return { ok: false, status: 401, reason: 'caller-credential-invalid' };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, reason: 'caller-credential-invalid' };
  }
  return { ok: true };
}

/**
 * Turns a verdict into the response to send, or null when the caller may
 * proceed. Pure apart from constructing a Response, so it is testable too.
 *
 * The bodies are deliberately uninformative. A caller learns that it was
 * refused and nothing about why — not which half of the check failed, not
 * whether the header was close.
 */
export function cronAuthResponse(
  outcome: CronAuthOutcome,
  corsHeaders: Record<string, string>,
): Response | null {
  if (outcome.ok) return null;

  if (outcome.status === 503) {
    // Server-side only. The operator needs to know the deployment is broken;
    // the caller is told nothing beyond "unavailable".
    console.error('[cron-auth] CRON_SECRET is not configured — refusing to run scheduled work');
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * The one line a scheduled function calls, before it does anything else:
 *
 *   const denied = requireCronSecret(req, corsHeaders);
 *   if (denied) return denied;
 *
 * Returns null when the request is authenticated, otherwise the Response to
 * return immediately. `readSecret` is injectable purely so the environment read
 * itself can be exercised in tests; production never passes it.
 */
export function requireCronSecret(
  req: Request,
  corsHeaders: Record<string, string>,
  readSecret: () => string | undefined = () => Deno.env.get('CRON_SECRET'),
): Response | null {
  return cronAuthResponse(
    decideCronAuth(readSecret(), req.headers.get('x-cron-secret')),
    corsHeaders,
  );
}

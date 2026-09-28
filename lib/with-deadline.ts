/**
 * with-deadline.ts — bound an await that has no timeout of its own.
 *
 * Pure (no React Native imports) so it can be unit-tested under node.
 */

export const TIMED_OUT = Symbol('timed-out');

/**
 * Races `work` against a deadline. Resolves `TIMED_OUT` if the deadline wins;
 * a rejection from `work` still propagates. The timer is always cleared.
 *
 * This does NOT cancel `work`. Pass `onTimeout` to release whatever it holds
 * (e.g. a native auth session) — it runs once, only if the deadline wins, and
 * a throw from it is swallowed so it can never mask the timeout result.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* releasing is best-effort */
      }
      resolve(TIMED_OUT);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch-v2-flag.ts — the Fetch v2 feature flag, as an edge function sees it (docs/FETCH_V2_IMPLEMENTATION.md, N.1).
 *
 * The database answers (fetch_v2_enabled_for, migration 20261127000000); this module only asks it, with the service client, for the
 * caller the function has already authenticated. Every Fetch v2 edge function calls fetchV2Gate before reading its body or touching
 * any row, and returns the decision as-is when it is not ok:
 *
 *   const gate = await fetchV2Gate(svc, caller);
 *   if (!gate.ok) return json({ error: gate.error }, gate.status);
 *
 * It fails closed: an error from the database, or an answer that is not literally `true`, is a refusal. The service role itself is
 * not exempt from the audience — it acts for a user, and that user must be inside it (cron/internal work passes the user it acts for).
 */

import { type NotifyDecision, denyNotify } from './notify-decision.ts';

// deno-lint-ignore no-explicit-any
type Svc = any;

export const FETCH_V2_UNAVAILABLE = 'Fetch is not available';

export async function fetchV2Enabled(svc: Svc, userId: string | null): Promise<boolean> {
  try {
    const { data, error } = await svc.rpc('fetch_v2_enabled_for', { p_user: userId });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function fetchV2Gate(svc: Svc, caller: { userId: string | null }): Promise<NotifyDecision> {
  return (await fetchV2Enabled(svc, caller.userId)) ? { ok: true } : denyNotify(403, FETCH_V2_UNAVAILABLE);
}

/**
 * edition-update-notify-auth.ts — who may make notify-edition-update fire.
 *
 * Only someone who CURRENTLY works for the Edition's organiser (any helper role, the Hub's owner / committee, the Business owner) or a platform administrator may tell the people who
 * saved an Edition about an update. The decision is the database's edition_update_notify_authorised(update, user), keyed by the UPDATE ROW the caller names, never by any organiser or
 * Edition id the client supplies. A service-role caller is our own backend. A database error is a refusal (fail closed), never permission.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export async function authoriseEditionUpdateNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { updateId: unknown },
): Promise<NotifyDecision> {
  const { updateId } = input;
  if (!updateId || !isUuid(updateId)) return denyNotify(400, 'update_id required');

  const { data: upd, error: lookupError } = await svc.from('edition_updates').select('id').eq('id', updateId).maybeSingle();
  if (lookupError) return denyNotify(503, 'Service unavailable');
  if (!upd) return denyNotify(404, 'update not found');
  if (caller.isServiceRole) return { ok: true };

  const { data: allowed, error } = await svc.rpc('edition_update_notify_authorised', { p_update: updateId, p_user: caller.userId });
  if (!error && allowed === true) return { ok: true };
  return denyNotify(403, 'Not allowed');
}

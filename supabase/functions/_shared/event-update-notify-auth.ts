/**
 * event-update-notify-auth.ts — who may make notify-event-update fire.
 *
 * Only someone who CURRENTLY controls the event's organiser may notify its ticket holders — otherwise any signed-in account could email
 * every buyer of somebody else's event. The decision is public.can_scan_event(), the same single source of truth that validate-event-ticket
 * and get_event_orders use: platform admin, the owner of the organising business, or the owner / an active committee member of the organising
 * hub. organiser_user_id is audit metadata and confers nothing — a former organiser, or a person who merely created the row, is refused.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export async function authoriseEventUpdateNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { updateId: unknown },
): Promise<NotifyDecision> {
  const { updateId } = input;
  if (!updateId) return denyNotify(400, 'update_id required');
  if (caller.isServiceRole) return { ok: true };
  if (!isUuid(updateId)) return denyNotify(400, 'update_id required');

  const { data: upd } = await svc.from('event_updates').select('event_id').eq('id', updateId).maybeSingle();
  if (!upd) return denyNotify(404, 'update not found');

  const { data: allowed, error } = await svc.rpc('can_scan_event', {
    p_event_id: (upd as { event_id: string }).event_id,
    p_user_id: caller.userId,
  });
  if (!error && allowed === true) return { ok: true };

  return denyNotify(403, 'Not allowed');
}

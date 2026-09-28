/**
 * hub-content-notify-auth.ts — who may make notify-hub-content fire.
 *
 * Only a hub's owner or admin may push to its whole membership — otherwise any
 * signed-in account could fan out a "new notice" / "new event" push to every
 * member of a hub they have nothing to do with. This was already checked
 * inline in notify-hub-content; pulled out here, unchanged in substance, so
 * the rule is unit-testable the same way as every other fan-out's gate.
 * Checked in order: the hub's owner, is_hub_admin for that hub, then a global
 * admin — the same authority the database's own policies use.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export async function authoriseHubContentNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; hubId: unknown },
): Promise<NotifyDecision> {
  const { event, hubId } = input;
  if (!event || !hubId) return denyNotify(400, 'event and hub_id required');
  if (caller.isServiceRole) return { ok: true };
  if (!isUuid(hubId)) return denyNotify(400, 'event and hub_id required');

  const { data: h } = await svc.from('hubs').select('owner_id').eq('id', hubId).maybeSingle();
  if ((h as { owner_id?: string } | null)?.owner_id === caller.userId) return { ok: true };

  const { data: isHubAdmin } = await svc.rpc('is_hub_admin', { p_hub: hubId, p_user: caller.userId });
  if (isHubAdmin === true) return { ok: true };

  const { data: me } = await svc.from('profiles').select('role').eq('id', caller.userId).maybeSingle();
  if ((me as { role?: string } | null)?.role === 'admin') return { ok: true };

  return denyNotify(403, 'Not allowed');
}

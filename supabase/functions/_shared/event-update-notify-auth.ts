/**
 * event-update-notify-auth.ts — who may make notify-event-update fire.
 *
 * Only the organiser of an event may notify its ticket holders — otherwise any
 * signed-in account could email every buyer of somebody else's event. This was
 * already checked inline in notify-event-update; pulled out here, unchanged in
 * substance, so the rule is unit-testable the same way as every other fan-out's
 * gate. Checked in order: the organiser themselves, the owner of the
 * organising business, the owner of the organising hub, then a global admin.
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

  const { data: ev } = await svc
    .from('events')
    .select('organiser_user_id, organiser_business_id, organiser_hub_id')
    .eq('id', (upd as { event_id: string }).event_id).maybeSingle();

  const e = ev as { organiser_user_id?: string; organiser_business_id?: string; organiser_hub_id?: string } | null;

  if (e?.organiser_user_id === caller.userId) return { ok: true };

  if (e?.organiser_business_id) {
    const { data: b } = await svc.from('local_businesses').select('owner_id').eq('id', e.organiser_business_id).maybeSingle();
    if ((b as { owner_id?: string } | null)?.owner_id === caller.userId) return { ok: true };
  }

  if (e?.organiser_hub_id) {
    const { data: h } = await svc.from('hubs').select('owner_id').eq('id', e.organiser_hub_id).maybeSingle();
    if ((h as { owner_id?: string } | null)?.owner_id === caller.userId) return { ok: true };
  }

  const { data: p } = await svc.from('profiles').select('role').eq('id', caller.userId).maybeSingle();
  if ((p as { role?: string } | null)?.role === 'admin') return { ok: true };

  return denyNotify(403, 'Not allowed');
}

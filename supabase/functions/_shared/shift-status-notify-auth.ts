/**
 * shift-status-notify-auth.ts — who may make notify-shift-status fire.
 *
 * notify-shift-status checked only that the caller was signed in. shift_id and
 * application_id came straight from the request body, so any account could:
 *
 *   cancelled  →  push "Shift cancelled" (urgent) to every pending/accepted
 *                  worker on a shift they don't employ for
 *   withdrawn  →  tell an employer "a worker withdrew" for an application
 *                  that was never theirs to report on
 *
 * The gate ties the caller to the entity: the shift's employer for
 * `cancelled`, the withdrawing worker themselves for `withdrawn`.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export type ShiftStatusNotifyEvent = 'cancelled' | 'withdrawn';

export async function authoriseShiftStatusNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; shiftId?: unknown; applicationId?: unknown },
): Promise<NotifyDecision> {
  const { event } = input;
  if (!event) return denyNotify(400, 'event required');
  if (caller.isServiceRole) return { ok: true };

  if (event === 'cancelled') {
    const { shiftId } = input;
    if (!shiftId) return denyNotify(400, 'shift_id required');
    if (!isUuid(shiftId)) return denyNotify(400, 'shift_id required');
    const { data: shift } = await svc.from('shifts').select('employer_id').eq('id', shiftId).maybeSingle();
    if (!shift) return denyNotify(404, 'shift not found');
    if ((shift as { employer_id?: string } | null)?.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  if (event === 'withdrawn') {
    const { applicationId } = input;
    if (!applicationId) return denyNotify(400, 'application_id required');
    if (!isUuid(applicationId)) return denyNotify(400, 'application_id required');
    const { data: app } = await svc.from('shift_applications').select('worker_id').eq('id', applicationId).maybeSingle();
    if (!app) return denyNotify(404, 'application not found');
    if ((app as { worker_id?: string } | null)?.worker_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  // Unrecognised event — left to the handler's own "unknown event" 400.
  return { ok: true };
}

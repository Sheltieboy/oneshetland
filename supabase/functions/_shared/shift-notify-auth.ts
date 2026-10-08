/**
 * shift-notify-auth.ts — who may make the five shift notification functions fire, and for which shift/application.
 *
 *   notify-application-update  employer accepted / rejected an application   → tells the WORKER
 *   notify-shift-complete      employer marked the shift complete             → tells every accepted worker
 *   notify-matching-workers    employer posted a shift                        → tells every worker with a matching alert
 *   notify-shift-application   worker applied                                → tells the EMPLOYER
 *   notify-worker-checkin      worker checked in / out                        → tells the EMPLOYER
 *
 * These checked only that the caller was signed in. application_id / shift_id came straight from the request body, so any account could push
 * "You're confirmed! 🎉", "Shift confirmed", "New shift for you" or "worker checked in" at people it has nothing to do with, simply by knowing a
 * UUID. The rule is the one the database already applies to the underlying WRITE (RLS: "employer accepts or rejects", "employer manages own
 * shifts", "worker submits interest", "worker records own check-in"), resolved from the caller's authenticated identity, never from the body:
 *
 *   employer actions  → the caller is shifts.employer_id of the application's / request's shift
 *   worker actions    → the caller is shift_applications.worker_id of that application
 *
 * and the claimed FACT must be true when the push is sent. The apps write first and notify second, so the row already says what happened:
 * the application's status must be the one claimed, the shift must be completed / open, a check-in must have a check-in time. Recipients are never
 * taken from the request: they are read from those same rows by the handlers.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export type ShiftNotifyInput =
  | { action: 'application_update'; applicationId: unknown; status: unknown }
  | { action: 'shift_application'; applicationId: unknown }
  | { action: 'worker_checkin'; applicationId: unknown; event: unknown }
  | { action: 'shift_complete'; shiftId: unknown }
  | { action: 'matching_workers'; shiftId: unknown };

type Caller = { userId: string; isServiceRole: boolean };
// deno-lint-ignore no-explicit-any
type Svc = any;

async function loadApplication(svc: Svc, applicationId: unknown) {
  if (!isUuid(applicationId)) return { err: denyNotify(400, 'application_id required') };
  const { data: app } = await svc.from('shift_applications')
    .select('id, shift_id, worker_id, status, checked_in_at, checked_out_at').eq('id', applicationId).maybeSingle();
  if (!app) return { err: denyNotify(404, 'application not found') };
  const { data: shift } = await svc.from('shifts').select('id, employer_id, status').eq('id', (app as { shift_id: string }).shift_id).maybeSingle();
  if (!shift) return { err: denyNotify(404, 'shift not found') };
  return { app: app as { id: string; shift_id: string; worker_id: string; status: string; checked_in_at: string | null; checked_out_at: string | null },
           shift: shift as { id: string; employer_id: string; status: string } };
}

async function loadShift(svc: Svc, shiftId: unknown) {
  if (!isUuid(shiftId)) return { err: denyNotify(400, 'shift_id required') };
  const { data: shift } = await svc.from('shifts').select('id, employer_id, status').eq('id', shiftId).maybeSingle();
  if (!shift) return { err: denyNotify(404, 'shift not found') };
  return { shift: shift as { id: string; employer_id: string; status: string } };
}

export async function authoriseShiftNotify(svc: Svc, caller: Caller, input: ShiftNotifyInput): Promise<NotifyDecision> {
  if (input.action === 'application_update') {
    if (input.status !== 'accepted' && input.status !== 'rejected') return denyNotify(400, "status must be 'accepted' or 'rejected'");
    if (caller.isServiceRole) return { ok: true };
    const r = await loadApplication(svc, input.applicationId); if ('err' in r) return r.err!;
    if (r.shift.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    if (r.app.status !== input.status) return denyNotify(409, 'The application is not in that state');
    return { ok: true };
  }

  if (input.action === 'shift_application') {
    if (caller.isServiceRole) return { ok: true };
    const r = await loadApplication(svc, input.applicationId); if ('err' in r) return r.err!;
    if (r.app.worker_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  if (input.action === 'worker_checkin') {
    if (input.event !== 'checked_in' && input.event !== 'checked_out') return denyNotify(400, "event must be 'checked_in' or 'checked_out'");
    if (caller.isServiceRole) return { ok: true };
    const r = await loadApplication(svc, input.applicationId); if ('err' in r) return r.err!;
    if (r.app.worker_id !== caller.userId) return denyNotify(403, 'Not allowed');
    if (r.app.status !== 'accepted') return denyNotify(409, 'Only an accepted application can check in');
    if (input.event === 'checked_in' && !r.app.checked_in_at) return denyNotify(409, 'No check-in has been recorded');
    if (input.event === 'checked_out' && !r.app.checked_out_at) return denyNotify(409, 'No check-out has been recorded');
    return { ok: true };
  }

  if (input.action === 'shift_complete') {
    if (caller.isServiceRole) return { ok: true };
    const r = await loadShift(svc, input.shiftId); if ('err' in r) return r.err!;
    if (r.shift.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    if (r.shift.status !== 'completed') return denyNotify(409, 'The shift is not marked complete');
    return { ok: true };
  }

  // matching_workers
  if (caller.isServiceRole) return { ok: true };
  const r = await loadShift(svc, input.shiftId); if ('err' in r) return r.err!;
  if (r.shift.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
  if (r.shift.status !== 'open') return denyNotify(409, 'The shift is not open');
  return { ok: true };
}

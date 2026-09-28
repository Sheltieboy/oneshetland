/**
 * job-notify-auth.ts — who may make notify-job fire.
 *
 * notify-job checked only that the caller was signed in. job_id and
 * application_id came straight from the request body, so any account could:
 *
 *   application / withdrawn  →  tell an employer "X applied" / "X withdrew"
 *                                 for an application that was never theirs
 *   status                   →  push a status change ("You got the job!") to
 *                                 an applicant with no employer decision behind it
 *   job_closed                →  tell every pending applicant a job they don't
 *                                 own has closed
 *
 * The gate ties the caller to the entity each event is really about:
 *   application / withdrawn   the applicant named on the row
 *   status / job_closed       the employer who owns the job
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export type JobNotifyEvent = 'application' | 'withdrawn' | 'status' | 'job_closed';

export async function authoriseJobNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; jobId?: unknown; applicationId?: unknown },
): Promise<NotifyDecision> {
  const { event } = input;
  if (!event) return denyNotify(400, 'event required');
  if (caller.isServiceRole) return { ok: true };

  if (event === 'job_closed') {
    const { jobId } = input;
    if (!jobId) return denyNotify(400, 'job_id required');
    if (!isUuid(jobId)) return denyNotify(400, 'job_id required');
    const { data: job } = await svc.from('jobs').select('employer_id').eq('id', jobId).maybeSingle();
    if (!job) return denyNotify(404, 'job not found');
    if ((job as { employer_id?: string } | null)?.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  if (event === 'application' || event === 'withdrawn' || event === 'status') {
    const { applicationId } = input;
    if (!applicationId) return denyNotify(400, 'application_id required');
    if (!isUuid(applicationId)) return denyNotify(400, 'application_id required');
    const { data: app } = await svc
      .from('job_applications').select('applicant_id, job_id')
      .eq('id', applicationId).maybeSingle();
    if (!app) return denyNotify(404, 'application not found');

    if (event === 'application' || event === 'withdrawn') {
      if ((app as { applicant_id?: string }).applicant_id !== caller.userId) return denyNotify(403, 'Not allowed');
      return { ok: true };
    }

    // status: only the employer moves an applicant's stage.
    const { data: job } = await svc.from('jobs').select('employer_id').eq('id', (app as { job_id: string }).job_id).maybeSingle();
    if (!job) return denyNotify(404, 'job not found');
    if ((job as { employer_id?: string } | null)?.employer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  // Unrecognised event — left to the handler's own "unknown event" 400.
  return { ok: true };
}

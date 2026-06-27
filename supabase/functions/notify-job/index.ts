import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * notify-job
 *
 * Notifications for the Jobs board (the board was otherwise silent):
 *   event 'application' → employer: someone applied to your job.
 *   event 'status'      → applicant: their application moved stage (meaningful
 *                         stages only; 'viewed' is intentionally silent).
 *   event 'withdrawn'   → employer: an applicant pulled out.
 *   event 'job_closed'  → all still-pending applicants: the role has closed/filled.
 *
 * Body: { event, application_id?, job_id?, status? }
 * All on the `jobs` module. Fire-and-forget — best effort.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Svc = ReturnType<typeof createServiceClient>;

async function jobContext(svc: Svc, jobId: string) {
  const { data: job } = await svc
    .from('jobs')
    .select('id, employer_id, title, posted_as_business_id')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return null;
  let bizName: string | null = null;
  if (job.posted_as_business_id) {
    const { data: biz } = await svc
      .from('local_businesses').select('name').eq('id', job.posted_as_business_id).maybeSingle();
    bizName = (biz as { name?: string } | null)?.name ?? null;
  }
  return { job, bizName };
}

// Applicant-facing copy per stage. Returns null for stages we don't notify on.
function statusMessage(status: string, title: string, where: string): { title: string; body: string; urgent: boolean } | null {
  switch (status) {
    case 'shortlisted': return { title: "You've been shortlisted 🎉", body: `You're shortlisted for ${title}${where}.`, urgent: false };
    case 'interview':   return { title: 'Interview stage', body: `You've reached the interview stage for ${title}${where}.`, urgent: false };
    case 'offer':       return { title: 'You\'ve had a job offer! 🎉', body: `There's an offer waiting for ${title}${where}. Tap to view.`, urgent: true };
    case 'hired':       return { title: 'You got the job! 🎉', body: `Great news — you've been hired for ${title}${where}.`, urgent: true };
    case 'declined':    return { title: `Update on your application`, body: `The employer has made their decision on ${title}${where}.`, urgent: false };
    default:            return null; // applied / viewed / withdrawn → no push
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { event, application_id, job_id, status } = await req.json();
    if (!event) return json({ error: 'event required' }, 400);
    const svc = createServiceClient();

    // ── job_closed: notify everyone still in the running ──
    if (event === 'job_closed') {
      if (!job_id) return json({ error: 'job_id required' }, 400);
      const ctx = await jobContext(svc, job_id);
      if (!ctx) return json({ error: 'job not found' }, 404);
      const { data: apps } = await svc
        .from('job_applications')
        .select('applicant_id')
        .eq('job_id', job_id)
        .in('status', ['applied', 'viewed', 'shortlisted', 'interview', 'offer']);
      const ids = [...new Set((apps ?? []).map(a => a.applicant_id).filter(Boolean) as string[])];
      const where = ctx.bizName ? ` at ${ctx.bizName}` : '';
      const { sent } = await sendUserPushBulk(svc, ids, {
        module: 'jobs',
        categoryId: 'jobs.closed',
        title: `${ctx.job.title} has closed`,
        body: `The role${where} is no longer taking applications.`,
        data: { job_id, screen: 'my-job-applications' },
      });
      return json({ ok: true, notified: sent });
    }

    // The remaining events all key off an application.
    if (!application_id) return json({ error: 'application_id required' }, 400);
    const { data: app } = await svc
      .from('job_applications')
      .select('id, applicant_id, job_id, status')
      .eq('id', application_id)
      .maybeSingle();
    if (!app) return json({ error: 'application not found' }, 404);

    const ctx = await jobContext(svc, app.job_id);
    if (!ctx) return json({ error: 'job not found' }, 404);
    const where = ctx.bizName ? ` at ${ctx.bizName}` : '';

    if (event === 'application' || event === 'withdrawn') {
      // Notify the employer (the person who posted the job).
      if (!ctx.job.employer_id) return json({ ok: true, notified: 0 });
      const { data: applicant } = await svc
        .from('profiles').select('full_name').eq('id', app.applicant_id).maybeSingle();
      const who = (applicant as { full_name?: string } | null)?.full_name ?? 'Someone';
      const isApply = event === 'application';
      await sendUserPush(svc, {
        userId:     ctx.job.employer_id,
        module:     'jobs',
        categoryId: isApply ? 'jobs.new_application' : 'jobs.withdrawn',
        title:      isApply ? 'New application' : 'Application withdrawn',
        body:       isApply
          ? `${who} applied for ${ctx.job.title}.`
          : `${who} withdrew from ${ctx.job.title}.`,
        data:       { screen: 'job-applicants', job_id: app.job_id },
      });
      return json({ ok: true, notified: 1 });
    }

    if (event === 'status') {
      const msg = statusMessage(status ?? app.status, ctx.job.title, where);
      if (!msg) return json({ ok: true, notified: 0, skipped: 'silent stage' });
      await sendUserPush(svc, {
        userId:     app.applicant_id,
        module:     'jobs',
        categoryId: `jobs.${status ?? app.status}`,
        title:      msg.title,
        body:       msg.body,
        urgent:     msg.urgent,
        data:       { screen: 'my-job-applications', job_id: app.job_id },
      });
      return json({ ok: true, notified: 1 });
    }

    return json({ error: 'unknown event' }, 400);
  } catch (err) {
    console.error('[notify-job]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';
import { requireCaller, forbidden } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';

/**
 * notify-shift-status
 *
 * Fills two Shifts gaps that were previously silent:
 *   event 'cancelled' { shift_id }      → all still-in-play workers (pending +
 *                                          accepted) — urgent, they may have
 *                                          blocked out their day.
 *   event 'withdrawn' { application_id } → the employer (a worker pulled out).
 *
 * Module 'shifts'. Fire-and-forget.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // The gateway's verify_jwt accepts the PUBLIC ANON KEY, so it is a shape
    // check, not an authorisation check. This is the authorisation check.
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    const { event, shift_id, application_id } = await req.json();
    if (!event) return json({ error: 'event required' }, 400);
    const svc = createServiceClient();

    if (event === 'cancelled') {
      if (!shift_id) return json({ error: 'shift_id required' }, 400);
      const { data: shift } = await svc.from('shifts').select('title').eq('id', shift_id).maybeSingle();
      const title = (shift as { title?: string } | null)?.title ?? 'a shift';
      const { data: apps } = await svc
        .from('shift_applications')
        .select('worker_id')
        .eq('shift_id', shift_id)
        .in('status', ['pending', 'accepted']);
      const ids = [...new Set((apps ?? []).map(a => a.worker_id).filter(Boolean) as string[])];
      const { sent } = await sendUserPushBulk(svc, ids, {
        module: 'shifts', categoryId: 'shifts.cancelled', urgent: true,
        title: 'Shift cancelled',
        body: `The employer has cancelled "${title}".`,
        data: { screen: 'my-shift-applications', shift_id },
      });
      return json({ ok: true, notified: sent });
    }

    if (event === 'withdrawn') {
      if (!application_id) return json({ error: 'application_id required' }, 400);
      const { data: app } = await svc
        .from('shift_applications').select('shift_id, worker_id').eq('id', application_id).maybeSingle();
      if (!app) return json({ error: 'application not found' }, 404);
      const { data: shift } = await svc
        .from('shifts').select('title, employer_id').eq('id', app.shift_id).maybeSingle();
      if (!shift?.employer_id) return json({ ok: true, notified: 0 });
      const { data: worker } = await svc
        .from('profiles').select('full_name').eq('id', app.worker_id).maybeSingle();
      const who = (worker as { full_name?: string } | null)?.full_name ?? 'A worker';
      await sendUserPush(svc, {
        userId: shift.employer_id, module: 'shifts', categoryId: 'shifts.withdrawn',
        title: 'Application withdrawn',
        body: `${who} withdrew from "${shift.title ?? 'a shift'}".`,
        data: { screen: 'employer-applications', shift_id: app.shift_id },
      });
      return json({ ok: true, notified: 1 });
    }

    return json({ error: 'unknown event' }, 400);
  } catch (err) {
    console.error('[notify-shift-status]', err);
    return json({ error: safeError('notify-shift-status', err) }, 500);
  }
});

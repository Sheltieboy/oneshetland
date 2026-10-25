import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { authoriseShiftNotify } from '../_shared/shift-notify-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-application-update
 *
 * Called after an employer accepts or rejects an application.
 * Sends a push notification to the worker.
 *
 * Body: { application_id: string, status: 'accepted' | 'rejected' }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // The gateway's verify_jwt accepts the PUBLIC ANON KEY, so it is a shape check, not an authorisation check. Who is calling comes from here;
    // WHAT they may notify about comes from shift-notify-auth.ts below.
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Counted against notify_any as well as its own route: the aggregate only means anything if every notification path claims it.
    // A service-role caller is our own backend, not the internet, so it is not throttled.
    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('notify-application-update', userSubject(caller.userId), ['notify_direct', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    const { application_id, status, reason } = await req.json();
    if (!application_id || !status) {
      return new Response(JSON.stringify({ error: 'application_id and status required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authorise the ACTION: the caller must be the legitimate actor for THIS entity, and the claimed fact must be true. Recipients are read from
    // the same rows below — nothing in the request body names who gets the push.
    const decision = await authoriseShiftNotify(supabase, caller, { action: 'application_update', applicationId: application_id, status });
    if (!decision.ok) {
      return new Response(JSON.stringify({ error: decision.error }), {
        status: decision.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch application to get worker_id + shift_id
    const { data: app } = await supabase
      .from('shift_applications')
      .select('shift_id, worker_id')
      .eq('id', application_id)
      .single();

    if (!app) {
      return new Response(JSON.stringify({ error: 'Application not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch shift title
    const { data: shift } = await supabase
      .from('shifts').select('title').eq('id', app.shift_id).single();

    const shiftTitle = shift?.title ?? 'a shift';

    // Notify the worker (helper resolves token + honours preferences).
    if (status === 'accepted') {
      await sendUserPush(supabase, {
        userId:     app.worker_id,
        module:     'shifts',
        categoryId: 'shifts.application_accepted',
        title:      "You're confirmed! 🎉",
        body:       `Your application for "${shiftTitle}" has been accepted.`,
        data:       { screen: 'my-shift-applications' },
      });
    } else if (status === 'rejected') {
      const filled = reason === 'filled';
      await sendUserPush(supabase, {
        userId:     app.worker_id,
        module:     'shifts',
        categoryId: 'shifts.application_rejected',
        title:      filled ? 'Shift now filled' : 'Application update',
        body:       filled
          ? `Thanks for applying — "${shiftTitle}" has now been filled.`
          : `Your application for "${shiftTitle}" was not successful this time.`,
        data:       { screen: 'my-shift-applications' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-application-update]', err);
    return new Response(
      JSON.stringify({ error: safeError('notify-application-update', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { authoriseShiftNotify } from '../_shared/shift-notify-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-shift-complete
 *
 * Called when an employer marks a shift as complete.
 * Sends a push notification to every accepted worker on that shift.
 *
 * Body: { shift_id: string }
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
      const limited = await enforceRateLimit('notify-shift-complete', userSubject(caller.userId), ['notify_direct', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    const { shift_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authorise the ACTION: the caller must be the legitimate actor for THIS entity, and the claimed fact must be true. Recipients are read from
    // the same rows below — nothing in the request body names who gets the push.
    const decision = await authoriseShiftNotify(supabase, caller, { action: 'shift_complete', shiftId: shift_id });
    if (!decision.ok) {
      return new Response(JSON.stringify({ error: decision.error }), {
        status: decision.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch shift title
    const { data: shift } = await supabase
      .from('shifts')
      .select('title')
      .eq('id', shift_id)
      .single();

    if (!shift) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all accepted worker IDs for this shift
    const { data: apps } = await supabase
      .from('shift_applications')
      .select('worker_id')
      .eq('shift_id', shift_id)
      .eq('status', 'accepted');

    if (!apps || apps.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const workerIds = apps.map((a: any) => a.worker_id);

    // Notify each accepted worker — the helper honours preferences /
    // quiet hours and resolves their push token.
    await sendUserPushBulk(supabase, workerIds, {
      module:     'shifts',
      categoryId: 'shifts.complete',
      title:      'Shift confirmed! 🎉',
      body:       `Your shift "${shift.title}" has been marked complete by the employer.`,
      data:       { screen: 'my-shift-applications' },
    });

    return new Response(JSON.stringify({ ok: true, sent: workerIds.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-shift-complete]', err);
    return new Response(
      JSON.stringify({ error: safeError('notify-shift-complete', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

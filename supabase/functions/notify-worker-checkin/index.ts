import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-worker-checkin
 *
 * Called when a worker checks in to or finishes a shift.
 * Notifies the employer so they know the worker is on-site / done.
 *
 * Body: { application_id: string; event: 'checked_in' | 'checked_out' }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify caller is a signed-in user
    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Counted against notify_any as well as its own route: the aggregate only
    // means anything if every notification path claims it.
    const limited = await enforceRateLimit('notify-worker-checkin', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { application_id, event } = await req.json();
    if (!application_id || !event) {
      return new Response(JSON.stringify({ error: 'application_id and event required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch application → shift + worker
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

    const [{ data: shift }, { data: worker }] = await Promise.all([
      supabase.from('shifts').select('title, employer_id').eq('id', app.shift_id).single(),
      supabase.from('profiles').select('full_name').eq('id', app.worker_id).single(),
    ]);

    if (!shift) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Notify the employer (helper resolves token + honours preferences).
    const workerName = worker?.full_name ?? 'A worker';

    if (event === 'checked_in') {
      await sendUserPush(supabase, {
        userId:     shift.employer_id,
        module:     'shifts',
        categoryId: 'shifts.worker_checked_in',
        title:      'Worker checked in 📍',
        body:       `${workerName} has checked in for "${shift.title}"`,
        data:       { screen: 'my-posted-shifts' },
      });
    } else if (event === 'checked_out') {
      await sendUserPush(supabase, {
        userId:     shift.employer_id,
        module:     'shifts',
        categoryId: 'shifts.worker_checked_out',
        title:      'Shift finished ✅',
        body:       `${workerName} has finished their shift on "${shift.title}" — confirm when ready`,
        data:       { screen: 'my-posted-shifts' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-worker-checkin]', err);
    return new Response(
      JSON.stringify({ error: safeError('notify-worker-checkin', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

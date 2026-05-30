import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

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

    // Fetch employer push token
    const { data: employer } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('id', shift.employer_id)
      .single();

    if (employer?.push_token) {
      const workerName = worker?.full_name ?? 'A worker';

      if (event === 'checked_in') {
        await sendPush(
          employer.push_token,
          'Worker checked in 📍',
          `${workerName} has checked in for "${shift.title}"`,
          { screen: 'my-posted-shifts' },
        );
      } else if (event === 'checked_out') {
        await sendPush(
          employer.push_token,
          'Shift finished ✅',
          `${workerName} has finished their shift on "${shift.title}" — confirm when ready`,
          { screen: 'my-posted-shifts' },
        );
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-worker-checkin]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

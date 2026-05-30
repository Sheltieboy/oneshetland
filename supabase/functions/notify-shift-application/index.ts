import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-shift-application
 *
 * Called immediately after a worker submits interest in a shift.
 * Looks up the employer and sends them a push notification.
 *
 * Body: { application_id: string }
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

    // Service-role client for DB reads
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify the caller is a signed-in user
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

    const { application_id } = await req.json();
    if (!application_id) {
      return new Response(JSON.stringify({ error: 'application_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the application to get shift_id + worker_id
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

    // Fetch shift title + employer_id, and worker name in parallel
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
      const workerName = worker?.full_name ?? 'Someone';
      await sendPush(
        employer.push_token,
        'New application 📩',
        `${workerName} has applied for "${shift.title}"`,
        { screen: 'employer-applications' },
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-shift-application]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

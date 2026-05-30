import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

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

    const { shift_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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

    // Fetch push tokens for all workers
    const { data: profiles } = await supabase
      .from('profiles')
      .select('push_token')
      .in('id', workerIds);

    // Send to each worker that has a push token
    let sent = 0;
    for (const profile of profiles ?? []) {
      if (profile?.push_token) {
        await sendPush(
          profile.push_token,
          'Shift confirmed! 🎉',
          `Your shift "${shift.title}" has been marked complete by the employer.`,
          { screen: 'my-shift-applications' },
        );
        sent++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-shift-complete]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

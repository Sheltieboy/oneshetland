import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';

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

    const { application_id, status } = await req.json();
    if (!application_id || !status) {
      return new Response(JSON.stringify({ error: 'application_id and status required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
      await sendUserPush(supabase, {
        userId:     app.worker_id,
        module:     'shifts',
        categoryId: 'shifts.application_rejected',
        title:      'Application update',
        body:       `Your application for "${shiftTitle}" was not successful this time.`,
        data:       { screen: 'my-shift-applications' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-application-update]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-drivers
 *
 * Two jobs, selected by `event`:
 *   • event omitted / 'new'  — a customer submitted a new delivery request.
 *     Fan out to every approved driver who has a push token.
 *   • event === 'cancelled'  — a customer cancelled an existing request.
 *     Notify ONLY the assigned driver (via the request's run → driver), and
 *     no one if the request was never matched. (Previously this branch was
 *     ignored, so a cancellation wrongly spammed the whole driver pool with a
 *     "new request" alert and the assigned driver was never told.)
 *
 * Body: { request_id: string, event?: 'new' | 'cancelled' }
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

    // Verify caller is authenticated
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

    const { request_id, event } = await req.json();
    if (!request_id) {
      return new Response(JSON.stringify({ error: 'request_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the request details for the notification message (+ run_id so we
    // can resolve the assigned driver on cancellation)
    const { data: request } = await supabase
      .from('delivery_requests')
      .select('category_slug, pickup_name, destination_area, destination_address, base_fee_pence, run_id')
      .eq('id', request_id)
      .single();

    if (!request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const destination = request.destination_area ?? request.destination_address?.split(',')[0] ?? 'nearby';

    // ── Cancellation: tell only the assigned driver (if the request was matched) ──
    if (event === 'cancelled') {
      if (!request.run_id) {
        // Never matched — no driver to notify.
        return new Response(JSON.stringify({ sent: 0 }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: run } = await supabase
        .from('runs')
        .select('driver_id')
        .eq('id', request.run_id)
        .maybeSingle();

      if (!run?.driver_id) {
        return new Response(JSON.stringify({ sent: 0 }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await sendUserPush(supabase, {
        userId:     run.driver_id,
        module:     'fetch',
        categoryId: 'fetch.request_cancelled',
        title:      'Delivery cancelled',
        body:       `The customer has called off the run to ${destination}.`,
        data:       { request_id, event: 'cancelled' },
      });

      return new Response(JSON.stringify({ sent: 1 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── New request: fan out to all approved drivers ──
    // Fetch IDs of all approved drivers
    const { data: approvedDrivers } = await supabase
      .from('driver_profiles')
      .select('id')
      .eq('driver_status', 'approved');

    if (!approvedDrivers?.length) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const driverIds = approvedDrivers.map((d) => d.id);

    const feeLabel = request.base_fee_pence
      ? ` — £${(request.base_fee_pence / 100).toFixed(2)}`
      : '';
    const body = `${request.pickup_name ?? request.category_slug} → ${destination}${feeLabel}`;

    // Send to all approved drivers — the helper honours each driver's
    // notification preferences / quiet hours and resolves their push token.
    await sendUserPushBulk(supabase, driverIds, {
      module:     'fetch',
      categoryId: 'fetch.new_request',
      title:      'New delivery request 📬',
      body,
      data:       { request_id },
    });

    return new Response(
      JSON.stringify({ sent: approvedDrivers.length }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[notify-drivers]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-drivers
 *
 * Called when a customer submits a new delivery request.
 * Sends a push notification to all approved drivers who have a push token.
 *
 * Body: { request_id: string }
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

    const { request_id } = await req.json();
    if (!request_id) {
      return new Response(JSON.stringify({ error: 'request_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the request details for the notification message
    const { data: request } = await supabase
      .from('delivery_requests')
      .select('category_slug, pickup_name, destination_area, destination_address, base_fee_pence')
      .eq('id', request_id)
      .single();

    if (!request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    // Fetch push tokens for those driver profiles
    const driverIds = approvedDrivers.map((d) => d.id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('push_token')
      .in('id', driverIds)
      .not('push_token', 'is', null);

    if (!profiles?.length) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const destination = request.destination_area ?? request.destination_address?.split(',')[0] ?? 'nearby';
    const feeLabel = request.base_fee_pence
      ? ` — £${(request.base_fee_pence / 100).toFixed(2)}`
      : '';
    const body = `${request.pickup_name ?? request.category_slug} → ${destination}${feeLabel}`;

    // Send to all approved drivers in parallel
    await Promise.allSettled(
      profiles.map((p) => sendPush(p.push_token, 'New delivery request 📬', body, { request_id })),
    );

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

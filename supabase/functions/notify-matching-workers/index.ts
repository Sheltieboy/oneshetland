import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-matching-workers
 *
 * Called after a shift is posted. Finds all workers with an active shift_alert
 * that matches the new shift's category, urgency and pay, then pushes them.
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

    const { shift_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the new shift
    const { data: shift } = await supabase
      .from('shifts')
      .select('title, category, urgency, pay_type, pay_amount, employer_id, location_text')
      .eq('id', shift_id)
      .single();

    if (!shift) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch all active alerts (excluding the employer who posted)
    const { data: alerts } = await supabase
      .from('shift_alerts')
      .select('user_id, categories, urgency, min_pay')
      .eq('is_active', true)
      .neq('user_id', shift.employer_id);

    if (!alerts?.length) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Filter alerts that match this shift
    const matchingUserIds = alerts
      .filter(a => {
        const categoryMatch = a.categories.length === 0 || a.categories.includes(shift.category);
        const urgencyMatch  = a.urgency.length  === 0 || a.urgency.includes(shift.urgency);
        const payMatch      = !a.min_pay
          || shift.pay_type !== 'hourly'
          || !shift.pay_amount
          || shift.pay_amount >= a.min_pay;
        return categoryMatch && urgencyMatch && payMatch;
      })
      .map(a => a.user_id);

    if (!matchingUserIds.length) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Send notifications — the helper honours each worker's preferences /
    // quiet hours and resolves their push token.
    const location = shift.location_text ?? 'Shetland';
    const body = `"${shift.title}" — ${location}`;

    await sendUserPushBulk(supabase, matchingUserIds, {
      module:     'shifts',
      categoryId: 'shifts.new_match',
      title:      'New shift for you 📋',
      body,
      data:       { screen: 'shifts', shift_id },
    });

    return new Response(JSON.stringify({ sent: matchingUserIds.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[notify-matching-workers]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

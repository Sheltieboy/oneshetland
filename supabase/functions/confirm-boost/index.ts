import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * confirm-boost
 *
 * Called immediately after a successful Stripe payment for a shift boost.
 * Sets boosted_until = NOW() + 24 hours, then fires push notifications to
 * all workers whose shift_alerts preferences match this shift.
 *
 * Body: { shift_id: string }
 * Returns: { ok: true, boosted_until: string, notified: number }
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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { shift_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch shift details
    const { data: shift } = await supabase
      .from('shifts')
      .select('id, title, category, urgency, pay_type, pay_amount, employer_id, location_text')
      .eq('id', shift_id)
      .single();

    if (!shift) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (shift.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Set boosted_until to 24 hours from now
    const boostedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('shifts')
      .update({ boosted_until: boostedUntil })
      .eq('id', shift_id);

    // Fetch all active shift alerts (excluding the employer)
    const { data: alerts } = await supabase
      .from('shift_alerts')
      .select('user_id, categories, urgency, min_pay')
      .eq('is_active', true)
      .neq('user_id', shift.employer_id);

    if (!alerts || alerts.length === 0) {
      return new Response(JSON.stringify({ ok: true, boosted_until: boostedUntil, notified: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // JS-side matching (same logic as notify-matching-workers)
    const matchingUserIds: string[] = [];
    for (const alert of alerts) {
      const categoryMatch = alert.categories.length === 0 || alert.categories.includes(shift.category);
      const urgencyMatch  = alert.urgency.length === 0    || alert.urgency.includes(shift.urgency);
      const payMatch      = !alert.min_pay || shift.pay_type !== 'hourly' || (shift.pay_amount ?? 0) >= alert.min_pay;
      if (categoryMatch && urgencyMatch && payMatch) {
        matchingUserIds.push(alert.user_id);
      }
    }

    if (matchingUserIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, boosted_until: boostedUntil, notified: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Notify matching workers (preference-aware: honours each worker's
    // shifts toggle + quiet hours, and logs to their inbox).
    const { sent: notified } = await sendUserPushBulk(supabase, matchingUserIds, {
      module:     'shifts',
      categoryId: 'shifts.new_match',
      title:      '⚡ Featured shift for you',
      body:       `"${shift.title}" — ${shift.location_text}`,
      data:       { screen: 'shifts', shift_id },
    });

    return new Response(
      JSON.stringify({ ok: true, boosted_until: boostedUntil, notified }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[confirm-boost]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';

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

    const { shift_id, payment_intent_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!payment_intent_id) {
      return new Response(JSON.stringify({ error: 'payment_intent_id required' }), {
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

    // Verify the boost was actually PAID FOR. Without this, anyone could call
    // this endpoint with a shift_id and get a free 24h feature + a push blast to
    // every matching worker. Retrieve the PaymentIntent from Stripe and require
    // it to have succeeded and to belong to THIS shift + employer.
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': '2023-10-16' } },
    );
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? `Stripe retrieve failed (HTTP ${piRes.status})`);
    const m = (pi.metadata ?? {}) as Record<string, string>;
    if (pi.status !== 'succeeded' || m.type !== 'shift_boost' || m.shift_id !== shift_id || m.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Payment could not be verified for this boost.' }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Idempotency: claim this PaymentIntent exactly once. A UNIQUE primary key on
    // consumed_payment_intents means a replay (double-tap, or re-using the same
    // payment after the 24h window expires) hits 23505 and is refused here — so a
    // single £2.99 payment can never yield more than one boost or notification blast.
    const { error: claimErr } = await supabase
      .from('consumed_payment_intents')
      .insert({ payment_intent_id, purpose: 'shift_boost', user_id: user.id });
    if (claimErr) {
      if (claimErr.code === '23505') {
        return new Response(JSON.stringify({ ok: true, notified: 0, already: true }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw claimErr;
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
      JSON.stringify({ error: safeError('confirm-boost', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

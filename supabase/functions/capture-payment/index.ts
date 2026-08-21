import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * capture-payment
 *
 * Called when a driver marks a delivery as complete (status: collected → delivered).
 * Captures the pre-authorised PaymentIntent for base fee + any confirmed waiting fee.
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

    // Verify caller
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
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

    // Fetch the request (+ customer_id for notification, + run_id for the auth guard)
    const { data: request, error: reqError } = await supabase
      .from('delivery_requests')
      .select('id, customer_id, payment_intent_id, base_fee_pence, waiting_fee_pence, payment_status, run_id')
      .eq('id', request_id)
      .single();

    if (reqError || !request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authorisation (IDOR guard): only the driver assigned to this delivery's run
    // may capture the customer's card. Prevents a driver capturing a charge on
    // someone else's delivery by passing an arbitrary request_id.
    const { data: run } = await supabase
      .from('runs')
      .select('driver_id')
      .eq('id', request.run_id)
      .single();
    if (!run || run.driver_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not the assigned driver' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!request.payment_intent_id) {
      // No payment intent — mark delivered anyway (e.g. already-paid or legacy requests)
      await supabase
        .from('delivery_requests')
        .update({ status: 'delivered', payment_status: 'unpaid' })
        .eq('id', request_id);

      await sendUserPush(supabase, {
        userId:     request.customer_id,
        module:     'fetch',
        categoryId: 'fetch.delivered',
        title:      'Delivered! 🎉',
        body:       'Your item has arrived.',
        data:       { request_id },
      });

      return new Response(
        JSON.stringify({ captured: false, no_payment_intent: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (request.payment_status === 'captured') {
      return new Response(JSON.stringify({ already_captured: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Service fee was added on top at authorisation; include it so the captured
    // total = delivery fee + service fee + any waiting fee. The driver receives
    // the delivery fee + waiting fee; OneShetland keeps the flat service fee.
    const fetchCfg = await getCommissionConfig(supabase, 'fetch');
    const serviceFeePence = calculateCommission(request.base_fee_pence ?? 0, fetchCfg, 'fetch').fee_pence;
    const totalPence = (request.base_fee_pence ?? 0) + serviceFeePence + (request.waiting_fee_pence ?? 0);

    // If there's a waiting fee, update the PaymentIntent amount before capturing.
    // Recompute the platform fee on the new total so it tracks the final
    // amount charged (matters once the Fetch rate goes percentage-based).
    //
    // We only set application_fee_amount on the update if the original PI was
    // authorised with one — i.e. against a connected driver account. PIs
    // without a transfer_data destination cannot carry an application fee, so
    // we GET the PI to find out reliably rather than guessing from local state.
    if ((request.waiting_fee_pence ?? 0) > 0) {
      const updateBody: Record<string, string> = { amount: String(totalPence) };

      const piGetRes = await fetch(
        `https://api.stripe.com/v1/payment_intents/${request.payment_intent_id}`,
        { headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' } },
      );
      const piExisting = await piGetRes.json();
      if (piGetRes.ok && piExisting.application_fee_amount != null) {
        // Service fee is flat and sits on top — it doesn't grow with the waiting
        // fee, so the driver receives the full delivery + waiting fee.
        updateBody.application_fee_amount = String(serviceFeePence);
      }

      const updateRes = await fetch(`https://api.stripe.com/v1/payment_intents/${request.payment_intent_id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': '2023-10-16',
        },
        body: new URLSearchParams(updateBody),
      });
      if (!updateRes.ok) {
        const updateErr = await updateRes.json();
        throw new Error(`PaymentIntent update failed: ${updateErr.error?.message}`);
      }
    }

    // Capture the payment
    const captureRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${request.payment_intent_id}/capture`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': '2023-10-16',
        },
        body: new URLSearchParams({ amount_to_capture: String(totalPence) }),
      },
    );

    const captured = await captureRes.json();
    if (!captureRes.ok) {
      throw new Error(`Capture failed: ${captured.error?.message}`);
    }

    // Update request to captured + delivered
    await supabase
      .from('delivery_requests')
      .update({
        payment_status: 'captured',
        total_fee_pence: totalPence,
        status: 'delivered',
      })
      .eq('id', request_id);

    // Notify the customer their item has been delivered (preference-aware).
    await sendUserPush(supabase, {
      userId:     request.customer_id,
      module:     'fetch',
      categoryId: 'fetch.delivered',
      title:      'Delivered! 🎉',
      body:       `Your item has arrived. £${(totalPence / 100).toFixed(2)} has been charged to your card.`,
      data:       { request_id },
    });

    return new Response(
      JSON.stringify({ captured: true, total_fee_pence: totalPence }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[capture-payment]', err);
    return new Response(
      JSON.stringify({ error: safeError('capture-payment', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

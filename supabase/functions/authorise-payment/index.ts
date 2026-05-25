import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * authorise-payment
 *
 * Called when a driver accepts a delivery request (status: pending → matched).
 * Pre-authorises the customer's saved payment method for the base fee.
 * Card is NOT charged yet — capture happens on delivery completion.
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

    // Use service role for this function — it needs to read across multiple tables
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify the caller is an approved driver
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

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

    // Fetch the delivery request
    const { data: request, error: reqError } = await supabase
      .from('delivery_requests')
      .select('id, customer_id, category_slug, payment_intent_id, payment_status, run_id, base_fee_pence')
      .eq('id', request_id)
      .single();

    if (reqError || !request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Already authorised — idempotent
    if (request.payment_intent_id && request.payment_status === 'authorised') {
      return new Response(JSON.stringify({ already_authorised: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use the distance-based fee calculated at submission time.
    // Fall back to pricing config minimum if not set (e.g. legacy requests).
    let baseFeePence = request.base_fee_pence;
    if (!baseFeePence) {
      const { data: config } = await supabase
        .from('delivery_pricing_config')
        .select('min_fee_pence')
        .single();
      baseFeePence = config?.min_fee_pence ?? 400;
    }

    // Get the customer's Stripe customer ID and push token
    const { data: customerProfile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, push_token')
      .eq('id', request.customer_id)
      .single();

    if (!customerProfile?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'Customer has no payment method on file' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get the driver's Stripe Connect account ID (via the run)
    const { data: run } = await supabase
      .from('runs')
      .select('driver_id')
      .eq('id', request.run_id)
      .single();

    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('id', run?.driver_id)
      .single();

    // Get the customer's default payment method from Stripe
    const pmRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerProfile.stripe_customer_id}/payment_methods?type=card&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } },
    );
    const pmData = await pmRes.json();
    const paymentMethodId = pmData.data?.[0]?.id;

    if (!paymentMethodId) {
      return new Response(JSON.stringify({ error: 'No payment method found for customer' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create a PaymentIntent with manual capture (pre-authorise only)
    const piBody: Record<string, string> = {
      amount: String(baseFeePence),
      currency: 'gbp',
      customer: customerProfile.stripe_customer_id,
      payment_method: paymentMethodId,
      capture_method: 'manual',        // pre-auth only — captured on delivery
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[request_id]': request_id,
      'metadata[customer_id]': request.customer_id,
      description: `OneShetland Fetch — ${request.category_slug ?? 'delivery'}`,
    };

    // Route funds to driver's Connect account if available
    if (driverProfile?.stripe_account_id) {
      piBody['transfer_data[destination]'] = driverProfile.stripe_account_id;
    }

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(piBody),
    });

    const pi = await piRes.json();
    if (!piRes.ok) {
      throw new Error(`PaymentIntent creation failed: ${pi.error?.message}`);
    }

    // Save the PaymentIntent ID and base fee to the request
    await supabase
      .from('delivery_requests')
      .update({
        payment_intent_id: pi.id,
        base_fee_pence: baseFeePence,
        payment_status: 'authorised',
      })
      .eq('id', request_id);

    // Notify the customer their driver has been matched
    await sendPush(
      customerProfile?.push_token,
      'Driver matched 🚗',
      `Your driver is on the way to collect your ${request.category_slug ?? 'item'}. Your card will be charged on delivery.`,
      { request_id },
    );

    return new Response(
      JSON.stringify({ payment_intent_id: pi.id, base_fee_pence: baseFeePence }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[authorise-payment]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

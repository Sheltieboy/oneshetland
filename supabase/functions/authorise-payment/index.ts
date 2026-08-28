import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { classifyAuthorisation, paymentStatusFor } from '../_shared/fetch-authorisation.ts';
import { defaultCardFor } from '../_shared/saved-card.ts';

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

    // The authoritative fee, written by fetch-quote from a server-measured
    // distance. It is deliberately NOT defaulted: this column used to be set by
    // the customer's browser, and falling back to a minimum would quietly price
    // a delivery nobody had costed. A request that was never priced cannot be
    // authorised — the customer re-opens it and gets a real quote.
    const baseFeePence = request.base_fee_pence;
    if (!baseFeePence || baseFeePence <= 0) {
      return new Response(
        JSON.stringify({ error: 'This delivery has not been priced yet.', code: 'NOT_PRICED' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
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

    // Authorisation (IDOR guard): the caller MUST be the driver assigned to this
    // run. Without this, any approved driver could pre-authorise a charge against
    // another driver's customer's card by passing an arbitrary request_id.
    if (!run || run.driver_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not the assigned driver' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('id', run?.driver_id)
      .single();

    // The card the customer thinks of as theirs — the Customer's DEFAULT,
    // promoting the first card when none is set. `?limit=1` alone returned
    // whatever Stripe listed first, which can differ between two calls.
    const paymentMethodId = await defaultCardFor(stripeKey, customerProfile.stripe_customer_id);

    // No card is NOT a dead end any more. It used to answer the DRIVER with
    // "No payment method found for customer", after they had already accepted,
    // and there was no way for the customer to put that right without starting
    // again. The intent is created without a payment method instead, and the
    // customer completes it themselves through fetch-authorise.

    // Service fee — added ON TOP of the delivery fee so the DRIVER receives the
    // full delivery fee and OneShetland's fee is separate (not skimmed from it).
    const fetchCfg = await getCommissionConfig(supabase, 'fetch');
    const serviceFeePence = calculateCommission(baseFeePence, fetchCfg, 'fetch').fee_pence;

    // Pre-authorise the customer for delivery fee + service fee (manual capture).
    const piBody: Record<string, string> = {
      amount: String(baseFeePence + serviceFeePence),
      currency: 'gbp',
      customer: customerProfile.stripe_customer_id,
      capture_method: 'manual',        // pre-auth only — captured on delivery
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[request_id]': request_id,
      'metadata[customer_id]': request.customer_id,
      'metadata[base_fee_pence]': String(baseFeePence),
      'metadata[application_fee_label]': 'OneShetland service fee',
      'metadata[application_fee_pence]': String(serviceFeePence),
      description: `OneShetland Fetch — ${request.category_slug ?? 'delivery'} (£${(baseFeePence / 100).toFixed(2)} to driver + £${(serviceFeePence / 100).toFixed(2)} service fee)`,
    };

    // Confirm here only when there is a card to confirm against. Without one
    // the intent is created unconfirmed and waits for the customer.
    if (paymentMethodId) {
      piBody.payment_method = paymentMethodId;
      piBody.confirm = 'true';
    }

    // Destination charge to the driver's Connect account. amount includes the
    // service fee; application_fee_amount = service fee, so the driver receives
    // (amount − service fee) = the FULL delivery fee.
    if (driverProfile?.stripe_account_id) {
      piBody['transfer_data[destination]'] = driverProfile.stripe_account_id;
      if (serviceFeePence > 0) {
        piBody['application_fee_amount'] = String(serviceFeePence);
      }
    }

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2023-10-16',
      },
      body: new URLSearchParams(piBody),
    });

    const pi = await piRes.json();
    if (!piRes.ok) {
      throw new Error(`PaymentIntent creation failed: ${pi.error?.message}`);
    }

    // ── What Stripe actually said ────────────────────────────────────────
    //
    // This used to write 'authorised' on the strength of `piRes.ok`. A 200
    // means Stripe accepted the request, not that a hold exists — a card
    // needing 3DS returns 200 with `requires_action`, and one that failed at
    // confirm returns 200 with `requires_payment_method`. Only
    // `requires_capture` is a hold. Anything unrecognised fails closed.
    const outcome = classifyAuthorisation(pi.status);
    const paymentStatus = paymentStatusFor(outcome);

    // The intent id is recorded whatever the outcome: it is what the customer
    // continues, and losing it would strand a live intent nothing points at.
    await supabase
      .from('delivery_requests')
      .update({
        payment_intent_id: pi.id,
        base_fee_pence: baseFeePence,
        payment_status: paymentStatus,
      })
      .eq('id', request_id);

    if (outcome.kind !== 'authorised') {
      // The customer has something to do, and the driver must not be released.
      const needsCustomer = outcome.kind === 'requires_action' || outcome.kind === 'requires_payment_method';
      if (needsCustomer) {
        await sendUserPush(supabase, {
          userId:     request.customer_id,
          module:     'fetch',
          categoryId: 'fetch.driver_matched',
          title:      'Driver found — one thing to do 💳',
          body:       outcome.kind === 'requires_action'
            ? `Open your delivery to confirm the £${((baseFeePence + serviceFeePence) / 100).toFixed(2)} hold with your bank. Nothing has been charged yet.`
            : `Open your delivery to add a card for the £${((baseFeePence + serviceFeePence) / 100).toFixed(2)} hold. Nothing has been charged yet.`,
          data:       { request_id },
        });
      }
      if (outcome.kind === 'unknown') {
        console.error(`[authorise-payment] unrecognised PaymentIntent status for ${request_id}: ${outcome.detail}`);
      }
      return new Response(
        JSON.stringify({
          authorised: false,
          payment_status: paymentStatus,
          requires_customer_action: needsCustomer,
          payment_intent_id: pi.id,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Notify the customer their driver has been matched (preference-aware).
    await sendUserPush(supabase, {
      userId:     request.customer_id,
      module:     'fetch',
      categoryId: 'fetch.driver_matched',
      title:      'Driver matched 🚗',
      body:       `Your driver is on the way to collect your ${request.category_slug ?? 'item'}. Your card will be charged on delivery.`,
      data:       { request_id },
    });

    return new Response(
      JSON.stringify({ authorised: true, payment_status: 'authorised', payment_intent_id: pi.id, base_fee_pence: baseFeePence }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[authorise-payment]', err);
    return new Response(
      JSON.stringify({ error: safeError('authorise-payment', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

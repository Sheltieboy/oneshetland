import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@13?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * create-boost-intent
 *
 * Creates a Stripe PaymentIntent for boosting a shift (£2.99 for 24 hours).
 *
 * Two modes:
 *
 *   use_saved_card = true  (default when has_payment_method is set)
 *     → Charges the user's central saved card off-session immediately.
 *       Returns { charged: true, payment_intent_id }.
 *       No PaymentSheet required on the client.
 *
 *   use_saved_card = false  (fallback — user has no card on file)
 *     → Returns { clientSecret } for the client to present a PaymentSheet.
 *
 * Body: { shift_id: string, use_saved_card?: boolean }
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

    const { shift_id, use_saved_card = false } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Confirm the caller is the employer for this shift
    const { data: shift } = await supabase
      .from('shifts')
      .select('id, title, employer_id')
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

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const intentParams = {
      amount:      299,
      currency:    'gbp',
      metadata: {
        shift_id,
        employer_id: user.id,
        type:        'shift_boost',
      },
      description: `OneShetland Shifts — Boost: "${shift.title}"`,
    };

    // ── Mode 1: charge saved card off-session ─────────────────────────────────
    if (use_saved_card) {
      // Look up the user's central stripe_customer_id
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      const customerId = profile?.stripe_customer_id;
      if (!customerId) {
        return new Response(JSON.stringify({ error: 'No saved card found. Please add a payment card in your account.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Get the customer's default (most recently added) payment method
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type:     'card',
        limit:    1,
      });
      const pm = paymentMethods.data[0];
      if (!pm) {
        return new Response(JSON.stringify({ error: 'No saved card found. Please update your payment card in account settings.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Confirm immediately — off_session means no 3DS prompt for small amounts
      const paymentIntent = await stripe.paymentIntents.create({
        ...intentParams,
        customer:       customerId,
        payment_method: pm.id,
        confirm:        true,
        off_session:    true,
      });

      if (paymentIntent.status !== 'succeeded') {
        return new Response(JSON.stringify({ error: `Payment did not succeed (status: ${paymentIntent.status}). Please check your card.` }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({ charged: true, payment_intent_id: paymentIntent.id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Mode 2: return clientSecret for PaymentSheet (fallback / no saved card) ──
    const paymentIntent = await stripe.paymentIntents.create(intentParams);

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-boost-intent]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

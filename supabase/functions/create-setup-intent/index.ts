import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { canonicalStripeCustomer } from '../_shared/stripe-customer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify the caller is a signed-in OneShetland user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Auth client — used only to verify the caller's identity
    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-setup-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    // Admin client — bypasses RLS for profile reads/writes
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Optional { business_id } in the body — when present we set up a
    // BUSINESS-scoped card (local_businesses.business_stripe_customer_id) instead
    // of the user's central card (profiles.stripe_customer_id). The caller must
    // own the business.
    const body = await req.json().catch(() => ({}));
    const businessId: string | undefined = body?.business_id;

    let stripeCustomerId = '';

    if (businessId) {
      const { data: business, error: bizErr } = await supabase
        .from('local_businesses')
        .select('id, owner_id, name, email, business_stripe_customer_id')
        .eq('id', businessId)
        .single();

      if (bizErr || !business) {
        return new Response(JSON.stringify({ error: 'Business not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (business.owner_id !== user.id) {
        return new Response(JSON.stringify({ error: 'Forbidden — not the business owner' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      stripeCustomerId = business.business_stripe_customer_id ?? '';
      if (!stripeCustomerId) {
        const customerRes = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2023-10-16' },
          body: new URLSearchParams({
            email: business.email ?? user.email ?? '',
            name: business.name ?? '',
            'metadata[supabase_user_id]': user.id,
            'metadata[business_id]': business.id,
          }),
        });
        const customer = await customerRes.json();
        if (!customerRes.ok) throw new Error(`Stripe customer creation failed: ${customer.error?.message}`);
        stripeCustomerId = customer.id;

        await supabase
          .from('local_businesses')
          .update({ business_stripe_customer_id: stripeCustomerId })
          .eq('id', business.id);
      }
    } else {
      // Central (personal) card on the profile.
      //
      // This block used to read the profile, find null, POST /v1/customers and
      // write the id back — a read, a decision and a write with nothing holding
      // the gap. Two concurrent calls both read null, both created, and one
      // Customer was orphaned for ever. It was also the ONLY place in the
      // product that made a Customer at all, which is why Fetch had none to use.
      //
      // Both problems have one answer, and it lives in _shared/stripe-customer.
      // Consolidated here rather than copied: a second customer model is how
      // the two would drift apart.
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();

      const customer = await canonicalStripeCustomer({
        supabase, stripeKey: stripeSecretKey,
        userId: user.id,
        email:  user.email ?? null,
        name:   profile?.full_name ?? null,
      });
      if (customer.kind === 'pending') {
        return new Response(
          JSON.stringify({ error: 'Your payment profile is being set up. Try again in a moment.', code: 'CUSTOMER_IN_FLIGHT' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      if (customer.kind === 'error') throw new Error(customer.message);
      stripeCustomerId = customer.customerId;
    }

    // Create a SetupIntent — this lets the app save a payment method without charging
    const setupRes = await fetch('https://api.stripe.com/v1/setup_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2023-10-16',
      },
      body: new URLSearchParams({
        customer: stripeCustomerId,
        'payment_method_types[]': 'card',
        // Apple Pay and Google Pay come through as 'card' type on mobile
        usage: 'off_session', // allow future charges without the customer being present
      }),
    });

    const setupIntent = await setupRes.json();
    if (!setupRes.ok) {
      throw new Error(`SetupIntent creation failed: ${setupIntent.error?.message}`);
    }

    return new Response(
      JSON.stringify({
        client_secret: setupIntent.client_secret,
        customer_id: stripeCustomerId,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    console.error('[create-setup-intent]', err);
    return new Response(
      JSON.stringify({ error: safeError('create-setup-intent', err) }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});

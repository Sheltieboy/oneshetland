import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    // Fetch the user's profile to check for an existing Stripe customer ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, full_name')
      .eq('id', user.id)
      .single();

    let stripeCustomerId: string = profile?.stripe_customer_id ?? '';

    // Create a Stripe customer if one doesn't exist yet
    if (!stripeCustomerId) {
      const customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          email: user.email ?? '',
          name: profile?.full_name ?? '',
          'metadata[supabase_user_id]': user.id,
        }),
      });

      const customer = await customerRes.json();
      if (!customerRes.ok) {
        throw new Error(`Stripe customer creation failed: ${customer.error?.message}`);
      }

      stripeCustomerId = customer.id;

      // Save the Stripe customer ID back to the profile
      await supabase
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', user.id);
    }

    // Create a SetupIntent — this lets the app save a payment method without charging
    const setupRes = await fetch('https://api.stripe.com/v1/setup_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
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
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if driver already has a Stripe Connect account
    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id, stripe_onboarding_complete')
      .eq('id', user.id)
      .single();

    let stripeAccountId: string = driverProfile?.stripe_account_id ?? '';

    // Create a new Connect account if one doesn't exist
    if (!stripeAccountId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();

      const accountRes = await fetch('https://api.stripe.com/v1/accounts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          type: 'express',                   // Express accounts — Stripe handles KYC UI
          country: 'GB',
          email: user.email ?? '',
          'capabilities[transfers][requested]': 'true',
          'business_type': 'individual',
          'individual[email]': user.email ?? '',
          'metadata[supabase_user_id]': user.id,
        }),
      });

      const account = await accountRes.json();
      if (!accountRes.ok) {
        throw new Error(`Connect account creation failed: ${account.error?.message}`);
      }

      stripeAccountId = account.id;

      // Save the account ID to driver_profiles
      await supabase
        .from('driver_profiles')
        .update({ stripe_account_id: stripeAccountId })
        .eq('id', user.id);
    }

    // If already fully onboarded, just return the account ID
    if (driverProfile?.stripe_onboarding_complete) {
      return new Response(
        JSON.stringify({ already_complete: true, stripe_account_id: stripeAccountId }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Generate a fresh onboarding link (these expire after a few minutes)
    const linkRes = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        account: stripeAccountId,
        refresh_url: 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/connect-redirect?status=refresh',
        return_url: 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/connect-redirect?status=return',
        type: 'account_onboarding',
      }),
    });

    const link = await linkRes.json();
    if (!linkRes.ok) {
      throw new Error(`Account link creation failed: ${link.error?.message}`);
    }

    return new Response(
      JSON.stringify({ url: link.url, stripe_account_id: stripeAccountId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-connect-account]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

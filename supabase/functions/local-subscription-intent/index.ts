import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-subscription-intent
 *
 * In-app Payment Sheet flavour of subscription upgrade.
 * Creates an incomplete Stripe Subscription, returns the data the
 * `@stripe/stripe-react-native` Payment Sheet needs:
 *
 *   { paymentIntent, ephemeralKey, customer, subscriptionId }
 *
 * After the user completes the sheet on-device, Stripe fires
 * `customer.subscription.updated` (status → 'active') and our
 * `stripe-webhook` flips the business's tier in the DB.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 * Optional (env-var fallback if admin_config row is empty):
 *   STRIPE_PRICE_LOCAL_PRO
 *   STRIPE_PRICE_LOCAL_PREMIUM
 *
 * Body: { business_id: string, tier: 'pro' | 'premium' }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { business_id, tier } = await req.json();
    if (!business_id || !['pro', 'premium'].includes(tier)) {
      return json({ error: 'business_id + tier (pro|premium) required' }, 400);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, name, email, stripe_customer_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Price ID — admin_config first, env var fallback
    const configKey = tier === 'premium' ? 'stripe.price.local_premium' : 'stripe.price.local_pro';
    const envFallback = tier === 'premium'
      ? Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM')
      : Deno.env.get('STRIPE_PRICE_LOCAL_PRO');
    const priceId = await getConfig(svc, configKey, envFallback ?? null);
    if (!priceId) {
      return json({ error: `Stripe price ID for ${tier} not configured. Set it in Admin → Config.` }, 500);
    }

    // 1. Create or reuse Stripe customer
    let customerId = business.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: business.email ?? user.email ?? undefined,
        name:  business.name,
        metadata: { business_id, owner_id: user.id, type: 'local_business' },
      });
      customerId = customer.id;
      await svc
        .from('local_businesses')
        .update({ stripe_customer_id: customerId })
        .eq('id', business_id);
    }

    // 2. Create an *incomplete* subscription. Stripe attaches a PaymentIntent
    //    to its first invoice — we use that PaymentIntent's clientSecret in
    //    the Payment Sheet. Once the customer pays, Stripe activates the sub
    //    and fires customer.subscription.updated → our webhook flips the tier.
    const subscription = await stripe.subscriptions.create({
      customer:         customerId,
      items:            [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand:           ['latest_invoice.payment_intent'],
      metadata:         { business_id, owner_id: user.id, tier, type: 'local_subscription' },
    });

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent;
    if (!paymentIntent?.client_secret) {
      return json({ error: 'Stripe did not return a PaymentIntent for the subscription' }, 500);
    }

    // 3. Ephemeral key — lets the Payment Sheet show the customer's saved
    //    payment methods (and remember new ones).
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2023-10-16' },
    );

    return json({
      paymentIntent:    paymentIntent.client_secret,
      ephemeralKey:     ephemeralKey.secret,
      customer:         customerId,
      subscriptionId:   subscription.id,
    });

  } catch (err) {
    console.error('[local-subscription-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

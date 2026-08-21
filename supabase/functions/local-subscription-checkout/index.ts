import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { subscriptionPricesFor, missingPriceError, assertPriceMatches } from '../_shared/tier-price.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-subscription-checkout
 *
 * Creates a Stripe Checkout session for upgrading a local business to a
 * paid tier (Pro or Premium).  The app opens the returned URL in the system
 * browser; once payment succeeds, the stripe-webhook handler flips
 * subscription_tier + subscription_until in the DB.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_PRICE_LOCAL_PRO       — recurring price ID for £19.99/mo
 *   STRIPE_PRICE_LOCAL_PREMIUM   — recurring price ID for £49.99/mo
 *
 * Body: { business_id: string, tier: 'pro' | 'premium', period?: 'monthly' | 'annual' }
 *
 * `period` only applies to premium (annual is twelve months for the price of
 * ten). Defaults to monthly, so existing callers are unaffected.
 * Returns: { url: string }
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

    const { business_id, tier, period = 'monthly' } = await req.json();
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

    // Read from admin_config (DB) with env-var fallback. The admin screen
    // populates these without needing a redeploy.
    const { tierPrice: priceId, meterPrice, configKey, annual } = await subscriptionPricesFor(svc, tier, period);
    if (!priceId) return json({ error: missingPriceError(tier, configKey, annual) }, 500);

    // Never charge a number the site didn't quote. Fails closed.
    const priceProblem = await assertPriceMatches(
      priceId, tier, annual ? 'annual' : 'monthly', Deno.env.get('STRIPE_SECRET_KEY') ?? '',
    );
    if (priceProblem) return json({ error: priceProblem }, 409);

    // Create or reuse customer
    let customerId = business.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: business.email ?? undefined,
        name:  business.name,
        metadata: { business_id, owner_id: user.id, type: 'local_business' },
      });
      customerId = customer.id;
      await svc
        .from('local_businesses')
        .update({ stripe_customer_id: customerId })
        .eq('id', business_id);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      // A metered line item must NOT carry a quantity — Stripe rejects that,
      // because the quantity is whatever usage gets reported.
      line_items: meterPrice
        ? [{ price: priceId, quantity: 1 }, { price: meterPrice }]
        : [{ price: priceId, quantity: 1 }],
      success_url: `${supabaseUrl}/functions/v1/connect-redirect?business=${business_id}&sub=success`,
      cancel_url:  `${supabaseUrl}/functions/v1/connect-redirect?business=${business_id}&sub=cancelled`,
      metadata: { business_id, owner_id: user.id, tier, period: annual ? 'annual' : 'monthly', type: 'local_subscription' },
      subscription_data: {
        metadata: { business_id, owner_id: user.id, tier, period: annual ? 'annual' : 'monthly' },
      },
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('[local-subscription-checkout]', err);
    return json({ error: safeError('local-subscription-checkout', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

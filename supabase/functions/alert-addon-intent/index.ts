import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * alert-addon-intent
 *
 * Creates a Stripe subscription for the £10/month Urgent Alerts add-on.
 *
 * If the customer already has a saved default payment method the subscription
 * is confirmed server-side immediately — no Payment Sheet needed, the app just
 * polls until the webhook flips the status to 'active'.
 *
 * If there is no saved payment method the function returns Payment Sheet params
 * so the app can present the card collection UI.
 *
 * Response variants:
 *   { activated: true }                                  — charged silently
 *   { paymentIntent, ephemeralKey, customer, subscriptionId } — needs Payment Sheet
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

    const { business_id } = await req.json();
    if (!business_id) return json({ error: 'business_id required' }, 400);

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, name, email, stripe_customer_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const { data: access } = await svc
      .from('business_alert_access')
      .select('id, status')
      .eq('business_id', business_id)
      .maybeSingle();

    if (!access) return json({ error: 'No alert access request found' }, 400);
    if (access.status === 'active') return json({ error: 'Alert access is already active' }, 400);
    if (access.status !== 'approved') return json({ error: 'Alert access has not been approved yet' }, 400);

    const priceId = await getConfig(
      svc,
      'stripe.price.alert_addon',
      Deno.env.get('STRIPE_PRICE_ALERT_ADDON') ?? null,
    );
    if (!priceId) {
      return json({ error: 'Alert add-on price ID not configured. Set stripe.price.alert_addon in Admin → Config.' }, 500);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // ── Resolve Stripe customer ──────────────────────────────────────────────
    let customerId = business.stripe_customer_id as string | null;

    if (!customerId) {
      const { data: profile } = await svc
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .maybeSingle();

      if (profile?.stripe_customer_id) {
        customerId = profile.stripe_customer_id as string;
        await svc.from('local_businesses').update({ stripe_customer_id: customerId }).eq('id', business_id);
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: business.email ?? user.email ?? undefined,
        name:  business.name,
        metadata: { business_id, owner_id: user.id, type: 'local_business' },
      });
      customerId = customer.id;
      await svc.from('local_businesses').update({ stripe_customer_id: customerId }).eq('id', business_id);
    }

    // ── Check for a saved default payment method ─────────────────────────────
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    const defaultPaymentMethod =
      customer.invoice_settings?.default_payment_method as string | null ?? null;

    // Also check if there are any payment methods attached even if not set as default
    let paymentMethodId = defaultPaymentMethod;
    if (!paymentMethodId) {
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      if (methods.data.length > 0) {
        paymentMethodId = methods.data[0].id;
        // Set it as the default so future charges use it automatically
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
      }
    }

    const subMetadata = { business_id, owner_id: user.id, type: 'alert_addon' };

    // ── Create subscription (works for both saved-card and no-card paths) ──────
    // Always use default_incomplete so we get a PaymentIntent we can inspect.
    const subscription = await stripe.subscriptions.create({
      customer:           customerId,
      items:              [{ price: priceId }],
      ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
      payment_behavior:   'default_incomplete',
      payment_settings:   { save_default_payment_method: 'on_subscription' },
      expand:             ['latest_invoice.payment_intent'],
      metadata:           subMetadata,
    });

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent;

    // If the subscription is already active (e.g. trialing, or Stripe confirmed
    // the saved card immediately), activate in DB and tell the client — no sheet needed.
    if (['active', 'trialing'].includes(subscription.status)) {
      await svc.from('business_alert_access').update({
        status:                 'active',
        activated_at:           new Date().toISOString(),
        stripe_subscription_id: subscription.id,
      }).eq('business_id', business_id);

      return json({ activated: true, subscriptionId: subscription.id });
    }

    // PaymentIntent exists and needs confirmation (saved card that needs action,
    // or no card yet) — return Payment Sheet params so the app can handle it.
    if (!paymentIntent?.client_secret) {
      return json({ error: 'Stripe did not return a PaymentIntent for the subscription' }, 500);
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2023-10-16' },
    );

    return json({
      paymentIntent:  paymentIntent.client_secret,
      ephemeralKey:   ephemeralKey.secret,
      customer:       customerId,
      subscriptionId: subscription.id,
    });

  } catch (err) {
    console.error('[alert-addon-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

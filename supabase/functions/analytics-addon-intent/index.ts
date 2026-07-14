import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getAddonPrice } from '../_shared/admin-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * analytics-addon-intent
 *
 * In-app (Payment Sheet, NOT hosted checkout) £10/mo Analytics add-on as a
 * Stripe subscription — available on ANY tier incl. free. Mirrors
 * alert-addon-intent. Uses the business's saved card if there is one (charged
 * silently), otherwise returns Payment Sheet params so the app collects a card.
 * Stripe auto-renews; the stripe-webhook (type 'analytics_addon') flips
 * business_addons.analytics.enabled on active/lapse.
 *
 * Price: admin_config `stripe.price.analytics_addon` (env STRIPE_PRICE_ANALYTICS_ADDON).
 *
 * Response: { activated: true } | { paymentIntent, ephemeralKey, customer, subscriptionId }
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
      .select('id, owner_id, name, email, stripe_customer_id, business_stripe_customer_id, has_business_payment_method')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const { data: addon } = await svc
      .from('business_addons')
      .select('enabled')
      .eq('business_id', business_id)
      .eq('addon_key', 'analytics')
      .maybeSingle();
    if (addon?.enabled) return json({ error: 'Analytics add-on is already active.' }, 409);

    const priceId = await getAddonPrice(
      svc, 'stripe.price.analytics_addon',
      Deno.env.get('STRIPE_PRICE_ANALYTICS_ADDON') ?? Deno.env.get('STRIPE_PRICE_ADDON') ?? null,
    );
    if (!priceId) {
      return json({ error: 'Add-on price not configured. Set stripe.price.addon in Admin → Config.' }, 500);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // ── Pick the card to charge: BUSINESS card first, then PERSONAL ──────────
    // Cards live on SEPARATE Stripe customers: the business card on
    // local_businesses.business_stripe_customer_id, the owner's personal card on
    // profiles.stripe_customer_id. (local_businesses.stripe_customer_id is the
    // tier-SUBSCRIPTION customer and usually has no card — checking it was the
    // bug that forced card re-entry.) The subscription is created on whichever
    // customer holds the card, so a saved card is charged silently. Only if
    // NEITHER has a card do we collect one.
    const { data: prof } = await svc.from('profiles')
      .select('stripe_customer_id, has_payment_method').eq('id', user.id).maybeSingle();

    let customerId: string | null = null;
    let paymentMethodId: string | null = null;

    if (business.has_business_payment_method && business.business_stripe_customer_id) {
      const pm = await firstCard(stripe, business.business_stripe_customer_id as string);
      if (pm) { customerId = business.business_stripe_customer_id as string; paymentMethodId = pm; }
    }
    if (!customerId && prof?.has_payment_method && prof.stripe_customer_id) {
      const pm = await firstCard(stripe, prof.stripe_customer_id as string);
      if (pm) { customerId = prof.stripe_customer_id as string; paymentMethodId = pm; }
    }
    // No saved card anywhere → use/create the business-card customer and collect one.
    if (!customerId) {
      customerId = (business.business_stripe_customer_id as string | null) ?? (business.stripe_customer_id as string | null);
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: business.email ?? user.email ?? undefined,
          name:  business.name,
          metadata: { business_id, owner_id: user.id, type: 'local_business' },
        });
        customerId = customer.id;
        await svc.from('local_businesses').update({ business_stripe_customer_id: customerId }).eq('id', business_id);
      }
    }

    const subMetadata = { business_id, owner_id: user.id, type: 'analytics_addon' };
    const subscription = await stripe.subscriptions.create({
      customer:         customerId,
      items:            [{ price: priceId }],
      ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand:           ['latest_invoice.payment_intent'],
      metadata:         subMetadata,
    });

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent;

    // Saved card → confirm the first invoice OFF-SESSION so it charges silently
    // (default_incomplete does not auto-charge). Same pattern as the one-off
    // charges. Only falls through to a card form if there's no saved card or the
    // card needs authentication (3DS) / is declined.
    const alreadyPaid = ['active', 'trialing'].includes(subscription.status) || paymentIntent?.status === 'succeeded';
    if (!alreadyPaid && paymentMethodId && paymentIntent?.id) {
      try {
        const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
          payment_method: paymentMethodId, off_session: true,
        });
        if (confirmed.status === 'succeeded') {
          await svc.from('business_addons')
            .update({ enabled: true, config: { method: 'card', subscription_id: subscription.id } })
            .eq('business_id', business_id).eq('addon_key', 'analytics');
          return json({ activated: true, subscriptionId: subscription.id });
        }
      } catch (_e) { /* needs auth / declined → fall through to client confirmation */ }
    } else if (alreadyPaid) {
      await svc.from('business_addons')
        .update({ enabled: true, config: { method: 'card', subscription_id: subscription.id } })
        .eq('business_id', business_id).eq('addon_key', 'analytics');
      return json({ activated: true, subscriptionId: subscription.id });
    }

    if (!paymentIntent?.client_secret) {
      return json({ error: 'Stripe did not return a PaymentIntent for the subscription' }, 500);
    }
    const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customerId }, { apiVersion: '2023-10-16' });

    return json({
      paymentIntent:  paymentIntent.client_secret,
      ephemeralKey:   ephemeralKey.secret,
      customer:       customerId,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    console.error('[analytics-addon-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// Returns a customer's default card payment method (or its first attached card),
// setting it as default for future renewals. Null if the customer has no card.
async function firstCard(stripe: Stripe, customerId: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    const def = (customer.invoice_settings?.default_payment_method as string | null) ?? null;
    if (def) return def;
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    if (methods.data.length > 0) {
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: methods.data[0].id } });
      return methods.data[0].id;
    }
  } catch (_e) { /* treat as no card */ }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}


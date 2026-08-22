import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';
import { subscriptionPricesFor, missingPriceError, assertPriceMatches } from '../_shared/tier-price.ts';
import { safeError } from '../_shared/safe-error.ts';

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
 * Body: { business_id: string, tier: 'pro' | 'premium', period?: 'monthly' | 'annual' }
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
      .select('id, owner_id, name, email, stripe_customer_id, business_stripe_customer_id, has_business_payment_method, stripe_subscription_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // This endpoint creates a NEW subscription. If a LIVE one already exists, a
    // retry or mis-routed call would create a second that bills every month, so
    // plan changes must go through local-subscription-change.
    //
    // But an id on the row is not proof of a live subscription. A cancelled one
    // left its id behind, and refusing on the id alone locked the business out
    // of buying anything at all — it was told to "use change-plan", and
    // change-plan looked at the same dead subscription and said it was already
    // on that tier. So ask Stripe rather than trusting the column, and clear it
    // when the answer is that nothing is running.
    if (business.stripe_subscription_id) {
      let live = false;
      try {
        const existing = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
        live = !['canceled', 'incomplete_expired'].includes(existing.status);
      } catch {
        live = false; // Stripe doesn't know it — treat as gone.
      }
      if (live) {
        return json({ error: 'This business already has a subscription. Use change-plan to switch tiers.', code: 'ALREADY_SUBSCRIBED' }, 409);
      }
      await svc.from('local_businesses')
        .update({ stripe_subscription_id: null })
        .eq('id', business_id);
    }

    // Price ID — admin_config first, env var fallback
    const { tierPrice: priceId, meterPrice, configKey, annual } = await subscriptionPricesFor(svc, tier, period);
    if (!priceId) return json({ error: missingPriceError(tier, configKey, annual) }, 500);

    // Never charge a number the site didn't quote. Fails closed.
    const priceProblem = await assertPriceMatches(
      priceId, tier, annual ? 'annual' : 'monthly', Deno.env.get('STRIPE_SECRET_KEY') ?? '',
    );
    if (priceProblem) return json({ error: priceProblem }, 409);

    // 1. Pick the card: BUSINESS card → PERSONAL card → the sub-customer's own
    //    saved card. The subscription is created on whichever customer holds the
    //    card, and we CONSOLIDATE local_businesses.stripe_customer_id onto it so
    //    the billing portal / plan-changes / add-on line-items keep working.
    //    First-time-only (upgrades use local-subscription-change), so reassigning
    //    is safe. A saved card is charged silently; only a no-card business sees
    //    the card form.
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
    if (!customerId && business.stripe_customer_id) {
      customerId = business.stripe_customer_id as string;
      paymentMethodId = await firstCard(stripe, customerId);
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: business.email ?? user.email ?? undefined,
        name:  business.name,
        metadata: { business_id, owner_id: user.id, type: 'local_business' },
      });
      customerId = customer.id;
    }
    if (customerId !== business.stripe_customer_id) {
      await svc.from('local_businesses').update({ stripe_customer_id: customerId }).eq('id', business_id);
    }

    // 2. Create an *incomplete* subscription so we get a PaymentIntent to inspect.
    const subscription = await stripe.subscriptions.create({
      customer:         customerId,
      // Pro carries the metered bookings price as a second item. Without it
      // there is nothing for meter-bookings to report usage against.
      items:            meterPrice ? [{ price: priceId }, { price: meterPrice }] : [{ price: priceId }],
      ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand:           ['latest_invoice.payment_intent'],
      metadata:         { business_id, owner_id: user.id, tier, period: annual ? 'annual' : 'monthly', type: 'local_subscription' },
    });

    // deno-lint-ignore no-explicit-any
    const latestInvoice = subscription.latest_invoice as any;
    const paymentIntent = latestInvoice?.payment_intent;

    // 3. Saved card → confirm ON-SESSION. This is the FIRST payment of a new
    //    subscription and the owner is sitting there having just chosen a tier, so
    //    Stripe is told the customer is present and decides whether the issuer must
    //    challenge them. Later renewals are off-session and Stripe drives those
    //    itself through the invoice — nothing here affects them.
    //
    //    A card needing authentication falls through to the card form below, which
    //    returns THIS subscription's existing PaymentIntent client secret plus an
    //    ephemeral key. The same intent is completed, never a second one.
    const alreadyPaid = ['active', 'trialing'].includes(subscription.status) || paymentIntent?.status === 'succeeded';
    if (alreadyPaid) return json({ activated: true, subscriptionId: subscription.id });
    if (paymentMethodId && paymentIntent?.id) {
      try {
        const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, { payment_method: paymentMethodId, use_stripe_sdk: true });
        if (confirmed.status === 'succeeded') return json({ activated: true, subscriptionId: subscription.id });
      } catch (_e) { /* needs auth / declined → fall through to card form */ }
    }

    if (!paymentIntent?.client_secret) {
      return json({ error: 'Stripe did not return a PaymentIntent for the subscription' }, 500);
    }

    // 4. Ephemeral key — lets the sheet/Elements show the customer's saved cards.
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
    return json({ error: safeError('local-subscription-intent', err) }, 500);
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

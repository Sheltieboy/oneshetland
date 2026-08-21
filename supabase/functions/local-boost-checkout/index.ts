import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-boost-checkout
 *
 * One-time payment for a short block of Pro features (1, 2 or 3 weeks).
 * Returns the bits the @stripe/stripe-react-native Payment Sheet needs:
 *
 *   { paymentIntent, ephemeralKey, customer, amountPence, weeks }
 *
 * On successful payment, stripe-webhook handles the
 * payment_intent.succeeded event with metadata.type=local_boost and:
 *   • extends local_businesses.subscription_until by N weeks
 *   • sets subscription_tier='pro'
 *   • inserts a row into local_boost_purchases
 *
 * Body: { business_id: string, weeks: 1 | 2 | 3 }
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

    const { business_id, weeks } = await req.json();
    if (!business_id || ![1, 2, 3].includes(weeks)) {
      return json({ error: 'business_id + weeks (1|2|3) required' }, 400);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, name, email, stripe_customer_id, business_stripe_customer_id, has_business_payment_method, stripe_subscription_id, subscription_tier')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // Block boosts on businesses that already have an active monthly subscription
    // — no point paying for a boost when you're already paying monthly.
    if (business.stripe_subscription_id) {
      return json({
        error: 'You\'re already on a monthly plan. Cancel it first if you want to switch to boosts.',
      }, 400);
    }

    // Resolve price for the chosen duration
    const priceKey = `boost.price.${weeks}_week_pence`;
    const priceStr = await getConfig(svc, priceKey, null);
    if (!priceStr) {
      return json({ error: `Boost price for ${weeks} week(s) not configured. Set it in Admin → Config.` }, 500);
    }
    const amountPence = parseInt(priceStr, 10);
    if (!amountPence || amountPence <= 0) {
      return json({ error: `Boost price for ${weeks} week(s) is invalid (got "${priceStr}").` }, 500);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Try to charge a SAVED card silently first: business card → personal card.
    // (off_session + confirm is your proven one-off pattern.) Only if there's no
    // saved card, or it needs 3DS / is declined, do we fall through to the card
    // form below.
    const { data: prof } = await svc.from('profiles')
      .select('stripe_customer_id, has_payment_method').eq('id', user.id).maybeSingle();
    let cardCustomer: string | null = null;
    let cardPm: string | null = null;
    if (business.has_business_payment_method && business.business_stripe_customer_id) {
      const pm = await firstCard(stripe, business.business_stripe_customer_id as string);
      if (pm) { cardCustomer = business.business_stripe_customer_id as string; cardPm = pm; }
    }
    if (!cardCustomer && prof?.has_payment_method && prof.stripe_customer_id) {
      const pm = await firstCard(stripe, prof.stripe_customer_id as string);
      if (pm) { cardCustomer = prof.stripe_customer_id as string; cardPm = pm; }
    }
    if (cardCustomer && cardPm) {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: amountPence, currency: 'gbp', customer: cardCustomer,
          payment_method: cardPm, off_session: true, confirm: true,
          description: `OneShetland Local · ${weeks}-week Pro boost · ${business.name}`,
          metadata: { type: 'local_boost', business_id, owner_id: user.id, weeks: String(weeks), amount_pence: String(amountPence) },
        });
        if (pi.status === 'succeeded') {
          await svc.from('local_boost_purchases').insert({
            business_id, owner_id: user.id, weeks, amount_pence: amountPence,
            stripe_payment_intent_id: pi.id, status: 'pending',
          });
          return json({ charged: true, payment_intent_id: pi.id, amountPence, weeks });
        }
      } catch (_e) { /* declined / needs auth → fall through to the card form */ }
    }

    // Create or reuse customer
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

    // One-time PaymentIntent (NOT a subscription)
    const paymentIntent = await stripe.paymentIntents.create({
      amount:    amountPence,
      currency:  'gbp',
      customer:  customerId,
      automatic_payment_methods: { enabled: true },
      description: `OneShetland Local · ${weeks}-week Pro boost · ${business.name}`,
      metadata: {
        type:         'local_boost',
        business_id,
        owner_id:     user.id,
        weeks:        String(weeks),
        amount_pence: String(amountPence),
      },
    });

    // Ephemeral key for the Payment Sheet (saved payment methods access)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2023-10-16' },
    );

    // Log the pending purchase so we have an audit trail even if the webhook
    // is slow. The webhook will flip status to 'succeeded' on confirmation.
    await svc.from('local_boost_purchases').insert({
      business_id,
      owner_id:                 user.id,
      weeks,
      amount_pence:             amountPence,
      stripe_payment_intent_id: paymentIntent.id,
      status:                   'pending',
    });

    return json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey:  ephemeralKey.secret,
      customer:      customerId,
      amountPence,
      weeks,
    });

  } catch (err) {
    console.error('[local-boost-checkout]', err);
    return json({ error: safeError('local-boost-checkout', err) }, 500);
  }
});

// Returns a customer's default card payment method (or its first attached card).
// Null if the customer has no card.
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

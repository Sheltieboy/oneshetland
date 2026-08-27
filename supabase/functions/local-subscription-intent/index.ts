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

    const { business_id, tier, period = 'monthly', client_request_id } = await req.json();
    if (!business_id || !['pro', 'premium'].includes(tier)) {
      return json({ error: 'business_id + tier (pro|premium) required' }, 400);
    }
    // Validated before anything is created, so a malformed attempt costs
    // nothing. Shape only — the reference is a de-duplication key, never
    // authority for who may buy what.
    if (typeof client_request_id !== 'string') {
      return json({ error: 'client_request_id required' }, 400);
    }
    if (client_request_id.length < 8 || client_request_id.length > 100) {
      return json({ error: 'client_request_id must be 8-100 characters' }, 400);
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

    // ── One deliberate checkout, one subscription ─────────────────────────
    //
    // Claimed AFTER ownership is proven and BEFORE Stripe is touched. The
    // primary key inside decides concurrent duplicates, so twenty simultaneous
    // identical requests produce exactly one 'claimed'.
    //
    // The fingerprint binds the reference to this person, this business, this
    // tier and this period. Reused for anything else it conflicts rather than
    // handing back another checkout's subscription.
    const period_norm = period === 'annual' ? 'annual' : 'monthly';
    const fingerprint = `${user.id}:${business_id}:${tier}:${period_norm}`;
    const { data: claimRows, error: claimErr } = await svc.rpc('claim_subscription_attempt', {
      p_request_id:  client_request_id,
      p_user:        user.id,
      p_business:    business_id,
      p_tier:        tier,
      p_period:      period_norm,
      p_fingerprint: fingerprint,
    });
    if (claimErr) {
      console.error('[local-subscription-intent] claim failed', claimErr);
      return json({ error: 'Could not start the subscription. Nothing has been charged.' }, 500);
    }
    const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
      { outcome: string; status: string; stripe_subscription_id: string | null; result: unknown } | null;

    if (claim?.outcome === 'conflict') {
      return json({
        error: 'That checkout reference belongs to a different purchase. Please start again.',
        code:  'ATTEMPT_CONFLICT',
      }, 409);
    }
    if (claim?.outcome === 'in_flight') {
      // A duplicate that has not reached Stripe yet. Ask for a retry rather
      // than racing it — the other request is about to create the subscription.
      return json({ error: 'This subscription is already being set up. Please try again in a moment.', code: 'IN_FLIGHT' }, 409);
    }
    // Already reached Stripe. Hand back THAT subscription — never make another.
    if ((claim?.outcome === 'resume' || claim?.outcome === 'replay') && claim.stripe_subscription_id) {
      return await resumeExisting(stripe, claim.stripe_subscription_id, svc, client_request_id);
    }

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
        // Release the claim. Otherwise this attempt sits in_flight for ever and
        // a retry is told "already being set up" instead of the real reason.
        await svc.rpc('settle_subscription_attempt', {
          p_request_id: client_request_id, p_status: 'failed',
          p_result: { reason: 'already_subscribed' },
        });
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
    if (priceProblem) {
      await svc.rpc('settle_subscription_attempt', {
        p_request_id: client_request_id, p_status: 'failed', p_result: { reason: 'price_mismatch' },
      });
      return json({ error: priceProblem }, 409);
    }

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
      // Records who pays for this business. Sharing one Customer across the
      // businesses one person owns is legitimate, so this no longer collides —
      // but the error is read, because a business that could not record its
      // payer must not go on to be charged.
      const { error: bindErr } = await svc.from('local_businesses')
        .update({ stripe_customer_id: customerId }).eq('id', business_id);
      if (bindErr) {
        console.error('[local-subscription-intent] could not record the payer', bindErr);
        await svc.rpc('settle_subscription_attempt', {
          p_request_id: client_request_id, p_status: 'failed', p_result: { reason: 'customer_bind_failed' },
        });
        return json({ error: 'Could not start the subscription. Nothing has been charged.' }, 500);
      }
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
    }, {
      // Deterministic, derived from the authoritative identities plus the
      // attempt reference. The belt to the registry's braces: if this request
      // is retried at the HTTP layer after Stripe already created the
      // subscription, Stripe returns the SAME one rather than a second.
      idempotencyKey: `local-sub-${user.id}-${business_id}-${tier}-${period_norm}-${client_request_id}`,
    });

    // Recorded BEFORE the first payment is confirmed. If this request dies
    // mid-confirm, the retry finds the subscription here and resumes it.
    await svc.rpc('settle_subscription_attempt', {
      p_request_id: client_request_id, p_status: 'in_flight', p_sub_id: subscription.id,
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
    const settleDone = async () => {
      await svc.rpc('settle_subscription_attempt', {
        p_request_id: client_request_id, p_status: 'completed', p_sub_id: subscription.id,
        p_result: { activated: true },
      });
    };

    const alreadyPaid = ['active', 'trialing'].includes(subscription.status) || paymentIntent?.status === 'succeeded';
    if (alreadyPaid) { await settleDone(); return json({ activated: true, subscriptionId: subscription.id }); }
    if (paymentMethodId && paymentIntent?.id) {
      try {
        const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, { payment_method: paymentMethodId, use_stripe_sdk: true });
        if (confirmed.status === 'succeeded') { await settleDone(); return json({ activated: true, subscriptionId: subscription.id }); }
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

/**
 * Hand back a subscription this attempt already created.
 *
 * Re-read from Stripe rather than from anything stored here, so the customer
 * gets the SAME subscription, the SAME first invoice and the SAME
 * PaymentIntent — including its live status. Storing the client secret would
 * have risked serving a stale one; Stripe stays the single source.
 */
async function resumeExisting(
  stripe: Stripe,
  subscriptionId: string,
  // deno-lint-ignore no-explicit-any
  svc: any,
  requestId: string,
): Promise<Response> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });
    // deno-lint-ignore no-explicit-any
    const pi = (sub.latest_invoice as any)?.payment_intent;

    // A subscription that has been cancelled or that Stripe expired is spent.
    // Resuming it would hand back a dead checkout for ever, and — because its
    // last invoice may well have been paid before it was cancelled — reading
    // that old succeeded PaymentIntent as "activated" would tell somebody with
    // no subscription that they had one. Retire the attempt so a fresh,
    // deliberate purchase can be made.
    if (['canceled', 'incomplete_expired'].includes(sub.status)) {
      await svc.rpc('settle_subscription_attempt', {
        p_request_id: requestId, p_status: 'failed', p_result: { reason: sub.status },
      });
      return json({
        error: 'That checkout has expired. Please choose your plan again.',
        code:  'ATTEMPT_TERMINAL',
      }, 409);
    }

    // Live only. The subscription's own status decides, not an old invoice.
    if (['active', 'trialing'].includes(sub.status)) {
      return json({ activated: true, subscriptionId: sub.id });
    }
    if (!pi?.client_secret) {
      return json({ error: 'This subscription is still being set up. Please try again in a moment.', code: 'IN_FLIGHT' }, 409);
    }
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: sub.customer as string }, { apiVersion: '2023-10-16' },
    );
    return json({
      paymentIntent:  pi.client_secret,
      ephemeralKey:   ephemeralKey.secret,
      customer:       sub.customer as string,
      subscriptionId: sub.id,
      resumed:        true,
    });
  } catch (e) {
    console.error('[local-subscription-intent] resume failed', e);
    return json({ error: 'Could not resume the subscription. Nothing further has been charged.' }, 502);
  }
}

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

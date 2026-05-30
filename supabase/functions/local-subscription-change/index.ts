import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-subscription-change
 *
 * Modifies an *existing* Stripe subscription to a new price/tier, with
 * proration. Two modes:
 *
 *   preview = true   → returns the prorated amount + next renewal date
 *                      without changing anything. Used by the app to show
 *                      a confirmation dialog.
 *
 *   preview = false  → actually applies the change. Stripe charges the
 *                      saved payment method for the prorated amount.
 *
 * Free-tier businesses should use `createSubscriptionIntent` instead — this
 * function returns 409 if there's no existing subscription.
 *
 * Body: { business_id: string, tier: 'pro' | 'premium', preview: boolean }
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

    const { business_id, tier, preview } = await req.json();
    if (!business_id || !['pro', 'premium'].includes(tier)) {
      return json({ error: 'business_id + tier (pro|premium) required' }, 400);
    }
    if (typeof preview !== 'boolean') {
      return json({ error: 'preview (boolean) required' }, 400);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, stripe_customer_id, stripe_subscription_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!business.stripe_subscription_id) {
      return json({
        error: 'No active subscription. Use createSubscriptionIntent for first-time subscribers.',
        code:  'NO_EXISTING_SUBSCRIPTION',
      }, 409);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Resolve the new price ID
    const configKey = tier === 'premium' ? 'stripe.price.local_premium' : 'stripe.price.local_pro';
    const envFallback = tier === 'premium'
      ? Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM')
      : Deno.env.get('STRIPE_PRICE_LOCAL_PRO');
    const newPriceId = await getConfig(svc, configKey, envFallback ?? null);
    if (!newPriceId) {
      return json({ error: `Stripe price ID for ${tier} not configured. Set it in Admin → Config.` }, 500);
    }

    // Fetch the live subscription to get its item id + check current price
    const subscription = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
    const item = subscription.items.data[0];
    if (!item) return json({ error: 'Subscription has no items' }, 500);

    if (item.price.id === newPriceId) {
      return json({ noChange: true, message: 'Already on this plan.' });
    }

    // ── Preview mode ──────────────────────────────────────────────────────
    if (preview) {
      // Stripe SDK v17 names this `createPreview` (was previously `retrieveUpcoming`).
      // The returned invoice represents the COMBINED next invoice = proration
      // adjustments PLUS the next full renewal period charge. We only want to
      // show the user the proration amount (what they pay TODAY), so we filter
      // to line items marked `proration: true`.
      // deno-lint-ignore no-explicit-any
      const invoice = await (stripe.invoices as any).createPreview({
        customer:     business.stripe_customer_id,
        subscription: business.stripe_subscription_id,
        subscription_details: {
          items:              [{ id: item.id, price: newPriceId }],
          proration_behavior: 'create_prorations',
        },
      });

      // Sum only the proration line items — these are the immediate charge.
      // Non-proration lines belong to the next renewal period and aren't due now.
      // deno-lint-ignore no-explicit-any
      const lines: Array<any> = invoice.lines?.data ?? [];
      const prorationPence = lines
        .filter(l => l.proration === true)
        .reduce((sum: number, l: any) => sum + (l.amount as number), 0);

      // current_period_end is per-item in newer API versions
      const periodEndSec = (item as any).current_period_end as number | undefined;
      const premiumPrice = await getConfig(svc, 'stripe.price.local_premium', null);

      return json({
        previewAmountPence:  prorationPence,
        currency:            invoice.currency,
        nextRenewalAt:       periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
        currentTier:         item.price.id === premiumPrice ? 'premium' : 'pro',
        newTier:             tier,
      });
    }

    // ── Apply mode ────────────────────────────────────────────────────────
    // Modify the subscription. proration_behavior: 'create_prorations'
    // → Stripe creates prorated line items and bills them on a new invoice
    //   (paid immediately by the saved payment method).
    // cancel_at_period_end: false
    // → if a cancellation was pending, the user is now committing to staying.
    const updated = await stripe.subscriptions.update(business.stripe_subscription_id, {
      items: [{ id: item.id, price: newPriceId }],
      proration_behavior:   'create_prorations',
      cancel_at_period_end: false,
      metadata: { ...subscription.metadata, tier },
    });

    // The webhook will fire customer.subscription.updated and flip the tier
    // in our DB. Return success.
    return json({ success: true, subscriptionId: updated.id });

  } catch (err) {
    console.error('[local-subscription-change]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

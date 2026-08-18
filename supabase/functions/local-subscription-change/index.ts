import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { subscriptionPricesFor, resolveBookingMeterPrice, resolveTierPrice, missingPriceError, assertPriceMatches } from '../_shared/tier-price.ts';
import { splitInvoice } from '../_shared/invoice-lines.ts';

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

    const { business_id, tier, preview, period = 'monthly' } = await req.json();
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

    // Resolve the new price. Switching monthly <-> annual on the SAME tier is a
    // real change even though the tier is unchanged, which is why period is part
    // of the lookup rather than an afterthought.
    const { tierPrice: newPriceId, meterPrice, configKey, annual } = await subscriptionPricesFor(svc, tier, period);
    // The meter price may exist on the CURRENT subscription even when moving to a
    // tier that shouldn't have it, so resolve it regardless of the target tier.
    const bookingMeterPrice = await resolveBookingMeterPrice(svc);
    if (!newPriceId) return json({ error: missingPriceError(tier, configKey, annual) }, 500);

    // Never charge a number the site didn't quote. Fails closed.
    const priceProblem = await assertPriceMatches(
      newPriceId, tier, annual ? 'annual' : 'monthly', Deno.env.get('STRIPE_SECRET_KEY') ?? '',
    );
    if (priceProblem) return json({ error: priceProblem }, 409);

    // Fetch the live subscription to get its item id + check current price
    const subscription = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
    // A Pro subscription carries TWO items — the tier price and the metered
    // bookings price — and Stripe does not promise an order. Picking data[0]
    // blind would sometimes have swapped the METER item's price to the new tier
    // and left the real tier item untouched.
    const meterItem = bookingMeterPrice
      ? subscription.items.data.find(i => i.price.id === bookingMeterPrice)
      : undefined;
    const item = subscription.items.data.find(i => i.id !== meterItem?.id);
    if (!item) return json({ error: 'Subscription has no tier item' }, 500);

    // "Already on this plan" is only true if the ITEMS are right too. A Pro
    // subscription created before the meter existed has the correct tier price
    // and no meter item, so it would bill £12 and never charge for a booking.
    // Letting it through here makes switching to Pro a repair as well as a move.
    const needsMeterRepair = tier === 'pro' && !!meterPrice && !meterItem;
    if (item.price.id === newPriceId && !needsMeterRepair) {
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
      // Classification lives in _shared because Stripe moved `proration` under
      // `parent` — reading the old top-level field returns undefined for every
      // line, which quietly quotes the business £0.00 due today.
      const prorationPence = splitInvoice(invoice).adjustPence;

      // current_period_end is per-item in newer API versions
      const periodEndSec = (item as any).current_period_end as number | undefined;
      // Both Premium prices count as premium — an annual subscriber must not be
      // reported as 'pro' just because they aren't on the monthly price.
      const { priceId: premiumMonthly } = await resolveTierPrice(svc, 'premium', 'monthly');
      const { priceId: premiumAnnual }  = await resolveTierPrice(svc, 'premium', 'annual');
      const onPremium = item.price.id === premiumMonthly || item.price.id === premiumAnnual;

      return json({
        previewAmountPence:  prorationPence,
        currency:            invoice.currency,
        nextRenewalAt:       periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
        currentTier:         onPremium ? 'premium' : 'pro',
        newTier:             tier,
      });
    }

    // ── Apply mode ────────────────────────────────────────────────────────
    // Modify the subscription. proration_behavior: 'create_prorations'
    // → Stripe creates prorated line items and bills them on a new invoice
    //   (paid immediately by the saved payment method).
    // cancel_at_period_end: false
    // → if a cancellation was pending, the user is now committing to staying.
    // Moving to Pro adds the metered bookings item; moving to Premium removes
    // it, because bookings are included there and a stray meter item would keep
    // billing 95p a booking on a plan that says it doesn't.
    const items: Record<string, unknown>[] = [{ id: item.id, price: newPriceId }];
    if (tier === 'pro' && meterPrice && !meterItem) items.push({ price: meterPrice });
    if (tier !== 'pro' && meterItem) items.push({ id: meterItem.id, deleted: true });

    const updated = await stripe.subscriptions.update(business.stripe_subscription_id, {
      items: items as never,
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

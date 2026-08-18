import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfig } from '../_shared/admin-config.ts';
import { sendUserPush } from '../_shared/send-push.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { fulfilByType } from '../_shared/fulfilment.ts';

/**
 * stripe-webhook
 *
 * Handles incoming Stripe webhook events.
 * Set this URL in Stripe Dashboard → Developers → Webhooks:
 * https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook
 *
 * Required env vars:
 *   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → signing secret
 *   STRIPE_SECRET_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */
/**
 * Email the owner when their plan actually CHANGES.
 *
 * Guarded on a real tier change, because Stripe fires subscription.updated for
 * all sorts of things — including usage being reported against the metered
 * bookings item. Emailing on every event would send a business a message every
 * time somebody booked them.
 *
 * Best-effort: a failed email must never fail the webhook, or Stripe retries a
 * payment we have already processed.
 */
async function emailPlanChange(
  supabase: any,
  ownerId: string,
  businessName: string,
  businessId: string,
  from: string,
  to: string,
  renewsIso: string | null,
  reason: 'ended' | 'lapsed' | null,
  stripeCustomerId: string | null,
  stripeSubscriptionId: string | null,
): Promise<void> {
  try {
    const { data: u } = await supabase.auth.admin.getUserById(ownerId);
    const email = u?.user?.email;
    if (!email) return;
    const meta = u?.user?.user_metadata ?? {};
    const ownerName =
      (meta.first_name as string | undefined) ??
      (meta.full_name as string | undefined)?.split(' ')[0] ?? 'there';

    const manageUrl = `https://oneshetland.com/business/${businessId}/manage/billing`;
    const renews = renewsIso
      ? new Date(renewsIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'Not set';

    if (to === 'free') {
      // What they actually lose depends on where they were.
      const lost = from === 'premium'
        ? 'Products and orders, passes, the featured spot on the home screen, and the counter tools — offers, loyalty, tap-to-stamp, Local Wallet and your analytics. Bookings stay, at 95p each on Pro.'
        : 'Offers, your loyalty card, tap-to-stamp, Local Wallet payments, enquiries, your analytics and taking bookings.';
      await sendEmail(supabase, {
        templateKey: 'billing.plan_ended',
        recipientEmail: email,
        recipientId: ownerId,
        variables: {
          owner_name: ownerName,
          business_name: businessName,
          ended_reason: reason === 'lapsed' ? ' — we could not take payment' : '',
          lost_features: lost,
          manage_url: manageUrl,
        },
        metadata: { business_id: businessId, from, to },
      });
      return;
    }

    const isPremium = to === 'premium';
    // Annual renews more than 90 days out; monthly always renews within ~31.
    const annual = isPremium && !!renewsIso &&
      new Date(renewsIso).getTime() - Date.now() > 90 * 86_400_000;

    const NAME: Record<string, string> = { free: 'Free', pro: 'Pro', premium: isPremium && annual ? 'Premium (yearly)' : 'Premium' };
    const wentUp = ['free', 'pro', 'premium'].indexOf(to) > ['free', 'pro', 'premium'].indexOf(from);

    // What the NEXT bill will be. Plan changes use create_prorations, which puts
    // the adjustment on the next invoice rather than charging on the day — so
    // "charged today" was wrong, and looked for an invoice that never existed.
    // The upcoming invoice already includes the proration, which is exactly the
    // number somebody wants after switching.
    let nextBillRow = '';
    try {
      if (stripeCustomerId) {
        // /v1/invoices/upcoming was REMOVED in recent Stripe API versions and
        // replaced by create_preview — which is why the first version of this
        // silently produced nothing. local-subscription-change already uses
        // createPreview, so the account is definitely on a version without the
        // old endpoint. Try the new one, fall back to the old for older accounts.
        const auth = { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}` };
        let due: number | null = null;

        // create_preview needs the SUBSCRIPTION as well as the customer —
        // sending customer alone returns 400, which is what the log showed.
        // local-subscription-change passes both; I didn't read it closely enough.
        const params = new URLSearchParams({ customer: stripeCustomerId });
        if (stripeSubscriptionId) params.set('subscription', stripeSubscriptionId);
        const preview = await fetch('https://api.stripe.com/v1/invoices/create_preview', {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        });
        if (preview.ok) {
          const up = await preview.json();
          if (typeof up?.amount_due === 'number') due = up.amount_due;
        } else {
          const legacy = await fetch(
            `https://api.stripe.com/v1/invoices/upcoming?customer=${stripeCustomerId}`, { headers: auth },
          );
          if (legacy.ok) {
            const up = await legacy.json();
            if (typeof up?.amount_due === 'number') due = up.amount_due;
          } else {
            // Log it. The silent version is why this shipped broken twice.
            console.error('[stripe-webhook] no upcoming invoice from either endpoint:',
              'create_preview', preview.status, (await preview.json())?.error?.message,
              '| upcoming', legacy.status);
          }
        }

        if (due !== null) {
          nextBillRow =
            `<tr><td style="color:#6B7280;font-size:14px;border-top:1px solid #D9D2C7;padding-top:8px">Next bill, ${renews}</td>` +
            `<td style="color:#0F1C26;font-size:15px;font-weight:900;text-align:right;border-top:1px solid #D9D2C7;padding-top:8px">` +
            `£${(due / 100).toFixed(2)}</td></tr>`;
        }
      }
    } catch (e) { console.error('[stripe-webhook] upcoming invoice lookup failed:', e); }

    await sendEmail(supabase, {
      templateKey: 'billing.plan_active',
      recipientEmail: email,
      recipientId: ownerId,
      variables: {
        owner_name: ownerName,
        business_name: businessName,
        change_summary: from === 'free'
          ? `now on ${NAME[to]}`
          : wentUp ? `moved up to ${NAME[to]}` : `moved to ${NAME[to]}`,
        change_sentence_html: from === 'free'
          ? `is now on <strong>${NAME[to]}</strong>.`
          : `has ${wentUp ? 'moved up' : 'moved'} from <strong>${NAME[from] ?? from}</strong> to <strong>${NAME[to]}</strong>.`,
        plan_name: NAME[to],
        plan_price: isPremium ? (annual ? '£290/year' : '£29/month') : '£12/month',
        renews_on: renews,
        next_bill_row_html: nextBillRow,
        plan_blurb: isPremium
          ? 'You can now sell products and passes, take bookings with no per-booking fee, and appear in the featured spot on the OneShetland home screen — on top of everything Pro gives you.'
          : 'You can now run offers, hand out loyalty stamps, take Local Wallet payments, see your own numbers, and take bookings at 95p each — capped at £16.15 a month, so Pro never costs more than Premium would have.',
        manage_url: manageUrl,
      },
      metadata: { business_id: businessId, from, to },
    });
  } catch (e) {
    console.error('[stripe-webhook] plan-change email failed:', e);
  }
}

serve(async (req) => {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const connectWebhookSecret = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') ?? '';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const body = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  // Try platform secret first, then Connect secret
  let event: Record<string, unknown>;
  try {
    try {
      event = await verifyStripeSignature(body, signature, webhookSecret);
    } catch {
      event = await verifyStripeSignature(body, signature, connectWebhookSecret);
    }
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return new Response('Webhook signature invalid', { status: 400 });
  }

  const eventType = event.type as string;
  const eventData = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;

  console.log(`[stripe-webhook] Received: ${eventType}`);

  try {
    switch (eventType) {

      // ── Payment confirmed ────────────────────────────────────────────
      case 'payment_intent.succeeded': {
        const meta = (eventData.metadata ?? {}) as Record<string, string>;

        // Fetch delivery (Fetch module)
        const requestId = meta.request_id;
        if (requestId) {
          await supabase
            .from('delivery_requests')
            .update({ payment_status: 'captured' })
            .eq('payment_intent_id', eventData.id as string);
        }

        // Local Boost — short-term Pro access
        if (meta.type === 'local_boost' && meta.business_id) {
          const weeks = parseInt(meta.weeks ?? '0', 10);
          if (weeks > 0) {
            // Fetch current subscription_until so we can extend it if there
            // are still days left on an existing boost. Stacking is allowed.
            const { data: biz } = await supabase
              .from('local_businesses')
              .select('subscription_until')
              .eq('id', meta.business_id)
              .single();

            const now = new Date();
            const startFrom = biz?.subscription_until && new Date(biz.subscription_until) > now
              ? new Date(biz.subscription_until)
              : now;
            const newExpiry = new Date(startFrom.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

            await supabase
              .from('local_businesses')
              .update({
                subscription_tier:                 'pro',
                subscription_until:                newExpiry.toISOString(),
                subscription_cancel_at_period_end: false,
                // Important: leave stripe_subscription_id NULL — that's how we
                // tell a boost apart from a monthly subscription downstream.
              })
              .eq('id', meta.business_id);

            // Mark the pending purchase row as succeeded + record expiry
            await supabase
              .from('local_boost_purchases')
              .update({
                status:     'succeeded',
                expires_at: newExpiry.toISOString(),
              })
              .eq('stripe_payment_intent_id', eventData.id as string);
          }
        }

        // Safety net for client-confirm-driven card flows (wallet top-up, unit
        // purchase, gift, event tickets, hub donation, hub membership). Normally
        // the client calls the matching confirm-* function after PaymentSheet
        // succeeds; if it never does (app killed / offline), fulfil here instead.
        // Idempotent on the PaymentIntent id, so it's a no-op when the client
        // already confirmed. Never let a fulfilment error 500 the webhook —
        // Stripe would retry the whole event and re-run the blocks above.
        try {
          const fulfilRes = await fulfilByType(supabase, {
            id:       eventData.id as string,
            amount:   (eventData.amount as number) ?? 0,
            metadata: meta,
            status:   eventData.status as string | undefined,
          });
          if (fulfilRes) {
            console.log(`[stripe-webhook] fulfil ${meta.type} (${eventData.id}): ${fulfilRes.note}`);
          }
        } catch (fulfilErr) {
          console.error(`[stripe-webhook] fulfil failed for ${meta.type} (${eventData.id}):`, fulfilErr);
        }

        break;
      }

      // ── Payment failed ───────────────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const meta = (eventData.metadata ?? {}) as Record<string, string>;
        const requestId = meta.request_id;
        if (requestId) {
          await supabase
            .from('delivery_requests')
            .update({ payment_status: 'failed' })
            .eq('payment_intent_id', eventData.id as string);

          // Notify the customer their delivery payment failed so they can fix
          // their card. customer_id is stamped on the PaymentIntent metadata by
          // authorise-payment; fall back to a lookup if it's absent.
          let customerId = meta.customer_id || '';
          if (!customerId) {
            const { data: dr } = await supabase
              .from('delivery_requests')
              .select('customer_id')
              .eq('payment_intent_id', eventData.id as string)
              .maybeSingle();
            customerId = (dr?.customer_id as string) ?? '';
          }
          if (customerId) {
            const lastErr = (eventData.last_payment_error as Record<string, unknown> | undefined);
            const reason = (lastErr?.message as string | undefined) ?? 'Your card was declined.';
            await sendUserPush(supabase, {
              userId:     customerId,
              module:     'fetch',
              categoryId: 'fetch.payment_failed',
              title:      'Delivery payment failed',
              body:       `${reason} Please update your payment method to keep your delivery.`,
              data:       { request_id: requestId, kind: 'fetch_payment_failed' },
              urgent:     true,
            }).catch((e) => console.error('[stripe-webhook] payment_failed push:', e));
          }
        }
        break;
      }

      // ── Connect account updated ──────────────────────────────────────
      // Stripe fires this when any user completes Connect onboarding
      // (driver, employer, business owner — anyone who receives money).
      // profiles is now the source of truth; driver_profiles is kept in
      // sync for backward compat. local_businesses covers business-specific
      // Connect accounts (use_business_payout = true).
      case 'account.updated': {
        const accountId = eventData.id as string;
        // We only ever create Express connected accounts. Ignore updates for any
        // other account type defensively, so an unexpected event can't flip
        // onboarding/payout flags.
        const accountType = eventData.type as string | undefined;
        if (accountType && accountType !== 'express') break;
        const payoutsEnabled   = eventData.payouts_enabled   as boolean;
        const chargesEnabled   = eventData.charges_enabled   as boolean;
        const detailsSubmitted = eventData.details_submitted as boolean;

        // 1. Central user account (profiles) — covers drivers, employers, business owners
        await supabase
          .from('profiles')
          .update({
            stripe_onboarding_complete: detailsSubmitted,
            stripe_payouts_enabled:     payoutsEnabled,
            stripe_charges_enabled:     chargesEnabled,
          })
          .eq('stripe_account_id', accountId);

        // 2. driver_profiles — backward compat for existing driver dashboard reads
        await supabase
          .from('driver_profiles')
          .update({
            stripe_onboarding_complete: detailsSubmitted,
            stripe_payouts_enabled:     payoutsEnabled,
            stripe_charges_enabled:     chargesEnabled,
          })
          .eq('stripe_account_id', accountId);

        // 3. Business-specific Connect accounts (use_business_payout = true)
        await supabase
          .from('local_businesses')
          .update({
            business_stripe_onboarding_complete: detailsSubmitted,
            business_stripe_payouts_enabled:     payoutsEnabled,
          })
          .eq('business_stripe_account_id', accountId);

        // 3b. Businesses onboarded via local-business-onboard store the Connect
        // account in stripe_account_id and gate payments on payout_enabled, so
        // set that here too — otherwise payout_enabled never flips true and every
        // business payment (wallet or card) is rejected after onboarding.
        await supabase
          .from('local_businesses')
          .update({ payout_enabled: payoutsEnabled })
          .eq('stripe_account_id', accountId);

        // 4. Hub Connect accounts (paid memberships)
        await supabase
          .from('hubs')
          .update({ payout_enabled: payoutsEnabled })
          .eq('stripe_account_id', accountId);

        break;
      }

      // ── Local business subscription created/updated ──────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subId             = eventData.id as string;
        const customerId        = eventData.customer as string;
        const status            = eventData.status as string;
        const cancelAtPeriodEnd = Boolean(eventData.cancel_at_period_end);
        const meta              = (eventData.metadata ?? {}) as Record<string, string>;
        const items             = eventData.items as {
          data: Array<{ price: { id: string }; current_period_end?: number }>
        };
        const isActive = ['active', 'trialing'].includes(status);

        // ── Standard business tier subscription ──────────────────────────
        // Map Stripe price IDs to our tiers — read from admin_config first,
        // fall back to env vars so old deployments keep working.
        const proPrice     = await getConfig(supabase, 'stripe.price.local_pro',     Deno.env.get('STRIPE_PRICE_LOCAL_PRO')     ?? null);
        const premiumPrice = await getConfig(supabase, 'stripe.price.local_premium', Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM') ?? null);
        // Annual Premium bills yearly but grants exactly the same access. Only
        // the billing period differs, so it maps to the same tier.
        const premiumAnnualPrice = await getConfig(supabase, 'stripe.price.local_premium_annual', Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM_ANNUAL') ?? null);

        // A subscription may carry more than one line item, so never assume
        // items.data[0] — find the item whose price matches a tier (premium
        // first), falling back to the first item.
        const tierItem =
          items?.data?.find((i) => i.price?.id === premiumPrice) ??
          items?.data?.find((i) => i.price?.id === premiumAnnualPrice) ??
          items?.data?.find((i) => i.price?.id === proPrice) ??
          items?.data?.[0];
        const priceId = tierItem?.price?.id;

        // current_period_end moved to the item in Stripe 2025-04-30+. Be robust
        // across API versions: prefer the tier item, then ANY item that carries
        // it, then the legacy top-level field. Only accept a finite epoch.
        const rawPeriodEnd =
          tierItem?.current_period_end ??
          items?.data?.find((it) => typeof it.current_period_end === 'number')?.current_period_end ??
          (eventData.current_period_end as number | undefined);
        const periodEndSec = typeof rawPeriodEnd === 'number' && Number.isFinite(rawPeriodEnd) ? rawPeriodEnd : null;
        const periodEndIso = periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null;

        // Map the price to a tier. `null` means "this is a paid, active
        // subscription against a price we don't recognise" — which is NOT the
        // same as "not paying", and must never be treated as such. See below.
        let tier: 'free' | 'pro' | 'premium' | null = null;
        if (priceId === premiumPrice || priceId === premiumAnnualPrice) tier = 'premium';
        else if (priceId === proPrice) tier = 'pro';

        // Read the current state first so we can tell a genuine downgrade
        // (was paid, now lapsing) from routine update churn.
        const { data: bizBefore } = await supabase
          .from('local_businesses')
          .select('id, owner_id, name, subscription_tier')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();

        // An ACTIVE subscription on a price we don't recognise must not be read
        // as "not paying". Previously an unmatched price fell through to 'free',
        // so adding a Price in the Stripe dashboard and subscribing somebody to
        // it would charge them and then strip their listing — the worst possible
        // pairing. Keep whatever tier they already had, and shout, so the
        // mismatch is fixed by setting the config key rather than by a customer
        // complaining. Genuinely inactive subscriptions still drop to free.
        if (isActive && tier === null) {
          console.error(
            `[stripe-webhook] ACTIVE subscription ${subId} on unrecognised price ${priceId ?? '(none)'} — ` +
            `tier left unchanged at "${bizBefore?.subscription_tier ?? 'unknown'}". ` +
            `Set the matching stripe.price.* key in admin_config.`,
          );
        }

        const nextTier = isActive ? (tier ?? bizBefore?.subscription_tier ?? 'free') : 'free';

        await supabase
          .from('local_businesses')
          .update({
            subscription_tier:                 nextTier,
            subscription_until:                isActive ? periodEndIso : null,
            subscription_cancel_at_period_end: isActive ? cancelAtPeriodEnd : false,
            stripe_subscription_id:            subId,
            stripe_customer_id:                customerId,
          })
          .eq('stripe_customer_id', customerId);

        // Email only when the tier genuinely moved. subscription.updated also
        // fires when usage is reported against the metered bookings item, so
        // emailing on every event would write to a business each time somebody
        // booked them.
        if (bizBefore?.owner_id && bizBefore.subscription_tier !== nextTier) {
          await emailPlanChange(
            supabase, bizBefore.owner_id, bizBefore.name,
            (bizBefore as { id?: string }).id ?? '',
            bizBefore.subscription_tier, nextTier, isActive ? periodEndIso : null,
            !isActive ? 'lapsed' : null, customerId, subId,
          );
        }

        // Silent-downgrade fix: if a paying business just lapsed (payment
        // failed / went inactive), tell the owner — losing the tier also hides
        // their bookable listings.
        if (!isActive && bizBefore?.owner_id && bizBefore.subscription_tier !== 'free') {
          await sendUserPush(supabase, {
            userId:     bizBefore.owner_id,
            module:     'business',
            categoryId: 'business.subscription_lapsed',
            title:      'Subscription payment problem',
            body:       `We couldn't take payment for ${bizBefore.name}'s OneShetland subscription, so it's paused. Tap to update your card and stay listed.`,
            data:       { screen: 'local-business-dashboard' },
          });
        }

        break;
      }

      // ── Subscription cancelled / lapsed ──────────────────────────────
      case 'customer.subscription.deleted': {
        const subId      = eventData.id as string;
        const deleteMeta = (eventData.metadata ?? {}) as Record<string, string>;

        // Standard tier subscription cancelled
        const { data: bizDel } = await supabase
          .from('local_businesses')
          .select('id, owner_id, name, subscription_tier')
          .eq('stripe_subscription_id', subId)
          .maybeSingle();

        await supabase
          .from('local_businesses')
          .update({
            subscription_tier:                 'free',
            subscription_until:                null,
            subscription_cancel_at_period_end: false,
            // Clear the dead id. Leaving it set made the business unable to buy
            // anything: the billing screen saw a subscription id, took the
            // "change an existing plan" path, found the CANCELLED subscription
            // still sitting on the Pro price, and answered "you're already on
            // Pro" to a business that was on free.
            stripe_subscription_id:            null,
          })
          .eq('stripe_subscription_id', subId);

        // Tell the owner their subscription has ended (bookable listings now hidden).
        if (bizDel?.owner_id && bizDel.subscription_tier !== 'free') {
          await emailPlanChange(
            supabase, bizDel.owner_id, bizDel.name,
            (bizDel as { id?: string }).id ?? '',
            bizDel.subscription_tier, 'free', null, 'ended', null, null,
          );
          await sendUserPush(supabase, {
            userId:     bizDel.owner_id,
            module:     'business',
            categoryId: 'business.subscription_ended',
            title:      'Subscription ended',
            body:       `Your OneShetland subscription for ${bizDel.name} has ended, so your bookable listings are now hidden. Tap to resubscribe.`,
            data:       { screen: 'local-business-dashboard' },
          });
        }
        break;
      }

      // ── Subscription renewal payment succeeded — extend the expiry ──
      case 'invoice.payment_succeeded': {
        const subId = eventData.subscription as string | null;
        // Invoices have always had period_end at top level — but newer API
        // versions also expose it under lines.data[0].period.end. Be defensive.
        const lines = eventData.lines as { data: Array<{ period?: { end?: number } }> } | undefined;
        const periodEndSec =
          (eventData.period_end as number | undefined) ??
          lines?.data?.[0]?.period?.end;
        if (subId && periodEndSec) {
          await supabase
            .from('local_businesses')
            .update({ subscription_until: new Date(periodEndSec * 1000).toISOString() })
            .eq('stripe_subscription_id', subId);
        }
        break;
      }

      // ── Payout to driver succeeded ───────────────────────────────────
      case 'transfer.created': {
        console.log('[stripe-webhook] Transfer created:', eventData.id);
        break;
      }

      // ── Charge refunded (in-app refund OR Stripe Dashboard refund) ───
      // Mark the originating record refunded so app state matches Stripe even
      // when a refund is issued straight from the Dashboard.
      case 'charge.refunded': {
        const pi = eventData.payment_intent as string | null;
        const fullyRefunded = eventData.refunded === true; // false for partials
        if (pi) {
          await supabase
            .from('delivery_requests')
            .update({ payment_status: fullyRefunded ? 'refunded' : 'partially_refunded' })
            .eq('payment_intent_id', pi);
          // Notify the customer a refund was issued.
          const meta = (eventData.metadata ?? {}) as Record<string, string>;
          const customerId = meta.customer_id || '';
          if (customerId) {
            const amt = ((eventData.amount_refunded as number) ?? 0) / 100;
            await sendUserPush(supabase, {
              userId:     customerId,
              module:     'fetch',
              categoryId: 'fetch.refunded',
              title:      'Refund issued',
              body:       `A refund of £${amt.toFixed(2)} is on its way back to your card.`,
              data:       { kind: 'refund', payment_intent_id: pi },
            }).catch((e) => console.error('[stripe-webhook] refund push:', e));
          }
        }
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error(`[stripe-webhook] Error handling ${eventType}:`, err);
    return new Response('Webhook handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

// ── Stripe signature verification ──────────────────────────────────────────
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<Record<string, unknown>> {
  if (!secret) {
    // Fail CLOSED. Previously this skipped verification when no secret was set,
    // which means an unset STRIPE_WEBHOOK_SECRET in production would accept ANY
    // forged payload (fake payments, free premium upgrades, payouts to attacker
    // accounts). Never accept an unsigned webhook.
    throw new Error('Webhook secret not configured — refusing to process unsigned event');
  }

  const parts = header.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signature = parts.find((p) => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !signature) throw new Error('Invalid signature header');

  // Replay protection: reject events whose timestamp is outside a 5-minute
  // tolerance (Stripe's recommended default).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    throw new Error('Webhook timestamp outside tolerance');
  }

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected !== signature) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}

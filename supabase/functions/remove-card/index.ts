import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { listAttachedCards, reconcileCustomerDefault } from '../_shared/saved-card.ts';
import { personalSubscriptionsFor, repointSubscriptions } from '../_shared/personal-subscriptions.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE = 'https://api.stripe.com/v1';

/**
 * remove-card — take the saved card off the account, truthfully.
 *
 * Detaches every card on the caller's own Stripe Customer, then makes the rest
 * of the world agree with what Stripe now holds. The flag MUST be set here and
 * not on the client: tg_profiles_lock_sensitive reverts any client write to
 * profiles.has_payment_method, and detaching needs the secret key anyway.
 *
 * ── What the readiness review found, and what changed ────────────────────
 *
 * 1. The Customer's `invoice_settings.default_payment_method` was never
 *    cleared. Stripe's reference does not say whether detaching clears it, and
 *    a detached PaymentMethod is permanently unusable — so the default could
 *    be left pointing at a dead card, and defaultCardFor returned it blind.
 *    Adding a replacement would NOT have fixed that. Both ends are fixed: the
 *    default is now reconciled here against the cards that actually remain,
 *    and saved-card.ts no longer trusts a default it cannot see attached.
 *
 * 2. The detach loop threw on the first Stripe error, BEFORE re-syncing the
 *    flag — so a partial removal left the local state describing an operation
 *    we intended rather than one that happened. Nothing throws out of the loop
 *    now; failures are collected, Stripe is re-read, and everything converges
 *    from what is actually there.
 *
 * 3. The unused `payment_method_id` mode is gone. Neither client ever sent one
 *    (web sends {} or {business_id}, mobile sends {}), it made a retry after a
 *    lost response answer 404 "not on this account", and making it idempotent
 *    would have meant inventing a registry for a mode nobody uses. Removing an
 *    unused input that takes a client-supplied Stripe id is the smaller
 *    surface and the better trade.
 *
 * Body: { business_id?: string }   — omit for the caller's personal card
 * Returns: { ok, has_card, removed, failed, default_cleared, subscriptions? }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const body = await req.json().catch(() => ({}));
    const businessId: string | undefined = body?.business_id;

    // The customer is resolved from the CALLER, never from the request. A
    // business one requires ownership; a personal one is simply theirs.
    let customerId = '';
    if (businessId) {
      const { data: biz } = await svc.from('local_businesses')
        .select('id, owner_id, business_stripe_customer_id').eq('id', businessId).maybeSingle();
      if (!biz) return json({ error: 'Business not found' }, 404);
      if (biz.owner_id !== user.id) return json({ error: 'Forbidden — not the business owner' }, 403);
      customerId = biz.business_stripe_customer_id ?? '';
    } else {
      const { data: prof } = await svc.from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
      customerId = prof?.stripe_customer_id ?? '';
    }

    if (!customerId) return json({ error: 'No payment profile found.' }, 400);

    const before = await listAttachedCards(stripeKey, customerId);
    if (before === null) {
      return json({ error: 'We could not check your cards just now. Please try again.' }, 502);
    }

    // ── Detach, without letting one failure hide the rest ──────────────────
    //
    // A retry after a lost response lands here with nothing left to detach,
    // which is the whole reason this is a loop over what Stripe currently
    // holds rather than over what the caller believes.
    let removed = 0;
    const failures: string[] = [];
    for (const card of before) {
      try {
        const res = await fetch(`${STRIPE}/payment_methods/${card.id}/detach`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' },
        });
        if (res.ok) { removed += 1; continue; }
        const err = await res.json().catch(() => ({}));
        failures.push(err?.error?.message ?? `HTTP ${res.status}`);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : 'unreachable');
      }
    }

    // ── Converge on what Stripe actually holds now ────────────────────────
    const after = await listAttachedCards(stripeKey, customerId);
    if (after === null) {
      // We cannot see the truth, so we must not write a flag claiming to know
      // it. Say so instead of guessing in either direction.
      console.error(`[remove-card] could not re-read cards for ${businessId ? 'business' : 'user'}`);
      return json({
        error: "Your card may have been removed, but we couldn't confirm it. Please reload in a moment.",
        code: 'UNRESOLVED',
      }, 502);
    }

    const def = await reconcileCustomerDefault(stripeKey, customerId, after);
    const hasCard = after.length > 0;

    if (businessId) {
      await svc.from('local_businesses').update({ has_business_payment_method: hasCard }).eq('id', businessId);
    } else {
      await svc.from('profiles').update({ has_payment_method: hasCard }).eq('id', user.id);
    }

    // ── The subscriptions this personal card was paying for ───────────────
    //
    // Best effort, and deliberately not load-bearing. A detached PaymentMethod
    // cannot be charged at all, and the Customer default is cleared above, so
    // no renewal can quietly succeed on a dead card whether or not this
    // clearing works. Stripe does not document unsetting the field, so the
    // outcome is reported rather than assumed. The guarantee that matters is
    // on the other side: adding a card repoints these subscriptions for real.
    let subscriptions: unknown = undefined;
    if (!businessId && !hasCard) {
      const subs = await personalSubscriptionsFor(svc, user.id, customerId);
      if (subs.length > 0) {
        const outcomes = await repointSubscriptions(stripeKey, subs, customerId, null);
        subscriptions = outcomes.map((o) => o.result);
        console.log(`[remove-card] subscription defaults after removal: ${outcomes.map((o) => o.result).join(', ')}`);
      }
    }

    if (failures.length > 0) {
      // Some cards went, some did not. The local state above already reflects
      // reality; saying "done" would not.
      console.error(`[remove-card] ${failures.length} detach failure(s): ${failures.join('; ')}`);
      return json({
        ok: false, has_card: hasCard, removed, failed: failures.length,
        default_cleared: def.default === null,
        error: hasCard
          ? 'We removed part of your saved card details but not all of them. Please try again.'
          : 'Your card was removed, but something else did not complete. Please reload.',
      }, 502);
    }

    return json({
      ok: true,
      has_card: hasCard,
      removed,
      failed: 0,
      default_cleared: def.default === null,
      ...(subscriptions ? { subscriptions } : {}),
    });
  } catch (err) {
    console.error('[remove-card]', err);
    return json({ error: safeError('remove-card', err) }, 500);
  }
});

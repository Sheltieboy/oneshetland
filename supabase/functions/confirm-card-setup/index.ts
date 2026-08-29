import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { listAttachedCards, setCustomerDefaultCard } from '../_shared/saved-card.ts';
import { personalSubscriptionsFor, repointSubscriptions } from '../_shared/personal-subscriptions.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE = 'https://api.stripe.com/v1';

/**
 * confirm-card-setup — the card they just added becomes the card we use.
 *
 * Called AFTER the SetupIntent succeeds. The "has a card" flag MUST be set
 * here: tg_profiles_lock_sensitive reverts any client write to
 * profiles.has_payment_method, so the old client-side update was silently
 * undone and the app never knew the card existed.
 *
 * ── What changed ─────────────────────────────────────────────────────────
 *
 * It used to do one thing — ask Stripe whether ANY card existed and set a
 * boolean. That left two holes:
 *
 * 1. The card the customer deliberately just added did not become the default.
 *    Whatever `invoice_settings.default_payment_method` already said kept
 *    winning, including a stale id left behind by a detached card — so
 *    "Replace card" could add a card the product then never used.
 *
 * 2. A subscription billed through this personal Customer went on holding
 *    whichever PaymentMethod it was created with. After a remove-then-add that
 *    is a permanently detached card, and nothing repaired it.
 *
 * Both are fixed here, because this is the one moment the customer has
 * expressed which card they want.
 *
 * The new PaymentMethod is taken from the SetupIntent itself where the client
 * supplies its id — Stripe's own record of what was just confirmed — rather
 * than from "the first card in the list", which is a guess.
 *
 * Body: { business_id?: string, setup_intent_id?: string }
 * Returns: { ok, has_card, default_set, subscriptions_repointed }
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
    const setupIntentId: string | undefined =
      typeof body?.setup_intent_id === 'string' ? body.setup_intent_id : undefined;

    // Find the right Stripe customer (business-scoped or personal).
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

    if (!customerId) return json({ error: 'No payment profile found — try adding the card again.' }, 400);

    // Ask Stripe what is actually attached. This is the authority for the flag,
    // exactly as before — the client is never believed about it.
    const attached = await listAttachedCards(stripeKey, customerId);
    if (attached === null) throw new Error('Could not read payment methods from Stripe');
    const hasCard = attached.length > 0;

    // Set the flag to match reality (service role bypasses the lock trigger).
    if (businessId) {
      await svc.from('local_businesses').update({ has_business_payment_method: hasCard }).eq('id', businessId);
    } else {
      await svc.from('profiles').update({ has_payment_method: hasCard }).eq('id', user.id);
    }

    // ── Which card did they just add? ─────────────────────────────────────
    //
    // The SetupIntent knows, and it is checked against this Customer so a
    // caller cannot name somebody else's intent and adopt their card. Without
    // an id (an older client) the newest attached card is the honest fallback.
    let newCard: string | null = null;
    if (setupIntentId) {
      const siRes = await fetch(`${STRIPE}/setup_intents/${setupIntentId}`, {
        headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' },
      });
      if (siRes.ok) {
        const si = await siRes.json().catch(() => ({}));
        const pm = typeof si?.payment_method === 'string' ? si.payment_method : null;
        if (si?.customer === customerId && pm && attached.some((c) => c.id === pm)) {
          newCard = pm;
        } else {
          console.error('[confirm-card-setup] setup intent did not match this customer or card');
        }
      }
    }
    if (!newCard && hasCard) newCard = attached[0].id;

    let defaultSet = false;
    let repointed = 0;
    if (newCard) {
      const r = await setCustomerDefaultCard(stripeKey, customerId, newCard);
      defaultSet = r.ok;
      if (!r.ok) console.error('[confirm-card-setup] could not set the customer default');

      // ── Repair the subscriptions this personal card pays for ────────────
      //
      // Stripe holds subscription.default_payment_method separately, and it
      // takes precedence. After a remove-then-add it is still holding a card
      // that has been detached and can never be charged again, so the new card
      // is written onto it here — the one moment we know which card is wanted.
      // Business-scoped Customers are a different model and are left alone.
      if (!businessId) {
        const subs = await personalSubscriptionsFor(svc, user.id, customerId);
        if (subs.length > 0) {
          const outcomes = await repointSubscriptions(stripeKey, subs, customerId, newCard);
          repointed = outcomes.filter((o) => o.result === 'repointed').length;
          const bad = outcomes.filter((o) => o.result === 'failed');
          if (bad.length) console.error(`[confirm-card-setup] ${bad.length} subscription repoint failure(s)`);
        }
      }
    }

    return json({ ok: true, has_card: hasCard, default_set: defaultSet, subscriptions_repointed: repointed });
  } catch (err) {
    console.error('[confirm-card-setup]', err);
    return json({ error: safeError('confirm-card-setup', err) }, 500);
  }
});

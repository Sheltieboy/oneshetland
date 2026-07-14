import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * remove-card
 *
 * Detaches a saved Stripe card from the customer, then re-syncs the "has a card"
 * flag SERVER-SIDE. The flag MUST be set here, not on the client — the
 * tg_profiles_lock_sensitive trigger reverts any client-side write to
 * profiles.has_payment_method (and has_business_payment_method on businesses),
 * so a client could never reliably clear it. We also can't detach a card from
 * the client because that needs the Stripe secret key.
 *
 * Mirrors confirm-card-setup: resolve the right Stripe customer (business-scoped
 * or personal), do the Stripe mutation, then ASK Stripe whether any card remains
 * and set the flag to match reality (self-healing — never trust the client).
 *
 * Body: {
 *   business_id?: string,        // omit = the user's personal/central card
 *   payment_method_id?: string,  // omit = detach ALL cards on the customer
 * }
 * Returns: { ok: true, has_card: boolean, removed: number }
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
    const paymentMethodId: string | undefined = body?.payment_method_id;

    // Find the right Stripe customer (business-scoped or personal), ownership-checked.
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

    // List the customer's saved cards.
    const listRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=100`,
      { headers: { Authorization: `Bearer ${stripeKey}` } },
    );
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(listData.error?.message ?? 'Could not read payment methods from Stripe');
    const cards: Array<{ id: string }> = Array.isArray(listData.data) ? listData.data : [];

    // Decide which to detach: the named one (must belong to this customer) or all.
    let targets: string[];
    if (paymentMethodId) {
      if (!cards.some((c) => c.id === paymentMethodId)) {
        return json({ error: 'That card is not on this account.' }, 404);
      }
      targets = [paymentMethodId];
    } else {
      targets = cards.map((c) => c.id);
    }

    // Detach each (Stripe: POST /v1/payment_methods/{id}/detach).
    let removed = 0;
    for (const pmId of targets) {
      const detachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}/detach`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      const detachData = await detachRes.json();
      if (!detachRes.ok) throw new Error(detachData.error?.message ?? 'Could not remove the card from Stripe');
      removed += 1;
    }

    // Re-check Stripe and set the flag to match reality (service role bypasses the lock trigger).
    const recheckRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
      { headers: { Authorization: `Bearer ${stripeKey}` } },
    );
    const recheckData = await recheckRes.json();
    if (!recheckRes.ok) throw new Error(recheckData.error?.message ?? 'Could not read payment methods from Stripe');
    const hasCard = Array.isArray(recheckData.data) && recheckData.data.length > 0;

    if (businessId) {
      await svc.from('local_businesses').update({ has_business_payment_method: hasCard }).eq('id', businessId);
    } else {
      await svc.from('profiles').update({ has_payment_method: hasCard }).eq('id', user.id);
    }

    return json({ ok: true, has_card: hasCard, removed });
  } catch (err) {
    console.error('[remove-card]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

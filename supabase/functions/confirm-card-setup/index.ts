import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * confirm-card-setup
 *
 * Called AFTER the Stripe SetupIntent (card-add) PaymentSheet succeeds. Sets the
 * "has a card" flag SERVER-SIDE — this MUST be server-side because the
 * tg_profiles_lock_sensitive trigger reverts any client-side write to
 * profiles.has_payment_method (a privilege/anti-tamper control). So the old
 * client `profiles.update({ has_payment_method: true })` was silently undone and
 * the app never knew the card existed.
 *
 * We don't just trust the client: we ask Stripe whether the customer actually
 * has a saved card, then set the flag to match (self-healing).
 *
 * Body: { business_id?: string }  (omit = the user's personal/central card)
 * Returns: { ok: true, has_card: boolean }
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

    // Ask Stripe whether the customer actually has a saved card.
    const pmRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
      { headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' } },
    );
    const pmData = await pmRes.json();
    if (!pmRes.ok) throw new Error(pmData.error?.message ?? 'Could not read payment methods from Stripe');
    const hasCard = Array.isArray(pmData.data) && pmData.data.length > 0;

    // Set the flag to match reality (service role bypasses the lock trigger).
    if (businessId) {
      await svc.from('local_businesses').update({ has_business_payment_method: hasCard }).eq('id', businessId);
    } else {
      await svc.from('profiles').update({ has_payment_method: hasCard }).eq('id', user.id);
    }

    return json({ ok: true, has_card: hasCard });
  } catch (err) {
    console.error('[confirm-card-setup]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

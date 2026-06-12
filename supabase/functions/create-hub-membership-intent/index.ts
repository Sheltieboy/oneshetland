import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';
const DEFAULT_FLAT_FEE_PENCE = 50;

function stripeHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
async function listSavedCard(customerId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
    { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `Stripe payment_methods list failed (HTTP ${res.status})`);
  return data.data?.[0]?.id ?? null;
}
async function createPaymentIntent(params: Record<string, string>): Promise<any> {
  const res  = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers: stripeHeaders(), body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe PaymentIntent failed (HTTP ${res.status})`);
  return json;
}

/**
 * create-hub-membership-intent
 *
 * Pays for a PAID hub membership tier. Destination charge: the membership price
 * routes to the hub's connected account; the platform keeps a flat application
 * fee (admin_config fees.hub_membership.flat_pence, added ON TOP so the hub
 * receives the full price). Guarded: the hub must have a payout-ready connected
 * account before any membership can be sold. Free tiers do NOT use this — the
 * client joins them directly.
 *
 *   use_saved_card = true  → off-session charge → { charged, payment_intent_id }
 *   use_saved_card = false → { clientSecret, payment_intent_id } for PaymentSheet
 *
 * Body: { membership_type_id: string, use_saved_card?: boolean }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

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

    const { membership_type_id, use_saved_card = false } = await req.json();
    if (!membership_type_id) return json({ error: 'membership_type_id required' }, 400);

    // Membership type + its hub
    const { data: type } = await svc
      .from('hub_membership_types')
      .select('id, hub_id, name, price_pence, period, is_active')
      .eq('id', membership_type_id)
      .single();
    if (!type || !type.is_active) return json({ error: 'Membership tier not available' }, 404);
    if (type.price_pence <= 0) return json({ error: 'This tier is free — join directly.' }, 400);

    const { data: hub } = await svc
      .from('hubs')
      .select('id, name, stripe_account_id, payout_enabled, is_active')
      .eq('id', type.hub_id)
      .single();
    if (!hub || !hub.is_active) return json({ error: 'Hub not available' }, 404);

    // Payout-readiness guard: never sell a membership the hub can't be paid for.
    if (!hub.stripe_account_id || !hub.payout_enabled) {
      return json({ error: 'This hub has not finished setting up payouts yet.' }, 409);
    }

    // Flat platform fee (added on top — hub receives the full membership price).
    const { data: feeRow } = await svc
      .from('admin_config').select('value').eq('key', 'fees.hub_membership.flat_pence').maybeSingle();
    const flatFee = Math.max(0, parseInt(feeRow?.value ?? '', 10) || DEFAULT_FLAT_FEE_PENCE);
    const totalPence = type.price_pence + flatFee;

    const baseParams: Record<string, string> = {
      amount:      String(totalPence),
      currency:    'gbp',
      description: `OneShetland Hub membership — ${hub.name} (${type.name})`,
      'transfer_data[destination]': hub.stripe_account_id,
      'metadata[type]':               'hub_membership',
      'metadata[hub_id]':             hub.id,
      'metadata[membership_type_id]': type.id,
      'metadata[period]':             type.period,
      'metadata[user_id]':            user.id,
      'metadata[face_pence]':         String(type.price_pence),
      'metadata[fee_pence]':          String(flatFee),
    };
    if (flatFee > 0) baseParams['application_fee_amount'] = String(flatFee);

    // ── Saved card, off-session ──────────────────────────────────────────────
    if (use_saved_card) {
      const { data: profile } = await svc
        .from('profiles').select('stripe_customer_id').eq('id', user.id).single();
      const customerId = profile?.stripe_customer_id;
      if (!customerId) return json({ error: 'No saved card found. Add a payment card in your account.' }, 400);

      const pmId = await listSavedCard(customerId);
      if (!pmId) return json({ error: 'No saved card found. Add a payment card in your account.' }, 400);

      const pi = await createPaymentIntent({
        ...baseParams,
        customer:       customerId,
        payment_method: pmId,
        confirm:        'true',
        off_session:    'true',
      });
      if (pi.status !== 'succeeded') {
        return json({ error: `Payment did not complete (status: ${pi.status}).` }, 402);
      }
      return json({ charged: true, payment_intent_id: pi.id });
    }

    // ── PaymentSheet (no saved card) ─────────────────────────────────────────
    const pi = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });
    return json({ clientSecret: pi.client_secret, payment_intent_id: pi.id });
  } catch (err) {
    console.error('[create-hub-membership-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

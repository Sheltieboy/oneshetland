import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const MIN_PENCE = 100;       // £1 minimum
const MAX_PENCE = 1_000_000; // £10,000 cap per donation

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
 * create-hub-donation-intent
 *
 * Donate to a hub fundraising campaign. Destination charge to the hub's
 * connected account; optional flat platform fee (default 0). Payout-readiness
 * guarded. The donation row + Gift Aid declaration are written by
 * confirm-hub-donation after payment succeeds.
 *
 *   use_saved_card = true  → { charged, payment_intent_id }
 *   use_saved_card = false → { clientSecret, payment_intent_id }
 *
 * Body: { campaign_id, amount_pence, use_saved_card? }
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

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { campaign_id, amount_pence, use_saved_card = false, cover_fees = false } = await req.json();
    if (!campaign_id) return json({ error: 'campaign_id required' }, 400);
    const amount = Math.round(Number(amount_pence));
    if (!Number.isFinite(amount) || amount < MIN_PENCE || amount > MAX_PENCE) {
      return json({ error: 'Donation must be between £1 and £10,000.' }, 400);
    }

    const { data: campaign } = await svc.from('hub_campaigns')
      .select('id, hub_id, title, status').eq('id', campaign_id).single();
    if (!campaign || campaign.status !== 'active') return json({ error: 'Campaign not available' }, 404);

    const { data: hub } = await svc.from('hubs')
      .select('id, name, stripe_account_id, payout_enabled, is_active, slug').eq('id', campaign.hub_id).single();
    if (!hub || !hub.is_active) return json({ error: 'Hub not available' }, 404);
    // Demo hubs (slug 'demo-…') exist only for testing and have no real Stripe
    // Connect account — in test mode we charge the platform directly (no
    // destination transfer). Real hubs must be payout-ready.
    const isDemoHub = (hub.slug ?? '').startsWith('demo-');
    const hubHasAccount = !!(hub.stripe_account_id && hub.payout_enabled);
    if (!isDemoHub && !hubHasAccount) {
      return json({ error: 'This hub has not finished setting up payouts yet.' }, 409);
    }

    // Donations earn the platform nothing. We retain an application_fee equal to
    // Stripe's estimated processing fee — the platform keeps it but immediately
    // pays it back to Stripe, netting ~£0, so the HUB effectively bears the fee.
    // If the donor opts to "cover the fee", we add the same estimate on top so
    // the hub still nets the full donation.
    // Platform commission — admin-editable, see fees.donation.* in admin_config.
    // Default 1.5% + 20p (matches the previous hardcoded ~Stripe-cost estimate).
    // Computed on the face donation amount, not the cover-fee-inclusive total.
    const donationCfg = await getCommissionConfig(svc, 'donation');
    const feeEstimate = calculateCommission(amount, donationCfg, 'donation').fee_pence;
    const coverPence = cover_fees ? feeEstimate : 0;
    const totalPence = amount + coverPence;

    const baseParams: Record<string, string> = {
      amount:      String(totalPence),
      currency:    'gbp',
      description: `OneShetland donation — ${hub.name} (${campaign.title})`,
      'metadata[type]':        'hub_donation',
      'metadata[campaign_id]': campaign.id,
      'metadata[hub_id]':      hub.id,
      'metadata[user_id]':     user.id,
      'metadata[face_pence]':  String(amount),
      'metadata[fee_pence]':   '0',
      'metadata[cover_pence]': String(coverPence),
    };
    // Route to the hub's Connect account only when it has one (a real,
    // payout-ready hub). Demo hubs have none → charge the platform.
    if (hubHasAccount) {
      baseParams['transfer_data[destination]'] = hub.stripe_account_id;
      baseParams['application_fee_amount']      = String(feeEstimate);
    }

    if (use_saved_card) {
      const { data: profile } = await svc.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
      const customerId = profile?.stripe_customer_id;
      if (!customerId) return json({ error: 'No saved card found. Add a payment card in your account.' }, 400);
      const pmId = await listSavedCard(customerId);
      if (!pmId) return json({ error: 'No saved card found. Add a payment card in your account.' }, 400);
      const pi = await createPaymentIntent({ ...baseParams, customer: customerId, payment_method: pmId, confirm: 'true', off_session: 'true' });
      if (pi.status !== 'succeeded') return json({ error: `Payment did not complete (status: ${pi.status}).` }, 402);
      return json({ charged: true, payment_intent_id: pi.id });
    }

    const pi = await createPaymentIntent({ ...baseParams, 'automatic_payment_methods[enabled]': 'true' });
    return json({ clientSecret: pi.client_secret, payment_intent_id: pi.id });
  } catch (err) {
    console.error('[create-hub-donation-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

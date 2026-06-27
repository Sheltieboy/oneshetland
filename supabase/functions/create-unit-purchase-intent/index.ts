import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

// ── Stripe helpers (raw fetch — avoids esm.sh SDK's Deno.core.runMicrotasks crash) ─

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
 * create-unit-purchase-intent
 *
 * Creates a Stripe PaymentIntent for buying a Book unit item (a ticket,
 * class pack, day pass, etc.). Caller is the buyer, NOT the recipient —
 * gift purchases use a separate flow.
 *
 * Two modes (same as create-boost-intent):
 *
 *   use_saved_card = true  → off-session charge against the user's central card.
 *                            Returns { charged: true, payment_intent_id }.
 *   use_saved_card = false → returns { clientSecret } for PaymentSheet.
 *
 * Body: { unit_item_id: string, use_saved_card?: boolean }
 *
 * Validation:
 *   - Item must exist and be is_active = true
 *   - If stock is finite and = 0, reject with stock_exhausted
 *
 * Does NOT insert the purchase row — that's confirm-unit-purchase's job.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { unit_item_id, use_saved_card = false } = await req.json();
    if (!unit_item_id) {
      return new Response(JSON.stringify({ error: 'unit_item_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: item } = await supabase
      .from('book_unit_items')
      .select('id, name, price_pence, stock, is_active, business_id')
      .eq('id', unit_item_id)
      .single();

    if (!item || !item.is_active) {
      return new Response(JSON.stringify({ error: 'Item not available' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (item.stock !== null && item.stock <= 0) {
      return new Response(JSON.stringify({ error: 'stock_exhausted' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // The business must be set up for payouts before we take money.
    const { data: unitBiz } = await supabase
      .from('local_businesses')
      .select('stripe_account_id, payout_enabled, slug')
      .eq('id', item.business_id)
      .single();
    // Demo businesses (slug 'demo-…') exist only for testing and have no real
    // Stripe Connect account — in test mode we charge the platform directly
    // (no destination transfer). Real businesses must be payout-ready.
    const isDemoBiz = (unitBiz?.slug ?? '').startsWith('demo-');
    if (!isDemoBiz && (!unitBiz?.stripe_account_id || !unitBiz.payout_enabled)) {
      return new Response(JSON.stringify({ error: "This business isn't set up to take payments yet." }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Platform commission — admin-editable, see fees.unit.* in admin_config.
    // Default 5% (matches the previous hardcoded rate).
    const unitCfg = await getCommissionConfig(supabase, 'unit');
    const unitPlatformFee = calculateCommission(item.price_pence, unitCfg, 'unit').fee_pence;

    const baseParams: Record<string, string> = {
      amount:      String(item.price_pence),
      currency:    'gbp',
      description: `OneShetland Book — ${item.name}`,
      'metadata[type]':         'unit_purchase',
      'metadata[unit_item_id]': item.id,
      'metadata[business_id]':  item.business_id,
      'metadata[buyer_id]':     user.id,
    };
    // Route to the business's Connect account only when it has one (a real,
    // payout-ready business). Demo businesses have none → charge the platform.
    if (unitBiz?.stripe_account_id && unitBiz.payout_enabled) {
      baseParams['transfer_data[destination]'] = unitBiz.stripe_account_id;
      baseParams['application_fee_amount']      = String(unitPlatformFee);
    }

    // ── Mode 1: saved card, off-session ──────────────────────────────────────
    if (use_saved_card) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      const customerId = profile?.stripe_customer_id;
      if (!customerId) {
        return new Response(JSON.stringify({ error: 'No saved card found. Please add a payment card in your account.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const pmId = await listSavedCard(customerId);
      if (!pmId) {
        return new Response(JSON.stringify({ error: 'No saved card found. Please update your payment card in account settings.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const paymentIntent = await createPaymentIntent({
        ...baseParams,
        customer:       customerId,
        payment_method: pmId,
        confirm:        'true',
        off_session:    'true',
      });

      if (paymentIntent.status !== 'succeeded') {
        return new Response(JSON.stringify({ error: `Payment did not succeed (status: ${paymentIntent.status}). Please check your card.` }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({ charged: true, payment_intent_id: paymentIntent.id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Mode 2: PaymentSheet (no saved card) ─────────────────────────────────
    const paymentIntent = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-unit-purchase-intent]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

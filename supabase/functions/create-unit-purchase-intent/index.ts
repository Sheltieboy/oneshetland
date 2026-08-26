import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';

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

async function createPaymentIntent(params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { ...stripeHeaders() };
  // Idempotency-Key makes a retried create (lost response, double-tap) return the
  // ORIGINAL PaymentIntent instead of charging the saved card a second time.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res  = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers, body: new URLSearchParams(params),
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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-unit-purchase-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { unit_item_id, use_saved_card = false, client_request_id = null } = await req.json();
    if (!unit_item_id) {
      return new Response(JSON.stringify({ error: 'unit_item_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // One deliberate checkout = one attempt id, and it goes into the Stripe
    // idempotency key. Without it the key was `unit-<user>-<item>`, which Stripe
    // honours for 24 hours — so a customer buying the same coffee card twice in
    // a day got the FIRST PaymentIntent back, fulfilment deduped on it, and they
    // received no second pass while the UI said it had worked.
    //
    // Same shape and same validation as create-event-ticket-intent. It is an
    // idempotency token ONLY: the amount, the buyer and the item are still read
    // from the database and the auth token, never from this.
    if (typeof client_request_id !== 'string' || client_request_id.trim().length === 0 ||
        client_request_id.length < 8 || client_request_id.length > 100) {
      return new Response(JSON.stringify({ error: 'client_request_id required' }), {
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
    // Asking for the saved card is a PREFERENCE, not an assertion that one
    // exists. A first-time buyer has no card on file, and turning that into
    // "No saved card found" made a first purchase impossible — the client had
    // no way to ask for the card form instead. Having no card is not an error;
    // it means the card form is the right screen. A saved card that FAILS
    // still errors further down, because that is a different thing.
    let customerId: string | null = null;
    let pmId: string | null = null;
    if (use_saved_card) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();
      customerId = profile?.stripe_customer_id ?? null;
      pmId = customerId ? await listSavedCard(customerId) : null;
    }

    if (customerId && pmId) {
      const paymentIntent = await createPaymentIntent({
        ...baseParams,
        ...onSessionConfirm(customerId, pmId),
      }, `unit-${user.id}-${item.id}-${client_request_id}`);

        const outcome = classifyIntent(paymentIntent);
        if (outcome.kind === 'requires_action') {
          // Middle of a payment, not the end of one: the SDK finishes THIS intent.
          return new Response(JSON.stringify({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (outcome.kind === 'processing') {
          return new Response(JSON.stringify({ status: 'processing', payment_intent_id: outcome.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (outcome.kind !== 'succeeded') {
          return new Response(JSON.stringify({ status: 'failed', error: failureMessage(outcome.status) }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    }, `unit-${user.id}-${item.id}-${client_request_id}`);

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-unit-purchase-intent]', err);
    return new Response(
      JSON.stringify({ error: safeError('create-unit-purchase-intent', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

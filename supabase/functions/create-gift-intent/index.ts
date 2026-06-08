import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

function stripePostHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
function stripeGetHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
async function listSavedCard(customerId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
    { headers: stripeGetHeaders() },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `Stripe payment_methods list failed (HTTP ${res.status})`);
  return data.data?.[0]?.id ?? null;
}
async function createPaymentIntent(params: Record<string, string>): Promise<any> {
  const res  = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers: stripePostHeaders(), body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe PaymentIntent failed (HTTP ${res.status})`);
  return json;
}

/**
 * create-gift-intent
 *
 * Begins a gift purchase: writes a pending book_gifts row, then creates a
 * Stripe PaymentIntent (with the gift_id in metadata so confirm-gift can
 * route it back).
 *
 * Body:
 *   {
 *     kind:           'unit' | 'booking',
 *     unit_item_id?:  string,   // required when kind = 'unit'
 *     service_id?:    string,   // required when kind = 'booking'
 *     recipient_email: string,
 *     recipient_name?: string,
 *     message?:       string,
 *     use_saved_card?: boolean,
 *   }
 *
 * Returns either:
 *   { charged: true, payment_intent_id, gift_id }            ← off-session success
 * or:
 *   { clientSecret, payment_intent_id, gift_id }             ← PaymentSheet path
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

    const body = await req.json();
    const { kind, unit_item_id, service_id, recipient_email, recipient_name, message, use_saved_card = false } = body;

    if (!kind || (kind !== 'unit' && kind !== 'booking')) {
      return new Response(JSON.stringify({ error: 'kind must be "unit" or "booking"' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!recipient_email || !/^\S+@\S+\.\S+$/.test(recipient_email)) {
      return new Response(JSON.stringify({ error: 'A valid recipient email is required.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve price + business from the item/service.
    let pricePence: number | null = null;
    let businessId: string | null = null;
    let itemLabel = '';

    if (kind === 'unit') {
      if (!unit_item_id) {
        return new Response(JSON.stringify({ error: 'unit_item_id required for unit gifts' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: item } = await supabase
        .from('book_unit_items')
        .select('id, business_id, name, price_pence, stock, is_active')
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
      pricePence = item.price_pence;
      businessId = item.business_id;
      itemLabel  = item.name;
    } else {
      if (!service_id) {
        return new Response(JSON.stringify({ error: 'service_id required for booking gifts' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: svc } = await supabase
        .from('book_services')
        .select('id, business_id, name, price_pence, is_active')
        .eq('id', service_id)
        .single();
      if (!svc || !svc.is_active || svc.price_pence <= 0) {
        return new Response(JSON.stringify({ error: 'Service not available for gifting' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      pricePence = svc.price_pence;
      businessId = svc.business_id;
      itemLabel  = svc.name;
    }

    // Insert pending gift row (no code yet — generated on confirm).
    const giftRow: Record<string, unknown> = {
      kind,
      status:           'pending_payment',
      code:             crypto.randomUUID(),  // placeholder; will be replaced with short code on confirm
      business_id:      businessId,
      unit_item_id:     kind === 'unit'    ? unit_item_id : null,
      service_id:       kind === 'booking' ? service_id   : null,
      purchaser_id:     user.id,
      recipient_email:  recipient_email.toLowerCase().trim(),
      recipient_name:   recipient_name?.trim() || null,
      message:          message?.trim().slice(0, 500) || null,
      price_paid_pence: pricePence,
    };

    const { data: gift, error: giftErr } = await supabase
      .from('book_gifts')
      .insert(giftRow)
      .select('id')
      .single();

    if (giftErr || !gift) {
      console.error('[create-gift-intent] gift insert failed', giftErr);
      return new Response(JSON.stringify({ error: giftErr?.message ?? 'Could not start gift.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseParams: Record<string, string> = {
      amount:      String(pricePence!),
      currency:    'gbp',
      description: `OneShetland gift — ${itemLabel}`,
      'metadata[type]':        'gift_purchase',
      'metadata[gift_id]':     gift.id,
      'metadata[kind]':        kind,
      'metadata[business_id]': businessId!,
      'metadata[buyer_id]':    user.id,
    };

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
        return new Response(JSON.stringify({ error: `Payment did not succeed (status: ${paymentIntent.status}).` }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Stash the PI on the gift now so confirm-gift can find it idempotently.
      await supabase
        .from('book_gifts')
        .update({ payment_intent_id: paymentIntent.id })
        .eq('id', gift.id);

      return new Response(
        JSON.stringify({ charged: true, payment_intent_id: paymentIntent.id, gift_id: gift.id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Mode 2: PaymentSheet (no saved card) ─────────────────────────────────
    const paymentIntent = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });
    await supabase
      .from('book_gifts')
      .update({ payment_intent_id: paymentIntent.id })
      .eq('id', gift.id);

    return new Response(
      JSON.stringify({
        clientSecret:      paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        gift_id:           gift.id,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-gift-intent]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

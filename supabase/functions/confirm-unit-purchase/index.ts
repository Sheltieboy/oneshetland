import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-unit-purchase
 *
 * Called after a successful Stripe payment for a Book unit item.
 * Verifies the PaymentIntent succeeded and inserts the book_unit_purchases
 * row owned by the caller. The decrement-stock trigger fires automatically.
 *
 * Idempotent — if a row already exists for this payment_intent_id, returns
 * that one instead of inserting a duplicate.
 *
 * Body: { unit_item_id: string, payment_intent_id: string }
 * Returns: { ok: true, purchase_id: string, uses_remaining: number, expires_at: string | null }
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

    const { unit_item_id, payment_intent_id } = await req.json();
    if (!unit_item_id || !payment_intent_id) {
      return new Response(JSON.stringify({ error: 'unit_item_id and payment_intent_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Idempotency — return existing row if we've already recorded this PI.
    const { data: existing } = await supabase
      .from('book_unit_purchases')
      .select('id, uses_remaining, expires_at')
      .eq('payment_intent_id', payment_intent_id)
      .maybeSingle();
    if (existing) {
      return new Response(
        JSON.stringify({ ok: true, purchase_id: existing.id, uses_remaining: existing.uses_remaining, expires_at: existing.expires_at }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Verify the PaymentIntent really succeeded and matches this user/item.
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      {
        headers: {
          'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
          'Stripe-Version': STRIPE_API_VERSION,
        },
      },
    );
    const pi = await piRes.json();
    if (!piRes.ok) {
      throw new Error(pi.error?.message ?? `Stripe PaymentIntent retrieve failed (HTTP ${piRes.status})`);
    }
    if (pi.status !== 'succeeded') {
      return new Response(JSON.stringify({ error: `Payment not completed (status: ${pi.status}).` }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (pi.metadata?.buyer_id !== user.id || pi.metadata?.unit_item_id !== unit_item_id) {
      return new Response(JSON.stringify({ error: 'PaymentIntent does not match this purchase.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: item } = await supabase
      .from('book_unit_items')
      .select('id, business_id, price_pence, uses_per_purchase, valid_days')
      .eq('id', unit_item_id)
      .single();

    if (!item) {
      return new Response(JSON.stringify({ error: 'Item not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const expiresAt = item.valid_days
      ? new Date(Date.now() + item.valid_days * 86_400_000).toISOString()
      : null;

    const { data: purchase, error: insertErr } = await supabase
      .from('book_unit_purchases')
      .insert({
        item_id:           item.id,
        business_id:       item.business_id,
        owner_id:          user.id,
        paid_amount_pence: pi.amount,
        uses_remaining:    item.uses_per_purchase,
        payment_intent_id,
        expires_at:        expiresAt,
      })
      .select('id, uses_remaining, expires_at')
      .single();

    if (insertErr || !purchase) {
      console.error('[confirm-unit-purchase] insert failed', insertErr);
      return new Response(JSON.stringify({ error: insertErr?.message ?? 'Could not record purchase.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ ok: true, purchase_id: purchase.id, uses_remaining: purchase.uses_remaining, expires_at: purchase.expires_at }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[confirm-unit-purchase]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

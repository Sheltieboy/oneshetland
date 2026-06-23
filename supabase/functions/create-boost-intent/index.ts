import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
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
    method: 'POST', headers: stripePostHeaders(), body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe PaymentIntent failed (HTTP ${res.status})`);
  return json;
}

/**
 * create-boost-intent
 *
 * Creates a Stripe PaymentIntent for boosting a shift (£2.99 for 24 hours).
 *
 * Two modes:
 *
 *   use_saved_card = true  (default when has_payment_method is set)
 *     → Charges the user's central saved card off-session immediately.
 *       Returns { charged: true, payment_intent_id }.
 *       No PaymentSheet required on the client.
 *
 *   use_saved_card = false  (fallback — user has no card on file)
 *     → Returns { clientSecret } for the client to present a PaymentSheet.
 *
 * Body: { shift_id: string, use_saved_card?: boolean }
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

    const { shift_id, use_saved_card = false, use_business_card = false, business_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Confirm the caller is the employer for this shift
    const { data: shift } = await supabase
      .from('shifts')
      .select('id, title, employer_id')
      .eq('id', shift_id)
      .single();

    if (!shift) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (shift.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseParams: Record<string, string> = {
      amount:      '299',
      currency:    'gbp',
      description: `OneShetland Shifts — Boost: "${shift.title}"`,
      'metadata[shift_id]':    shift_id,
      'metadata[employer_id]': user.id,
      'metadata[type]':        'shift_boost',
    };

    // ── Mode 0: charge the BUSINESS's own saved card (business expense) ────────
    // A boost is the business paying to feature its shift, so it should default
    // to the business card. If the business has no card on file we return a
    // `no_business_card` signal so the app can prompt to add one first.
    if (use_business_card && business_id) {
      const { data: biz } = await supabase
        .from('local_businesses')
        .select('id, name, owner_id, business_stripe_customer_id, has_business_payment_method')
        .eq('id', business_id)
        .single();
      if (!biz || biz.owner_id !== user.id) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (!biz.business_stripe_customer_id || !biz.has_business_payment_method) {
        return new Response(JSON.stringify({ error: 'no_business_card', business_id }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const bizPm = await listSavedCard(biz.business_stripe_customer_id);
      if (!bizPm) {
        return new Response(JSON.stringify({ error: 'no_business_card', business_id }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const pi = await createPaymentIntent({
        ...baseParams,
        'metadata[business_id]': business_id,
        customer:       biz.business_stripe_customer_id,
        payment_method: bizPm,
        confirm:        'true',
        off_session:    'true',
      });
      if (pi.status !== 'succeeded') {
        return new Response(JSON.stringify({ error: `Payment did not succeed (status: ${pi.status}). Please check the business card.` }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ charged: true, payment_intent_id: pi.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Mode 1: charge saved card off-session ─────────────────────────────────
    if (use_saved_card) {
      // Look up the user's central stripe_customer_id
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

      // Confirm immediately — off_session means no 3DS prompt for small amounts
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

    // ── Mode 2: return clientSecret for PaymentSheet (fallback / no saved card) ──
    const paymentIntent = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-boost-intent]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

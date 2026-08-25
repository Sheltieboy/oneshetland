import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

/** Why a shift cannot be boosted, said the way an employer would say it. */
const BOOST_INELIGIBLE: Record<string, string> = {
  cancelled:       'This shift has been cancelled, so it cannot be boosted.',
  completed:       'This shift is complete, so it cannot be boosted.',
  filled:          'Every position on this shift is filled, so there is nothing to promote.',
  draft:           'Post this shift before boosting it.',
  not_open:        'This shift is not open, so it cannot be boosted.',
  ended:           'This shift has already finished, so boosting it would promote nothing.',
  already_boosted: 'This shift is already boosted. You can boost it again once that runs out.',
};

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
async function createPaymentIntent(params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { ...stripePostHeaders() as Record<string, string> };
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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-boost-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { shift_id, use_saved_card = false, use_business_card = false, business_id,
            client_request_id = null } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // One deliberate checkout = one attempt id, and it goes into the Stripe
    // idempotency key. Without it the key was `boost-<user>-<shift>`, which
    // Stripe honours for ~24 hours — so a declined card was REPLAYED as a
    // decline for a day, and trying a different card could not even reach the
    // issuer. A later re-boost of the same shift could come back as the first,
    // already-succeeded PaymentIntent, which fulfilment then deduped away while
    // the page said "Shift boosted!".
    //
    // Same shape and same validation as create-unit-purchase-intent. It is an
    // idempotency token ONLY: the buyer, the shift, the £2.99 and the 24 hours
    // are all read from the auth token and the database, never from this.
    if (typeof client_request_id !== 'string' || client_request_id.trim().length === 0 ||
        client_request_id.length < 8 || client_request_id.length > 100) {
      return new Response(JSON.stringify({ error: 'client_request_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Ownership AND eligibility, from the one definition both card and wallet
    // use. Nothing is charged for a shift no consumer query can return.
    const { data: eligRows, error: eligErr } = await supabase
      .rpc('shift_boost_eligibility', { p_shift: shift_id });
    if (eligErr) throw eligErr;
    const shift = Array.isArray(eligRows) ? eligRows[0] : eligRows;

    if (!shift || shift.reason === 'shift_not_found') {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (shift.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!shift.eligible) {
      return new Response(JSON.stringify({ error: BOOST_INELIGIBLE[shift.reason] ?? 'This shift cannot be boosted.', reason: shift.reason }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        ...onSessionConfirm(biz.business_stripe_customer_id, bizPm),
      }, `boost-biz-${business_id}-${shift_id}-${client_request_id}`);
      const outcome = classifyIntent(pi);
      if (outcome.kind === 'requires_action') {
        // The issuer wants the cardholder to authenticate. That is the middle of a
        // payment, not the end of one: hand back THIS intent's client secret so the
        // SDK can finish it. No second PaymentIntent, and nothing is fulfilled yet.
        return new Response(JSON.stringify({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (outcome.kind === 'processing') {
        // Stripe has it and has not settled. The webhook fulfils when it resolves.
        return new Response(JSON.stringify({ status: 'processing', payment_intent_id: outcome.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (outcome.kind !== 'succeeded') {
        return new Response(JSON.stringify({ status: 'failed', error: failureMessage(outcome.status) }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

      // The customer is present, so Stripe is told so and decides whether the
      // issuer needs to challenge them.
      const paymentIntent = await createPaymentIntent({
        ...baseParams,
        ...onSessionConfirm(customerId, pmId),
      }, `boost-${user.id}-${shift_id}-${client_request_id}`);

      const outcome = classifyIntent(paymentIntent);
      if (outcome.kind === 'requires_action') {
        // The issuer wants the cardholder to authenticate. That is the middle of a
        // payment, not the end of one: hand back THIS intent's client secret so the
        // SDK can finish it. No second PaymentIntent, and nothing is fulfilled yet.
        return new Response(JSON.stringify({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (outcome.kind === 'processing') {
        // Stripe has it and has not settled. The webhook fulfils when it resolves.
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

    // ── Mode 2: return clientSecret for PaymentSheet (fallback / no saved card) ──
    const paymentIntent = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    }, `boost-form-${user.id}-${shift_id}-${client_request_id}`);

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-boost-intent]', err);
    return new Response(
      JSON.stringify({ error: safeError('create-boost-intent', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

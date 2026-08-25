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

/**
 * local-wallet-topup-intent
 *
 * Creates a Stripe PaymentIntent for a wallet top-up.
 *
 * Two modes (mirrors Boost / Units / Gifts):
 *
 *   use_saved_card = true  → charges the user's central saved card off-session.
 *                            Returns { charged: true, payment_intent_id } and
 *                            the client should call confirm-topup right after
 *                            to credit the wallet.
 *   use_saved_card = false → returns { clientSecret } for the Stripe Payment Sheet.
 *                            Used when the user has no saved card yet (first-ever
 *                            top-up) or chose to add a new card.
 *
 * Body: { amount_pence: number, use_saved_card?: boolean, client_request_id: string }
 *
 * client_request_id is REQUIRED and is idempotency only — the amount is
 * validated here and the CREDIT is always taken from Stripe's own pi.amount.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('local-wallet-topup-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Default to saved-card mode so older app builds (which don't pass this
    // flag yet) still get the centralised-payment UX. Falls back to
    // PaymentSheet automatically if the customer has no saved card.
    const { amount_pence, use_saved_card = true, client_request_id = null } = await req.json();

    // ── The amount must be a genuine integer number of pence ──────────────
    //
    // This used to be `!amount_pence || amount_pence < 500 || amount_pence > 50_000`,
    // which leans on JavaScript coercion: the STRING "1000" passed it and
    // created a real £10 PaymentIntent, while "abc", {} and 1000.7 sailed
    // through to Stripe and failed there instead of here. Nothing was
    // exploitable — the credit always comes from Stripe's own pi.amount — but a
    // money field should not be guarded by accident.
    if (typeof amount_pence !== 'number' || !Number.isFinite(amount_pence) ||
        !Number.isInteger(amount_pence) || amount_pence < 500 || amount_pence > 50_000) {
      return json({ error: 'Amount must be £5–£500' }, 400);
    }

    // ── One deliberate top-up = one attempt reference ─────────────────────
    //
    // The key used to fall back to `topup-<user>-<amount>`, and neither client
    // ever sent an override, so that fallback WAS the key. Stripe honours it for
    // ~24 hours: a customer topping up £10 twice in a day got the first
    // PaymentIntent back, the ledger claim deduplicated on it, and they were
    // told their money had arrived when it had not. A declined card could not be
    // retried at the same amount either.
    //
    // Required now, validated before Stripe, and the fallback is gone.
    if (typeof client_request_id !== 'string' || client_request_id.trim().length === 0 ||
        client_request_id.length < 8 || client_request_id.length > 100) {
      return json({ error: 'client_request_id required' }, 400);
    }
    const topupIdemKey = `topup-${user.id}-${client_request_id}`;

    const baseParams: Record<string, string> = {
      amount:   String(amount_pence),
      currency: 'gbp',
      'metadata[type]':    'local_wallet_topup',
      'metadata[user_id]': user.id,
    };

    // ── Mode 1: saved card, off-session ─────────────────────────────────────
    if (use_saved_card) {
      const { data: profile } = await svc
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();

      const customerId = profile?.stripe_customer_id;
      if (customerId) {
        const pmRes = await fetch(
          `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
          {
            headers: {
              'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
              'Stripe-Version': STRIPE_API_VERSION,
            },
          },
        );
        const pmJson = await pmRes.json();
        if (!pmRes.ok) {
          throw new Error(pmJson.error?.message ?? `Stripe payment_methods list failed (HTTP ${pmRes.status})`);
        }
        const pmId: string | undefined = pmJson.data?.[0]?.id;

        if (pmId) {
          const intentRes = await fetch('https://api.stripe.com/v1/payment_intents', {
            method: 'POST',
            headers: {
              'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
              'Content-Type':   'application/x-www-form-urlencoded',
              'Stripe-Version': STRIPE_API_VERSION,
              'Idempotency-Key': topupIdemKey,
            },
            body: new URLSearchParams({
              ...baseParams,
              ...onSessionConfirm(customerId, pmId),
            }),
          });
          const intent = await intentRes.json();
          if (!intentRes.ok) {
            // Bubble up to the catch — the client can fall back to PaymentSheet
            throw new Error(intent.error?.message ?? `Stripe PaymentIntent failed (HTTP ${intentRes.status})`);
          }
          const outcome = classifyIntent(intent);
          if (outcome.kind === 'requires_action') {
            // The issuer wants the cardholder to authenticate. Hand back THIS
            // intent's secret; the wallet is credited only once it succeeds.
            return json({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id }, 200);
          }
          if (outcome.kind === 'processing') {
            return json({ status: 'processing', payment_intent_id: outcome.id }, 200);
          }
          if (outcome.kind !== 'succeeded') {
            return json({ status: 'failed', error: failureMessage(outcome.status) }, 402);
          }

          return json({ charged: true, payment_intent_id: intent.id });
        }
        // Customer exists but has no saved card — fall through to PaymentSheet mode.
      }
      // No stripe_customer_id at all — fall through to PaymentSheet so the
      // user can add a card and top up in the same flow.
    }

    // ── Mode 2: PaymentSheet (no saved card / first time / new card) ─────────
    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization':   `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Content-Type':    'application/x-www-form-urlencoded',
        'Stripe-Version':  STRIPE_API_VERSION,
        // This route carried no key at all, so a double submit minted two
        // PaymentIntents — two real charges, two real credits.
        'Idempotency-Key': `topup-form-${user.id}-${client_request_id}`,
      },
      body: new URLSearchParams({
        ...baseParams,
        'automatic_payment_methods[enabled]': 'true',
      }),
    });
    const intent = await piRes.json();
    if (!piRes.ok) {
      throw new Error(intent.error?.message ?? `Stripe PaymentIntent failed (HTTP ${piRes.status})`);
    }

    return json({
      clientSecret: intent.client_secret,
      payment_intent_id: intent.id,
    });
  } catch (err) {
    console.error('[local-wallet-topup-intent]', err);
    return json({ error: safeError('local-wallet-topup-intent', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

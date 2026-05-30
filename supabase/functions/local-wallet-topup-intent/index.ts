import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@13?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-wallet-topup-intent
 *
 * Creates a Stripe PaymentIntent for a wallet top-up.
 * The mobile app uses the returned clientSecret with the Stripe Payment Sheet.
 * After success, the app calls /local-wallet-confirm-topup to credit the wallet.
 *
 * Body: { amount_pence: number }   // e.g. 1000 = £10
 * Returns: { clientSecret: string, payment_intent_id: string }
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

    const { amount_pence } = await req.json();
    if (!amount_pence || amount_pence < 500 || amount_pence > 50_000) {
      return json({ error: 'Amount must be £5–£500' }, 400);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const intent = await stripe.paymentIntents.create({
      amount: amount_pence,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: {
        type: 'local_wallet_topup',
        user_id: user.id,
      },
    });

    return json({
      clientSecret: intent.client_secret,
      payment_intent_id: intent.id,
    });
  } catch (err) {
    console.error('[local-wallet-topup-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

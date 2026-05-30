import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@13?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-wallet-confirm-topup
 *
 * Called from the app after Stripe Payment Sheet succeeds.
 * Verifies the PaymentIntent with Stripe and credits the wallet.
 * Idempotent — calling twice with the same payment_intent_id won't double-credit.
 *
 * Body: { payment_intent_id: string }
 * Returns: { balance_pence: number }
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

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { payment_intent_id } = await req.json();
    if (!payment_intent_id) return json({ error: 'payment_intent_id required' }, 400);

    // Idempotency check
    const { data: existing } = await svc
      .from('local_wallet_transactions')
      .select('id')
      .eq('stripe_payment_intent_id', payment_intent_id)
      .maybeSingle();

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (intent.metadata?.user_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (intent.status !== 'succeeded') return json({ error: 'Payment not completed' }, 400);

    // If already recorded, return current balance
    if (existing) {
      const { data: bal } = await svc
        .from('local_wallet_balances')
        .select('balance_pence')
        .eq('user_id', user.id)
        .maybeSingle();
      return json({ balance_pence: bal?.balance_pence ?? 0 });
    }

    const amount = intent.amount;

    // Read-modify-write the balance (acceptable at low scale; consider DB function later)
    const { data: balRow } = await svc
      .from('local_wallet_balances')
      .select('balance_pence')
      .eq('user_id', user.id)
      .maybeSingle();

    const newBalance = (balRow?.balance_pence ?? 0) + amount;

    await svc
      .from('local_wallet_balances')
      .upsert({
        user_id: user.id,
        balance_pence: newBalance,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    await svc.from('local_wallet_transactions').insert({
      user_id: user.id,
      type: 'topup',
      amount_pence: amount,
      stripe_payment_intent_id: payment_intent_id,
      description: 'Wallet top-up',
    });

    return json({ balance_pence: newBalance });
  } catch (err) {
    console.error('[local-wallet-confirm-topup]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

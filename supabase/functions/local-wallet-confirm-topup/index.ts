import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';

type WalletTopupResult = { balance_pence: number; already_credited: boolean };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

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

    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      {
        headers: {
          'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
          'Stripe-Version': STRIPE_API_VERSION,
        },
      },
    );
    const intent = await piRes.json();
    if (!piRes.ok) {
      throw new Error(intent.error?.message ?? `Stripe PaymentIntent retrieve failed (HTTP ${piRes.status})`);
    }

    if (intent.metadata?.user_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (intent.status !== 'succeeded') return json({ error: 'Payment not completed' }, 400);
    // CRITICAL: only a PaymentIntent that was actually created as a wallet top-up
    // may be redeemed as wallet credit. Without this, any of the user's other
    // succeeded card payments (a hub donation, membership, gift, ticket — which
    // all stamp metadata.user_id and hand the PI id back to the client) could be
    // replayed here to mint free wallet credit funded by the platform.
    if (intent.metadata?.type !== 'local_wallet_topup') {
      return json({ error: 'This payment is not a wallet top-up.' }, 400);
    }

    // Amount comes from Stripe (server-verified), never the client.
    const amount = intent.amount;

    // Idempotency and credit in ONE transaction. These were two statements —
    // claim the payment_intent_id in the ledger (a partial UNIQUE index makes
    // that the single source of truth), then wallet_credit. If the second
    // failed, the claim was already committed and every retry returned the
    // uncredited balance as success. The customer had paid and the wallet never
    // moved. The RPC does both or neither.
    const { data: topup, error: topupErr } = await svc
      .rpc('wallet_topup', { p_user: user.id, p_amount: amount, p_pi: payment_intent_id })
      .maybeSingle<WalletTopupResult>();
    if (topupErr) throw topupErr;

    if (topup?.already_credited) {
      return json({ balance_pence: topup.balance_pence ?? 0 });
    }
    const newBalance = topup?.balance_pence ?? 0;

    // Top-up receipt (best-effort).
    try {
      await sendUserPush(svc, {
        userId: user.id, module: 'wallet', categoryId: 'wallet.topup',
        title: 'Wallet topped up',
        body: `£${(amount / 100).toFixed(2)} added to your wallet. New balance £${((newBalance ?? 0) / 100).toFixed(2)}.`,
        data: { screen: 'local-wallet' },
      });
    } catch (e) { console.error('[local-wallet-confirm-topup] notify failed', e); }

    return json({ balance_pence: newBalance });
  } catch (err) {
    console.error('[local-wallet-confirm-topup]', err);
    return json({ error: safeError('local-wallet-confirm-topup', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

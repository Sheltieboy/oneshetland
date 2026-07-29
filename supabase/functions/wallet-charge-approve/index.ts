import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { executeWalletPayment } from '../_shared/wallet-pay.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * wallet-charge-approve
 *
 * CUSTOMER side of charge-by-scan — the consent step. Only the customer the
 * request targets can call it. On 'decline' the request is closed; on 'approve'
 * the wallet debit + Stripe transfer run via the shared executeWalletPayment.
 *
 * Double-charge safe: the pending request is atomically CLAIMED to 'charging'
 * (a conditional update that only one caller can win) before any money moves,
 * and the Stripe transfer carries the request id as its Idempotency-Key.
 *
 * Body: { request_id: string, decision: 'approve' | 'decline' }
 * Returns (approve): { ok, balance_pence, cashback_pence } | (decline): { declined: true }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { request_id, decision } = await req.json();
    if (!request_id || (decision !== 'approve' && decision !== 'decline')) {
      return json({ error: 'request_id and decision (approve|decline) required' }, 400);
    }

    const { data: reqRow } = await svc
      .from('wallet_charge_requests')
      .select('id, business_id, customer_id, amount_pence, status, expires_at')
      .eq('id', request_id)
      .maybeSingle();
    if (!reqRow) return json({ error: 'Charge request not found' }, 404);
    if (reqRow.customer_id !== user.id) return json({ error: 'This request is not for you' }, 403);
    if (reqRow.status !== 'pending') {
      // Already handled — report the settled state rather than erroring.
      return json({ error: `This request is already ${reqRow.status}.`, status: reqRow.status }, 409);
    }
    if (new Date(reqRow.expires_at).getTime() < Date.now()) {
      await svc.from('wallet_charge_requests').update({ status: 'expired', resolved_at: new Date().toISOString() }).eq('id', reqRow.id).eq('status', 'pending');
      return json({ error: 'This request has expired — ask for a new one.', status: 'expired' }, 410);
    }

    // ── Decline ────────────────────────────────────────────────────────────────
    if (decision === 'decline') {
      await svc.from('wallet_charge_requests').update({ status: 'declined', resolved_at: new Date().toISOString() }).eq('id', reqRow.id).eq('status', 'pending');
      return json({ declined: true });
    }

    // ── Approve: atomically CLAIM the request so it can't be charged twice ───────
    const { data: claimed } = await svc
      .from('wallet_charge_requests')
      .update({ status: 'charging' })
      .eq('id', reqRow.id).eq('status', 'pending')
      .select('id');
    if (!claimed || claimed.length === 0) {
      // A concurrent approve won the race, or it lapsed between our read and here.
      const { data: cur } = await svc.from('wallet_charge_requests').select('status').eq('id', reqRow.id).maybeSingle();
      return json({ error: `This request is already ${cur?.status ?? 'closed'}.`, status: cur?.status }, 409);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, accepts_wallet, cashback_percent, stripe_account_id, payout_enabled')
      .eq('id', reqRow.business_id)
      .single();
    if (!business) {
      await svc.from('wallet_charge_requests').update({ status: 'failed', resolved_at: new Date().toISOString() }).eq('id', reqRow.id);
      return json({ error: 'Business not found' }, 404);
    }

    // Idempotency-Key = the request id, so even a retried execution pays once.
    const result = await executeWalletPayment(svc, {
      userId: user.id,
      business,
      amountPence: reqRow.amount_pence,
      idempotencyKey: `charge-${reqRow.id}`,
      label: `Payment at ${business.name}`,
    });

    if (!result.ok) {
      // executeWalletPayment already refunded the wallet if the transfer failed.
      await svc.from('wallet_charge_requests').update({ status: 'failed', resolved_at: new Date().toISOString() }).eq('id', reqRow.id);
      return json({ error: result.error }, result.status);
    }

    await svc.from('wallet_charge_requests')
      .update({ status: 'paid', stripe_transfer_id: result.transfer_id, resolved_at: new Date().toISOString() })
      .eq('id', reqRow.id);

    return json({ ok: true, balance_pence: result.balance_pence, cashback_pence: result.cashback_pence });
  } catch (err) {
    console.error('[wallet-charge-approve]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

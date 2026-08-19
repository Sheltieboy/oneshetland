import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { executeWalletPayment } from '../_shared/wallet-pay.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-wallet-pay
 *
 * Customer pays a business from their wallet — identifying the business by
 * either the rotating till `code` (typed at the counter) OR an `nfc_token`
 * (tapped their tile). Server debits the wallet, credits cashback, and transfers
 * to the business's Stripe Connect account (minus platform fee). Points-based
 * loyalty auto-earns via the local_wallet_transactions trigger.
 *
 * Body: { code?: string, nfc_token?: string, amount_pence: number }  (one of code|nfc_token)
 * Returns: { balance_pence: number, cashback_pence: number }
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

    const { code, nfc_token, amount_pence, client_request_id } = await req.json();
    if ((!code && !nfc_token) || amount_pence == null || amount_pence < 50) {
      return json({ error: 'Need a code or tile, and an amount of at least £0.50' }, 400);
    }

    // Resolve the business — by tapped tile, or by the typed rotating till code.
    let businessId: string;
    if (nfc_token) {
      const { data: b } = await svc.from('local_businesses').select('id').eq('nfc_token', nfc_token).maybeSingle();
      if (!b) return json({ error: 'Tile not recognised' }, 404);
      businessId = b.id;
    } else {
      const { data: codeRow } = await svc
        .from('local_business_codes')
        .select('business_id, expires_at')
        .eq('current_code', code)
        .maybeSingle();
      if (!codeRow) return json({ error: 'Code not found' }, 404);
      if (new Date(codeRow.expires_at).getTime() < Date.now()) {
        return json({ error: 'Code expired — ask for a fresh one' }, 410);
      }
      businessId = codeRow.business_id;
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, accepts_wallet, cashback_percent, stripe_account_id, payout_enabled')
      .eq('id', businessId)
      .single();

    if (!business) return json({ error: 'Business not found' }, 404);

    // Claim the attempt BEFORE any money moves. executeWalletPayment debits and
    // then transfers, so a second tap that got past this point would debit again
    // — a Stripe idempotency key alone would only dedupe the transfer, leaving
    // the customer down twice and the business paid once.
    //
    // Optional: an older client that sends no id behaves exactly as before,
    // rather than being locked out by a server it hasn't caught up with.
    if (client_request_id) {
      const { error: claimErr } = await svc
        .from('wallet_payment_claims')
        .insert({ client_request_id: String(client_request_id).slice(0, 128), user_id: user.id });

      if (claimErr) {
        if (claimErr.code !== '23505') throw claimErr;
        // Someone already claimed this attempt.
        const { data: prior } = await svc
          .from('wallet_payment_claims')
          .select('result, completed_at, user_id')
          .eq('client_request_id', String(client_request_id).slice(0, 128))
          .maybeSingle();
        // A claim belongs to whoever took it; never hand one person another's result.
        if (prior?.user_id !== user.id) return json({ error: 'Payment reference already used' }, 409);
        if (prior?.completed_at && prior.result) return json(prior.result);
        return json({ error: "That payment is already going through — give it a moment." }, 409);
      }
    }

    // Shared execution path (fee, cashback, atomic debit, transfer, refund-on-fail,
    // receipts) — identical to the scan-to-charge flow so the money logic can't drift.
    const result = await executeWalletPayment(svc, {
      userId: user.id, business, amountPence: amount_pence,
      // Belt and braces: even inside one claim, a retried transfer returns the
      // original rather than paying the business twice.
      idempotencyKey: client_request_id ? `wallet-pay:${client_request_id}` : undefined,
    });

    if (!result.ok) {
      // Release the claim so the customer can genuinely try again — a failed
      // payment that can never be retried is worse than the double charge.
      if (client_request_id) {
        await svc.from('wallet_payment_claims').delete()
          .eq('client_request_id', String(client_request_id).slice(0, 128));
      }
      return json({ error: result.error }, result.status);
    }

    const payload = { balance_pence: result.balance_pence, cashback_pence: result.cashback_pence };
    if (client_request_id) {
      await svc.from('wallet_payment_claims')
        .update({ completed_at: new Date().toISOString(), result: payload })
        .eq('client_request_id', String(client_request_id).slice(0, 128));
    }
    return json(payload);
  } catch (err) {
    console.error('[local-wallet-pay]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

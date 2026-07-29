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
 * Customer enters the business's rotating code + an amount.
 * Server:
 *   - validates code
 *   - debits customer's wallet
 *   - credits cashback (if business has cashback_percent > 0)
 *   - transfers funds to business's Stripe Connect account (minus platform fee — see fees.wallet.* in admin_config)
 *
 * Body: { code: string, amount_pence: number }
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

    const { code, amount_pence } = await req.json();
    if (!code || amount_pence == null || amount_pence < 50) {
      return json({ error: 'Invalid code or amount (min £0.50)' }, 400);
    }

    // Validate code
    const { data: codeRow } = await svc
      .from('local_business_codes')
      .select('business_id, expires_at')
      .eq('current_code', code)
      .maybeSingle();
    if (!codeRow) return json({ error: 'Code not found' }, 404);
    if (new Date(codeRow.expires_at).getTime() < Date.now()) {
      return json({ error: 'Code expired — ask for a fresh one' }, 410);
    }

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, accepts_wallet, cashback_percent, stripe_account_id, payout_enabled')
      .eq('id', codeRow.business_id)
      .single();

    if (!business) return json({ error: 'Business not found' }, 404);

    // Shared execution path (fee, cashback, atomic debit, transfer, refund-on-fail,
    // receipts) — identical to the scan-to-charge flow so the money logic can't drift.
    const result = await executeWalletPayment(svc, { userId: user.id, business, amountPence: amount_pence });
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ balance_pence: result.balance_pence, cashback_pence: result.cashback_pence });
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

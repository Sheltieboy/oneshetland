import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';

// Stripe API version pinned via header below — kept aligned with authorise-payment.
const STRIPE_API_VERSION = '2023-10-16';

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
    if (business.owner_id === user.id) return json({ error: "Can't pay yourself" }, 403);
    if (!business.accepts_wallet) return json({ error: "This business doesn't accept wallet payments yet" }, 400);
    if (!business.stripe_account_id || !business.payout_enabled) {
      return json({ error: 'Business hasn\'t finished Stripe onboarding' }, 400);
    }

    // Check balance
    const { data: balRow } = await svc
      .from('local_wallet_balances')
      .select('balance_pence')
      .eq('user_id', user.id)
      .maybeSingle();
    const currentBalance = balRow?.balance_pence ?? 0;
    if (currentBalance < amount_pence) {
      return json({ error: 'Insufficient balance — top up first' }, 402);
    }

    // Cashback is BUSINESS-FUNDED — comes out of the merchant's transfer.
    // The customer's wallet still gets the credit; the business absorbs the
    // cost of the loyalty incentive they themselves set. See migration 034.
    const cashbackPence = Math.floor(amount_pence * (business.cashback_percent ?? 0) / 100);

    // Platform commission — admin-editable, see fees.wallet.* in admin_config.
    const walletCfg = await getCommissionConfig(svc, 'wallet');
    const platformFee = calculateCommission(amount_pence, walletCfg, 'wallet').fee_pence;
    const transferAmount = amount_pence - platformFee - cashbackPence;

    // Refuse if the business would receive nothing (or negative) after fee +
    // cashback — typically only happens if a business sets an extreme cashback
    // rate that combined with the platform fee exceeds the payment.
    if (transferAmount < 1) {
      return json({
        error: 'This payment can\'t be processed — the business\'s cashback rate and platform fee together exceed the payment amount.',
      }, 400);
    }

    // Debit customer wallet
    const newBalance = currentBalance - amount_pence + cashbackPence;
    await svc
      .from('local_wallet_balances')
      .upsert({
        user_id: user.id,
        balance_pence: newBalance,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    // Stripe Connect transfer — raw fetch (no SDK) to avoid the esm.sh Stripe
    // build's Node-compat shim, which crashes under newer Supabase edge
    // runtimes. Same pattern as authorise-payment.
    let transferId: string | null = null;
    try {
      const transferBody = new URLSearchParams({
        amount:      String(transferAmount),
        currency:    'gbp',
        destination: business.stripe_account_id,
        description: `OneShetland Marketplace payment from ${user.id.slice(0, 8)} (£${(platformFee / 100).toFixed(2)} platform fee${cashbackPence > 0 ? ` + £${(cashbackPence / 100).toFixed(2)} cashback to customer` : ''})`,
        'metadata[user_id]':               user.id,
        'metadata[business_id]':           business.id,
        'metadata[application_fee_label]': 'OneShetland platform fee',
        'metadata[application_fee_pence]': String(platformFee),
        'metadata[cashback_to_customer_pence]': String(cashbackPence),
      });

      const transferRes = await fetch('https://api.stripe.com/v1/transfers', {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Stripe-Version': STRIPE_API_VERSION,
        },
        body: transferBody,
      });
      const transferJson = await transferRes.json();
      if (!transferRes.ok) {
        throw new Error(transferJson.error?.message ?? `Stripe transfer failed (HTTP ${transferRes.status})`);
      }
      transferId = transferJson.id;
    } catch (stripeErr) {
      console.error('[local-wallet-pay] Stripe transfer failed:', stripeErr);
      // Refund customer
      await svc
        .from('local_wallet_balances')
        .update({ balance_pence: currentBalance, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      return json({ error: 'Payment to business failed — wallet refunded' }, 502);
    }

    // Record transactions
    await svc.from('local_wallet_transactions').insert([
      {
        user_id: user.id,
        business_id: business.id,
        type: 'spend',
        amount_pence: -amount_pence,
        platform_fee_pence: platformFee,
        cashback_pence: cashbackPence,
        stripe_transfer_id: transferId,
        description: `Payment at ${business.name}`,
      },
      ...(cashbackPence > 0 ? [{
        user_id: user.id,
        business_id: business.id,
        type: 'cashback',
        amount_pence: cashbackPence,
        description: `${business.cashback_percent}% cashback from ${business.name}`,
      }] : []),
    ]);

    return json({ balance_pence: newBalance, cashback_pence: cashbackPence });
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

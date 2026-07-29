/**
 * wallet-pay.ts — the single, shared wallet-payment execution path.
 *
 * Both entry points use it so the money logic (fee, cashback, atomic debit,
 * Stripe transfer, refund-on-failure, receipts) lives in ONE place and can't
 * drift between them:
 *   • local-wallet-pay        — customer enters the business's till code
 *   • wallet-charge-approve   — customer approves a business's scan-to-charge
 *
 * Validation that is specific to each entry (code lookup / request lookup) stays
 * in the caller; this helper takes an already-resolved business + amount.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from './commission.ts';
import { getCommissionConfig } from './commission-config.ts';
import { sendUserPush } from './send-push.ts';

const STRIPE_API_VERSION = '2023-10-16';

export interface PayBusiness {
  id: string;
  name: string;
  owner_id: string;
  accepts_wallet: boolean;
  cashback_percent: number | null;
  stripe_account_id: string | null;
  payout_enabled: boolean;
}

export type WalletPayResult =
  | { ok: true; balance_pence: number; cashback_pence: number; transfer_id: string | null }
  | { ok: false; status: number; error: string };

/**
 * Debit the customer's wallet and pay the business, atomically and idempotently.
 * Returns a discriminated result the caller maps to an HTTP status. Never throws
 * for an expected business condition (insufficient funds, not onboarded, …) —
 * only a genuine infrastructure error propagates.
 */
export async function executeWalletPayment(
  svc: SupabaseClient,
  args: { userId: string; business: PayBusiness; amountPence: number; idempotencyKey?: string; label?: string },
): Promise<WalletPayResult> {
  const { userId, business, amountPence } = args;

  if (business.owner_id === userId) return { ok: false, status: 403, error: "Can't pay yourself" };
  if (!business.accepts_wallet) return { ok: false, status: 400, error: "This business doesn't accept wallet payments yet" };
  if (!business.stripe_account_id || !business.payout_enabled) {
    return { ok: false, status: 400, error: "Business hasn't finished Stripe onboarding" };
  }

  // Cashback is BUSINESS-FUNDED — comes out of the merchant's transfer.
  const cashbackPence = Math.floor(amountPence * (business.cashback_percent ?? 0) / 100);
  const walletCfg = await getCommissionConfig(svc, 'wallet');
  const platformFee = calculateCommission(amountPence, walletCfg, 'wallet').fee_pence;
  const transferAmount = amountPence - platformFee - cashbackPence;
  if (transferAmount < 1) {
    return { ok: false, status: 400, error: "This payment can't be processed — the business's cashback rate and platform fee together exceed the payment amount." };
  }

  // Atomic debit (spend + cashback in one guarded statement). NULL = insufficient.
  const { data: newBalance, error: debitErr } = await svc
    .rpc('wallet_debit', { p_user: userId, p_spend: amountPence, p_cashback: cashbackPence });
  if (debitErr) throw debitErr;
  if (newBalance == null) return { ok: false, status: 402, error: 'Insufficient balance — top up first' };

  // Stripe Connect transfer — raw fetch (avoids the esm.sh Stripe Node-compat shim).
  let transferId: string | null = null;
  try {
    const transferBody = new URLSearchParams({
      amount:      String(transferAmount),
      currency:    'gbp',
      destination: business.stripe_account_id!,
      description: `OneShetland Marketplace payment from ${userId.slice(0, 8)} (£${(platformFee / 100).toFixed(2)} platform fee${cashbackPence > 0 ? ` + £${(cashbackPence / 100).toFixed(2)} cashback to customer` : ''})`,
      'metadata[user_id]':                    userId,
      'metadata[business_id]':                business.id,
      'metadata[application_fee_label]':      'OneShetland platform fee',
      'metadata[application_fee_pence]':      String(platformFee),
      'metadata[cashback_to_customer_pence]': String(cashbackPence),
    });
    const transferRes = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        // Idempotency: a caller-supplied stable key (e.g. the charge-request id)
        // makes a retry return the same transfer instead of paying twice.
        'Idempotency-Key': args.idempotencyKey ?? crypto.randomUUID(),
      },
      body: transferBody,
    });
    const transferJson = await transferRes.json();
    if (!transferRes.ok) throw new Error(transferJson.error?.message ?? `Stripe transfer failed (HTTP ${transferRes.status})`);
    transferId = transferJson.id;
  } catch (stripeErr) {
    console.error('[wallet-pay] Stripe transfer failed:', stripeErr);
    // Refund the net change atomically (we debited spend, credited cashback).
    await svc.rpc('wallet_credit', { p_user: userId, p_amount: amountPence - cashbackPence });
    return { ok: false, status: 502, error: 'Payment to business failed — wallet refunded' };
  }

  // Record transactions.
  await svc.from('local_wallet_transactions').insert([
    {
      user_id: userId,
      business_id: business.id,
      type: 'spend',
      amount_pence: -amountPence,
      platform_fee_pence: platformFee,
      cashback_pence: cashbackPence,
      stripe_transfer_id: transferId,
      description: args.label ?? `Payment at ${business.name}`,
    },
    ...(cashbackPence > 0 ? [{
      user_id: userId,
      business_id: business.id,
      type: 'cashback',
      amount_pence: cashbackPence,
      description: `${business.cashback_percent}% cashback from ${business.name}`,
    }] : []),
  ]);

  // Receipts (best-effort): customer paid, owner received.
  try {
    const paid = `£${(amountPence / 100).toFixed(2)}`;
    const cashbackNote = cashbackPence > 0 ? ` You earned £${(cashbackPence / 100).toFixed(2)} cashback.` : '';
    await sendUserPush(svc, {
      userId, module: 'wallet', categoryId: 'wallet.payment',
      title: 'Payment sent',
      body: `You paid ${paid} at ${business.name}.${cashbackNote}`,
      data: { screen: 'local-wallet' },
    });
    if (business.owner_id) {
      await sendUserPush(svc, {
        userId: business.owner_id, module: 'business', categoryId: 'business.payment_received',
        title: 'Payment received 💷',
        body: `A customer paid ${paid} at ${business.name}.`,
        data: { screen: 'local-business-dashboard' },
      });
    }
  } catch (e) { console.error('[wallet-pay] notify failed', e); }

  return { ok: true, balance_pence: newBalance, cashback_pence: cashbackPence, transfer_id: transferId };
}

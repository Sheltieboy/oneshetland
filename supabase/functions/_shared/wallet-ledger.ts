/**
 * wallet-ledger.ts — the only way money leaves or enters a wallet.
 *
 * WHY THIS EXISTS
 *
 * Every wallet debit in this codebase used to be three separate things:
 *
 *     rpc('wallet_debit')                  // commits the balance change
 *     fetch('https://api.stripe.com/...')  // moves the money
 *     .from('local_wallet_transactions')   // SEPARATE commit, result unchecked
 *       .insert({...})                     // no .select(), no error branch
 *
 * The balance step was never the weak part — it is a single guarded UPDATE that
 * cannot overdraw and cannot lose a race. The weak part was that the accounting
 * entry lived outside it, after a network call, and nobody looked at whether it
 * worked. Production shows the result: three wallets, all BELOW their ledgers,
 * £233.45 unaccounted between them.
 *
 * THE SPLIT THAT MATTERS
 *
 * Local money and external money are not one transaction and pretending they
 * are is how you get a database lock held open across somebody else's API.
 * So there are two moves here, each durable:
 *
 *     debit + ledger        one PostgreSQL transaction — both or neither
 *     stripe transfer       outside it, with the ledger row recording where
 *                           it got to
 *
 * A row in transfer_state='pending' or 'unresolved' is a real, queryable fact
 * about money that needs attention — not a gap in the accounts.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const STRIPE_API_VERSION = '2023-10-16';

export type WalletDebit =
  | { ok: true; balancePence: number; transactionId: string; alreadyApplied: boolean }
  | { ok: false; reason: 'insufficient'; balancePence: number };

/**
 * Take money out of a wallet and record why, atomically.
 *
 * Pass an idempotencyKey whenever the caller has a stable identity for the
 * attempt (an order id, a charge-request id, a client request id). With one, a
 * retry returns the original transaction and moves nothing. Without one, a
 * retry is a second payment — so callers that can supply one, must.
 */
export async function walletDebit(
  svc: SupabaseClient,
  args: {
    userId: string;
    spendPence: number;
    cashbackPence?: number;
    businessId?: string | null;
    description: string;
    idempotencyKey?: string | null;
    platformFeePence?: number | null;
    needsTransfer?: boolean;
  },
): Promise<WalletDebit> {
  const { data, error } = await svc.rpc('wallet_debit_with_ledger', {
    p_user:            args.userId,
    p_spend:           args.spendPence,
    p_cashback:        args.cashbackPence ?? 0,
    p_type:            'spend',
    p_business:        args.businessId ?? null,
    p_description:     args.description,
    p_idempotency_key: args.idempotencyKey ?? null,
    p_platform_fee:    args.platformFeePence ?? null,
    p_needs_transfer:  args.needsTransfer ?? false,
  }).maybeSingle<{
    balance_pence: number; transaction_id: string | null;
    already_applied: boolean; insufficient: boolean;
  }>();

  if (error) throw error;
  if (!data) throw new Error('wallet_debit_with_ledger returned nothing');

  if (data.insufficient) {
    return { ok: false, reason: 'insufficient', balancePence: data.balance_pence };
  }
  return {
    ok: true,
    balancePence: data.balance_pence,
    transactionId: data.transaction_id!,
    alreadyApplied: data.already_applied,
  };
}

/** Record where the external transfer for a ledger row got to. */
export async function walletMarkTransfer(
  svc: SupabaseClient,
  transactionId: string,
  state: 'none' | 'pending' | 'sent' | 'failed' | 'unresolved',
  transferId?: string | null,
): Promise<void> {
  const { error } = await svc.rpc('wallet_mark_transfer', {
    p_transaction_id: transactionId,
    p_state:          state,
    p_transfer_id:    transferId ?? null,
  });
  if (error) console.error('[wallet-ledger] mark transfer failed:', error);
}

/**
 * Put a debit back, by APPENDING a refund entry linked to it.
 *
 * The original debit is never deleted or edited. "This went wrong and we put it
 * back" is a different fact from "nothing happened", and only one of them can
 * be audited afterwards.
 */
export async function walletReverse(
  svc: SupabaseClient,
  transactionId: string,
  reason: string,
): Promise<number | null> {
  const { data, error } = await svc.rpc('wallet_reverse_debit', {
    p_transaction_id: transactionId,
    p_reason:         reason,
  }).maybeSingle<{ balance_pence: number; reversal_id: string; already_reversed: boolean }>();
  if (error) {
    console.error('[wallet-ledger] reversal failed:', error);
    return null;
  }
  return data?.balance_pence ?? null;
}

export type TransferOutcome =
  | { kind: 'sent'; transferId: string }
  /** Stripe refused it. No money moved, so the debit can safely be put back. */
  | { kind: 'rejected'; message: string }
  /**
   * We do not know. A timeout, a dropped connection, a 5xx — Stripe may well
   * have created the transfer and lost the reply. Refunding on this would pay
   * the business AND the customer.
   */
  | { kind: 'unresolved'; message: string };

/**
 * Send a Connect transfer, keyed on the wallet transaction that funded it.
 *
 * The idempotency key is derived from our own transaction id, so it is stable
 * across every retry of the same payment and different for every genuine
 * payment. A retry after a lost response returns Stripe's original transfer
 * rather than creating a second one.
 */
export async function stripeTransfer(args: {
  transactionId: string;
  destination: string;
  amountPence: number;
  description: string;
  metadata?: Record<string, string>;
}): Promise<TransferOutcome> {
  const body = new URLSearchParams({
    amount:      String(args.amountPence),
    currency:    'gbp',
    destination: args.destination,
    description: args.description,
  });
  for (const [k, v] of Object.entries(args.metadata ?? {})) body.set(`metadata[${k}]`, v);
  body.set('metadata[wallet_transaction_id]', args.transactionId);

  let res: Response;
  try {
    res = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: {
        'Authorization':   `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Content-Type':    'application/x-www-form-urlencoded',
        'Stripe-Version':  STRIPE_API_VERSION,
        'Idempotency-Key': `wallet-txn:${args.transactionId}`,
      },
      body,
    });
  } catch (e) {
    // Never reached Stripe, or reached it and the reply was lost. Unknowable
    // from here, so say so rather than guessing in the expensive direction.
    return { kind: 'unresolved', message: e instanceof Error ? e.message : 'network error' };
  }

  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* a body we cannot read is still a status */ }

  if (res.ok) return { kind: 'sent', transferId: String(json.id) };

  const message = ((json.error as { message?: string } | undefined)?.message)
    ?? `Stripe transfer failed (HTTP ${res.status})`;

  // 4xx is Stripe telling us it refused — a bad destination, an unonboarded
  // account, insufficient platform balance. Nothing moved. 5xx and 429 are
  // Stripe having a bad day, which tells us nothing about whether it moved.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    return { kind: 'rejected', message };
  }
  return { kind: 'unresolved', message };
}

/**
 * Debit, transfer, and settle the ledger row — the whole state machine.
 *
 * Returns the customer-facing outcome. The three failure shapes are genuinely
 * different and the caller should not flatten them:
 *
 *   insufficient  nothing happened at all
 *   rejected      debited then put back; an audit trail shows both
 *   unresolved    debited, and whether the business was paid is unknown. The
 *                 wallet is deliberately NOT refunded, because refunding a
 *                 transfer that actually succeeded pays twice. The row is
 *                 marked so it can be settled once Stripe's real state is known.
 */
export async function debitAndTransfer(
  svc: SupabaseClient,
  args: {
    userId: string;
    spendPence: number;
    cashbackPence?: number;
    businessId?: string | null;
    description: string;
    idempotencyKey?: string | null;
    platformFeePence?: number | null;
    /** Omit to debit without any external transfer (a platform-funded purchase). */
    transfer?: { destination: string; amountPence: number; description: string; metadata?: Record<string, string> };
  },
): Promise<
  | { ok: true; balancePence: number; transactionId: string; transferId: string | null; alreadyApplied: boolean }
  | { ok: false; status: number; error: string; reason: 'insufficient' | 'rejected' | 'unresolved'; transactionId?: string }
> {
  const debit = await walletDebit(svc, {
    userId:           args.userId,
    spendPence:       args.spendPence,
    cashbackPence:    args.cashbackPence,
    businessId:       args.businessId,
    description:      args.description,
    idempotencyKey:   args.idempotencyKey,
    platformFeePence: args.platformFeePence,
    needsTransfer:    !!args.transfer,
  });

  if (!debit.ok) {
    return { ok: false, status: 402, error: 'Insufficient balance — top up first', reason: 'insufficient' };
  }

  // A replay of an attempt we already completed. The money moved once; say so
  // and move nothing again.
  if (debit.alreadyApplied) {
    return { ok: true, balancePence: debit.balancePence, transactionId: debit.transactionId, transferId: null, alreadyApplied: true };
  }

  if (!args.transfer) {
    await walletMarkTransfer(svc, debit.transactionId, 'none');
    return { ok: true, balancePence: debit.balancePence, transactionId: debit.transactionId, transferId: null, alreadyApplied: false };
  }

  const outcome = await stripeTransfer({
    transactionId: debit.transactionId,
    destination:   args.transfer.destination,
    amountPence:   args.transfer.amountPence,
    description:   args.transfer.description,
    metadata:      args.transfer.metadata,
  });

  if (outcome.kind === 'sent') {
    await walletMarkTransfer(svc, debit.transactionId, 'sent', outcome.transferId);
    return { ok: true, balancePence: debit.balancePence, transactionId: debit.transactionId, transferId: outcome.transferId, alreadyApplied: false };
  }

  if (outcome.kind === 'rejected') {
    await walletReverse(svc, debit.transactionId, `Transfer rejected: ${outcome.message}`);
    return {
      ok: false, status: 502, reason: 'rejected', transactionId: debit.transactionId,
      error: 'Payment to the recipient failed — your wallet has been refunded.',
    };
  }

  await walletMarkTransfer(svc, debit.transactionId, 'unresolved');
  console.error(
    `[wallet-ledger] UNRESOLVED transfer for wallet txn ${debit.transactionId}: ${outcome.message}. ` +
    'Wallet was NOT refunded — Stripe may have moved the money. Settle from the Stripe dashboard.',
  );
  return {
    ok: false, status: 502, reason: 'unresolved', transactionId: debit.transactionId,
    error: "We couldn't confirm this payment. Don't pay again — we're checking it and will put it right.",
  };
}

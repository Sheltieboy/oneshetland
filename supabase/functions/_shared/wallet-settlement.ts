/**
 * wallet-settlement.ts — production wiring for wallet-settlement-core.ts.
 *
 * Every wallet-checkout route spends through settleMerchantWalletPayment. A
 * structural test fails if wallet-checkout calls debitAndTransfer any other way.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { debitAndTransfer, releaseUnstartedAttempt } from './wallet-ledger.ts';
import { withWalletLiquidityGate } from './wallet-liquidity-gate.ts';
import { settleMerchantWalletPayment as settle } from './wallet-settlement-core.ts';

export { WALLET_UNAVAILABLE_TITLE, WALLET_UNAVAILABLE_NO_CHARGE, WALLET_UNAVAILABLE_RESUMING } from './wallet-settlement-core.ts';

type DebitArgs = Parameters<typeof debitAndTransfer>[1];

export function settleMerchantWalletPayment(
  svc: SupabaseClient,
  o: { requestId: string; userId: string; attempt: { outcome: string }; debit: DebitArgs },
) {
  return settle(
    {
      gate: (transferPence, run) => withWalletLiquidityGate(svc, transferPence, run),
      releaseUnstartedAttempt: async () => { await releaseUnstartedAttempt(svc, o.requestId, o.userId); },
    },
    {
      attemptOutcome: o.attempt.outcome,
      transfer: o.debit.transfer ? { amountPence: o.debit.transfer.amountPence } : undefined,
      debit: () => debitAndTransfer(svc, o.debit),
    },
  );
}

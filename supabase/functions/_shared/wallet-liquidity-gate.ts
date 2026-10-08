/**
 * wallet-liquidity-gate.ts — production wiring for wallet-liquidity-gate-core.ts.
 *
 * Use this around ANY debitAndTransfer call that carries a `transfer` (a
 * merchant settlement). A structural test fails if a new caller does not.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getWalletLiquiditySnapshot, reserveWalletLiquidity, releaseWalletLiquidity } from './wallet-liquidity.ts';
import { runWithLiquidityGate, type GateOutcome } from './wallet-liquidity-gate-core.ts';

export { LIQUIDITY_DECLINED_MESSAGE } from './wallet-liquidity-gate-core.ts';
export type { GateOutcome } from './wallet-liquidity-gate-core.ts';

export function withWalletLiquidityGate<T>(
  svc: SupabaseClient, transferPence: number, settle: () => Promise<T>,
): Promise<GateOutcome<T>> {
  return runWithLiquidityGate<T>({
    snapshot: async () => {
      const s = await getWalletLiquiditySnapshot(svc);
      return { status: s.status, available_pence: s.available_pence, reserve_pence: s.reserve_pence, error: s.error };
    },
    reserve: async (amount, available, reserve) => {
      const r = await reserveWalletLiquidity(svc, amount, available, reserve);
      return r.ok ? { ok: true, reservationId: r.reservationId } : { ok: false, heldPence: r.heldPence };
    },
    release: (id) => releaseWalletLiquidity(svc, id),
    log: (level, msg) => (level === 'error' ? console.error(msg) : console.warn(msg)),
  }, transferPence, settle);
}

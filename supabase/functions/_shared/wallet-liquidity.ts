/**
 * wallet-liquidity.ts — the one canonical way to answer "can OneShetland
 * actually settle a Wallet transfer right now?"
 *
 * Why this exists: a real £5.00 Premium Wallet payment was correctly debited
 * and correctly fee'd, then Stripe refused the merchant transfer with
 * "Insufficient funds in Stripe account." The reversal safety net caught it —
 * nothing was lost — but the customer was debited before anyone asked the
 * question this file answers. getWalletLiquiditySnapshot() is that question,
 * asked once, from one place, so a dashboard and a preflight check never
 * disagree about what "available" means.
 *
 * getWalletLiquiditySnapshot() reads Stripe's balance LIVE every call — no
 * caching here. The audit that led to this file found that a flat
 * reconstruction of Stripe's balance can look sufficient while Stripe's own
 * real-time check still refuses a transfer, so a stale number is actively
 * dangerous in the one place (the preflight gate) that must never be wrong in
 * the optimistic direction. At OneShetland's current volume a live call on
 * every check is cheap; if that stops being true, cache at the CALLER (e.g.
 * the admin panel), never inside this function.
 *
 * reserveWalletLiquidity()/releaseWalletLiquidity() wrap the DB-backed
 * reservation ledger (see migration 20261025050000) that closes the real
 * concurrency hole: two simultaneous spends reading the same "available"
 * figure and both proceeding. The RESERVE call is one atomic, lock-serialised
 * database round trip — never two independent reads compared in application
 * code.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfigBulk } from './admin-config.ts';

const STRIPE_API_VERSION = '2023-10-16';

export type WalletLiquidityStatus = 'healthy' | 'low' | 'critical' | 'disabled' | 'unknown';

export interface WalletLiquiditySnapshot {
  enabled: boolean;
  available_pence: number;
  pending_pence: number;
  liability_pence: number;
  reserve_pence: number;
  headroom_pence: number;
  /** null when there is no live liability — coverage is undefined, not zero. */
  coverage_bps: number | null;
  low_coverage_bps: number;
  critical_coverage_bps: number;
  status: WalletLiquidityStatus;
  /** Set only when status is 'unknown' — Stripe's balance could not be read. */
  error?: string;
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

/**
 * Live, uncached. Never trusts a client-supplied figure for anything in this
 * computation — every number comes from Stripe or from our own database,
 * read fresh, right here.
 */
export async function getWalletLiquiditySnapshot(svc: SupabaseClient): Promise<WalletLiquiditySnapshot> {
  const cfg = await getConfigBulk(svc, [
    'wallet.liquidity.enabled',
    'wallet.liquidity.reserve_pence',
    'wallet.liquidity.low_coverage_bps',
    'wallet.liquidity.critical_coverage_bps',
  ]);
  const enabled = cfg.get('wallet.liquidity.enabled') === 'true';
  const reserve_pence = parseIntOr(cfg.get('wallet.liquidity.reserve_pence'), 10_000);
  const low_coverage_bps = parseIntOr(cfg.get('wallet.liquidity.low_coverage_bps'), 15_000);
  const critical_coverage_bps = parseIntOr(cfg.get('wallet.liquidity.critical_coverage_bps'), 10_000);

  const { data: liabilityRows, error: liabilityErr } = await svc
    .from('local_wallet_balances')
    .select('balance_pence')
    .gt('balance_pence', 0);
  if (liabilityErr) {
    console.error('[wallet-liquidity] could not read total Wallet liability:', liabilityErr);
  }
  const liability_pence = (liabilityRows ?? []).reduce((sum, r) => sum + (Number(r.balance_pence) || 0), 0);

  const base: Omit<WalletLiquiditySnapshot, 'available_pence' | 'pending_pence' | 'headroom_pence' | 'coverage_bps' | 'status' | 'error'> = {
    enabled, liability_pence, reserve_pence, low_coverage_bps, critical_coverage_bps,
  };

  if (!enabled) {
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, coverage_bps: null, status: 'disabled' };
  }

  let balanceRes: Response;
  try {
    balanceRes = await fetch('https://api.stripe.com/v1/balance', {
      headers: {
        'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    console.error('[wallet-liquidity] Stripe balance fetch threw:', msg);
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, coverage_bps: null, status: 'unknown', error: msg };
  }
  if (!balanceRes.ok) {
    const msg = `Stripe balance read failed (HTTP ${balanceRes.status})`;
    console.error('[wallet-liquidity]', msg);
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, coverage_bps: null, status: 'unknown', error: msg };
  }
  const balance = await balanceRes.json();
  const gbp = (bucket: unknown): number =>
    Array.isArray(bucket) ? (bucket.find((b: { currency?: string }) => b.currency === 'gbp')?.amount ?? 0) : 0;
  const available_pence = gbp(balance.available);
  const pending_pence = gbp(balance.pending);
  const headroom_pence = available_pence - reserve_pence;

  let coverage_bps: number | null = null;
  let status: WalletLiquidityStatus;
  if (liability_pence <= 0) {
    status = 'healthy';
  } else {
    coverage_bps = Math.floor((available_pence * 10_000) / liability_pence);
    status = coverage_bps < critical_coverage_bps ? 'critical'
      : coverage_bps < low_coverage_bps ? 'low'
      : 'healthy';
  }

  return { ...base, available_pence, pending_pence, headroom_pence, coverage_bps, status };
}

export interface LiquidityReservation {
  ok: boolean;
  reservationId: string | null;
  heldPence: number;
}

/**
 * Atomically checks AND claims headroom for one transfer, in a single
 * lock-serialised database round trip — see wallet_liquidity_reserve() in
 * migration 20261025050000. Never computed by comparing two independent
 * reads in application code; that is exactly the race this closes.
 */
export async function reserveWalletLiquidity(
  svc: SupabaseClient,
  amountPence: number,
  availablePence: number,
  reservePence: number,
): Promise<LiquidityReservation> {
  const { data, error } = await svc.rpc('wallet_liquidity_reserve', {
    p_amount_pence: amountPence,
    p_available_pence: availablePence,
    p_reserve_pence: reservePence,
  }).maybeSingle<{ ok: boolean; reservation_id: string | null; held_pence: number }>();
  if (error || !data) {
    console.error('[wallet-liquidity] reservation call failed — failing closed:', error);
    return { ok: false, reservationId: null, heldPence: 0 };
  }
  return { ok: data.ok, reservationId: data.reservation_id, heldPence: data.held_pence };
}

/** Always safe to call, including with a null id (no-ops) — callers release unconditionally in a finally. */
export async function releaseWalletLiquidity(svc: SupabaseClient, reservationId: string | null): Promise<void> {
  if (!reservationId) return;
  const { error } = await svc.rpc('wallet_liquidity_release', { p_reservation_id: reservationId });
  if (error) console.error('[wallet-liquidity] failed to release reservation', reservationId, error);
}

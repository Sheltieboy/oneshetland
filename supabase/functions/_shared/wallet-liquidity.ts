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
  /**
   * available − reserve. This is SPENDABLE HEADROOM — what is left to permit
   * a transfer AFTER the reserve is protected. It can be negative. Reaching
   * a headroom of exactly 0 means the reserve is intact but there is nothing
   * left over for even a 1p transfer — see gap_to_reserve_pence below for
   * the different, smaller question of "how far below the reserve are we".
   */
  headroom_pence: number;
  /**
   * max(0, reserve − available). How far available balance sits BELOW the
   * reserve floor — nothing more. Closing this gap only brings headroom up
   * to exactly 0, which still permits NO transfer at all. Never read this as
   * "what Wallet needs to become spendable" — that question needs a
   * specific transfer amount, which is reserve + that amount − available
   * (see the admin panel's worked examples). null when available itself is
   * unknown (status 'disabled' or 'unknown') — there is nothing to compare.
   */
  gap_to_reserve_pence: number | null;
  /** null when there is no live liability — coverage is undefined, not zero. */
  coverage_bps: number | null;
  low_coverage_bps: number;
  critical_coverage_bps: number;
  /**
   * Spendable headroom OneShetland aims to keep funded ABOVE the reserve —
   * a configured operating target, not merely "reach the reserve". Pure
   * config; always a real number, never null.
   */
  desired_headroom_pence: number;
  /**
   * max(0, reserve + desired_headroom − available) — the admin panel's
   * "recommended funding amount". Deliberately NOT "what closes the gap to
   * the reserve" (that leaves zero spendable headroom) — it targets reserve
   * + headroom together. null when available itself is unknown (status
   * 'disabled' or 'unknown'), same reasoning as gap_to_reserve_pence.
   */
  recommended_funding_pence: number | null;
  /**
   * wallet.liquidity.funding_enabled — whether the admin "Fund Wallet
   * reserve" action may call Stripe at all. Pure config; always a real
   * boolean. False means Admin shows Stripe Dashboard funding instructions
   * instead of a live action.
   */
  funding_enabled: boolean;
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
    'wallet.liquidity.desired_headroom_pence',
    'wallet.liquidity.funding_enabled',
  ]);
  const enabled = cfg.get('wallet.liquidity.enabled') === 'true';
  const reserve_pence = parseIntOr(cfg.get('wallet.liquidity.reserve_pence'), 10_000);
  const low_coverage_bps = parseIntOr(cfg.get('wallet.liquidity.low_coverage_bps'), 15_000);
  const critical_coverage_bps = parseIntOr(cfg.get('wallet.liquidity.critical_coverage_bps'), 10_000);
  const desired_headroom_pence = parseIntOr(cfg.get('wallet.liquidity.desired_headroom_pence'), 5_000);
  const funding_enabled = cfg.get('wallet.liquidity.funding_enabled') === 'true';

  const { data: liabilityRows, error: liabilityErr } = await svc
    .from('local_wallet_balances')
    .select('balance_pence')
    .gt('balance_pence', 0);
  if (liabilityErr) {
    console.error('[wallet-liquidity] could not read total Wallet liability:', liabilityErr);
  }
  const liability_pence = (liabilityRows ?? []).reduce((sum, r) => sum + (Number(r.balance_pence) || 0), 0);

  const base: Omit<WalletLiquiditySnapshot, 'available_pence' | 'pending_pence' | 'headroom_pence' | 'gap_to_reserve_pence' | 'recommended_funding_pence' | 'coverage_bps' | 'status' | 'error'> = {
    enabled, liability_pence, reserve_pence, low_coverage_bps, critical_coverage_bps,
    desired_headroom_pence, funding_enabled,
  };

  // available is unknown in both branches below — gap_to_reserve_pence and
  // recommended_funding_pence stay null rather than computed against a
  // placeholder 0, same reasoning as coverage_bps staying null.
  if (!enabled) {
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, gap_to_reserve_pence: null, recommended_funding_pence: null, coverage_bps: null, status: 'disabled' };
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
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, gap_to_reserve_pence: null, recommended_funding_pence: null, coverage_bps: null, status: 'unknown', error: msg };
  }
  if (!balanceRes.ok) {
    const msg = `Stripe balance read failed (HTTP ${balanceRes.status})`;
    console.error('[wallet-liquidity]', msg);
    return { ...base, available_pence: 0, pending_pence: 0, headroom_pence: 0, gap_to_reserve_pence: null, recommended_funding_pence: null, coverage_bps: null, status: 'unknown', error: msg };
  }
  const balance = await balanceRes.json();
  const gbp = (bucket: unknown): number =>
    Array.isArray(bucket) ? (bucket.find((b: { currency?: string }) => b.currency === 'gbp')?.amount ?? 0) : 0;
  const available_pence = gbp(balance.available);
  const pending_pence = gbp(balance.pending);
  const headroom_pence = available_pence - reserve_pence;
  // Reaching this at exactly 0 means the reserve is intact — it does NOT
  // mean any transfer is permitted. That still needs headroom_pence above
  // (which stays negative until available exceeds reserve by the transfer
  // amount itself).
  const gap_to_reserve_pence = Math.max(0, reserve_pence - available_pence);
  // The admin panel's "recommended funding" — targets reserve + desired
  // headroom TOGETHER, not merely the reserve. Example: reserve £100,
  // desired headroom £50, available £5.55 → recommended £144.45, not £94.45.
  const recommended_funding_pence = Math.max(0, reserve_pence + desired_headroom_pence - available_pence);

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

  return { ...base, available_pence, pending_pence, headroom_pence, gap_to_reserve_pence, recommended_funding_pence, coverage_bps, status };
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

export interface WalletLiquidityTopup {
  id: string;
  stripe_topup_id: string | null;
  amount_pence: number;
  status: string;
  reserve_target_pence: number;
  desired_headroom_pence: number;
  failure_message: string | null;
  expected_availability_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The admin panel's "pending funding" list. A row still 'creating' or
 * 'pending' is refreshed live from Stripe (GET only — never a mutating
 * call) before being returned, so a Topup that has since settled is shown
 * as settled rather than stale. Pending amounts are NEVER folded into
 * available_pence/headroom_pence above — that figure comes only from
 * Stripe's own /v1/balance, which already excludes anything not genuinely
 * available.
 */
export async function getRecentWalletTopups(svc: SupabaseClient, limit = 10): Promise<WalletLiquidityTopup[]> {
  const { data, error } = await svc
    .from('wallet_liquidity_topups')
    .select('id, stripe_topup_id, amount_pence, status, reserve_target_pence, desired_headroom_pence, failure_message, expected_availability_date, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[wallet-liquidity] could not read recent topups:', error);
    return [];
  }
  const rows = (data ?? []) as WalletLiquidityTopup[];

  const refreshed = await Promise.all(rows.map(async (row) => {
    if (row.status !== 'creating' && row.status !== 'pending') return row;
    if (!row.stripe_topup_id) return row;
    try {
      const res = await fetch(`https://api.stripe.com/v1/topups/${row.stripe_topup_id}`, {
        headers: {
          'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
          'Stripe-Version': STRIPE_API_VERSION,
        },
      });
      if (!res.ok) return row;
      const topup = await res.json();
      if (topup.status === row.status) return row;
      const update = {
        status: topup.status as string,
        failure_message: topup.failure_message ?? null,
        expected_availability_date: topup.expected_availability_date
          ? new Date(topup.expected_availability_date * 1000).toISOString().slice(0, 10)
          : null,
        updated_at: new Date().toISOString(),
      };
      await svc.from('wallet_liquidity_topups').update(update).eq('id', row.id);
      return { ...row, ...update };
    } catch (e) {
      console.error('[wallet-liquidity] could not refresh topup status for', row.stripe_topup_id, e);
      return row;
    }
  }));
  return refreshed;
}

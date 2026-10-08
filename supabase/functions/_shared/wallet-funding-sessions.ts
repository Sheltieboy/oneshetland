/**
 * wallet-funding-sessions.ts — tracking of push bank transfers that fund the
 * Wallet liquidity reserve.
 *
 * reconcileFundingSessions() is called by the scheduled liquidity monitor and
 * by the admin snapshot. It performs Stripe GET requests only (never a POST),
 * and only when a session is open. It reads and writes
 * wallet_liquidity_funding_sessions and wallet_liquidity_topups (read) — never
 * a customer Wallet balance, ledger, or the preflight reservation tables.
 * It never throws: a failure to look leaves sessions untouched.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfigBulk } from './admin-config.ts';
import {
  OPEN_SESSION_STATUSES, CLOCK_SLACK_SECONDS, candidateFromTopup, candidateFromBalanceTransaction,
  pickFundingMatch, nextSessionState,
  type FundingCandidate, type FundingSessionStatus,
} from './wallet-funding-match.ts';

const STRIPE_API_VERSION = '2023-10-16';

export interface WalletFundingSession {
  id: string;
  requested_amount_pence: number;
  target_available_pence: number;
  baseline_available_pence: number;
  baseline_pending_pence: number;
  reserve_target_pence: number;
  desired_headroom_pence: number;
  status: FundingSessionStatus;
  matched_ref: string | null;
  received_amount_pence: number | null;
  received_at: string | null;
  available_at: string | null;
  expected_available_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS =
  'id, requested_amount_pence, target_available_pence, baseline_available_pence, baseline_pending_pence, ' +
  'reserve_target_pence, desired_headroom_pence, status, matched_ref, received_amount_pence, received_at, ' +
  'available_at, expected_available_at, resolution_note, created_at, updated_at';

async function stripeGet(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getRecentFundingSessions(svc: SupabaseClient, limit = 5): Promise<WalletFundingSession[]> {
  const { data, error } = await svc.from('wallet_liquidity_funding_sessions')
    .select(SESSION_COLUMNS).order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('[wallet-funding-sessions] list failed:', error.message); return []; }
  return (data ?? []) as unknown as WalletFundingSession[];
}

export interface ReconcileResult {
  open: number;
  changed: { id: string; status: FundingSessionStatus }[];
}

export async function reconcileFundingSessions(svc: SupabaseClient): Promise<ReconcileResult> {
  const result: ReconcileResult = { open: 0, changed: [] };
  try {
    const { data: openRows } = await svc.from('wallet_liquidity_funding_sessions')
      .select(SESSION_COLUMNS).in('status', OPEN_SESSION_STATUSES);
    const open = (openRows ?? []) as unknown as WalletFundingSession[];
    result.open = open.length;
    if (open.length === 0) return result;

    const since = Math.min(...open.map((s) => Math.floor(new Date(s.created_at).getTime() / 1000))) - CLOCK_SLACK_SECONDS;
    const [topups, bts, adjustments] = await Promise.all([
      stripeGet(`/topups?limit=100&created[gte]=${since}`),
      stripeGet(`/balance_transactions?limit=100&type=topup&created[gte]=${since}`),
      stripeGet(`/balance_transactions?limit=100&type=adjustment&created[gte]=${since}`),
    ]);
    // If Stripe could not be read at all, change nothing (and do not expire).
    if (!topups && !bts && !adjustments) return result;

    // A succeeded Topup is only "received"; whether it is AVAILABLE is told by
    // its balance transaction. Take it from the list we already have, or GET it.
    const btById = new Map<string, Record<string, unknown>>();
    for (const bt of ((bts?.data ?? []) as Record<string, unknown>[])) {
      if (typeof bt.id === 'string') btById.set(bt.id, bt);
    }

    const candidates: FundingCandidate[] = [];
    const topupRefs = new Set<string>();
    for (const t of ((topups?.data ?? []) as Record<string, unknown>[])) {
      let bt: Record<string, unknown> | null = null;
      if (t.status === 'succeeded' && typeof t.balance_transaction === 'string') {
        bt = btById.get(t.balance_transaction) ?? await stripeGet(`/balance_transactions/${t.balance_transaction}`);
      }
      const c = candidateFromTopup(t, bt);
      if (c) { candidates.push(c); topupRefs.add(c.ref); }
    }
    for (const bt of [...((bts?.data ?? []) as Record<string, unknown>[]), ...((adjustments?.data ?? []) as Record<string, unknown>[])]) {
      // A balance transaction that merely mirrors a Topup we already have is not a second credit.
      if (typeof bt.source === 'string' && topupRefs.has(bt.source)) continue;
      const c = candidateFromBalanceTransaction(bt);
      if (c) candidates.push(c);
    }

    // Refs that already belong to other sessions, or to a programmatic Topup of ours.
    const [{ data: claimedRows }, { data: ownTopups }] = await Promise.all([
      svc.from('wallet_liquidity_funding_sessions').select('id, matched_ref').not('matched_ref', 'is', null),
      svc.from('wallet_liquidity_topups').select('stripe_topup_id').not('stripe_topup_id', 'is', null),
    ]);
    const ownTopupIds = new Set(((ownTopups ?? []) as { stripe_topup_id: string }[]).map((r) => r.stripe_topup_id));

    const cfg = await getConfigBulk(svc, ['wallet.liquidity.funding_session_expiry_hours']);
    const expiryRaw = Number(cfg.get('wallet.liquidity.funding_session_expiry_hours'));
    const expiryHours = Number.isFinite(expiryRaw) && expiryRaw > 0 ? expiryRaw : 168;
    const now = new Date();

    for (const s of open) {
      const claimed = new Set<string>(ownTopupIds);
      for (const r of ((claimedRows ?? []) as { id: string; matched_ref: string }[])) {
        if (r.id !== s.id) claimed.add(r.matched_ref);
      }
      const match = pickFundingMatch(s, candidates, claimed);
      const next = nextSessionState(s, match, now, expiryHours);
      const expectedIso = match?.available_on_unix ? new Date(match.available_on_unix * 1000).toISOString() : null;
      const expectedChanged = !!expectedIso && new Date(s.expected_available_at ?? 0).getTime() !== new Date(expectedIso).getTime();
      if (!next && !(match && s.matched_ref !== match.ref) && !expectedChanged) continue;

      const status = next?.status ?? s.status;
      const update: Record<string, unknown> = { status, updated_at: now.toISOString() };
      if (next?.note !== undefined) update.resolution_note = next.note;
      if (match) {
        update.matched_ref = match.ref;
        update.matched_kind = match.kind;
        update.received_amount_pence = match.amount_pence;
        if (!s.received_at) update.received_at = new Date(match.created_unix * 1000).toISOString();
        if (expectedIso) update.expected_available_at = expectedIso;
        if (status === 'available') update.available_at = now.toISOString();
      }
      const { error } = await svc.from('wallet_liquidity_funding_sessions')
        .update(update).eq('id', s.id).in('status', OPEN_SESSION_STATUSES);
      if (error) { console.error('[wallet-funding-sessions] update failed:', error.code); continue; }
      if (next) result.changed.push({ id: s.id, status });
    }
  } catch (e) {
    console.error('[wallet-funding-sessions] reconcile failed:', e instanceof Error ? e.message : 'error');
  }
  return result;
}

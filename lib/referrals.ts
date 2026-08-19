/**
 * referrals.ts — "refer a friend, you both get a reward".
 *
 * The code + reward crediting live server-side (ensure_referral_code /
 * apply_referral_code RPCs + a DB trigger on first spend); this is just the
 * client surface. Reward is wallet credit (£5 each) when the friend first spends.
 */

import { supabase } from './supabase';

export const REFERRAL_REWARD_PENCE = 500;

export interface ReferralEntry {
  id: string;
  status: 'pending' | 'rewarded' | 'void';
  reward_pence: number;
  name: string;
  created_at: string;
}

export interface MyReferrals {
  code: string;
  entries: ReferralEntry[];
  joined: number;         // total friends who used the code
  earned_pence: number;   // total credited so far
}

/** The caller's referral code, generated on first request. Identity comes from
 *  the session (auth.uid()), not from an argument. */
export async function getMyReferralCode(): Promise<string> {
  const { data, error } = await supabase.rpc('ensure_referral_code');
  if (error) throw error;
  return data as string;
}

export async function fetchMyReferrals(userId: string): Promise<MyReferrals> {
  const code = await getMyReferralCode();
  const { data, error } = await supabase
    .from('referrals')
    .select('id, status, referrer_reward_pence, created_at, referee:profiles!referrals_referee_id_fkey(display_name, full_name)')
    .eq('referrer_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // PostgREST types an embedded to-one as an array; at runtime it's a single row.
  const entries: ReferralEntry[] = (data ?? []).map((r: Record<string, unknown>) => {
    const rawRef = r.referee as { display_name?: string | null; full_name?: string | null } | Array<{ display_name?: string | null; full_name?: string | null }> | null;
    const ref = Array.isArray(rawRef) ? rawRef[0] : rawRef;
    return {
      id: r.id as string,
      status: r.status as ReferralEntry['status'],
      reward_pence: r.referrer_reward_pence as number,
      name: ref?.display_name || ref?.full_name || 'A friend',
      created_at: r.created_at as string,
    };
  });
  return {
    code,
    entries,
    joined: entries.length,
    earned_pence: entries.filter((e) => e.status === 'rewarded').reduce((s, e) => s + e.reward_pence, 0),
  };
}

/** Apply a friend's code. Returns { ok, error? } — a friendly message on failure. */
export async function applyReferralCode(code: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('apply_referral_code', { p_code: code.trim() });
  if (error) throw error;
  return data as { ok: boolean; error?: string };
}

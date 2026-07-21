/**
 * member-card.ts — the "one card for all of Shetland" client surface.
 *
 * Customer: getMyMemberCode() → the single permanent code their QR encodes.
 * Business till: tillLookup()/tillAction() drive the loyalty-till edge function
 * (scan the customer's code, then add a stamp / points / redeem).
 */

import { supabase } from './supabase';

export type TillAction = 'lookup' | 'stamp' | 'points' | 'redeem_reward' | 'redeem_offer';

export interface TillOffer { id: string; title: string; badge: string; claimed: boolean; }
export interface TillLookup {
  ok: boolean;
  customer: { name: string };
  business: { id: string; name: string };
  program: {
    type: 'stamps' | 'points';
    stamps_required: number | null;
    stamp_reward: string | null;
    reward_tiers: { stamps: number; reward: string }[];
    points_per_pound: number | null;
    points_for_pound: number | null;
  } | null;
  card: { stamps_collected: number; points_balance: number; tiers_redeemed_upto: number } | null;
  ready_reward: { stamps: number; reward: string } | null;
  offers: TillOffer[];
}

/** The signed-in member's permanent code (generated on first call). */
export async function getMyMemberCode(userId: string): Promise<string> {
  const { data, error } = await supabase.rpc('ensure_member_code', { p_user: userId });
  if (error) throw error;
  return data as string;
}

async function callTill(body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke('loyalty-till', { body });
  if (error) {
    // Surface the function's JSON error message where possible.
    let msg = error.message;
    try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* */ }
    throw new Error(msg);
  }
  return data;
}

export function tillLookup(memberCode: string, businessId?: string): Promise<TillLookup> {
  return callTill({ member_code: memberCode, business_id: businessId, action: 'lookup' });
}

export function tillAction(
  action: Exclude<TillAction, 'lookup'>,
  memberCode: string,
  opts: { businessId?: string; amountPence?: number; offerId?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  return callTill({ member_code: memberCode, business_id: opts.businessId, action, amount_pence: opts.amountPence, offer_id: opts.offerId });
}

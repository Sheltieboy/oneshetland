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

/**
 * The signed-in member's permanent code (generated on first call).
 *
 * No user id: the RPC reads auth.uid() from the session, so there is no
 * parameter that could ask for somebody else's code.
 */
export async function getMyMemberCode(): Promise<string> {
  const { data, error } = await supabase.rpc('ensure_member_code');
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

/* ── Charge by scan ────────────────────────────────────────────────────────────
   Business scans the member card and REQUESTS a payment; the customer approves
   on their own phone before any money moves. Mirrors the web member-card client. */

export interface ChargeRequest { request_id: string; customer_name: string; amount_pence: number; expires_at: string; }
export type ChargeStatus = 'pending' | 'charging' | 'paid' | 'declined' | 'expired' | 'failed';

async function invokeErr(error: unknown): Promise<Error> {
  let msg = (error as { message?: string }).message ?? 'Something went wrong';
  try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* */ }
  return new Error(msg);
}

/** Business side: raise a pending charge request from a scanned member code. */
export async function createChargeRequest(memberCode: string, amountPence: number, businessId?: string): Promise<ChargeRequest> {
  const { data, error } = await supabase.functions.invoke('wallet-charge-request', {
    body: { member_code: memberCode, amount_pence: amountPence, business_id: businessId },
  });
  if (error) throw await invokeErr(error);
  return data as ChargeRequest;
}

/** Business side: poll a request's status while waiting for the customer. */
export async function getChargeStatus(requestId: string): Promise<ChargeStatus | null> {
  const { data } = await supabase.from('wallet_charge_requests').select('status').eq('id', requestId).maybeSingle();
  return (data as { status: ChargeStatus } | null)?.status ?? null;
}

/** Customer side: approve or decline a charge request aimed at them. */
export async function respondToCharge(
  requestId: string,
  decision: 'approve' | 'decline',
): Promise<{ ok?: boolean; declined?: boolean; balance_pence?: number; cashback_pence?: number }> {
  const { data, error } = await supabase.functions.invoke('wallet-charge-approve', {
    body: { request_id: requestId, decision },
  });
  if (error) throw await invokeErr(error);
  return data as { ok?: boolean; declined?: boolean; balance_pence?: number; cashback_pence?: number };
}

/** Customer side: any pending, not-yet-expired request aimed at me (catch-on-load). */
export async function fetchPendingCharge(userId: string): Promise<{ id: string; business_id: string; amount_pence: number; expires_at: string } | null> {
  const { data } = await supabase
    .from('wallet_charge_requests')
    .select('id, business_id, amount_pence, expires_at')
    .eq('customer_id', userId).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string; business_id: string; amount_pence: number; expires_at: string } | null) ?? null;
}

/** Look up a business display name (for the approval sheet). */
export async function businessName(businessId: string): Promise<string> {
  const { data } = await supabase.from('local_businesses').select('name').eq('id', businessId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? 'A business';
}

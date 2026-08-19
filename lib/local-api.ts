/**
 * local-api.ts
 * All Supabase calls and helpers for the OneShetland Local feature.
 * Covers: businesses, follows, loyalty, offers, wallet, codes.
 */

import { supabase } from './supabase';

/**
 * Decode the real error from a supabase.functions.invoke failure.
 * invoke() returns a generic "Edge Function returned a non-2xx status code";
 * the real reason is in error.context.json() → { error: "..." }.
 */
async function fnErr(error: any, fallback: string): Promise<Error> {
  let msg = error?.message ?? fallback;
  try {
    const c = error?.context;
    if (c?.json) { const b = await c.json(); if (b?.error) msg = b.error; }
  } catch { /* keep generic */ }
  return new Error(msg);
}

// ---------------------------------------------------------------------------
// Shetland areas
// ---------------------------------------------------------------------------
export const SHETLAND_AREAS = [
  { key: 'lerwick',        label: 'Lerwick' },
  { key: 'scalloway',      label: 'Scalloway' },
  { key: 'brae',           label: 'Brae' },
  { key: 'northmavine',    label: 'Northmavine' },
  { key: 'south mainland', label: 'South Mainland' },
  { key: 'west mainland',  label: 'West Mainland' },
  { key: 'yell',           label: 'Yell' },
  { key: 'unst',           label: 'Unst' },
  { key: 'fetlar',         label: 'Fetlar' },
  { key: 'whalsay',        label: 'Whalsay' },
  { key: 'skerries',       label: 'Skerries' },
] as const;

export type ShetlandAreaKey = typeof SHETLAND_AREAS[number]['key'];

// ── Types ─────────────────────────────────────────────────────────────────────

export type LocalCategory =
  | 'food_drink' | 'retail' | 'services' | 'tourism' | 'accommodation' | 'other';

export type SubscriptionTier = 'free' | 'pro' | 'premium';

/** Tier labels and prices live in lib/listing-tiers.ts — the file mirrored with
 *  the web repo, so both products quote the same numbers. Re-exported here so
 *  the business screens keep importing from one place. */
export { TIER_LABEL as TIER_LABELS, TIER_PRICE, TIER_PITCH, PREMIUM_ANNUAL_PRICE } from '@/lib/listing-tiers';

export type LoyaltyType = 'stamps' | 'points';
export type DiscountType = 'percent' | 'fixed' | 'freebie' | 'bogo' | 'other';
export type WalletTxType = 'topup' | 'spend' | 'refund' | 'cashback';
export type LoyaltyTxType = 'stamp' | 'points_earn' | 'redeem' | 'reward';

export async function fetchBusinessBySlug(slug: string): Promise<LocalBusiness | null> {
  const { data, error } = await supabase
    .from('local_businesses')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as LocalBusiness | null;
}

export interface OpeningHours {
  mon?: string; tue?: string; wed?: string; thu?: string;
  fri?: string; sat?: string; sun?: string;
}

export interface LocalBusiness {
  id:                string;
  owner_id:          string;
  name:              string;
  category:          LocalCategory;
  description:       string | null;
  address:           string;
  lat:               number | null;
  lng:               number | null;
  logo_url:          string | null;
  cover_url:         string | null;
  brand_color:       string | null;
  tags:              string[] | null;
  phone:             string | null;
  website:           string | null;
  email:             string | null;
  opening_hours:     OpeningHours | null;
  /** Last date opening_hours is known good (seasonal). NULL = no known end. */
  opening_hours_until: string | null;
  is_verified:       boolean;
  is_active:         boolean;
  accepts_wallet:    boolean;
  cashback_percent:  number;
  stripe_account_id: string | null;
  payout_enabled:    boolean;
  subscription_tier:      SubscriptionTier;
  subscription_until:     string | null;
  stripe_customer_id:     string | null;
  stripe_subscription_id: string | null;
  nfc_token:              string | null;
  nfc_status:             'none' | 'requested' | 'dispatched' | 'active';
  nfc_dispatched_at:      string | null;
  nfc_activated_at:       string | null;
  accepts_bookings:       boolean;
  slug:                   string | null;
  subscription_cancel_at_period_end?: boolean;
  // Directory seeding + claim flow (migration 062)
  source:            'owner' | 'csv' | 'google' | 'wordpress';
  place_id:          string | null;
  is_claimed:        boolean;
  claimed_at:        string | null;
  verified_at:       string | null;
  created_at:        string;
  // computed
  is_followed?:      boolean;
  active_offers?:    number;
  has_loyalty?:      boolean;
}

/** One rung of a reward ladder: reach `stamps` to unlock `reward`. */
export interface RewardTier { stamps: number; reward: string; }

export interface LoyaltyProgram {
  id:                string;
  business_id:       string;
  type:              LoyaltyType;
  stamps_required:   number | null;
  stamp_reward:      string | null;
  /** Multi-tier ladder (ascending). null/empty = single-reward mode above. */
  reward_tiers:      RewardTier[] | null;
  points_per_pound:  number | null;
  points_for_pound:  number | null;
  is_active:         boolean;
  created_at:        string;
}

export interface LoyaltyCard {
  id:                string;
  user_id:           string;
  program_id:        string;
  business_id:       string;
  stamps_collected:  number;
  points_balance:    number;
  total_redeemed:    number;
  /** Stamp threshold of the highest ladder tier claimed this cycle (0 = none). */
  tiers_redeemed_upto: number;
  last_stamp_at:     string | null;
  created_at:        string;
  // joined
  business?:         Pick<LocalBusiness, 'name' | 'logo_url' | 'category'> | null;
  program?:          LoyaltyProgram | null;
}

export interface LocalOffer {
  id:                string;
  business_id:       string;
  title:             string;
  description:       string | null;
  image_url:         string | null;
  discount_type:     DiscountType | null;
  discount_value:    number | null;
  valid_from:        string;
  valid_until:       string;
  terms:             string | null;
  max_redemptions:   number | null;
  is_active:         boolean;
  redemption_count:  number;
  created_at:        string;
  // joined — includes bookability fields so callers can route to the booking screen
  business?:         Pick<LocalBusiness, 'id' | 'name' | 'logo_url' | 'category' | 'accepts_bookings' | 'subscription_tier' | 'is_active'> | null;
  is_redeemed?:      boolean;
}

export interface WalletTransaction {
  id:                          string;
  user_id:                     string;
  business_id:                 string | null;
  type:                        WalletTxType;
  amount_pence:                number;
  stripe_payment_intent_id:    string | null;
  stripe_transfer_id:          string | null;
  description:                 string | null;
  created_at:                  string;
  // joined
  business?:                   Pick<LocalBusiness, 'name'> | null;
}

export interface BusinessCode {
  business_id:  string;
  current_code: string;
  expires_at:   string;
  updated_at:   string;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<LocalCategory, string> = {
  food_drink:    'Food & Drink',
  retail:        'Retail',
  services:      'Services',
  tourism:       'Tourism',
  accommodation: 'Accommodation',
  other:         'Other',
};

export const CATEGORY_ICONS: Record<LocalCategory, string> = {
  food_drink:    'utensils',
  retail:        'shopping-bag',
  services:      'tools',
  tourism:       'umbrella-beach',
  accommodation: 'bed',
  other:         'store',
};

/**
 * Curated trade/service tags offered to business owners in the register form.
 * Owners may also add their own free-text tags. Directory search matches
 * against whatever ends up in local_businesses.tags.
 */
export const TRADE_TAGS: string[] = [
  // Trades
  'Plumbing', 'Joinery', 'Building', 'Electrical', 'Roofing', 'Painting & Decorating',
  'Plastering', 'Flooring', 'Landscaping', 'Fencing', 'Groundworks',
  // Home & vehicle
  'Cleaning', 'Window Cleaning', 'Garden Services', 'Removals', 'Car Repair & MOT',
  'Tyres', 'Boat Repair', 'Welding', 'Heating & Plumbing',
  // People services
  'Hair & Beauty', 'Barber', 'Massage & Therapy', 'Fitness & Wellbeing',
  'Childcare', 'Tutoring', 'Photography', 'Catering', 'Events & Entertainment',
  // Professional
  'Accountancy', 'Legal', 'IT & Web', 'Marketing & Design', 'Bookkeeping',
  // Land & sea
  'Crofting & Farming', 'Fishing Supplies', 'Agricultural Supplies', 'Vet & Animal Care',
  // Retail & food
  'Bakery', 'Butcher', 'Café', 'Bar & Pub', 'Restaurant', 'Takeaway',
  'Gifts & Crafts', 'Clothing', 'Hardware', 'Groceries',
];

/** Format pence as "£1,234.56" (thousands grouped). */
export function formatPence(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const [intPart, decPart] = (Math.abs(pence) / 100).toFixed(2).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}£${grouped}.${decPart}`;
}

/** Human-readable discount label */
export function formatOfferDiscount(o: Pick<LocalOffer, 'discount_type' | 'discount_value'>): string {
  if (!o.discount_type) return 'Offer';
  switch (o.discount_type) {
    case 'percent':  return `${o.discount_value ?? 0}% off`;
    case 'fixed':    return `£${(o.discount_value ?? 0).toFixed(2)} off`;
    case 'freebie':  return 'Freebie';
    case 'bogo':     return '2 for 1';
    case 'other':    return 'Special offer';
  }
}

/** "Valid until Tue 26 May" */
export function formatValidUntil(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/** Days remaining for an offer — used in cards */
export function daysRemaining(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/** Haversine distance in km */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Businesses ────────────────────────────────────────────────────────────────

/** All active businesses, optionally filtered by category */
export async function fetchActiveBusinesses(category?: LocalCategory): Promise<LocalBusiness[]> {
  let q = supabase
    .from('local_businesses')
    .select('*')
    .eq('is_active', true)
    .order('is_verified', { ascending: false })
    .order('created_at', { ascending: false });
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as LocalBusiness[];
}

/** Single business by id */
export async function fetchBusiness(id: string): Promise<LocalBusiness | null> {
  const { data, error } = await supabase
    .from('local_businesses')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as LocalBusiness | null;
}

/** All businesses owned by a user */
export async function fetchMyBusinesses(userId: string): Promise<LocalBusiness[]> {
  const { data, error } = await supabase
    .from('local_businesses')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as LocalBusiness[];
}

export interface BusinessUpsertInput {
  name: string;
  category: LocalCategory;
  description?: string | null;
  address: string;
  lat?: number | null;
  lng?: number | null;
  logo_url?: string | null;
  cover_url?: string | null;
  brand_color?: string | null;
  tags?: string[] | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  opening_hours?: OpeningHours | null;
  // Day-planner context. `planner_context_source: 'owner'` is a claim, not a
  // label: the backfill scripts refuse to overwrite a row carrying it, so it
  // must only be written when the owner has actually answered.
  planner_visitor_ready?: boolean | null;
  planner_dwell_minutes?: number | null;
  planner_setting?: 'indoor' | 'outdoor' | 'both' | null;
  planner_good_for?: string[] | null;
  planner_booking?: 'none' | 'advised' | 'required' | null;
  planner_note?: string | null;
  planner_context_source?: 'owner';
  // Payment / payout override toggles
  use_business_payment?: boolean;
  use_business_payout?:  boolean;
}

export async function createBusiness(userId: string, input: BusinessUpsertInput): Promise<LocalBusiness> {
  const { data, error } = await supabase
    .from('local_businesses')
    .insert({ owner_id: userId, ...input })
    .select('*')
    .single();
  if (error) throw error;
  return data as LocalBusiness;
}

export async function updateBusiness(id: string, patch: Partial<BusinessUpsertInput & { accepts_wallet: boolean; cashback_percent: number; is_active: boolean; }>): Promise<void> {
  const { error } = await supabase
    .from('local_businesses')
    .update(patch)
    .eq('id', id);
  if (error) throw error;
}

// ── Follows ───────────────────────────────────────────────────────────────────

export async function followBusiness(userId: string, businessId: string): Promise<void> {
  const { error } = await supabase
    .from('local_business_follows')
    .upsert({ user_id: userId, business_id: businessId }, { onConflict: 'user_id,business_id' });
  if (error) throw error;
}

export async function unfollowBusiness(userId: string, businessId: string): Promise<void> {
  const { error } = await supabase
    .from('local_business_follows')
    .delete()
    .eq('user_id', userId)
    .eq('business_id', businessId);
  if (error) throw error;
}

export async function isFollowing(userId: string, businessId: string): Promise<boolean> {
  const { data } = await supabase
    .from('local_business_follows')
    .select('business_id')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .maybeSingle();
  return !!data;
}

export async function fetchFollowedBusinessIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('local_business_follows')
    .select('business_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map(r => r.business_id);
}

// ── Loyalty ───────────────────────────────────────────────────────────────────

export async function fetchLoyaltyProgram(businessId: string): Promise<LoyaltyProgram | null> {
  const { data } = await supabase
    .from('local_loyalty_programs')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .maybeSingle();
  return (data ?? null) as LoyaltyProgram | null;
}

export interface LoyaltyProgramInput {
  type: LoyaltyType;
  stamps_required?: number | null;
  stamp_reward?: string | null;
  reward_tiers?: RewardTier[] | null;
  points_per_pound?: number | null;
  points_for_pound?: number | null;
}

/** Clean a raw tiers value (from DB or a form) into an ascending, valid list. */
export function normalizeTiers(raw: unknown): RewardTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ({ stamps: Number((t as RewardTier)?.stamps), reward: String((t as RewardTier)?.reward ?? '').trim() }))
    .filter((t) => Number.isFinite(t.stamps) && t.stamps > 0)
    .sort((a, b) => a.stamps - b.stamps);
}

export interface LadderState {
  tiers: RewardTier[];
  top: number;
  ready: RewardTier | null;   // reached but unclaimed — redeem this now
  next: RewardTier | null;    // the next rung still to reach
}

/** Compute ladder progress for a card. Returns null for single-reward programmes. */
export function ladderState(
  program: Pick<LoyaltyProgram, 'reward_tiers'> | null | undefined,
  stampsCollected: number,
  redeemedUpto: number,
): LadderState | null {
  const tiers = normalizeTiers(program?.reward_tiers);
  if (tiers.length === 0) return null;
  const top = tiers[tiers.length - 1].stamps;
  const ready = tiers.find((t) => t.stamps <= stampsCollected && t.stamps > redeemedUpto) ?? null;
  const next = tiers.find((t) => t.stamps > stampsCollected) ?? null;
  return { tiers, top, ready, next };
}

export async function upsertLoyaltyProgram(businessId: string, input: LoyaltyProgramInput): Promise<LoyaltyProgram> {
  const { data, error } = await supabase
    .from('local_loyalty_programs')
    .upsert({ business_id: businessId, ...input, is_active: true }, { onConflict: 'business_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as LoyaltyProgram;
}

/** Cards the user holds, with business + program joined client-side */
export async function fetchMyLoyaltyCards(userId: string): Promise<LoyaltyCard[]> {
  const { data: cards, error } = await supabase
    .from('local_loyalty_cards')
    .select('*')
    .eq('user_id', userId)
    .order('last_stamp_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  if (!cards || cards.length === 0) return [];

  const businessIds = [...new Set(cards.map(c => c.business_id))];
  const programIds  = [...new Set(cards.map(c => c.program_id))];

  const [{ data: biz }, { data: progs }] = await Promise.all([
    supabase.from('local_businesses').select('id, name, logo_url, category').in('id', businessIds),
    supabase.from('local_loyalty_programs').select('*').in('id', programIds),
  ]);

  const bizMap  = Object.fromEntries((biz   ?? []).map(b => [b.id, b]));
  const progMap = Object.fromEntries((progs ?? []).map(p => [p.id, p]));

  return cards.map(c => ({
    ...c,
    business: bizMap[c.business_id]  ?? null,
    program:  progMap[c.program_id]  ?? null,
  })) as LoyaltyCard[];
}

export async function fetchMyLoyaltyCard(userId: string, businessId: string): Promise<LoyaltyCard | null> {
  const { data } = await supabase
    .from('local_loyalty_cards')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .maybeSingle();
  return (data ?? null) as LoyaltyCard | null;
}

/** Collect a stamp via the edge function — server validates the code */
export async function collectStamp(code: string): Promise<{ ok: boolean; reward_ready?: boolean; stamps?: number; needed?: number }> {
  const { data, error } = await supabase.functions.invoke('local-stamp-collect', {
    body: { code },
  });
  if (error) throw await fnErr(error, 'Could not collect stamp.');
  return data;
}

/** Redeem a stamp reward (when threshold is hit) */
export async function redeemReward(cardId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('local-redeem-reward', {
    body: { card_id: cardId },
  });
  if (error) throw await fnErr(error, 'Could not redeem reward.');
}

// ── Offers ────────────────────────────────────────────────────────────────────

/** Active offers across all businesses */
export async function fetchActiveOffers(): Promise<LocalOffer[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('local_offers')
    .select('*')
    .eq('is_active', true)
    .lte('valid_from', now)
    .gte('valid_until', now)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const offers = (data ?? []) as LocalOffer[];

  const businessIds = [...new Set(offers.map(o => o.business_id))];
  if (businessIds.length === 0) return offers;
  const { data: biz } = await supabase
    .from('local_businesses')
    .select('id, name, logo_url, category, accepts_bookings, subscription_tier, is_active')
    .in('id', businessIds);
  const bizMap = Object.fromEntries((biz ?? []).map(b => [b.id, b]));
  return offers.map(o => ({ ...o, business: bizMap[o.business_id] ?? null }));
}

/** Shop Local Shetland — every business running an active stamp/points
 *  programme, for the island-wide loyalty hub (mirrors the web /loyalty page). */
export interface LoyaltyHubBusiness {
  business: Pick<LocalBusiness, 'id' | 'name' | 'logo_url' | 'category' | 'brand_color' | 'address' | 'slug'>;
  program: Pick<LoyaltyProgram, 'type' | 'stamps_required' | 'stamp_reward' | 'points_per_pound' | 'points_for_pound'>;
}

export async function fetchLoyaltyBusinesses(limit = 120): Promise<LoyaltyHubBusiness[]> {
  const { data: progs, error } = await supabase
    .from('local_loyalty_programs')
    .select('business_id, type, stamps_required, stamp_reward, points_per_pound, points_for_pound')
    .eq('is_active', true)
    .limit(limit);
  if (error) throw error;
  const rows = (progs ?? []) as (LoyaltyHubBusiness['program'] & { business_id: string })[];
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map(p => p.business_id))];
  const { data: biz } = await supabase
    .from('local_businesses')
    .select('id, name, logo_url, category, brand_color, address, slug')
    .eq('is_active', true)
    .in('id', ids);
  const bizMap = Object.fromEntries(
    ((biz ?? []) as LoyaltyHubBusiness['business'][]).map(b => [b.id, b]),
  );
  return rows
    .filter(p => bizMap[p.business_id])
    .map(p => ({
      business: bizMap[p.business_id],
      program: {
        type: p.type,
        stamps_required: p.stamps_required,
        stamp_reward: p.stamp_reward,
        points_per_pound: p.points_per_pound,
        points_for_pound: p.points_for_pound,
      },
    }));
}

export type NearbyOffer = Omit<LocalOffer, 'business'> & {
  distance_km: number;
  business: Pick<LocalBusiness, 'id' | 'name' | 'logo_url' | 'category' | 'accepts_bookings' | 'subscription_tier' | 'is_active' | 'lat' | 'lng'>;
};

/** Active offers whose business has coordinates, sorted nearest-first from `coords`.
 *  Returns the closest ones with a distance on each — deliberately never filters
 *  to empty, so the caller can highlight a "within 1 mile" band yet still show the
 *  nearest deals island-wide (Shetland is spread out). */
export async function fetchNearbyOffers(
  coords: { lat: number; lng: number },
  limit = 40,
): Promise<NearbyOffer[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('local_offers')
    .select('*')
    .eq('is_active', true)
    .lte('valid_from', now)
    .gte('valid_until', now);
  if (error) throw error;
  const offers = (data ?? []) as LocalOffer[];
  if (!offers.length) return [];

  const businessIds = [...new Set(offers.map(o => o.business_id))];
  const { data: biz } = await supabase
    .from('local_businesses')
    .select('id, name, logo_url, category, accepts_bookings, subscription_tier, is_active, lat, lng')
    .in('id', businessIds)
    .eq('is_active', true);
  const bizMap = new Map((biz ?? []).map((b: any) => [b.id, b]));

  const out: NearbyOffer[] = [];
  for (const o of offers) {
    const b: any = bizMap.get(o.business_id);
    if (!b || b.lat == null || b.lng == null) continue;   // no coords → can't place it near you
    out.push({ ...o, business: b, distance_km: distanceKm(coords.lat, coords.lng, b.lat, b.lng) });
  }
  out.sort((a, b) => a.distance_km - b.distance_km);
  return out.slice(0, limit);
}

/** All offers (active + expired) for a business — used by both the public profile and the owner dashboard */
export async function fetchBusinessOffers(businessId: string, includeExpired = false): Promise<LocalOffer[]> {
  const now = new Date().toISOString();
  let q = supabase
    .from('local_offers')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (!includeExpired) q = q.gte('valid_until', now).eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as LocalOffer[];
}

export interface OfferInput {
  title: string;
  description?: string | null;
  image_url?: string | null;
  discount_type: DiscountType;
  discount_value?: number | null;
  valid_from: string;
  valid_until: string;
  terms?: string | null;
  max_redemptions?: number | null;
}

export async function createOffer(businessId: string, input: OfferInput): Promise<LocalOffer> {
  const { data, error } = await supabase
    .from('local_offers')
    .insert({ business_id: businessId, ...input })
    .select('*')
    .single();
  if (error) throw error;
  // Fire-and-forget: notify followers
  supabase.functions.invoke('notify-new-offer', { body: { offer_id: data.id } }).catch(() => {});
  return data as LocalOffer;
}

export async function deactivateOffer(offerId: string): Promise<void> {
  const { error } = await supabase
    .from('local_offers')
    .update({ is_active: false })
    .eq('id', offerId);
  if (error) throw error;
}

/** Redeem an offer — server records it and increments the count */
export async function redeemOffer(offerId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('local-redeem-offer', {
    body: { offer_id: offerId },
  });
  if (error) throw await fnErr(error, 'Could not redeem offer.');
}

// ── Staff-verified redemption backbone ──────────────────────────────────────
export type RedeemKind = 'offer' | 'reward' | 'pass' | 'points';
export type RedemptionTicket = {
  id: string; code: string; token: string; kind: RedeemKind;
  detail: { title?: string; subtitle?: string }; expires_at: string;
};

/** Customer starts a redemption → short code + QR token for staff to verify. */
export async function startRedemption(kind: RedeemKind, refId: string, amount?: number): Promise<RedemptionTicket> {
  const { data, error } = await supabase.functions.invoke('local-redeem-start', {
    body: { kind, ref_id: refId, amount },
  });
  if (error) throw await fnErr(error, 'Could not start redemption.');
  return data as RedemptionTicket;
}

/** Staff confirm a customer's code or scanned QR token → applies the effect. */
export async function verifyRedemption(input: { code?: string; token?: string }): Promise<{ ok: boolean; kind: RedeemKind; detail: { title?: string; subtitle?: string } }> {
  const { data, error } = await supabase.functions.invoke('local-redeem-verify', { body: input });
  if (error) throw await fnErr(error, 'Could not verify.');
  return data as { ok: boolean; kind: RedeemKind; detail: { title?: string; subtitle?: string } };
}

/** Poll a redemption's status (customer side) — flips to 'consumed' when staff verify. */
export async function getRedemptionStatus(id: string): Promise<'pending' | 'consumed' | 'expired' | 'cancelled' | null> {
  const { data } = await supabase.from('local_redemptions').select('status').eq('id', id).maybeSingle();
  return (data?.status as 'pending' | 'consumed' | 'expired' | 'cancelled' | undefined) ?? null;
}

export async function fetchMyRedeemedOfferIds(userId: string): Promise<string[]> {
  const { data } = await supabase
    .from('local_offer_redemptions')
    .select('offer_id')
    .eq('user_id', userId);
  return (data ?? []).map(r => r.offer_id);
}

// ── Wallet ────────────────────────────────────────────────────────────────────

/**
 * Pay for something from the OneShetland wallet (instead of a card) via the
 * wallet-checkout edge function. Surfaces the server's error message. Returns
 * the function's JSON (incl. the new balance_pence) on success.
 */
export async function walletCheckout(body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke('wallet-checkout', { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error; }
    } catch { /* keep generic */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data;
}

export async function fetchWalletBalance(userId: string): Promise<number> {
  const { data } = await supabase
    .from('local_wallet_balances')
    .select('balance_pence')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.balance_pence ?? 0;
}

export async function fetchWalletTransactions(userId: string, limit = 50): Promise<WalletTransaction[]> {
  const { data, error } = await supabase
    .from('local_wallet_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const txs = (data ?? []) as WalletTransaction[];

  const businessIds = [...new Set(txs.map(t => t.business_id).filter(Boolean))] as string[];
  if (businessIds.length === 0) return txs;
  const { data: biz } = await supabase
    .from('local_businesses')
    .select('id, name')
    .in('id', businessIds);
  const bizMap = Object.fromEntries((biz ?? []).map(b => [b.id, b]));
  return txs.map(t => ({ ...t, business: t.business_id ? (bizMap[t.business_id] ?? null) : null }));
}

/**
 * Start a top-up.
 *
 * Two possible response shapes (mirrors Boost / Units / Gifts):
 *   - { charged: true, payment_intent_id } when the user's saved card was
 *     charged off-session successfully. Caller should immediately invoke
 *     confirmWalletTopUp(payment_intent_id) to credit the balance.
 *   - { clientSecret, payment_intent_id } when there's no saved card — the
 *     caller should present the Stripe Payment Sheet with the clientSecret.
 */
export interface WalletTopUpResponse {
  charged?:          boolean;
  payment_intent_id: string;
  clientSecret?:     string;
}
export async function startWalletTopUp(
  amountPence: number,
  useSavedCard = true,
): Promise<WalletTopUpResponse> {
  const { data, error } = await supabase.functions.invoke('local-wallet-topup-intent', {
    body: { amount_pence: amountPence, use_saved_card: useSavedCard },
  });
  if (error) throw await fnErr(error, 'Could not start top-up.');
  return data;
}

/** After payment sheet succeeds, confirm so the balance is credited */
export async function confirmWalletTopUp(paymentIntentId: string): Promise<{ balance_pence: number }> {
  const { data, error } = await supabase.functions.invoke('local-wallet-confirm-topup', {
    body: { payment_intent_id: paymentIntentId },
  });
  if (error) throw await fnErr(error, 'Could not confirm top-up.');
  return data;
}

/**
 * A fresh id per payment ATTEMPT. The server claims it before debiting, so a
 * double-tap or an automatic retry after a slow response cannot pay twice —
 * while a genuine second payment, carrying a new id, still goes through.
 */
const paymentAttemptId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Pay a business from the wallet using their rotating code */
export async function payWithWallet(code: string, amountPence: number): Promise<{ balance_pence: number; cashback_pence: number }> {
  const { data, error } = await supabase.functions.invoke('local-wallet-pay', {
    body: { code, amount_pence: amountPence, client_request_id: paymentAttemptId() },
  });
  if (error) throw await fnErr(error, 'Could not pay with wallet.');
  return data;
}

/** Pay a business identified by a tapped NFC tile (no till code needed). */
export async function payWithWalletViaTile(nfcToken: string, amountPence: number): Promise<{ balance_pence: number; cashback_pence: number }> {
  const { data, error } = await supabase.functions.invoke('local-wallet-pay', {
    body: { nfc_token: nfcToken, amount_pence: amountPence, client_request_id: paymentAttemptId() },
  });
  if (error) throw await fnErr(error, 'Could not pay with wallet.');
  return data;
}

export interface ResolvedTile {
  business_id: string; business_name: string; accepts_wallet: boolean; payout_ready: boolean;
  cashback_percent: number | null; has_loyalty: boolean; program_type: 'stamps' | 'points' | null; stamp_reward: string | null;
}
/** Turn a tapped tile token into the business + what it offers (for the landing). */
export async function resolveNfcTile(token: string): Promise<ResolvedTile | null> {
  const { data, error } = await supabase.rpc('resolve_nfc_tile', { p_token: token });
  if (error) throw await fnErr(error, 'Could not read the tile.');
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ResolvedTile) ?? null;
}

// ── Business owner: incoming wallet payments (receipts) ──────────────────────
//
// What the shop sees when customers pay them via wallet. Backed by the
// SECURITY DEFINER RPC get_business_wallet_receipts (migration 033) so we
// can return customer first names without widening profiles RLS.

export interface BusinessWalletReceipt {
  id:                  string;
  created_at:          string;
  /** What the customer paid from their wallet, in pence. */
  gross_pence:         number;
  /** Platform fee retained. NULL for rows written before migration 033. */
  fee_pence:           number | null;
  /**
   * Cashback the business funded back to the customer (business-funded model,
   * migration 034 onwards). NULL for rows written before migration 034.
   */
  cashback_pence:      number | null;
  /**
   * What hit the shop's Stripe Connect balance — gross − fee − cashback.
   * NULL if fee_pence is unknown.
   */
  net_pence:           number | null;
  customer_first_name: string | null;
  stripe_transfer_id:  string | null;
}

export async function fetchBusinessWalletReceipts(
  businessId: string,
  limit = 20,
): Promise<BusinessWalletReceipt[]> {
  const { data, error } = await supabase.rpc('get_business_wallet_receipts', {
    p_business_id: businessId,
    p_limit:       limit,
  });
  if (error) throw error;
  return (data ?? []) as BusinessWalletReceipt[];
}

// ── Business owner: rotating code ─────────────────────────────────────────────

export async function fetchBusinessCode(businessId: string): Promise<BusinessCode | null> {
  const { data } = await supabase
    .from('local_business_codes')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();
  return (data ?? null) as BusinessCode | null;
}

/** Refreshes the rotating code (valid 60s).  Called by the business when displaying the code. */
export function generateCode(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

export async function refreshBusinessCode(businessId: string): Promise<BusinessCode> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 90_000).toISOString(); // 90s window for tolerance
  const { data, error } = await supabase
    .from('local_business_codes')
    .upsert({
      business_id: businessId,
      current_code: code,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as BusinessCode;
}

// ── Stripe Connect onboarding ─────────────────────────────────────────────────

export async function createBusinessOnboardingLink(businessId: string): Promise<{ url: string }> {
  const { data, error } = await supabase.functions.invoke('local-business-onboard', {
    body: { business_id: businessId },
  });
  if (error) throw await fnErr(error, 'Could not start onboarding.');
  return data;
}

// ── Subscription / featured ───────────────────────────────────────────────────

/** Is this business eligible for homepage featuring? */
export function isBusinessFeatured(b: Pick<LocalBusiness, 'subscription_tier' | 'subscription_until' | 'is_active'>): boolean {
  if (!b.is_active) return false;
  if (b.subscription_tier !== 'premium') return false;
  if (!b.subscription_until) return true; // null = no expiry yet
  return new Date(b.subscription_until).getTime() > Date.now();
}

/**
 * Pulls the freshest live offer from a premium-tier business — used by the
 * homepage Featured Offer card. Falls back to null if none qualifies.
 */
export async function fetchFeaturedOffer(): Promise<LocalOffer | null> {
  const now = new Date().toISOString();

  // 1. Eligible premium businesses
  const { data: bizRows } = await supabase
    .from('local_businesses')
    .select('id, name, logo_url, category, subscription_tier, subscription_until, accepts_bookings, is_active')
    .eq('subscription_tier', 'premium')
    .eq('is_active', true)
    .or(`subscription_until.is.null,subscription_until.gt.${now}`);

  if (!bizRows || bizRows.length === 0) return null;
  const eligibleIds = bizRows.map(b => b.id);

  // 2. Freshest live offer from those businesses
  const { data: offers } = await supabase
    .from('local_offers')
    .select('*')
    .in('business_id', eligibleIds)
    .eq('is_active', true)
    .lte('valid_from', now)
    .gte('valid_until', now)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!offers || offers.length === 0) return null;
  const offer = offers[0] as LocalOffer;
  offer.business = bizRows.find(b => b.id === offer.business_id) ?? null;
  return offer;
}

/**
 * Businesses for the homepage featured grid.
 *
 * Pro/Premium subscribers come first (that's the paid perk), then — so the grid
 * is never empty while the directory is young — we backfill remaining slots with
 * other active businesses (verified first, then newest). This means seeded
 * listings surface here too, complete with their "Claim" pill.
 */
export async function fetchFeaturedBusinesses(limit = 12): Promise<LocalBusiness[]> {
  const now = new Date().toISOString();

  const { data: subs } = await supabase
    .from('local_businesses')
    .select('*')
    .eq('is_active', true)
    .in('subscription_tier', ['pro', 'premium'])
    .or(`subscription_until.is.null,subscription_until.gt.${now}`)
    .order('subscription_tier', { ascending: false }) // premium before pro
    .order('created_at', { ascending: false })
    .limit(limit);

  const featured = (subs ?? []) as LocalBusiness[];
  if (featured.length >= limit) return featured;

  // Backfill with other active businesses we haven't already included.
  const have = new Set(featured.map(b => b.id));
  const { data: rest } = await supabase
    .from('local_businesses')
    .select('*')
    .eq('is_active', true)
    .order('is_verified', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit * 3);

  for (const b of (rest ?? []) as LocalBusiness[]) {
    if (featured.length >= limit) break;
    if (!have.has(b.id)) { featured.push(b); have.add(b.id); }
  }
  return featured;
}

/** Fetch the single best live offer per business for a set of business IDs. */
export async function fetchActiveOffersForBusinesses(
  businessIds: string[]
): Promise<LocalOffer[]> {
  if (businessIds.length === 0) return [];
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('local_offers')
    .select('id, business_id, title, discount_type, discount_value, valid_until, image_url, is_active, redemption_count, max_redemptions, valid_from, terms, description, created_at')
    .in('business_id', businessIds)
    .eq('is_active', true)
    .lte('valid_from', now)
    .gte('valid_until', now)
    .order('created_at', { ascending: false });
  return (data ?? []) as LocalOffer[];
}

// ── NFC tile ──────────────────────────────────────────────────────────────────

/** Business owner requests an NFC tile — generates token, sets status to 'requested' */
export async function requestNfcTile(businessId: string): Promise<{ token: string }> {
  // Generate token via DB function
  const { data: business } = await supabase
    .from('local_businesses')
    .select('name')
    .eq('id', businessId)
    .single();

  if (!business) throw new Error('Business not found');

  const { data: tokenRow, error: rpcErr } = await supabase
    .rpc('generate_nfc_token', { business_name: business.name });
  if (rpcErr) throw rpcErr;

  const token = tokenRow as unknown as string;

  const { error } = await supabase
    .from('local_businesses')
    .update({ nfc_token: token, nfc_status: 'requested' })
    .eq('id', businessId);
  if (error) throw error;

  return { token };
}

/** Collect a stamp via NFC tap — requires user location */
export async function collectStampViaNfc(
  token: string,
  lat: number,
  lng: number,
): Promise<{ ok: boolean; stamps: number; needed: number; reward_ready: boolean; business_name: string; business_id: string }> {
  const { data, error } = await supabase.functions.invoke('local-nfc-stamp', {
    body: { token, lat, lng },
  });
  if (error) {
    // Supabase wraps the response in a FunctionsHttpError; pull the real message out
    try {
      const body = await (error as any).context?.json();
      throw new Error(body?.error ?? error.message);
    } catch (parseErr) {
      if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      throw new Error(error.message);
    }
  }
  return data;
}

export const NFC_TILE_URL_PREFIX = 'https://oneshetland.com/t/';

/** Create a Stripe Checkout session for upgrading the business to Pro or Premium */
/**
 * In-app subscription via Stripe Payment Sheet.
 * Calls the local-subscription-intent edge function to create an incomplete
 * subscription and get the data needed to initialise the Payment Sheet.
 * The caller (a component using useStripe) does the actual initPaymentSheet /
 * presentPaymentSheet — this just provides the server-side bits.
 */
export interface SubscriptionIntent {
  paymentIntent:    string;
  ephemeralKey:     string;
  customer:         string;
  subscriptionId:   string;
}

export async function createSubscriptionIntent(
  businessId: string,
  tier: 'pro' | 'premium',
): Promise<SubscriptionIntent> {
  const { data, error } = await supabase.functions.invoke('local-subscription-intent', {
    body: { business_id: businessId, tier },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
      }
    } catch { /* fall through */ }
    throw new Error(realMessage);
  }
  return data as SubscriptionIntent;
}

/**
 * Mid-cycle tier change with proration.
 *
 * Two-step UX: preview first to show the user what they'll pay, then apply
 * after they confirm.
 *
 * - previewSubscriptionChange returns { previewAmountPence, nextRenewalAt, ... }
 * - applySubscriptionChange triggers the actual proration + charge.
 *
 * Only valid for existing subscribers (Pro → Premium or Premium → Pro).
 * For first-time subscribers, use createSubscriptionIntent (Payment Sheet) instead.
 */
export interface SubscriptionChangePreview {
  previewAmountPence: number;
  currency:           string;
  nextRenewalAt:      string | null;
  currentTier:        'pro' | 'premium';
  newTier:            'pro' | 'premium';
  noChange?:          boolean;
}

export async function previewSubscriptionChange(
  businessId: string,
  tier: 'pro' | 'premium',
): Promise<SubscriptionChangePreview> {
  const { data, error } = await supabase.functions.invoke('local-subscription-change', {
    body: { business_id: businessId, tier, preview: true },
  });
  if (error) {
    let realMessage = error.message;
    let code: string | undefined;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
        if (body?.code)  code        = body.code;
      }
    } catch { /* fall through */ }
    const e = new Error(realMessage) as Error & { code?: string };
    e.code = code;
    throw e;
  }
  return data as SubscriptionChangePreview;
}

export async function applySubscriptionChange(
  businessId: string,
  tier: 'pro' | 'premium',
): Promise<{ success: boolean; subscriptionId: string }> {
  const { data, error } = await supabase.functions.invoke('local-subscription-change', {
    body: { business_id: businessId, tier, preview: false },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
      }
    } catch { /* fall through */ }
    throw new Error(realMessage);
  }
  return data as { success: boolean; subscriptionId: string };
}

/**
 * Boost — short-term Pro access (1, 2 or 3 weeks) via a one-time payment.
 * Returns the data the Payment Sheet needs to collect payment + the £ amount
 * for confirmation messaging in the UI.
 */
export interface BoostIntent {
  paymentIntent: string;
  ephemeralKey:  string;
  customer:      string;
  amountPence:   number;
  weeks:         number;
}

export async function createBoostIntent(
  businessId: string,
  weeks: 1 | 2 | 3,
): Promise<BoostIntent> {
  const { data, error } = await supabase.functions.invoke('local-boost-checkout', {
    body: { business_id: businessId, weeks },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
      }
    } catch { /* fall through */ }
    throw new Error(realMessage);
  }
  return data as BoostIntent;
}

/** Fetch the configured boost prices (in pence) for 1, 2 and 3 weeks.
 *  Returns null values silently if RLS denies the read (e.g. non-admin user).
 *  We need a public read path for these eventually — see TODO in migration 021. */
export async function fetchBoostPrices(): Promise<{
  one:   number | null;
  two:   number | null;
  three: number | null;
}> {
  try {
    const { data, error } = await supabase
      .from('admin_config')
      .select('key, value')
      .in('key', [
        'boost.price.1_week_pence',
        'boost.price.2_week_pence',
        'boost.price.3_week_pence',
      ]);
    if (error) {
      // Most likely cause: RLS denies non-admin users from reading admin_config.
      // Fail silently — the boost card will simply not render until we add a
      // dedicated public-read view for prices.
      console.warn('[fetchBoostPrices] read denied or failed:', error.message);
      return { one: null, two: null, three: null };
    }
    const map = Object.fromEntries((data ?? []).map((r: any) => [r.key, parseInt(r.value, 10) || null]));
    return {
      one:   map['boost.price.1_week_pence']   ?? null,
      two:   map['boost.price.2_week_pence']   ?? null,
      three: map['boost.price.3_week_pence']   ?? null,
    };
  } catch (e) {
    console.warn('[fetchBoostPrices] threw:', e);
    return { one: null, two: null, three: null };
  }
}

/**
 * Is this business currently on a boost (vs a monthly subscription)?
 * A boost = paid Pro access with no Stripe subscription attached.
 */
export function isOnBoost(b: {
  subscription_tier?: 'free' | 'pro' | 'premium' | null;
  subscription_until?: string | null;
  stripe_subscription_id?: string | null;
}): boolean {
  return (
    !b.stripe_subscription_id &&
    b.subscription_tier === 'pro' &&
    !!b.subscription_until &&
    new Date(b.subscription_until) > new Date()
  );
}

/**
 * Stripe Customer Portal — for cancellation, payment-method updates,
 * invoice history. Returns a URL the app should open in a browser.
 */
export async function createBillingPortalLink(businessId: string): Promise<{ url: string }> {
  const { data, error } = await supabase.functions.invoke('local-billing-portal', {
    body: { business_id: businessId },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
      }
    } catch { /* fall through */ }
    throw new Error(realMessage);
  }
  return data as { url: string };
}

/**
 * Legacy: opens a hosted Stripe Checkout page in the browser. Kept as a
 * fallback / for web sharing. The in-app upgrade now uses
 * createSubscriptionIntent + Payment Sheet instead.
 */
export async function startSubscriptionCheckout(businessId: string, tier: 'pro' | 'premium'): Promise<{ url: string }> {
  const { data, error } = await supabase.functions.invoke('local-subscription-checkout', {
    body: { business_id: businessId, tier },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) {
          realMessage = body.error;
          // Include any debug payload inline so the alert shows it during dev
          if (body?.debug) realMessage += '\n\n' + JSON.stringify(body.debug, null, 2);
        }
      }
    } catch { /* fall through to generic */ }
    throw new Error(realMessage);
  }
  return data;
}

/** Count of active businesses — used on the Home Live now strip */
export async function fetchActiveBusinessCount(): Promise<number> {
  const { count } = await supabase
    .from('local_businesses')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);
  return count ?? 0;
}

// ── Directory: claim-a-business + discount grants (migration 062) ─────────────

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface BusinessClaim {
  id:            string;
  business_id:   string;
  user_id:       string;
  status:        ClaimStatus;
  contact_name:  string | null;
  contact_email: string | null;
  contact_phone: string | null;
  role:          string | null;
  evidence:      string | null;
  admin_note:    string | null;
  created_at:    string;
  reviewed_at:   string | null;
  reviewed_by:   string | null;
  // joined (admin list)
  business?:     Pick<LocalBusiness, 'id' | 'name' | 'slug' | 'category'> | null;
}

export interface ClaimInput {
  contact_name?:  string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  role?:          string | null;
  evidence?:      string | null;
}

/** Submit a claim for an unclaimed listing. */
export async function submitBusinessClaim(
  userId: string,
  businessId: string,
  input: ClaimInput,
): Promise<BusinessClaim> {
  const { data, error } = await supabase
    .from('business_claims')
    .insert({ user_id: userId, business_id: businessId, ...input })
    .select('*')
    .single();
  if (error) throw error;
  // Fire-and-forget: ping admin (edge function added separately).
  supabase.functions.invoke('notify-business-claim', { body: { claim_id: data.id } }).catch(() => {});
  return data as BusinessClaim;
}

/** A user's own claim for a given business, if any (to show pending state). */
export async function fetchMyClaim(userId: string, businessId: string): Promise<BusinessClaim | null> {
  const { data } = await supabase
    .from('business_claims')
    .select('*')
    .eq('user_id', userId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as BusinessClaim | null;
}

/** Admin: all claims, newest first, with business joined. */
export async function fetchClaims(status?: ClaimStatus): Promise<BusinessClaim[]> {
  let q = supabase
    .from('business_claims')
    .select('*, business:local_businesses ( id, name, slug, category )')
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as BusinessClaim[];
}

/** Admin: count of pending claims (badge). */
export async function fetchPendingClaimCount(): Promise<number> {
  const { count } = await supabase
    .from('business_claims')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  return count ?? 0;
}

/** Admin: approve a claim (assigns owner, verifies, rejects rivals) via RPC. */
export async function approveClaim(claimId: string): Promise<void> {
  const { error } = await supabase.rpc('approve_business_claim', { p_claim_id: claimId });
  if (error) throw error;
  supabase.functions
    .invoke('notify-claim', { body: { claim_id: claimId, outcome: 'approved' } })
    .catch(() => {});
}

/** Admin: reject a claim with an optional note. */
export async function rejectClaim(claimId: string, note?: string): Promise<void> {
  const { error } = await supabase
    .from('business_claims')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString(), admin_note: note ?? null })
    .eq('id', claimId);
  if (error) throw error;
  supabase.functions
    .invoke('notify-claim', { body: { claim_id: claimId, outcome: 'rejected' } })
    .catch(() => {});
}

// ── Discount grants ────────────────────────────────────────────────────────────

export interface DiscountGrant {
  id:              string;
  business_id:     string;
  tier:            'pro' | 'premium';
  percent_off:     number;
  duration_months: number;
  applicable_from: string;
  expires_at:      string;
  status:          'active' | 'redeemed' | 'expired' | 'revoked';
  stripe_coupon_id: string | null;
  granted_by:      string | null;
  created_at:      string;
  redeemed_at:     string | null;
}

export interface DiscountGrantInput {
  tier:         'pro' | 'premium';
  percent_off:  number;
  /** Days after the grant before it becomes applicable (default 7). */
  delay_days?:  number;
  duration_months?: number;
}

/** Admin: grant a discount that becomes applicable `delay_days` later (default a week). */
export async function grantDiscount(
  businessId: string,
  input: DiscountGrantInput,
): Promise<DiscountGrant> {
  const delayDays = input.delay_days ?? 7;
  const months    = input.duration_months ?? 12;
  const applicableFrom = new Date(Date.now() + delayDays * 86_400_000);
  const expiresAt      = new Date(applicableFrom.getTime());
  expiresAt.setMonth(expiresAt.getMonth() + months);
  const { data, error } = await supabase
    .from('business_discount_grants')
    .insert({
      business_id:     businessId,
      tier:            input.tier,
      percent_off:     input.percent_off,
      duration_months: months,
      applicable_from: applicableFrom.toISOString(),
      expires_at:      expiresAt.toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as DiscountGrant;
}

/** The live discount waiting for a business (to upsell the owner), if any. */
export async function fetchActiveDiscount(businessId: string): Promise<DiscountGrant | null> {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('business_discount_grants')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .lte('applicable_from', now)
    .gte('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as DiscountGrant | null;
}

// ── My Wallet hub: passes & gifts ─────────────────────────────────────────────
//
// "Passes & vouchers" — unit purchases the user owns. Joins to the source
// book_unit_items for name + business_id, and to local_businesses for the
// business name. Filters to active passes (uses_remaining > 0, not expired).

export interface MyPass {
  id:                string;
  item_id:           string;
  business_id:       string;
  uses_remaining:    number;
  paid_amount_pence: number;
  expires_at:        string | null;
  created_at:        string;
  item_name:         string | null;
  business_name:     string | null;
  /** True if this purchase was acquired by claiming a gift. */
  from_gift:         boolean;
}

export async function fetchMyPasses(userId: string): Promise<MyPass[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('book_unit_purchases')
    .select(`
      id, item_id, business_id, uses_remaining, paid_amount_pence,
      expires_at, created_at, gift_id,
      item:book_unit_items ( name ),
      business:local_businesses ( name )
    `)
    .eq('owner_id', userId)
    .gt('uses_remaining', 0)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    id:                r.id,
    item_id:           r.item_id,
    business_id:       r.business_id,
    uses_remaining:    r.uses_remaining,
    paid_amount_pence: r.paid_amount_pence,
    expires_at:        r.expires_at,
    created_at:        r.created_at,
    item_name:         r.item?.name ?? null,
    business_name:     r.business?.name ?? null,
    from_gift:         !!r.gift_id,
  }));
}

// "Gifts to claim" — gifts the user has claimed but not yet redeemed.
// Unit gifts that already became book_unit_purchases rows show up as Passes,
// not here. So this list is mainly:
//   - booking gifts where claimed_by_user_id = me AND status = 'claimed' (slot
//     not yet picked → routes into the booking picker with gift_id pre-attached)
//
// `kind` is preserved so the UI can route correctly.

export interface MyGiftReceived {
  id:                 string;
  code:               string;
  kind:               'unit' | 'booking';
  status:             'claimed' | 'used';
  business_id:        string;
  business_name:      string | null;
  /** Set when kind = 'booking' — the service the gift redeems. */
  service_id:         string | null;
  service_name:       string | null;
  /** Set when kind = 'unit' — the item the gift becomes a purchase of. */
  unit_item_id:       string | null;
  unit_item_name:     string | null;
  purchaser_name:     string | null;
  message:            string | null;
  claimed_at:         string;
  expires_at:         string | null;
}

export async function fetchMyGiftsReceived(userId: string): Promise<MyGiftReceived[]> {
  const { data, error } = await supabase
    .from('book_gifts')
    .select(`
      id, code, kind, status, business_id, service_id, unit_item_id,
      purchaser_name, message, claimed_at, expires_at,
      business:local_businesses ( name ),
      service:book_services ( name ),
      unit_item:book_unit_items ( name )
    `)
    .eq('claimed_by_user_id', userId)
    .in('status', ['claimed', 'used'])
    .order('claimed_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    id:             r.id,
    code:           r.code,
    kind:           r.kind,
    status:         r.status,
    business_id:    r.business_id,
    business_name:  r.business?.name ?? null,
    service_id:     r.service_id,
    service_name:   r.service?.name ?? null,
    unit_item_id:   r.unit_item_id,
    unit_item_name: r.unit_item?.name ?? null,
    purchaser_name: r.purchaser_name,
    message:        r.message,
    claimed_at:     r.claimed_at,
    expires_at:     r.expires_at,
  }));
}

// ---------------------------------------------------------------------------
// Combined local feed (for the Local tab)
// ---------------------------------------------------------------------------

export interface LocalFeedEvent {
  id: string; title: string; starts_at: string; venue: string | null;
  cover_url: string | null; has_tickets: boolean; locality: string | null;
}

export interface LocalFeedJob {
  id: string; title: string; location: string | null; pay_text: string | null;
}

export interface LocalFeedNotice {
  id: string; title: string; body: string | null;
  hub: { id: string; name: string; logo_url: string | null; slug: string | null } | null;
}

export async function fetchLocalFeed(area?: string): Promise<{
  events:     LocalFeedEvent[];
  businesses: LocalBusiness[];
  jobs:       LocalFeedJob[];
}> {
  const now = new Date().toISOString();

  let evQ = supabase
    .from('events')
    .select('id,title,starts_at,venue,cover_url,has_tickets,locality')
    .eq('status', 'published')
    .or('organiser_hub_id.is.null,calendar_approved.eq.true')
    .gte('starts_at', now)
    .order('starts_at', { ascending: true })
    .limit(12);
  if (area) evQ = evQ.ilike('locality', `%${area}%`);

  let bizQ = supabase
    .from('local_businesses')
    .select('*')
    .eq('is_active', true)
    .order('is_verified', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(20);
  if (area) bizQ = bizQ.ilike('locality', `%${area}%`);

  let jobQ = supabase
    .from('jobs')
    .select('id,title,location,pay_text')
    .eq('is_hidden', false)
    .eq('status', 'open')
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('is_featured', { ascending: false })
    .order('posted_at', { ascending: false })
    .limit(10);
  if (area) jobQ = jobQ.ilike('location', `%${area}%`);

  const [evRes, bizRes, jobRes] = await Promise.all([evQ, bizQ, jobQ]);

  return {
    events:     (evRes.data  ?? []) as LocalFeedEvent[],
    businesses: (bizRes.data ?? []) as LocalBusiness[],
    jobs:       (jobRes.data ?? []) as LocalFeedJob[],
  };
}

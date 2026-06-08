/**
 * lib/home-data.ts
 *
 * Aggregates the signed-in user's personalised home-screen state into one
 * resilient fetch. Every sub-query is wrapped so a single failure degrades
 * gracefully (that card just doesn't show) rather than breaking the feed.
 *
 * Role-aware: only runs the queries relevant to the user's role.
 */

import { supabase } from './supabase';
import { fetchMyBookings, type BookBooking } from './book-api';
import { fetchMyApplications } from './shifts-api';
import { fetchMyLoyaltyCards, fetchMyBusinesses, type LocalBusiness } from './local-api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActiveDelivery {
  id:               string;
  status:           'pending' | 'matched' | 'collected';
  category_slug:    string | null;
  destination_area: string | null;
}

export interface UpcomingBooking {
  id:            string;
  business_id:   string;
  business_name: string | null;
  service_name:  string | null;
  starts_at:     string;
}

export interface ApplicationSummary {
  id:        string;
  title:     string;
  status:    'pending' | 'accepted' | 'rejected' | 'withdrawn';
  start_at:  string | null;
}

export interface RewardReady {
  business_id:   string;
  business_name: string | null;
  stamps:        number;
  needed:        number;
}

export interface OwnerGlance {
  businesses:        LocalBusiness[];
  primaryBusiness:   LocalBusiness | null;
  tier:              'free' | 'pro' | 'premium' | null;
  pendingBookings:   number;
}

export interface HomeData {
  activeDelivery:   ActiveDelivery | null;
  upcomingBooking:  UpcomingBooking | null;
  application:      ApplicationSummary | null;   // most relevant (pending/accepted)
  rewardReady:      RewardReady | null;
  owner:            OwnerGlance | null;
  /**
   * Total "things in your wallet" — sum of:
   *   - active passes/vouchers (book_unit_purchases with uses_remaining > 0)
   *   - gifts awaiting claim/slot pick (book_gifts kind='booking', status='claimed')
   *   - upcoming confirmed bookings
   *   - loyalty cards
   * Used to render a count badge on the header wallet icon. Cheap head-counts.
   */
  walletItemCount:  number;
}

const EMPTY: HomeData = {
  activeDelivery:  null,
  upcomingBooking: null,
  application:     null,
  rewardReady:     null,
  owner:           null,
  walletItemCount: 0,
};

// ── Helpers (each isolated; never throws) ───────────────────────────────────────

async function getActiveDelivery(userId: string): Promise<ActiveDelivery | null> {
  try {
    const { data } = await supabase
      .from('delivery_requests')
      .select('id, status, category_slug, destination_area')
      .eq('customer_id', userId)
      .in('status', ['pending', 'matched', 'collected'])
      .order('created_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    return row ? (row as ActiveDelivery) : null;
  } catch {
    return null;
  }
}

async function getUpcomingBooking(userId: string): Promise<UpcomingBooking | null> {
  try {
    const all = await fetchMyBookings(userId);
    const now = Date.now();
    const next = all
      .filter(b => b.status === 'confirmed' && new Date(b.starts_at).getTime() > now)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0] as
        (BookBooking & { business?: { name?: string } | null }) | undefined;
    if (!next) return null;
    return {
      id:            next.id,
      business_id:   next.business_id,
      business_name: (next as any).business?.name ?? null,
      service_name:  next.service?.name ?? null,
      starts_at:     next.starts_at,
    };
  } catch {
    return null;
  }
}

async function getApplication(userId: string): Promise<ApplicationSummary | null> {
  try {
    const apps = await fetchMyApplications(userId);
    // Surface the most actionable: accepted first, then most recent pending.
    const accepted = apps.find((a: any) => a.status === 'accepted');
    const pending  = apps.find((a: any) => a.status === 'pending');
    const pick = accepted ?? pending;
    if (!pick) return null;
    return {
      id:       pick.id,
      title:    pick.title ?? 'Your shift',
      status:   pick.status,
      start_at: pick.start_at ?? null,
    };
  } catch {
    return null;
  }
}

async function getRewardReady(userId: string): Promise<RewardReady | null> {
  try {
    const cards = await fetchMyLoyaltyCards(userId);
    for (const c of cards) {
      const needed = c.program?.stamps_required ?? 0;
      if (c.program?.type === 'stamps' && needed > 0 && c.stamps_collected >= needed) {
        return {
          business_id:   c.business_id,
          business_name: c.business?.name ?? null,
          stamps:        c.stamps_collected,
          needed,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getOwnerGlance(userId: string): Promise<OwnerGlance | null> {
  try {
    const businesses = await fetchMyBusinesses(userId);
    if (businesses.length === 0) return null;
    const primary = businesses[0];

    // Count pending bookings across the owner's businesses (cheap head count).
    let pendingBookings = 0;
    try {
      const ids = businesses.map(b => b.id);
      const { count } = await supabase
        .from('book_bookings')
        .select('id', { count: 'exact', head: true })
        .in('business_id', ids)
        .eq('status', 'confirmed')
        .gte('starts_at', new Date().toISOString());
      pendingBookings = count ?? 0;
    } catch { /* leave at 0 */ }

    return {
      businesses,
      primaryBusiness: primary,
      tier:            (primary.subscription_tier as OwnerGlance['tier']) ?? 'free',
      pendingBookings,
    };
  } catch {
    return null;
  }
}

async function getWalletItemCount(userId: string): Promise<number> {
  // Four cheap head-counts in parallel. Each independent — any single
  // failure just contributes 0 to the badge.
  const nowIso = new Date().toISOString();

  // Run a count-builder (Supabase Thenable). Awaiting it returns the
  // standard { count, error } shape. Any throw collapses to 0.
  const safeCount = async (run: () => PromiseLike<{ count: number | null }>): Promise<number> => {
    try { const { count } = await run(); return count ?? 0; } catch { return 0; }
  };

  const [passes, gifts, bookings, cards] = await Promise.all([
    safeCount(() => supabase
      .from('book_unit_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .gt('uses_remaining', 0)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)),
    safeCount(() => supabase
      .from('book_gifts')
      .select('id', { count: 'exact', head: true })
      .eq('claimed_by_user_id', userId)
      .eq('status', 'claimed')
      .eq('kind', 'booking')),
    safeCount(() => supabase
      .from('book_bookings')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', userId)
      .eq('status', 'confirmed')
      .gte('starts_at', nowIso)),
    safeCount(() => supabase
      .from('loyalty_cards')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)),
  ]);

  return passes + gifts + bookings + cards;
}

// ── Public aggregator ───────────────────────────────────────────────────────────

/**
 * Fetch everything the home screen needs about THIS user, in parallel.
 * Pass the profile; pass null/undefined for signed-out (returns EMPTY).
 */
export async function fetchHomeData(
  profile: { id: string; role?: string | null } | null | undefined,
): Promise<HomeData> {
  if (!profile?.id) return { ...EMPTY };

  const userId = profile.id;

  const [activeDelivery, upcomingBooking, application, rewardReady, owner, walletItemCount] = await Promise.all([
    getActiveDelivery(userId),
    getUpcomingBooking(userId),
    getApplication(userId),
    getRewardReady(userId),
    // Always check ownership — role isn't always set to business_owner even when they own one
    getOwnerGlance(userId),
    getWalletItemCount(userId),
  ]);

  return { activeDelivery, upcomingBooking, application, rewardReady, owner, walletItemCount };
}

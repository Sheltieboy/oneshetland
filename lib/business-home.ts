/**
 * business-home.ts — everything the mobile Business Home needs, in one go.
 *
 * The web equivalent lives in the web repo's business-dashboard.server.ts; this
 * is the same set of questions asked the same way, because the answers have to
 * agree. What differs is only how they are fetched.
 *
 * Two rules run through it.
 *
 * A failed read is null, never zero. "No orders" and "we could not find out"
 * look identical to an owner and must not come out of the same code path, so a
 * rejected or errored read degrades one row to "couldn't load this" rather than
 * confidently reporting nothing.
 *
 * Counts are counted by Postgres. head-only requests transfer no rows, so the
 * page never pulls a shop's products across the wire to call .length on them.
 */

import { supabase } from '@/lib/supabase';
import { fetchEffectiveTier, NO_ENTITLEMENT, type Effective } from '@/lib/entitlement';
import type { OutcomeData } from '@/lib/business-outcomes';

/** One thing genuinely waiting on the owner. */
export type AttentionItem = {
  key: 'orders' | 'bookings' | 'leads' | 'applications' | 'availability';
  label: string;
  /** Where it is dealt with. Work items deep-link into Work. */
  route: string;
};

export type WeekAtAGlance = {
  views: number | null;
  contacts: number | null;
  followers: number | null;
  /** Pence. null = we genuinely cannot see it, which is not the same as £0. */
  revenuePence: number | null;
};

export type BusinessHome = {
  attention: AttentionItem[];
  week: WeekAtAGlance;
  outcomes: OutcomeData;
  effective: Effective;
  /** Boost bought and not yet expired. null = unreadable. */
  boostActive: boolean | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An exact count, or null when the read failed. Never a consoling zero. */
function num(r: PromiseSettledResult<{ count: number | null; error: unknown }>): number | null {
  return r.status === 'fulfilled' && !r.value.error ? (r.value.count ?? 0) : null;
}

export async function fetchBusinessHome(
  businessId: string,
  ownerId: string,
  business: { trade_availability?: string | null; trade_availability_set_at?: string | null },
  availabilityIsStale: (setAt: string | null | undefined) => boolean,
): Promise<BusinessHome> {
  const now = new Date().toISOString();
  const count = (table: string, apply: (q: any) => any) =>   // eslint-disable-line @typescript-eslint/no-explicit-any
    apply(supabase.from(table).select('id', { count: 'exact', head: true }).eq('business_id', businessId));

  // Job applications are keyed by job, so the job ids come first. Everything
  // else goes in one parallel batch behind it — two waves, not eighteen.
  const jobIds = await supabase.from('jobs').select('id').eq('business_id', businessId)
    .then(({ data }) => (data ?? []).map((j: { id: string }) => j.id), () => [] as string[]);

  const [
    ordersRes, bookingsRes, leadsRes, appsRes,
    productsRes, productsActiveRes, passesRes, passesActiveRes,
    servicesRes, availabilityRes, eventsRes, eventsUpcomingRes,
    offersRes, offersLiveRes, loyaltyRes, loyaltyActiveRes,
    boostRes, analyticsRes, effRes,
  ] = await Promise.allSettled([
    count('product_orders', (q) => q.eq('status', 'paid')),
    supabase.from('book_bookings').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('status', 'confirmed').gte('starts_at', now),
    supabase.from('trade_brief_matches').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('status', 'sent'),
    jobIds.length
      ? supabase.from('job_applications').select('id', { count: 'exact', head: true })
          .in('job_id', jobIds).eq('status', 'applied')
      : Promise.resolve({ count: 0, error: null }),

    count('products', (q) => q),
    count('products', (q) => q.eq('is_active', true)),
    count('book_unit_items', (q) => q),
    count('book_unit_items', (q) => q.eq('is_active', true)),
    count('book_services', (q) => q),
    count('book_availability_rules', (q) => q),
    supabase.from('events').select('id', { count: 'exact', head: true })
      .eq('organiser_business_id', businessId),
    supabase.from('events').select('id', { count: 'exact', head: true })
      .eq('organiser_business_id', businessId).eq('status', 'published')
      .eq('is_hidden', false).gt('starts_at', now),
    count('local_offers', (q) => q),
    count('local_offers', (q) => q.eq('is_active', true).lte('valid_from', now).gte('valid_until', now)),
    count('local_loyalty_programs', (q) => q),
    count('local_loyalty_programs', (q) => q.eq('is_active', true)),
    count('local_boost_purchases', (q) => q.eq('status', 'succeeded').gt('expires_at', now)),

    supabase.rpc('business_analytics', { p_business_id: businessId, p_days: 7 }),
    fetchEffectiveTier(businessId),
  ]);

  /* ── What is waiting ────────────────────────────────────────────────────
     Only genuine, actionable items. A zero is not shown — a row of zeroes
     teaches you to skim past the row that finally matters — and an unreadable
     count is not shown either, because we cannot honestly say it needs you. */
  const attention: AttentionItem[] = [];
  const orders = num(ordersRes as never);
  const bookings = num(bookingsRes as never);
  const leads = num(leadsRes as never);
  const apps = num(appsRes as never);
  if (orders && orders > 0) attention.push({ key: 'orders', label: `${plural(orders, 'order')} to deal with`, route: '/business-orders' });
  if (bookings && bookings > 0) attention.push({ key: 'bookings', label: `${plural(bookings, 'booking')} coming up`, route: '/local-book-bookings' });
  if (leads && leads > 0) attention.push({ key: 'leads', label: `${plural(leads, 'job lead')} waiting`, route: '/business-leads' });
  if (apps && apps > 0) attention.push({ key: 'applications', label: `${plural(apps, 'application')} to review`, route: '/business-jobs' });
  // The costliest stale setting on the platform: a trade whose availability has
  // lapsed has silently stopped receiving work.
  if (business.trade_availability && availabilityIsStale(business.trade_availability_set_at)) {
    attention.push({ key: 'availability', label: 'Your availability is out of date', route: '/business-leads' });
  }

  /* ── The week ───────────────────────────────────────────────────────────
     business_analytics returns { basic, full }; `full` is null without the
     paid tier, so revenue is genuinely UNKNOWN for most businesses. Printing
     £0 to somebody who took £400 would destroy trust in every other figure. */
  const a = analyticsRes.status === 'fulfilled' && !(analyticsRes.value as { error?: unknown }).error
    ? ((analyticsRes.value as { data: Record<string, unknown> | null }).data ?? null)
    : null;
  const basic = (a?.basic ?? null) as Record<string, number> | null;
  const full = (a?.full ?? null) as Record<string, number> | null;
  const week: WeekAtAGlance = {
    views: basic ? (basic.profile_views ?? 0) : null,
    contacts: basic ? (basic.contacts ?? 0) : null,
    followers: basic ? (basic.followers ?? 0) : null,
    revenuePence: full
      ? (full.booking_revenue_pence ?? 0) + (full.unit_revenue_pence ?? 0) + (full.ticket_revenue_pence ?? 0)
      : null,
  };

  const effective = effRes.status === 'fulfilled' ? (effRes.value as Effective) : NO_ENTITLEMENT;
  const boostCount = num(boostRes as never);

  return {
    attention,
    week,
    effective,
    boostActive: boostCount === null ? null : boostCount > 0,
    outcomes: {
      products: num(productsRes as never), productsActive: num(productsActiveRes as never),
      passes: num(passesRes as never), passesActive: num(passesActiveRes as never),
      services: num(servicesRes as never), availability: num(availabilityRes as never),
      events: num(eventsRes as never), eventsUpcoming: num(eventsUpcomingRes as never),
      offers: num(offersRes as never), offersLive: num(offersLiveRes as never),
      loyalty: num(loyaltyRes as never), loyaltyActive: num(loyaltyActiveRes as never),
      // Entitlement failing is not the same as being un-entitled for the
      // OUTCOME rows: an unreadable plan must not claim anything is live.
      meetsPro: effRes.status === 'fulfilled' ? effective.pro : null,
      meetsPremium: effRes.status === 'fulfilled' ? effective.premium : null,
    },
  };
}

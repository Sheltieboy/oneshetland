/**
 * book-api.ts
 * Types + Supabase calls for OneShetland Book — slot-booking for service businesses.
 *
 * Phase 1 covers:
 *   • Services (CRUD)
 *   • Weekly availability rules
 *   • One-off slot overrides (open / closed / last-min)
 *   • Bookings (read for business + customer; create/cancel come in Phase 2)
 */

import { supabase } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BookService {
  id:               string;
  business_id:      string;
  name:             string;
  description:      string | null;
  duration_minutes: number;
  buffer_minutes:   number;
  price_pence:      number;       // 0 = price on request
  deposit_pence:    number;
  requires_deposit: boolean;
  category:         string | null;
  display_order:    number;
  is_active:        boolean;
  capacity:         number;       // simultaneous bookings the service supports (default 1)
  created_at:       string;
}

export interface BookAvailabilityRule {
  id:                     string;
  business_id:            string;
  service_id:             string | null;  // null = applies to all services
  day_of_week:            number;         // 0 = Sun, 6 = Sat
  start_time:             string;         // 'HH:MM:SS'
  end_time:               string;
  slot_interval_minutes:  number;
  is_active:              boolean;
  created_at:             string;
}

export type BookOverrideType = 'open' | 'closed' | 'last_min';

export interface BookSlotOverride {
  id:          string;
  business_id: string;
  service_id:  string | null;
  starts_at:   string;
  ends_at:     string;
  type:        BookOverrideType;
  notes:       string | null;
  created_at:  string;
}

export type BookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'no_show' | 'completed';

export interface BookBooking {
  id:                          string;
  business_id:                 string;
  service_id:                  string;
  customer_id:                 string;
  starts_at:                   string;
  ends_at:                     string;
  status:                      BookingStatus;
  price_pence:                 number;
  deposit_pence:               number;
  deposit_payment_intent_id:   string | null;
  deposit_paid_at:             string | null;
  cancelled_at:                string | null;
  cancelled_by:                string | null;
  notes:                       string | null;
  created_at:                  string;

  // Optional joined data
  service?:  Pick<BookService, 'name' | 'duration_minutes' | 'price_pence'> | null;
  customer?: { full_name: string | null } | null;
  business?: { id: string; name: string; logo_url: string | null; address: string | null; phone: string | null } | null;
}

// ── Days / formatting helpers ────────────────────────────────────────────────

export const DAYS_OF_WEEK = [
  { idx: 0, short: 'Sun', long: 'Sunday'    },
  { idx: 1, short: 'Mon', long: 'Monday'    },
  { idx: 2, short: 'Tue', long: 'Tuesday'   },
  { idx: 3, short: 'Wed', long: 'Wednesday' },
  { idx: 4, short: 'Thu', long: 'Thursday'  },
  { idx: 5, short: 'Fri', long: 'Friday'    },
  { idx: 6, short: 'Sat', long: 'Saturday'  },
] as const;

/** "09:00" or "09:30" — strips seconds and any TZ junk. */
export function formatTime(t: string): string {
  return t.slice(0, 5);
}

/** £25.00 / £0.00 / "Price on request" */
export function formatPence(pence: number): string {
  if (pence === 0) return 'Price on request';
  return `£${(pence / 100).toFixed(2)}`;
}

/** "1h 30m" / "45m" / "2h" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ── Services ─────────────────────────────────────────────────────────────────

export async function fetchBusinessServices(
  businessId: string,
  includeInactive = false,
): Promise<BookService[]> {
  let q = supabase
    .from('book_services')
    .select('*')
    .eq('business_id', businessId)
    .order('display_order', { ascending: true })
    .order('created_at',    { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as BookService[];
}

export type ServiceUpsertInput = Partial<Omit<BookService, 'id' | 'business_id' | 'created_at'>> & {
  name:             string;
  duration_minutes: number;
  price_pence:      number;
};

export async function createService(
  businessId: string,
  input: ServiceUpsertInput,
): Promise<BookService> {
  const { data, error } = await supabase
    .from('book_services')
    .insert({ business_id: businessId, ...input })
    .select()
    .single();
  if (error) throw error;
  return data as BookService;
}

export async function updateService(
  id: string,
  patch: Partial<ServiceUpsertInput>,
): Promise<void> {
  const { error } = await supabase
    .from('book_services')
    .update(patch)
    .eq('id', id);
  if (error) throw error;
}

export async function deleteService(id: string): Promise<void> {
  // Soft-delete: just deactivate. Real delete would orphan historical bookings.
  const { error } = await supabase
    .from('book_services')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
}

// ── Availability rules ───────────────────────────────────────────────────────

export async function fetchAvailabilityRules(
  businessId: string,
): Promise<BookAvailabilityRule[]> {
  const { data, error } = await supabase
    .from('book_availability_rules')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('day_of_week', { ascending: true })
    .order('start_time',  { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookAvailabilityRule[];
}

export type AvailabilityRuleInput = {
  service_id?:            string | null;
  day_of_week:            number;
  start_time:             string;   // 'HH:MM'
  end_time:               string;
  slot_interval_minutes?: number;
};

export async function createAvailabilityRule(
  businessId: string,
  input: AvailabilityRuleInput,
): Promise<BookAvailabilityRule> {
  const { data, error } = await supabase
    .from('book_availability_rules')
    .insert({
      business_id:           businessId,
      service_id:            input.service_id ?? null,
      day_of_week:           input.day_of_week,
      start_time:            input.start_time,
      end_time:              input.end_time,
      slot_interval_minutes: input.slot_interval_minutes ?? 30,
    })
    .select()
    .single();
  if (error) throw error;
  return data as BookAvailabilityRule;
}

export async function deleteAvailabilityRule(id: string): Promise<void> {
  const { error } = await supabase
    .from('book_availability_rules')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
}

// ── Slot overrides ───────────────────────────────────────────────────────────

export async function fetchUpcomingOverrides(
  businessId: string,
  fromIso?: string,
): Promise<BookSlotOverride[]> {
  const from = fromIso ?? new Date().toISOString();
  const { data, error } = await supabase
    .from('book_slot_overrides')
    .select('*')
    .eq('business_id', businessId)
    .gte('starts_at', from)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookSlotOverride[];
}

export type OverrideInput = {
  service_id?: string | null;
  starts_at:   string;
  ends_at:     string;
  type:        BookOverrideType;
  notes?:      string | null;
};

export async function createOverride(
  businessId: string,
  input: OverrideInput,
): Promise<BookSlotOverride> {
  const { data, error } = await supabase
    .from('book_slot_overrides')
    .insert({
      business_id: businessId,
      service_id:  input.service_id ?? null,
      starts_at:   input.starts_at,
      ends_at:     input.ends_at,
      type:        input.type,
      notes:       input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as BookSlotOverride;
}

export async function deleteOverride(id: string): Promise<void> {
  const { error } = await supabase
    .from('book_slot_overrides')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Bookings (read-only in Phase 1) ──────────────────────────────────────────

/** All upcoming + recent bookings for one business (for the owner dashboard). */
export async function fetchBusinessBookings(
  businessId: string,
  fromIso?: string,
): Promise<BookBooking[]> {
  const from = fromIso ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('book_bookings')
    .select(`
      *,
      service:book_services ( name, duration_minutes, price_pence ),
      customer:profiles!book_bookings_customer_id_fkey ( full_name )
    `)
    .eq('business_id', businessId)
    .gte('starts_at', from)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BookBooking[];
}

/** A customer's own bookings (for "My bookings" in Phase 2). */
export async function fetchMyBookings(userId: string): Promise<BookBooking[]> {
  const { data, error } = await supabase
    .from('book_bookings')
    .select(`
      *,
      service:book_services ( name, duration_minutes, price_pence ),
      business:local_businesses ( id, name, logo_url, address, phone )
    `)
    .eq('customer_id', userId)
    .order('starts_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as BookBooking[];
}

// ── Create / cancel bookings ─────────────────────────────────────────────────

export interface CreateBookingInput {
  businessId: string;
  serviceId:  string;
  customerId: string;
  startsAt:   string;        // ISO
  endsAt:     string;        // ISO
  pricePence:    number;     // snapshot
  depositPence:  number;     // snapshot (0 if no deposit)
  notes?:        string | null;
  status?:       BookingStatus;   // default 'confirmed' (Phase 3 will set 'pending_payment')
  giftId?:       string | null;   // set when this booking was paid via a gift
}

/**
 * Public booking-load — non-PII slot data so the customer-facing booking
 * screen can show which slots are taken / full without leaking customer names.
 * Backed by the get_public_booking_load() SECURITY DEFINER function.
 */
export async function fetchPublicBookings(
  businessId: string,
  fromIso?: string,
  toIso?: string,
): Promise<BookBooking[]> {
  const { data, error } = await supabase.rpc('get_public_booking_load', {
    p_business_id: businessId,
    p_from:        fromIso ?? null,
    p_to:          toIso   ?? null,
  });
  if (error) {
    console.warn('[fetchPublicBookings] failed:', error.message);
    return [];
  }
  // Map to BookBooking shape (PII fields stay undefined — slot engine only
  // reads service_id / starts_at / ends_at / status).
  return (data ?? []).map((r: any): BookBooking => ({
    id:                          r.id,
    business_id:                 businessId,
    service_id:                  r.service_id,
    customer_id:                 '',
    starts_at:                   r.starts_at,
    ends_at:                     r.ends_at,
    status:                      r.status as BookingStatus,
    price_pence:                 0,
    deposit_pence:               0,
    deposit_payment_intent_id:   null,
    deposit_paid_at:             null,
    cancelled_at:                null,
    cancelled_by:                null,
    notes:                       null,
    created_at:                  '',
  }));
}

/**
 * Check whether a slot has capacity for one more booking.
 * Capacity-aware: services with capacity > 1 allow multiple simultaneous bookings.
 * There's a tiny race window between this check and the insert — Phase 3 will
 * tighten this with a DB-level exclusion constraint or a transaction.
 */
export async function isSlotAvailable(
  businessId: string,
  serviceId:  string,
  startsAt:   string,
  endsAt:     string,
): Promise<boolean> {
  // Fetch the service's capacity (defaults to 1 if missing)
  const { data: svc, error: svcErr } = await supabase
    .from('book_services')
    .select('capacity')
    .eq('id', serviceId)
    .maybeSingle();
  if (svcErr) throw svcErr;
  const capacity = svc?.capacity ?? 1;

  // Count overlapping bookings for THIS service
  const { count, error } = await supabase
    .from('book_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('service_id',  serviceId)
    .in('status', ['confirmed', 'pending_payment'])
    .lt('starts_at', endsAt)
    .gt('ends_at',   startsAt);
  if (error) throw error;
  return (count ?? 0) < capacity;
}

export async function createBooking(input: CreateBookingInput): Promise<BookBooking> {
  const free = await isSlotAvailable(input.businessId, input.serviceId, input.startsAt, input.endsAt);
  if (!free) {
    throw new Error('Sorry — that slot is now full. Please pick another.');
  }
  const { data, error } = await supabase
    .from('book_bookings')
    .insert({
      business_id:   input.businessId,
      service_id:    input.serviceId,
      customer_id:   input.customerId,
      starts_at:     input.startsAt,
      ends_at:       input.endsAt,
      price_pence:   input.pricePence,
      deposit_pence: input.depositPence,
      notes:         input.notes ?? null,
      status:        input.status ?? 'confirmed',
      gift_id:       input.giftId ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  // If this booking was paid by a gift, mark the gift as used.
  if (input.giftId) {
    await supabase
      .from('book_gifts')
      .update({ status: 'used', used_at: new Date().toISOString() })
      .eq('id', input.giftId);
  }

  return data as BookBooking;
}

export async function cancelBooking(id: string, byUserId: string): Promise<void> {
  const { error } = await supabase
    .from('book_bookings')
    .update({
      status:       'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: byUserId,
    })
    .eq('id', id);
  if (error) throw error;
}

/** Owner action: mark a booking complete or no-show. */
export async function updateBookingStatus(
  id: string,
  status: BookingStatus,
): Promise<void> {
  const { error } = await supabase
    .from('book_bookings')
    .update({ status })
    .eq('id', id);
  if (error) throw error;
}

// ── Business-level booking flag ──────────────────────────────────────────────

/**
 * Single source of truth for "is this business actually live for bookings?"
 * Bookings are gated behind the Premium subscription tier — even if a business
 * flips accepts_bookings on, customers shouldn't see them as bookable unless
 * their subscription is currently Premium.
 */
export function isBookableLive(b: {
  accepts_bookings?: boolean | null;
  subscription_tier?: 'free' | 'pro' | 'premium' | null;
  is_active?: boolean | null;
}): boolean {
  return Boolean(b.accepts_bookings) && b.subscription_tier === 'premium' && b.is_active !== false;
}


export async function setAcceptsBookings(
  businessId: string,
  value: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('local_businesses')
    .update({ accepts_bookings: value })
    .eq('id', businessId);
  if (error) throw error;
}

// ── Unit items (non-time-based things a business sells) ──────────────────────
//
// Tickets, class packs, day passes, gift vouchers. Optional finite stock,
// optional expiry from purchase, optional multi-use (uses_per_purchase > 1
// covers things like 10-class packs).

export interface BookUnitItem {
  id:                string;
  business_id:       string;
  name:              string;
  description:       string | null;
  price_pence:       number;
  stock:             number | null;     // null = unlimited
  valid_days:        number | null;     // null = never expires
  uses_per_purchase: number;            // default 1
  image_url:         string | null;
  category:          string | null;
  display_order:     number;
  is_active:         boolean;
  created_at:        string;
  updated_at:        string;
}

export async function fetchBusinessUnitItems(
  businessId: string,
  includeInactive = false,
): Promise<BookUnitItem[]> {
  let q = supabase
    .from('book_unit_items')
    .select('*')
    .eq('business_id', businessId)
    .order('display_order', { ascending: true })
    .order('created_at',    { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as BookUnitItem[];
}

export interface UnitItemWithBusiness extends BookUnitItem {
  business_name?: string | null;
}

/**
 * Active, in-stock unit items across all businesses — for the Marketplace feed.
 * Sold-out items (stock === 0) are filtered out; unlimited (stock null) stay.
 */
export async function fetchActiveUnitItems(limit = 12): Promise<UnitItemWithBusiness[]> {
  const { data, error } = await supabase
    .from('book_unit_items')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const available = (data ?? []).filter((i: any) => i.stock === null || i.stock > 0) as BookUnitItem[];
  const bizIds = [...new Set(available.map(i => i.business_id))];
  if (bizIds.length === 0) return available;

  const { data: biz } = await supabase
    .from('local_businesses')
    .select('id, name')
    .in('id', bizIds);
  const nameMap = Object.fromEntries((biz ?? []).map(b => [b.id, b.name]));
  return available.map(i => ({ ...i, business_name: nameMap[i.business_id] ?? null }));
}

export type UnitItemUpsertInput = Partial<Omit<BookUnitItem, 'id' | 'business_id' | 'created_at' | 'updated_at'>> & {
  name:        string;
  price_pence: number;
};

export async function createUnitItem(
  businessId: string,
  input: UnitItemUpsertInput,
): Promise<BookUnitItem> {
  const { data, error } = await supabase
    .from('book_unit_items')
    .insert({ business_id: businessId, ...input })
    .select()
    .single();
  if (error) throw error;
  return data as BookUnitItem;
}

export async function updateUnitItem(
  id: string,
  patch: Partial<UnitItemUpsertInput>,
): Promise<void> {
  const { error } = await supabase
    .from('book_unit_items')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteUnitItem(id: string): Promise<void> {
  // Soft-delete — preserves history on book_unit_purchases.
  const { error } = await supabase
    .from('book_unit_items')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
}

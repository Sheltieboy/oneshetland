/**
 * events-api.ts
 * All Supabase calls and helpers for the OneShetland Events module.
 */

import { uploadAsync as fsUploadAsync } from 'expo-file-system/legacy';
import { supabase, SUPABASE_URL } from './supabase';
import { settleSavedCardPayment, type PaymentStart } from './stripe-sca';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventStatus = 'draft' | 'published' | 'cancelled' | 'postponed' | 'archived';
export type TicketStatus = 'pending_payment' | 'valid' | 'used' | 'cancelled' | 'refunded';
export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';
export type UpdateKind = 'info' | 'urgent' | 'cancellation' | 'venue_change' | 'time_change' | 'weather' | 'entry_info';
export type CheckinResult = 'valid' | 'already_used' | 'wrong_event' | 'cancelled' | 'refunded' | 'not_found' | 'payment_incomplete' | 'invalid_token';

export const EVENT_CATEGORIES = [
  'Music', 'Arts & Culture', 'Market', 'Community', 'Outdoors', 'Sport',
  'Family', 'Food & Drink', 'Charity', 'Business', 'Festival', 'Other',
] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];

export const AGE_RESTRICTIONS = ['All ages', '12+', '16+', '18+', 'Under 18 only'] as const;

export type HubEventVisibility = 'members' | 'hub' | 'islands';

export interface OsEvent {
  /** Effective payout readiness for the organiser — resolved server-side in fetchEvent. */
  payout_ready?: boolean;
  id:                  string;
  organiser_user_id:   string | null;
  organiser_business_id: string | null;
  organiser_hub_id:    string | null;
  hub_visibility:      HubEventVisibility | null;
  calendar_approved:   boolean;
  title:               string;
  description:         string | null;
  category:            string | null;
  status:              EventStatus;
  venue:               string | null;
  locality:            string | null;
  lat:                 number | null;
  lng:                 number | null;
  place_id:            string | null;
  formatted_address:   string | null;
  starts_at:           string;
  ends_at:             string | null;
  doors_open_at:       string | null;
  capacity:            number | null;
  tickets_sold:        number;
  has_tickets:         boolean;
  cover_url:           string | null;
  gallery_urls:        string[];
  video_url:           string | null;
  price_text:          string | null;
  ticket_url:          string | null;
  accessibility_info:  string | null;
  age_restriction:     string | null;
  refund_policy:       string | null;
  contact_info:        string | null;
  event_notes:         string | null;
  is_featured:         boolean;
  is_hidden:           boolean;
  updated_at:          string;
  created_at:          string;
  // Optional joins
  business?:           { id: string; name: string; logo_url: string | null } | null;
  hub?:                { id: string; name: string; logo_url: string | null; brand_color: string | null } | null;
  ticket_types?:       EventTicketType[];
  updates?:            EventUpdate[];
}

export interface EventTicketType {
  id:                       string;
  event_id:                 string;
  name:                     string;
  description:              string | null;
  price_pence:              number;
  quantity_available:       number | null;
  quantity_sold:            number;
  per_order_max:            number;
  sale_starts_at:           string | null;
  sale_ends_at:             string | null;
  is_active:                boolean;
  requires_attendee_details: boolean;
  display_order:            number;
  created_at:               string;
  // computed
  remaining?:               number | null;
  on_sale?:                 boolean;
}

export interface EventTicketOrder {
  id:                       string;
  event_id:                 string;
  buyer_id:                 string;
  stripe_payment_intent_id: string | null;
  status:                   OrderStatus;
  total_pence:              number;
  tickets_count:            number;
  created_at:               string;
  paid_at:                  string | null;
  // Joins
  event?:                   Pick<OsEvent, 'id' | 'title' | 'starts_at' | 'venue' | 'cover_url'> | null;
}

export interface EventTicket {
  id:            string;
  order_id:      string;
  event_id:      string;
  ticket_type_id: string;
  holder_id:     string;
  backup_code:   string;
  status:        TicketStatus;
  attendee_name: string | null;
  attendee_email: string | null;
  price_pence:   number;
  event_snapshot: {
    title:     string;
    starts_at: string;
    venue:     string | null;
    formatted_address: string | null;
  };
  checked_in_at:  string | null;
  created_at:     string;
  // Joins
  ticket_type?:   Pick<EventTicketType, 'id' | 'name' | 'price_pence'> | null;
  event?:         Pick<OsEvent, 'id' | 'title' | 'starts_at' | 'venue' | 'cover_url' | 'status'> | null;
  business?:      { id: string; name: string; logo_url: string | null } | null;
  // In-memory only — never stored
  raw_token?:     string;
}

export interface EventUpdate {
  id:         string;
  event_id:   string;
  author_id:  string;
  title:      string;
  body:       string;
  kind:       UpdateKind;
  is_urgent:  boolean;
  created_at: string;
}

export interface ScannerStats {
  tickets_sold:    number;
  checked_in:      number;
  pending_payment: number;
}

export type LineItem = {
  ticket_type_id: string;
  quantity:       number;
  attendee_name?: string;
  attendee_email?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatEventDate(starts_at: string, ends_at?: string | null): string {
  const s = new Date(starts_at);
  const sDate = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const sTime = s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (!ends_at) return `${sDate} · ${sTime}`;
  const e = new Date(ends_at);
  const eTime = e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay = s.toDateString() === e.toDateString();
  return sameDay ? `${sDate} · ${sTime}–${eTime}` : `${sDate} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ticketTypeOnSale(tt: EventTicketType): boolean {
  const now = new Date().toISOString();
  if (!tt.is_active) return false;
  if (tt.sale_starts_at && tt.sale_starts_at > now) return false;
  if (tt.sale_ends_at && tt.sale_ends_at < now) return false;
  if (tt.quantity_available !== null && tt.quantity_sold >= tt.quantity_available) return false;
  return true;
}

export function ticketTypeRemaining(tt: EventTicketType): number | null {
  if (tt.quantity_available === null) return null;
  return Math.max(0, tt.quantity_available - tt.quantity_sold);
}

/**
 * Does this event have at least one active, free ticket type? A mixed
 * free+paid event whose organiser is not payout-ready still has something
 * genuinely obtainable — the buy flow must stay reachable, not be hidden
 * behind "Tickets coming soon" the way a wholly-paid event correctly is.
 * Mirrors the server's own all_free computation (see
 * _event_payout_resolve in supabase/migrations/20260822120000_effective_event_payout.sql)
 * at the opposite extreme: that asks "are ALL active types free"; this asks
 * "is ANY active type free".
 */
export function eventHasFreeActiveTicket(types: EventTicketType[]): boolean {
  return types.some(t => t.is_active && t.price_pence === 0);
}

/**
 * Does this event have at least one active ticket type priced above zero?
 * The saved-event counterpart to event-create.tsx's own inline paid-draft
 * check (which additionally filters on a non-blank name, since that screen
 * works from in-progress draft rows before they're saved — a fully saved
 * event's ticket_types never have that concern, so this is the plain rule).
 * Used to decide whether Event Manage's publish action needs a payout
 * route at all.
 */
export function eventHasActivePaidTicket(types: EventTicketType[]): boolean {
  return types.some(t => t.is_active && t.price_pence > 0);
}

/**
 * Can THIS ticket type actually be bought right now, payout-wise? A free
 * type never needs a payout route. A paid type needs the event's resolved
 * payout_ready — the one place per-ticket-type gating and event-level
 * payout readiness meet; nowhere else re-derives readiness itself.
 */
export function ticketTypePurchasable(tt: EventTicketType, eventPayoutReady: boolean): boolean {
  return eventPayoutReady || tt.price_pence === 0;
}

export interface EventScarcity {
  measurable: boolean;
  totalCap:   number;
  totalSold:  number;
  remaining:  number;
  pctSold:    number;   // 0..100
  soldOut:    boolean;
  sellingFast: boolean; // ≥65% sold
  almostGone:  boolean; // capped allocation nearly gone
}

/**
 * Aggregate scarcity across an event's capped, active ticket types. Uncapped
 * tiers are ignored (can't measure "% gone" without a cap). Honest data only.
 * Mirrors the web computeScarcity().
 */
export function computeScarcity(ticketTypes: EventTicketType[]): EventScarcity {
  const none: EventScarcity = {
    measurable: false, totalCap: 0, totalSold: 0, remaining: 0,
    pctSold: 0, soldOut: false, sellingFast: false, almostGone: false,
  };
  const capped = ticketTypes.filter(t => t.is_active && t.quantity_available !== null);
  if (capped.length === 0) return none;
  const totalCap = capped.reduce((n, t) => n + (t.quantity_available ?? 0), 0);
  const totalSold = capped.reduce((n, t) => n + Math.min(t.quantity_sold, t.quantity_available ?? 0), 0);
  if (totalCap <= 0) return none;
  const remaining = Math.max(0, totalCap - totalSold);
  const pctSold = Math.round((totalSold / totalCap) * 100);
  return {
    measurable: true,
    totalCap, totalSold, remaining, pctSold,
    soldOut: remaining === 0,
    sellingFast: pctSold >= 65 && remaining > 0,
    almostGone: remaining > 0 && remaining <= 10,
  };
}

export interface EventSocialStats {
  goingCount:   number; // valid + used tickets
  bookedRecent: number; // booked in last 24h
}

/** Public aggregate stats (counts only, no PII) via the get_event_social_stats RPC. */
export async function fetchEventSocialStats(eventId: string): Promise<EventSocialStats> {
  const { data, error } = await supabase.rpc('get_event_social_stats', { p_event_id: eventId });
  if (error || !data) return { goingCount: 0, bookedRecent: 0 };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    goingCount:   Number(row?.going_count ?? 0),
    bookedRecent: Number(row?.booked_recent ?? 0),
  };
}

export function eventSoldOut(event: OsEvent): boolean {
  if (!event.has_tickets) return false;
  if (event.capacity === null) return false;
  return event.tickets_sold >= event.capacity;
}

export function lowestTicketPrice(types: EventTicketType[]): number | null {
  const active = types.filter(t => t.is_active && t.price_pence > 0);
  if (active.length === 0) return null;
  return Math.min(...active.map(t => t.price_pence));
}

// True when a customer can actually get in for nothing: at least one ticket
// type that is on sale costs £0. Mixed free+paid events count — the free ticket
// is real, so "From £1.00" would have been a lie. Inactive types are ignored,
// which is the same rule lowestTicketPrice() applies.
export function isFreeEvent(types: EventTicketType[]): boolean {
  const active = types.filter(t => t.is_active);
  return active.length > 0 && active.some(t => t.price_pence === 0);
}

/**
 * The one place the price label shown on every public surface (What's On
 * cards, the event detail CTA) is derived, so the three call sites that used
 * to each re-run the same "free or from £X" ternary can't drift from one
 * another or from the Free-only filter.
 *
 * Built entirely from the two existing predicates rather than a third pass
 * over `types`: hasFree is isFreeEvent() itself (at least one active ticket
 * costs nothing — the same fact the Free-only filter reads), and hasPaid is
 * lowestTicketPrice() !== null (that helper already answers "is there an
 * active ticket priced above zero"; asking with a second, separately
 * written filter would be the duplication this function exists to remove).
 *
 * Free and paid are not exclusive — a mixed event has both, and saying only
 * "Free" would hide that some tickets cost money, while "From £1.00" was the
 * original bug: a genuinely free ticket priced out of the label entirely.
 */
export function eventPriceLabel(types: EventTicketType[]): string | null {
  const hasFree = isFreeEvent(types);
  const cheapestPaid = lowestTicketPrice(types);
  const hasPaid = cheapestPaid !== null;
  if (hasFree && hasPaid) return 'Free + paid tickets';
  if (hasFree) return 'Free';
  if (hasPaid) return `From £${(cheapestPaid / 100).toFixed(2)}`;
  return null;
}

export const UPDATE_KIND_LABELS: Record<UpdateKind, string> = {
  info:         'Update',
  urgent:       'Urgent',
  cancellation: 'Cancelled',
  venue_change: 'Venue changed',
  time_change:  'Time changed',
  weather:      'Weather notice',
  entry_info:   'Entry info',
};

// ── Events CRUD ───────────────────────────────────────────────────────────────

export async function fetchPublishedEvents(opts: {
  category?: string;
  businessId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<OsEvent[]> {
  let q = supabase
    .from('events')
    .select('*, business:local_businesses(id,name,logo_url), hub:hubs(id,name,logo_url,brand_color)')
    .eq('status', 'published')
    // Hub events only reach the islands-wide calendar once approved; non-hub
    // events (organiser_hub_id null) are governed by status alone.
    .or('organiser_hub_id.is.null,calendar_approved.eq.true')
    .order('starts_at', { ascending: true });

  const now = new Date().toISOString();
  q = q.gte('starts_at', opts.from ?? now);
  if (opts.to)         q = q.lte('starts_at', opts.to);
  if (opts.category)   q = q.eq('category', opts.category);
  if (opts.businessId) q = q.eq('organiser_business_id', opts.businessId);
  if (opts.limit)      q = q.limit(opts.limit);
  if (opts.offset)     q = q.range(opts.offset, (opts.offset + (opts.limit ?? 20)) - 1);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as OsEvent[];
}

export async function fetchEvent(id: string): Promise<OsEvent | null> {
  const { data, error } = await supabase
    .from('events')
    .select(`
      *,
      business:local_businesses(id,name,logo_url,payout_enabled),
      ticket_types:event_ticket_types(*),
      updates:event_updates(*)
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Sort embedded arrays client-side (PostgREST select syntax doesn't accept ORDER BY)
  const ev = data as any;
  if (Array.isArray(ev.ticket_types)) {
    ev.ticket_types.sort((a: any, b: any) =>
      (a.display_order ?? 0) - (b.display_order ?? 0) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }
  if (Array.isArray(ev.updates)) {
    ev.updates.sort((a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }
  // Can this organiser actually be paid?
  //
  // The screen used to answer that with `event.business.payout_enabled`, which
  // asks only whether the BUSINESS has its own Stripe account. A business
  // inherits its owner's central card and bank unless it is explicitly given
  // its own, so an organiser who could perfectly well take money still saw
  // "Tickets coming soon".
  //
  // It cannot be worked out here either: profiles RLS is own-row-only, so a
  // BUYER cannot read the organiser's payout state at all. event_payout_ready
  // is a SECURITY DEFINER function that can, and returns one boolean — no
  // Stripe identifier reaches the client. It is the same resolver
  // create-event-ticket-intent uses to choose the destination, so the button
  // and the charge cannot disagree.
  const { data: ready } = await supabase.rpc('event_payout_ready', { p_event_id: id });
  ev.payout_ready = ready === true;

  return ev as OsEvent;
}

export async function fetchBusinessEvents(businessId: string): Promise<OsEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('organiser_business_id', businessId)
    .order('starts_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OsEvent[];
}

/**
 * Every event this business organises, for the Events management list
 * (app/business-events.tsx) — deliberately a SEPARATE query from
 * fetchBusinessEvents above, not an extension of it: that one has exactly
 * one call site (the dashboard's bizEvents/bizEventsRaw/nextBizEvent
 * pipeline) and its own doc comment says it is left untouched. This embeds
 * ticket_types, which that one does not, so the management list can decide
 * per draft whether it has an active paid ticket without a second query.
 */
export async function fetchBusinessEventsForManagement(businessId: string): Promise<OsEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*, ticket_types:event_ticket_types(*)')
    .eq('organiser_business_id', businessId)
    .order('starts_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OsEvent[];
}

export interface ManagedEventGroups<T> {
  drafts:   T[];
  upcoming: T[];
  past:     T[];
}

/**
 * Groups a business's events for the management list: drafts/needs-attention
 * first, then upcoming published, then past/cancelled — the same three
 * buckets on both platforms (see oneshetland-web's lib/events-manage.ts).
 *
 * The 6-hour grace window on "upcoming" mirrors the web events list's
 * existing upcoming/past split — an event that started minutes ago is still
 * genuinely upcoming for a merchant glancing at this list, not yet history.
 * This is a different, simpler question than lib/business-next-event.ts's
 * "which one event is most relevant right now" (which reads ends_at and the
 * event's own calendar day) — this just buckets a whole list for browsing,
 * and does not replace or feed that selection.
 *
 * A cancelled, postponed or archived event — and a published one whose date
 * has passed the grace window — all land in `past`, never hidden: "do not
 * hide historic events simply because they are no longer upcoming."
 */
export function groupEventsForManagement<T extends { status: EventStatus; starts_at: string }>(
  events: readonly T[],
  now: Date = new Date(),
): ManagedEventGroups<T> {
  const nowMs = now.getTime();
  const UPCOMING_GRACE_MS = 6 * 3600_000;
  const drafts: T[] = [];
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const e of events) {
    if (e.status === 'draft') { drafts.push(e); continue; }
    if (e.status === 'published' && new Date(e.starts_at).getTime() >= nowMs - UPCOMING_GRACE_MS) {
      upcoming.push(e);
      continue;
    }
    past.push(e);
  }
  const byStartAsc  = (a: T, b: T) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  const byStartDesc = (a: T, b: T) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime();
  drafts.sort(byStartAsc);
  upcoming.sort(byStartAsc);
  past.sort(byStartDesc);
  return { drafts, upcoming, past };
}

/**
 * Events organised by a hub. Admins (the hub's own page) get every event
 * including drafts/members tiers — RLS already permits that for hub admins;
 * non-admin viewers only get the rows RLS exposes (public/hub tiers, or
 * members tiers if they're a member).
 */
export async function fetchHubEvents(hubId: string): Promise<OsEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('organiser_hub_id', hubId)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OsEvent[];
}

/**
 * Platform-admin approval of an unverified hub's islands-wide event. Stamps the
 * approver; the events trigger validates the caller is an admin and flips
 * calendar_approved on.
 */
export async function approveHubEvent(eventId: string, adminId: string): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({ calendar_approved_by: adminId })
    .eq('id', eventId);
  if (error) throw error;
}

/** Events awaiting calendar approval (unverified hubs going islands-wide). */
export async function fetchPendingHubEvents(): Promise<OsEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*, hub:hubs(id,name,logo_url,brand_color,is_verified)')
    .not('organiser_hub_id', 'is', null)
    .eq('hub_visibility', 'islands')
    .eq('calendar_approved', false)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as OsEvent[];
}

export interface EventUpsertInput {
  organiser_business_id?: string;
  organiser_hub_id?:    string;
  hub_visibility?:      HubEventVisibility;
  title:                string;
  description?:         string | null;
  category?:            string | null;
  status?:              EventStatus;
  venue?:               string | null;
  locality?:            string | null;
  lat?:                 number | null;
  lng?:                 number | null;
  place_id?:            string | null;
  formatted_address?:   string | null;
  starts_at:            string;
  ends_at?:             string | null;
  doors_open_at?:       string | null;
  capacity?:            number | null;
  has_tickets?:         boolean;
  cover_url?:           string | null;
  gallery_urls?:        string[];
  video_url?:           string | null;
  price_text?:          string | null;
  ticket_url?:          string | null;
  accessibility_info?:  string | null;
  age_restriction?:     string | null;
  refund_policy?:       string | null;
  contact_info?:        string | null;
  event_notes?:         string | null;
}

export async function createEvent(userId: string, input: EventUpsertInput): Promise<OsEvent> {
  const { data, error } = await supabase
    .from('events')
    .insert({ organiser_user_id: userId, ...input })
    .select('*')
    .single();
  if (error) throw error;

  // If this is a published HUB event, tell the hub's members (fire-and-forget).
  const ev = data as OsEvent;
  if (ev.organiser_hub_id && ev.status === 'published') {
    supabase.functions
      .invoke('notify-hub-content', { body: { event: 'event', hub_id: ev.organiser_hub_id, ref_id: ev.id, title: ev.title } })
      .catch(() => {});
  }

  return ev;
}

export async function updateEvent(
  id: string,
  patch: Partial<EventUpsertInput & { status: EventStatus; calendar_approved_by: string }>,
): Promise<void> {
  const { error } = await supabase.from('events').update(patch).eq('id', id);
  if (error) throw error;
}

// ── Ticket types ──────────────────────────────────────────────────────────────

export async function upsertTicketType(input: Partial<EventTicketType> & { event_id: string; name: string; price_pence: number }): Promise<EventTicketType> {
  const { id, ...rest } = input;
  const { data, error } = id
    ? await supabase.from('event_ticket_types').update(rest).eq('id', id).select('*').single()
    : await supabase.from('event_ticket_types').insert(rest).select('*').single();
  if (error) throw error;
  return data as EventTicketType;
}

export async function deleteTicketType(id: string): Promise<void> {
  const { error } = await supabase.from('event_ticket_types').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

// ── My tickets (wallet) ───────────────────────────────────────────────────────

export async function fetchMyEventTickets(userId: string): Promise<EventTicket[]> {
  const { data, error } = await supabase
    .from('event_tickets')
    .select(`
      *,
      ticket_type:event_ticket_types(id, name, price_pence),
      event:events(id, title, starts_at, venue, cover_url, status),
      business:events(business:local_businesses(id, name, logo_url))
    `)
    .eq('holder_id', userId)
    // Only PAID tickets ('valid'/'used'). 'pending_payment' rows are created the
    // moment checkout starts, so including them showed tickets to a customer who
    // backed out before paying.
    .in('status', ['valid', 'used'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any[];
}

export async function fetchMyUpcomingEventTickets(userId: string): Promise<EventTicket[]> {
  const { data, error } = await supabase
    .from('event_tickets')
    .select(`
      *,
      ticket_type:event_ticket_types(id, name, price_pence),
      event:events(id, title, starts_at, venue, cover_url, status)
    `)
    .eq('holder_id', userId)
    .eq('status', 'valid')
    .gte('event.starts_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as any[];
}

export async function fetchTicketWithToken(ticketId: string): Promise<EventTicket | null> {
  const { data, error } = await supabase
    .from('event_tickets')
    .select(`
      *,
      ticket_type:event_ticket_types(id, name, price_pence),
      event:events(id, title, starts_at, venue, formatted_address, cover_url, status, organiser_business_id),
      business:events(organiser_business_id, business:local_businesses(id, name, logo_url))
    `)
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as EventTicket | null;
}

// ── Event updates ─────────────────────────────────────────────────────────────

export async function postEventUpdate(input: {
  event_id:  string;
  author_id: string;
  title:     string;
  body:      string;
  kind:      UpdateKind;
  is_urgent?: boolean;
}): Promise<EventUpdate> {
  const { data, error } = await supabase
    .from('event_updates')
    .insert(input)
    .select('*')
    .single();
  if (error) throw error;

  // Tell every ticket-holder about the update (cancellations/changes urgent).
  supabase.functions
    .invoke('notify-event-update', { body: { update_id: (data as EventUpdate).id } })
    .catch(() => {});

  return data as EventUpdate;
}

// ── Scanner stats ─────────────────────────────────────────────────────────────

export async function fetchScannerStats(eventId: string): Promise<ScannerStats> {
  const { data, error } = await supabase.rpc('get_event_scanner_stats', { p_event_id: eventId });
  if (error) throw error;
  return (data as ScannerStats) ?? { tickets_sold: 0, checked_in: 0, pending_payment: 0 };
}

// ── Business event ticket sales ───────────────────────────────────────────────

export async function fetchEventOrders(eventId: string): Promise<EventTicketOrder[]> {
  const { data, error } = await supabase
    .from('event_ticket_orders')
    .select('*')
    .eq('event_id', eventId)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EventTicketOrder[];
}

// ── Ticket purchase (client-side orchestration) ────────────────────────────────

export async function purchaseTickets(params: {
  event_id:       string;
  line_items:     LineItem[];
  use_saved_card?: boolean;
  pay_with_wallet?: boolean;
  /**
   * One id per logical checkout, minted by the SCREEN (see
   * lib/checkout-attempt.ts) and reused across retries of that same checkout.
   * Deliberately not generated in here: a fresh id per HTTP call would give
   * every retry a new key and remove the protection entirely.
   */
  client_request_id?: string;
}): Promise<{
  clientSecret?: string;
  order_id:       string;
  tokens:         string[];
  ticket_ids:     string[];
  charged?:       boolean;
  free?:          boolean;
}> {
  const { data, error } = await supabase.functions.invoke('create-event-ticket-intent', { body: params });
  // Supabase wraps HTTP errors as FunctionsHttpError — the real message is in data.error
  if (data?.error) throw new Error(data.error);
  if (error) {
    // Try to extract the JSON body Supabase wraps in context
    const ctx = (error as any)?.context;
    if (ctx) {
      try {
        const body = typeof ctx === 'string' ? JSON.parse(ctx) : await ctx.json?.();
        if (body?.error) throw new Error(body.error);
      } catch (inner) {
        if ((inner as Error).message !== ctx) throw inner;
      }
    }
    throw new Error(error.message);
  }

  // A saved-card charge the issuer wants authenticated is PAUSED, not failed.
  // Finish that same PaymentIntent here so every screen sees a settled result
  // and no second intent is created. The PaymentSheet path has no `status`, so
  // it returns straight through unchanged.
  const settled = await settleSavedCardPayment(data as PaymentStart);
  if (settled.outcome === 'cancelled') throw new Error('Payment cancelled — nothing was charged.');
  if (settled.outcome === 'failed') throw new Error(settled.message);
  if (settled.outcome === 'succeeded') return { ...data, charged: true };
  return data;
}

export async function confirmTicketPurchase(params: {
  order_id:          string;
  payment_intent_id: string;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke('confirm-event-tickets', { body: params });
  if (error) {
    // invoke gives a generic non-2xx message — the real reason is in context.json().
    let msg = error.message ?? 'Could not confirm your ticket purchase.';
    try {
      const ctx = (error as any)?.context;
      if (ctx?.json) { const body = await ctx.json(); if (body?.error) msg = body.error; }
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
}

// ── Image upload ──────────────────────────────────────────────────────────────

export async function uploadEventImage(
  _businessId: string,   // kept for API compatibility; path now uses user ID
  uri:         string,
  kind:        'cover' | 'gallery',
): Promise<string> {
  const ext     = uri.split('.').pop()?.split('?')[0]?.toLowerCase() ?? 'jpg';
  const safeExt = ['jpg','jpeg','png','webp','heic','heif'].includes(ext) ? ext : 'jpg';
  const mimeType = safeExt === 'png' ? 'image/png'
                 : safeExt === 'webp' ? 'image/webp'
                 : 'image/jpeg';

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');

  // Use a dedicated event-media bucket with a simple user-ID-based path.
  // RLS check is just split_part(name,'/',1) = auth.uid() — no business
  // table lookup, nothing that can silently fail from a stale policy.
  const bucket = 'event-media';
  const path   = `${session.user.id}/events/${kind}-${Date.now()}.${safeExt}`;

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const result = await fsUploadAsync(uploadUrl, uri, {
    httpMethod: 'POST',
    uploadType: 1, // FileSystemUploadType.MULTIPART
    fieldName:  'file',
    mimeType,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'x-upsert':    'true',
    },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Image upload failed (${result.status}): ${result.body.slice(0, 200)}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

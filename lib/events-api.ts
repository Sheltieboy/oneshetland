/**
 * events-api.ts
 * All Supabase calls and helpers for the OneShetland Events module.
 */

import { uploadAsync as fsUploadAsync } from 'expo-file-system/legacy';
import { supabase, SUPABASE_URL } from './supabase';

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

export function isFreeEvent(types: EventTicketType[]): boolean {
  return types.length > 0 && types.every(t => t.price_pence === 0);
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
    .in('status', ['valid', 'used', 'pending_payment'])
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

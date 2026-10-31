/**
 * lib/concierge-api.ts
 *
 * Fetchers for the Home / Local screens. Each reads the real tables and returns an empty list when there is nothing
 * (or the request fails) — never placeholder content. A screen collapses a section that has no data.
 */

import { supabase } from './supabase';
import { todaysSpik } from './seed-content';
import type { NoticePublisher } from './notice-publisher';
import { NOTICE_PUBLISHER_COLUMNS, applyPublicNoticeFilters, attributionFor, loadPersonNames } from './notice-feed';

// ── Types ───────────────────────────────────────────────────────────────────

export interface HomeEvent {
  id:           string;
  title:        string;
  starts_at:    string;
  venue:        string | null;
  category:     string | null;
  cover_url?:   string | null;
  is_featured?: boolean;
  price_text?:  string | null;
  has_tickets?: boolean;
  source:       'db';
}
export interface HomeNotice {
  id:           string;
  severity:     'urgent' | 'community' | 'info';
  title:        string;
  body:         string;
  locality:     string | null;
  posted_at:    string;
  publisher:    string;
  source:       'db';
  /** Who posted it and how to show that (label, byline, mark, official source, destination) - see lib/notice-publisher.ts. `publisher` is its label. */
  attribution:  NoticePublisher;
  // Publisher branding (hub or business) + optional linked campaign.
  logo_url?:    string | null;
  brand_color?: string | null;
  hub_id?:      string | null;
  business_id?: string | null;
  campaign_id?: string | null;
  campaign?:    { id: string; raised_pence: number; goal_pence: number; donor_count: number; status: string } | null;
  event_id?:    string | null;
  event?:       { id: string; title: string; starts_at: string; venue: string | null; cover_url: string | null; has_tickets: boolean } | null;
}

export interface SpikDaily {
  word:    string;
  meaning: string;
  example?: string | null;
}

export interface NearbyOffer {
  business_id:     string;
  business_name:   string;
  business_lat:    number | null;
  business_lng:    number | null;
  distance_km:     number;
  offer_id:        string | null;
  offer_title:     string | null;
  offer_image_url: string | null;
  has_loyalty:     boolean;
}

// ── Events ─────────────────────────────────────────────────────────────────

export async function fetchHomeEvents(limit = 6): Promise<HomeEvent[]> {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, title, starts_at, venue, category, cover_url, is_featured, price_text, has_tickets')
      .eq('is_hidden', false)
      // Hub events only reach the islands-wide calendar once approved.
      .or('organiser_hub_id.is.null,calendar_approved.eq.true')
      .gte('starts_at', new Date().toISOString())
      .order('is_featured', { ascending: false })
      .order('starts_at',   { ascending: true })
      .limit(limit);
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({ ...r, source: 'db' as const }));
    }
  } catch { /* nothing to show */ }

  return [];
}

// ── Notices ────────────────────────────────────────────────────────────────
//
// If the viewer has a `parish` set on their profile, prioritise notices
// matching that parish, then island/region, then archipelago-wide, then
// the rest by recency. Without a parish, sort purely by recency.

export async function fetchHomeNotices(opts: {
  viewerParish?: string | null;
  limit?: number;
} = {}): Promise<HomeNotice[]> {
  const limit = opts.limit ?? 3;

  try {
    const { data, error } = await applyPublicNoticeFilters(supabase
      .from('notices')
      // broadcast_at is deliberately NOT selected: PostgREST fails the whole
      // request on an unknown column, so asking for it here would empty the
      // notices feed in the window between an app release and the migration.
      // Admins read it separately (lib/notices-broadcast).
      .select(`id, severity, title, body, locality, published_at,
               publisher_business_id, publisher_user_id, publisher_hub_id, campaign_id, event_id,
               ${NOTICE_PUBLISHER_COLUMNS},
               hub:hubs ( id, name, logo_url, brand_color ),
               business:local_businesses ( id, name, logo_url, brand_color ),
               campaign:hub_campaigns ( id, raised_pence, goal_pence, donor_count, status ),
               event:events ( id, title, starts_at, venue, cover_url, has_tickets, calendar_approved )`)
      .eq('is_hidden', false)
      .eq('visibility', 'public'))   // never surface members-only hub notices in the public feed
      // + published, started, unexpired (lib/notice-feed.ts); RLS remains the security boundary
      .order('is_pinned',    { ascending: false })
      .order('published_at', { ascending: false })
      .limit(40);

    if (!error && data && data.length > 0) {
      // Event-linked notices only belong in the islands-wide feed once their
      // event is calendar-approved — keeps members/hub-tier event notices on
      // the hub page only.
      const ranked = (data as any[]).filter(r => !r.event_id || r.event?.calendar_approved);
      if (opts.viewerParish) {
        const p = opts.viewerParish.toLowerCase().trim();
        ranked.sort((a, b) => {
          const aw = scoreLocality(a.locality, p);
          const bw = scoreLocality(b.locality, p);
          if (aw !== bw) return aw - bw;
          return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        });
      }

      const shown = ranked.slice(0, limit);
      // Person names come from the authorised attribution RPC, never from profiles.
      const personNames = await loadPersonNames((fn, args) => supabase.rpc(fn, args), shown);
      return shown.map(r => {
        const a = attributionFor(r, personNames);
        return {
        id:        r.id,
        severity:  r.severity,
        title:     r.title,
        body:      r.body ?? '',
        locality:  r.locality,
        posted_at: r.published_at,
        // The publisher the DATABASE names (hub / business / person / OneShetland / official source) - see lib/notice-publisher.ts.
        publisher: a.label,
        attribution: a,
        logo_url:    a.logo_url,
        brand_color: a.brand_color,
        hub_id:      a.destination?.type === 'hub' ? a.destination.id : null,
        business_id: a.destination?.type === 'business' ? a.destination.id : null,
        campaign_id: r.campaign_id ?? null,
        campaign:    r.campaign ?? null,
        event_id:    r.event_id ?? null,
        event:       r.event ? {
          id: r.event.id, title: r.event.title, starts_at: r.event.starts_at,
          venue: r.event.venue, cover_url: r.event.cover_url, has_tickets: r.event.has_tickets,
        } : null,
        source:    'db' as const,
        };
      });
    }
  } catch { /* nothing to show */ }

  return [];
}

function scoreLocality(noticeLocality: string | null, viewerParish: string): number {
  if (!noticeLocality) return 3;
  const l = noticeLocality.toLowerCase();
  if (l === viewerParish)              return 0; // exact parish match
  if (l === 'all-shetland')            return 1; // archipelago-wide
  if (l.includes(viewerParish.split(' ')[0])) return 2; // partial
  return 3;
}

// ── Spik daily ─────────────────────────────────────────────────────────────

export async function fetchTodaysSpik(): Promise<SpikDaily> {
  try {
    const { data, error } = await supabase.rpc('spik_daily');
    if (!error && data && Array.isArray(data) && data.length > 0) {
      const r = data[0];
      return { word: r.word, meaning: r.meaning, example: r.example ?? null };
    }
  } catch { /* fall through */ }
  return todaysSpik();
}

// ── Nearby offers ──────────────────────────────────────────────────────────

export async function fetchNearbyOffers(
  lat: number,
  lng: number,
  radiusKm = 2,
  limit = 8,
): Promise<NearbyOffer[]> {
  try {
    const { data, error } = await supabase.rpc('nearby_local_offers', {
      user_lat:    lat,
      user_lng:    lng,
      radius_km:   radiusKm,
      result_limit: limit,
    });
    if (error) return [];
    return (data ?? []) as NearbyOffer[];
  } catch { return []; }
}

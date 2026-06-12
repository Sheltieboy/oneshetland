/**
 * lib/concierge-api.ts
 *
 * Fetchers for the Home concierge. Each one tries the real DB first
 * and falls back to the placeholder seed data when the table is empty
 * or unreachable — so the Home tab stays populated and on-brand even
 * before notices, events and jobs have any real entries.
 *
 * Once data starts flowing into the new tables, the seed disappears
 * silently. No code changes needed in the screen.
 */

import { supabase } from './supabase';
import {
  SAMPLE_EVENTS, SAMPLE_NOTICES, SAMPLE_JOBS, SAMPLE_SHIFTS,
  SampleEvent, SampleNotice, SampleJob, SampleShift,
  todaysSpik,
} from './seed-content';

// ── Types — keep the same shape the screen already renders ──────────────────

export type HomeEvent   = SampleEvent   & { source: 'db' | 'seed' };
export type HomeNotice  = SampleNotice  & {
  source:       'db' | 'seed';
  // Publisher branding (hub or business) + optional linked campaign.
  logo_url?:    string | null;
  brand_color?: string | null;
  hub_id?:      string | null;
  campaign_id?: string | null;
  campaign?:    { id: string; raised_pence: number; goal_pence: number; donor_count: number; status: string } | null;
};
export type HomeJob     = SampleJob     & { source: 'db' | 'seed' };
export type HomeShift   = SampleShift   & { source: 'db' | 'seed' };

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
      .gte('starts_at', new Date().toISOString())
      .order('is_featured', { ascending: false })
      .order('starts_at',   { ascending: true })
      .limit(limit);
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({ ...r, source: 'db' }));
    }
  } catch { /* fall through */ }

  return SAMPLE_EVENTS.slice(0, limit).map(e => ({ ...e, source: 'seed' }));
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
    const { data, error } = await supabase
      .from('notices')
      .select(`id, severity, title, body, locality, published_at,
               publisher_business_id, publisher_user_id, publisher_hub_id, campaign_id,
               hub:hubs ( id, name, logo_url, brand_color ),
               business:local_businesses ( name, logo_url, brand_color ),
               campaign:hub_campaigns ( id, raised_pence, goal_pence, donor_count, status )`)
      .eq('is_hidden', false)
      .eq('visibility', 'public')   // never surface members-only hub notices in the public feed
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('is_pinned',    { ascending: false })
      .order('published_at', { ascending: false })
      .limit(40);

    if (!error && data && data.length > 0) {
      // Local-first sort if we have a parish.
      const ranked = (data as any[]).slice();
      if (opts.viewerParish) {
        const p = opts.viewerParish.toLowerCase().trim();
        ranked.sort((a, b) => {
          const aw = scoreLocality(a.locality, p);
          const bw = scoreLocality(b.locality, p);
          if (aw !== bw) return aw - bw;
          return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        });
      }

      return ranked.slice(0, limit).map(r => ({
        id:        r.id,
        severity:  r.severity,
        title:     r.title,
        body:      r.body ?? '',
        locality:  r.locality,
        posted_at: r.published_at,
        // Real publisher name + branding (hub or business), falling back to a label.
        publisher: r.hub?.name ?? r.business?.name
                 ?? (r.publisher_hub_id ? 'Community hub' : r.publisher_business_id ? 'Local business' : 'Member'),
        logo_url:    r.hub?.logo_url ?? r.business?.logo_url ?? null,
        brand_color: r.hub?.brand_color ?? r.business?.brand_color ?? null,
        hub_id:      r.hub?.id ?? null,
        campaign_id: r.campaign_id ?? null,
        campaign:    r.campaign ?? null,
        source:    'db' as const,
      }));
    }
  } catch { /* fall through */ }

  return SAMPLE_NOTICES.slice(0, limit).map(n => ({ ...n, source: 'seed' }));
}

function scoreLocality(noticeLocality: string | null, viewerParish: string): number {
  if (!noticeLocality) return 3;
  const l = noticeLocality.toLowerCase();
  if (l === viewerParish)              return 0; // exact parish match
  if (l === 'all-shetland')            return 1; // archipelago-wide
  if (l.includes(viewerParish.split(' ')[0])) return 2; // partial
  return 3;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function fetchHomeJobs(limit = 2): Promise<HomeJob[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, location, pay_text, posted_at, posted_as_business_id, employer_id')
      .eq('is_hidden', false)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('is_featured', { ascending: false })
      .order('posted_at',   { ascending: false })
      .limit(limit);
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({
        id:        r.id,
        title:     r.title,
        employer:  r.posted_as_business_id ? 'Local business' : 'Member',
        location:  r.location ?? '',
        pay:       r.pay_text ?? '',
        posted_at: r.posted_at,
        source:    'db' as const,
      }));
    }
  } catch { /* fall through */ }

  return SAMPLE_JOBS.slice(0, limit).map(j => ({ ...j, source: 'seed' }));
}

// ── Shifts — reuse existing shifts table ───────────────────────────────────

export async function fetchHomeShifts(limit = 2): Promise<HomeShift[]> {
  try {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, pay_type, hourly_pay_pence, fixed_pay_pence, start_at, employer_id')
      .eq('status', 'open')
      .order('start_at', { ascending: true })
      .limit(limit);
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({
        id:        r.id,
        title:     r.title,
        employer:  'Employer',
        when:      r.start_at ? new Date(r.start_at).toLocaleString(undefined, {
          weekday: 'short', hour: 'numeric', minute: '2-digit',
        }) : 'Flexible',
        pay:
          r.pay_type === 'hourly'     ? `£${((r.hourly_pay_pence ?? 0) / 100).toFixed(2)}/hr`
          : r.pay_type === 'fixed'    ? `£${((r.fixed_pay_pence ?? 0) / 100).toFixed(0)}`
          : r.pay_type === 'volunteer' ? 'Volunteer'
          : 'Discuss',
        source:    'db' as const,
      }));
    }
  } catch { /* fall through */ }

  return SAMPLE_SHIFTS.slice(0, limit).map(s => ({ ...s, source: 'seed' }));
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

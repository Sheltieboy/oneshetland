/**
 * lib/boats-api.ts
 *
 * Typed wrapper around the LK Boats schema (migration 042) — a heritage
 * register of Shetland LK-registered fishing vessels modelled around the
 * physical hull as the canonical identity.
 *
 * Key idea: vessels.id is the boat's identity. Names, registrations,
 * owners, events and photos all hang off it. LK numbers and names are
 * historical metadata, not identifiers — both get reused across boats.
 */

import { supabase } from './supabase';

export type Confidence =
  | 'confirmed'
  | 'probable'
  | 'possible'
  | 'unmatched'
  | 'conflict';

// ── Types ───────────────────────────────────────────────────────────────────

export interface Vessel {
  id:                  string;
  vessel_key:          string;
  canonical_name:      string;
  primary_lk_number:   string | null;
  built_year:          number | null;
  built_decade:        string | null;
  builder:             string | null;
  yard_number:         string | null;
  hull_material:       string | null;
  country_of_build:    string | null;
  status:              string | null;
  identity_confidence: Confidence;
  identity_notes:      string | null;
  source_family:       string | null;
  created_at:          string;
  updated_at:          string;
}

export interface VesselSearchRow {
  id:                   string;
  canonical_name:       string;
  primary_lk_number:    string | null;
  built_year:           number | null;
  builder:              string | null;
  hull_material:        string | null;
  status:               string | null;
  identity_confidence:  Confidence;
  all_names:            string | null;
  all_registrations:    string | null;
  source_record_count:  number;
  media_asset_count:    number;
}

export interface VesselName {
  id:                 string;
  vessel_id:          string;
  name:               string;
  normalised_name:    string;
  start_year:         number | null;
  end_year:           number | null;
  date_text:          string | null;
  is_primary:         boolean;
  confidence:         Confidence;
  source_record_id:   string | null;
}

export interface Registration {
  id:                   string;
  vessel_id:            string;
  registration:         string;     // "LK123"
  port_mark:            string | null;
  registration_number:  number | null;
  start_year:           number | null;
  end_year:             number | null;
  date_text:            string | null;
  is_primary:           boolean;
  confidence:           Confidence;
  source_record_id:     string | null;
}

export interface Owner {
  id:               string;
  name:             string;
  normalised_name:  string;
  notes:            string | null;
}

export interface OwnershipPeriod {
  id:                string;
  vessel_id:         string;
  owner_id:          string;
  owner?:            Owner | null;
  start_year:        number | null;
  end_year:          number | null;
  date_text:         string | null;
  confidence:        Confidence;
  source_record_id:  string | null;
  notes:             string | null;
}

export interface VesselEvent {
  id:                 string;
  vessel_id:          string;
  event_type:         string;       // "official_snapshot_seen", "built", "rename", "sale", "loss", "note", …
  event_year:         number | null;
  event_date_text:    string | null;
  description:        string;
  location:           string | null;
  confidence:         Confidence;
  source_record_id:   string | null;
}

export interface Measurement {
  id:                string;
  vessel_id:         string;
  measurement_year:  number | null;
  length_m:          number | null;
  tonnage:           number | null;
  tonnage_type:      string | null;
  tonnage_text:      string | null;
  engine_power_kw:   number | null;
  capacity_units:    number | null;
  source_record_id:  string | null;
  notes:             string | null;
}

export interface MediaAsset {
  id:                 string;
  source_document_id: string;
  source_record_id:   string | null;
  asset_type:         string;      // "photo", "photo_reference", …
  title:              string | null;
  external_ref:       string | null;
  image_url:          string | null;
  thumbnail_url:      string | null;
  page_url:           string | null;
  rights_note:        string | null;
  payload:            Record<string, any>;
  created_at:         string;
}

export interface VesselMediaLink {
  id:                string;
  vessel_id:         string;
  media_asset_id:    string;
  media?:            MediaAsset | null;
  source_record_id:  string | null;
  confidence:        Confidence;
  notes:             string | null;
}

export interface SourceDocument {
  id:          string;
  slug:        string;
  title:       string;
  source_type: string;
  publisher:   string | null;
  url:         string | null;
  accessed_on: string | null;
  notes:       string | null;
}

export interface SourceRecord {
  id:                  string;
  source_document_id:  string;
  document?:           SourceDocument | null;
  record_type:         string;
  external_ref:        string | null;
  source_page:         string | null;
  record_date_text:    string | null;
  raw_text:            string | null;
  payload:             Record<string, any>;
  extraction_notes:    string | null;
}

export interface VesselSourceLink {
  id:                string;
  vessel_id:         string;
  source_record_id:  string;
  source_record?:    SourceRecord | null;
  confidence:        Confidence;
  relationship_type: string;
  notes:             string | null;
}

export interface VesselTimelineEntry {
  vessel_id:         string;
  canonical_name:    string;
  year:              number | null;
  date_text:         string | null;
  item_type:         string;   // 'registration' | 'name' | event_type
  description:       string;
  confidence:        Confidence;
  source_record_id:  string | null;
}

export interface VesselProfile {
  vessel:        Vessel;
  names:         VesselName[];
  registrations: Registration[];
  ownerships:    OwnershipPeriod[];
  events:        VesselEvent[];
  measurements:  Measurement[];
  media:         (VesselMediaLink & { media: MediaAsset })[];
  evidence:      (VesselSourceLink & { source_record: SourceRecord })[];
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Browse / search the fleet. Backed by the vessel_search view (string-agg'd
 * names + registrations) so a single result row gives you everything you
 * need to render a list card without N+1.
 *
 * Empty query returns the most-recently-built confirmed boats first.
 */
export async function searchVessels(query: string, limit = 60): Promise<VesselSearchRow[]> {
  const q = query.trim();

  if (!q) {
    // No query — return a default browse list: most-recently-built first,
    // confirmed identity ahead of probable/possible.
    const { data, error } = await supabase
      .from('vessel_search')
      .select('*')
      .order('built_year', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as VesselSearchRow[];
  }

  // Search across canonical_name + all_names + all_registrations + LK.
  // .or() with ilike across multiple columns is good enough at this scale
  // (~500 vessels). Trigram index speeds the canonical_name path.
  const wild = `%${q}%`;
  const { data, error } = await supabase
    .from('vessel_search')
    .select('*')
    .or(
      `canonical_name.ilike.${wild},all_names.ilike.${wild},all_registrations.ilike.${wild},primary_lk_number.ilike.${wild}`,
    )
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as VesselSearchRow[];
}

/**
 * Full vessel profile in one round-trip-ish — names, registrations,
 * ownerships (with owner joined), events, measurements, media (with the
 * MediaAsset joined), evidence (with the SourceRecord + Document joined).
 *
 * Returns null if the vessel id is missing.
 */
export async function fetchVesselProfile(id: string): Promise<VesselProfile | null> {
  const [
    vRes, nRes, rRes, oRes, eRes, mRes, mediaRes, evRes,
  ] = await Promise.all([
    supabase.from('vessels').select('*').eq('id', id).maybeSingle(),
    supabase.from('vessel_names').select('*').eq('vessel_id', id)
      .order('is_primary', { ascending: false })
      .order('start_year', { ascending: true, nullsFirst: false }),
    supabase.from('registrations').select('*').eq('vessel_id', id)
      .order('is_primary', { ascending: false })
      .order('start_year', { ascending: true, nullsFirst: false }),
    supabase.from('ownership_periods')
      .select('*, owner:owners(*)')
      .eq('vessel_id', id)
      .order('start_year', { ascending: true, nullsFirst: false }),
    supabase.from('vessel_events').select('*').eq('vessel_id', id)
      .order('event_year', { ascending: true, nullsFirst: false }),
    supabase.from('measurements').select('*').eq('vessel_id', id)
      .order('measurement_year', { ascending: true, nullsFirst: false }),
    supabase.from('vessel_media_links')
      .select('*, media:media_assets(*)')
      .eq('vessel_id', id),
    supabase.from('vessel_source_links')
      .select('*, source_record:source_records(*, document:source_documents(*))')
      .eq('vessel_id', id),
  ]);

  if (vRes.error) throw vRes.error;
  if (!vRes.data) return null;
  if (nRes.error) throw nRes.error;
  if (rRes.error) throw rRes.error;
  if (oRes.error) throw oRes.error;
  if (eRes.error) throw eRes.error;
  if (mRes.error) throw mRes.error;
  if (mediaRes.error) throw mediaRes.error;
  if (evRes.error) throw evRes.error;

  return {
    vessel:        vRes.data as Vessel,
    names:         (nRes.data ?? []) as VesselName[],
    registrations: (rRes.data ?? []) as Registration[],
    ownerships:    (oRes.data ?? []) as OwnershipPeriod[],
    events:        (eRes.data ?? []) as VesselEvent[],
    measurements:  (mRes.data ?? []) as Measurement[],
    media:         (mediaRes.data ?? []) as any,
    evidence:      (evRes.data   ?? []) as any,
  };
}

/**
 * Unified timeline view — names, registrations and events folded into one
 * chronological list. Backed by vessel_timeline. Good for the "story so
 * far" panel on a profile.
 */
export async function fetchVesselTimeline(id: string): Promise<VesselTimelineEntry[]> {
  const { data, error } = await supabase
    .from('vessel_timeline')
    .select('*')
    .eq('vessel_id', id)
    .order('year', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data ?? []) as VesselTimelineEntry[];
}

/**
 * Batch-fetch one hero image URL per vessel id. Picks the first media
 * asset that has an actual image_url (not just a Wildmuir reference)
 * with the best confidence. Returns a map vesselId → URL.
 *
 * Used by the landing page to give the cards a hero photo. We do it as a
 * second round-trip (rather than baking it into the vessel_search view)
 * so the view stays cheap and the heroes can be re-ranked over time
 * without a schema migration.
 */
export async function fetchHeroPhotos(vesselIds: string[]): Promise<Record<string, string>> {
  if (!vesselIds.length) return {};

  const { data, error } = await supabase
    .from('vessel_media_links')
    .select('vessel_id, confidence, media:media_assets(image_url, thumbnail_url)')
    .in('vessel_id', vesselIds);

  if (error) return {};

  // Per-vessel: highest confidence + non-null image_url wins. Walk once
  // and prefer confirmed > probable > possible > anything else.
  const confidenceRank: Record<string, number> = {
    confirmed: 0, probable: 1, possible: 2, unmatched: 3, conflict: 4,
  };

  const best: Record<string, { url: string; rank: number }> = {};
  for (const row of (data ?? []) as any[]) {
    const url = row.media?.image_url ?? row.media?.thumbnail_url;
    if (!url) continue;
    const rank = confidenceRank[row.confidence] ?? 9;
    const prev = best[row.vessel_id];
    if (!prev || rank < prev.rank) {
      best[row.vessel_id] = { url, rank };
    }
  }

  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.url]));
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * "LK123 BRILLIANT" — what most people will recognise on a card.
 */
export function vesselDisplayTitle(v: { canonical_name: string; primary_lk_number: string | null }): string {
  return v.primary_lk_number ? `${v.primary_lk_number} ${v.canonical_name}` : v.canonical_name;
}

/**
 * Hull-material code → readable label.
 * F = fibreglass, S = steel, W = wood, A = aluminium.
 */
export function hullMaterialLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.toUpperCase();
  switch (c) {
    case 'F': return 'Fibreglass';
    case 'S': return 'Steel';
    case 'W': return 'Wood';
    case 'A': return 'Aluminium';
    default:  return c;
  }
}

/**
 * Plain-English confidence labels. The DB enums are fine for code but
 * "probable" and "possible" mean little to a retired skipper. These
 * read like a researcher friend would phrase it.
 */
export function confidenceLabel(c: Confidence): string {
  switch (c) {
    case 'confirmed': return 'Confirmed';
    case 'probable':  return 'Almost certain';
    case 'possible':  return 'Likely match';
    case 'unmatched': return 'Not yet matched';
    case 'conflict':  return 'Sources disagree';
  }
}

/**
 * Vessel-event type slug → human label. Most types come from the seed
 * data; unknown types are title-cased.
 */
export function eventTypeLabel(type: string): string {
  switch (type) {
    case 'official_snapshot_seen': return 'Seen in official register';
    case 'built':                  return 'Built';
    case 'rename':                 return 'Renamed';
    case 'reregistered':           return 'Re-registered';
    case 'sale':                   return 'Sale';
    case 'loss':                   return 'Lost at sea';
    case 'scrapped':               return 'Scrapped';
    case 'note':                   return 'Note';
    case 'photo':                  return 'Photographed';
    case 'registration':           return 'Registration';
    case 'name':                   return 'Name';
    default:
      return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

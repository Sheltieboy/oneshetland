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

import { supabase, SUPABASE_URL } from './supabase';
import { PickedFile } from './image-upload';

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
  comment_count:        number;
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

// ── Per-vessel metrics (for yard/fleet stats) ────────────────────────────────

export interface VesselMetric {
  length:  number | null;   // metres (max recorded)
  tonnage: number | null;   // max recorded
  engine:  number | null;   // kW (max recorded)
}

/**
 * Best (max) length / tonnage / engine power per vessel, folded from the
 * measurements table. Paginated because measurements exceeds the 1000-row
 * PostgREST cap. Returns a map keyed by vessel_id.
 */
export async function fetchVesselMetrics(): Promise<Record<string, VesselMetric>> {
  const out: Record<string, VesselMetric> = {};
  const PAGE = 1000;
  for (let from = 0; from < 6000; from += PAGE) {
    const { data, error } = await supabase
      .from('measurements')
      .select('vessel_id, length_m, tonnage, engine_power_kw')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const m of data as any[]) {
      const cur = out[m.vessel_id] ?? { length: null, tonnage: null, engine: null };
      if (m.length_m != null)        cur.length  = Math.max(cur.length  ?? 0, m.length_m);
      if (m.tonnage != null)         cur.tonnage = Math.max(cur.tonnage ?? 0, m.tonnage);
      if (m.engine_power_kw != null) cur.engine  = Math.max(cur.engine  ?? 0, m.engine_power_kw);
      out[m.vessel_id] = cur;
    }
    if (data.length < PAGE) break;
  }
  return out;
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
    case 'U': return 'Unknown';
    case 'O': return 'Other';
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

// ── Comments / discussion ──────────────────────────────────────────────────

export type CommentSubject =
  | 'general'
  | 'names'
  | 'registrations'
  | 'owners'
  | 'photos'
  | 'build'
  | 'story'
  | 'correction'
  | 'addition';

export const COMMENT_SUBJECTS: { slug: CommentSubject; label: string; icon: string }[] = [
  { slug: 'general',       label: 'General',           icon: 'comment'      },
  { slug: 'names',         label: 'About the names',    icon: 'tag'          },
  { slug: 'registrations', label: 'About the numbers',  icon: 'hashtag'      },
  { slug: 'owners',        label: 'About the owners',   icon: 'users'        },
  { slug: 'photos',        label: 'About the photos',   icon: 'camera'       },
  { slug: 'build',         label: 'About the build',    icon: 'hammer'       },
  { slug: 'story',         label: 'Her story',          icon: 'book'         },
  { slug: 'correction',    label: 'A correction',       icon: 'exclamation-triangle' },
  { slug: 'addition',      label: 'An addition',        icon: 'plus-circle'  },
];

export function commentSubjectLabel(slug: string): string {
  return COMMENT_SUBJECTS.find(s => s.slug === slug)?.label ?? 'General';
}

export interface VesselComment {
  id:                 string;
  vessel_id:          string;
  author_id:          string | null;
  author?:            { id: string; full_name: string | null; avatar_url: string | null } | null;
  subject_type:       CommentSubject;
  subject_row_id:     string | null;
  parent_comment_id:  string | null;
  body:               string;
  image_url:          string | null;
  image_path:         string | null;
  is_hidden:          boolean;
  edited_at:          string | null;
  created_at:         string;

  /** Filled client-side when comments are nested under their parent for rendering. */
  replies?:           VesselComment[];
}

const COMMENT_BUCKET = 'boat-comment-media';

/**
 * Uploads a picked image to the boat-comment-media bucket under
 * <author_id>/<uuid>.<ext> using the FormData REST pattern (the SDK's
 * blob upload uploads 0-byte files on RN/iOS — see lib/image-upload.ts).
 * Returns the persisted path + public URL.
 */
export async function uploadCommentPhoto(
  authorId: string,
  file: PickedFile,
): Promise<{ path: string; publicUrl: string }> {
  const ext =
    (file.ext ?? file.mimeType?.split('/')[1] ?? file.uri.split('.').pop() ?? 'jpg')
      .replace(/^\./, '').toLowerCase();
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const path = `${authorId}/${filename}`;
  const contentType = file.mimeType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');

  const form = new FormData();
  form.append('file', {
    uri:  file.uri,
    name: filename,
    type: contentType,
  } as any);

  const url = `${SUPABASE_URL}/storage/v1/object/${COMMENT_BUCKET}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'x-upsert':    'true',
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Photo upload failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const { data: pub } = supabase.storage.from(COMMENT_BUCKET).getPublicUrl(path);
  return { path, publicUrl: pub.publicUrl };
}

/**
 * Delete a previously-uploaded comment photo from storage. Silently
 * ignores "not found".
 */
export async function deleteCommentPhoto(path: string): Promise<void> {
  const { error } = await supabase.storage.from(COMMENT_BUCKET).remove([path]);
  if (error && !/not found/i.test(error.message)) throw error;
}

/**
 * Fetch every comment on a vessel — both top-level and replies — joined
 * with author summaries. Returned in chronological order; callers can
 * thread by parent_comment_id client-side.
 */
export async function fetchVesselComments(vesselId: string): Promise<VesselComment[]> {
  const { data, error } = await supabase
    .from('vessel_comments')
    .select(`
      *,
      author:profiles!vessel_comments_author_id_fkey(id, full_name, avatar_url)
    `)
    .eq('vessel_id', vesselId)
    .eq('is_hidden', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as VesselComment[];
}

/**
 * Thread a flat list into top-level + replies. Replies that lost their
 * parent (e.g. parent was hidden) get promoted to top-level so they
 * don't vanish.
 */
export function threadComments(flat: VesselComment[]): VesselComment[] {
  const byId: Record<string, VesselComment> = {};
  for (const c of flat) byId[c.id] = { ...c, replies: [] };

  const top: VesselComment[] = [];
  for (const c of flat) {
    const node = byId[c.id];
    if (c.parent_comment_id && byId[c.parent_comment_id]) {
      byId[c.parent_comment_id].replies!.push(node);
    } else {
      top.push(node);
    }
  }
  return top;
}

export async function addVesselComment(input: {
  vesselId:         string;
  authorId:         string;
  body:             string;
  subjectType?:     CommentSubject;
  subjectRowId?:    string | null;
  parentCommentId?: string | null;
  /** Optional photo to upload + attach. */
  imageFile?:       PickedFile | null;
}): Promise<VesselComment> {
  // Upload first (if any) so the row carries a known-good URL.
  let imagePath: string | null = null;
  let imageUrl:  string | null = null;
  if (input.imageFile) {
    const up = await uploadCommentPhoto(input.authorId, input.imageFile);
    imagePath = up.path;
    imageUrl  = up.publicUrl;
  }

  const { data, error } = await supabase
    .from('vessel_comments')
    .insert({
      vessel_id:         input.vesselId,
      author_id:         input.authorId,
      body:              input.body.trim(),
      subject_type:      input.subjectType ?? 'general',
      subject_row_id:    input.subjectRowId ?? null,
      parent_comment_id: input.parentCommentId ?? null,
      image_url:         imageUrl,
      image_path:        imagePath,
    })
    .select(`
      *,
      author:profiles!vessel_comments_author_id_fkey(id, full_name, avatar_url)
    `)
    .single();

  if (error) {
    // Roll back the orphaned upload so we don't leak bytes.
    if (imagePath) await deleteCommentPhoto(imagePath).catch(() => {});
    throw error;
  }

  // Notify the thread (reply → parent commenter; top-level → other commenters).
  supabase.functions
    .invoke('notify-engagement', { body: { event: 'vessel_comment', comment_id: (data as VesselComment).id } })
    .catch(() => {});

  return data as VesselComment;
}

export async function editVesselComment(
  id: string,
  body: string,
  options?: {
    /** Replace the photo with a freshly-picked file. */
    newImageFile?:  PickedFile | null;
    /** Set true to remove an existing photo with no replacement. */
    removeImage?:   boolean;
    /** Author id — needed when uploading a new photo, ignored otherwise. */
    authorId?:      string;
    /** Existing image_path so we can clean up storage when replacing. */
    previousImagePath?: string | null;
  },
): Promise<VesselComment> {
  const patch: Record<string, any> = {
    body: body.trim(),
    edited_at: new Date().toISOString(),
  };

  if (options?.newImageFile && options.authorId) {
    const up = await uploadCommentPhoto(options.authorId, options.newImageFile);
    patch.image_url  = up.publicUrl;
    patch.image_path = up.path;
    if (options.previousImagePath) {
      await deleteCommentPhoto(options.previousImagePath).catch(() => {});
    }
  } else if (options?.removeImage) {
    patch.image_url  = null;
    patch.image_path = null;
    if (options.previousImagePath) {
      await deleteCommentPhoto(options.previousImagePath).catch(() => {});
    }
  }

  const { data, error } = await supabase
    .from('vessel_comments')
    .update(patch)
    .eq('id', id)
    .select(`
      *,
      author:profiles!vessel_comments_author_id_fkey(id, full_name, avatar_url)
    `)
    .single();
  if (error) throw error;
  return data as VesselComment;
}

export async function deleteVesselComment(id: string): Promise<void> {
  const { error } = await supabase
    .from('vessel_comments')
    .delete()
    .eq('id', id);
  if (error) throw error;
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
    case 'community_edit':         return 'Community correction';
    default:
      return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

// ── Community corrections (migration 076) ────────────────────────────────────
//
// Anyone signed in can suggest a change to a single fact. When CONFIRM_THRESHOLD
// other people confirm it, the vote_vessel_edit RPC applies it automatically;
// DISPUTE_THRESHOLD disagrees auto-rejects it. No admin in the loop.

export const CONFIRM_THRESHOLD = 3;
export const DISPUTE_THRESHOLD = 3;

export type EditAction = 'edit' | 'add' | 'remove';
export type EditVote   = 'confirm' | 'dispute';
export type EditStatus = 'open' | 'applied' | 'rejected' | 'superseded';

export type EditTable =
  | 'vessels'
  | 'vessel_names'
  | 'registrations'
  | 'ownership_periods'
  | 'owners'
  | 'measurements';

export interface VesselEditProposal {
  id:            string;
  vessel_id:     string;
  target_table:  EditTable;
  target_row_id: string | null;
  target_column: string | null;
  action:        EditAction;
  payload:       Record<string, any>;
  current_value: string | null;
  summary:       string;
  note:          string | null;
  proposed_by:   string | null;
  status:        EditStatus;
  confirm_count: number;
  dispute_count: number;
  created_at:    string;
  applied_at:    string | null;
  resolved_at:   string | null;
}

/** proposal_id → the viewer's vote on it. */
export type MyEditVotes = Record<string, EditVote>;

export type EditValueType = 'text' | 'year' | 'number';

/** What kind of input a column wants in the suggest form. */
export function editValueType(column: string | null | undefined): EditValueType {
  if (!column) return 'text';
  if (['built_year', 'start_year', 'end_year', 'measurement_year'].includes(column)) return 'year';
  if (['length_m', 'tonnage', 'engine_power_kw'].includes(column)) return 'number';
  return 'text';
}

/** Builds the human sentence stored on the proposal + shown in the audit trail. */
export function buildEditSummary(args: {
  action: EditAction;
  label: string;
  value?: string | null;
  currentValue?: string | null;
}): string {
  const v = (args.value ?? '').trim();
  if (args.action === 'edit') return `Change ${args.label} to “${v}”`;
  if (args.action === 'add')  return `Add ${args.label}: “${v}”`;
  return `Remove ${args.label}${args.currentValue ? `: “${args.currentValue}”` : ''}`;
}

/** Open + recently-applied proposals for a vessel (oldest first). */
export async function fetchVesselEdits(vesselId: string): Promise<VesselEditProposal[]> {
  const { data, error } = await supabase
    .from('vessel_edit_proposals')
    .select('*')
    .eq('vessel_id', vesselId)
    .in('status', ['open', 'applied'])
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as VesselEditProposal[];
}

/** The viewer's votes across the given proposals (votes are readable own-only). */
export async function fetchMyEditVotes(proposalIds: string[], userId: string): Promise<MyEditVotes> {
  if (proposalIds.length === 0) return {};
  const { data, error } = await supabase
    .from('vessel_edit_votes')
    .select('proposal_id, vote')
    .eq('user_id', userId)
    .in('proposal_id', proposalIds);
  if (error) throw error;
  const map: MyEditVotes = {};
  for (const r of (data ?? []) as any[]) map[r.proposal_id] = r.vote as EditVote;
  return map;
}

/** Convenience: proposals + the viewer's votes in one call (used by the screen). */
export async function fetchVesselEditState(
  vesselId: string,
  userId?: string | null,
): Promise<{ proposals: VesselEditProposal[]; myVotes: MyEditVotes }> {
  const proposals = await fetchVesselEdits(vesselId);
  let myVotes: MyEditVotes = {};
  if (userId) myVotes = await fetchMyEditVotes(proposals.map(p => p.id), userId);
  return { proposals, myVotes };
}

export interface ProposeEditInput {
  vesselId:      string;
  userId:        string;
  table:         EditTable;
  rowId?:        string | null;
  column?:       string | null;
  action:        EditAction;
  payload:       Record<string, any>;
  currentValue?: string | null;
  summary:       string;
  note?:         string | null;
}

export async function proposeVesselEdit(input: ProposeEditInput): Promise<VesselEditProposal> {
  const { data, error } = await supabase
    .from('vessel_edit_proposals')
    .insert({
      vessel_id:     input.vesselId,
      target_table:  input.table,
      target_row_id: input.rowId ?? null,
      target_column: input.column ?? null,
      action:        input.action,
      payload:       input.payload ?? {},
      current_value: input.currentValue ?? null,
      summary:       input.summary,
      note:          input.note ?? null,
      proposed_by:   input.userId,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as VesselEditProposal;
}

export async function voteVesselEdit(
  proposalId: string,
  vote: EditVote,
): Promise<{ status: EditStatus; confirm_count: number; dispute_count: number; applied: boolean }> {
  const { data, error } = await supabase.rpc('vote_vessel_edit', {
    p_proposal: proposalId,
    p_vote: vote,
  });
  if (error) throw error;
  return data as { status: EditStatus; confirm_count: number; dispute_count: number; applied: boolean };
}

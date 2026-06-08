/**
 * lib/memories-api.ts
 *
 * All Supabase access for the Memories section. Keep screen code thin —
 * everything goes through here so authorisation, RPC payloads, and shape
 * normalisation live in one place.
 *
 * Schema lives in migration 038.
 */

import { supabase, SUPABASE_URL } from './supabase';
import { PickedFile } from './image-upload';

// ── Types (kept loose; the DB is the source of truth) ───────────────────────

export type MemoryVisibility = 'public' | 'community' | 'private';
export type MediaKind        = 'photo' | 'video' | 'audio';
export type ReactionKind     = 'heart' | 'applaud' | 'compass' | 'scroll';
export type TranscriptStatus = 'none' | 'pending' | 'done' | 'failed';

export interface MemoryPin {
  id:             string;
  lat:            number;
  lng:            number;
  place_name:     string | null;
  title:          string | null;
  era:            string | null;
  tags:           string[];
  media_count:    number;
  comment_count:  number;
  reaction_count: number;
  child_count:    number;
  hero_url:       string | null;
  hero_kind:      MediaKind | null;
  created_at:     string;
}

export interface MemoryAuthor {
  id:         string;
  full_name:  string | null;
  avatar_url: string | null;
}

export interface MemoryMedia {
  id:                string;
  memory_id:         string;
  uploader_id:       string;
  kind:              MediaKind;
  url:               string;
  storage_path:      string;
  thumb_url:         string | null;
  transcript:        string | null;
  transcript_status: TranscriptStatus;
  caption:           string | null;
  display_order:     number;
  duration_seconds:  number | null;
  created_at:        string;
}

export interface MemoryImagePin {
  id:                     string;
  media_id:               string;
  author_id:              string;
  x:                      number;   // 0..1
  y:                      number;   // 0..1
  prompt:                 string;
  resolved:               boolean;
  resolved_answer:        string | null;
  resolved_by:            string | null;
  resolved_at:            string | null;
  accepted_suggestion_id: string | null;
  created_at:             string;
  /** Filled by fetchPinSuggestions / fetchMemoryDetail. */
  suggestions?:           MemoryImagePinSuggestion[];
}

export interface MemoryImagePinSuggestion {
  id:           string;
  pin_id:       string;
  suggester_id: string;
  suggester?:   MemoryAuthor | null;
  answer:       string;
  is_accepted:  boolean;
  accepted_at:  string | null;
  created_at:   string;
}

export interface MemorySearchResult {
  id:           string;
  lat:          number | null;
  lng:          number | null;
  place_name:   string | null;
  title:        string | null;
  body_excerpt: string | null;
  era:          string | null;
  tags:         string[];
  matched_via:  'title' | 'body' | 'era' | 'tag' | 'photo_tag';
  hero_url:     string | null;
  hero_kind:    MediaKind | null;
  created_at:   string;
}

export interface MemoryComment {
  id:           string;
  memory_id:    string;
  author_id:    string;
  author?:      MemoryAuthor | null;
  image_pin_id: string | null;
  body:         string;
  created_at:   string;
}

export interface Memory {
  id:             string;
  author_id:      string;
  author?:        MemoryAuthor | null;
  lat:            number | null;
  lng:            number | null;
  place_name:     string | null;
  parent_id:      string | null;
  era:            string | null;
  tags:           string[];
  title:          string | null;
  body:           string | null;
  visibility:     MemoryVisibility;
  media_count:    number;
  comment_count:  number;
  reaction_count: number;
  child_count:    number;
  created_at:     string;
  updated_at:     string;

  media?:    MemoryMedia[];
  pins?:     MemoryImagePin[];
  comments?: MemoryComment[];
  children?: Memory[];
  reactions_by_kind?: Record<ReactionKind, number>;
  my_reactions?: ReactionKind[];
}

// ── Map / list queries ──────────────────────────────────────────────────────

/**
 * Fetch lightweight pin data for the map view, scoped to a lat/lng bounding
 * box. Backed by the fetch_memory_pins RPC in migration 038.
 */
export async function fetchMemoryPins(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  limit = 500,
): Promise<MemoryPin[]> {
  const { data, error } = await supabase.rpc('fetch_memory_pins', {
    min_lat: bbox.minLat,
    max_lat: bbox.maxLat,
    min_lng: bbox.minLng,
    max_lng: bbox.maxLng,
    result_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as MemoryPin[];
}

/**
 * Most-recent memories list (Home tab teaser, "Latest from the islands").
 */
export async function fetchRecentMemories(limit = 12): Promise<MemoryPin[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('id, lat, lng, place_name, title, era, media_count, comment_count, reaction_count, child_count, created_at')
    .is('parent_id', null)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  // hero_url is omitted in this fast path; caller can hit fetchMemoryPins or
  // open the detail to load media.
  return ((data ?? []) as any[]).map(r => ({ ...r, hero_url: null, hero_kind: null }));
}

// ── Detail ──────────────────────────────────────────────────────────────────

/**
 * Fetch one memory plus its media, image pins, comments, children, and
 * reaction tallies. Returns null if missing or hidden-from-caller.
 */
export async function fetchMemoryDetail(id: string, userId: string | null): Promise<Memory | null> {
  const [memRes, mediaRes, commentsRes, childrenRes, reactionsRes, myReactionsRes] = await Promise.all([
    supabase
      .from('memories')
      .select('*, author:profiles!memories_author_id_fkey(id, full_name, avatar_url)')
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('memory_media')
      .select('*')
      .eq('memory_id', id)
      .order('display_order'),
    supabase
      .from('memory_comments')
      .select('*, author:profiles!memory_comments_author_id_fkey(id, full_name, avatar_url)')
      .eq('memory_id', id)
      .eq('is_hidden', false)
      .order('created_at'),
    supabase
      .from('memories')
      .select('*, author:profiles!memories_author_id_fkey(id, full_name, avatar_url)')
      .eq('parent_id', id)
      .order('created_at'),
    supabase
      .from('memory_reactions')
      .select('kind')
      .eq('memory_id', id),
    userId
      ? supabase
          .from('memory_reactions')
          .select('kind')
          .eq('memory_id', id)
          .eq('user_id', userId)
      : Promise.resolve({ data: [] as { kind: ReactionKind }[] }),
  ]);

  if (memRes.error)      throw memRes.error;
  if (!memRes.data)      return null;
  if (mediaRes.error)    throw mediaRes.error;
  if (commentsRes.error) throw commentsRes.error;
  if (childrenRes.error) throw childrenRes.error;

  // Pins (only fetch if there are photos)
  const photoIds = (mediaRes.data ?? []).filter(m => m.kind === 'photo').map(m => m.id);
  let pins: MemoryImagePin[] = [];
  if (photoIds.length) {
    const { data: pinData, error: pinErr } = await supabase
      .from('memory_image_pins')
      .select('*')
      .in('media_id', photoIds);
    if (pinErr) throw pinErr;
    pins = (pinData ?? []) as MemoryImagePin[];

    // Hydrate community suggestions for every pin in one round-trip.
    if (pins.length) {
      const pinIds = pins.map(p => p.id);
      const { data: sugData, error: sugErr } = await supabase
        .from('memory_image_pin_suggestions')
        .select('*, suggester:profiles!memory_image_pin_suggestions_suggester_id_fkey(id, full_name, avatar_url)')
        .in('pin_id', pinIds)
        .order('created_at');
      if (sugErr) throw sugErr;
      const byPin: Record<string, MemoryImagePinSuggestion[]> = {};
      for (const s of (sugData ?? []) as MemoryImagePinSuggestion[]) {
        (byPin[s.pin_id] ||= []).push(s);
      }
      pins = pins.map(p => ({ ...p, suggestions: byPin[p.id] ?? [] }));
    }
  }

  const reactionsByKind: Record<ReactionKind, number> = {
    heart: 0, applaud: 0, compass: 0, scroll: 0,
  };
  for (const r of (reactionsRes.data ?? []) as { kind: ReactionKind }[]) {
    reactionsByKind[r.kind] = (reactionsByKind[r.kind] ?? 0) + 1;
  }

  return {
    ...(memRes.data as Memory),
    media:    (mediaRes.data ?? []) as MemoryMedia[],
    comments: (commentsRes.data ?? []) as MemoryComment[],
    children: (childrenRes.data ?? []) as Memory[],
    pins,
    reactions_by_kind: reactionsByKind,
    my_reactions: (myReactionsRes.data ?? []).map((r: any) => r.kind as ReactionKind),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateMemoryInput {
  author_id:   string;
  lat?:        number | null;
  lng?:        number | null;
  place_name?: string | null;
  parent_id?:  string | null;
  era?:        string | null;
  tags?:       string[];
  title?:      string | null;
  body?:       string | null;
  visibility?: MemoryVisibility;
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const { data, error } = await supabase
    .from('memories')
    .insert({
      author_id:  input.author_id,
      lat:        input.lat        ?? null,
      lng:        input.lng        ?? null,
      place_name: input.place_name ?? null,
      parent_id:  input.parent_id  ?? null,
      era:        input.era        ?? null,
      tags:       input.tags       ?? [],
      title:      input.title      ?? null,
      body:       input.body       ?? null,
      visibility: input.visibility ?? 'public',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as Memory;
}

export async function updateMemory(
  id: string,
  patch: Partial<Pick<Memory, 'title' | 'body' | 'place_name' | 'era' | 'tags' | 'visibility' | 'lat' | 'lng'>>,
): Promise<Memory> {
  const { data, error } = await supabase
    .from('memories')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Memory;
}

export async function deleteMemory(id: string): Promise<void> {
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) throw error;
}

// ── Media uploads ───────────────────────────────────────────────────────────

const MEMORIES_BUCKET = 'memories-media';

function newFilename(ext: string): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
}

function extFromFile(file: PickedFile, fallback: string): string {
  if (file.ext)      return file.ext.replace(/^\./, '').toLowerCase();
  if (file.mimeType) return (file.mimeType.split('/')[1] || fallback).toLowerCase();
  const last = file.uri.split('.').pop();
  return (last && last.length <= 5 ? last : fallback).toLowerCase();
}

export interface UploadMemoryMediaInput {
  memoryId:        string;
  uploaderId:      string;
  kind:            MediaKind;
  file:            PickedFile;
  caption?:        string;
  durationSeconds?: number;
  displayOrder?:    number;
}

/**
 * Upload a single piece of media and register it on the memory.
 * For audio it also flips transcript_status to 'pending' so a background
 * job (or the transcribe-audio edge function called by the client) knows
 * to fill it in.
 *
 * Why the FormData REST path instead of supabase.storage.upload(blob)?
 *   On React Native iOS, `fetch(file://…).blob()` resolves to a Blob
 *   with size 0 even though the underlying file is intact — so the JS
 *   SDK happily uploads a 0-byte file. The resulting URL works but the
 *   asset is empty (renders as black for images). FormData with a
 *   { uri, name, type } object lets the platform stream the real bytes.
 *   This is the supabase-js-recommended pattern for React Native.
 */
export async function uploadMemoryMedia(input: UploadMemoryMediaInput): Promise<MemoryMedia> {
  const extFallback = input.kind === 'audio' ? 'm4a' : input.kind === 'video' ? 'mp4' : 'jpg';
  const ext  = extFromFile(input.file, extFallback);
  const path = `${input.memoryId}/${input.kind}/${newFilename(ext)}`;
  const contentType =
    input.file.mimeType
    ?? (input.kind === 'photo' ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
       : input.kind === 'video' ? `video/${ext}`
       : `audio/${ext}`);

  // ── Direct REST upload via FormData (RN-safe) ──────────────────────────
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in — please sign in and try again.');

  const filename = path.split('/').pop() ?? `upload.${ext}`;
  const form = new FormData();
  form.append('file', {
    // RN's FormData accepts this { uri, name, type } object even though
    // TypeScript doesn't know about it.
    uri:  input.file.uri,
    name: filename,
    type: contentType,
  } as any);

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${MEMORIES_BUCKET}/${path}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'x-upsert':    'true',
      // Note: don't set Content-Type — let RN fill in the multipart boundary.
    },
    body: form,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`Storage upload failed (${uploadRes.status}): ${text.slice(0, 200)}`);
  }

  const { data: pub } = supabase.storage.from(MEMORIES_BUCKET).getPublicUrl(path);

  const { data, error } = await supabase
    .from('memory_media')
    .insert({
      memory_id:         input.memoryId,
      uploader_id:       input.uploaderId,
      kind:              input.kind,
      url:               pub.publicUrl,
      storage_path:      path,
      caption:           input.caption ?? null,
      duration_seconds:  input.durationSeconds ?? null,
      display_order:     input.displayOrder ?? 0,
      transcript_status: input.kind === 'audio' ? 'pending' : 'none',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as MemoryMedia;
}

export async function deleteMemoryMedia(media: MemoryMedia): Promise<void> {
  // Try to remove the file first, but proceed if it's already gone.
  await supabase.storage.from(MEMORIES_BUCKET).remove([media.storage_path]);
  const { error } = await supabase.from('memory_media').delete().eq('id', media.id);
  if (error) throw error;
}

// ── Image pins (annotations on photos) ──────────────────────────────────────

export async function addImagePin(input: {
  mediaId:  string;
  authorId: string;
  x: number; y: number;
  prompt: string;
}): Promise<MemoryImagePin> {
  const { data, error } = await supabase
    .from('memory_image_pins')
    .insert({
      media_id:  input.mediaId,
      author_id: input.authorId,
      x: Math.min(1, Math.max(0, input.x)),
      y: Math.min(1, Math.max(0, input.y)),
      prompt:    input.prompt,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as MemoryImagePin;
}

export async function resolveImagePin(
  pinId: string,
  answer: string,
  resolverId: string,
): Promise<MemoryImagePin> {
  const { data, error } = await supabase
    .from('memory_image_pins')
    .update({
      resolved:        true,
      resolved_answer: answer,
      resolved_by:     resolverId,
      resolved_at:     new Date().toISOString(),
    })
    .eq('id', pinId)
    .select('*')
    .single();
  if (error) throw error;
  return data as MemoryImagePin;
}

export async function deleteImagePin(pinId: string): Promise<void> {
  const { error } = await supabase.from('memory_image_pins').delete().eq('id', pinId);
  if (error) throw error;
}

// ── Community suggestions on image pins ─────────────────────────────────────

/**
 * Propose an answer to an open image pin ("who is this?", "what boat?").
 * Anyone signed-in can suggest. The memory author later picks one with
 * acceptImagePinSuggestion to make it the visible tag on the photo.
 */
export async function suggestImagePinAnswer(input: {
  pinId:       string;
  suggesterId: string;
  answer:      string;
}): Promise<MemoryImagePinSuggestion> {
  const { data, error } = await supabase
    .from('memory_image_pin_suggestions')
    .insert({
      pin_id:       input.pinId,
      suggester_id: input.suggesterId,
      answer:       input.answer.trim(),
    })
    .select('*, suggester:profiles!memory_image_pin_suggestions_suggester_id_fkey(id, full_name, avatar_url)')
    .single();
  if (error) throw error;
  return data as MemoryImagePinSuggestion;
}

export async function deletePinSuggestion(suggestionId: string): Promise<void> {
  const { error } = await supabase
    .from('memory_image_pin_suggestions')
    .delete()
    .eq('id', suggestionId);
  if (error) throw error;
}

/**
 * Memory-author action: accept a suggestion. The DB function flips the
 * accepted flag, stamps the pin with the answer + credits the suggester,
 * and clears the accept flag on any sibling suggestions. Returns the
 * freshly-resolved pin.
 */
export async function acceptImagePinSuggestion(suggestionId: string): Promise<MemoryImagePin> {
  const { data, error } = await supabase.rpc('accept_image_pin_suggestion', {
    suggestion_id: suggestionId,
  });
  if (error) throw error;
  return data as MemoryImagePin;
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Searches memories by free text across title / body / era / tag slugs and
 * resolved image-pin answers — so a photo tagged "John Anderson" surfaces
 * when someone searches for him later. Backed by the search_memories RPC.
 */
export async function searchMemories(
  query: string,
  limit = 50,
): Promise<MemorySearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase.rpc('search_memories', {
    q,
    result_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as MemorySearchResult[];
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function addComment(input: {
  memoryId:   string;
  authorId:   string;
  body:       string;
  imagePinId?: string | null;
}): Promise<MemoryComment> {
  const { data, error } = await supabase
    .from('memory_comments')
    .insert({
      memory_id:    input.memoryId,
      author_id:    input.authorId,
      image_pin_id: input.imagePinId ?? null,
      body:         input.body,
    })
    .select('*, author:profiles!memory_comments_author_id_fkey(id, full_name, avatar_url)')
    .single();
  if (error) throw error;
  return data as MemoryComment;
}

export async function deleteComment(id: string): Promise<void> {
  const { error } = await supabase.from('memory_comments').delete().eq('id', id);
  if (error) throw error;
}

// ── Reactions ───────────────────────────────────────────────────────────────

export async function toggleReaction(
  memoryId: string,
  userId: string,
  kind: ReactionKind,
): Promise<{ added: boolean }> {
  // Try insert; if PK conflict, remove instead.
  const { error: insErr } = await supabase
    .from('memory_reactions')
    .insert({ memory_id: memoryId, user_id: userId, kind });

  if (!insErr) return { added: true };

  // Unique-violation = already reacted → remove
  const { error: delErr } = await supabase
    .from('memory_reactions')
    .delete()
    .eq('memory_id', memoryId)
    .eq('user_id', userId)
    .eq('kind', kind);
  if (delErr) throw delErr;
  return { added: false };
}

// ── Transcription ───────────────────────────────────────────────────────────

/**
 * Kicks the transcribe-audio edge function for a given media row. Safe to
 * call multiple times — the function will mark it 'done' or 'failed'.
 *
 * Caller doesn't have to await — the edge function writes back to
 * memory_media.transcript when done; UI subscribes to it (or polls on
 * refresh).
 */
export async function requestTranscription(mediaId: string): Promise<void> {
  await supabase.functions.invoke('transcribe-audio', {
    body: { media_id: mediaId },
  });
}

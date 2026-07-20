/**
 * lib/image-upload.ts
 *
 * Image upload helpers for OneShetland — wraps Supabase Storage with the
 * bucket / path conventions set by migration 037:
 *
 *   business-media/<business_id>/<kind>/<uuid>.<ext>   kind ∈ logo|cover|offer|service|unit
 *   employer-logos/<user_id>/<uuid>.<ext>
 *   avatars/<user_id>/<uuid>.<ext>
 *
 * All three buckets are public-read, owner-write — see migration 037 RLS.
 *
 * Picker dependency
 * -----------------
 * The image-pick step uses `expo-image-picker`. Install with:
 *
 *     npx expo install expo-image-picker
 *
 * Until installed, the picker calls in <ImagePickerField/> short-circuit
 * with a friendly error — no crash, just no upload.
 *
 * Why one helper per kind?
 * ------------------------
 * Each kind has different ownership semantics (business owner vs user) and
 * goes into a different bucket / path. Centralising here means the screens
 * stay tiny — one line to upload.
 */

import ImageColors from 'react-native-image-colors';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────────

export type BusinessMediaKind = 'logo' | 'cover' | 'offer' | 'service' | 'unit';

export interface UploadedImage {
  /** Storage path within the bucket (NOT a URL). Save this if you ever need to delete. */
  path: string;
  /** Public URL ready to display. Save this in your *_url column. */
  publicUrl: string;
}

export interface PickedFile {
  /** Local file URI from the picker (file://...) */
  uri:      string;
  /** Mime type when available (image/jpeg, image/png, image/webp). */
  mimeType?: string;
  /** Original file extension without the dot. */
  ext?:      string;
}

// ── Bucket constants ─────────────────────────────────────────────────────────

const BUCKET_BUSINESS = 'business-media';
const BUCKET_EMPLOYER = 'employer-logos';
const BUCKET_AVATAR   = 'avatars';

// ── Internals ────────────────────────────────────────────────────────────────

function extFromFile(file: PickedFile): string {
  if (file.ext)      return file.ext.replace(/^\./, '').toLowerCase();
  if (file.mimeType) return (file.mimeType.split('/')[1] || 'jpg').toLowerCase();
  const last = file.uri.split('.').pop();
  return (last && last.length <= 5 ? last : 'jpg').toLowerCase();
}

function newFilename(ext: string): string {
  // Avoid Math.random() collisions across many concurrent uploads — use a
  // crypto-random hex string when available.
  // expo-crypto is already a transitive dep via expo, but to keep this file
  // dependency-free we fall back to Date.now + a random suffix.
  const r = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${r}.${ext}`;
}

/**
 * Upload via FormData against the Supabase storage REST endpoint. The
 * SDK's blob-based upload path produces 0-byte files on React Native iOS
 * (fetch(file://…).blob() returns Blob with size 0 even though the file
 * is intact). This streams the real bytes through RN's FormData → file
 * URI bridge instead.
 */
async function uploadBlob(
  bucket: string,
  path: string,
  file: PickedFile,
): Promise<UploadedImage> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in — please sign in and try again.');

  const ext = path.split('.').pop()?.toLowerCase() ?? 'jpg';
  const contentType = file.mimeType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const filename = path.split('/').pop() ?? `upload.${ext}`;

  const form = new FormData();
  form.append('file', {
    uri:  file.uri,
    name: filename,
    type: contentType,
  } as any);

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      // apikey lets Supabase Storage resolve the JWT claims so RLS sees the
      // correct auth.uid(); without it the request can fall back to anon.
      apikey:        SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'x-upsert':    'true',
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Storage upload failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload a business-owned image. Caller must already own the business
 * (RLS enforces this; the call will reject otherwise).
 */
export async function uploadBusinessImage(
  businessId: string,
  kind: BusinessMediaKind,
  file: PickedFile,
): Promise<UploadedImage> {
  const ext = extFromFile(file);
  const path = `${businessId}/${kind}/${newFilename(ext)}`;
  return uploadBlob(BUCKET_BUSINESS, path, file);
}

/**
 * Upload a hub-owned image (logo or cover). Caller must be the hub owner or
 * committee (RLS enforces this). Path: <hub_id>/<kind>/<uuid>.<ext>
 */
export async function uploadHubImage(
  hubId: string,
  kind: 'logo' | 'cover',
  file: PickedFile,
): Promise<UploadedImage> {
  const ext = extFromFile(file);
  const path = `${hubId}/${kind}/${newFilename(ext)}`;
  return uploadBlob('hub-media', path, file);
}

/**
 * Upload a Shifts employer logo. shift_employer_profiles.id is the user id,
 * so the folder is just the current user id.
 */
export async function uploadEmployerLogo(
  userId: string,
  file: PickedFile,
): Promise<UploadedImage> {
  const ext = extFromFile(file);
  const path = `${userId}/${newFilename(ext)}`;
  return uploadBlob(BUCKET_EMPLOYER, path, file);
}

/**
 * Upload an avatar for the current user.
 */
export async function uploadAvatar(
  userId: string,
  file: PickedFile,
): Promise<UploadedImage> {
  const ext = extFromFile(file);
  const path = `${userId}/${newFilename(ext)}`;
  return uploadBlob(BUCKET_AVATAR, path, file);
}

/**
 * Upload a Spik "local variation" audio clip (the word itself, or its example
 * sentence) recorded by a contributor. Public-read bucket `spik-audio`; RLS
 * lets a signed-in user write under their own folder.
 * Path: <word_id>/<user_id>/<kind>-<uuid>.<ext>. Returns the public URL.
 */
export async function uploadSpikAudio(
  userId: string,
  wordId: number,
  kind: 'word' | 'sentence',
  file: PickedFile,
): Promise<string> {
  const ext = extFromFile(file);
  const path = `${wordId}/${userId}/${kind}-${newFilename(ext)}`;
  const { publicUrl } = await uploadBlob('spik-audio', path, file);
  return publicUrl;
}

/**
 * Delete a previously-uploaded image. Pass the stored `path` (the value
 * that was returned in {@link UploadedImage}.path), not the public URL.
 *
 * Silently ignores "object not found" — common when a UI optimistically
 * removes an image that was never actually saved.
 */
export async function deleteUploadedImage(
  bucket: 'business-media' | 'employer-logos' | 'avatars',
  path: string,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error && !/not found/i.test(error.message)) throw error;
}

// ── Brand colour extraction ────────────────────────────────────────────────

function hexLuminance(hex: string): number {
  const m = hex.replace('#', '');
  if (m.length < 6) return 0.5;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  // Perceived luminance
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isUsableBannerColor(hex: string | undefined | null): hex is string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return false;
  const lum = hexLuminance(hex);
  // Reject near-white / near-black — they make a flat, lifeless banner.
  return lum > 0.08 && lum < 0.92;
}

/**
 * Turn a dominant colour into one that's legible with white text — light/pale
 * colours get darkened toward their hue. Returns the input's hue, button-safe.
 */
export function readableAccent(hex: string | null | undefined, fallback: string): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return fallback;
  const m = hex.replace('#', '').slice(0, 6);
  let r = parseInt(m.slice(0, 2), 16);
  let g = parseInt(m.slice(2, 4), 16);
  let b = parseInt(m.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.6) {
    const f = 0.6 / lum;
    r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
  }
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Pull the dominant colour out of an image (the uploaded logo) and return a
 * banner-friendly hex string, or null if nothing usable could be extracted.
 * Picks the most saturated/representative swatch per platform and skips
 * near-white / near-black results.
 */
export async function extractBrandColor(uri: string): Promise<string | null> {
  try {
    const result = await ImageColors.getColors(uri, {
      fallback: '#475569',
      cache: true,
      key: uri,
    });

    let candidates: (string | undefined)[] = [];
    if (result.platform === 'ios') {
      candidates = [result.primary, result.detail, result.secondary, result.background];
    } else if (result.platform === 'android') {
      candidates = [result.vibrant, result.dominant, result.darkVibrant, result.muted];
    } else {
      // web
      candidates = [result.vibrant, result.dominant, result.darkVibrant, result.muted];
    }

    for (const c of candidates) {
      if (isUsableBannerColor(c)) {
        return c.startsWith('#') ? c : `#${c}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the storage path back out of a public URL produced by this helper.
 * Useful when only the *_url column was persisted and you now need to delete.
 *
 * Returns null if the URL doesn't look like one of our buckets.
 */
export function pathFromPublicUrl(
  publicUrl: string,
): { bucket: 'business-media' | 'employer-logos' | 'avatars'; path: string } | null {
  const match = publicUrl.match(/\/storage\/v1\/object\/public\/(business-media|employer-logos|avatars)\/(.+)$/);
  if (!match) return null;
  return {
    bucket: match[1] as 'business-media' | 'employer-logos' | 'avatars',
    path:   decodeURIComponent(match[2]),
  };
}

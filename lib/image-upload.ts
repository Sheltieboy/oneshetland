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

import { supabase } from './supabase';

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

async function uploadBlob(
  bucket: string,
  path: string,
  file: PickedFile,
): Promise<UploadedImage> {
  // React Native fetch on a file:// URI returns a Blob — works in both
  // simulator and on-device.
  const res = await fetch(file.uri);
  const blob = await res.blob();

  const contentType = file.mimeType ?? blob.type ?? 'image/jpeg';

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, blob, {
      contentType,
      upsert: true,            // re-uploading the same path overwrites — handy for retries
      cacheControl: '3600',
    });

  if (error) throw error;

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

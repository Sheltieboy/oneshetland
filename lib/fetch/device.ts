/**
 * lib/fetch/device.ts — the Fetch v2 steps that need the phone: choosing and preparing a photo, uploading it to the one-use address the
 * server hands out, opening directions, and the bank's check (3D Secure) on a Fetch payment.
 */
import { Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import type { FetchResult } from '@/lib/fetch-api';
import { bankCheckResult } from '@/lib/fetch/present';
import { PHOTO_QUALITY, directionsFallback, directionsUrl, photoPlan } from '@/lib/fetch/mobile';
import { settleSavedCardPayment } from '@/lib/stripe-sca';
import { fetchApi } from '@/lib/fetch/transport';

/** An idempotency key / client reference (same shape the server checks: 8–80 of A–Z a–z 0–9 _ -). */
export const fetchKey = () => Crypto.randomUUID().replace(/-/g, '');

export type PreparedPhoto = { uri: string; mime: 'image/jpeg'; size: number };

/**
 * Pick a photo (camera or library) and prepare it for Fetch. Every photo — HEIC from an iPhone, PNG, an Android camera JPEG — is
 * re-encoded on the device as a JPEG of at most 2048 px: orientation is applied, the file stays small, and no location or camera
 * metadata goes with it. The server's own type check is unchanged (JPEG/PNG/WEBP only).
 */
export async function pickFetchPhoto(source: 'camera' | 'library'): Promise<{ ok: true; photo: PreparedPhoto } | { ok: false; message: string } | null> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, message: source === 'camera' ? 'Please allow camera access in Settings to take a photo.' : 'Please allow photo access in Settings to choose a photo.' };
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false, allowsEditing: false,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible };
  const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets?.length) return null;
  return prepareFetchPhoto(res.assets[0]);
}

export async function prepareFetchPhoto(asset: { uri: string; width?: number; height?: number; mimeType?: string | null; fileSize?: number | null }):
  Promise<{ ok: true; photo: PreparedPhoto } | { ok: false; message: string }> {
  const plan = photoPlan(asset);
  try {
    const out = await manipulateAsync(asset.uri, plan.resize ? [{ resize: plan.resize }] : [], { format: SaveFormat.JPEG, compress: PHOTO_QUALITY });
    const info = await fetch(out.uri).then((r) => r.blob()).then((b) => b.size).catch(() => 0);
    if (info > 10 * 1024 * 1024) return { ok: false, message: 'That photo is too large (10 MB at most).' };
    return { ok: true, photo: { uri: out.uri, mime: plan.mime, size: info || 1 } };
  } catch {
    return { ok: false, message: plan.wasHeic
      ? "We couldn't convert that photo. Please try another, or take a new one."
      : "We couldn't prepare that photo. Please try another." };
  }
}

/** Upload a prepared photo: ask for a one-use address, send the file straight there, then ask the server to check and register it. */
export async function uploadFetchPhoto(photo: PreparedPhoto,
  begin: (mime: string, size: number) => Promise<FetchResult<{ upload_id: string; upload_url: string }>>,
  submit: (uploadId: string) => Promise<FetchResult<unknown>>): Promise<{ ok: true } | { ok: false; message: string }> {
  const b = await begin(photo.mime, photo.size);
  if (!b.ok) return { ok: false, message: b.message };
  try {
    const put = await uploadAsync(b.data.upload_url, photo.uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { 'content-type': photo.mime, 'x-upsert': 'false' } });
    if (put.status < 200 || put.status >= 300) return { ok: false, message: "The upload didn't go through. Please try again." };
  } catch { return { ok: false, message: "The upload didn't go through. Please check your connection and try again." }; }
  const s = await submit(b.data.upload_id);
  return s.ok ? { ok: true } : { ok: false, message: s.message };
}

/** Directions in the platform's maps app; Google Maps on the web if that can't open. */
export async function openDirections(address: string) {
  const url = directionsUrl(address, Platform.OS);
  try {
    if (await Linking.canOpenURL(url)) { await Linking.openURL(url); return; }
  } catch { /* fall through */ }
  await Linking.openURL(directionsFallback(address));
}

/**
 * The bank's check on a Fetch payment. The server hands out its own client secret; the Stripe SDK runs the check; then the server is
 * asked for the real state, which decides what we say (a successful check on a hold is requires_capture, not "succeeded").
 */
export async function confirmWithBank(requestId: string): Promise<{ ok: boolean; text: string }> {
  const r = await fetchApi.payment(requestId, 'complete');
  if (!r.ok) return { ok: false, text: r.message };
  if (r.data.payment === 'authorised') return { ok: true, text: 'Payment authorisation confirmed.' };
  if (!r.data.client_secret) return { ok: false, text: "Your bank's check isn't available just now. Please try again." };
  const out = await settleSavedCardPayment({ status: 'requires_action', clientSecret: r.data.client_secret });
  const after = await fetchApi.payment(requestId, 'refresh');
  return bankCheckResult(after.ok ? after.data.payment : null, out.outcome);
}

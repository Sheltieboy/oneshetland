/**
 * fetch-v2-photos.ts — Fetch v2 photos and the administrator support actions (docs/FETCH_V2_IMPLEMENTATION.md, Step 9).
 *
 * fetch-v2-photos (members) and the `support` area of fetch-v2-admin are thin wrappers around these handlers. The database decides who
 * may add which photo to which job and when (fetch_v2_photo_problem) and who may see it (fetch_v2_photo_for_view); this module moves
 * bytes. Messages and issue reports need no storage and are plain database calls (fetch_v2_send_message, fetch_v2_report_issue).
 *
 * Upload: begin_upload → one-use signed upload to a server-chosen path in the private fetch-photos bucket → submit, which reads the
 * stored object back, accepts only real JPEG / PNG / WEBP bytes up to 10 MB, strips embedded metadata (location, device, comments) and
 * writes the clean bytes back before the photo is registered. Viewing: short-lived signed links only — 60 seconds for members, 120
 * for administrators. Storage paths never leave the server.
 */
import { sniffType } from './fetch-v2-verification.ts';
import { stripImageMetadata } from './image-metadata.ts';

export interface PhotoStorage {
  signedUpload: (path: string) => Promise<{ url: string; token: string }>;
  read: (path: string) => Promise<Uint8Array | null>;
  write: (path: string, bytes: Uint8Array, mime: string) => Promise<void>;
  signedUrl: (path: string, ttlSecs: number) => Promise<string>;
  remove: (path: string) => Promise<void>;
}
export type RpcResult = { data: unknown; error: unknown };
export interface PhotoDeps {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  storage: PhotoStorage;
  limit: (userId: string, actions: string[]) => Promise<boolean>;
}
export type Outcome = { status: number; body: Record<string, unknown> };

export const MEMBER_LINK_SECS = 60;
export const ADMIN_LINK_SECS = 120;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const KINDS = ['item', 'collection', 'delivery', 'return', 'issue'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  not_found: 404, invalid_request: 400, invalid_kind: 400, reason_required: 400, resolution_required: 400, file_type_not_allowed: 415,
  file_type_mismatch: 415, file_too_large: 413, upload_missing: 409, upload_expired: 410, too_many_uploads: 429, too_many_photos: 409,
  item_photos_closed: 409, invalid_state: 409, issue_closed: 409, forbidden: 403, fetch_unavailable: 403, rate_limited: 429, unauthorised: 401,
};
const refuse = (code: string, extra: Record<string, unknown> = {}): Outcome => ({ status: STATUS[code] ?? 422, body: { ok: false, code, ...extra } });
const SERVER_ERROR: Outcome = { status: 500, body: { ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' } };

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
class RpcFailure extends Error {
  readonly detail: unknown;
  constructor(fn: string, detail: unknown) { super(`rpc ${fn} failed`); this.detail = detail; }
}
async function call(deps: PhotoDeps, fn: string, args: Record<string, unknown>): Promise<Json> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) throw new RpcFailure(fn, error);
  return (Array.isArray(data) ? data[0] : data) as Json;
}
const fromSql = (d: Json): Outcome | null => (d?.ok === false ? refuse(String(d.code)) : null);
const wrap = async (f: () => Promise<Outcome>): Promise<Outcome> => {
  try { return await f(); } catch (e) {
    const t = e instanceof RpcFailure ? JSON.stringify(e.detail) : '';
    if (/Fetch is not available/.test(t)) return refuse('fetch_unavailable');
    if (/Only an administrator/.test(t)) return refuse('forbidden');
    if (/A Fetch action needs a signed-in member/.test(t)) return refuse('unauthorised');
    return SERVER_ERROR;
  }
};
const guard = async (userId: string | null, deps: PhotoDeps, actions: string[]): Promise<Outcome | null> => {
  if (!userId) return refuse('unauthorised');
  if (!(await deps.limit(userId, actions))) return refuse('rate_limited');
  return null;
};
const id = (b: Json, k: string) => (typeof b[k] === 'string' && UUID.test(b[k]) ? b[k] as string : null);

/** A member's photo actions: begin_upload, submit, discard_upload, view (participant), view_board (a driver browsing jobs). */
export function handlePhotos(userId: string | null, body: unknown, deps: PhotoDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(userId, deps, ['fetch_v2_photos']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    switch (b.action) {
      case 'begin_upload': {
        if (!id(b, 'request_id') || !KINDS.includes(b.kind) || typeof b.mime_type !== 'string' || !Number.isInteger(b.size_bytes)) return refuse('invalid_request');
        if (!TYPES.includes(b.mime_type)) return refuse('file_type_not_allowed');
        if (b.size_bytes > MAX_PHOTO_BYTES) return refuse('file_too_large');
        const out = await call(deps, 'fetch_v2_begin_photo_upload', { p_actor: userId, p_request: id(b, 'request_id'), p_kind: b.kind,
          p_mime: b.mime_type, p_size: b.size_bytes, p_issue: id(b, 'issue_id'), p_matching_visible: b.show_on_board === true });
        const r = fromSql(out);
        if (r) return r;
        const signed = await deps.storage.signedUpload(out.storage_path);
        return { status: 200, body: { ok: true, upload_id: out.upload_id, upload_url: signed.url, upload_token: signed.token,
          expires_at: out.expires_at, max_bytes: MAX_PHOTO_BYTES } };
      }
      case 'submit': {
        const up = id(b, 'upload_id');
        if (!up) return refuse('invalid_request');
        const u = await call(deps, 'fetch_v2_pending_photo_upload', { p_actor: userId, p_upload: up });
        const r = fromSql(u);
        if (r) return r;
        if (u.consumed) return { status: 200, body: { ok: true, already: true, photo_id: u.photo_id } };
        if (u.expired) return refuse('upload_expired');
        const raw = await deps.storage.read(u.storage_path);
        if (!raw) return refuse('upload_missing');
        const bad = raw.length < 1 || raw.length > MAX_PHOTO_BYTES ? 'file_too_large' : sniffType(raw.subarray(0, 16)) !== u.mime_type ? 'file_type_mismatch' : null;
        if (bad) {
          await deps.storage.remove(u.storage_path);
          await call(deps, 'fetch_v2_discard_photo_upload', { p_actor: userId, p_upload: up });
          return refuse(bad);
        }
        const clean = stripImageMetadata(raw, u.mime_type);
        if (clean !== raw) await deps.storage.write(u.storage_path, clean, u.mime_type);
        const out = await call(deps, 'fetch_v2_register_photo', { p_actor: userId, p_upload: up, p_size: clean.length, p_mime: u.mime_type });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true, photo_id: out.photo_id, kind: out.kind } };
      }
      case 'discard_upload': {
        const up = id(b, 'upload_id');
        if (!up) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_discard_photo_upload', { p_actor: userId, p_upload: up });
        const r = fromSql(out);
        if (r) return r;
        await deps.storage.remove(out.storage_path);
        return { status: 200, body: { ok: true } };
      }
      case 'view':
      case 'view_board': {
        const ph = id(b, 'photo_id');
        if (!ph) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_photo_for_view', { p_actor: userId, p_photo: ph, p_purpose: b.action === 'view' ? 'party' : 'board' });
        const r = fromSql(out);
        if (r) return r;
        return { status: 200, body: { ok: true, url: await deps.storage.signedUrl(out.storage_path, MEMBER_LINK_SECS), expires_in: MEMBER_LINK_SECS } };
      }
      default:
        return refuse('invalid_request');
    }
  });
}

/** Administrator support actions (fetch-v2-admin, area "support"). Every change needs a reason and is recorded by the database. */
export function handleSupportAdmin(adminId: string | null, body: unknown, deps: PhotoDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(adminId, deps, ['fetch_v2_admin']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 2000) : null;
    switch (b.action) {
      case 'record': {
        if (!id(b, 'request_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_support_record', { p_admin: adminId, p_request: id(b, 'request_id') });
        return fromSql(out) ?? { status: 200, body: out };
      }
      case 'hide_message': {
        if (!id(b, 'message_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_hide_message', { p_admin: adminId, p_message: id(b, 'message_id'), p_reason: reason });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true } };
      }
      case 'resolve_issue': {
        if (!id(b, 'issue_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_resolve_issue', { p_admin: adminId, p_issue: id(b, 'issue_id'), p_resolution: reason });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true } };
      }
      case 'remove_photo': {
        if (!id(b, 'photo_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_remove_photo', { p_admin: adminId, p_photo: id(b, 'photo_id'), p_reason: reason });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true } };
      }
      case 'view_photo': {
        if (!id(b, 'photo_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_photo_for_view', { p_actor: adminId, p_photo: id(b, 'photo_id'), p_purpose: 'admin' });
        const r = fromSql(out);
        if (r) return r;
        return { status: 200, body: { ok: true, url: await deps.storage.signedUrl(out.storage_path, ADMIN_LINK_SECS), expires_in: ADMIN_LINK_SECS,
          removed: out.removed === true, evidence_held: out.evidence_held === true } };
      }
      default:
        return refuse('invalid_request');
    }
  });
}

/** Lapsed, never-submitted photo uploads: remove the object, then forget it. */
export async function runPhotoSweep(deps: PhotoDeps): Promise<Record<string, number>> {
  const out = { uploads_removed: 0, errors: 0 };
  const { data, error } = await deps.rpc('fetch_v2_stale_photo_uploads', {});
  if (error) { out.errors++; return out; }
  for (const u of (data ?? []) as Json[]) {
    try {
      await deps.storage.remove(u.storage_path);
      const d = await call(deps, 'fetch_v2_discard_photo_upload', { p_actor: u.uploader_id, p_upload: u.upload_id });
      if (d?.ok) out.uploads_removed++;
    } catch { out.errors++; }
  }
  return out;
}

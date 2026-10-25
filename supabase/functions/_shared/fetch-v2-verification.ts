/**
 * fetch-v2-verification.ts — Fetch v2 driver verification (docs/FETCH_V2_IMPLEMENTATION.md, Step 6).
 *
 * become-driver (apply), fetch-v2-driver-verification (the driver's own evidence) and the `drivers` area of fetch-v2-admin
 * (review and decisions) are thin wrappers around these handlers. Every dependency (database RPC, document storage, rate limiter)
 * is injected, so the same code runs in production and — against a throwaway database with an in-memory store — in the isolated suite.
 *
 * Rules this layer keeps:
 *   · Approval, review outcomes, expiry dates and verification_ok_until are never read from a client. The database decides them in
 *     audited functions; a driver can only apply, describe their vehicle and hand in evidence.
 *   · Evidence goes to a path the server generated, through a short-lived signed upload. Before it is accepted, the stored object is
 *     read back: its real size, and its real type from the file's first bytes (not the name, not the declared type).
 *   · Documents are only ever shown through short-lived signed links: the driver their own (60s), a reviewer any (120s, audited).
 *     Storage paths, reviewer identities and provider text never leave the server.
 *   · Answers are { status, body } with a stable code (and, for the original apply forms, an `error` sentence).
 */

export type RpcResult = { data: unknown; error: unknown };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
export interface EvidenceStorage {
  /** A one-use signed upload to exactly this path (never an overwrite). */
  signedUpload: (path: string) => Promise<{ url: string; token: string }>;
  /** The stored object's size and first bytes, or null if nothing is there. */
  inspect: (path: string) => Promise<{ size: number; head: Uint8Array } | null>;
  signedUrl: (path: string, ttlSecs: number) => Promise<string>;
  remove: (path: string) => Promise<void>;
}
export interface VerificationDeps {
  rpc: Rpc;
  storage: EvidenceStorage;
  limit: (userId: string, actions: string[]) => Promise<boolean>;
}
export type Outcome = { status: number; body: Record<string, unknown> };

export const DRIVER_LINK_SECS = 60;
export const REVIEWER_LINK_SECS = 120;
export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  not_found: 404, invalid_request: 400, reason_required: 400, invalid_vehicle: 400, registration_required: 400, size_exceeds_vehicle: 400,
  file_type_not_allowed: 415, file_type_mismatch: 415, file_too_large: 413, upload_missing: 409, upload_expired: 410, too_many_uploads: 429,
  evidence_kind_not_required: 400, driver_not_applied: 409, driver_suspended: 403, driver_vehicle_missing: 409, invalid_state: 409,
  expiry_required: 400, expiry_out_of_range: 400, evidence_incomplete: 409, cannot_review_own: 403, guidance_required: 400,
  file_deleted: 410, age_confirmation_required: 403, member_restricted: 403, fetch_unavailable: 403, forbidden: 403,
};
const SENTENCE: Record<string, string> = {
  driver_suspended: 'Your driver account is suspended. Please contact OneShetland.',
  age_confirmation_required: 'Please confirm you are 18 or over before applying to drive.',
  member_restricted: 'Your account cannot apply to drive at the moment. Please contact OneShetland.',
  fetch_unavailable: 'Fetch is not available yet.',
  registration_required: 'Please enter your vehicle registration.',
  invalid_vehicle: 'Please choose your vehicle.',
  size_exceeds_vehicle: 'That item size is too large for this vehicle.',
  rate_limited: 'Too many attempts. Please try again later.',
};

const refuse = (code: string, extra: Record<string, unknown> = {}, status?: number): Outcome =>
  ({ status: status ?? STATUS[code] ?? 422, body: { ok: false, code, ...(SENTENCE[code] ? { error: SENTENCE[code] } : {}), ...extra } });
const SERVER_ERROR: Outcome = { status: 500, body: { ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' } };

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
class RpcFailure extends Error {
  readonly detail: unknown;
  constructor(fn: string, detail: unknown) { super(`rpc ${fn} failed`); this.detail = detail; }
}
async function call(deps: VerificationDeps, fn: string, args: Record<string, unknown>): Promise<Json> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) throw new RpcFailure(fn, error);
  return (Array.isArray(data) ? data[0] : data) as Json;
}
const fromSql = (d: Json, keep: string[] = []): Outcome | null => {
  if (d?.ok !== false) return null;
  const extra: Json = {};
  for (const k of keep) if (d[k] !== undefined) extra[k] = d[k];
  return refuse(String(d.code), extra);
};
const wrap = async (f: () => Promise<Outcome>): Promise<Outcome> => {
  try { return await f(); } catch (e) {
    const t = e instanceof RpcFailure ? JSON.stringify(e.detail) : '';
    if (/Fetch is not available/.test(t)) return refuse('fetch_unavailable');
    if (/Only an administrator/.test(t)) return refuse('forbidden');
    if (/A Fetch action needs a signed-in member/.test(t)) return refuse('unauthorised', {}, 401);
    return SERVER_ERROR;
  }
};
const guard = async (userId: string | null, deps: VerificationDeps, actions: string[]): Promise<Outcome | null> => {
  if (!userId) return refuse('unauthorised', { error: 'Please sign in.' }, 401);
  if (!(await deps.limit(userId, actions))) return refuse('rate_limited', {}, 429);
  return null;
};
const reason = (v: unknown) => (typeof v === 'string' ? v.slice(0, 1000) : null);

/** The real type of a file from its first bytes. HEIC and HEIF are one family. */
export function sniffType(head: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((x, k) => head[i + k] === x);
  const ascii = (i: number, n: number) => String.fromCharCode(...head.slice(i, i + n));
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}
const sameFamily = (declared: string, real: string | null) =>
  real !== null && (declared === real || (declared.startsWith('image/hei') && real.startsWith('image/hei')));

// ── apply (become-driver) ───────────────────────────────────────────────────────────────────────────────────────────────────
/** A member applies to drive. The result is always `pending` (or an unchanged approved account); never approval. */
export function handleApply(userId: string | null, body: unknown, deps: VerificationDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(userId, deps, ['fetch_v2_apply']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    // Allow-list. Anything else in the body (driver_status, verification_ok_until, decided_by, …) is never forwarded.
    const p: Json = {};
    for (const k of ['vehicle_type', 'vehicle_reg', 'statement', 'vehicle_class', 'max_size_class', 'can_two_person_lift']) {
      if (b[k] !== undefined && b[k] !== null) p[k] = k === 'can_two_person_lift' ? b[k] === true : String(b[k]).slice(0, 1000);
    }
    if (!p.vehicle_class && !(typeof p.vehicle_reg === 'string' && p.vehicle_reg.trim())) {
      return refuse('registration_required', { error: 'Vehicle type and registration are required.' }, 400);
    }
    const out = await call(deps, 'fetch_v2_apply_driver', { p_user: userId, p });
    return fromSql(out) ?? { status: 200, body: { ok: true, driver_status: out.driver_status, already: out.already === true } };
  });
}

// ── the driver's own evidence ───────────────────────────────────────────────────────────────────────────────────────────────
export function handleDriverVerification(userId: string | null, body: unknown, deps: VerificationDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(userId, deps, ['fetch_v2_verification']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    switch (b.action) {
      case 'status':
        return { status: 200, body: { ok: true, ...(await call(deps, 'fetch_v2_verification_summary', { p_driver: userId })) } };

      case 'set_vehicle': {
        const p: Json = {};
        for (const k of ['vehicle_class', 'max_size_class', 'vehicle_reg']) if (typeof b[k] === 'string') p[k] = b[k].slice(0, 40);
        p.can_two_person_lift = b.can_two_person_lift === true;
        const out = await call(deps, 'fetch_v2_set_vehicle', { p_driver: userId, p });
        return fromSql(out) ?? { status: 200, body: { ok: true, re_verification_required: out.re_verification_required === true,
          already: out.already === true } };
      }

      case 'begin_upload': {
        if (typeof b.kind !== 'string' || typeof b.mime_type !== 'string' || !Number.isInteger(b.size_bytes)) return refuse('invalid_request');
        if (!(ALLOWED_TYPES as readonly string[]).includes(b.mime_type)) return refuse('file_type_not_allowed');
        if (b.size_bytes > MAX_BYTES) return refuse('file_too_large');
        const out = await call(deps, 'fetch_v2_begin_evidence_upload',
          { p_driver: userId, p_kind: b.kind, p_mime: b.mime_type, p_size: b.size_bytes });
        const r = fromSql(out);
        if (r) return r;
        const signed = await deps.storage.signedUpload(out.storage_path);
        return { status: 200, body: { ok: true, upload_id: out.upload_id, upload_url: signed.url, upload_token: signed.token,
          expires_at: out.expires_at, max_bytes: MAX_BYTES } };
      }

      case 'submit': {
        if (typeof b.upload_id !== 'string' || !UUID.test(b.upload_id)) return refuse('invalid_request');
        const u = await call(deps, 'fetch_v2_pending_evidence_upload', { p_driver: userId, p_upload: b.upload_id });
        const r = fromSql(u);
        if (r) return r;
        if (u.consumed) {
          const again = await call(deps, 'fetch_v2_submit_evidence', { p_driver: userId, p_upload: b.upload_id, p_size: 1, p_mime: u.mime_type });
          return fromSql(again) ?? { status: 200, body: { ok: true, already: true, item_id: again.item_id, kind: again.kind,
            version: again.version, status: again.status } };
        }
        if (u.expired) return refuse('upload_expired');
        const obj = await deps.storage.inspect(u.storage_path);
        if (!obj) return refuse('upload_missing');
        const bad = obj.size < 1 || obj.size > MAX_BYTES ? 'file_too_large' : !sameFamily(u.mime_type, sniffType(obj.head)) ? 'file_type_mismatch' : null;
        if (bad) {
          await deps.storage.remove(u.storage_path);
          await call(deps, 'fetch_v2_discard_evidence_upload', { p_driver: userId, p_upload: b.upload_id });
          return refuse(bad);
        }
        const out = await call(deps, 'fetch_v2_submit_evidence', { p_driver: userId, p_upload: b.upload_id, p_size: obj.size, p_mime: u.mime_type });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true, item_id: out.item_id, kind: out.kind,
          version: out.version, status: out.status } };
      }

      case 'discard_upload': {
        if (typeof b.upload_id !== 'string' || !UUID.test(b.upload_id)) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_discard_evidence_upload', { p_driver: userId, p_upload: b.upload_id });
        const r = fromSql(out);
        if (r) return r;
        await deps.storage.remove(out.storage_path);
        return { status: 200, body: { ok: true } };
      }

      case 'view_own': {
        if (typeof b.item_id !== 'string' || !UUID.test(b.item_id)) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_evidence_file_for', { p_actor: userId, p_item: b.item_id, p_purpose: 'driver' });
        const r = fromSql(out);
        if (r) return r;
        return { status: 200, body: { ok: true, url: await deps.storage.signedUrl(out.storage_path, DRIVER_LINK_SECS),
          expires_in: DRIVER_LINK_SECS, mime_type: out.mime_type } };
      }

      default:
        return refuse('invalid_request');
    }
  });
}

// ── review and decisions (fetch-v2-admin, area "drivers") ───────────────────────────────────────────────────────────────────
/** Every action is checked as a reviewer by the database (fetch_v2_require_reviewer) and audited there. */
export function handleVerificationAdmin(adminId: string | null, body: unknown, deps: VerificationDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(adminId, deps, ['fetch_v2_admin']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    const id = (k: string) => (typeof b[k] === 'string' && UUID.test(b[k]) ? b[k] : null);
    switch (b.action) {
      case 'queue':
        return { status: 200, body: { ok: true, ...(await call(deps, 'fetch_v2_verification_queue', { p_reviewer: adminId })) } };

      case 'driver_record': {
        if (!id('driver_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_driver_verification_record', { p_reviewer: adminId, p_driver: id('driver_id') });
        return fromSql(out) ?? { status: 200, body: { ok: true, ...out } };
      }

      case 'review': {
        if (!id('item_id') || !['approve', 'reject', 'request_replacement'].includes(b.outcome)) return refuse('invalid_request');
        // The date printed on the document; the database treats it as valid through the end of that day in the UK.
        let expires: string | null = null;
        if (b.expires_on !== undefined && b.expires_on !== null) {
          if (typeof b.expires_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.expires_on) || Number.isNaN(Date.parse(b.expires_on))) return refuse('invalid_request');
          expires = b.expires_on;
        }
        const out = await call(deps, 'fetch_v2_review_evidence', { p_reviewer: adminId, p_item: id('item_id'), p_outcome: b.outcome,
          p_reason: reason(b.reason), p_expires_on: expires });
        return fromSql(out) ?? { status: 200, body: { ok: true, item_id: out.item_id, status: out.status, already: out.already === true,
          evidence_complete: out.evidence_complete === true, missing: out.missing ?? [] } };
      }

      case 'decide': {
        if (!id('driver_id') || !['approve', 'reject', 'suspend', 'reinstate'].includes(b.decision)) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_decide_driver', { p_reviewer: adminId, p_driver: id('driver_id'), p_decision: b.decision,
          p_reason: reason(b.reason) });
        return fromSql(out, ['missing', 'driver_status']) ?? { status: 200, body: { ok: true, driver_status: out.driver_status,
          already: out.already === true, live_jobs: out.live_jobs ?? 0 } };
      }

      case 'set_requirement': {
        const p: Json = {};
        for (const k of ['vehicle_class', 'evidence_kind', 'guidance_text', 'reason']) if (typeof b[k] === 'string') p[k] = b[k].slice(0, 1000);
        for (const k of ['required', 'needs_expiry', 'per_vehicle', 'active']) if (typeof b[k] === 'boolean') p[k] = b[k];
        const out = await call(deps, 'fetch_v2_set_requirement', { p_admin: adminId, p });
        return fromSql(out) ?? { status: 200, body: { ok: true, drivers_affected: out.drivers_affected ?? 0 } };
      }

      case 'view_evidence': {
        if (!id('item_id')) return refuse('invalid_request');
        const out = await call(deps, 'fetch_v2_evidence_file_for', { p_actor: adminId, p_item: id('item_id'), p_purpose: 'reviewer' });
        const r = fromSql(out);
        if (r) return r;
        return { status: 200, body: { ok: true, url: await deps.storage.signedUrl(out.storage_path, REVIEWER_LINK_SECS),
          expires_in: REVIEWER_LINK_SECS, mime_type: out.mime_type } };
      }

      case 'delete_file': {
        // Storage first, then the record: a failure in between leaves a record that still says "file present", never a file the
        // record says is gone. Retrying is safe (removing a missing object is a no-op).
        if (!id('item_id')) return refuse('invalid_request');
        const why = reason(b.reason);
        if (!why || why.trim().length < 3) return refuse('reason_required');
        const f = await call(deps, 'fetch_v2_evidence_file_for', { p_actor: adminId, p_item: id('item_id'), p_purpose: 'delete' });
        if (f?.ok === false && f.code !== 'file_deleted') return refuse(String(f.code));
        if (f?.ok !== false) await deps.storage.remove(f.storage_path);
        const out = await call(deps, 'fetch_v2_record_evidence_file_deleted', { p_admin: adminId, p_item: id('item_id'), p_reason: why });
        return fromSql(out) ?? { status: 200, body: { ok: true, already: out.already === true } };
      }

      default:
        return refuse('invalid_request');
    }
  });
}

// ── the timed sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Expiry, reminders and lapsed-driver issues (database), then removal of abandoned uploads (storage, then record). */
export async function runVerificationSweep(deps: VerificationDeps): Promise<Record<string, number>> {
  const out: Record<string, number> = { expired: 0, expiring: 0, drivers_synced: 0, issues_opened: 0, uploads_removed: 0, errors: 0 };
  try {
    const s = await call(deps, 'fetch_v2_verification_sweep', {});
    for (const k of ['expired', 'expiring', 'drivers_synced', 'issues_opened']) out[k] = Number(s?.[k] ?? 0);
  } catch { out.errors++; }
  try {
    const { data, error } = await deps.rpc('fetch_v2_stale_evidence_uploads', {});
    if (error) throw new RpcFailure('fetch_v2_stale_evidence_uploads', error);
    for (const u of (data ?? []) as Json[]) {
      try {
        await deps.storage.remove(u.storage_path);
        const d = await call(deps, 'fetch_v2_discard_evidence_upload', { p_driver: u.driver_id, p_upload: u.upload_id });
        if (d?.ok) out.uploads_removed++;
      } catch { out.errors++; }
    }
  } catch { out.errors++; }
  return out;
}

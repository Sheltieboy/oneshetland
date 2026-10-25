/**
 * fetch-api.ts — the one typed web interface to Fetch v2 (oneshetland-delivers docs/FETCH_V2_IMPLEMENTATION.md, Step 11).
 *
 * Every Fetch v2 call the website makes goes through here, over an injected transport (lib/fetch/transport.server.ts on the server;
 * a fake in tests). It never writes a table: changes are the authoritative database functions and edge functions of Steps 3–11, and
 * direct reads are limited to the job's event timeline (party-readable by design) and the public reference tables. No money value is
 * ever sent by the client — prices, holds, fees and captures are the server's.
 *
 * Pure (no React, no Next, no Supabase import), so it runs under plain node.
 */

export type FetchResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string; field?: string; end?: string };
export interface FetchTransport {
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
  invoke(fn: string, body: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  read(table: "fetch_request_events" | "regions" | "delivery_categories", columns: string, filter?: { column: string; value: string }): Promise<{ data: unknown; error: { message?: string } | null }>;
}

/** The functions and edge functions this module may call — nothing else (tests hold it to this). */
export const FETCH_RPCS = ["fetch_v2_my_eligibility", "fetch_v2_confirm_adult", "fetch_v2_request_detail", "fetch_v2_heading_that_way",
  "fetch_v2_cancel_open", "fetch_v2_request_cancellation", "fetch_v2_decline_cancellation", "fetch_v2_extend", "fetch_v2_confirm_ready",
  "fetch_v2_mark_arrived", "fetch_v2_mark_collected", "fetch_v2_mark_undeliverable", "fetch_v2_report_return", "fetch_v2_create_run",
  "fetch_v2_cancel_run", "fetch_v2_board", "fetch_v2_messages", "fetch_v2_send_message", "fetch_v2_report_issue", "fetch_v2_my_issues",
  "fetch_v2_photos", "fetch_v2_set_item_photo", "fetch_v2_my_requests", "fetch_v2_my_jobs", "fetch_v2_my_runs",
  "fetch_v2_set_my_areas"] as const;
export const FETCH_EDGES = ["fetch-v2-quote", "fetch-v2-create", "fetch-v2-accept", "fetch-v2-payment", "fetch-v2-driver", "fetch-v2-photos",
  "fetch-v2-driver-verification", "become-driver"] as const;

/** Server refusal codes, in plain English for members. Stable: screens key on the code, show the message. */
export const FETCH_MESSAGES: Record<string, string> = {
  fetch_unavailable: "Fetch isn't available to you yet.",
  age_confirmation_required: "Please confirm you're 18 or over to use Fetch.",
  member_restricted: "Your account can't use Fetch at the moment. Please contact OneShetland.",
  payment_method_required: "Please add a payment card to your account before posting a Fetch.",
  card_check_failed: "We couldn't check your payment card just now. Please try again in a moment.",
  location_unresolved: "We couldn't find that address. Please check it, or add a postcode.",
  location_service_unavailable: "We couldn't look up addresses just now. Please try again in a moment.",
  outside_service_area: "Fetch only covers Shetland. Please check the postcode.",
  area_not_supported: "Fetch doesn't cover that island yet.",
  region_mismatch: "That address isn't in the area you picked. Please check the area.",
  liability_required: "Please confirm the note about pharmacy and takeaway items.",
  item_photo_required: "A photo of the item is needed before a driver can accept a bulky Fetch.",
  already_taken: "Another driver accepted this Fetch just before you.",
  not_claimable: "This Fetch is no longer available.",
  own_request: "This is your own Fetch.",
  vehicle_confirmation_required: "Please confirm the item will fit in your vehicle.",
  too_large_for_vehicle: "This item is too large for the vehicle on your driver profile.",
  two_person_lift_required: "This item needs two people to lift it.",
  driver_not_approved: "Your driver application hasn't been approved yet.",
  driver_suspended: "Your driver account is paused. Please contact OneShetland.",
  driver_vehicle_missing: "Please add your vehicle to your driver profile.",
  driver_verification_expired: "One of your driver documents has expired. Please upload a renewed copy.",
  driver_verification_incomplete: "Your driver documents aren't complete yet.",
  driver_payouts_not_enabled: "Please set up your payouts before taking a Fetch.",
  self_payment: "You can't take a Fetch that would be paid into your own account.",
  payment_could_not_start: "The payment couldn't be started. The Fetch has gone back on the board.",
  payment_not_ready: "The payment isn't confirmed yet, so the item can't be collected.",
  cancellation_pending: "The requester has asked to cancel. Please answer that first.",
  capture_pending: "The payment is still being confirmed. Please try again in a moment.",
  capture_failed: "The payment couldn't be taken, so this delivery isn't marked complete yet. OneShetland has been told and will be in touch.",
  capture_exceeds_hold: "The payment couldn't be taken, so this delivery isn't marked complete yet. OneShetland has been told and will be in touch.",
  capture_in_progress: "The payment is being taken right now. Please wait a moment and refresh.",
  delivery_photo_required: "Please add a photo of where you left the item.",
  safe_place_not_allowed: "The requester didn't agree to a safe place for this Fetch.",
  return_photo_required: "Please add a photo of the item being returned.",
  extension_limit: "This Fetch has already been extended as far as it can be.",
  cancel_directly: "You can cancel this Fetch directly.",
  cannot_cancel_after_collection: "The item has already been collected, so it can't be cancelled now. Report a problem instead.",
  no_driver_yet: "You can message once a driver has accepted.",
  message_empty: "Please write a message.",
  message_too_long: "That message is too long (1,000 characters at most).",
  message_window_closed: "Messages for this Fetch have closed.",
  issue_window_closed: "Problems can be reported up to 72 hours after a Fetch finishes.",
  invalid_kind: "Please choose what kind of problem it is.",
  rate_limited: "That's a lot of requests in a short time. Please wait a moment.",
  file_type_not_allowed: "Please use a JPEG, PNG or WEBP photo.",
  file_type_mismatch: "That file isn't a photo we can use. Please choose a JPEG, PNG or WEBP.",
  file_too_large: "That photo is too large (10 MB at most).",
  upload_expired: "That upload took too long. Please try again.",
  too_many_photos: "You've added as many photos as allowed here.",
  item_photos_closed: "Item photos can't be changed once a driver has accepted.",
  evidence_kind_not_required: "That document isn't needed for your vehicle.",
  registration_required: "Please enter your vehicle registration.",
  size_exceeds_vehicle: "That size is too large for this vehicle.",
  invalid_vehicle: "Please choose your vehicle.",
  driver_not_applied: "Please apply to drive first.",
  too_many_open_runs: "You already have the most journeys you can post at once.",
  invalid_state: "This Fetch has moved on. Please refresh the page.",
  invalid_transition: "That isn't possible at this stage. Please refresh the page.",
  not_found: "We couldn't find that Fetch.",
  unauthorised: "Please sign in.",
  invalid_request: "Something in those details isn't right. Please check and try again.",
  server_error: "Something went wrong. Please try again.",
};
export const fetchMessage = (code: string) => FETCH_MESSAGES[code] ?? FETCH_MESSAGES.server_error;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, extra: Json = {}): { ok: false; code: string; message: string } & Json => ({ ok: false, code, message: fetchMessage(code), ...extra });

/** A PostgREST error from a Fetch function, to a stable code. */
function codeFromDbError(e: { message?: string } | null): string {
  const m = e?.message ?? "";
  if (/Fetch request not found|P0002/.test(m)) return "not_found";
  if (/Fetch is not available|42501.*Fetch/.test(m)) return "fetch_unavailable";
  if (/can take Fetch jobs \((\w+)\)/.test(m)) return /can take Fetch jobs \((\w+)\)/.exec(m)![1];
  if (/permission denied|JWT|not authenticated/i.test(m)) return "unauthorised";
  return "server_error";
}

export class FetchApi {
  private readonly t: FetchTransport;
  constructor(transport: FetchTransport) { this.t = transport; }

  private async rpc<T = Json>(fn: (typeof FETCH_RPCS)[number], args?: Record<string, unknown>): Promise<FetchResult<T>> {
    try {
      const { data, error } = await this.t.rpc(fn, args);
      if (error) return fail(codeFromDbError(error));
      const d = data as Json;
      if (d && typeof d === "object" && !Array.isArray(d) && d.ok === false) return fail(String(d.code ?? "server_error"), pick(d));
      return { ok: true, data: d as T };
    } catch { return fail("server_error"); }
  }
  private async edge<T = Json>(fn: (typeof FETCH_EDGES)[number], body: Record<string, unknown>): Promise<FetchResult<T>> {
    try {
      const { data, error } = await this.t.invoke(fn, body);
      if (error) return fail(error.code && FETCH_MESSAGES[error.code] ? error.code : "server_error");
      const d = data as Json;
      if (!d || d.ok === false) return fail(String(d?.code ?? "server_error"), pick(d ?? {}));
      return { ok: true, data: d as T };
    } catch { return fail("server_error"); }
  }
  private id(v: string) { return UUID.test(v); }

  // ── who you are to Fetch ──────────────────────────────────────────────────────────────────────────────────────────────────
  eligibility() { return this.rpc<Eligibility>("fetch_v2_my_eligibility"); }
  confirmAdult() { return this.rpc("fetch_v2_confirm_adult", { p_version: ADULT_CONFIRMATION_VERSION }); }

  // ── reference data (public tables, read only) ─────────────────────────────────────────────────────────────────────────────
  async regions(): Promise<FetchResult<Region[]>> {
    const { data, error } = await this.t.read("regions", "id, slug, name, island_group");
    return error ? fail("server_error") : { ok: true, data: (data as Region[]) ?? [] };
  }
  async categories(): Promise<FetchResult<{ slug: string; name: string }[]>> {
    const { data, error } = await this.t.read("delivery_categories", "slug, name");
    return error ? fail("server_error") : { ok: true, data: (data as { slug: string; name: string }[]) ?? [] };
  }

  // ── requester ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  quote(q: QuoteInput) { return this.edge<{ quote: Quote }>("fetch-v2-quote", { size_class: q.size_class, pickup: q.pickup, destination: q.destination }); }
  create(c: CreateInput) {
    // Only what the form collects. No price, status, driver, coordinate or money field is ever part of this.
    const body: Record<string, unknown> = { idempotency_key: c.idempotency_key, pickup: c.pickup, destination: c.destination, size_class: c.size_class,
      category_slug: c.category_slug, item_description: c.item_description, approx_dimensions_cm: c.approx_dimensions_cm ?? null,
      handling_flags: c.handling_flags ?? [], pickup_name: c.pickup_name ?? null, pickup_notes: c.pickup_notes ?? null, delivery_notes: c.delivery_notes ?? null,
      contact_phone: c.contact_phone, share_phone_with_driver: c.share_phone_with_driver === true, safe_place_allowed: c.safe_place_allowed === true,
      safe_place_note: c.safe_place_allowed ? (c.safe_place_note ?? null) : null, liability_acknowledged: c.liability_acknowledged === true,
      scheduling_mode: c.scheduling_mode, needed_by: c.scheduling_mode === "by" ? c.needed_by : null,
      flexible_until: c.scheduling_mode === "flexible" ? c.flexible_until : null };
    return this.edge<{ request_id: string; status: string; already: boolean; quote?: Quote; needs_item_photo?: boolean; expires_at?: string }>("fetch-v2-create", body);
  }
  myRequests() { return this.rpc<RequestSummary[]>("fetch_v2_my_requests"); }
  detail(id: string) { return this.id(id) ? this.rpc<Detail>("fetch_v2_request_detail", { p_request: id }) : Promise.resolve(fail("not_found")); }
  headingThatWay(id: string) { return this.rpc<{ heading_that_way: boolean; on?: string; hint?: string }>("fetch_v2_heading_that_way", { p_request: id }); }
  async timeline(id: string): Promise<FetchResult<TimelineEvent[]>> {
    if (!this.id(id)) return fail("not_found");
    const { data, error } = await this.t.read("fetch_request_events", "id, event, created_at, actor_role", { column: "request_id", value: id });
    return error ? fail("server_error") : { ok: true, data: ((data as TimelineEvent[]) ?? []).sort((a, b) => a.id - b.id) };
  }
  cancelOpen(id: string, reason?: string) { return this.rpc("fetch_v2_cancel_open", { p_request: id, p_reason: reason ?? null }); }
  askToCancel(id: string, reason: string) { return this.rpc("fetch_v2_request_cancellation", { p_request: id, p_reason: reason }); }
  extend(id: string) { return this.rpc("fetch_v2_extend", { p_request: id }); }
  ready(id: string) { return this.rpc("fetch_v2_confirm_ready", { p_request: id }); }
  payment(id: string, action: "complete" | "refresh") { return this.edge<{ payment: string; client_secret?: string }>("fetch-v2-payment", { request_id: id, action }); }

  // ── driver ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  apply(a: ApplyInput) {
    return this.edge<{ driver_status: string }>("become-driver", { vehicle_class: a.vehicle_class, max_size_class: a.max_size_class,
      can_two_person_lift: a.can_two_person_lift === true, vehicle_reg: a.vehicle_reg ?? null, statement: a.statement ?? null });
  }
  setAreas(areas: string[]) { return this.rpc("fetch_v2_set_my_areas", { p_areas: areas.filter((a) => this.id(a)) }); }
  verification() { return this.edge<Verification>("fetch-v2-driver-verification", { action: "status" }); }
  setVehicle(v: { vehicle_class: string; max_size_class: string; vehicle_reg?: string; can_two_person_lift?: boolean }) {
    return this.edge<{ re_verification_required: boolean }>("fetch-v2-driver-verification", { action: "set_vehicle", ...v });
  }
  evidenceBeginUpload(kind: string, mime: string, size: number) {
    return this.edge<UploadStart>("fetch-v2-driver-verification", { action: "begin_upload", kind, mime_type: mime, size_bytes: size });
  }
  evidenceSubmit(uploadId: string) { return this.edge<{ item_id: string; status: string }>("fetch-v2-driver-verification", { action: "submit", upload_id: uploadId }); }
  evidenceView(itemId: string) { return this.edge<{ url: string; expires_in: number }>("fetch-v2-driver-verification", { action: "view_own", item_id: itemId }); }
  board(showAll = false) { return this.rpc<BoardItem[]>("fetch_v2_board", { p_show_all: showAll }); }
  myRuns() { return this.rpc<Run[]>("fetch_v2_my_runs"); }
  createRun(r: RunInput) {
    return this.rpc<{ run_id: string }>("fetch_v2_create_run", { p_origin_region: r.origin_region_id, p_destination_region: r.destination_region_id,
      p_departure_start: r.departure_start, p_departure_end: r.departure_end, p_categories: r.categories ?? [], p_max_size: r.max_size_class ?? null, p_notes: null });
  }
  cancelRun(id: string) { return this.rpc("fetch_v2_cancel_run", { p_run: id }); }
  accept(id: string, vehicleConfirmed: boolean) {
    return this.edge<{ payment: string; can_collect: boolean; payment_reason?: string }>("fetch-v2-accept", { request_id: id, vehicle_confirmed: vehicleConfirmed === true });
  }
  myJobs() { return this.rpc<JobSummary[]>("fetch_v2_my_jobs"); }
  arrived(id: string) { return this.rpc("fetch_v2_mark_arrived", { p_request: id }); }
  collected(id: string) { return this.rpc("fetch_v2_mark_collected", { p_request: id }); }
  refreshHold(id: string) { return this.edge<{ payment: string; can_collect: boolean }>("fetch-v2-driver", { request_id: id, action: "refresh_hold" }); }
  release(id: string, reason: ReleaseReason, note?: string) { return this.edge("fetch-v2-driver", { request_id: id, action: "release", reason, note: note ?? null }); }
  agreeToCancel(id: string) { return this.edge("fetch-v2-driver", { request_id: id, action: "agree_cancellation" }); }
  declineToCancel(id: string, note?: string) { return this.rpc("fetch_v2_decline_cancellation", { p_request: id, p_note: note ?? null }); }
  deliver(id: string, leftInSafePlace: boolean) { return this.edge<{ status: string }>("fetch-v2-driver", { request_id: id, action: "deliver", left_in_safe_place: leftInSafePlace === true }); }
  cannotDeliver(id: string, reason: UndeliverableReason, note?: string) { return this.rpc("fetch_v2_mark_undeliverable", { p_request: id, p_reason: reason, p_note: note ?? null }); }
  reportReturn(id: string, note?: string) { return this.rpc("fetch_v2_report_return", { p_request: id, p_note: note ?? null }); }

  // ── both ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  messages(id: string) { return this.rpc<{ can_send: boolean; messages: Message[] }>("fetch_v2_messages", { p_request: id }); }
  sendMessage(id: string, body: string, clientRef: string) { return this.rpc("fetch_v2_send_message", { p_request: id, p_body: body, p_client_ref: clientRef }); }
  reportProblem(id: string, kind: IssueKind, detail: string, clientRef: string) {
    return this.rpc<{ issue_id: string }>("fetch_v2_report_issue", { p_request: id, p_kind: kind, p_detail: detail || null, p_client_ref: clientRef });
  }
  myIssues(id: string) { return this.rpc<{ issues: Issue[] }>("fetch_v2_my_issues", { p_request: id }); }
  photos(id: string) { return this.rpc<{ photos: Photo[] }>("fetch_v2_photos", { p_request: id }); }
  setItemPhoto(id: string, photoId: string, action: "show_on_board" | "hide_from_board" | "withdraw") {
    return this.rpc("fetch_v2_set_item_photo", { p_request: id, p_photo: photoId, p_action: action });
  }
  photoBeginUpload(id: string, kind: PhotoKind, mime: string, size: number, opts: { issueId?: string; showOnBoard?: boolean } = {}) {
    return this.edge<UploadStart>("fetch-v2-photos", { action: "begin_upload", request_id: id, kind, mime_type: mime, size_bytes: size,
      issue_id: opts.issueId ?? null, show_on_board: opts.showOnBoard === true });
  }
  photoSubmit(uploadId: string) { return this.edge<{ photo_id: string }>("fetch-v2-photos", { action: "submit", upload_id: uploadId }); }
  photoView(photoId: string, board = false) { return this.edge<{ url: string; expires_in: number }>("fetch-v2-photos", { action: board ? "view_board" : "view", photo_id: photoId }); }
}

function pick(d: Json): Json {
  const out: Json = {};
  for (const k of ["field", "end", "reason", "missing"]) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

export const ADULT_CONFIRMATION_VERSION = "fetch-18plus-v1";

// ── contracts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Size = "small" | "medium" | "large" | "bulky";
export type PhotoKind = "item" | "collection" | "delivery" | "return" | "issue";
export type IssueKind = "not_delivered" | "damaged" | "wrong_item" | "payment" | "safety" | "other" | "driver_conduct" | "requester_conduct";
export type ReleaseReason = "changed_plans" | "vehicle_unsuitable" | "not_as_described" | "prohibited_item" | "other";
export type UndeliverableReason = "recipient_absent" | "address_wrong" | "item_refused" | "not_as_described" | "requester_aborted" | "damaged" | "vehicle_unsuitable" | "driver_unable" | "other";
export type Eligibility = { fetch_enabled: boolean; adult_confirmed: boolean; restricted: boolean; problem: string | null; driver_problem: string | null };
export type Region = { id: string; slug: string; name: string; island_group: string | null };
export type Place = { region_id: string; address: string; postcode?: string; area?: string };
export type QuoteInput = { size_class: Size; pickup: Place; destination: Place };
export type Quote = {
  driver_delivery_pence: number; ferry_supplement_pence: number; service_fee_pence: number; expected_total_pence: number; max_authorisation_pence: number;
  authorisation_breakdown: { expected_total_pence: number; waiting_max_pence: number; return_max_pence: number };
  explanation: string; ferry_required: boolean; minimum_applied: boolean; size_class: Size; road_miles: number; pricing_version: string;
};
export type CreateInput = QuoteInput & {
  idempotency_key: string; category_slug: string; item_description: string; approx_dimensions_cm?: { l: number; w: number; h: number } | null;
  handling_flags?: string[]; pickup_name?: string; pickup_notes?: string; delivery_notes?: string; contact_phone: string; share_phone_with_driver?: boolean;
  safe_place_allowed?: boolean; safe_place_note?: string; liability_acknowledged?: boolean;
  scheduling_mode: "asap" | "by" | "flexible"; needed_by?: string | null; flexible_until?: string | null;
};
export type RequestSummary = { id: string; status: string; payment_status: string; created_at: string; closed_at: string | null; route: string;
  item_description: string; size_class: Size; total_fee_pence: number | null; cancel_requested: boolean; expires_at: string | null };
export type JobSummary = { id: string; status: string; payment_status: string; claimed_at: string; closed_at: string | null; route: string;
  item_description: string; size_class: Size; driver_pay_pence: number | null; cancel_requested: boolean; live: boolean;
  pay: { delivery_pence: number | null; ferry_pence: number | null; waiting_pence: number | null; return_pence: number | null } };
export type Detail = { viewer: "requester" | "driver"; request: Json; addresses_visible?: boolean; phone_shared?: boolean };
export type TimelineEvent = { id: number; event: string; created_at: string; actor_role: string };
export type BoardItem = { request_id: string; created_at: string; pickup_region: string; pickup_area: string | null; destination_region: string;
  destination_area: string | null; ferry_required: boolean; scheduling_mode: string; needed_by: string | null; flexible_until: string | null; expires_at: string | null;
  category_slug: string; item_description: string; size_class: Size; approx_dimensions_cm: Json | null; handling_flags: string[]; matching_photo_ids: string[];
  driver_pay_pence: number | null; match: "your_run" | "your_area" | "other" | "beyond_vehicle"; match_reasons: string[]; match_summary: string;
  fits_run_id: string | null; can_claim: boolean };
export type Run = { id: string; status: string; origin: string; destination: string; departure_start: string; departure_end: string; max_size_class: Size | null;
  categories: string[]; crosses_water: boolean };
export type RunInput = { origin_region_id: string; destination_region_id: string; departure_start: string; departure_end: string; categories?: string[]; max_size_class?: Size | null };
export type ApplyInput = { vehicle_class: string; max_size_class: Size; can_two_person_lift?: boolean; vehicle_reg?: string; statement?: string };
export type Verification = { driver_status: string; decision_reason: string | null; vehicle: Json; verified_until: string | null; verified: boolean;
  can_claim: boolean; claim_problem: string | null; requirements: { kind: string; required: boolean; needs_expiry: boolean; guidance: string; current: Json | null; awaiting_review: Json | null }[] };
export type UploadStart = { upload_id: string; upload_url: string; upload_token: string; expires_at: string; max_bytes: number };
export type Message = { id: string; from: "you" | "requester" | "driver"; body: string | null; hidden: boolean; created_at: string };
export type Issue = { id: string; kind: IssueKind; detail: string | null; status: "open" | "resolved"; resolution: string | null; created_at: string };
export type Photo = { id: string; kind: PhotoKind; issue_id: string | null; matching_visible: boolean; created_at: string; mine: boolean };

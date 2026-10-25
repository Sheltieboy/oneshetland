/**
 * scenarios.ts — the Step 11 UX scenarios A–J as fixture data (pure). Used by the scenario tests and by the dev-only preview route
 * (app/dev/fetch-preview), which renders the real Fetch views from these without any backend. Invented places and people only.
 */
import type { BoardItem, Detail, JobSummary, Message, Photo, Quote, Region, RequestSummary, Run, TimelineEvent, Verification } from "@/lib/fetch-api";
import type { Draft } from "@/lib/fetch/flow";

const H = 3600_000;
const iso = (now: number, h: number) => new Date(now + h * H).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ev = (now: number, list: [string, number, string][]): TimelineEvent[] => list.map(([event, h, actor_role], i) => ({ id: i + 1, event, created_at: iso(now, h), actor_role }));

export const REGIONS: Region[] = [
  { id: id(901), slug: "lerwick", name: "Lerwick", island_group: "mainland" }, { id: id(902), slug: "yell", name: "Yell", island_group: "north_isles" },
  { id: id(903), slug: "unst", name: "Unst", island_group: "north_isles" }, { id: id(904), slug: "scalloway", name: "Scalloway", island_group: "mainland" },
  { id: id(905), slug: "brae", name: "Brae", island_group: "mainland" },
];
export const CATEGORIES = [{ slug: "furniture", name: "Furniture" }, { slug: "parcel", name: "Parcel" }, { slug: "shopping", name: "Shopping" }, { slug: "pharmacy", name: "Pharmacy" }];

/** A sofa from Lerwick to Yell: ferry, bulky, the hold higher than the expected total. */
export const QUOTE_SOFA: Quote = { driver_delivery_pence: 2400, ferry_supplement_pence: 600, service_fee_pence: 300, expected_total_pence: 3300, max_authorisation_pence: 5200,
  authorisation_breakdown: { expected_total_pence: 3300, waiting_max_pence: 600, return_max_pence: 1300 }, explanation: "", ferry_required: true, minimum_applied: false,
  size_class: "bulky", road_miles: 38, pricing_version: "p0-v1" };
/** A small parcel to Unst: the £4 minimum driver payment applies on top of two ferries. */
export const QUOTE_PARCEL: Quote = { driver_delivery_pence: 400, ferry_supplement_pence: 400, service_fee_pence: 100, expected_total_pence: 900, max_authorisation_pence: 1500,
  authorisation_breakdown: { expected_total_pence: 900, waiting_max_pence: 200, return_max_pence: 400 }, explanation: "", ferry_required: true, minimum_applied: true,
  size_class: "small", road_miles: 4, pricing_version: "p0-v1" };

const base = (now: number, over: Record<string, unknown> = {}) => ({
  id: id(1), status: "pending", payment_status: "none", category_slug: "furniture", item_description: "Two-seater sofa (grey)", size_class: "bulky",
  approx_dimensions_cm: { l: 180, w: 85, h: 80 }, handling_flags: ["heavy_two_person"], pickup_region: "Lerwick", pickup_area: "Sound", destination_region: "Yell",
  destination_area: "Mid Yell", ferry_required: true, scheduling_mode: "flexible", needed_by: null, flexible_until: iso(now, 72), expires_at: iso(now, 72),
  created_at: iso(now, -2), claimed_at: null, collected_at: null, delivered_at: null, cancelled_at: null, cancel_reason: null, cancel_requested_at: null,
  cancel_request_reason: null, undeliverable_at: null, undeliverable_reason: null, undeliverable_note: null, returned_at: null, return_outcome: null,
  fault_party: null, return_fee_pence: null, closed_at: null, ...over,
});
const requesterView = (now: number, over: Record<string, unknown> = {}): Detail => ({ viewer: "requester", request: { ...base(now), base_fee_pence: 2400,
  ferry_supplement_pence: 600, waiting_fee_pence: null, total_fee_pence: 3300, min_fee_applied_pence: null, return_max_pence: 1300, resolution_capture_pence: null,
  share_phone_with_driver: false, driver: null, operational_details_visible: true, pickup_name: "Harbour Furniture (invented)", pickup_location: "1 Example Quay, Lerwick ZE1 0ZZ",
  pickup_notes: "Ask at the back door", destination_address: "Example Cottage, Mid Yell ZE2 9ZZ", delivery_notes: "Track past the kirk", safe_place_allowed: false,
  safe_place_note: null, contact_phone: "07000 000000", ...over } });
const driverView = (now: number, over: Record<string, unknown> = {}, extra: Partial<Detail> = {}): Detail => ({ viewer: "driver", addresses_visible: true, phone_shared: false,
  ...extra, request: { ...base(now, { status: "matched", payment_status: "authorised", claimed_at: iso(now, -1) }), requester_first_name: "Morag", driver_pay_pence: 3000,
    pickup_name: "Harbour Furniture (invented)", pickup_location: "1 Example Quay, Lerwick ZE1 0ZZ", pickup_notes: "Ask at the back door",
    destination_address: "Example Cottage, Mid Yell ZE2 9ZZ", delivery_notes: "Track past the kirk", safe_place_allowed: false, safe_place_note: null, ...over } });

/** The messages a driver sees on a live job (one removed by OneShetland). */
export const MESSAGES = (now: number): Message[] => [
  { id: id(301), from: "requester", body: "It's the grey one by the door.", hidden: false, created_at: iso(now, -0.8) },
  { id: id(302), from: "you", body: "Thanks — I'll be there about 2.", hidden: false, created_at: iso(now, -0.7) },
  { id: id(303), from: "requester", body: null, hidden: true, created_at: iso(now, -0.6) } ];
/** The preview's clock (outside render, so the views stay pure). */
export const previewNow = () => Date.now();
const photo = (now: number, kind: Photo["kind"], mine: boolean, visible = false, n = 401): Photo => ({ id: id(n), kind, issue_id: null, matching_visible: visible, created_at: iso(now, -1), mine });
const pay = { delivery_pence: 2400, ferry_pence: 600, waiting_pence: null, return_pence: null } as JobSummary["pay"];

export const RUN_SATURDAY = (now: number): Run => {
  const d = new Date(now); const sat = new Date(d); sat.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7)); sat.setUTCHours(9, 0, 0, 0);
  return { id: id(501), status: "open", origin: "Lerwick", destination: "Yell", departure_start: sat.toISOString(), departure_end: new Date(sat.getTime() + 4 * H).toISOString(),
    max_size_class: "bulky", categories: [], crosses_water: true };
};
const boardItem = (now: number, over: Partial<BoardItem> = {}): BoardItem => ({ request_id: id(1), created_at: iso(now, -2), pickup_region: "Lerwick", pickup_area: "Sound",
  destination_region: "Yell", destination_area: "Mid Yell", ferry_required: true, scheduling_mode: "flexible", needed_by: null, flexible_until: iso(now, 72), expires_at: iso(now, 72),
  category_slug: "furniture", item_description: "Two-seater sofa (grey)", size_class: "bulky", approx_dimensions_cm: { l: 180, w: 85, h: 80 }, handling_flags: ["heavy_two_person"],
  matching_photo_ids: [id(401)], driver_pay_pence: 3000, match: "your_run", match_reasons: ["your_run", "fits_vehicle"], match_summary: "Fits your Lerwick → Yell journey · fits your vehicle",
  fits_run_id: id(501), can_claim: true, ...over });

export const VERIFICATION = (status: "approved" | "pending", expired = false): Verification => ({ driver_status: status, decision_reason: null,
  vehicle: { vehicle_class: "van", max_size_class: "bulky", can_two_person_lift: true, has_registration: true }, verified_until: expired ? null : "2027-03-31", verified: !expired,
  can_claim: status === "approved" && !expired, claim_problem: expired ? "driver_verification_expired" : status === "pending" ? "driver_not_approved" : null,
  requirements: [
    { kind: "driving_licence", required: true, needs_expiry: true, guidance: "A photo of the front of your photocard licence.", current: { item_id: id(601), status: "verified", expires_on: "2031-05-01" }, awaiting_review: null },
    { kind: "insurance", required: true, needs_expiry: true, guidance: "Your certificate showing the van and its cover dates.",
      current: expired ? { item_id: id(602), status: "expired", expires_on: "2026-10-20" } : { item_id: id(602), status: "verified", expires_on: "2027-03-31" }, awaiting_review: null },
    { kind: "vehicle", required: true, needs_expiry: false, guidance: "A photo of the van showing its registration.", current: status === "pending" ? null : { item_id: id(603), status: "verified", expires_on: null }, awaiting_review: status === "pending" ? { item_id: id(604) } : null },
  ] });

export type Screen =
  | { kind: "wizard"; title: string; draft: Draft; step: number; quote: Quote }
  | { kind: "requester"; title: string; detail: Detail; timeline: TimelineEvent[]; photos: Photo[]; hint?: { heading_that_way: boolean; hint?: string } | null; messages?: boolean }
  | { kind: "driver"; title: string; detail: Detail; timeline: TimelineEvent[]; photos: Photo[]; pay: JobSummary["pay"]; driverProblem?: string }
  | { kind: "board"; title: string; items: BoardItem[]; runs: Run[]; showAll: boolean; problem: string | null }
  | { kind: "boardItem"; title: string; item: BoardItem | null; runs: Run[]; problem: string | null; gone?: string }
  | { kind: "verification"; title: string; v: Verification }
  | { kind: "home"; title: string; requests: RequestSummary[]; jobs: JobSummary[]; runs: Run[] };

export type Scenario = { key: string; name: string; screens: Screen[] };

/** The ten scenarios from the Step 11 brief, each as the screens a member would see. */
export function scenarios(now = Date.now()): Scenario[] {
  const run = RUN_SATURDAY(now);
  const draftSofa: Draft = { pickup: { region_id: id(901), address: "1 Example Quay, Lerwick", postcode: "ZE1 0ZZ" }, destination: { region_id: id(902), address: "Example Cottage, Mid Yell", postcode: "ZE2 9ZZ" },
    category_slug: "furniture", item_description: "Two-seater sofa (grey)", size_class: "bulky", dims: { l: "180", w: "85", h: "80" }, two_person: true, scheduling_mode: "flexible",
    flexible_until: iso(now, 72).slice(0, 16), contact_phone: "07000 000000" };
  return [
    { key: "a", name: "A · Requester in Yell needs a sofa collected in Lerwick", screens: [
      { kind: "wizard", title: "Price & review", draft: draftSofa, step: 4, quote: QUOTE_SOFA },
      { kind: "requester", title: "Posted, waiting for a driver", detail: requesterView(now), timeline: ev(now, [["created", -2, "requester"]]), photos: [photo(now, "item", true, true)],
        hint: { heading_that_way: true, hint: "A Fetch driver may be heading that way on Saturday." } } ] },
    { key: "b", name: "B · Driver already travelling Lerwick → Yell sees it as a journey match", screens: [
      { kind: "board", title: "Board", runs: [run], showAll: false, problem: null, items: [boardItem(now),
        boardItem(now, { request_id: id(2), pickup_area: null, destination_region: "Brae", destination_area: null, ferry_required: false, item_description: "Box of books", size_class: "medium",
          approx_dimensions_cm: null, handling_flags: [], matching_photo_ids: [], driver_pay_pence: 900, match: "your_area", match_summary: "In your area", fits_run_id: null, scheduling_mode: "asap" })] },
      { kind: "boardItem", title: "Accepting (bulky — fit confirmation)", item: boardItem(now), runs: [run], problem: null } ] },
    { key: "c", name: "C · Requester needs a small parcel taken to Unst", screens: [
      { kind: "wizard", title: "Price & review (minimum applies)", step: 4, quote: QUOTE_PARCEL, draft: { ...draftSofa, destination: { region_id: id(903), address: "Example House, Baltasound" },
        category_slug: "parcel", item_description: "Small parcel", size_class: "small", dims: {}, two_person: false, scheduling_mode: "asap" } } ] },
    { key: "d", name: "D · The card hold needs the requester's 3D Secure confirmation", screens: [
      { kind: "requester", title: "Requester", detail: requesterView(now, { status: "matched", payment_status: "requires_action", claimed_at: iso(now, -0.2), driver: { first_name: "Ewan", vehicle_class: "van" } }),
        timeline: ev(now, [["created", -2, "requester"], ["claimed", -0.2, "driver"], ["payment_requires_action", -0.2, "system"]]), photos: [] },
      { kind: "driver", title: "Driver", detail: driverView(now, { payment_status: "requires_action" }), pay,
        timeline: ev(now, [["created", -2, "requester"], ["claimed", -0.2, "driver"]]), photos: [] } ] },
    { key: "e", name: "E · Requester asks to cancel before collection", screens: [
      { kind: "requester", title: "Requester", detail: requesterView(now, { status: "matched", payment_status: "authorised", claimed_at: iso(now, -1), cancel_requested_at: iso(now, -0.1),
        cancel_request_reason: "Bought one locally", driver: { first_name: "Ewan", vehicle_class: "van" } }), messages: true,
        timeline: ev(now, [["created", -2, "requester"], ["claimed", -1, "driver"], ["payment_authorised", -1, "system"], ["cancellation_requested", -0.1, "requester"]]), photos: [] },
      { kind: "driver", title: "Driver", detail: driverView(now, { cancel_requested_at: iso(now, -0.1), cancel_request_reason: "Bought one locally" }), pay,
        timeline: ev(now, [["claimed", -1, "driver"], ["payment_authorised", -1, "system"], ["cancellation_requested", -0.1, "requester"]]), photos: [] } ] },
    { key: "f", name: "F · Driver arrives and has to wait", screens: [
      { kind: "driver", title: "Driver", detail: driverView(now), pay: { ...pay, waiting_pence: null },
        timeline: ev(now, [["claimed", -1, "driver"], ["payment_authorised", -1, "system"], ["arrived", -0.3, "driver"]]), photos: [] } ] },
    { key: "g", name: "G · Driver cannot deliver after collection", screens: [
      { kind: "driver", title: "Driver", detail: driverView(now, { status: "undeliverable", collected_at: iso(now, -1), undeliverable_at: iso(now, -0.2), undeliverable_reason: "recipient_absent" }), pay,
        timeline: ev(now, [["claimed", -2, "driver"], ["collected", -1, "driver"], ["undeliverable", -0.2, "driver"]]), photos: [photo(now, "collection", true, false, 402)] },
      { kind: "requester", title: "Requester", detail: requesterView(now, { status: "undeliverable", payment_status: "authorised", driver: { first_name: "Ewan", vehicle_class: "van" } }),
        timeline: ev(now, [["claimed", -2, "driver"], ["collected", -1, "driver"], ["undeliverable", -0.2, "driver"]]), photos: [] } ] },
    { key: "h", name: "H · Safe-place delivery with a photo", screens: [
      { kind: "driver", title: "Driver", detail: driverView(now, { status: "collected", collected_at: iso(now, -0.5), safe_place_allowed: true, safe_place_note: "In the porch" }), pay,
        timeline: ev(now, [["claimed", -2, "driver"], ["collected", -0.5, "driver"]]), photos: [photo(now, "delivery", true, false, 403)] } ] },
    { key: "i", name: "I · Verification expires before collection", screens: [
      { kind: "driver", title: "Driver (collect is refused by the server)", detail: driverView(now), pay, driverProblem: "driver_verification_expired", timeline: ev(now, [["claimed", -20, "driver"], ["payment_authorised", -20, "system"]]), photos: [] },
      { kind: "verification", title: "Driver details", v: VERIFICATION("approved", true) },
      { kind: "board", title: "Board", runs: [run], showAll: false, problem: "One of your driver documents has expired. Please upload a renewed copy.", items: [boardItem(now, { can_claim: false })] } ] },
    { key: "j", name: "J · Another driver accepts just before this driver", screens: [
      { kind: "boardItem", title: "After pressing Accept", item: null, runs: [run], problem: null, gone: "Another driver accepted this Fetch just before you." } ] },
    { key: "home", name: "Fetch home (signed in)", screens: [
      { kind: "home", title: "Home", runs: [run],
        requests: [{ id: id(1), status: "pending", payment_status: "none", created_at: iso(now, -2), closed_at: null, route: "Lerwick → Yell", item_description: "Two-seater sofa (grey)", size_class: "bulky", total_fee_pence: 3300, cancel_requested: false, expires_at: iso(now, 72) }],
        jobs: [{ id: id(7), status: "collected", payment_status: "authorised", claimed_at: iso(now, -3), closed_at: null, route: "Scalloway → Brae", item_description: "Bike", size_class: "large", driver_pay_pence: 1400, cancel_requested: false, live: true, pay }] } ] },
  ];
}

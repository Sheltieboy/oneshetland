/**
 * fetch-v2-intake.ts — the Fetch v2 quote and create boundary (docs/FETCH_V2_IMPLEMENTATION.md, Step 4).
 *
 * The edge functions fetch-v2-quote and fetch-v2-create are thin wrappers around handleQuote / handleCreate. Everything they depend on
 * is injected (database RPC, geocoder, card check, rate limiter), so the same code runs in production and, against a throwaway
 * database with mocked Google and Stripe, in the isolated test suite.
 *
 * What this layer decides: who may ask (auth, the Fetch v2 flag, 18+, restriction, card on file), where the two ends are (server
 * geocoding only), and how the answer is shaped. What it never decides: any amount of money. Prices and frozen terms come from the
 * database (fetch_v2_quote / fetch_v2_create_request → fetch_v2_price), and are passed through.
 *
 * Every answer is { status, body } with a stable `code`. Provider and database error text is never returned.
 */

import { type Geocoder, type LatLng, GeocodeUnavailable } from './fetch-v2-geocode.ts';

export type RpcResult = { data: unknown; error: unknown };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
export type CardStatus = 'eligible' | 'payment_method_required' | 'card_check_failed';
export type CardCheck = (userId: string) => Promise<CardStatus>;
/** true = allowed. Claims a slot against every named action. */
export type Limiter = (userId: string, actions: string[]) => Promise<boolean>;
export interface IntakeDeps { rpc: Rpc; geocode: Geocoder; cardCheck: CardCheck; limit: Limiter }
export type Outcome = { status: number; body: Record<string, unknown> };

const refuse = (status: number, code: string, extra: Record<string, unknown> = {}): Outcome => ({ status, body: { ok: false, code, ...extra } });
const SERVER_ERROR = refuse(500, 'server_error', { error: 'Something went wrong. Please try again.' });

// ── input ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Place = { region_id: string; address: string; postcode: string | null; place_id: string | null; area: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const SHETLAND_POSTCODE = /^ZE[1-3]\s?\d[A-Z]{2}$/i;
const SIZES = new Set(['small', 'medium', 'large', 'bulky']);

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);

function readPlace(v: unknown): Place | { error: string } {
  if (!v || typeof v !== 'object') return { error: 'missing' };
  const o = v as Record<string, unknown>;
  const region_id = typeof o.region_id === 'string' && UUID.test(o.region_id) ? o.region_id : null;
  const address = str(o.address, 300);
  if (!region_id || !address) return { error: 'missing' };
  const postcode = o.postcode == null || o.postcode === '' ? null : str(o.postcode, 10);
  if (o.postcode != null && o.postcode !== '' && !postcode) return { error: 'format' };
  if (postcode && !SHETLAND_POSTCODE.test(postcode)) return { error: 'outside' };
  const place_id = o.place_id == null || o.place_id === '' ? null : (typeof o.place_id === 'string' && PLACE_ID.test(o.place_id) ? o.place_id : undefined);
  if (place_id === undefined) return { error: 'format' };
  const area = o.area == null || o.area === '' ? null : str(o.area, 120);
  return { region_id, address, postcode, place_id, area };
}

// ── location ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** place_id first (the client's autocomplete pick, resolved here), then address + postcode, then the postcode alone. */
async function resolvePlace(p: Place, geocode: Geocoder): Promise<LatLng | null> {
  if (p.place_id) {
    const hit = await geocode({ place_id: p.place_id });
    if (hit) return hit;
  }
  const full = [p.address, p.postcode, 'Shetland'].filter(Boolean).join(', ');
  const hit = await geocode({ address: full });
  if (hit) return hit;
  if (p.postcode) return await geocode({ address: `${p.postcode}, Shetland` });
  return null;
}

async function resolveBoth(a: Place, b: Place, geocode: Geocoder): Promise<{ pickup: LatLng; dest: LatLng } | Outcome> {
  try {
    const [pickup, dest] = await Promise.all([resolvePlace(a, geocode), resolvePlace(b, geocode)]);
    if (!pickup || !dest) return refuse(422, 'location_unresolved', { end: !pickup ? 'pickup' : 'destination' });
    return { pickup, dest };
  } catch (e) {
    if (e instanceof GeocodeUnavailable) return refuse(503, 'location_service_unavailable');
    return SERVER_ERROR;
  }
}

// ── money, shaped for people ──────────────────────────────────────────────────────────────────────────────────────────────────
const pounds = (p: number) => `£${(p / 100).toFixed(2)}`;
// deno-lint-ignore no-explicit-any
export function shapeQuote(t: any) {
  const expected = Number(t.total_pence);
  const waitMax = Number(t.waiting_max_pence ?? t.wait_max_pence);
  const returnMax = Number(t.return_max_pence);
  const max = Number(t.max_hold_pence);
  return {
    driver_delivery_pence: Number(t.delivery_fee_pence),
    ferry_supplement_pence: Number(t.ferry_supplement_pence),
    service_fee_pence: Number(t.service_fee_pence),
    expected_total_pence: expected,
    max_authorisation_pence: max,
    authorisation_breakdown: { expected_total_pence: expected, waiting_max_pence: waitMax, return_max_pence: returnMax },
    explanation:
      `You'll pay ${pounds(expected)} if the delivery goes as planned. When a driver accepts, your card is temporarily held for up to ` +
      `${pounds(max)}: the extra covers up to ${pounds(waitMax)} if the driver has to wait after you said the item was ready, and up to ` +
      `${pounds(returnMax)} only if the item has to be brought back for a reason outside the driver's control. ` +
      `You are only charged for what actually happens; the rest of the hold is released.`,
    ferry_required: Boolean(t.ferry_required),
    minimum_applied: t.min_fee_applied_pence != null,
    size_class: t.size_class,
    road_miles: Number(t.road_miles),
    pricing_version: t.pricing_version,
  };
}

// ── shared gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function gate(userId: string | null, deps: IntakeDeps, actions: string[]): Promise<Outcome | null> {
  if (!userId) return refuse(401, 'unauthorised');
  if (!(await deps.limit(userId, actions))) return refuse(429, 'rate_limited');
  const { data, error } = await deps.rpc('fetch_v2_eligibility_for', { p_user: userId });
  if (error || !data) return SERVER_ERROR;
  const e = data as { fetch_enabled: boolean; problem: string | null };
  if (!e.fetch_enabled) return refuse(403, 'fetch_unavailable');
  if (e.problem) return refuse(403, e.problem);
  return null;
}

const SQL_REFUSAL_STATUS: Record<string, number> = {
  location_unresolved: 422, outside_service_area: 422, area_not_supported: 422, region_mismatch: 422, invalid_request: 400,
  liability_required: 400, idempotency_key_required: 400, member_restricted: 403, age_confirmation_required: 403,
};
function fromSql(data: unknown): Outcome | null {
  const d = data as { ok?: boolean; code?: string; field?: string; end?: string } | null;
  if (!d || typeof d.ok !== 'boolean') return SERVER_ERROR;
  if (d.ok) return null;
  const extra: Record<string, unknown> = {};
  if (d.field) extra.field = d.field;
  if (d.end) extra.end = d.end;
  return refuse(SQL_REFUSAL_STATUS[d.code ?? ''] ?? 422, d.code ?? 'refused', extra);
}

// ── QUOTE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function handleQuote(userId: string | null, body: unknown, deps: IntakeDeps): Promise<Outcome> {
  const blocked = await gate(userId, deps, ['fetch_v2_quote', 'fetch_v2_quote_day']);
  if (blocked) return blocked;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const size = typeof b.size_class === 'string' && SIZES.has(b.size_class) ? b.size_class : null;
  if (!size) return refuse(400, 'invalid_request', { field: 'size_class' });
  const pickup = readPlace(b.pickup), dest = readPlace(b.destination);
  if ('error' in pickup || 'error' in dest) {
    const err = 'error' in pickup ? pickup.error : (dest as { error: string }).error;
    return err === 'outside' ? refuse(422, 'outside_service_area') : refuse(400, 'invalid_request', { field: 'location' });
  }
  const where = await resolveBoth(pickup, dest, deps.geocode);
  if ('status' in where) return where;

  const { data, error } = await deps.rpc('fetch_v2_quote', { p_user: userId, p: {
    pickup_region_id: pickup.region_id, destination_region_id: dest.region_id, size_class: size,
    pickup_lat: where.pickup.lat, pickup_lng: where.pickup.lng, dest_lat: where.dest.lat, dest_lng: where.dest.lng,
  } });
  if (error) return SERVER_ERROR;
  const refused = fromSql(data);
  if (refused) return refused;
  return { status: 200, body: { ok: true, quote: shapeQuote((data as { terms: unknown }).terms) } };
}

// ── CREATE ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Exactly these fields are forwarded. Prices, statuses, drivers, coordinates and every money field a client might send are not.
const FORWARDED = ['category_slug', 'item_description', 'size_class', 'approx_dimensions_cm', 'handling_flags', 'pickup_notes', 'delivery_notes',
  'contact_phone', 'share_phone_with_driver', 'safe_place_allowed', 'safe_place_note', 'already_paid', 'liability_acknowledged',
  'scheduling_mode', 'needed_by', 'flexible_until', 'pickup_name'] as const;

export async function handleCreate(userId: string | null, body: unknown, deps: IntakeDeps): Promise<Outcome> {
  const blocked = await gate(userId, deps, ['fetch_v2_create', 'fetch_v2_create_day']);
  if (blocked) return blocked;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const key = typeof b.idempotency_key === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(b.idempotency_key) ? b.idempotency_key : null;
  if (!key) return refuse(400, 'idempotency_key_required');

  let card: CardStatus;
  try { card = await deps.cardCheck(userId!); } catch { card = 'card_check_failed'; }
  if (card === 'payment_method_required') return refuse(402, 'payment_method_required');
  if (card !== 'eligible') return refuse(503, 'card_check_failed');

  const pickup = readPlace(b.pickup), dest = readPlace(b.destination);
  if ('error' in pickup || 'error' in dest) {
    const err = 'error' in pickup ? pickup.error : (dest as { error: string }).error;
    return err === 'outside' ? refuse(422, 'outside_service_area') : refuse(400, 'invalid_request', { field: 'location' });
  }
  const where = await resolveBoth(pickup, dest, deps.geocode);
  if ('status' in where) return where;

  const p: Record<string, unknown> = {};
  for (const k of FORWARDED) if (b[k] !== undefined) p[k] = b[k];
  Object.assign(p, {
    idempotency_key: key,
    pickup_region_id: pickup.region_id, pickup_area: pickup.area, pickup_location: [pickup.address, pickup.postcode].filter(Boolean).join(', '),
    destination_region_id: dest.region_id, destination_area: dest.area,
    destination_address: [dest.address, dest.postcode].filter(Boolean).join(', '),
    pickup_lat: where.pickup.lat, pickup_lng: where.pickup.lng, dest_lat: where.dest.lat, dest_lng: where.dest.lng,
  });
  if (typeof p.pickup_name !== 'string' || p.pickup_name.trim() === '') p.pickup_name = pickup.address;

  const { data, error } = await deps.rpc('fetch_v2_create_request', { p_customer: userId, p });
  if (error) return SERVER_ERROR;
  const refused = fromSql(data);
  if (refused) return refused;
  const d = data as { request_id: string; status: string; already: boolean; terms?: unknown; needs_item_photo?: boolean; expires_at?: string };
  return { status: d.already ? 200 : 201, body: {
    ok: true, request_id: d.request_id, status: d.status, already: d.already,
    quote: d.terms ? shapeQuote(d.terms) : undefined,
    needs_item_photo: d.needs_item_photo, expires_at: d.expires_at,
  } };
}

// ── card on file (read-only: never creates a Stripe customer or stores card data) ─────────────────────────────────────────────
export function makeCardCheck(opts: {
  customerIdFor: (userId: string) => Promise<string | null>;
  chargeableCard: (customerId: string) => Promise<string | null>;
}): CardCheck {
  return async (userId) => {
    try {
      const customer = await opts.customerIdFor(userId);
      if (!customer) return 'payment_method_required';
      return (await opts.chargeableCard(customer)) ? 'eligible' : 'payment_method_required';
    } catch {
      return 'card_check_failed';
    }
  };
}

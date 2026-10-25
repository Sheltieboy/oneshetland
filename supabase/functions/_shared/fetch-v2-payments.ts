/**
 * fetch-v2-payments.ts — the Fetch v2 payment layer (docs/FETCH_V2_IMPLEMENTATION.md, Step 5).
 *
 * The edge functions fetch-v2-accept, fetch-v2-payment, fetch-v2-driver, fetch-v2-admin and fetch-v2-runner, and the Fetch v2 hand-off
 * inside stripe-webhook, are thin wrappers around these handlers. Every dependency (database RPC, Stripe, card lookup, rate limiter,
 * account lookups) is injected, so the same code runs in production and — against a throwaway database with a fake Stripe — in the
 * isolated suite.
 *
 * Rules this layer keeps:
 *   · Money never comes from a client. Hold amount, capture amount, application fee, destination account, PaymentIntent and
 *     generation all come from the frozen terms and the job's state in the database.
 *   · Stripe's answer becomes Fetch state through exactly one door: fetch_v2_apply_payment_state.
 *   · The lifecycle moves only through the Step 3 actions; delivery is recorded only after a successful capture.
 *   · A hold is voided, confirmed terminal and archived before any other hold exists for the job. After collection a dying hold is
 *     escalated to a person, never replaced in a way that leaves two holds or none.
 *   · Every Stripe write has a deterministic idempotency key: fetch-auth-<job>[-g<n>] (create), fetch-v2-void-<intent> (cancel),
 *     fetch-v2-capture-<intent> (capture).
 *   · Answers are { status, body } with a stable code. Stripe and database text never leaves.
 */

import { type PaymentIntent, type StripeGateway, StripeDeclined, StripeRejected, StripeUnavailable } from './fetch-v2-stripe.ts';

export type RpcResult = { data: unknown; error: unknown };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
export interface PaymentDeps {
  rpc: Rpc;
  stripe: StripeGateway;
  /** The requester's canonical Stripe Customer and chargeable card (null card = none on file). Throws if it cannot be asked. */
  customerCard: (userId: string) => Promise<{ customerId: string; paymentMethodId: string | null } | null>;
  /** The driver's Connect account, read server-side. */
  driverAccount: (driverId: string) => Promise<{ accountId: string | null; payoutsEnabled: boolean }>;
  isAdmin: (userId: string) => Promise<boolean>;
  limit: (userId: string, actions: string[]) => Promise<boolean>;
}
export type Outcome = { status: number; body: Record<string, unknown> };

const refuse = (status: number, code: string, extra: Record<string, unknown> = {}): Outcome => ({ status, body: { ok: false, code, ...extra } });
const SERVER_ERROR = refuse(500, 'server_error', { error: 'Something went wrong. Please try again.' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  already_taken: 409, not_claimable: 409, own_request: 403, vehicle_confirmation_required: 400, too_large_for_vehicle: 409,
  item_photo_required: 409, driver_not_approved: 403, driver_verification_expired: 403, driver_payouts_not_enabled: 403,
  age_confirmation_required: 403, member_restricted: 403, reason_required: 400, invalid_request: 400, invalid_transition: 409,
  invalid_state: 409, already_collected: 409, no_cancellation_request: 409, safe_place_not_allowed: 409, delivery_photo_required: 409,
  payment_not_captured: 409, override_reason_required: 400, override_required: 400, override_out_of_range: 400, use_return_resolution: 409,
};

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
async function call(deps: PaymentDeps, fn: string, args: Record<string, unknown>): Promise<Json> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) throw new RpcFailure(fn, error);
  return (Array.isArray(data) ? data[0] : data) as Json;
}
class RpcFailure extends Error {
  readonly detail: unknown;
  constructor(fn: string, detail: unknown) { super(`rpc ${fn} failed`); this.detail = detail; }
}
const fromSql = (d: Json): Outcome | null => (d?.ok === false ? refuse(STATUS[d.code] ?? 422, d.code, d.reason ? { reason: d.reason } : {}) : null);
const notFound = refuse(404, 'not_found');

// ── Stripe → Fetch (the one door) ─────────────────────────────────────────────────────────────────────────────────────────────
export async function applyIntent(deps: PaymentDeps, requestId: string, pi: PaymentIntent, source: string, override?: string): Promise<Json> {
  const state = override ?? pi.status;
  const generation = Number(pi.metadata?.fetch_v2_generation ?? 0) || null;
  return await call(deps, 'fetch_v2_apply_payment_state', {
    p_request: requestId, p_pi: pi.id, p_generation: generation, p_state: state,
    p_amount_capturable: pi.amount_capturable, p_amount_received: pi.amount_received,
    p_capture_before: pi.capture_before ? new Date(pi.capture_before * 1000).toISOString() : null, p_source: source,
  });
}

/** Void a hold (idempotently) and record it. 'pending' = Stripe could not be asked; the runner will finish it. */
export async function voidHold(deps: PaymentDeps, requestId: string, piId: string | null): Promise<'voided' | 'none' | 'pending' | 'captured'> {
  if (!piId) return 'none';
  try {
    let pi = await deps.stripe.retrieve(piId);
    if (pi.status === 'succeeded') { await applyIntent(deps, requestId, pi, 'void_check'); return 'captured'; }
    if (pi.status !== 'canceled') pi = await deps.stripe.cancel(piId, `fetch-v2-void-${piId}`);
    await applyIntent(deps, requestId, pi, 'void');
    return 'voided';
  } catch (e) {
    if (e instanceof StripeUnavailable) return 'pending';
    if (e instanceof StripeRejected) {   // e.g. already cancelled by Stripe on expiry: read it back
      try { const pi = await deps.stripe.retrieve(piId); if (pi.status === 'canceled') { await applyIntent(deps, requestId, pi, 'void'); return 'voided'; } } catch { /* fall through */ }
      return 'pending';
    }
    throw e;
  }
}

/** Void then archive a released/cancelled job's hold, so the next driver's hold is a new generation. */
async function voidAndRetire(deps: PaymentDeps, requestId: string, piId: string | null): Promise<string> {
  const v = await voidHold(deps, requestId, piId);
  if (v === 'pending' || v === 'captured') return v;
  const r = await call(deps, 'fetch_v2_retire_authorisation', { p_request: requestId });
  return r?.ok ? 'retired' : `retire_${r?.code ?? 'refused'}`;
}

// ── Placing the hold ──────────────────────────────────────────────────────────────────────────────────────────────────────────
type HoldResult = { payment: 'authorised' | 'requester_action_required' | 'pending' | 'failed'; reason?: string };

export async function placeHold(deps: PaymentDeps, driverId: string, requestId: string): Promise<HoldResult> {
  let claim = await call(deps, 'fetch_v2_claim_authorisation', { p_driver: driverId, p_request: requestId });
  if (claim.outcome === 'previous_hold_not_retired') {
    const ctx0 = await call(deps, 'fetch_v2_payment_context', { p_request: requestId });
    const done = await voidAndRetire(deps, requestId, ctx0.payment_intent_id);
    if (done !== 'retired') return { payment: 'pending', reason: 'previous_hold' };
    claim = await call(deps, 'fetch_v2_claim_authorisation', { p_driver: driverId, p_request: requestId });
  }
  const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: requestId });

  if (claim.outcome === 'resume' && claim.stripe_payment_intent_id) {
    try {
      const pi = await deps.stripe.retrieve(claim.stripe_payment_intent_id);
      const s = await applyIntent(deps, requestId, pi, 'accept_resume');
      return s.payment_status === 'authorised' ? { payment: 'authorised' } : { payment: 'requester_action_required' };
    } catch (e) {
      if (e instanceof StripeUnavailable) return { payment: 'pending' };
      throw e;
    }
  }
  if (claim.outcome !== 'claimed' && !(claim.outcome === 'in_flight' && !claim.stripe_payment_intent_id)) {
    return { payment: 'pending', reason: claim.outcome };
  }

  const acct = await deps.driverAccount(driverId);
  if (!acct.accountId || !acct.payoutsEnabled) return { payment: 'failed', reason: 'driver_payouts_not_enabled' };
  const card = await deps.customerCard(ctx.customer_id);
  if (!card) return { payment: 'failed', reason: 'requester_has_no_payment_profile' };

  try {
    // Same key on every retry of this generation: a lost response returns the SAME intent, never a second hold.
    const pi = await deps.stripe.createHold({
      amount: Number(claim.amount_pence), customer: card.customerId, paymentMethod: card.paymentMethodId,
      destination: acct.accountId, applicationFee: Number(ctx.service_fee_pence),
      metadata: { fetch_v2_request_id: requestId, fetch_v2_generation: String(claim.generation), fetch_v2_driver_id: driverId,
        application_fee_label: 'OneShetland service fee' },
      description: `OneShetland Fetch ${ctx.category_slug ?? 'delivery'} — card hold (only what is owed is charged)`,
      idempotencyKey: claim.idempotency_key,
    });
    await call(deps, 'settle_fetch_authorisation', { p_request: requestId, p_status: pi.status === 'requires_capture' ? 'authorised' : 'awaiting_customer', p_pi: pi.id });
    const s = await applyIntent(deps, requestId, pi, 'accept');
    return s.payment_status === 'authorised' ? { payment: 'authorised' } : { payment: 'requester_action_required' };
  } catch (e) {
    if (e instanceof StripeDeclined) {
      if (e.intent) {
        await call(deps, 'settle_fetch_authorisation', { p_request: requestId, p_status: 'awaiting_customer', p_pi: e.intent.id, p_error: e.code });
        await applyIntent(deps, requestId, e.intent, 'accept_declined', e.code === 'authentication_required' ? 'requires_action' : 'requires_payment_method');
      } else {
        await call(deps, 'settle_fetch_authorisation', { p_request: requestId, p_status: 'awaiting_customer', p_error: e.code });
      }
      return { payment: 'requester_action_required', reason: e.code === 'authentication_required' ? 'authentication_required' : 'card_declined' };
    }
    if (e instanceof StripeUnavailable) {
      await call(deps, 'settle_fetch_authorisation', { p_request: requestId, p_status: 'unresolved', p_error: e.reason });
      return { payment: 'pending' };
    }
    if (e instanceof StripeRejected) {
      await call(deps, 'settle_fetch_authorisation', { p_request: requestId, p_status: 'terminal', p_error: e.code });
      return { payment: 'failed', reason: 'payment_could_not_start' };
    }
    throw e;
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Capture what is owed (once). Returns null on success, or the refusal. Never captures more than Stripe holds. */
async function captureOwed(deps: PaymentDeps, requestId: string, driverId: string, ctx: Json): Promise<Outcome | null> {
  const owed = await call(deps, 'fetch_v2_capture_amount', { p_request: requestId });
  if (owed?.ok === false) return fromSql(owed);
  const piId: string | null = ctx.payment_intent_id;
  if (!piId) return refuse(409, 'payment_not_ready');
  let pi: PaymentIntent;
  try { pi = await deps.stripe.retrieve(piId); } catch (e) { if (e instanceof StripeUnavailable) return refuse(503, 'payment_provider_unavailable'); throw e; }
  if (pi.status === 'succeeded') { await applyIntent(deps, requestId, pi, 'capture_check'); return null; }
  if (pi.status !== 'requires_capture') { await applyIntent(deps, requestId, pi, 'capture_check'); return refuse(409, 'payment_not_ready', { reason: pi.status }); }
  if (Number(owed.amount_pence) > pi.amount_capturable) {
    await call(deps, 'fetch_v2_escalate_payment', { p_request: requestId, p_reason: `Owed ${owed.amount_pence}p exceeds the capturable ${pi.amount_capturable}p` });
    return refuse(409, 'capture_exceeds_hold');
  }
  const claim = await call(deps, 'claim_fetch_capture', { p_request: requestId, p_driver: driverId, p_amount: Number(owed.amount_pence) });
  if (claim.outcome === 'in_flight') return refuse(409, 'capture_in_progress');
  if (claim.outcome !== 'claimed' && claim.outcome !== 'already_captured') return refuse(409, 'payment_not_ready', { reason: claim.outcome });
  try {
    const done = await deps.stripe.capture(piId, Number(owed.amount_pence), Number(owed.application_fee_pence), `fetch-v2-capture-${piId}`);
    await applyIntent(deps, requestId, done, 'capture');
    await call(deps, 'settle_fetch_capture', { p_request: requestId, p_state: 'captured', p_amount: done.amount_received });
    return null;
  } catch (e) {
    if (e instanceof StripeUnavailable) {
      await call(deps, 'settle_fetch_capture', { p_request: requestId, p_state: 'unresolved', p_error: e.reason });
      return refuse(503, 'capture_pending');
    }
    if (e instanceof StripeDeclined || e instanceof StripeRejected) {
      await call(deps, 'settle_fetch_capture', { p_request: requestId, p_state: 'failed', p_error: e.code });
      await call(deps, 'fetch_v2_escalate_payment', { p_request: requestId, p_reason: `Capture failed: ${e.code}` });
      return refuse(409, 'capture_failed');
    }
    throw e;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function guard(userId: string | null, deps: PaymentDeps, actions: string[]): Promise<Outcome | null> {
  if (!userId) return refuse(401, 'unauthorised');
  if (!(await deps.limit(userId, actions))) return refuse(429, 'rate_limited');
  return null;
}
const wrap = async (f: () => Promise<Outcome>): Promise<Outcome> => {
  try { return await f(); } catch (e) {
    if (e instanceof RpcFailure && /Fetch request not found|P0002/.test(JSON.stringify(e.detail))) return notFound;
    if (e instanceof RpcFailure && /Fetch is not available/.test(JSON.stringify(e.detail))) return refuse(403, 'fetch_unavailable');
    if (e instanceof RpcFailure && /Only an administrator/.test(JSON.stringify(e.detail))) return refuse(403, 'forbidden');
    return SERVER_ERROR;
  }
};
const shapeHold = (requestId: string, h: HoldResult, extra: Json = {}): Outcome => ({ status: 200, body: { ok: true, request_id: requestId,
  status: 'matched', payment: h.payment, ...(h.reason && h.payment !== 'authorised' ? { payment_reason: h.reason } : {}),
  can_collect: h.payment === 'authorised', ...extra } });

/** Driver accepts a job: eligibility → account → self-payment guard → race-safe claim → hold. */
export function handleAccept(driverId: string | null, body: unknown, deps: PaymentDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(driverId, deps, ['fetch_v2_accept', 'stripe_intent', 'stripe_intent_day']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    if (typeof b.request_id !== 'string' || !UUID.test(b.request_id)) return refuse(400, 'invalid_request');
    const requestId = b.request_id;
    const el = await call(deps, 'fetch_v2_eligibility_for', { p_user: driverId });
    if (!el.fetch_enabled) return refuse(403, 'fetch_unavailable');
    if (el.problem) return refuse(403, el.problem);
    if (el.driver_problem) return refuse(403, el.driver_problem);
    const acct = await deps.driverAccount(driverId!);
    if (!acct.accountId || !acct.payoutsEnabled) return refuse(403, 'driver_payouts_not_enabled');
    const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: requestId });
    if (!ctx?.request_id) return notFound;
    // The requester must not be paying a payout account they control (the existing card/wallet self-payment guard).
    const self = await deps.rpc('wallet_destination_self_controlled', { p_user: ctx.customer_id, p_account: acct.accountId });
    if (self.error) throw new RpcFailure('wallet_destination_self_controlled', self.error);
    if (self.data === true) return refuse(403, 'self_payment');

    const claimed = await call(deps, 'fetch_v2_claim', { p_driver: driverId, p_request: requestId, p_vehicle_confirmed: b.vehicle_confirmed === true });
    const refused = fromSql(claimed);
    if (refused) return refused;

    const hold = await placeHold(deps, driverId!, requestId);
    if (hold.payment === 'failed') {
      await call(deps, 'fetch_v2_release_after_payment_failure', { p_request: requestId, p_reason: hold.reason ?? 'payment failed' });
      return refuse(hold.reason === 'driver_payouts_not_enabled' ? 403 : 502, hold.reason ?? 'payment_could_not_start');
    }
    return shapeHold(requestId, hold, { already: claimed.already === true });
  });
}

/** The requester finishes a hold Stripe could not complete on its own (3DS, a new card), or asks for its current state. */
export function handleRequesterPayment(userId: string | null, body: unknown, deps: PaymentDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(userId, deps, ['fetch_v2_payment']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    if (typeof b.request_id !== 'string' || !UUID.test(b.request_id) || !['complete', 'refresh'].includes(b.action)) return refuse(400, 'invalid_request');
    const el = await call(deps, 'fetch_v2_eligibility_for', { p_user: userId });
    if (!el.fetch_enabled) return refuse(403, 'fetch_unavailable');
    const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: b.request_id });
    if (!ctx?.request_id || ctx.customer_id !== userId) return notFound;
    if (ctx.status !== 'matched') return refuse(409, 'invalid_state');
    if (!ctx.payment_intent_id) {
      const h = await placeHold(deps, ctx.driver_id, b.request_id);
      if (h.payment === 'failed') return refuse(502, 'payment_could_not_start');
    }
    const fresh = await call(deps, 'fetch_v2_payment_context', { p_request: b.request_id });
    if (!fresh.payment_intent_id) return refuse(503, 'payment_provider_unavailable');
    let pi: PaymentIntent;
    try { pi = await deps.stripe.retrieve(fresh.payment_intent_id); } catch (e) { if (e instanceof StripeUnavailable) return refuse(503, 'payment_provider_unavailable'); throw e; }
    const s = await applyIntent(deps, b.request_id, pi, 'requester');
    const needs = pi.status === 'requires_action' || pi.status === 'requires_payment_method';
    return { status: 200, body: { ok: true, request_id: b.request_id, payment: s.payment_status,
      ...(needs && b.action === 'complete' ? { client_secret: pi.client_secret } : {}) } };
  });
}

/** The assigned driver: refresh the hold before collecting, release, agree to a cancellation, or deliver (capture → delivered). */
export function handleDriverAction(driverId: string | null, body: unknown, deps: PaymentDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(driverId, deps, ['fetch_v2_driver']);
    if (blocked) return blocked;
    const b = (body ?? {}) as Json;
    if (typeof b.request_id !== 'string' || !UUID.test(b.request_id)) return refuse(400, 'invalid_request');
    const requestId = b.request_id;
    const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: requestId });
    if (!ctx?.request_id || (ctx.driver_id !== driverId && ctx.attempt_driver_id !== driverId)) return notFound;

    switch (b.action) {
      case 'refresh_hold': {
        if (!ctx.payment_intent_id) return { status: 200, body: { ok: true, request_id: requestId, payment: ctx.payment_status, can_collect: false } };
        let pi: PaymentIntent;
        try { pi = await deps.stripe.retrieve(ctx.payment_intent_id); } catch (e) { if (e instanceof StripeUnavailable) return refuse(503, 'payment_provider_unavailable'); throw e; }
        const s = await applyIntent(deps, requestId, pi, 'driver_refresh');
        const ready = await call(deps, 'fetch_v2_hold_ready', { p_request: requestId });
        return { status: 200, body: { ok: true, request_id: requestId, payment: s.payment_status, can_collect: ready.ok === true, reason: ready.ok ? undefined : ready.reason } };
      }
      case 'release': {
        const r = await call(deps, 'fetch_v2_release', { p_actor: driverId, p_request: requestId, p_reason: b.reason ?? null, p_note: typeof b.note === 'string' ? b.note.slice(0, 500) : null });
        const refused = fromSql(r); if (refused) return refused;
        const settled = await voidAndRetire(deps, requestId, ctx.payment_intent_id);
        return { status: 200, body: { ok: true, request_id: requestId, status: r.status, already: r.already === true, hold: settled } };
      }
      case 'agree_cancellation': {
        const r = await call(deps, 'fetch_v2_agree_cancellation', { p_driver: driverId, p_request: requestId });
        const refused = fromSql(r); if (refused) return refused;
        const settled = await voidAndRetire(deps, requestId, ctx.payment_intent_id);
        return { status: 200, body: { ok: true, request_id: requestId, status: r.status, already: r.already === true, hold: settled } };
      }
      case 'deliver': {
        const pre = await call(deps, 'fetch_v2_delivery_precheck', { p_driver: driverId, p_request: requestId, p_left_in_safe_place: b.left_in_safe_place === true });
        if (pre.ok === false) return pre.code === 'not_found' ? notFound : fromSql(pre)!;
        if (!pre.already) {
          const failed = await captureOwed(deps, requestId, driverId!, ctx);
          if (failed) return failed;
        }
        const r = await call(deps, 'fetch_v2_complete_delivery', { p_driver: driverId, p_request: requestId, p_left_in_safe_place: b.left_in_safe_place === true });
        const refused = fromSql(r); if (refused) return refused;
        return { status: 200, body: { ok: true, request_id: requestId, status: r.status, already: r.already === true } };
      }
      default:
        return refuse(400, 'invalid_request');
    }
  });
}

/** P0 admin payment actions. Amounts are decided by the database; an override is validated there and needs a reason. */
export function handleAdmin(adminId: string | null, body: unknown, deps: PaymentDeps): Promise<Outcome> {
  return wrap(async () => {
    const blocked = await guard(adminId, deps, ['fetch_v2_admin']);
    if (blocked) return blocked;
    if (!(await deps.isAdmin(adminId!))) return refuse(403, 'forbidden');
    const b = (body ?? {}) as Json;
    if (typeof b.request_id !== 'string' || !UUID.test(b.request_id)) return refuse(400, 'invalid_request');
    const requestId = b.request_id;
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 1000) : null;
    const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: requestId });
    if (!ctx?.request_id) return notFound;
    const done = (r: Json, extra: Json = {}): Outcome => ({ status: 200, body: { ok: true, request_id: requestId, status: r.status, already: r.already === true, ...extra } });

    switch (b.action) {
      case 'cancel': {
        const r = await call(deps, 'fetch_v2_admin_cancel', { p_admin: adminId, p_request: requestId, p_reason: reason });
        const refused = fromSql(r); if (refused) return refused;
        return done(r, { hold: await voidAndRetire(deps, requestId, ctx.payment_intent_id) });
      }
      case 'return_to_board': {
        const r = await call(deps, 'fetch_v2_release', { p_actor: adminId, p_request: requestId, p_reason: reason, p_note: null });
        const refused = fromSql(r); if (refused) return refused;
        return done(r, { hold: await voidAndRetire(deps, requestId, ctx.payment_intent_id) });
      }
      case 'resolve_cancellation': {
        const r = await call(deps, 'fetch_v2_resolve_cancellation', { p_admin: adminId, p_request: requestId, p_decision: b.decision, p_reason: reason });
        const refused = fromSql(r); if (refused) return refused;
        return done(r, r.status === 'cancelled' ? { hold: await voidAndRetire(deps, requestId, ctx.payment_intent_id) } : {});
      }
      case 'resolve_return': {
        const override = b.override_capture_pence == null ? null : Number.isInteger(b.override_capture_pence) ? b.override_capture_pence : NaN;
        if (Number.isNaN(override)) return refuse(400, 'invalid_request');
        const r = await call(deps, 'fetch_v2_resolve_return', { p_admin: adminId, p_request: requestId, p_outcome: b.outcome, p_fault: b.fault,
          p_override_capture_pence: override, p_reason: reason });
        const refused = fromSql(r); if (refused) return refused;
        if (Number(r.capture_pence) > 0) {
          const failed = await captureOwed(deps, requestId, ctx.driver_id, ctx);
          if (failed) return { status: failed.status, body: { ...failed.body, resolution: 'recorded', capture_pence: r.capture_pence } };
          return done(r, { capture_pence: r.capture_pence, payment: 'captured' });
        }
        return done(r, { capture_pence: 0, hold: await voidHold(deps, requestId, ctx.payment_intent_id) });
      }
      case 'retry_capture': {
        if (!['returned', 'collected', 'undeliverable'].includes(ctx.status)) return refuse(409, 'invalid_state');
        const failed = await captureOwed(deps, requestId, ctx.driver_id, ctx);
        return failed ?? done(ctx, { payment: 'captured' });
      }
      case 'void_hold': {
        if (!reason || reason.trim().length < 3) return refuse(400, 'reason_required');
        if (['collected', 'undeliverable'].includes(ctx.status)) return refuse(409, 'item_in_transit');
        return done(ctx, { hold: await voidHold(deps, requestId, ctx.payment_intent_id) });
      }
      case 'reconcile': {
        if (!ctx.payment_intent_id) return done(ctx, { payment: ctx.payment_status });
        const s = await applyIntent(deps, requestId, await deps.stripe.retrieve(ctx.payment_intent_id), 'admin_reconcile');
        return done(ctx, { payment: s.payment_status });
      }
      default:
        return refuse(400, 'invalid_request');
    }
  });
}

/** The timed runner: lifecycle sweeps, then payment work. Every item is independent and repeat-safe; one failure never stops the rest. */
export async function runSweeps(deps: PaymentDeps): Promise<Record<string, number>> {
  const out: Record<string, number> = { expired: 0, unpaid_released: 0, cancel_escalated: 0, voided: 0, retired: 0, rotated: 0,
    escalated: 0, captured: 0, refreshed: 0, deferred: 0, errors: 0 };
  const safely = async (f: () => Promise<void>) => { try { await f(); } catch { out.errors++; } };
  await safely(async () => { out.expired = Number((await deps.rpc('fetch_v2_expire_due', {})).data ?? 0); });
  await safely(async () => {
    const { data } = await deps.rpc('fetch_v2_release_unpaid_due', {});
    for (const row of (data ?? []) as Json[]) {
      out.unpaid_released++;
      await safely(async () => { const s = await voidAndRetire(deps, row.request_id, row.payment_intent_id); if (s !== 'retired') out.deferred++; });
    }
  });
  await safely(async () => { out.cancel_escalated = Number((await deps.rpc('fetch_v2_escalate_cancel_requests', {})).data ?? 0); });
  const { data: work } = await deps.rpc('fetch_v2_payment_work', {});
  for (const w of (work ?? []) as Json[]) {
    await safely(async () => {
      switch (w.action) {
        case 'void_orphan': { const s = await voidAndRetire(deps, w.request_id, w.payment_intent_id); if (s === 'retired') { out.voided++; out.retired++; } else out.deferred++; break; }
        case 'retire': { const r = await call(deps, 'fetch_v2_retire_authorisation', { p_request: w.request_id }); if (r.ok) out.retired++; break; }
        case 'rotate': {
          const v = await voidHold(deps, w.request_id, w.payment_intent_id);
          if (v === 'pending' || v === 'captured') { out.deferred++; break; }
          const r = await call(deps, 'fetch_v2_rotate_authorisation', { p_request: w.request_id, p_reason: 'hold expiring or expired before collection' });
          if (!r.ok) { out.deferred++; break; }
          await placeHold(deps, w.driver_id, w.request_id);
          out.rotated++; break;
        }
        case 'escalate': { await call(deps, 'fetch_v2_escalate_payment', { p_request: w.request_id, p_reason: 'Card hold expiring or expired after collection' }); out.escalated++; break; }
        case 'capture_return': {
          const ctx = await call(deps, 'fetch_v2_payment_context', { p_request: w.request_id });
          if (!(await captureOwed(deps, w.request_id, ctx.driver_id, ctx))) out.captured++; else out.deferred++;
          break;
        }
        case 'refresh': { await applyIntent(deps, w.request_id, await deps.stripe.retrieve(w.payment_intent_id), 'runner_refresh'); out.refreshed++; break; }
      }
    });
  }
  return out;
}

/** Webhook hand-off: a Fetch v2 PaymentIntent event is reconciled from Stripe's CURRENT state, so replays and out-of-order delivery
 *  converge on the truth. Returns false when the object is not a Fetch v2 intent (the webhook carries on as before). */
export function isFetchV2Intent(eventType: string, obj: Json | null | undefined): boolean {
  return eventType.startsWith('payment_intent.') && obj?.object === 'payment_intent' && typeof obj?.metadata?.fetch_v2_request_id === 'string'
    && UUID.test(obj.metadata.fetch_v2_request_id);
}
export async function handleFetchV2Webhook(eventType: string, obj: Json, deps: Pick<PaymentDeps, 'rpc' | 'stripe'>): Promise<Json> {
  const requestId = obj.metadata.fetch_v2_request_id as string;
  let pi: PaymentIntent;
  try {
    pi = await deps.stripe.retrieve(obj.id);
  } catch (e) {
    if (!(e instanceof StripeUnavailable)) throw e;
    // Could not read the current state: fall back to the event's own snapshot (still scoped and never-backwards in SQL).
    pi = { id: obj.id, status: obj.status, amount: obj.amount ?? 0, amount_capturable: obj.amount_capturable ?? 0,
      amount_received: obj.amount_received ?? 0, client_secret: null, capture_before: null, metadata: obj.metadata ?? {} };
  }
  return await applyIntent(deps as PaymentDeps, requestId, pi, `webhook:${eventType}`);
}

/**
 * editions-commerce-core.ts — the pure heart of Editions payments. NO Deno, NO network, NO secrets: it only turns data into data, so it is unit-tested
 * with Node's built-in runner (editions-commerce-core.node.test.ts) and the edge functions stay thin.
 *
 *   isEditionObject     the guard the SHARED stripe-webhook uses to leave Edition objects alone (and the Editions webhook uses to ignore everything else)
 *   verifyStripeSignature   HMAC check with a replay window
 *   routeEditionEvent   a verified provider event  ->  the exact service-role database calls it implies (or "ignore")
 *   *Params             the form fields for creating provider objects. The amount ALWAYS comes from a database "prepare" result, never from a client.
 *
 * Nothing here enables payments: the functions that call it are not deployed, and the database refuses money while editions.commerce.enabled is not 'true'.
 */

export const EDITION_KINDS = ['edition_order', 'edition_participation', 'edition_membership', 'edition_organiser'] as const;
export type EditionKind = (typeof EDITION_KINDS)[number];

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Every place an Edition object can carry its marker: the object, a subscription's metadata copied onto an invoice, or an invoice line. */
export function editionKind(obj: unknown): EditionKind | null {
  const o = asObj(obj);
  const candidates = [asObj(o.metadata).kind, asObj(asObj(o.subscription_details).metadata).kind, asObj(asObj(asObj(asObj(o.lines).data as unknown[])[0] as Obj).metadata).kind, asObj(asObj(o.parent).subscription_details && asObj(asObj(o.parent).subscription_details).metadata).kind];
  for (const c of candidates) if (typeof c === 'string' && (EDITION_KINDS as readonly string[]).includes(c)) return c as EditionKind;
  return null;
}
/** True when an event belongs to Editions commerce. The shared webhook returns early on this; the Editions webhook processes ONLY this. */
export const isEditionObject = (_eventType: string, obj: unknown): boolean => editionKind(obj) !== null;

/** Stripe-Signature check (t=..,v1=..) with HMAC-SHA256 and a replay window. Pure WebCrypto: runs in Deno and Node. */
export async function verifyStripeSignature(payload: string, header: string, secret: string, nowSec: number, toleranceSec = 300): Promise<Obj> {
  if (!secret) throw new Error('no signing secret configured');
  const parts = Object.fromEntries(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  const t = Number(parts.t); const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!Number.isFinite(t) || sigs.length === 0) throw new Error('malformed signature header');
  if (Math.abs(nowSec - t) > toleranceSec) throw new Error('signature timestamp outside the allowed window');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ok = sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
  if (!ok) throw new Error('signature mismatch');
  return JSON.parse(payload) as Obj;
}
export async function signForTest(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type Call = { fn: string; args: Record<string, unknown> };
export type Routed =
  | { action: 'ignore'; reason: string }
  | { action: 'calls'; calls: Call[]; onlyIfKnownPaymentIntent?: string; needsChargeDetail?: { chargeId: string } };

const iso = (sec: unknown) => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const ignore = (reason: string): Routed => ({ action: 'ignore', reason });

/**
 * Turns one verified provider event into database calls. Defensive by design: an object without a valid Edition marker and valid ids is ignored (never guessed
 * at); amounts must be integers. The database re-validates everything (amount equals the stored order/quote, idempotent on the provider id).
 */
export function routeEditionEvent(event: Obj): Routed {
  const type = str(event.type) ?? '';
  const obj = asObj(asObj(event.data).object);
  const kind = editionKind(obj);
  // dispute objects carry no marker of their own: the caller checks the payment intent against the ledger first
  if (type.startsWith('charge.dispute.')) {
    const pi = str(obj.payment_intent);
    return pi ? { action: 'calls', onlyIfKnownPaymentIntent: pi, calls: [{ fn: 'edition_payment_disputed', args: { p_payment_intent: pi, p_reason: str(obj.reason) ?? 'unknown' } }] } : ignore('dispute without payment intent');
  }
  // A refund of a SUBSCRIPTION charge: the charge itself carries no Edition marker (the marker lives on the subscription and invoice), so route it exactly like a dispute:
  // by payment intent, and only if the ledger already knows that payment intent.
  if (!kind && type === 'charge.refunded') {
    const pi = str(obj.payment_intent), total = int(obj.amount_refunded);
    return pi && total !== null ? { action: 'calls', onlyIfKnownPaymentIntent: pi, calls: [{ fn: 'edition_payment_refunded', args: { p_payment_intent: pi, p_refunded_total: total } }] } : ignore('not an Edition object');
  }
  // an organiser disconnected their Stripe account from the platform: the event's own `account` is the connected account; only the ledger can say whether it is ours
  if (type === 'account.application.deauthorized') {
    const acct = str(event.account);
    return acct && /^acct_[A-Za-z0-9]+$/.test(acct) ? { action: 'calls', calls: [{ fn: 'edition_payout_account_disconnected', args: { p_account: acct } }] } : ignore('deauthorization without an account');
  }
  if (!kind) return ignore('not an Edition object');
  const meta = asObj(obj.metadata);
  const subMeta = asObj(asObj(obj.subscription_details).metadata);
  const m = { ...subMeta, ...meta };

  switch (type) {
    case 'account.updated': {
      if (kind !== 'edition_organiser') return ignore('account kind');
      const org = uuid(meta.organiser_id), acct = str(obj.id);
      if (!org || !acct) return ignore('bad account metadata');
      return { action: 'calls', calls: [{ fn: 'edition_payout_account_sync', args: { p_org: org, p_account: acct, p_details: obj.details_submitted === true, p_charges: obj.charges_enabled === true, p_payouts: obj.payouts_enabled === true,
        p_requirements: (asObj(obj.requirements).currently_due as unknown[] | undefined) ?? [] } }] };
    }
    case 'payment_intent.succeeded': {
      const pi = str(obj.id), paid = int(obj.amount_received);
      if (!pi || paid === null) return ignore('bad payment intent');
      if (kind === 'edition_order') { const o = uuid(m.order_id); return o ? { action: 'calls', calls: [{ fn: 'edition_fulfil_order', args: { p_order: o, p_payment_intent: pi, p_amount: paid } }] } : ignore('bad order id'); }
      if (kind === 'edition_participation') {
        const l = uuid(m.link_id); if (!l) return ignore('bad link id');
        return { action: 'calls', needsChargeDetail: str(obj.latest_charge) ? { chargeId: str(obj.latest_charge)! } : undefined,
          calls: [{ fn: 'edition_participation_payment_succeeded', args: { p_link: l, p_payment_intent: pi, p_charge: str(obj.latest_charge), p_charge_pence: paid, p_stripe_fee: null } }] };
      }
      return ignore('membership payments arrive as invoices');
    }
    case 'payment_intent.payment_failed': {
      const pi = str(obj.id);
      if (kind === 'edition_order') { const o = uuid(m.order_id); return o && pi ? { action: 'calls', calls: [{ fn: 'edition_order_failed', args: { p_order: o, p_payment_intent: pi } }] } : ignore('bad order id'); }
      if (kind === 'edition_participation') { const l = uuid(m.link_id); return l && pi ? { action: 'calls', calls: [{ fn: 'edition_participation_payment_failed', args: { p_link: l, p_payment_intent: pi } }] } : ignore('bad link id'); }
      return ignore('not a one-off payment');
    }
    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      if (kind !== 'edition_membership') return ignore('invoice kind');
      const mem = uuid(m.membership_id), inv = str(obj.id), paid = int(obj.amount_paid);
      const line = asObj((asObj(obj.lines).data as unknown[] | undefined)?.[0]); const period = asObj(line.period);
      const start = iso(period.start), end = iso(period.end);
      if (!mem || !inv || paid === null || !start || !end) return ignore('bad membership invoice');
      return { action: 'calls', needsChargeDetail: str(obj.charge) ? { chargeId: str(obj.charge)! } : undefined,
        calls: [{ fn: 'edition_membership_payment_succeeded', args: { p_membership: mem, p_subscription: str(obj.subscription), p_payment_intent: str(obj.payment_intent), p_invoice: inv, p_charge: str(obj.charge), p_period_start: start, p_period_end: end, p_charge_pence: paid, p_stripe_fee: null, p_platform_fee: null } }] };
    }
    case 'invoice.payment_failed': {
      if (kind !== 'edition_membership') return ignore('invoice kind');
      const mem = uuid(m.membership_id), inv = str(obj.id);
      return mem && inv ? { action: 'calls', calls: [{ fn: 'edition_membership_payment_failed', args: { p_membership: mem, p_invoice: inv, p_attempt_count: int(obj.attempt_count) ?? 1 } }] } : ignore('bad membership invoice');
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (kind !== 'edition_membership') return ignore('subscription kind');
      const mem = uuid(meta.membership_id); if (!mem) return ignore('bad membership id');
      const item = asObj((asObj(obj.items).data as unknown[] | undefined)?.[0]);
      const end = iso(item.current_period_end ?? obj.current_period_end);
      return { action: 'calls', calls: [{ fn: 'edition_membership_subscription_changed', args: { p_membership: mem, p_status: type.endsWith('deleted') ? 'canceled' : str(obj.status) ?? 'active', p_cancel_at_period_end: obj.cancel_at_period_end === true, p_period_end: end } }] };
    }
    case 'charge.refunded': {
      const total = int(obj.amount_refunded), pi = str(obj.payment_intent);
      if (total === null) return ignore('bad refund');
      if (kind === 'edition_order') { const o = uuid(m.order_id); return o ? { action: 'calls', calls: [{ fn: 'edition_refund_order', args: { p_order: o, p_refunded_total: total } }] } : ignore('bad order id'); }
      return pi ? { action: 'calls', calls: [{ fn: 'edition_payment_refunded', args: { p_payment_intent: pi, p_refunded_total: total } }] } : ignore('refund without payment intent');
    }
    default: return ignore(`unhandled event ${type}`);
  }
}

/* ── provider object parameters (form fields) ─────────────────────────────────────────────────────────────────── */

export type Prepared = { organiser_id: string; charge_pence: number; platform_fee_pence: number; price_pence: number; vat_pence?: number; net_to_organiser_pence?: number };
const base = (kind: EditionKind, meta: Record<string, string>) => {
  const p: Record<string, string> = { currency: 'gbp', 'metadata[kind]': kind };
  for (const [k, v] of Object.entries(meta)) p[`metadata[${k}]`] = v;
  return p;
};
const assertPence = (n: number, what: string) => { if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be integer pence`); };

/** Organiser buys a package: the platform keeps all of it, so NO transfer and NO application fee. */
export function orderIntentParams(o: { order_id: string; organiser_id: string; amount_pence: number; edition_id: string; buyer_id: string }): Record<string, string> {
  assertPence(o.amount_pence, 'amount');
  return { ...base('edition_order', { order_id: o.order_id, organiser_id: o.organiser_id, edition_id: o.edition_id, buyer_id: o.buyer_id }), amount: String(o.amount_pence), 'automatic_payment_methods[enabled]': 'true' };
}
/** Business pays an organiser for participation: destination charge to the organiser's connected account, platform fee as the application fee. */
export function participationIntentParams(prep: Prepared & { link_id: string; business_id: string; edition_id: string }, connectedAccount: string, buyerId: string, customer: string | null): Record<string, string> {
  assertPence(prep.charge_pence, 'charge'); assertPence(prep.platform_fee_pence, 'fee');
  if (prep.platform_fee_pence > prep.charge_pence) throw new Error('fee exceeds the charge');
  if (!/^acct_[A-Za-z0-9]+$/.test(connectedAccount)) throw new Error('invalid connected account');
  const p: Record<string, string> = { ...base('edition_participation', { link_id: prep.link_id, organiser_id: prep.organiser_id, business_id: prep.business_id, edition_id: prep.edition_id, buyer_id: buyerId }),
    amount: String(prep.charge_pence), 'automatic_payment_methods[enabled]': 'true', 'transfer_data[destination]': connectedAccount };
  if (prep.platform_fee_pence > 0) p.application_fee_amount = String(prep.platform_fee_pence);
  if (customer) p.customer = customer;
  return p;
}
/** application_fee_percent for a subscription: Stripe takes a percentage per invoice, so express the computed fee as a percent of the charge (2 dp, rounded down so we never over-collect). */
export const feePercent = (feePence: number, chargePence: number): number => (chargePence <= 0 ? 0 : Math.min(50, Math.floor((feePence / chargePence) * 10000) / 100));
/** The Stripe Product a membership subscription's inline price hangs off. Stripe's subscription price_data REQUIRES an existing product id (product_data is only allowed in Checkout), found by testing against Stripe's API spec. */
export function productParams(prep: { membership_id: string; organiser_id: string; tier_id: string; tier_name: string }): Record<string, string> {
  return { name: `${prep.tier_name} membership`.slice(0, 250), 'metadata[kind]': 'edition_membership_product', 'metadata[membership_id]': prep.membership_id, 'metadata[organiser_id]': prep.organiser_id, 'metadata[tier_id]': prep.tier_id };
}
/** A card membership: a Stripe Subscription whose invoices are destination charges. The price is inline (price_data) so no client or catalogue price can leak in. */
export function subscriptionParams(prep: Prepared & { membership_id: string; business_id: string; tier_id: string; tier_name: string; interval: 'monthly' | 'annual' }, connectedAccount: string, customer: string, productId: string): Record<string, string> {
  if (!/^prod_[A-Za-z0-9]+$/.test(productId)) throw new Error('invalid product');
  assertPence(prep.charge_pence, 'charge');
  if (!/^acct_[A-Za-z0-9]+$/.test(connectedAccount)) throw new Error('invalid connected account');
  if (prep.interval !== 'monthly' && prep.interval !== 'annual') throw new Error('invalid interval');
  const p: Record<string, string> = { customer, 'items[0][price_data][currency]': 'gbp', 'items[0][price_data][unit_amount]': String(prep.charge_pence),
    'items[0][price_data][recurring][interval]': prep.interval === 'monthly' ? 'month' : 'year', 'items[0][price_data][product]': productId,
    payment_behavior: 'default_incomplete', 'payment_settings[save_default_payment_method]': 'on_subscription', 'expand[0]': 'latest_invoice.payment_intent', 'transfer_data[destination]': connectedAccount };
  const pct = feePercent(prep.platform_fee_pence, prep.charge_pence);
  if (pct > 0) p.application_fee_percent = String(pct);
  for (const [k, v] of Object.entries({ kind: 'edition_membership', membership_id: prep.membership_id, organiser_id: prep.organiser_id, business_id: prep.business_id, tier_id: prep.tier_id })) p[`metadata[${k}]`] = v;
  return p;
}
export function connectAccountParams(org: { organiser_id: string; email: string; name: string }): Record<string, string> {
  return { type: 'express', country: 'GB', email: org.email, 'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true',
    'business_profile[name]': org.name, 'metadata[kind]': 'edition_organiser', 'metadata[organiser_id]': org.organiser_id };
}
export const refundParams = (r: { payment_intent: string; amount_pence: number; refund_application_fee: boolean; request_id: string }): Record<string, string> => {
  assertPence(r.amount_pence, 'refund');
  return { payment_intent: r.payment_intent, amount: String(r.amount_pence), reverse_transfer: 'true', refund_application_fee: r.refund_application_fee ? 'true' : 'false', 'metadata[kind]': 'edition_refund', 'metadata[request_id]': r.request_id };
};
/**
 * The provider request that ends a card membership's subscription. 'at_period_end' stops renewal but keeps what was paid for; 'now' ends it immediately with no proration and no
 * final invoice. Returned as data so it can be unit-tested and checked against Stripe's API spec.
 */
export function subscriptionCancelRequest(mode: 'at_period_end' | 'now', subscriptionId: string): { method: 'POST' | 'DELETE'; path: string; params: Record<string, string> } {
  if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId)) throw new Error('invalid subscription id');
  return mode === 'at_period_end'
    ? { method: 'POST', path: `/subscriptions/${subscriptionId}`, params: { cancel_at_period_end: 'true' } }
    : { method: 'DELETE', path: `/subscriptions/${subscriptionId}`, params: { invoice_now: 'false', prorate: 'false' } };
}
/**
 * A membership that already has a provider subscription (it has been paid at least once) must NEVER get a second one: the member pays the existing subscription's open invoice instead.
 * Takes the subscription as the provider returned it (latest_invoice.payment_intent expanded) and says what the checkout may do.
 *   'pay'         an invoice is open and needs a card: hand its client secret to Stripe.js
 *   'settled'     nothing is owed (the subscription is current): tell the member, take nothing
 *   'unavailable' anything else (cancelled, processing, no open invoice): take nothing and ask the member to try again or contact support; the webhook settles the membership's status
 */
export function existingSubscriptionDecision(sub: unknown): { action: 'pay'; clientSecret: string } | { action: 'settled' } | { action: 'unavailable' } {
  const s = asObj(sub);
  const status = str(s.status) ?? '';
  if (status === 'active' || status === 'trialing') return { action: 'settled' };
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') {
    const pi = asObj(asObj(s.latest_invoice).payment_intent);
    const secret = str(pi.client_secret), piStatus = str(pi.status) ?? '';
    if (secret && ['requires_payment_method', 'requires_action', 'requires_confirmation'].includes(piStatus)) return { action: 'pay', clientSecret: secret };
  }
  return { action: 'unavailable' };
}

/** Provider failures worth retrying later (rate limit, server error, a request still in flight under the same idempotency key); everything else from the provider is a final answer. */
export const isRetryableProviderStatus = (status: number): boolean => status === 429 || status === 409 || status >= 500 || status === 0;

/** One idempotency key per business action + attempt, so a double submit reaches Stripe as the same request. */
export const idempotencyKey = (kind: string, id: string, attempt: string): string => `ed-${kind}-${id}-${attempt}`.slice(0, 255);
/**
 * Server-derived key for a CHARGE. It is built only from what the database quoted (who, what, how much, where it goes), never from the client's attempt token,
 * so two submits of the same payment always reach Stripe as the same request and can never create two charges. If the quote changes (price, fee, account), the
 * key changes with it, so a stale intent is not reused. (Stripe remembers a key for 24 hours; after that the database refuses a second payment: see
 * edition_participation_payment_succeeded.)
 */
export const chargeKey = (kind: string, id: string, quote: { charge_pence: number; platform_fee_pence?: number; vat_pence?: number }, account: string): string =>
  `ed-${kind}-${id}-c${quote.charge_pence}-f${quote.platform_fee_pence ?? 0}-v${quote.vat_pence ?? 0}-${account.slice(-8)}`.slice(0, 255);

/**
 * Which signing secret may vouch for an event. Stripe Connect (account) events carry a top-level `account`; platform events do not. Each secret is bound to its own
 * kind, so a leak of one cannot forge the other kind of event. Returns null when the unsigned body is not an object we can classify (reject it).
 */
export function expectedSecretKind(rawBody: string): 'platform' | 'connect' | null {
  try { const o = JSON.parse(rawBody); if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null; return typeof o.account === 'string' && o.account.startsWith('acct_') ? 'connect' : 'platform'; } catch { return null; }
}
/** Constant-time string comparison for secrets (bearer tokens): the time taken does not reveal how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
/** Form-encode (Stripe takes application/x-www-form-urlencoded). */
export const formBody = (p: Record<string, string>): string => new URLSearchParams(p).toString();

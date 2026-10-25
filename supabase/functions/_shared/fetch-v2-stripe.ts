/**
 * fetch-v2-stripe.ts — the only Stripe calls Fetch v2 makes (docs/FETCH_V2_IMPLEMENTATION.md, Step 5).
 *
 * Manual-capture destination charges on the driver's Connect account, the same model as v1 Fetch: amount = the frozen maximum hold,
 * transfer_data[destination] = the driver's account, application_fee_amount = OneShetland's frozen service fee. Capture takes only
 * what is owed (Stripe releases the rest), and passes the application fee explicitly so a reduced capture can never carry a fee
 * larger than itself.
 *
 * Every state-changing call carries a deterministic Idempotency-Key from the caller, so a retry after a lost response returns the
 * original object instead of acting twice. The latest charge is expanded so Stripe's own capture deadline (capture_before) is read,
 * never guessed. Errors are typed and never carry the secret key.
 */

export type PaymentIntent = {
  id: string;
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  client_secret: string | null;
  capture_before: number | null;
  metadata: Record<string, string>;
};

/** The card was refused (decline, authentication required…). Stripe may hand back the intent it left behind. */
export class StripeDeclined extends Error {
  readonly code: string;
  readonly intent: PaymentIntent | null;
  constructor(code: string, intent: PaymentIntent | null) { super(`card_error:${code}`); this.code = code; this.intent = intent; }
}
/** Stripe could not be reached or answered 5xx/429: the outcome is unknown, retry with the same key. */
export class StripeUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`stripe_unavailable:${reason}`); this.reason = reason; }
}
/** Stripe refused the request itself (bad account, invalid amount, wrong state). Retrying will not help. */
export class StripeRejected extends Error {
  readonly code: string;
  constructor(code: string) { super(`stripe_rejected:${code}`); this.code = code; }
}

export interface StripeGateway {
  createHold(p: { amount: number; customer: string; paymentMethod: string | null; destination: string; applicationFee: number;
    metadata: Record<string, string>; description: string; idempotencyKey: string }): Promise<PaymentIntent>;
  retrieve(id: string): Promise<PaymentIntent>;
  cancel(id: string, idempotencyKey: string): Promise<PaymentIntent>;
  capture(id: string, amount: number, applicationFee: number, idempotencyKey: string): Promise<PaymentIntent>;
}

// deno-lint-ignore no-explicit-any
export function toIntent(o: any): PaymentIntent {
  const charge = o?.latest_charge && typeof o.latest_charge === 'object' ? o.latest_charge : null;
  const cb = charge?.payment_method_details?.card?.capture_before;
  return {
    id: String(o?.id ?? ''), status: String(o?.status ?? ''), amount: Number(o?.amount ?? 0),
    amount_capturable: Number(o?.amount_capturable ?? 0), amount_received: Number(o?.amount_received ?? 0),
    client_secret: typeof o?.client_secret === 'string' ? o.client_secret : null,
    capture_before: typeof cb === 'number' ? cb : null,
    metadata: o?.metadata && typeof o.metadata === 'object' ? o.metadata : {},
  };
}

// deno-lint-ignore no-explicit-any
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export function stripeGateway(secretKey: string, fetchImpl: FetchLike): StripeGateway {
  const base = 'https://api.stripe.com/v1/payment_intents';
  const call = async (path: string, method: string, params: Record<string, string> = {}, key?: string): Promise<PaymentIntent> => {
    if (!secretKey) throw new StripeUnavailable('not_configured');
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2023-10-16' };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (key) headers['Idempotency-Key'] = key;
    const body = new URLSearchParams(params).toString();
    let res;
    try {
      res = await fetchImpl(method === 'GET' && body ? `${base}${path}?${body}` : `${base}${path}`, { method, headers, body: method === 'POST' ? body : undefined });
    } catch {
      throw new StripeUnavailable('network');
    }
    const json = await res.json().catch(() => null);
    if (res.ok) return toIntent(json);
    if (res.status === 429 || res.status >= 500) throw new StripeUnavailable(`http_${res.status}`);
    const err = json?.error ?? {};
    if (err.type === 'card_error') throw new StripeDeclined(String(err.code ?? err.decline_code ?? 'card_declined'), err.payment_intent ? toIntent(err.payment_intent) : null);
    throw new StripeRejected(String(err.code ?? `http_${res.status}`));
  };
  return {
    createHold: (p) => {
      const params: Record<string, string> = {
        amount: String(p.amount), currency: 'gbp', customer: p.customer, capture_method: 'manual',
        'automatic_payment_methods[enabled]': 'true', 'automatic_payment_methods[allow_redirects]': 'never',
        'transfer_data[destination]': p.destination, application_fee_amount: String(p.applicationFee),
        description: p.description, 'expand[0]': 'latest_charge',
      };
      for (const [k, v] of Object.entries(p.metadata)) params[`metadata[${k}]`] = v;
      if (p.paymentMethod) { params.payment_method = p.paymentMethod; params.confirm = 'true'; }
      return call('', 'POST', params, p.idempotencyKey);
    },
    retrieve: (id) => call(`/${encodeURIComponent(id)}`, 'GET', { 'expand[0]': 'latest_charge' }),
    cancel: (id, key) => call(`/${encodeURIComponent(id)}/cancel`, 'POST', { 'expand[0]': 'latest_charge' }, key),
    capture: (id, amount, fee, key) => call(`/${encodeURIComponent(id)}/capture`, 'POST',
      { amount_to_capture: String(amount), application_fee_amount: String(fee), 'expand[0]': 'latest_charge' }, key),
  };
}

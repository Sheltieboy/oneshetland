/**
 * payment-failure-brake.ts — what stripe-webhook does when a card attempt FAILS.
 *
 * WHY IT EXISTS
 *
 * Starting a payment is rate limited (enforcePaymentStart). That counts how many intents are CREATED. It cannot see the thing
 * card testing actually does: take one client secret and confirm it with card after card, straight from the browser to Stripe.
 * Our server hears about each failure only through the `payment_intent.payment_failed` webhook, so that is where the brake goes:
 *
 *   · each failure is counted against the ACCOUNT it belongs to (payment_failed / payment_failed_day). At the ceiling,
 *     enforcePaymentStart refuses that account a NEW payment start — without spending any of its allowance.
 *   · each failure is counted against the INTENT (pi_failed). When one intent keeps failing, it is CANCELLED, so its client
 *     secret cannot be tried again. A real customer starts a fresh one; an attacker has to come back through the limiter.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never touches an order, a ticket, a membership or any money state, and it never throws into the webhook (the caller wraps
 * it): a failure of the brake must not turn into Stripe retrying — and re-running — the whole event. It also never cancels an
 * intent that belongs to an invoice (Stripe manages those), though it still counts the failure against the account.
 *
 * The counting uses the same limiter and the same table as everything else (claim_rate_limits); there is no second system.
 */

import { PAYMENT_FAILURE_ACTIONS } from './rate-limit.ts';

export interface FailedPayment {
  id: string;
  kind: 'payment_intent' | 'setup_intent';
  customer?: string | null;
  invoice?: string | null;
  metadata?: Record<string, string> | null;
}

export interface BrakeDeps {
  /** The account that owns a Stripe Customer we created, or null. */
  userForCustomer(customerId: string): Promise<string | null>;
  /** Claims one slot. true = there was room (and it is recorded); false = the ceiling was already reached. */
  claim(subject: string, actions: string[]): Promise<boolean>;
  /** Cancels the intent at Stripe so its client secret is dead. */
  cancel(kind: 'payment_intent' | 'setup_intent', id: string): Promise<void>;
}

export interface BrakeResult { userId: string | null; counted: boolean; cancelled: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Which metadata key names the paying account, in each flow (tickets/gifts/units/products, hub, boost/subscription, Fetch). */
export const USER_METADATA_KEYS = ['buyer_id', 'user_id', 'owner_id', 'customer_id'];

/** The account a payment was made by, taken from what OUR checkout stamped on it. Anything that is not a UUID is ignored. */
export function userFromMetadata(meta: Record<string, string> | null | undefined): string | null {
  for (const k of USER_METADATA_KEYS) {
    const v = meta?.[k];
    if (typeof v === 'string' && UUID.test(v)) return v.toLowerCase();
  }
  return null;
}

export async function brakeAfterFailedPayment(deps: BrakeDeps, f: FailedPayment): Promise<BrakeResult> {
  // 1. whose failure is it?
  let userId = userFromMetadata(f.metadata);
  if (!userId && typeof f.customer === 'string' && f.customer) userId = await deps.userForCustomer(f.customer);

  // 2. count it against the account
  let counted = false;
  if (userId) {
    await deps.claim(`user:${userId}`, PAYMENT_FAILURE_ACTIONS);
    counted = true;
  }

  // 3. count it against the intent; the failure that finds the ceiling already reached kills the intent
  const roomLeft = await deps.claim(`pi:${f.id}`, ['pi_failed']);
  let cancelled = false;
  if (!roomLeft && !f.invoice) {
    await deps.cancel(f.kind, f.id);
    cancelled = true;
  }
  return { userId, counted, cancelled };
}

// ── production wiring ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function productionBrakeDeps(supabase: any, stripeKey: string): BrakeDeps {
  return {
    async userForCustomer(customerId) {
      const { data: prof } = await supabase.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle();
      if (prof?.id) return prof.id as string;
      const { data: biz } = await supabase.from('local_businesses').select('owner_id')
        .or(`stripe_customer_id.eq.${customerId},business_stripe_customer_id.eq.${customerId}`).limit(1).maybeSingle();
      return (biz?.owner_id as string | undefined) ?? null;
    },
    async claim(subject, actions) {
      const { data, error } = await supabase.rpc('claim_rate_limits', { p_subject: subject, p_actions: actions });
      if (error) throw new Error(`claim_rate_limits: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return row?.allowed === true;
    },
    async cancel(kind, id) {
      const path = kind === 'setup_intent' ? 'setup_intents' : 'payment_intents';
      const res = await fetch(`https://api.stripe.com/v1/${path}/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Stripe-Version': '2023-10-16',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `payment-brake-cancel-${id}`,
        },
        body: kind === 'payment_intent' ? 'cancellation_reason=abandoned' : '',
      });
      // A refusal (already succeeded, already cancelled, an invoice's intent) is not an error worth failing the webhook for.
      if (!res.ok) console.warn(`[payment-brake] cancel ${id} refused HTTP ${res.status}`);
    },
  };
}

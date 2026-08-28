/**
 * stripe-customer.ts — one OneShetland user, one Stripe Customer.
 *
 * Until this existed, the only place in the product that created a Customer
 * was create-setup-intent, and it did it the way that looks obvious:
 *
 *     read profiles.stripe_customer_id  →  null
 *     POST /v1/customers
 *     write profiles.stripe_customer_id
 *
 * A read, a decision and a write with nothing holding the gap — the same shape
 * as the double Fetch hold that the authorisation registry exists to prevent.
 * Two concurrent calls both read null, both create, and one Customer is
 * orphaned for ever.
 *
 * It also meant every rail that NEEDS a Customer up front had nothing to fall
 * back on. Fetch is the one that does: its PaymentIntent is created when the
 * driver accepts, and a manual-capture intent has to name the Customer then.
 * So a customer who had never paid for anything was answered 400 before any
 * intent existed, and Fix 2's cardless recovery — which continues an intent
 * that must already be there — had nothing to continue.
 *
 * ── How a Customer is recovered rather than duplicated ───────────────────
 *
 *   1. profiles.stripe_customer_id, via claim_stripe_customer. The existing
 *      binding always wins.
 *   2. stripe_customer_claims, the durable registry. A retry after a lost
 *      response finds what the first attempt settled.
 *   3. Stripe's own metadata['supabase_user_id'] search, for a Customer that
 *      was created by a process which then died before it could settle.
 *   4. Creation, under a deterministic idempotency key.
 *
 * Layer 3 is deliberately last and is never the identity: Stripe documents
 * search as unsuitable for read-after-write flows and normally under a minute
 * behind. It recovers an orphan; the registry is what decides.
 */

export type CustomerResult =
  /** The canonical Stripe Customer for this user. */
  | { kind: 'ok'; customerId: string }
  /** Another call is inside Stripe right now. Come back — do not race it. */
  | { kind: 'pending' }
  /** Stripe refused, or could not be reached. Nothing was bound. */
  | { kind: 'error'; message: string };

const STRIPE = 'https://api.stripe.com/v1';
const headersFor = (key: string) => ({
  'Authorization': `Bearer ${key}`,
  'Stripe-Version': '2023-10-16',
});

/**
 * Look for a Customer this user already owns at Stripe.
 *
 * The metadata is stamped on every Customer this product has ever created, so
 * it is a genuine identity — but the SEARCH INDEX is eventually consistent, so
 * a miss proves nothing and is treated as "no answer", never as "none exists".
 */
async function findByMetadata(stripeKey: string, userId: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(`metadata['supabase_user_id']:'${userId}'`);
    const res = await fetch(`${STRIPE}/customers/search?limit=2&query=${q}`, { headers: headersFor(stripeKey) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (rows.length !== 1) {
      // Zero is the ordinary answer for a first-time customer. More than one
      // means something is already wrong, and guessing which is theirs would
      // bind a stranger's card to them — so neither is used.
      if (rows.length > 1) console.error(`[stripe-customer] ${rows.length} customers carry this user's metadata`);
      return null;
    }
    return typeof rows[0]?.id === 'string' ? rows[0].id : null;
  } catch {
    return null;
  }
}

/**
 * The canonical Stripe Customer for an authenticated user, created if needed.
 *
 * `userId` is ALWAYS the identity — never anything from a request body, and
 * never the caller when the caller is not the person being charged. A driver
 * triggers the Fetch authorisation, and the Customer established is the
 * delivery's customer's.
 */
export async function canonicalStripeCustomer(opts: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  stripeKey: string;
  userId: string;
  email?: string | null;
  name?: string | null;
}): Promise<CustomerResult> {
  const { supabase, stripeKey, userId } = opts;

  const { data: claimRows, error: claimErr } = await supabase.rpc('claim_stripe_customer', { p_user: userId });
  if (claimErr) {
    console.error('[stripe-customer] claim failed', claimErr);
    return { kind: 'error', message: 'Could not set up a payment profile just now.' };
  }
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    { outcome: string; stripe_customer_id: string | null } | null;

  if (claim?.outcome === 'bound' && claim.stripe_customer_id) {
    return { kind: 'ok', customerId: claim.stripe_customer_id };
  }
  if (claim?.outcome !== 'claimed') {
    // in_flight. Asking the caller to wait is the whole point: racing the
    // other call is what makes a second Customer.
    return { kind: 'pending' };
  }

  // Recover an orphan before making anything. A Customer created by a process
  // that died before it could settle is still this user's Customer.
  const orphan = await findByMetadata(stripeKey, userId);
  if (orphan) {
    await supabase.rpc('settle_stripe_customer', { p_user: userId, p_customer: orphan });
    return { kind: 'ok', customerId: orphan };
  }

  try {
    const res = await fetch(`${STRIPE}/customers`, {
      method: 'POST',
      headers: {
        ...headersFor(stripeKey),
        'Content-Type': 'application/x-www-form-urlencoded',
        // Deterministic, from the user. If this request is retried at the HTTP
        // layer after Stripe already made the Customer, Stripe hands back the
        // SAME one rather than a second. Nothing random or time-based may
        // appear here, or the recovery it exists for is lost.
        'Idempotency-Key': `oneshetland-customer-${userId}`,
      },
      body: new URLSearchParams({
        email: opts.email ?? '',
        name:  opts.name ?? '',
        // The identity layer 3 recovers on. Stamped by every Customer this
        // product has ever created, including the ones create-setup-intent
        // made before this module existed.
        'metadata[supabase_user_id]': userId,
      }),
    });
    const customer = await res.json().catch(() => ({}));
    if (!res.ok || typeof customer?.id !== 'string') {
      await supabase.rpc('settle_stripe_customer', {
        p_user: userId, p_error: customer?.error?.message ?? `HTTP ${res.status}`,
      });
      console.error('[stripe-customer] create failed', customer?.error?.message);
      return { kind: 'error', message: 'Could not set up a payment profile just now.' };
    }

    // Recorded BEFORE anything else can fail. A function that dies after this
    // point retries into 'bound'; one that died before it is covered by the
    // idempotency key above and the metadata search.
    await supabase.rpc('settle_stripe_customer', { p_user: userId, p_customer: customer.id });
    return { kind: 'ok', customerId: customer.id };
  } catch (e) {
    await supabase.rpc('settle_stripe_customer', {
      p_user: userId, p_error: e instanceof Error ? e.message : 'Stripe unreachable',
    });
    return { kind: 'error', message: 'Could not set up a payment profile just now.' };
  }
}

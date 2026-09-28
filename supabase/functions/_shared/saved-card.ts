/**
 * saved-card.ts — which card OneShetland uses, and whether it still exists.
 *
 * Fetch took `payment_methods?type=card&limit=1` and used whatever Stripe
 * happened to return first, which is not necessarily the card the customer
 * thinks of as theirs, and can change between two calls. Everywhere else asks
 * the Customer for its DEFAULT — so that is what this does.
 *
 * ── Why the default is no longer trusted on its own ──────────────────────
 *
 * This used to read `invoice_settings.default_payment_method` and return it
 * without checking. A detached PaymentMethod is PERMANENTLY unusable — Stripe:
 * "once detached, a PaymentMethod can no longer be used for payments or
 * re-attached to a Customer" — and Stripe's published reference does not say
 * whether detaching clears the Customer's default. So the stored default may
 * point at a dead card, and returning it would hand every saved-card rail a
 * `pm_` that cannot be charged. Worse, ADDING a new card would not have fixed
 * it: the stale default won the first branch every time.
 *
 * So the attached list is the authority and the stored default is only a
 * preference within it. That is correct whichever way Stripe behaves, which is
 * the point — nothing here depends on an undocumented side effect.
 *
 * Raw fetch rather than the SDK: the Fetch functions talk to Stripe over HTTP
 * and pulling the SDK in for one lookup would change their cold-start cost.
 */

const STRIPE = 'https://api.stripe.com/v1';
const headersFor = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Stripe-Version': '2023-10-16',
});
const form = (key: string) => ({
  ...headersFor(key),
  'Content-Type': 'application/x-www-form-urlencoded',
});

export type AttachedCard = { id: string };

/**
 * Every card currently attached to this Customer, newest first (Stripe's own
 * ordering). `null` means we could not ask — which is not the same as "none",
 * and callers must not treat it as such.
 */
export async function listAttachedCards(
  stripeKey: string,
  customerId: string,
): Promise<AttachedCard[] | null> {
  try {
    const res = await fetch(
      `${STRIPE}/customers/${customerId}/payment_methods?type=card&limit=100`,
      { headers: headersFor(stripeKey) },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (!Array.isArray(body?.data)) return null;
    return body.data
      .filter((c: unknown) => typeof (c as AttachedCard)?.id === 'string')
      .map((c: AttachedCard) => ({ id: c.id }));
  } catch {
    return null;
  }
}

/** The Customer's stored default card id, or null. `undefined` = unreadable. */
export async function customerDefaultCard(
  stripeKey: string,
  customerId: string,
): Promise<string | null | undefined> {
  try {
    const res = await fetch(`${STRIPE}/customers/${customerId}`, { headers: headersFor(stripeKey) });
    if (!res.ok) return undefined;
    const customer = await res.json().catch(() => ({}));
    const def = customer?.invoice_settings?.default_payment_method;
    return typeof def === 'string' && def ? def : null;
  } catch {
    return undefined;
  }
}

/**
 * Point the Customer's default at `paymentMethodId`, or clear it with `null`.
 *
 * Verified rather than assumed: Stripe's reference does not document unsetting
 * this field, so the write is followed by a read and the caller is told what is
 * actually there now. Everything that matters is built on the read.
 */
export async function setCustomerDefaultCard(
  stripeKey: string,
  customerId: string,
  paymentMethodId: string | null,
): Promise<{ ok: boolean; now: string | null | undefined }> {
  try {
    const res = await fetch(`${STRIPE}/customers/${customerId}`, {
      method: 'POST',
      headers: form(stripeKey),
      // An empty value is Stripe's convention for unsetting an optional field.
      body: new URLSearchParams({ 'invoice_settings[default_payment_method]': paymentMethodId ?? '' }),
    });
    const now = await customerDefaultCard(stripeKey, customerId);
    return { ok: res.ok && now === paymentMethodId, now };
  } catch {
    return { ok: false, now: undefined };
  }
}

/**
 * Bring the Customer's default into line with the cards that actually exist.
 *
 *   no cards left        → clear it
 *   default still there  → leave it alone
 *   default gone/absent  → promote the newest attached card
 *
 * Deterministic on purpose: "whatever came back first this time" is the bug
 * this module was written to end.
 */
export async function reconcileCustomerDefault(
  stripeKey: string,
  customerId: string,
  attached: AttachedCard[],
): Promise<{ default: string | null; changed: boolean; ok: boolean }> {
  const current = await customerDefaultCard(stripeKey, customerId);
  const stillAttached = typeof current === 'string' && attached.some((c) => c.id === current);

  if (attached.length === 0) {
    if (current === null) return { default: null, changed: false, ok: true };
    const r = await setCustomerDefaultCard(stripeKey, customerId, null);
    return { default: r.now ?? null, changed: true, ok: r.ok };
  }
  if (stillAttached) return { default: current as string, changed: false, ok: true };

  const promote = attached[0].id;
  const r = await setCustomerDefaultCard(stripeKey, customerId, promote);
  return { default: r.ok ? promote : (r.now ?? null), changed: true, ok: r.ok };
}

/**
 * The card to charge for this Customer, or null when there is none.
 *
 * The attached list decides. A stored default that is no longer attached is
 * treated as stale, repaired here at the one trusted server-side point, and
 * never returned.
 */
export async function defaultCardFor(stripeKey: string, customerId: string): Promise<string | null> {
  const attached = await listAttachedCards(stripeKey, customerId);
  if (!attached || attached.length === 0) return null;

  const current = await customerDefaultCard(stripeKey, customerId);
  if (typeof current === 'string' && attached.some((c) => c.id === current)) return current;

  // Either nothing was set, or what was set has been detached. Promote the
  // newest real card so the next call is deterministic rather than "whatever
  // came back first this time". The id is good even if promoting fails.
  const promote = attached[0].id;
  await setCustomerDefaultCard(stripeKey, customerId, promote).catch(() => { /* non-fatal */ });
  return promote;
}

/* ── Canonical "which card, and can I describe it safely?" ───────────────────
 *
 * Everything above answers "which card id". These add the two things the
 * checkouts kept getting wrong on their own:
 *
 *   1. picking the card by the SAME rule everywhere — the Customer's default
 *      when it is really attached, otherwise the newest attached card — instead
 *      of `payment_methods?limit=1`, which is just "whatever Stripe listed first";
 *   2. describing it to the buyer with SAFE metadata only (brand, last4) so a
 *      checkout can say what will be charged before charging it.
 *
 * No card number, expiry, fingerprint or payment-method id ever leaves through
 * the description. The id stays server-side.
 */

export type AttachedCardDetail = { id: string; brand?: string; last4?: string };

/** Stripe brands are short lowercase tokens ('visa', 'amex'…). Anything else is dropped. */
export function safeBrand(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z0-9_]{2,20}$/.test(v) ? v : undefined;
}

/** Exactly four digits, or nothing. */
export function safeLast4(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}$/.test(v) ? v : undefined;
}

/**
 * Like listAttachedCards, but keeps the two display fields. `null` still means
 * "could not ask", which is not the same as "no cards".
 */
export async function listAttachedCardsDetailed(
  stripeKey: string,
  customerId: string,
): Promise<AttachedCardDetail[] | null> {
  try {
    const res = await fetch(
      `${STRIPE}/customers/${customerId}/payment_methods?type=card&limit=100`,
      { headers: headersFor(stripeKey) },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (!Array.isArray(body?.data)) return null;
    return body.data
      .filter((c: unknown) => typeof (c as { id?: unknown })?.id === 'string')
      .map((c: { id: string; card?: { brand?: unknown; last4?: unknown } }) => ({
        id: c.id,
        brand: safeBrand(c.card?.brand),
        last4: safeLast4(c.card?.last4),
      }));
  } catch {
    return null;
  }
}

/**
 * The one selection rule. The stored default wins only if it is really attached
 * (a detached card is permanently unusable); otherwise the newest attached card
 * (Stripe lists newest first). Pure, so it is tested without a network.
 */
export function pickDefaultCard<T extends { id: string }>(
  attached: T[],
  storedDefault: string | null | undefined,
): T | null {
  if (attached.length === 0) return null;
  if (typeof storedDefault === 'string') {
    const hit = attached.find((c) => c.id === storedDefault);
    if (hit) return hit;
  }
  return attached[0];
}

/**
 * The card id to charge for this Customer, chosen by pickDefaultCard, or null
 * when there is none. Throws when Stripe cannot be asked — a failed lookup must
 * never read as "no saved card on file", which is what the per-function
 * `listSavedCard` helpers this replaces also refused to do. Read-only: unlike
 * defaultCardFor it does not repair the stored default.
 */
export async function chargeableCardFor(stripeKey: string, customerId: string): Promise<string | null> {
  const attached = await listAttachedCards(stripeKey, customerId);
  if (attached === null) throw new Error('Stripe payment_methods list failed');
  const stored = await customerDefaultCard(stripeKey, customerId);
  return pickDefaultCard(attached, stored)?.id ?? null;
}

/**
 * saved-card.ts — which card OneShetland uses, asked once.
 *
 * Fetch took `payment_methods?type=card&limit=1` and used whatever Stripe
 * happened to return first, which is not necessarily the card the customer
 * thinks of as theirs, and can change between two calls. Everywhere else
 * already asks the Customer for its DEFAULT and promotes the first card when
 * none is set — the behaviour in local-subscription-intent's firstCard.
 *
 * Raw fetch rather than the SDK: the Fetch functions talk to Stripe over HTTP
 * and pulling the SDK in for one lookup would change their cold-start cost.
 */
export async function defaultCardFor(stripeKey: string, customerId: string): Promise<string | null> {
  const h = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };
  try {
    const cRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { headers: h });
    if (cRes.ok) {
      const customer = await cRes.json();
      const def = customer?.invoice_settings?.default_payment_method;
      if (typeof def === 'string' && def) return def;
    }
    const mRes = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
      { headers: h },
    );
    if (!mRes.ok) return null;
    const methods = await mRes.json();
    const first = methods?.data?.[0]?.id;
    if (typeof first !== 'string' || !first) return null;

    // Promote it, so the next call is deterministic rather than "whatever came
    // back first this time".
    await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'invoice_settings[default_payment_method]': first }),
    }).catch(() => { /* the id is still good even if promoting fails */ });
    return first;
  } catch {
    return null;   // no card is a state to handle, not an error to throw
  }
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforcePaymentStart } from '../_shared/rate-limit.ts';
import { chargeKey, connectAccountParams, existingSubscriptionDecision, formBody, idempotencyKey, orderCheckoutDecision, orderIntentParams, participationIntentParams, productParams, subscriptionParams } from '../_shared/editions-commerce-core.ts';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const STRIPE = 'https://api.stripe.com/v1';

/**
 * create-edition-checkout — starts a payment for Editions. NOT DEPLOYED; refuses unless the database says collection is open.
 *
 * Body: { kind: 'order' | 'participation' | 'membership', id: uuid, attempt: string, edition_id?: uuid }   (an id and an idempotency token, NOTHING about price)
 *
 * The caller's own JWT calls the database "prepare" function, which checks ownership, consent, capacity, the self-payment guard, the collection gate and the
 * charge ceiling, and returns the exact amounts. Only then does this function use the service role to read the connected account and call the provider.
 * Returns { client_secret, ... } for Stripe.js (no card data ever touches this server).
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const asUser = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const limited = await enforcePaymentStart('create-edition-checkout', user.id, corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { kind, id, attempt, edition_id } = await req.json().catch(() => ({}));
    if (!['order', 'participation', 'membership'].includes(kind) || typeof id !== 'string' || typeof attempt !== 'string') return json({ error: 'Bad request' }, 400);
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Payments are not configured' }, 503);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const post = async (path: string, params: Record<string, string>, key: string) => {
      const r = await fetch(`${STRIPE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key, 'Stripe-Version': '2023-10-16' }, body: formBody(params) });
      const j = await r.json(); if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message ?? r.status}`); return j;
    };
    const customerFor = async () => {
      const { data: existing } = await svc.rpc('edition_customer_get', { p_user: user.id });
      if (existing) return String(existing);
      // A DEDICATED customer for organiser commerce: never the Business plan or Hub customer.
      const c = await post('/customers', { email: user.email ?? '', 'metadata[kind]': 'edition_customer', 'metadata[user_id]': user.id }, idempotencyKey('customer', user.id, 'v1'));
      await svc.rpc('edition_customer_set', { p_user: user.id, p_customer: c.id });
      return String(c.id);
    };

    if (kind === 'order') {
      // organiser buys a package: the DATABASE created the order (edition_create_order: owner or admin, approved Edition, stored price). Read it with the service role (the order table's read
      // policy is owner-only, and an admin who created the order must be able to pay it), then re-check who is asking and that the Edition is still approved.
      const { data: order } = await svc.from('edition_orders').select('id, organiser_id, edition_id, amount_pence, status, buyer_id').eq('id', id).maybeSingle();
      const decision = order
        ? orderCheckoutDecision({ order, userId: user.id, canAdmin: (await asUser.rpc('edition_org_can', { p_org: order.organiser_id, p_min: 'admin' })).data === true,
            editionApproved: (await svc.from('editions').select('review_state').eq('id', order.edition_id).maybeSingle()).data?.review_state === 'approved',
            commerceOn: (await asUser.rpc('edition_commerce_enabled')).data === true })
        : orderCheckoutDecision({ order: null, userId: user.id, canAdmin: false, editionApproved: false, commerceOn: false });
      if (!decision.ok || !order) return json({ error: decision.ok ? 'Order not available' : decision.error }, decision.ok ? 404 : decision.status);
      const pi = await post('/payment_intents', orderIntentParams({ order_id: order.id, organiser_id: order.organiser_id, amount_pence: order.amount_pence, edition_id: order.edition_id, buyer_id: user.id }), chargeKey('order', order.id, { charge_pence: order.amount_pence }, order.organiser_id));
      return json({ client_secret: pi.client_secret, payment_intent_id: pi.id });
    }
    if (kind === 'participation') {
      const { data: prep, error } = await asUser.rpc('edition_participation_pay_prepare', { p_link: id, p_attempt: attempt });
      if (error) return json({ error: error.message }, 409);
      const { data: acct } = await svc.rpc('edition_payout_account_for', { p_org: prep.organiser_id });
      if (!acct) return json({ error: 'This organiser cannot take payments right now' }, 409);
      const pi = await post('/payment_intents', participationIntentParams(prep, String(acct), user.id, await customerFor()), chargeKey('participation', id, prep, String(acct)));
      return json({ client_secret: pi.client_secret, payment_intent_id: pi.id, charge_pence: prep.charge_pence, vat_pence: prep.vat_pence });
    }
    // membership: a subscription whose invoices are destination charges
    const { data: prep, error } = await asUser.rpc('edition_membership_pay_prepare', { p_membership: id, p_attempt: attempt });
    if (error) return json({ error: error.message }, 409);
    // A membership that already has a provider subscription (a past-due card) is paid through THAT subscription's open invoice. Creating another would bill the member twice.
    if (prep.existing_subscription) {
      const r = await fetch(`${STRIPE}/subscriptions/${encodeURIComponent(String(prep.existing_subscription))}?expand[]=latest_invoice.payment_intent`, { headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' } });
      const existing = r.ok ? await r.json() : null;
      const d = existingSubscriptionDecision(existing);
      if (d.action === 'pay') return json({ client_secret: d.clientSecret, subscription_id: existing.id, charge_pence: prep.charge_pence, vat_pence: prep.vat_pence });
      if (d.action === 'settled') return json({ error: 'Your membership payments are up to date' }, 409);
      return json({ error: 'We cannot take this payment right now. Please try again shortly or contact support' }, 409);
    }
    const { data: acct } = await svc.rpc('edition_payout_account_for', { p_org: prep.organiser_id });
    if (!acct) return json({ error: 'This organiser cannot take payments right now' }, 409);
    // Stripe's subscription price needs an existing Product: one per membership, created idempotently so a retry reuses it (found by testing against Stripe's API spec)
    const product = await post('/products', productParams({ membership_id: prep.membership_id, organiser_id: prep.organiser_id, tier_id: prep.tier_id, tier_name: prep.tier_name }), idempotencyKey('product', id, 'm'));
    const sub = await post('/subscriptions', subscriptionParams({ ...prep, membership_id: prep.membership_id, tier_id: prep.tier_id, tier_name: prep.tier_name, interval: prep.interval }, String(acct), await customerFor(), String(product.id)), chargeKey('membership', id, prep, String(acct)));
    return json({ client_secret: sub.latest_invoice?.payment_intent?.client_secret ?? null, subscription_id: sub.id, charge_pence: prep.charge_pence, vat_pence: prep.vat_pence });
  } catch (err) {
    console.error('[create-edition-checkout]', (err as Error).message);
    return json({ error: 'Could not start the payment' }, 500);
  }
});
void connectAccountParams;

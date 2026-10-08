import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { executeWalletPayment, type PayBusiness } from '../_shared/wallet-pay.ts';
import { selfPaymentBlock } from '../_shared/self-payment.ts';
import { sendUserPush } from '../_shared/send-push.ts';
import { spawnFetchRequest } from '../_shared/fulfilment.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforcePaymentStart } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';
import { chargeableCardFor } from '../_shared/saved-card.ts';
import {
  attemptIdProblem, payModeFor, mapClaimError, createPaymentIntentOnce, retrievePaymentIntent, isCardDecline, EXPIRED_BODY, IN_PROGRESS_BODY,
} from '../_shared/purchase-attempt.ts';

/**
 * create-product-order-intent — Shop Shetland checkout.
 *
 * Validates the basket server-side (prices, stock, fulfilment rules), then CLAIMS the
 * purchase attempt — one atomic database call that creates the pending product_order and
 * RESERVES its stock, or resolves a repeat of the same attempt to the order it already
 * made — and then takes payment:
 *
 *   pay_with = 'wallet'      → debits the Local Wallet via the shared helper,
 *                              order finalised as paid immediately.
 *   use_saved_card = true    → off-session charge on the saved card; the
 *                              stripe-webhook finalises on payment_intent.succeeded.
 *   otherwise                → returns { clientSecret } for PaymentSheet/Elements.
 *
 * Money: Stripe destination charge to the business's connected account with a
 * 5% platform fee on the GOODS subtotal (product rail; shipping passes through
 * uncharged). Wallet path mirrors this via the wallet rail's transfer.
 *
 * ONE ATTEMPT, ONE ORDER. `client_request_id` is minted by the client once per deliberate
 * checkout and sent with every request for it, retries included. The database keys on
 * (buyer, id): a double-click, a retry after a lost response, two tabs or a replayed call
 * all resolve to the SAME order — no second reservation, no second PaymentIntent, no second
 * wallet debit. It is an idempotency token only; the basket, prices and destination are
 * still resolved here. A reused id for a different basket / address / payment method is a
 * 409, never a silent swap, and a cancelled or expired attempt is never resurrected.
 *
 * Body: {
 *   client_request_id, business_id, items: [{ product_id, variant_id?, qty }],
 *   fulfilment: 'collect' | 'post' | 'fetch',
 *   delivery?: { name, address, postcode, phone?, region_slug? },  // post + fetch
 *                                                    // region_slug required for fetch
 *   note?, pay_with?: 'card' | 'wallet', use_saved_card?: boolean
 * }
 *
 * fulfilment 'fetch': goods paid here (shipping_pence = 0); once paid, a Fetch
 * delivery_request is spawned (already_paid) and the buyer pays the driver's
 * fee through the normal Fetch pre-auth rails when a driver accepts.
 *
 * Unpaid orders expire after 30 min (reminder-runner releases the stock).
 *
 * Replies on a repeat: paid → { charged: true, replayed: true }; unpaid card → the SAME PaymentIntent's state (clientSecret /
 * requires_action / processing); another request is mid-payment → 409 in_progress; cancelled or expired → 409 checkout_expired.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ORDER_TTL_MIN = 30;

// Which card, by the ONE canonical rule (the Customer's default when it is really
// attached, else the newest) rather than "whatever Stripe listed first". Throws
// when Stripe cannot be asked, so an outage never reads as "no saved card".
async function listSavedCard(customerId: string): Promise<string | null> {
  return chargeableCardFor(Deno.env.get('STRIPE_SECRET_KEY') ?? '', customerId);
}

type Item = { product_id: string; variant_id?: string | null; qty: number };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforcePaymentStart('create-product-order-intent', user.id, corsHeaders);
    if ('denied' in limited) return limited.denied;

    const body = await req.json();
    const businessId: string = body.business_id;
    const fulfilment: string = body.fulfilment;
    const items: Item[] = Array.isArray(body.items) ? body.items : [];
    const payWith: string = body.pay_with === 'wallet' ? 'wallet' : 'card';
    // One id per deliberate checkout, sent again on every retry. Idempotency token ONLY — see the header.
    const clientRequestId: string = body.client_request_id;
    if (attemptIdProblem(clientRequestId)) return json({ error: 'client_request_id required', code: 'attempt_id_required' }, 400);
    if (!businessId || !items.length || items.length > 20) return json({ error: 'Bad basket' }, 400);
    if (!['collect', 'post', 'fetch'].includes(fulfilment)) return json({ error: 'Bad fulfilment' }, 400);
    for (const it of items) {
      it.qty = Math.floor(Number(it.qty));
      if (!it.product_id || !Number.isFinite(it.qty) || it.qty < 1 || it.qty > 99) return json({ error: 'Bad basket item' }, 400);
    }

    // ── Business + shipping config ─────────────────────────────────────────
    const { data: biz } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, is_active, accepts_wallet, cashback_percent')
      .eq('id', businessId).maybeSingle();
    if (!biz?.is_active) return json({ error: 'Business not found' }, 404);
    if (biz.owner_id === user.id) return json({ error: "You can't buy from your own shop" }, 403);

    // Selling is Premium, and an active product row is not proof of that by
    // the time somebody clicks buy — a business can lapse with its shop still
    // sitting there. The read policy hides those products, but a basket built
    // ten minutes earlier, or a direct call to this function, would not care.
    // Asked here, before the order row and before Stripe is touched at all.
    //
    // Deliberately the same words the basket already uses for a withdrawn
    // item: a customer has no business learning a shop's billing state.
    const { data: maySell, error: tierErr } = await svc.rpc('business_meets_tier', {
      p_business_id: businessId,
      p_required_tier: 'premium',
    });
    if (tierErr || maySell !== true) {
      return json({ error: 'An item in your basket is no longer available' }, 409);
    }
    // Where does this shop's money go?
    //
    // This used to demand business_stripe_account_id AND
    // business_stripe_payouts_enabled — a column pair set on ZERO businesses,
    // so every shop was refused, not just this one. It also had no fallback:
    // the product model, already settled for event tickets, is that a business
    // uses its owner's central bank unless it has explicitly been given its own.
    // business_payout_destination is that one rule, shared with events.
    const { data: payoutRows, error: payoutErr } = await svc.rpc('business_payout_destination', { p_business: businessId });
    if (payoutErr) {
      console.error('[create-product-order-intent] payout resolve failed:', payoutErr);
      return json({ error: 'Could not check this shop’s payment setup. Please try again.' }, 503);
    }
    const payout = Array.isArray(payoutRows) ? payoutRows[0] : payoutRows;
    const sellerAccountId: string | null = payout?.account_id ?? null;
    if (!sellerAccountId) {
      return json({ error: "This shop isn't quite ready to take payments yet." }, 400);
    }

    // ── You cannot pay yourself by card ───────────────────────────────────────
    // A card order is a destination charge into the seller's connected account. If the buyer controls that account — as the shop's
    // owner, through another business or hub on the same account, or because a shop with no payout account of its own is paid into
    // its owner's central account — the money goes round in a circle that ends in their own bank, and a chargeback is the
    // platform's loss. Asked of the DESTINATION ACCOUNT, the way the wallet route below (executeWalletPayment) and the card
    // membership ask it. BEFORE any stock is reserved, any order row exists or any PaymentIntent is made: a refusal costs nothing.
    if (payWith === 'card') {
      const selfPay = await selfPaymentBlock(svc, user.id, sellerAccountId, 'card');
      if (selfPay) return json(selfPay.body, selfPay.status);
    }

    const { data: ship } = await svc.from('business_shipping').select('*').eq('business_id', businessId).maybeSingle();
    const collectEnabled = ship?.collect_enabled ?? true;
    if (fulfilment === 'collect' && !collectEnabled) return json({ error: 'Collection is not available from this shop' }, 400);
    if (fulfilment === 'post' && !ship?.post_enabled) return json({ error: "This shop doesn't post orders" }, 400);
    if (fulfilment === 'fetch' && !ship?.fetch_enabled) return json({ error: "This shop doesn't offer Fetch delivery" }, 400);
    if (fulfilment === 'post' || fulfilment === 'fetch') {
      const d = body.delivery ?? {};
      if (!d.name?.trim() || !d.address?.trim() || !d.postcode?.trim()) return json({ error: 'Delivery name, address and postcode are needed' }, 400);
      if (fulfilment === 'fetch') {
        // Drivers' runs are matched on region, so a Fetch order needs a real one.
        const { data: reg } = d.region_slug
          ? await svc.from('regions').select('slug').eq('slug', d.region_slug).maybeSingle()
          : { data: null };
        if (!reg) return json({ error: 'Choose the area you want it dropped off in' }, 400);
        // The driver's fee is pre-authorised on the buyer's card the moment
        // they accept, so a card has to be on file — otherwise a driver
        // commits to a run they can't be paid for. (Same gate as Fetch itself.)
        const { data: p } = await svc.from('profiles').select('has_payment_method').eq('id', user.id).maybeSingle();
        if (!p?.has_payment_method) {
          return json({ error: "Add a payment card before choosing Fetch — your driver's fee is authorised when they accept, and only charged on delivery." }, 400);
        }
      }
    }

    // ── Load + validate products, compute snapshot prices ──────────────────
    const productIds = [...new Set(items.map((i) => i.product_id))];
    const { data: products } = await svc
      .from('products')
      .select('id, business_id, title, price_pence, photos, stock_mode, is_active, sold_at, collect_only, free_uk_post')
      .in('id', productIds);
    const pmap = new Map((products ?? []).map((p) => [p.id, p]));
    const variantIds = items.map((i) => i.variant_id).filter(Boolean) as string[];
    const { data: variants } = variantIds.length
      ? await svc.from('product_variants').select('id, product_id, name, price_delta_pence, is_active').in('id', variantIds)
      : { data: [] };
    const vmap = new Map((variants ?? []).map((v) => [v.id, v]));

    let itemsPence = 0;
    let allFreeUkPost = true;
    let totalQty = 0;
    const lines: { product_id: string; variant_id: string | null; title: string; variant_name: string | null; unit_pence: number; qty: number; photo_url: string | null }[] = [];
    for (const it of items) {
      const p = pmap.get(it.product_id);
      if (!p || p.business_id !== businessId || !p.is_active || p.sold_at) return json({ error: 'An item in your basket is no longer available' }, 409);
      if (fulfilment === 'post' && p.collect_only) return json({ error: `"${p.title}" is collect-only` }, 400);
      let unit = p.price_pence as number;
      let variantName: string | null = null;
      if (it.variant_id) {
        const v = vmap.get(it.variant_id);
        if (!v || v.product_id !== p.id || !v.is_active) return json({ error: 'A selected option is no longer available' }, 409);
        unit += v.price_delta_pence as number;
        variantName = v.name as string;
      }
      if (!p.free_uk_post) allFreeUkPost = false;
      itemsPence += unit * it.qty;
      totalQty += it.qty;
      lines.push({
        product_id: p.id, variant_id: it.variant_id ?? null, title: p.title as string,
        variant_name: variantName, unit_pence: unit, qty: it.qty,
        photo_url: (p.photos as string[])?.[0] ?? null,
      });
    }

    // ── Shipping from the rate card ─────────────────────────────────────────
    let shippingPence = 0;
    if (fulfilment === 'post' && !allFreeUkPost) {
      const pc = String(body.delivery.postcode).trim().toUpperCase();
      const isShetland = pc.startsWith('ZE');
      const base = isShetland
        ? (ship!.post_shetland_pence ?? ship!.post_uk_pence ?? 0)
        : (ship!.post_uk_pence ?? 0);
      shippingPence = base + (ship!.post_per_extra_item_pence ?? 0) * Math.max(0, totalQty - 1);
      if (ship!.free_over_pence && itemsPence >= ship!.free_over_pence) shippingPence = 0;
    }

    const totalPence = itemsPence + shippingPence;
    if (totalPence < 50) return json({ error: 'Order total is below the 50p minimum' }, 400);

    // Commission: 5% product rail on GOODS only — postage passes through.
    const cfg = await getCommissionConfig(svc, 'product');
    const commissionPence = calculateCommission(itemsPence, cfg, 'product').fee_pence;

    // ── Claim the attempt (atomic): create the order + reserve its stock, or resolve a repeat ──────────
    //
    // This is the ONE place an order comes into existence. The database keys on (buyer, client_request_id), so of any number
    // of simultaneous or repeated requests for this attempt exactly one creates the order and reserves the stock; the rest are
    // handed that same order. A sold-out line aborts the whole claim — the order row and every earlier reservation vanish
    // together, so nothing is left held and nothing can be released twice.
    const d = body.delivery ?? {};
    const payMode = payModeFor({ wallet: payWith === 'wallet', savedCard: !!body.use_saved_card });
    const { data: claim, error: claimErr } = await svc.rpc('claim_product_order', {
      p_buyer: user.id, p_client_request_id: clientRequestId, p_pay_mode: payMode,
      p_business: businessId, p_fulfilment: fulfilment, p_items: lines,
      p_items_pence: itemsPence, p_shipping_pence: shippingPence, p_total_pence: totalPence, p_commission_pence: commissionPence,
      p_delivery_name: d.name?.trim() || null,
      p_delivery_address: d.address?.trim() || null,
      p_delivery_postcode: d.postcode?.trim() || null,
      p_delivery_region: fulfilment === 'fetch' ? d.region_slug : null,
      p_contact_phone: d.phone?.trim() || null,
      p_buyer_note: body.note?.trim() || null,
      p_ttl_minutes: ORDER_TTL_MIN,
    });
    if (claimErr) {
      const mapped = mapClaimError(claimErr.message);
      if (mapped) return json(mapped.body, mapped.status);
      throw claimErr;
    }
    const orderId: string = claim.order_id;

    // An attempt that already ended is reported, never revived: the client starts a new one.
    if (['cancelled', 'expired', 'refunded'].includes(claim.status)) return json(EXPIRED_BODY, 409);
    // Already paid (or beyond): this is a repeat of a purchase that went through. Nothing to charge, nothing to redo.
    if (claim.status !== 'pending') {
      return json({ charged: true, status: 'succeeded', order_id: orderId, payment_intent_id: claim.payment_intent_id ?? undefined, replayed: true });
    }

    // Give back what a dead attempt reserved — once. The status flip inside the function is the guard, so the failed request,
    // its retry and the expiry sweeper can all call it and the stock still goes back a single time.
    const cancelAttempt = () => svc.rpc('cancel_pending_product_order', { p_order: orderId, p_as: 'cancelled' });

    /** What the caller should be told about a PaymentIntent this attempt already started. */
    const respondForIntent = async (pi: Record<string, any>) => {
      const outcome = classifyIntent(pi);
      if (outcome.kind === 'succeeded') return json({ charged: true, status: 'succeeded', order_id: orderId, payment_intent_id: pi.id, replayed: true });
      if (outcome.kind === 'processing') return json({ status: 'processing', order_id: orderId, payment_intent_id: outcome.id }, 200);
      if (outcome.kind === 'requires_action') return json({ status: 'requires_action', clientSecret: outcome.clientSecret, order_id: orderId, payment_intent_id: outcome.id }, 200);
      // An unfinished card FORM payment (nothing entered yet, or a failed try the customer may repeat on the same intent) is
      // resumed by handing back the same client secret; a saved-card intent in this state was declined and is spent.
      if (payMode === 'card_form' && ['requires_payment_method', 'requires_confirmation'].includes(pi.status) && pi.client_secret) {
        return json({ clientSecret: pi.client_secret, order_id: orderId, payment_intent_id: pi.id });
      }
      await cancelAttempt();
      return json({ status: 'failed', error: failureMessage(outcome.status), order_id: orderId }, 402);
    };

    /* ── A card payment this attempt already started: resume it, never start another ── */
    if (payWith !== 'wallet' && claim.payment_intent_id) {
      return await respondForIntent(await retrievePaymentIntent(String(claim.payment_intent_id)));
    }

    // ── Single-flight the money-moving step ────────────────────────────────────────
    // Whoever holds the lease creates the PaymentIntent / runs the wallet debit. A concurrent repeat is told to wait and moves
    // nothing. The lease goes stale after 90 s so a request that died cannot lock the attempt, and the Stripe and wallet keys
    // below make a takeover safe.
    const { data: leased } = await svc.rpc('claim_purchase_processing', { p_kind: 'product_order', p_id: orderId });
    if (leased !== true) return json(IN_PROGRESS_BODY, 409);
    try {
      // The previous holder may have bound its PaymentIntent between our claim and our lease: look again before creating.
      if (payWith !== 'wallet') {
        const { data: fresh } = await svc.from('product_orders').select('payment_intent_id, status').eq('id', orderId).maybeSingle();
        if (fresh && fresh.status !== 'pending') {
          return ['cancelled', 'expired', 'refunded'].includes(fresh.status)
            ? json(EXPIRED_BODY, 409)
            : json({ charged: true, status: 'succeeded', order_id: orderId, replayed: true });
        }
        if (fresh?.payment_intent_id) return await respondForIntent(await retrievePaymentIntent(String(fresh.payment_intent_id)));
      }

      /* ── Wallet path — finalise immediately ─────────────────────────────── */
      if (payWith === 'wallet') {
        const payBiz: PayBusiness = {
          id: biz.id, name: biz.name, owner_id: biz.owner_id,
          accepts_wallet: biz.accepts_wallet ?? false,
          cashback_percent: biz.cashback_percent,
          stripe_account_id: sellerAccountId,
          payout_enabled: true,   // resolved above, or we would not be here
        };
        // The key is the order id, which is now the same on every repeat of this attempt: a second run finds the debit already
        // applied (alreadyApplied) and does not take the money or make the transfer again.
        const res = await executeWalletPayment(svc, {
          userId: user.id, business: payBiz, amountPence: totalPence,
          idempotencyKey: `product-order-${orderId}`, label: `Shop order at ${biz.name}`,
        });
        if (!res.ok) {
          await cancelAttempt();
          return json({ error: res.error }, res.status);
        }
        // Only the request that flips pending → paid commits the stock and tells the shop; a repeat finds it done.
        const { data: flipped } = await svc.from('product_orders').update({
          status: 'paid', paid_via: 'wallet', paid_at: new Date().toISOString(), expires_at: null,
        }).eq('id', orderId).eq('status', 'pending').select('id').maybeSingle();
        if (!flipped) return json({ charged: true, order_id: orderId, balance_pence: res.balance_pence, replayed: true });

        for (const it of items) {
          await svc.rpc('commit_product_stock', { p_product: it.product_id, p_variant: it.variant_id ?? null, p_qty: it.qty });
        }

        // Loyalty is awarded HERE, at completion — not at the debit. The retired
        // trigger fired on the wallet insert, before the merchant was paid and
        // before this purchase existed, so three later events could undo the spend
        // and none of them gave the points back. Best-effort: a loyalty failure
        // must never fail a purchase that has already been paid for.
        try {
          await svc.rpc('loyalty_award_for_wallet_spend', { p_wallet_txn: res.transactionId });
        } catch (e) { console.error('[create-product-order-intent] loyalty award failed', e); }

        await sendUserPush(svc, {
          userId: biz.owner_id, module: 'business', categoryId: 'business.order',
          title: '🛍️ New shop order!',
          body: `£${(totalPence / 100).toFixed(2)} — ${lines.length === 1 ? lines[0].title : `${totalQty} items`} (${fulfilment})`,
          // NOTE: not `order_id` — that key routes to event tickets in the app.
          data: { screen: 'business-orders', product_order_id: orderId, business_id: businessId },
        });
        // Fetch lane: spawn the delivery request and ping matching drivers now
        // (notify-drivers needs the buyer's JWT, which only this path holds —
        // the card/webhook path spawns without the ping; the request still
        // appears on the Fetch board).
        if (fulfilment === 'fetch') {
          try {
            await spawnFetchRequest(svc, orderId);
            const { data: o2 } = await svc.from('product_orders').select('delivery_request_id').eq('id', orderId).maybeSingle();
            if (o2?.delivery_request_id) {
              fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notify-drivers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: authHeader, apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
                body: JSON.stringify({ request_id: o2.delivery_request_id }),
              }).catch(() => {});
            }
          } catch (e) { console.error('[create-product-order-intent] fetch spawn failed', e); }
        }
        return json({ charged: true, order_id: orderId, balance_pence: res.balance_pence });
      }

      /* ── Card path — PaymentIntent; webhook finalises ───────────────────── */
      const { data: profile } = await svc.from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
      const customerId = profile?.stripe_customer_id ?? null;

      const params: Record<string, string> = {
        amount: String(totalPence),
        currency: 'gbp',
        'metadata[type]':        'product_order',
        'metadata[order_id]':    orderId,
        'metadata[buyer_id]':    user.id,
        'metadata[business_id]': businessId,
        'transfer_data[destination]': sellerAccountId,
        description: `OneShetland shop order at ${biz.name}`,
      };
      if (commissionPence > 0) params['application_fee_amount'] = String(commissionPence);
      if (customerId) params['customer'] = customerId;

      // The Stripe idempotency key comes from the ORDER ROW the database returned — never from anything the client sent. Every
      // repeat of this attempt resolves to the same order id, so every repeat asks Stripe for the same object and gets it.
      const stripeKey = `product-order-${orderId}`;

      if (body.use_saved_card) {
        if (!customerId) { await cancelAttempt(); return json({ error: 'No saved card on file' }, 400); }
        const pm = await listSavedCard(customerId);
        if (!pm) { await cancelAttempt(); return json({ error: 'No saved card on file' }, 400); }
        Object.assign(params, onSessionConfirm(customerId, pm));
        let pi: Record<string, any>;
        try {
          pi = await createPaymentIntentOnce(params, stripeKey);
        } catch (e) {
          // The issuer refused the card. Stripe will give the same refusal for this key every time, so this attempt is over:
          // give the stock back and let the buyer start a new one (or choose another card).
          if (isCardDecline(e)) { await cancelAttempt(); return json({ status: 'failed', error: failureMessage('requires_payment_method'), order_id: orderId }, 402); }
          throw e;
        }
        // Bind the intent to the order BEFORE any branch returns: the webhook may settle it while the cardholder is still
        // authenticating, and a repeat must find THIS intent rather than make another.
        await svc.from('product_orders').update({ payment_intent_id: String(pi.id) }).eq('id', orderId).is('payment_intent_id', null);
        const outcome = classifyIntent(pi);
        if (outcome.kind === 'requires_action') {
          // Middle of a payment: the order stays pending and its reservation
          // stands while the cardholder authenticates THIS intent.
          return json({ status: 'requires_action', clientSecret: outcome.clientSecret, order_id: orderId, payment_intent_id: outcome.id }, 200);
        }
        if (outcome.kind === 'processing') {
          return json({ status: 'processing', order_id: orderId, payment_intent_id: outcome.id }, 200);
        }
        if (outcome.kind !== 'succeeded') {
          // A dead intent — declined or cancelled. Give the stock back (once): a one-off
          // item held by a failed payment is unbuyable by anyone, including the
          // buyer retrying, and nothing else releases it before the 30-minute sweep.
          await cancelAttempt();
          return json({ status: 'failed', error: failureMessage(outcome.status), order_id: orderId }, 402);
        }
        return json({ charged: true, status: 'succeeded', order_id: orderId, payment_intent_id: pi.id });
      }

      params['automatic_payment_methods[enabled]'] = 'true';
      const pi = await createPaymentIntentOnce(params, stripeKey);
      await svc.from('product_orders').update({ payment_intent_id: String(pi.id) }).eq('id', orderId).is('payment_intent_id', null);
      return json({ clientSecret: pi.client_secret, order_id: orderId });
    } finally {
      // Best-effort: a stale lease expires on its own, but there is no reason to make a retry wait for it.
      try { await svc.rpc('release_purchase_processing', { p_kind: 'product_order', p_id: orderId }); } catch { /* the lease expires */ }
    }
  } catch (err) {
    // Nothing is released here on purpose. If the claim succeeded the order is still pending and a repeat of this attempt
    // RESUMES it (same order, same Stripe key); if the buyer walks away the 30-minute sweep gives the stock back.
    console.error('[create-product-order-intent]', err);
    return json({ error: safeError('create-product-order-intent', err) }, 500);
  }
});

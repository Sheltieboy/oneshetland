import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { executeWalletPayment, type PayBusiness } from '../_shared/wallet-pay.ts';
import { sendUserPush } from '../_shared/send-push.ts';

/**
 * create-product-order-intent — Shop Shetland checkout.
 *
 * Validates the basket server-side (prices, stock, fulfilment rules), RESERVES
 * stock atomically, creates a pending product_order, then takes payment:
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
 * Body: {
 *   business_id, items: [{ product_id, variant_id?, qty }],
 *   fulfilment: 'collect' | 'post',
 *   delivery?: { name, address, postcode, phone? },   // post only
 *   note?, pay_with?: 'card' | 'wallet', use_saved_card?: boolean
 * }
 *
 * Unpaid orders expire after 30 min (reminder-runner releases the stock).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';
const ORDER_TTL_MIN = 30;

async function createPaymentIntent(params: Record<string, string>, idempotencyKey: string): Promise<Record<string, unknown>> {
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Content-Type':    'application/x-www-form-urlencoded',
      'Stripe-Version':  STRIPE_API_VERSION,
      'Idempotency-Key': idempotencyKey,
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: { message?: string } }).error?.message ?? `Stripe PaymentIntent failed (HTTP ${res.status})`);
  return json;
}

async function listSavedCard(customerId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
    { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? 'Stripe payment_methods list failed');
  return data.data?.[0]?.id ?? null;
}

type Item = { product_id: string; variant_id?: string | null; qty: number };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Track reservations made so far so ANY failure path releases them.
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const reservedSoFar: Item[] = [];
  const releaseAll = async () => {
    for (const r of reservedSoFar) {
      await svc.rpc('release_product_stock', { p_product: r.product_id, p_variant: r.variant_id ?? null, p_qty: r.qty });
    }
  };

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const body = await req.json();
    const businessId: string = body.business_id;
    const fulfilment: string = body.fulfilment;
    const items: Item[] = Array.isArray(body.items) ? body.items : [];
    const payWith: string = body.pay_with === 'wallet' ? 'wallet' : 'card';
    if (!businessId || !items.length || items.length > 20) return json({ error: 'Bad basket' }, 400);
    if (!['collect', 'post'].includes(fulfilment)) return json({ error: 'Bad fulfilment' }, 400);
    for (const it of items) {
      it.qty = Math.floor(Number(it.qty));
      if (!it.product_id || !Number.isFinite(it.qty) || it.qty < 1 || it.qty > 99) return json({ error: 'Bad basket item' }, 400);
    }

    // ── Business + shipping config ─────────────────────────────────────────
    const { data: biz } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, is_active, accepts_wallet, cashback_percent, business_stripe_account_id, business_stripe_payouts_enabled')
      .eq('id', businessId).maybeSingle();
    if (!biz?.is_active) return json({ error: 'Business not found' }, 404);
    if (biz.owner_id === user.id) return json({ error: "You can't buy from your own shop" }, 403);
    if (!biz.business_stripe_account_id || !biz.business_stripe_payouts_enabled) {
      return json({ error: "This shop isn't quite ready to take payments yet." }, 400);
    }

    const { data: ship } = await svc.from('business_shipping').select('*').eq('business_id', businessId).maybeSingle();
    const collectEnabled = ship?.collect_enabled ?? true;
    if (fulfilment === 'collect' && !collectEnabled) return json({ error: 'Collection is not available from this shop' }, 400);
    if (fulfilment === 'post') {
      if (!ship?.post_enabled) return json({ error: "This shop doesn't post orders" }, 400);
      const d = body.delivery ?? {};
      if (!d.name?.trim() || !d.address?.trim() || !d.postcode?.trim()) return json({ error: 'Delivery name, address and postcode are needed' }, 400);
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

    // ── Reserve stock atomically (any failure → everything released) ───────
    for (const it of items) {
      const { data: ok, error } = await svc.rpc('reserve_product_stock', {
        p_product: it.product_id, p_variant: it.variant_id ?? null, p_qty: it.qty,
      });
      if (error || !ok) {
        await releaseAll();
        const t = pmap.get(it.product_id)?.title ?? 'An item';
        return json({ error: `${t} sold out while you were browsing — sorry!` }, 409);
      }
      reservedSoFar.push(it);
    }

    // ── Create the pending order + snapshot items ───────────────────────────
    const d = body.delivery ?? {};
    const { data: order, error: orderErr } = await svc.from('product_orders').insert({
      business_id: businessId,
      buyer_id: user.id,
      status: 'pending',
      fulfilment,
      items_pence: itemsPence,
      shipping_pence: shippingPence,
      total_pence: totalPence,
      commission_pence: commissionPence,
      delivery_name: d.name?.trim() || null,
      delivery_address: d.address?.trim() || null,
      delivery_postcode: d.postcode?.trim() || null,
      contact_phone: d.phone?.trim() || null,
      buyer_note: body.note?.trim() || null,
      expires_at: new Date(Date.now() + ORDER_TTL_MIN * 60_000).toISOString(),
    }).select('id').single();
    if (orderErr || !order) { await releaseAll(); throw orderErr ?? new Error('order insert failed'); }
    await svc.from('product_order_items').insert(lines.map((l) => ({ ...l, order_id: order.id })));

    /* ── Wallet path — finalise immediately ─────────────────────────────── */
    if (payWith === 'wallet') {
      const payBiz: PayBusiness = {
        id: biz.id, name: biz.name, owner_id: biz.owner_id,
        accepts_wallet: biz.accepts_wallet ?? false,
        cashback_percent: biz.cashback_percent,
        stripe_account_id: biz.business_stripe_account_id,
        payout_enabled: biz.business_stripe_payouts_enabled,
      };
      const res = await executeWalletPayment(svc, {
        userId: user.id, business: payBiz, amountPence: totalPence,
        idempotencyKey: `product-order-${order.id}`, label: `Shop order at ${biz.name}`,
      });
      if (!res.ok) {
        await releaseAll();
        await svc.from('product_orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', order.id);
        return json({ error: res.error }, res.status);
      }
      for (const it of items) {
        await svc.rpc('commit_product_stock', { p_product: it.product_id, p_variant: it.variant_id ?? null, p_qty: it.qty });
      }
      await svc.from('product_orders').update({
        status: 'paid', paid_via: 'wallet', paid_at: new Date().toISOString(), expires_at: null,
      }).eq('id', order.id);
      await sendUserPush(svc, {
        userId: biz.owner_id, module: 'business', categoryId: 'business.order',
        title: '🛍️ New shop order!',
        body: `£${(totalPence / 100).toFixed(2)} — ${lines.length === 1 ? lines[0].title : `${totalQty} items`} (${fulfilment})`,
        data: { order_id: order.id, event: 'product_order' },
      });
      return json({ charged: true, order_id: order.id, balance_pence: res.balance_pence });
    }

    /* ── Card path — PaymentIntent; webhook finalises ───────────────────── */
    const { data: profile } = await svc.from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
    const customerId = profile?.stripe_customer_id ?? null;

    const params: Record<string, string> = {
      amount: String(totalPence),
      currency: 'gbp',
      'metadata[type]':        'product_order',
      'metadata[order_id]':    order.id,
      'metadata[buyer_id]':    user.id,
      'metadata[business_id]': businessId,
      'transfer_data[destination]': biz.business_stripe_account_id,
      description: `OneShetland shop order at ${biz.name}`,
    };
    if (commissionPence > 0) params['application_fee_amount'] = String(commissionPence);
    if (customerId) params['customer'] = customerId;

    if (body.use_saved_card) {
      if (!customerId) { await releaseAll(); return json({ error: 'No saved card on file' }, 400); }
      const pm = await listSavedCard(customerId);
      if (!pm) { await releaseAll(); return json({ error: 'No saved card on file' }, 400); }
      params['payment_method'] = pm;
      params['off_session'] = 'true';
      params['confirm'] = 'true';
      const pi = await createPaymentIntent(params, `product-order-${order.id}`);
      await svc.from('product_orders').update({ payment_intent_id: String(pi.id) }).eq('id', order.id);
      return json({ charged: pi.status === 'succeeded', order_id: order.id, payment_intent_id: pi.id });
    }

    params['automatic_payment_methods[enabled]'] = 'true';
    const pi = await createPaymentIntent(params, `product-order-${order.id}`);
    await svc.from('product_orders').update({ payment_intent_id: String(pi.id) }).eq('id', order.id);
    return json({ clientSecret: pi.client_secret, order_id: order.id });
  } catch (err) {
    await releaseAll().catch(() => {});
    console.error('[create-product-order-intent]', err);
    return json({ error: err instanceof Error ? err.message : 'Something went wrong' }, 500);
  }
});

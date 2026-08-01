import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';

/**
 * notify-product-order — tells the BUYER their shop order moved.
 *
 * Called fire-and-forget by the merchant UIs (web + app) right after a status
 * update. Only the business owner (or an admin) may trigger it, and the copy
 * comes from the ORDER's actual status — so a mischievous caller can't invent
 * messages, only cause a re-send of the truth.
 *
 * Body: { order_id: string }   (status is read from the DB, not trusted)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const COPY: Record<string, { title: string; body: (o: { fulfilment: string; tracking_ref: string | null; business: string }) => string }> = {
  accepted:    { title: '🛍️ Order accepted', body: (o) => `${o.business} has your order and it's being prepared.` },
  ready:       { title: '🎉 Ready to collect', body: (o) => `Your order from ${o.business} is ready to pick up.` },
  posted:      { title: '📮 In the post', body: (o) => `${o.business} has posted your order${o.tracking_ref ? ` — tracking ${o.tracking_ref}` : ''}.` },
  handed_over: { title: '🚗 On its way', body: (o) => `Your order from ${o.business} is on its way to you.` },
  cancelled:   { title: 'Order cancelled', body: (o) => `Your order from ${o.business} was cancelled. If you paid, the refund is on its way.` },
  refunded:    { title: 'Order refunded', body: (o) => `Your order from ${o.business} has been refunded.` },
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const { order_id } = await req.json();
    if (!order_id) return json({ error: 'order_id required' }, 400);

    const svc = createServiceClient();
    const { data: order } = await svc
      .from('product_orders')
      .select('id, status, fulfilment, tracking_ref, buyer_id, business_id')
      .eq('id', order_id).maybeSingle();
    if (!order) return json({ error: 'Order not found' }, 404);

    const { data: biz } = await svc
      .from('local_businesses').select('name, owner_id').eq('id', order.business_id).maybeSingle();
    const { data: profile } = await svc.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (biz?.owner_id !== user.id && profile?.role !== 'admin') return json({ error: 'Not allowed' }, 403);

    const copy = COPY[order.status];
    if (!copy) return json({ ok: true, skipped: `no buyer copy for status ${order.status}` });

    await sendUserPush(svc, {
      userId: order.buyer_id,
      module: 'wallet',
      categoryId: 'wallet.order_update',
      title: copy.title,
      body: copy.body({ fulfilment: order.fulfilment, tracking_ref: order.tracking_ref, business: biz?.name ?? 'the shop' }),
      data: { screen: 'my-orders', product_order_id: order.id },
    });
    return json({ ok: true });
  } catch (err) {
    console.error('[notify-product-order]', err);
    return json({ error: String(err) }, 500);
  }
});

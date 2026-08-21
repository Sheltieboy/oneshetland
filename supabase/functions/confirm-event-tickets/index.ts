import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { sendTicketReceipt } from '../_shared/ticket-receipt.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-event-tickets
 *
 * Called after a successful Stripe payment to mark the order and tickets as valid.
 * Idempotent — safe to retry.
 *
 * Body: { order_id: string, payment_intent_id: string }
 * Returns: { ok: true, order_id, tickets_count }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { order_id, payment_intent_id } = await req.json();
    if (!order_id || !payment_intent_id) return new Response(JSON.stringify({ error: 'order_id and payment_intent_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Load order — verify ownership
    const { data: order } = await supabase
      .from('event_ticket_orders')
      .select('id, buyer_id, status, tickets_count, event_id, stripe_payment_intent_id, total_pence, platform_fee_pence')
      .eq('id', order_id)
      .single();

    if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (order.buyer_id !== user.id) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Idempotency — already confirmed
    if (order.status === 'paid') {
      return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Bind the PaymentIntent to THIS order. create-event-ticket-intent stored
    // the order's own PI id at creation, so the only valid PI is that one.
    // Without this, a buyer could pass any other succeeded PI id (e.g. a cheap
    // 50p one, or another order's) with their pending order_id and have these
    // tickets marked valid without paying for them.
    const piToVerify = order.stripe_payment_intent_id ?? payment_intent_id;
    if (order.stripe_payment_intent_id && payment_intent_id !== order.stripe_payment_intent_id) {
      return new Response(JSON.stringify({ error: 'Payment reference does not match this order.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Verify PI with Stripe (always the order's own PI, never a client-substituted one)
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${piToVerify}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
    );
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? 'Stripe lookup failed');

    if (pi.status !== 'succeeded') {
      return new Response(JSON.stringify({ error: `Payment not confirmed (status: ${pi.status})` }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Defence-in-depth: the PI's own metadata must point back at this order + buyer.
    if (pi.metadata?.order_id !== order_id || pi.metadata?.buyer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Payment does not match this order.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Confirm order + tickets
    // Compare-and-swap — see the same guard in _shared/fulfilment.ts. The
    // already-paid check above is a separate round trip from this write, and the
    // Stripe webhook is racing us, so both sides could pass that check. Only the
    // path that actually moves the row off 'pending' runs the side effects.
    const { data: claimed } = await supabase.from('event_ticket_orders').update({
      status:                  'paid',
      paid_at:                 new Date().toISOString(),
      stripe_payment_intent_id: payment_intent_id,
    }).eq('id', order_id).eq('status', 'pending').select('id');

    if (!claimed?.length) {
      // Lost the race — but to WHOM matters. Stale-order expiry can also move an
      // order off 'pending', and an order it cancelled after this buyer paid must
      // not be reported back as a success: Stripe has the money and the tickets
      // are cancelled.
      const { data: settled } = await supabase.from('event_ticket_orders')
        .select('status').eq('id', order_id).maybeSingle();

      if (settled?.status !== 'paid') {
        console.error(`[confirm-event-tickets] order ${order_id} was ${settled?.status ?? 'missing'} when payment ${piToVerify} succeeded`);
        try {
          await supabase.from('failed_fulfilments').insert({
            user_id: user.id,
            purpose: 'event_tickets_paid_after_expiry',
            amount_pence: order.total_pence ?? 0,
            error: `order was ${settled?.status ?? 'missing'} when the payment succeeded — buyer charged, tickets cancelled`,
            detail: { order_id, payment_intent_id: piToVerify, order_status: settled?.status ?? null },
          });
        } catch (e) { console.error('[confirm-event-tickets] failed_fulfilments insert failed:', e); }
        return new Response(
          JSON.stringify({ error: 'Your payment went through but this order had already been released. We have flagged it — please contact us and we will sort it out.' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Genuinely the webhook — it is sending the receipt and the push.
      await sendTicketReceipt(supabase, order_id, user.id);
      return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order_id);

    // Increment event tickets_sold counter (non-critical — a Supabase builder
    // isn't a real Promise, so guard with try/catch, not .catch()).
    try {
      await supabase.rpc('increment_event_tickets_sold', {
        p_event_id: order.event_id,
        p_count:    order.tickets_count,
      });
    } catch { /* non-critical */ }

    // Send push notification (preference-aware: honours the events toggle +
    // quiet hours, fans out to all the buyer's devices, logs to their inbox).
    const { data: event } = await supabase
      .from('events')
      .select('title, starts_at, venue, locality, organiser_business_id, organiser_hub_id')
      .eq('id', order.event_id).single();
    if (event) {
      const eventDate = new Date(event.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      await sendUserPush(supabase, {
        userId:     user.id,
        module:     'events',
        categoryId: 'events.tickets_confirmed',
        title:      'Tickets confirmed 🎟',
        body:       `${order.tickets_count} ticket${order.tickets_count !== 1 ? 's' : ''} for ${event.title} on ${eventDate}. Find them in My Wallet.`,
        data:       { order_id },
      });

    }

    // Outside the event guard: the receipt fetches what it needs itself, and a
    // buyer should get one even if the event row read hiccups.
    await sendTicketReceipt(supabase, order_id, user.id);

    return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[confirm-event-tickets]', err);
    return new Response(JSON.stringify({ error: safeError('confirm-event-tickets', err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

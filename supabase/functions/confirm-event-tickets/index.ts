import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
      .select('id, buyer_id, status, tickets_count, event_id, stripe_payment_intent_id')
      .eq('id', order_id)
      .single();

    if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (order.buyer_id !== user.id) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Idempotency — already confirmed
    if (order.status === 'paid') {
      return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Verify PI with Stripe
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
    );
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? 'Stripe lookup failed');

    if (pi.status !== 'succeeded') {
      return new Response(JSON.stringify({ error: `Payment not confirmed (status: ${pi.status})` }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Confirm order + tickets
    await supabase.from('event_ticket_orders').update({
      status:                  'paid',
      paid_at:                 new Date().toISOString(),
      stripe_payment_intent_id: payment_intent_id,
    }).eq('id', order_id);

    await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order_id);

    // Increment event tickets_sold counter
    await supabase.rpc('increment_event_tickets_sold', {
      p_event_id: order.event_id,
      p_count:    order.tickets_count,
    }).catch(() => {}); // non-critical

    // Send push notification
    const { data: profile } = await supabase.from('profiles').select('push_token').eq('id', user.id).single();
    if (profile?.push_token) {
      const { data: event } = await supabase.from('events').select('title, starts_at').eq('id', order.event_id).single();
      if (event) {
        const eventDate = new Date(event.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to:    profile.push_token,
            title: 'Tickets confirmed 🎟',
            body:  `${order.tickets_count} ticket${order.tickets_count !== 1 ? 's' : ''} for ${event.title} on ${eventDate}. Find them in My Wallet.`,
            data:  { categoryId: 'events.tickets_confirmed', order_id },
            sound: 'default',
          }),
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[confirm-event-tickets]', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

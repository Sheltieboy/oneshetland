import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { sendEmail } from '../_shared/send-email.ts';

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
    await supabase.from('event_ticket_orders').update({
      status:                  'paid',
      paid_at:                 new Date().toISOString(),
      stripe_payment_intent_id: payment_intent_id,
    }).eq('id', order_id);

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

      // ── Receipt by email ─────────────────────────────────────────────────
      // Push reaches nobody today (unpublished app, empty push_tokens), and this
      // is the moment a stranger most needs to see that their money did
      // something. The codes are in the email so it works as the ticket itself
      // for somebody who never opens the site again.
      try {
        const { data: u } = await supabase.auth.admin.getUserById(user.id);
        const email = u?.user?.email;
        if (email) {
          const meta = u?.user?.user_metadata ?? {};
          const buyerName =
            (meta.first_name as string | undefined) ??
            (meta.full_name as string | undefined)?.split(' ')[0] ?? 'there';

          const { data: tix } = await supabase
            .from('event_tickets').select('backup_code').eq('order_id', order_id);
          const codes = (tix ?? [])
            .map((t: { backup_code: string | null }) => t.backup_code)
            .filter(Boolean) as string[];

          let organiser = 'the organiser';
          if (event.organiser_business_id) {
            const { data: b } = await supabase.from('local_businesses').select('name').eq('id', event.organiser_business_id).maybeSingle();
            if (b?.name) organiser = b.name;
          } else if (event.organiser_hub_id) {
            const { data: h } = await supabase.from('hubs').select('name').eq('id', event.organiser_hub_id).maybeSingle();
            if (h?.name) organiser = h.name;
          }

          const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
          const fee = order.platform_fee_pence ?? 0;
          const total = order.total_pence ?? 0;

          await sendEmail(supabase, {
            templateKey: 'events.tickets_confirmed',
            recipientEmail: email,
            recipientId: user.id,
            variables: {
              buyer_name:   buyerName,
              event_title:  event.title,
              event_when:   new Date(event.starts_at).toLocaleString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long',
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
              }),
              event_where:  [event.venue, event.locality].filter(Boolean).join(', ') || 'See the event page',
              ticket_count: `${order.tickets_count} ticket${order.tickets_count !== 1 ? 's' : ''}`,
              ticket_codes: codes.length
                ? codes.map(c => `<strong style="font-family:Menlo,Consolas,monospace;background:#F0F2F5;padding:8px 16px;border-radius:6px;font-size:18px;letter-spacing:2px;color:#032F4C;display:inline-block;margin:4px">${c}</strong>`).join('')
                : '<span style="color:#6B7280">Open your account to see your tickets.</span>',
              tickets_total: gbp(total - fee),
              booking_fee:   gbp(fee),
              total_paid:    gbp(total),
              tickets_url:   'https://oneshetland.com/account/tickets',
              organiser_name: organiser,
            },
            metadata: { order_id, event_id: order.event_id },
          });
        }
      } catch (e) {
        // A receipt failing must never fail the confirmation — the tickets are
        // already valid and the money is already taken.
        console.error('[confirm-event-tickets] receipt email failed:', e);
      }
    }

    return new Response(JSON.stringify({ ok: true, order_id, tickets_count: order.tickets_count }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[confirm-event-tickets]', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendTicketReceipt } from '../_shared/ticket-receipt.ts';
import { checkLineItems, totalOrder } from '../_shared/ticket-quantities.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';

function stripeHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}

async function createPaymentIntent(params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { ...stripeHeaders() };
  // Idempotency-Key makes a retried create (lost response, double-tap) return the
  // ORIGINAL PaymentIntent instead of charging the saved card a second time.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers, body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe PI failed (${res.status})`);
  return json;
}

function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * create-event-ticket-intent
 *
 * Body: {
 *   event_id:    string,
 *   line_items:  Array<{ ticket_type_id: string, quantity: number, attendee_name?: string, attendee_email?: string }>,
 *   use_saved_card?: boolean
 * }
 *
 * Returns: { clientSecret, order_id, tickets } | { charged: true, order_id, tickets }
 *
 * On success, creates a pending order + ticket rows (status='pending_payment').
 * Capacity, the pending order and the ticket rows are created together by
 * reserve_ticket_basket() — one database transaction, so a failed checkout
 * can never leave seats held by an order that does not exist.
 * confirm-event-tickets must be called after payment to mark them 'valid'.
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

    const { event_id, line_items, use_saved_card = false, pay_with_wallet = false,
            client_request_id = null } = await req.json();

    // ── Checkout attempt id ──────────────────────────────────────────────────
    // One id per logical checkout, minted by the client and reused only while
    // retrying THAT checkout. It cannot be derived from the basket: Adult x2
    // today and Adult x2 tomorrow are two purchases, and any key made from
    // buyer + event + basket would refuse the second one.
    //
    // Still optional while the live website catches up — a request without it
    // behaves exactly as before rather than being turned away by a server the
    // deployed bundle has not met yet. Both clients now send it; once the web
    // deploy is confirmed live this should become mandatory.
    if (client_request_id !== null && client_request_id !== undefined) {
      if (typeof client_request_id !== 'string' ||
          client_request_id.length < 8 || client_request_id.length > 100) {
        return new Response(JSON.stringify({ error: 'Invalid checkout reference' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (!event_id || !Array.isArray(line_items) || line_items.length === 0) {
      return new Response(JSON.stringify({ error: 'event_id and line_items required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Quantity contract ────────────────────────────────────────────────────
    // Runs BEFORE any reservation, order or ticket row exists, so a malformed
    // request leaves no trace. Rules and reasoning in _shared/ticket-quantities.ts,
    // where they are unit-tested; a validator that needs a Stripe key and a live
    // event to exercise is one nobody re-checks.
    const checked = checkLineItems(line_items);
    if (!checked.ok) {
      return new Response(JSON.stringify({ error: checked.error }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const items = checked.items;

    // Load event
    const { data: event } = await supabase
      .from('events')
      .select('id, title, starts_at, venue, formatted_address, status, organiser_business_id, organiser_hub_id')
      .eq('id', event_id)
      .single();

    if (!event || event.status !== 'published') {
      return new Response(JSON.stringify({ error: 'Event not available' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Load + validate ticket types
    const typeIds = items.map((li) => li.ticket_type_id);
    const { data: types } = await supabase
      .from('event_ticket_types')
      .select('*')
      .in('id', typeIds)
      .eq('event_id', event_id)
      .eq('is_active', true);

    if (!types || types.length !== typeIds.length) {
      return new Response(JSON.stringify({ error: 'One or more ticket types unavailable' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const now = new Date().toISOString();
    for (const type of types) {
      const li = items.find((l) => l.ticket_type_id === type.id);
      if (!li) continue;
      if (type.sale_starts_at && type.sale_starts_at > now) return new Response(JSON.stringify({ error: `Sales for ${type.name} haven't started yet` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (type.sale_ends_at && type.sale_ends_at < now) return new Response(JSON.stringify({ error: `Sales for ${type.name} have ended` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (li.quantity > type.per_order_max) return new Response(JSON.stringify({ error: `Max ${type.per_order_max} ${type.name} tickets per order` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Total against DATABASE prices, and decide the free path from what the
    // ticket types COST rather than from the sum landing on zero.
    const totals = totalOrder(items, types as { id: string; price_pence: number }[]);
    if (!totals.ok) {
      return new Response(JSON.stringify({ error: totals.error }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const { totalPence, totalTickets, allFree: allTicketTypesAreFree } = totals;

    // Buyer-facing booking fee: 95p per ticket PLUS 1.5% of face value, added on
    // top. Free tickets carry no fee. This is the platform's cut.
    //
    // Why both parts. This is a destination charge, so Stripe bills US (roughly
    // 1.5% + 20p of the whole charge) and takes it out of the application fee —
    // the organiser always receives the full face value. A flat 95p therefore
    // broke even around a £49 ticket and LOST money above it: a £120 ticket cost
    // us £1.06 to sell. The 1.5% cancels Stripe's percentage so the fee scales
    // with the charge, and the 95p covers Stripe's fixed 20p plus our run costs.
    // Net result: we keep ~70-90p per ticket at any face value, instead of
    // subsidising expensive ones.
    //
    // Math.floor rounds in the BUYER's favour, matching _shared/commission.ts.
    //
    // ⚠️ Duplicated client-side for the basket display — keep all three in step:
    //    app/event-ticket-checkout.tsx  ·  oneshetland-web/components/events/TicketModal.tsx
    const BOOKING_FEE_PENCE = 95;   // per ticket
    const BOOKING_FEE_BPS = 150;    // 1.5% of face value, in basis points
    const platformFeePence = totalPence > 0
      ? BOOKING_FEE_PENCE * totalTickets + Math.floor((totalPence * BOOKING_FEE_BPS) / 10_000)
      : 0;
    const chargeTotalPence = totalPence + platformFeePence;

    // Load buyer profile (for Stripe customer + push token)
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, full_name')
      .eq('id', user.id)
      .single();

    // Resolve the organiser's Connect account for the destination charge.
    let stripeAccountId: string | null = null;
    // Demo organisers (slug 'demo-…') exist only for testing and have no real
    // Stripe Connect account — in test mode we charge the platform directly
    // (no destination transfer). Real organisers must be payout-ready.
    let isDemo = false;
    if (event.organiser_hub_id) {
      // Hub-organised event → pay out to the hub's connected account.
      const { data: hub } = await supabase
        .from('hubs')
        .select('stripe_account_id, payout_enabled, slug')
        .eq('id', event.organiser_hub_id)
        .single();
      isDemo = (hub?.slug ?? '').startsWith('demo-');
      if (hub?.payout_enabled && hub?.stripe_account_id) {
        stripeAccountId = hub.stripe_account_id;
      }
    } else if (event.organiser_business_id) {
      const { data: biz } = await supabase
        .from('local_businesses')
        .select('stripe_account_id, payout_enabled, use_business_payout, owner_id, slug')
        .eq('id', event.organiser_business_id)
        .single();
      isDemo = (biz?.slug ?? '').startsWith('demo-');

      if (biz?.payout_enabled && biz?.stripe_account_id) {
        stripeAccountId = biz.stripe_account_id;
      } else if (!stripeAccountId) {
        // Fallback: owner's personal Connect account
        const { data: owner } = await supabase
          .from('profiles')
          .select('stripe_account_id')
          .eq('id', biz?.owner_id ?? '')
          .single();
        if (owner?.stripe_account_id) stripeAccountId = owner.stripe_account_id;
      }
    }

    // ── Payout-readiness, BEFORE anything is reserved ────────────────────────
    // This used to run after the order and tickets existed, so a checkout that
    // was always going to be refused still took seats off the event first — and
    // then deleted the order, destroying the only record that could give them
    // back. Refusing here means there is nothing to unwind.
    if (totalPence > 0 && !stripeAccountId && !isDemo) {
      return new Response(
        JSON.stringify({ error: 'This organiser isn\u2019t set up to take payments yet. Please check back soon.' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Reserve the basket, create the order and the tickets, atomically ─────
    // One transaction in the database. Either every line is reserved and the
    // order exists to justify it, or nothing changed at all. Capacity can no
    // longer be held by an order that was never created, which is what made
    // expire_stale_ticket_orders unable to see it.
    const eventSnapshot = {
      title:     event.title,
      starts_at: event.starts_at,
      venue:     event.venue,
      formatted_address: event.formatted_address,
    };

    // One entry per SEAT, in the order we want the ids back. The raw token
    // never leaves this function except to the buyer; only its hash is stored.
    const tokensByIndex: string[] = [];
    const seatRows: Array<Record<string, string | null>> = [];
    for (const li of items) {
      for (let i = 0; i < li.quantity; i++) {
        const rawToken = generateRawToken();
        tokensByIndex.push(rawToken);
        seatRows.push({
          ticket_type_id: li.ticket_type_id,
          token_hash:     await sha256hex(rawToken),
          attendee_name:  li.attendee_name,
          attendee_email: li.attendee_email,
        });
      }
    }

    const { data: basket, error: basketErr } = await supabase.rpc('reserve_ticket_basket', {
      p_event_id:           event_id,
      p_buyer_id:           user.id,
      p_tickets:            seatRows,
      p_total_pence:        chargeTotalPence,
      p_platform_fee_pence: platformFeePence,
      p_snapshot:           eventSnapshot,
      p_client_request_id:  client_request_id ?? null,
    });

    if (basketErr || !basket?.order_id) {
      // SOLD_OUT is the ordinary outcome when an event fills mid-checkout, and
      // deserves a different sentence from a genuine fault.
      const msg = basketErr?.message ?? '';
      console.error('[create-event-ticket-intent] basket reservation failed:', msg);
      // Each of these is an ordinary outcome with its own sentence, not a fault.
      const text =
        msg.includes('SOLD_OUT')             ? 'Some tickets are now sold out. Please refresh and try again.'
      : msg.includes('CHECKOUT_EXPIRED')     ? 'This checkout has expired. Please start again.'
      : msg.includes('IDEMPOTENCY_CONFLICT') ? 'That checkout reference was already used for a different order. Please start again.'
      :                                        'Those tickets are not available. Please refresh and try again.';
      return new Response(JSON.stringify({ error: text }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const order = { id: basket.order_id as string };
    const ticketIdsByIndex = (basket.ticket_ids ?? []) as string[];
    const isReplay = basket.already === true;

    // ── Replay: resolve to the existing order, pay nothing again ─────────────
    // The reservation already happened; every path below moves money or issues
    // tickets, and none of them may run a second time for one checkout. The
    // wallet path matters most — wallet_debit runs before any status changes,
    // so short-circuiting here is what makes "at most one debit per attempt"
    // true rather than merely likely.
    if (isReplay) {
      const status = basket.status as string;

      if (status === 'paid') {
        // Already settled. Tokens were NOT rotated for a paid order, so the
        // buyer keeps whatever they already hold.
        return new Response(JSON.stringify({
          charged: true, order_id: order.id, ticket_ids: ticketIdsByIndex, replayed: true,
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Still pending. If a PaymentIntent already exists, hand back ITS client
      // secret rather than making another — fetched from Stripe, never stored
      // in a column a client could read.
      const existingPi = basket.stripe_payment_intent_id as string | null;
      if (existingPi && !existingPi.startsWith('wallet_')) {
        const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${existingPi}`, { headers: stripeHeaders() });
        const piJson = await piRes.json();
        if (piRes.ok && piJson?.client_secret) {
          return new Response(JSON.stringify({
            clientSecret: piJson.client_secret, order_id: order.id,
            tokens: tokensByIndex, ticket_ids: ticketIdsByIndex, replayed: true,
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        console.error('[create-event-ticket-intent] could not re-read PI', existingPi, piJson?.error?.message);
      }
      // Pending with no usable PaymentIntent: fall through and finish setting
      // this same order up. Nothing below reserves capacity again.
    }

    /** Give the seats back when a checkout aborts after reservation. */
    const releaseHeldSeats = async () => {
      const { error } = await supabase.rpc('release_ticket_order', { p_order_id: order.id });
      if (error) console.error('[create-event-ticket-intent] release failed for order', order.id, error.message);
    };

    // ── Free order path ──────────────────────────────────────────────────────────
    // Gated on every selected ticket type being configured free in the database,
    // not on totalPence === 0. `totalPence === 0` follows from that anyway; the
    // point is that the converse must never be enough.
    if (allTicketTypesAreFree) {
      // No Stripe here to provide an external idempotency layer, so the order's
      // own status is the exactly-once gate: only the call that moves it off
      // 'pending' runs the side effects.
      const { data: claimedFree } = await supabase.from('event_ticket_orders')
        .update({ status: 'paid', paid_at: now })
        .eq('id', order.id).eq('status', 'pending').select('id');
      if (!claimedFree?.length) {
        return new Response(JSON.stringify({
          free: true, order_id: order.id, ticket_ids: ticketIdsByIndex, replayed: true,
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order.id);
      await sendTicketReceipt(supabase, order.id, user.id);
      // Use the atomic counter RPC — the previous `supabase.rpc('tickets_sold')`
      // wrote a query-builder object into the column, corrupting tickets_sold.
      try { await supabase.rpc('increment_event_tickets_sold', { p_event_id: event_id, p_count: totalTickets }); } catch { /* best-effort counter */ }

      return new Response(JSON.stringify({
        free:       true,
        order_id:   order.id,
        tokens:     tokensByIndex,
        ticket_ids: ticketIdsByIndex,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Wallet path: debit the wallet + transfer face value to the organiser ─────
    if (pay_with_wallet) {
      const { data: bal, error: dErr } = await supabase.rpc('wallet_debit', { p_user: user.id, p_spend: chargeTotalPence, p_cashback: 0 });
      if (dErr) throw new Error(dErr.message);
      if (bal == null) {
        await releaseHeldSeats();
        return new Response(JSON.stringify({ error: 'Not enough in your wallet — top up or pay by card.' }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // Demo organisers have no connected account → skip the transfer entirely
      // (the wallet debit alone funds the platform). Real organisers transfer.
      let walletTransferId: string | null = null;
      if (stripeAccountId) {
        try {
          const tb = new URLSearchParams({
            amount: String(totalPence), currency: 'gbp', destination: stripeAccountId,
            description: `OneShetland wallet tickets — ${event.title}`,
            'metadata[type]': 'event_tickets_wallet', 'metadata[order_id]': order.id, 'metadata[buyer_id]': user.id,
          });
          const tr = await fetch('https://api.stripe.com/v1/transfers', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': STRIPE_API_VERSION, 'Idempotency-Key': crypto.randomUUID() },
            body: tb,
          });
          const tj = await tr.json();
          if (!tr.ok) throw new Error(tj.error?.message ?? `Stripe transfer failed (HTTP ${tr.status})`);
          walletTransferId = tj.id;
        } catch (e) {
          console.error('[create-event-ticket-intent] wallet transfer failed:', e);
          await supabase.rpc('wallet_credit', { p_user: user.id, p_amount: chargeTotalPence });
          await releaseHeldSeats();
          return new Response(JSON.stringify({ error: 'Ticket payment failed — your wallet has been refunded.' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      const walletRef = walletTransferId ? `wallet_${walletTransferId}` : `wallet_${crypto.randomUUID()}`;
      await supabase.from('event_ticket_orders').update({ status: 'paid', paid_at: now, stripe_payment_intent_id: walletRef }).eq('id', order.id);
      await sendTicketReceipt(supabase, order.id, user.id);
      await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order.id);
      try { await supabase.rpc('increment_event_tickets_sold', { p_event_id: event_id, p_count: totalTickets }); } catch { /* best-effort counter */ }
      await supabase.from('local_wallet_transactions').insert({ user_id: user.id, business_id: null, type: 'spend', amount_pence: -chargeTotalPence, stripe_transfer_id: walletTransferId, description: `Tickets — ${event.title}` });
      return new Response(JSON.stringify({ charged: true, wallet: true, order_id: order.id, tokens: tokensByIndex, ticket_ids: ticketIdsByIndex }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Paid order: create Stripe PaymentIntent ──────────────────────────────────
    const baseParams: Record<string, string> = {
      amount:      String(chargeTotalPence),
      currency:    'gbp',
      description: `OneShetland Events — ${event.title} (${totalTickets} ticket${totalTickets !== 1 ? 's' : ''})`,
      'metadata[type]':         'event_tickets',
      'metadata[event_id]':     event_id,
      'metadata[order_id]':     order.id,
      'metadata[buyer_id]':     user.id,
    };

    if (stripeAccountId) {
      baseParams['transfer_data[destination]'] = stripeAccountId;
      if (platformFeePence > 0) baseParams['application_fee_amount'] = String(platformFeePence);
    }

    // Saved card off-session mode
    if (use_saved_card && profile?.stripe_customer_id) {
      const pmRes = await fetch(
        `https://api.stripe.com/v1/customers/${profile.stripe_customer_id}/payment_methods?type=card&limit=1`,
        { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
      );
      const pmData = await pmRes.json();
      const pmId = pmData.data?.[0]?.id;

      if (pmId) {
        const pi = await createPaymentIntent({
          ...baseParams,
          customer:       profile.stripe_customer_id,
          payment_method: pmId,
          confirm:        'true',
          off_session:    'true',
        }, `evt-order-${order.id}`);

        if (pi.status === 'succeeded') {
          await supabase.from('event_ticket_orders').update({ stripe_payment_intent_id: pi.id, status: 'paid', paid_at: new Date().toISOString() }).eq('id', order.id);
          await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order.id);
          await sendTicketReceipt(supabase, order.id, user.id);
          // Use the atomic counter RPC — `event.tickets_sold` was never selected,
          // so `event.tickets_sold + totalTickets` was NaN and the raw update
          // failed AFTER the card was charged (500 → client retry → double charge).
          try { await supabase.rpc('increment_event_tickets_sold', { p_event_id: event_id, p_count: totalTickets }); } catch { /* best-effort counter */ }

          return new Response(JSON.stringify({
            charged:    true,
            order_id:   order.id,
            tokens:     tokensByIndex,
            ticket_ids: ticketIdsByIndex,
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }

    // Standard PaymentSheet
    const pi = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });

    await supabase.from('event_ticket_orders').update({ stripe_payment_intent_id: pi.id }).eq('id', order.id);

    return new Response(JSON.stringify({
      clientSecret: pi.client_secret,
      order_id:     order.id,
      tokens:       tokensByIndex,
      ticket_ids:   ticketIdsByIndex,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[create-event-ticket-intent]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

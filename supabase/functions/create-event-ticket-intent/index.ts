import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

async function createPaymentIntent(params: Record<string, string>): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers: stripeHeaders(), body: new URLSearchParams(params),
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
 * Capacity is reserved atomically via reserve_ticket_slots().
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

    const { event_id, line_items, use_saved_card = false, pay_with_wallet = false } = await req.json();

    if (!event_id || !Array.isArray(line_items) || line_items.length === 0) {
      return new Response(JSON.stringify({ error: 'event_id and line_items required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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
    const typeIds = line_items.map((li: any) => li.ticket_type_id);
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
      const li = line_items.find((l: any) => l.ticket_type_id === type.id);
      if (!li) continue;
      if (type.sale_starts_at && type.sale_starts_at > now) return new Response(JSON.stringify({ error: `Sales for ${type.name} haven't started yet` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (type.sale_ends_at && type.sale_ends_at < now) return new Response(JSON.stringify({ error: `Sales for ${type.name} have ended` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (li.quantity > type.per_order_max) return new Response(JSON.stringify({ error: `Max ${type.per_order_max} ${type.name} tickets per order` }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Calculate total
    let totalPence = 0;
    for (const li of line_items) {
      const type = types.find((t: any) => t.id === li.ticket_type_id)!;
      totalPence += type.price_pence * li.quantity;
    }

    const totalTickets = line_items.reduce((s: number, li: any) => s + li.quantity, 0);

    // Buyer-facing booking fee: flat 50p per ticket, added on top of face value.
    // Free tickets carry no fee. This is the platform's cut (covers Stripe + run costs).
    const BOOKING_FEE_PENCE = 95;
    const platformFeePence = totalPence > 0 ? BOOKING_FEE_PENCE * totalTickets : 0;
    const chargeTotalPence = totalPence + platformFeePence;

    // Atomically reserve slots (prevents overselling)
    for (const li of line_items) {
      const { data: reserved } = await supabase.rpc('reserve_ticket_slots', {
        p_type_id: li.ticket_type_id,
        p_quantity: li.quantity,
      });
      if (!reserved) {
        return new Response(JSON.stringify({ error: 'Some tickets are now sold out. Please refresh and try again.' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

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

    // Create pending order
    const { data: order, error: orderErr } = await supabase
      .from('event_ticket_orders')
      .insert({
        event_id,
        buyer_id:        user.id,
        status:          'pending',
        total_pence:     chargeTotalPence,
        platform_fee_pence: platformFeePence,
        tickets_count:   totalTickets,
      })
      .select('id')
      .single();

    if (orderErr || !order) throw new Error('Failed to create order');

    // Generate ticket rows (pending_payment)
    const eventSnapshot = {
      title:     event.title,
      starts_at: event.starts_at,
      venue:     event.venue,
      formatted_address: event.formatted_address,
    };

    const ticketRows: any[] = [];
    for (const li of line_items) {
      const type = types.find((t: any) => t.id === li.ticket_type_id)!;
      for (let i = 0; i < li.quantity; i++) {
        const rawToken = generateRawToken();
        const tokenHash = await sha256hex(rawToken);
        const { data: bc } = await supabase.rpc('generate_ticket_backup_code');
        ticketRows.push({
          order_id:              order.id,
          event_id,
          ticket_type_id:        li.ticket_type_id,
          holder_id:             user.id,
          validation_token_hash: tokenHash,
          backup_code:           bc,
          status:                'pending_payment',
          attendee_name:         li.attendee_name ?? null,
          attendee_email:        li.attendee_email ?? null,
          price_pence:           type.price_pence,
          event_snapshot:        eventSnapshot,
          _raw_token:            rawToken, // temp field — stripped before insert
        });
      }
    }

    // Insert tickets (strip _raw_token) and get back their IDs so the client
    // can persist raw tokens in SecureStore keyed by ticket ID.
    const insertRows = ticketRows.map(({ _raw_token, ...rest }) => rest);
    const { data: insertedTickets, error: ticketErr } = await supabase
      .from('event_tickets')
      .insert(insertRows)
      .select('id');
    if (ticketErr || !insertedTickets) {
      // Roll back order on failure
      await supabase.from('event_ticket_orders').delete().eq('id', order.id);
      throw new Error('Failed to create ticket records');
    }

    // Parallel arrays: tokens[i] belongs to insertedTickets[i].id
    const tokensByIndex   = ticketRows.map(r => r._raw_token);
    const ticketIdsByIndex = insertedTickets.map((t: { id: string }) => t.id);

    // ── Free order path ──────────────────────────────────────────────────────────
    if (totalPence === 0) {
      // No Stripe needed — just confirm immediately
      await supabase.from('event_ticket_orders').update({ status: 'paid', paid_at: now }).eq('id', order.id);
      await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order.id);
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

    // ── Payout-readiness guard ───────────────────────────────────────────────────
    // Never take money for a paid ticket unless the organiser has a connected
    // Stripe account to receive it — otherwise the funds would settle into the
    // platform account with no automatic payout to the organiser.
    if (!stripeAccountId && !isDemo) {
      // Roll back the pending order + held tickets we just created.
      await supabase.from('event_tickets').delete().eq('order_id', order.id);
      await supabase.from('event_ticket_orders').delete().eq('id', order.id);
      return new Response(
        JSON.stringify({ error: 'This organiser isn’t set up to take payments yet. Please check back soon.' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Wallet path: debit the wallet + transfer face value to the organiser ─────
    if (pay_with_wallet) {
      const { data: bal, error: dErr } = await supabase.rpc('wallet_debit', { p_user: user.id, p_spend: chargeTotalPence, p_cashback: 0 });
      if (dErr) throw new Error(dErr.message);
      if (bal == null) {
        await supabase.from('event_tickets').delete().eq('order_id', order.id);
        await supabase.from('event_ticket_orders').delete().eq('id', order.id);
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
          await supabase.from('event_tickets').delete().eq('order_id', order.id);
          await supabase.from('event_ticket_orders').delete().eq('id', order.id);
          return new Response(JSON.stringify({ error: 'Ticket payment failed — your wallet has been refunded.' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      const walletRef = walletTransferId ? `wallet_${walletTransferId}` : `wallet_${crypto.randomUUID()}`;
      await supabase.from('event_ticket_orders').update({ status: 'paid', paid_at: now, stripe_payment_intent_id: walletRef }).eq('id', order.id);
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
        });

        if (pi.status === 'succeeded') {
          await supabase.from('event_ticket_orders').update({ stripe_payment_intent_id: pi.id, status: 'paid', paid_at: new Date().toISOString() }).eq('id', order.id);
          await supabase.from('event_tickets').update({ status: 'valid' }).eq('order_id', order.id);
          await supabase.from('events').update({ tickets_sold: event.tickets_sold + totalTickets }).eq('id', event_id);

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

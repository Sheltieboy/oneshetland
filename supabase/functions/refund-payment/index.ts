import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const STRIPE = 'https://api.stripe.com/v1';

/**
 * refund-payment  (ADMIN ONLY)
 *
 * Issues a Stripe refund for a PaymentIntent. For destination charges (tickets,
 * donations, memberships, wallet pay-ins — anything that paid out to a connected
 * account) it ALSO reverses the transfer and the application fee, so the money is
 * clawed back from the recipient rather than coming out of the platform balance.
 *
 * The matching `charge.refunded` webhook updates app state (and also catches
 * refunds issued straight from the Stripe Dashboard).
 *
 * Body: { payment_intent_id: string, amount_pence?: number, reason?: string }
 * Returns: { ok, refund_id, amount_pence, reversed_transfer }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    // Admin gate — same check used by validate-event-ticket.
    const { data: me } = await svc.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role !== 'admin') return json({ error: 'Forbidden — admins only' }, 403);

    const { payment_intent_id, amount_pence = null, reason = 'requested_by_customer' } = await req.json();
    if (!payment_intent_id || typeof payment_intent_id !== 'string') {
      return json({ error: 'payment_intent_id required' }, 400);
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const headers = { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': STRIPE_API_VERSION };

    // Fetch the PaymentIntent (+ its charge) to detect a Connect transfer.
    const piRes = await fetch(`${STRIPE}/payment_intents/${payment_intent_id}?expand[]=latest_charge`, { headers });
    const pi = await piRes.json();
    if (!piRes.ok) return json({ error: pi.error?.message ?? `Stripe lookup failed (HTTP ${piRes.status})` }, 502);
    if (pi.status !== 'succeeded') return json({ error: `Cannot refund a payment that is "${pi.status}".` }, 400);

    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    if (charge?.refunded) return json({ error: 'This payment is already fully refunded.' }, 400);
    const hasTransfer = !!(charge?.transfer) || !!(pi.transfer_data?.destination);

    // Partial-amount validation.
    let amount: number | null = null;
    if (amount_pence != null) {
      amount = Math.round(Number(amount_pence));
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount_pence must be a positive integer' }, 400);
      if (amount > (pi.amount as number)) return json({ error: 'amount_pence exceeds the original charge' }, 400);
    }

    // Build the refund. Only Stripe's enum reasons are valid; anything else goes
    // into metadata so we keep the operator's note without erroring.
    const allowedReasons = ['requested_by_customer', 'duplicate', 'fraudulent'];
    const form = new URLSearchParams();
    form.set('payment_intent', payment_intent_id);
    if (amount != null) form.set('amount', String(amount));
    if (allowedReasons.includes(reason)) form.set('reason', reason);
    else form.set('metadata[note]', String(reason).slice(0, 200));
    form.set('metadata[refunded_by]', user.id);
    if (hasTransfer) {
      form.set('reverse_transfer', 'true');       // claw the money back from the connected account
      form.set('refund_application_fee', 'true'); // and return our platform fee too
    }

    const refRes = await fetch(`${STRIPE}/refunds`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const refund = await refRes.json();
    if (!refRes.ok) return json({ error: refund.error?.message ?? `Refund failed (HTTP ${refRes.status})` }, 502);

    // Best-effort app-state update for Fetch deliveries (other flows are handled
    // by the charge.refunded webhook). Full vs partial.
    const meta = (pi.metadata ?? {}) as Record<string, string>;
    const fully = amount == null || amount >= (pi.amount as number);
    if (meta.request_id) {
      await svc.from('delivery_requests')
        .update({ payment_status: fully ? 'refunded' : 'partially_refunded' })
        .eq('payment_intent_id', payment_intent_id);
    }

    return json({
      ok: true,
      refund_id: refund.id,
      amount_pence: refund.amount,
      reversed_transfer: hasTransfer,
    });
  } catch (err) {
    console.error('[refund-payment]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

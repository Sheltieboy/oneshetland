import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE = 'https://api.stripe.com/v1';

/**
 * cancel-payment
 *
 * Called when a customer cancels a delivery request that a driver has already
 * accepted (status: matched, payment_status: authorised). Voids the uncaptured
 * Stripe pre-authorisation so the hold is released from the customer's card
 * immediately, then marks the request cancelled.
 *
 * WITHOUT this, cancelling a matched request only flipped the row to
 * 'cancelled' and left the manual-capture hold dangling until Stripe expired it
 * (~7 days), so the customer's money stayed frozen after they cancelled.
 *
 * Only the request's owner (or an admin) may cancel. A request that is already
 * 'collected' or 'delivered' cannot be cancelled here (money is in flight).
 *
 * Body: { request_id: string }
 * Returns: { ok: true, voided: boolean, status: 'cancelled' }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { request_id } = await req.json();
    if (!request_id || typeof request_id !== 'string') return json({ error: 'request_id required' }, 400);

    const { data: request, error: reqErr } = await svc
      .from('delivery_requests')
      .select('id, customer_id, status, payment_intent_id, payment_status')
      .eq('id', request_id)
      .maybeSingle();
    if (reqErr || !request) return json({ error: 'Request not found' }, 404);

    // Authorisation: only the customer who owns the request, or an admin.
    let allowed = request.customer_id === user.id;
    if (!allowed) {
      const { data: me } = await svc.from('profiles').select('role').eq('id', user.id).maybeSingle();
      allowed = me?.role === 'admin';
    }
    if (!allowed) return json({ error: 'Forbidden' }, 403);

    // Idempotent + guarded terminal states.
    if (request.status === 'cancelled') return json({ ok: true, voided: false, status: 'cancelled', already: true });
    if (request.status === 'collected' || request.status === 'delivered') {
      return json({ error: 'This delivery is already underway and can’t be cancelled here.' }, 400);
    }

    // Release the pre-authorisation hold, if one exists.
    let voided = false;
    if (request.payment_intent_id && request.payment_status === 'authorised') {
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
      const headers = { 'Authorization': `Bearer ${stripeKey}` };

      const piRes = await fetch(`${STRIPE}/payment_intents/${request.payment_intent_id}`, { headers });
      const pi = await piRes.json();
      if (!piRes.ok) return json({ error: pi.error?.message ?? `Stripe lookup failed (HTTP ${piRes.status})` }, 502);

      if (pi.status === 'succeeded') {
        // Already captured — must be refunded, not voided. Refuse rather than silently cancel.
        return json({ error: 'This payment has already been taken. Contact support for a refund.' }, 409);
      }
      if (pi.status !== 'canceled') {
        const cancelRes = await fetch(`${STRIPE}/payment_intents/${request.payment_intent_id}/cancel`, {
          method: 'POST', headers,
        });
        const cancelled = await cancelRes.json();
        if (!cancelRes.ok) return json({ error: cancelled.error?.message ?? `Could not release the card hold (HTTP ${cancelRes.status})` }, 502);
      }
      voided = true;
    }

    // Mark cancelled. If we released a hold, no money was ever taken → 'unpaid'.
    await svc
      .from('delivery_requests')
      .update({ status: 'cancelled', payment_status: voided ? 'unpaid' : request.payment_status })
      .eq('id', request_id);

    return json({ ok: true, voided, status: 'cancelled' });
  } catch (err) {
    console.error('[cancel-payment]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

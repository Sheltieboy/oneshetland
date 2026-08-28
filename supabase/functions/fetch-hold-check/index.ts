import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { sendUserPush } from '../_shared/send-push.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { readHold, holdIsFulfillable, driverMessage } from '../_shared/fetch-hold.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * fetch-hold-check — the hold, re-read from Stripe, before anybody acts on it.
 *
 * `payment_status = 'authorised'` is a note of a past conversation. Stripe
 * releases an uncaptured card authorisation after a few days, and until this
 * existed nothing ever asked again: a driver could be shown "Mark as
 * collected" on a delivery whose money had been gone since Tuesday.
 *
 * It is also the backstop for a webhook that never arrives. Stripe's
 * `payment_intent.canceled` is the fast path; this is the one that cannot be
 * missed, because it runs on the driver's own screen at the moment it matters.
 *
 * Answers the CUSTOMER and the ASSIGNED DRIVER, and nobody else. Returns a
 * verdict — never a client secret, never a Stripe object.
 *
 * Body: { request_id }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
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

    // Every call retrieves a PaymentIntent from Stripe. Note the shape:
    // enforceRateLimit answers { ok: true } on success, which is truthy — it
    // must be tested for 'denied', not for existence.
    const limited = await enforceRateLimit(
      'fetch-hold-check', userSubject(user.id), ['fetch_hold_check', 'fetch_hold_check_day'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json().catch(() => ({}));
    const requestId = typeof body?.request_id === 'string' ? body.request_id : null;
    if (!requestId) return json({ error: 'request_id required' }, 400);

    const { data: request } = await svc
      .from('delivery_requests')
      .select('id, customer_id, run_id, status, payment_status, payment_intent_id')
      .eq('id', requestId)
      .maybeSingle();
    if (!request) return json({ error: 'Request not found' }, 404);

    // Two parties have a legitimate interest and no third does. The driver is
    // resolved from the run, never from anything in the body.
    let role: 'customer' | 'driver' | null = request.customer_id === user.id ? 'customer' : null;
    if (!role && request.run_id) {
      const { data: run } = await svc.from('runs').select('driver_id').eq('id', request.run_id).maybeSingle();
      if (run?.driver_id === user.id) role = 'driver';
    }
    if (!role) return json({ error: 'Forbidden' }, 403);

    const { data: attempt } = await svc
      .from('fetch_authorisation_attempts')
      .select('stripe_payment_intent_id, status, capture_state, amount_pence, authorisation_generation, authorisation_expires_at')
      .eq('delivery_request_id', requestId)
      .maybeSingle();

    // Nothing to check. Said plainly rather than dressed up as a hold.
    if (!attempt) {
      return json({
        state: request.payment_status === 'captured' ? 'captured' : 'unresolved',
        fulfillable: request.payment_status === 'captured',
        payment_status: request.payment_status ?? 'unpaid',
        expires_at: null, can_reauthorise: false,
        message: request.payment_status === 'captured'
          ? '' : 'This delivery has no authorised payment yet.',
      });
    }
    if (!attempt.stripe_payment_intent_id) {
      return json({
        state: attempt.status === 'captured' ? 'captured' : 'unresolved',
        fulfillable: attempt.status === 'captured',
        payment_status: request.payment_status ?? 'unpaid',
        expires_at: null,
        generation: attempt.authorisation_generation,
        can_reauthorise: false,
        message: attempt.status === 'captured' ? '' : 'This delivery has no authorised payment yet.',
      });
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const reading = await readHold(stripeKey, attempt.stripe_payment_intent_id);

    // Stripe is the authority, so the server's own record is corrected from it
    // on every call. This is what a missed webhook falls back to.
    const wasExpired = request.payment_status === 'expired';
    await svc.rpc('record_fetch_hold_state', {
      p_request: requestId,
      p_state:   reading.state,
      p_detail:  reading.detail,
      p_expires_at:     reading.expiresAt,
      // An unreadable Stripe must not rewrite a good local record into
      // something worse — it is a failure to observe, not an observation.
      p_payment_status: reading.state === 'unresolved' ? null : reading.paymentStatus,
    });

    if (reading.state === 'expired' && !wasExpired) {
      console.error(`[fetch-hold-check] hold expired for ${requestId}: ${reading.detail}`);
      await sendUserPush(svc, {
        userId:     request.customer_id,
        module:     'fetch',
        categoryId: 'fetch.payment_failed',
        title:      'Delivery payment hold expired',
        body:       'The hold on your card has run out before your delivery could be completed. Open your delivery to re-authorise it — nothing has been charged.',
        data:       { request_id: requestId, kind: 'fetch_hold_expired' },
        urgent:     true,
      }).catch((e) => console.error('[fetch-hold-check] push:', e));
    }

    return json({
      state:           reading.state,
      fulfillable:     holdIsFulfillable(reading),
      payment_status:  reading.paymentStatus,
      expires_at:      reading.expiresAt,
      amount_pence:    attempt.amount_pence,
      generation:      attempt.authorisation_generation,
      // Replacing a hold is the customer's to do, and only once the old one is
      // definitively gone. A driver can never mint one.
      can_reauthorise: role === 'customer' && reading.state === 'expired',
      message: role === 'driver'
        ? driverMessage(reading.state)
        : reading.state === 'expired'
          ? 'Your payment authorisation has expired. Re-authorise it so your delivery can continue — nothing has been charged.'
          : '',
    });
  } catch (err) {
    console.error('[fetch-hold-check]', err);
    return json({ error: safeError('fetch-hold-check', err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

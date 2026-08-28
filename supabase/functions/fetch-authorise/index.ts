import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { classifyAuthorisation, paymentStatusFor } from '../_shared/fetch-authorisation.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const STRIPE = 'https://api.stripe.com/v1';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * fetch-authorise — the customer finishes the hold their driver could not.
 *
 * The PaymentIntent is created when a driver accepts, because it pays that
 * driver's connected account and the destination has to be known. But the
 * driver cannot answer the customer's bank, and cannot type in a card the
 * customer never saved. Before this, both of those simply ended the journey:
 * `requires_action` was recorded as authorised and the driver drove against
 * a hold that did not exist, and a cardless customer produced "No payment
 * method found for customer" — shown to the DRIVER, after they had accepted.
 *
 *   GET-shaped  { request_id }                 → where this payment stands,
 *                                                and a client secret to
 *                                                finish it if one is needed.
 *   { request_id, refresh: true }              → ask Stripe again after the
 *                                                browser says it is done.
 *
 * It NEVER creates a PaymentIntent. It only ever continues the one already
 * stored on the request, read from the server's own row — so a caller cannot
 * name an intent, and cannot finish somebody else's delivery.
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

    // Every call retrieves a PaymentIntent from Stripe. Generous, because being
    // refused while trying to authorise a payment is worse than the abuse.
    // Note the shape: enforceRateLimit answers { ok: true } on success, which
    // is truthy — it must be tested for 'denied', not for existence.
    const limited = await enforceRateLimit('fetch-authorise', userSubject(user.id), ['fetch_authorise', 'fetch_authorise_day'], corsHeaders);
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
      .select('id, customer_id, status, payment_intent_id, payment_status, base_fee_pence')
      .eq('id', requestId)
      .maybeSingle();
    if (!request) return json({ error: 'Request not found' }, 404);

    // Ownership, not membership. Only the person whose card it is may move
    // this along — a driver cannot authenticate on somebody else's behalf.
    if (request.customer_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // The intent comes from OUR row. A request_id is a reference to something
    // we already know; a payment_intent_id in a request body would be a
    // stranger's intent for the taking, so one is never read.
    if (!request.payment_intent_id) {
      return json({
        payment_status: request.payment_status ?? 'unpaid',
        needs_action: false,
        message: 'This delivery has no payment to complete yet.',
      });
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const headers = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };

    const piRes = await fetch(`${STRIPE}/payment_intents/${request.payment_intent_id}`, { headers });
    const pi = await piRes.json();
    if (!piRes.ok) {
      console.error('[fetch-authorise] could not read the intent', pi?.error?.message);
      return json({ error: 'We could not check that payment just now. Please try again.' }, 502);
    }

    const outcome = classifyAuthorisation(pi.status);
    const paymentStatus = paymentStatusFor(outcome);

    // Stripe is the authority, so the row is corrected from it on every call —
    // including the one the browser makes after finishing 3DS. The browser
    // says "I am done"; it never says "it worked".
    if (paymentStatus !== request.payment_status) {
      await svc.from('delivery_requests')
        .update({ payment_status: paymentStatus })
        .eq('id', requestId);
    }

    if (outcome.kind === 'authorised') {
      return json({ payment_status: 'authorised', needs_action: false, authorised: true });
    }
    if (outcome.kind === 'succeeded') {
      return json({ payment_status: 'captured', needs_action: false, authorised: true });
    }
    if (outcome.kind === 'canceled') {
      return json({
        payment_status: 'failed', needs_action: false, authorised: false,
        message: 'That payment was cancelled. Please cancel this delivery and start again.',
      });
    }
    if (outcome.kind === 'processing' || outcome.kind === 'unknown') {
      // Fail closed. Not a hold, not a failure — nothing for the customer to
      // do but wait, and nothing that releases the driver.
      if (outcome.kind === 'unknown') {
        console.error(`[fetch-authorise] unrecognised status for ${requestId}: ${outcome.detail}`);
      }
      return json({
        payment_status: paymentStatus, needs_action: false, authorised: false,
        message: 'Your bank is still deciding. We will update this as soon as we hear.',
      });
    }

    // requires_action or requires_payment_method: the customer finishes it.
    // The client secret is for the intent already on this request, handed only
    // to the customer who owns it, and completes THAT intent — there is no
    // path here that makes a second one.
    return json({
      payment_status:  paymentStatus,
      needs_action:    true,
      authorised:      false,
      client_secret:   pi.client_secret,
      amount_pence:    typeof pi.amount === 'number' ? pi.amount : null,
      reason:          outcome.kind,
      message: outcome.kind === 'requires_action'
        ? 'Your bank needs to check this is you. Nothing has been charged — this is a hold until your delivery arrives.'
        : outcome.message,
    });
  } catch (err) {
    console.error('[fetch-authorise]', err);
    return json({ error: safeError('fetch-authorise', err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

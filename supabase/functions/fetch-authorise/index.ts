import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { classifyAuthorisation, paymentStatusFor } from '../_shared/fetch-authorisation.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { classifyHold, readHold } from '../_shared/fetch-hold.ts';
import { defaultCardFor } from '../_shared/saved-card.ts';
import { canonicalStripeCustomer } from '../_shared/stripe-customer.ts';

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
 *   { request_id, reauthorise: true }          → the hold LAPSED. Replace it.
 *
 * It only ever continues the intent already stored on the request, read from
 * the server's own row — so a caller cannot name an intent, and cannot finish
 * somebody else's delivery.
 *
 * The one exception is re-authorisation, and it is narrow on purpose. Stripe
 * cannot revive a canceled PaymentIntent, so a hold that has lapsed can only
 * be REPLACED. That is the single legitimate second intent for one delivery,
 * and it requires: the customer themselves asking, Stripe itself confirming
 * the old hold is gone, the old intent explicitly cancelled first, and the
 * database handing out exactly one new generation however many callers ask at
 * once. A driver tap or an ordinary retry can never reach it.
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
      .select('id, customer_id, run_id, category_slug, status, payment_intent_id, payment_status, base_fee_pence')
      .eq('id', requestId)
      .maybeSingle();
    if (!request) return json({ error: 'Request not found' }, 404);

    // Ownership, not membership. Only the person whose card it is may move
    // this along — a driver cannot authenticate on somebody else's behalf.
    if (request.customer_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const stripeKeyEarly = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    if (body?.reauthorise === true) {
      return await reauthorise(svc, stripeKeyEarly, request, user.id);
    }

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

    // Expanded, because Stripe's capture deadline lives on the charge and this
    // is the customer's own view of whether their hold is still alive.
    const piRes = await fetch(`${STRIPE}/payment_intents/${request.payment_intent_id}?expand[]=latest_charge`, { headers });
    const pi = await piRes.json();
    if (!piRes.ok) {
      console.error('[fetch-authorise] could not read the intent', pi?.error?.message);
      return json({ error: 'We could not check that payment just now. Please try again.' }, 502);
    }

    const hold = classifyHold(pi, Date.now());
    const outcome = classifyAuthorisation(pi.status);
    // A requires_capture intent whose deadline has passed is not money. The
    // hold reading outranks the raw status for exactly that case.
    const paymentStatus = hold.state === 'expired' ? 'expired' : paymentStatusFor(outcome);

    await svc.rpc('record_fetch_hold_state', {
      p_request: requestId, p_state: hold.state, p_detail: hold.detail,
      p_expires_at: hold.expiresAt, p_payment_status: null,
    });

    // Stripe is the authority, so the row is corrected from it on every call —
    // including the one the browser makes after finishing 3DS. The browser
    // says "I am done"; it never says "it worked".
    if (paymentStatus !== request.payment_status) {
      await svc.from('delivery_requests')
        .update({ payment_status: paymentStatus })
        .eq('id', requestId);
    }

    if (hold.state === 'expired') {
      // Said as a hold, not a charge, because nothing was ever charged.
      return json({
        payment_status: 'expired', needs_action: false, authorised: false,
        can_reauthorise: true,
        amount_pence: typeof pi.amount === 'number' ? pi.amount : null,
        message: 'Your payment authorisation has expired. Re-authorise it so your delivery can continue — nothing has been charged.',
      });
    }
    if (outcome.kind === 'authorised') {
      return json({
        payment_status: 'authorised', needs_action: false, authorised: true,
        expires_at: hold.expiresAt, hold_state: hold.state,
      });
    }
    if (outcome.kind === 'succeeded') {
      return json({ payment_status: 'captured', needs_action: false, authorised: true });
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
        : outcome.kind === 'requires_payment_method'
          ? outcome.message
          // Unreachable: a canceled intent is classified as an expired hold
          // above and answered there. Kept as a total rather than a cast.
          : 'That payment could not be authorised. Nothing has been charged.',
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

/**
 * Replace a hold that has lapsed.
 *
 * The order below is the whole safety argument, and it is deliberate:
 *
 *   1. ASK STRIPE. The only thing that may put this delivery into 'expired' is
 *      Stripe's own answer, recorded by record_fetch_hold_state. A client
 *      saying "it expired" moves nothing.
 *   2. CANCEL THE OLD INTENT. An expired authorisation is already released,
 *      but a `requires_capture` intent that is merely PAST ITS DEADLINE may
 *      not be tidied yet — and minting a second hold beside a live first one
 *      is the one outcome this must never produce.
 *   3. TAKE THE GENERATION. The database hands out exactly one, under a row
 *      lock, and only from 'expired'. Twenty simultaneous taps make one intent.
 *   4. CREATE, at the SAME frozen price. The customer agreed a figure for this
 *      delivery; a hold lapsing is not a repricing event.
 */
// deno-lint-ignore no-explicit-any
async function reauthorise(svc: any, stripeKey: string, request: any, userId: string): Promise<Response> {
  const headers = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };

  const { data: attempt } = await svc
    .from('fetch_authorisation_attempts')
    .select('stripe_payment_intent_id, status, capture_state, amount_pence, authorisation_generation, base_fee_pence, service_fee_pence, wait_max_pence')
    .eq('delivery_request_id', request.id)
    .maybeSingle();

  if (!attempt) {
    return json({ error: 'There is no authorisation on this delivery to replace.', code: 'NO_ATTEMPT' }, 409);
  }
  if (attempt.capture_state === 'captured' || attempt.status === 'captured') {
    return json({ error: 'This delivery has already been paid for.', code: 'CAPTURED' }, 409);
  }

  // 1 + 2. Stripe decides, and the old intent is put beyond use before
  // anything else exists.
  if (attempt.stripe_payment_intent_id) {
    const hold = await readHold(stripeKey, attempt.stripe_payment_intent_id);
    await svc.rpc('record_fetch_hold_state', {
      p_request: request.id, p_state: hold.state, p_detail: hold.detail,
      p_expires_at: hold.expiresAt,
      p_payment_status: hold.state === 'unresolved' ? null : hold.paymentStatus,
    });
    if (hold.state === 'unresolved') {
      return json({ error: 'We could not check that payment just now. Please try again in a moment.', code: 'UNRESOLVED' }, 502);
    }
    if (hold.state !== 'expired') {
      // Still alive, or waiting on the customer's bank. Either way there is
      // something to finish rather than something to replace.
      return json({
        error: 'That authorisation has not expired — there is nothing to replace.',
        code: 'NOT_EXPIRED', payment_status: hold.paymentStatus,
      }, 409);
    }
    const cancelRes = await fetch(`${STRIPE}/payment_intents/${attempt.stripe_payment_intent_id}/cancel`, {
      method: 'POST', headers,
    });
    if (!cancelRes.ok) {
      const err = await cancelRes.json().catch(() => ({}));
      // Already canceled is the expected answer for a hold that lapsed on its
      // own; anything else means we cannot prove the old hold is gone, and we
      // do not create a second one on a maybe.
      const code = err?.error?.code as string | undefined;
      const already = cancelRes.status === 400 &&
        (code === 'payment_intent_unexpected_state' || /already canceled|no longer/i.test(err?.error?.message ?? ''));
      if (!already) {
        console.error('[fetch-authorise] could not release the old intent', err?.error?.message);
        return json({ error: 'We could not release the old hold. Please try again shortly.', code: 'RELEASE_FAILED' }, 502);
      }
    }
  }

  // 3. One generation, decided by the database.
  const { data: genRows, error: genErr } = await svc.rpc('reauthorise_fetch_delivery', {
    p_request: request.id, p_customer: userId,
  });
  if (genErr) {
    console.error('[fetch-authorise] re-authorisation claim failed', genErr);
    return json({ error: 'We could not start a new hold. Nothing has been charged.' }, 500);
  }
  const claim = (Array.isArray(genRows) ? genRows[0] : genRows) as
    { outcome: string; new_generation: number | null; frozen_amount_pence: number | null } | null;

  if (claim?.outcome === 'forbidden')   return json({ error: 'Forbidden' }, 403);
  if (claim?.outcome === 'captured')    return json({ error: 'This delivery has already been paid for.', code: 'CAPTURED' }, 409);
  if (claim?.outcome === 'no_attempt')  return json({ error: 'There is no authorisation on this delivery to replace.', code: 'NO_ATTEMPT' }, 409);
  if (claim?.outcome !== 'claimed' || !claim.new_generation) {
    // Another caller took it, or the hold is not expired after all.
    return json({ error: 'That authorisation is already being replaced. Give it a moment.', code: 'IN_FLIGHT' }, 409);
  }
  const generation = claim.new_generation;

  // 4. The same delivery, at the same agreed price.
  const amountPence = Number(
    claim.frozen_amount_pence ??
    (Number(attempt.base_fee_pence ?? 0) + Number(attempt.service_fee_pence ?? 0) + Number(attempt.wait_max_pence ?? 0)),
  );
  const serviceFeePence = Number(attempt.service_fee_pence ?? 0);
  if (!amountPence || amountPence <= 0) {
    await svc.rpc('settle_fetch_authorisation', {
      p_request: request.id, p_status: 'unresolved', p_error: 'no frozen amount to re-authorise',
    });
    return json({ error: 'We could not work out what to hold for this delivery.', code: 'NOT_PRICED' }, 409);
  }

  // The SAME canonical Customer as generation 1. A replacement hold is a new
  // PaymentIntent, never a new Customer: one per authorisation generation would
  // scatter this person's cards across accounts and break the saved-card path
  // for every rail, not just this one.
  const { data: customerProfile } = await svc
    .from('profiles').select('full_name').eq('id', request.customer_id).maybeSingle();
  const { data: customerUser } = await svc.auth.admin.getUserById(request.customer_id);
  const customer = await canonicalStripeCustomer({
    supabase: svc, stripeKey,
    userId: request.customer_id,
    email:  customerUser?.user?.email ?? null,
    name:   customerProfile?.full_name ?? null,
  });
  if (customer.kind === 'pending') {
    return json({ error: 'Your payment profile is being set up. Try again in a moment.', code: 'CUSTOMER_IN_FLIGHT' }, 409);
  }
  if (customer.kind === 'error') {
    await svc.rpc('settle_fetch_authorisation', {
      p_request: request.id, p_status: 'awaiting_customer', p_error: 'no Stripe customer',
    });
    return json({ error: customer.message, code: 'CUSTOMER_UNAVAILABLE' }, 502);
  }
  const stripeCustomerId = customer.customerId;

  const { data: run } = await svc.from('runs').select('driver_id').eq('id', request.run_id).maybeSingle();
  const { data: driverProfile } = run?.driver_id
    ? await svc.from('driver_profiles').select('stripe_account_id').eq('id', run.driver_id).maybeSingle()
    : { data: null };

  // Same Fix 2 architecture: the customer's DEFAULT card, confirmed here when
  // there is one; otherwise the intent waits unconfirmed and the customer
  // completes it with the Payment Element — including any 3DS — on THIS intent.
  const paymentMethodId = await defaultCardFor(stripeKey, stripeCustomerId);

  const piBody: Record<string, string> = {
    amount: String(amountPence),
    currency: 'gbp',
    customer: stripeCustomerId,
    capture_method: 'manual',
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    'metadata[request_id]': request.id,
    'metadata[customer_id]': request.customer_id,
    'metadata[authorisation_generation]': String(generation),
    'metadata[application_fee_label]': 'OneShetland service fee',
    'metadata[application_fee_pence]': String(serviceFeePence),
    'expand[0]': 'latest_charge',
    description: `OneShetland Fetch — ${request.category_slug ?? 'delivery'} (re-authorised hold ${generation})`,
  };
  if (paymentMethodId) { piBody.payment_method = paymentMethodId; piBody.confirm = 'true'; }
  if (driverProfile?.stripe_account_id) {
    piBody['transfer_data[destination]'] = driverProfile.stripe_account_id;
    if (serviceFeePence > 0) piBody['application_fee_amount'] = String(serviceFeePence);
  }

  const piRes = await fetch(`${STRIPE}/payment_intents`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Deterministic, and CARRIES THE GENERATION. Reusing the first
      // generation's key would make Stripe hand back the dead intent instead
      // of creating the replacement.
      'Idempotency-Key': `fetch-auth-${request.id}-g${generation}`,
    },
    body: new URLSearchParams(piBody),
  });
  const pi = await piRes.json();
  if (!piRes.ok) {
    await svc.rpc('settle_fetch_authorisation', {
      p_request: request.id, p_status: 'unresolved', p_error: pi?.error?.message ?? 'create failed',
    });
    console.error('[fetch-authorise] replacement intent failed', pi?.error?.message);
    return json({ error: 'We could not place a new hold just now. Nothing has been charged.' }, 502);
  }

  // Recorded before anything that can fail or need the customer, exactly as
  // the first generation is.
  await svc.rpc('settle_fetch_authorisation', {
    p_request: request.id, p_status: 'in_flight', p_pi: pi.id,
  });

  const hold = classifyHold(pi, Date.now());
  const outcome = classifyAuthorisation(pi.status);
  const paymentStatus = hold.state === 'expired' ? 'expired' : paymentStatusFor(outcome);

  await svc.rpc('settle_fetch_authorisation', {
    p_request: request.id, p_pi: pi.id,
    p_status: outcome.kind === 'authorised' ? 'authorised'
            : outcome.kind === 'succeeded'  ? 'captured'
            : outcome.kind === 'processing' || outcome.kind === 'unknown' ? 'unresolved'
            : 'awaiting_customer',
    p_result: { payment_status: paymentStatus, generation },
  });
  await svc.from('delivery_requests')
    .update({ payment_intent_id: pi.id, payment_status: paymentStatus })
    .eq('id', request.id);
  await svc.rpc('record_fetch_hold_state', {
    p_request: request.id, p_state: hold.state, p_detail: hold.detail,
    p_expires_at: hold.expiresAt, p_payment_status: null,
  });

  const needsAction = outcome.kind === 'requires_action' || outcome.kind === 'requires_payment_method';
  return json({
    reauthorised:   true,
    generation,
    payment_status: paymentStatus,
    authorised:     outcome.kind === 'authorised',
    needs_action:   needsAction,
    amount_pence:   amountPence,
    expires_at:     hold.expiresAt,
    // Only handed over when the customer has something to finish, and it is
    // the secret for THIS delivery's own new intent.
    client_secret:  needsAction ? pi.client_secret : null,
    reason:         needsAction ? outcome.kind : undefined,
    message: outcome.kind === 'authorised'
      ? 'Your delivery is authorised again. Nothing has been charged.'
      : needsAction
        ? 'Confirm the new hold to keep your delivery going. Nothing has been charged.'
        : 'We are waiting on your bank. We will update this as soon as we hear.',
  });
}

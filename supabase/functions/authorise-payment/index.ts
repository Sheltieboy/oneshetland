import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { classifyAuthorisation, paymentStatusFor } from '../_shared/fetch-authorisation.ts';
import { classifyHold } from '../_shared/fetch-hold.ts';
import { defaultCardFor } from '../_shared/saved-card.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * authorise-payment
 *
 * Called when a driver accepts a delivery request (status: pending → matched).
 * Pre-authorises the customer's saved payment method for the base fee.
 * Card is NOT charged yet — capture happens on delivery completion.
 *
 * Body: { request_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use service role for this function — it needs to read across multiple tables
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify the caller is an approved driver
    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { request_id } = await req.json();
    if (!request_id) {
      return new Response(JSON.stringify({ error: 'request_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

    // Fetch the delivery request
    const { data: request, error: reqError } = await supabase
      .from('delivery_requests')
      .select('id, customer_id, category_slug, payment_intent_id, payment_status, run_id, base_fee_pence')
      .eq('id', request_id)
      .single();

    if (reqError || !request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Already authorised — idempotent
    if (request.payment_intent_id && request.payment_status === 'authorised') {
      return new Response(JSON.stringify({ already_authorised: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // NOTE: the claim itself is below, after the driver has been proven. It
    // must not be taken on behalf of somebody who turns out not to own this
    // run, and it must not be taken before we know the amount.

    // The authoritative fee, written by fetch-quote from a server-measured
    // distance. It is deliberately NOT defaulted: this column used to be set by
    // the customer's browser, and falling back to a minimum would quietly price
    // a delivery nobody had costed. A request that was never priced cannot be
    // authorised — the customer re-opens it and gets a real quote.
    const baseFeePence = request.base_fee_pence;
    if (!baseFeePence || baseFeePence <= 0) {
      return new Response(
        JSON.stringify({ error: 'This delivery has not been priced yet.', code: 'NOT_PRICED' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Get the customer's Stripe customer ID and push token
    const { data: customerProfile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, push_token')
      .eq('id', request.customer_id)
      .single();

    if (!customerProfile?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'Customer has no payment method on file' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get the driver's Stripe Connect account ID (via the run)
    const { data: run } = await supabase
      .from('runs')
      .select('driver_id')
      .eq('id', request.run_id)
      .single();

    // Authorisation (IDOR guard): the caller MUST be the driver assigned to this
    // run. Without this, any approved driver could pre-authorise a charge against
    // another driver's customer's card by passing an arbitrary request_id.
    if (!run || run.driver_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not the assigned driver' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: driverProfile } = await supabase
      .from('driver_profiles')
      .select('stripe_account_id')
      .eq('id', run?.driver_id)
      .single();

    // The card the customer thinks of as theirs — the Customer's DEFAULT,
    // promoting the first card when none is set. `?limit=1` alone returned
    // whatever Stripe listed first, which can differ between two calls.
    const paymentMethodId = await defaultCardFor(stripeKey, customerProfile.stripe_customer_id);

    // No card is NOT a dead end any more. It used to answer the DRIVER with
    // "No payment method found for customer", after they had already accepted,
    // and there was no way for the customer to put that right without starting
    // again. The intent is created without a payment method instead, and the
    // customer completes it themselves through fetch-authorise.

    // Service fee — added ON TOP of the delivery fee so the DRIVER receives the
    // full delivery fee and OneShetland's fee is separate (not skimmed from it).
    const fetchCfg = await getCommissionConfig(supabase, 'fetch');
    const serviceFeePence = calculateCommission(baseFeePence, fetchCfg, 'fetch').fee_pence;

    // ── Hold enough to cover the waiting fee that does not exist yet ──────
    //
    // The waiting fee is MEASURED after the driver arrives, which is long
    // after this hold is placed. Holding only base + service meant capture
    // could be asked for up to the configured cap MORE than was ever
    // authorised — and a confirmed card intent cannot be captured above its
    // authorisation, so the driver simply lost the difference.
    //
    // So the hold includes the worst case, and capture takes only what is
    // actually owed. Capturing BELOW an authorisation is ordinary and always
    // permitted; the rest is released. The customer briefly sees a larger
    // pending amount, which is why the screens say "hold" and name the figure.
    const { data: waitCfg } = await supabase
      .from('delivery_pricing_config')
      .select('wait_grace_secs, wait_period_secs, wait_period_pence, wait_max_pence')
      .maybeSingle();
    const waitingHeadroom = Number(waitCfg?.wait_max_pence ?? 0);

    // Pre-authorise the customer for delivery fee + service fee (manual capture).
    const piBody: Record<string, string> = {
      amount: String(baseFeePence + serviceFeePence + waitingHeadroom),
      currency: 'gbp',
      customer: customerProfile.stripe_customer_id,
      capture_method: 'manual',        // pre-auth only — captured on delivery
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[request_id]': request_id,
      'metadata[customer_id]': request.customer_id,
      'metadata[base_fee_pence]': String(baseFeePence),
      'metadata[application_fee_label]': 'OneShetland service fee',
      'metadata[application_fee_pence]': String(serviceFeePence),
      // The capture deadline lives on the CHARGE, not the intent. Expanding it
      // here is how we learn when this hold dies without ever guessing at a
      // number of days — Stripe's window differs by card brand and by whether
      // the network judged the transaction merchant-initiated, which a hold
      // confirmed by the driver very well may be.
      'expand[0]': 'latest_charge',
      description: `OneShetland Fetch — ${request.category_slug ?? 'delivery'} (£${(baseFeePence / 100).toFixed(2)} to driver + £${(serviceFeePence / 100).toFixed(2)} service fee)`,
    };

    // Confirm here only when there is a card to confirm against. Without one
    // the intent is created unconfirmed and waits for the customer.
    if (paymentMethodId) {
      piBody.payment_method = paymentMethodId;
      piBody.confirm = 'true';
    }

    // Destination charge to the driver's Connect account. amount includes the
    // service fee; application_fee_amount = service fee, so the driver receives
    // (amount − service fee) = the FULL delivery fee.
    if (driverProfile?.stripe_account_id) {
      piBody['transfer_data[destination]'] = driverProfile.stripe_account_id;
      if (serviceFeePence > 0) {
        piBody['application_fee_amount'] = String(serviceFeePence);
      }
    }

    // ── One delivery, one hold ───────────────────────────────────────────
    //
    // The decision used to be "is payment_intent_id null?", read then written
    // with nothing holding the gap: two concurrent accepts both read null,
    // both created an intent, and the customer got TWO holds — the second id
    // overwriting the first, leaving the first orphaned for ever.
    //
    // The database decides now. The claim is keyed on the delivery request
    // itself, because a delivery has exactly one authorisation for its whole
    // life and a browser-generated id cannot express that.
    const { data: claimRows, error: claimErr } = await supabase.rpc('claim_fetch_authorisation', {
      p_request:  request_id,
      p_customer: request.customer_id,
      p_driver:   run.driver_id,
      p_amount:   baseFeePence + serviceFeePence + waitingHeadroom,
      // The commercial terms, frozen. The waiting MINUTES are discovered
      // later, as they must be; the rules that turn minutes into money are
      // the ones this customer authorised. A fee change applies to the next
      // Fetch, never to one already held.
      p_base:     baseFeePence,
      p_service:  serviceFeePence,
      p_grace:    Number(waitCfg?.wait_grace_secs ?? 300),
      p_period:   Number(waitCfg?.wait_period_secs ?? 300),
      p_rate:     Number(waitCfg?.wait_period_pence ?? 150),
      p_cap:      waitingHeadroom,
    });
    if (claimErr) {
      console.error('[authorise-payment] claim failed', claimErr);
      return new Response(JSON.stringify({ error: 'Could not start the authorisation. Nothing has been held.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
      { outcome: string; status: string; stripe_payment_intent_id: string | null; result: unknown } | null;

    if (claim?.outcome === 'conflict') {
      return new Response(JSON.stringify({ error: 'This delivery belongs to a different customer.', code: 'ATTEMPT_CONFLICT' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (claim?.outcome === 'terminal') {
      return new Response(JSON.stringify({ error: 'This delivery\'s payment is finished and cannot be restarted.', code: 'ATTEMPT_TERMINAL' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (claim?.outcome === 'in_flight') {
      // Another call is inside Stripe right now. Asking it to wait is the whole
      // point: racing it is what made two holds.
      return new Response(JSON.stringify({ error: 'This authorisation is already being set up. Try again in a moment.', code: 'IN_FLIGHT' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Already reached Stripe. Read THAT intent back and report where it stands
    // — never create another.
    if (claim?.outcome === 'resume' && claim.stripe_payment_intent_id) {
      return await resumeExisting(supabase, stripeKey, request_id, claim.stripe_payment_intent_id, corsHeaders);
    }

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2023-10-16',
        // Deterministic, from the delivery itself. If this request is retried
        // at the HTTP layer after Stripe already made the intent, Stripe hands
        // back the SAME one rather than a second hold. Nothing random or
        // time-based may appear here, or the recovery it exists for is lost.
        'Idempotency-Key': `fetch-auth-${request_id}`,
      },
      body: new URLSearchParams(piBody),
    });

    const pi = await piRes.json();
    if (!piRes.ok) {
      await supabase.rpc('settle_fetch_authorisation', {
        p_request: request_id, p_status: 'unresolved', p_error: pi.error?.message ?? 'create failed',
      });
      throw new Error(`PaymentIntent creation failed: ${pi.error?.message}`);
    }

    // Recorded BEFORE anything that can fail or need the customer. A function
    // that dies after this point retries into 'resume' and finds the same
    // intent; one that died before it is covered by the idempotency key above.
    await supabase.rpc('settle_fetch_authorisation', {
      p_request: request_id, p_status: 'in_flight', p_pi: pi.id,
    });

    // ── What Stripe actually said ────────────────────────────────────────
    //
    // This used to write 'authorised' on the strength of `piRes.ok`. A 200
    // means Stripe accepted the request, not that a hold exists — a card
    // needing 3DS returns 200 with `requires_action`, and one that failed at
    // confirm returns 200 with `requires_payment_method`. Only
    // `requires_capture` is a hold. Anything unrecognised fails closed.
    const outcome = classifyAuthorisation(pi.status);
    const paymentStatus = paymentStatusFor(outcome);

    await supabase.rpc('settle_fetch_authorisation', {
      p_request: request_id, p_pi: pi.id,
      p_status: outcome.kind === 'authorised' ? 'authorised'
              : outcome.kind === 'succeeded'  ? 'captured'
              : outcome.kind === 'canceled'   ? 'terminal'
              : outcome.kind === 'processing' || outcome.kind === 'unknown' ? 'unresolved'
              : 'awaiting_customer',
      p_result: { payment_status: paymentStatus },
    });

    // When Stripe gave a deadline, keep it. Nothing here invents one: an
    // authorisation with no recorded deadline is reconciled by status instead,
    // which is the authority in either case.
    const hold = classifyHold(pi, Date.now());
    await supabase.rpc('record_fetch_hold_state', {
      p_request: request_id, p_state: hold.state, p_detail: hold.detail,
      p_expires_at: hold.expiresAt,
      // The request row is written directly below; recording it twice would
      // let the two disagree.
      p_payment_status: null,
    });

    // The intent id is recorded whatever the outcome: it is what the customer
    // continues, and losing it would strand a live intent nothing points at.
    await supabase
      .from('delivery_requests')
      .update({
        payment_intent_id: pi.id,
        base_fee_pence: baseFeePence,
        payment_status: paymentStatus,
      })
      .eq('id', request_id);

    if (outcome.kind !== 'authorised') {
      // The customer has something to do, and the driver must not be released.
      const needsCustomer = outcome.kind === 'requires_action' || outcome.kind === 'requires_payment_method';
      if (needsCustomer) {
        await sendUserPush(supabase, {
          userId:     request.customer_id,
          module:     'fetch',
          categoryId: 'fetch.driver_matched',
          title:      'Driver found — one thing to do 💳',
          body:       outcome.kind === 'requires_action'
            ? `Open your delivery to confirm the hold with your bank — up to £${((baseFeePence + serviceFeePence + waitingHeadroom) / 100).toFixed(2)}, and you are only charged what the delivery costs. Nothing has been charged yet.`
            : `Open your delivery to add a card. We hold up to £${((baseFeePence + serviceFeePence + waitingHeadroom) / 100).toFixed(2)} and only charge what the delivery costs. Nothing has been charged yet.`,
          data:       { request_id },
        });
      }
      if (outcome.kind === 'unknown') {
        console.error(`[authorise-payment] unrecognised PaymentIntent status for ${request_id}: ${outcome.detail}`);
      }
      return new Response(
        JSON.stringify({
          authorised: false,
          payment_status: paymentStatus,
          requires_customer_action: needsCustomer,
          payment_intent_id: pi.id,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Notify the customer their driver has been matched (preference-aware).
    await sendUserPush(supabase, {
      userId:     request.customer_id,
      module:     'fetch',
      categoryId: 'fetch.driver_matched',
      title:      'Driver matched 🚗',
      body:       `Your driver is on the way to collect your ${request.category_slug ?? 'item'}. Your card will be charged on delivery.`,
      data:       { request_id },
    });

    return new Response(
      JSON.stringify({ authorised: true, payment_status: 'authorised', payment_intent_id: pi.id, base_fee_pence: baseFeePence }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[authorise-payment]', err);
    return new Response(
      JSON.stringify({ error: safeError('authorise-payment', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Hand back the authorisation this delivery already has.
 *
 * Re-read from Stripe rather than from anything stored here, so a driver
 * retrying gets the CURRENT state of the same intent — including one the
 * customer has since completed. Creates nothing.
 */
async function resumeExisting(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  stripeKey: string,
  requestId: string,
  paymentIntentId: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}?expand[]=latest_charge`, {
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' },
  });
  const pi = await res.json();
  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Could not check that authorisation just now.' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // A resumed authorisation is the oldest one in the system, so it is the most
  // likely to have lapsed. The hold reading decides, not the raw status: a
  // requires_capture intent whose deadline has passed is not money.
  const hold = classifyHold(pi, Date.now());
  const outcome = classifyAuthorisation(pi.status);
  const paymentStatus = hold.state === 'expired' ? 'expired' : paymentStatusFor(outcome);

  await supabase.from('delivery_requests')
    .update({ payment_status: paymentStatus, payment_intent_id: paymentIntentId })
    .eq('id', requestId);
  await supabase.rpc('record_fetch_hold_state', {
    p_request: requestId, p_state: hold.state, p_detail: hold.detail,
    p_expires_at: hold.expiresAt, p_payment_status: null,
  });
  await supabase.rpc('settle_fetch_authorisation', {
    p_request: requestId, p_pi: paymentIntentId,
    p_status: hold.state === 'expired'  ? 'expired'
            : outcome.kind === 'authorised' ? 'authorised'
            : outcome.kind === 'succeeded'  ? 'captured'
            : outcome.kind === 'processing' || outcome.kind === 'unknown' ? 'unresolved'
            : 'awaiting_customer',
    p_result: { payment_status: paymentStatus, resumed: true },
  });

  return new Response(
    JSON.stringify({
      resumed: true,
      authorised: hold.state === 'valid' || hold.state === 'expiring_soon',
      hold_state: hold.state,
      expires_at: hold.expiresAt,
      payment_status: paymentStatus,
      requires_customer_action: outcome.kind === 'requires_action' || outcome.kind === 'requires_payment_method',
      payment_intent_id: paymentIntentId,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

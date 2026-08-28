import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { captureDeadline } from '../_shared/fetch-hold.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * capture-payment
 *
 * Called when a driver marks a delivery as complete (status: collected → delivered).
 * Captures the pre-authorised PaymentIntent for base fee + any confirmed waiting fee.
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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Verify caller
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
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

    // Fetch the request (+ customer_id for notification, + run_id for the auth guard)
    const { data: request, error: reqError } = await supabase
      .from('delivery_requests')
      .select('id, customer_id, payment_intent_id, base_fee_pence, waiting_fee_pence, payment_status, run_id')
      .eq('id', request_id)
      .single();

    if (reqError || !request) {
      return new Response(JSON.stringify({ error: 'Request not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authorisation (IDOR guard): only the driver assigned to this delivery's run
    // may capture the customer's card. Prevents a driver capturing a charge on
    // someone else's delivery by passing an arbitrary request_id.
    const { data: run } = await supabase
      .from('runs')
      .select('driver_id')
      .eq('id', request.run_id)
      .single();
    if (!run || run.driver_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not the assigned driver' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!request.payment_intent_id) {
      // No payment intent — mark delivered anyway (e.g. already-paid or legacy requests)
      await supabase
        .from('delivery_requests')
        .update({ status: 'delivered', payment_status: 'unpaid' })
        .eq('id', request_id);

      await sendUserPush(supabase, {
        userId:     request.customer_id,
        module:     'fetch',
        categoryId: 'fetch.delivered',
        title:      'Delivered! 🎉',
        body:       'Your item has arrived.',
        data:       { request_id },
      });

      return new Response(
        JSON.stringify({ captured: false, no_payment_intent: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── The authoritative amount ─────────────────────────────────────────
    //
    // Fix 1 made every one of these the server's: the base fee written by
    // fetch-quote, the service fee from admin_config, and the waiting fee
    // MEASURED from the waiting_events timestamps. Nothing here comes from a
    // request body.
    // Priced under the terms frozen when the hold was placed — not under
    // whatever the configuration says today. Re-reading them here meant a fee
    // rise mid-delivery enlarged a charge the customer had already agreed to.
    const { data: totalRows, error: totalErr } = await supabase
      .rpc('fetch_capture_total_pence', { p_request: request_id });
    if (totalErr) throw totalErr;
    const totals = (Array.isArray(totalRows) ? totalRows[0] : totalRows) as
      { total_pence: number; authorised_pence: number | null; terms_frozen: boolean } | null;

    let totalPence: number;
    if (totals?.terms_frozen) {
      totalPence = Number(totals.total_pence);
    } else {
      // Authorised before the terms were frozen. Current configuration is all
      // there is, and the clamp below is what protects the customer.
      const fetchCfg = await getCommissionConfig(supabase, 'fetch');
      const serviceFeePence = calculateCommission(request.base_fee_pence ?? 0, fetchCfg, 'fetch').fee_pence;
      const { data: waitingPence, error: waitErr } = await supabase
        .rpc('fetch_waiting_fee_pence', { p_request: request_id });
      if (waitErr) throw waitErr;
      totalPence = (request.base_fee_pence ?? 0) + serviceFeePence + Number(waitingPence ?? 0);
    }

    // ── One delivery, one capture ────────────────────────────────────────
    //
    // The old guard was `payment_status === 'captured'` — read, then written,
    // with nothing holding the gap, so two taps could both get past it. The
    // database decides now: exactly one caller moves capture_state into
    // 'in_flight'.
    const { data: claimRows, error: claimErr } = await supabase.rpc('claim_fetch_capture', {
      p_request: request_id, p_driver: user.id, p_amount: null,
    });
    if (claimErr) throw claimErr;
    const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
      { outcome: string; capture_state: string; stripe_payment_intent_id: string | null } | null;

    if (claim?.outcome === 'already_captured') {
      // The driver tapped twice, or the first response was lost after it
      // worked. Either way this is a success, not a Stripe error on a
      // doorstep.
      await supabase.from('delivery_requests')
        .update({ payment_status: 'captured', status: 'delivered' })
        .eq('id', request_id);
      return json({ captured: true, already_captured: true, message: 'Delivery payment already completed.' }, 200);
    }
    if (claim?.outcome === 'in_flight') {
      return json({ error: 'Payment is already being completed. Give it a moment.', code: 'IN_FLIGHT' }, 409);
    }
    if (claim?.outcome === 'wrong_driver') {
      return json({ error: 'Forbidden — not the assigned driver' }, 403);
    }
    if (claim?.outcome !== 'claimed' || !claim.stripe_payment_intent_id) {
      return json({ error: 'This delivery has no authorised payment to complete.', code: 'NO_INTENT' }, 409);
    }

    // The intent is the one the authorisation registry holds — never the row
    // alone, and never anything from the request body.
    const paymentIntentId = claim.stripe_payment_intent_id;
    if (request.payment_intent_id && request.payment_intent_id !== paymentIntentId) {
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'unresolved',
        p_error: 'the request and its attempt name different PaymentIntents',
      });
      console.error(`[capture-payment] PI mismatch for ${request_id}`);
      return json({ error: "We couldn't confirm this payment. Nothing has been taken — we're looking into it." }, 409);
    }

    const stripeHeaders = { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };

    // ── Ask Stripe what it holds, BEFORE trying to take anything ──────────
    //
    // The stored word 'authorised' is our note of a past conversation. It is
    // not evidence that money is still held, and it is certainly not evidence
    // that a previous capture did not already succeed.
    const before = await readIntent(stripeHeaders, paymentIntentId);
    if (!before.ok) {
      await supabase.rpc('settle_fetch_capture', { p_request: request_id, p_state: 'unresolved', p_error: before.error });
      return json({ error: "We couldn't confirm the payment yet. Please don't retry repeatedly — we're checking it." , code: 'UNRESOLVED' }, 502);
    }

    if (before.status === 'succeeded') {
      // Already captured, by an earlier call whose response we lost. Recover
      // rather than capture a second time.
      await converge(supabase, request_id, before.amountReceived ?? totalPence);
      return json({ captured: true, recovered: true, total_fee_pence: before.amountReceived ?? totalPence }, 200);
    }
    if (before.status === 'canceled') {
      // The hold is gone. Whether it lapsed or somebody released it, there is
      // nothing to capture — and the local record must stop saying otherwise,
      // or the next screen to load will offer the driver a button again.
      await supabase.rpc('settle_fetch_capture', { p_request: request_id, p_state: 'failed', p_error: 'intent canceled' });
      await supabase.rpc('record_fetch_hold_state', {
        p_request: request_id, p_state: 'expired',
        p_detail: 'the PaymentIntent was canceled before capture',
        p_payment_status: 'expired',
      });
      return json({ error: 'The hold on this payment is no longer there, so it cannot be completed. The customer needs to authorise it again.', code: 'EXPIRED' }, 409);
    }
    if (before.status === 'requires_capture'
        && before.captureBefore !== undefined && before.captureBefore <= Date.now()) {
      // Past Stripe's own deadline. The funds are released at the network well
      // before the object is tidied up, so capturing here would fail anyway —
      // and calling it a capture failure would hide what actually happened.
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'failed', p_error: 'authorisation expired before capture',
      });
      await supabase.rpc('record_fetch_hold_state', {
        p_request: request_id, p_state: 'expired', p_detail: 'the capture deadline has passed',
        p_payment_status: 'expired',
      });
      return json({ error: 'The hold on this payment has expired, so it cannot be completed. The customer needs to authorise it again.', code: 'EXPIRED' }, 409);
    }
    if (before.status !== 'requires_capture') {
      // requires_action, requires_payment_method, processing, anything new:
      // there is no hold to take. Fail closed rather than call it a failure
      // of the delivery.
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'unresolved', p_error: `not capturable: ${before.status}`,
      });
      return json({ error: 'This delivery is not authorised yet, so payment cannot be completed.', code: 'NOT_AUTHORISED' }, 409);
    }

    // Never take more than is held. The waiting fee is measured after the
    // hold was placed, so it can exceed it — see the report accompanying this
    // change. Capturing the capturable amount is the only safe reading until
    // that policy is decided; the shortfall is recorded, not silently dropped.
    // A safety belt, not business logic. For anything authorised with frozen
    // terms the total cannot exceed the hold by construction — base and
    // service are the same numbers, and the waiting fee is capped at the
    // headroom that was held. If it happens anyway, something is wrong that
    // operations must see: silently taking less is invisible lost revenue for
    // the driver, so it is recorded as a mismatch and said out loud.
    const capturable = before.amountCapturable ?? totalPence;
    const captureAmount = Math.min(totalPence, capturable);
    if (captureAmount < totalPence) {
      const detail = `expected ${totalPence}p but only ${capturable}p was authorised`;
      console.error(`[capture-payment] ${request_id}: ${detail}` +
        (totals?.terms_frozen ? ' — frozen terms should have made this impossible' : ' — legacy pre-freeze authorisation'));
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'in_flight', p_error: `authorisation shortfall: ${detail}`,
      });
    }

    let captureRes: Response;
    let captured: Record<string, unknown> = {};
    let ambiguous = false;
    try {
      captureRes = await fetch(
        `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/capture`,
        {
          method: 'POST',
          headers: {
            ...stripeHeaders,
            'Content-Type': 'application/x-www-form-urlencoded',
            // Deterministic, from the delivery. A retry after a lost response
            // reaches the same operation rather than taking the money twice.
            'Idempotency-Key': `fetch-capture-${request_id}`,
          },
          body: new URLSearchParams({ amount_to_capture: String(captureAmount) }),
        },
      );
      captured = await captureRes.json().catch(() => ({}));
      if (!captureRes.ok) ambiguous = true;
    } catch (_e) {
      // The request may well have reached Stripe. This is UNKNOWN, not failed.
      ambiguous = true;
    }

    if (ambiguous) {
      // Ask Stripe what actually happened rather than declaring a failure and
      // letting the driver retry blind. This is the whole point of the fix.
      const after = await readIntent(stripeHeaders, paymentIntentId);
      if (after.ok && after.status === 'succeeded') {
        await converge(supabase, request_id, after.amountReceived ?? captureAmount);
        return json({ captured: true, recovered: true, total_fee_pence: after.amountReceived ?? captureAmount }, 200);
      }
      if (after.ok && after.status === 'requires_capture') {
        // It genuinely did not happen. Safe to try again — the same
        // idempotency key means a retry cannot become a second capture.
        await supabase.rpc('settle_fetch_capture', {
          p_request: request_id, p_state: 'failed',
          p_error: (captured as { error?: { message?: string } })?.error?.message ?? 'capture did not complete',
        });
        return json({ error: 'We could not take the payment just now. Please try again.', code: 'RETRY' }, 502);
      }
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'unresolved',
        p_error: after.ok ? `unresolved after capture: ${after.status}` : after.error,
      });
      return json({ error: "We couldn't confirm the payment yet. Please don't retry repeatedly — we're checking it.", code: 'UNRESOLVED' }, 502);
    }

    // A clean HTTP result is still not a captured payment. Read the status.
    if (captured.status !== 'succeeded') {
      await supabase.rpc('settle_fetch_capture', {
        p_request: request_id, p_state: 'unresolved', p_error: `capture returned ${captured.status}`,
      });
      return json({ error: "We couldn't confirm the payment yet. Please don't retry repeatedly — we're checking it.", code: 'UNRESOLVED' }, 502);
    }

    await converge(supabase, request_id, captureAmount);

    // Notify the customer their item has been delivered (preference-aware).
    await sendUserPush(supabase, {
      userId:     request.customer_id,
      module:     'fetch',
      categoryId: 'fetch.delivered',
      title:      'Delivered! 🎉',
      body:       `Your item has arrived. £${(totalPence / 100).toFixed(2)} has been charged to your card.`,
      data:       { request_id },
    });

    return new Response(
      JSON.stringify({ captured: true, total_fee_pence: totalPence }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[capture-payment]', err);
    return new Response(
      JSON.stringify({ error: safeError('capture-payment', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Read a PaymentIntent. Never throws — an unreadable intent is a state.
 *
 * The charge is expanded because Stripe's capture deadline lives there, at
 * payment_method_details.card.capture_before, and an authorisation past its
 * deadline is not money however the intent's status still reads.
 */
async function readIntent(headers: Record<string, string>, id: string): Promise<{
  ok: boolean; status?: string; amountCapturable?: number; amountReceived?: number;
  captureBefore?: number; error?: string;
}> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${id}?expand[]=latest_charge`, { headers });
    const pi = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: pi?.error?.message ?? `HTTP ${res.status}` };
    const deadline = captureDeadline(pi);
    return {
      ok: true,
      status: pi.status,
      amountCapturable: typeof pi.amount_capturable === 'number' ? pi.amount_capturable : undefined,
      amountReceived:   typeof pi.amount_received   === 'number' ? pi.amount_received   : undefined,
      captureBefore:    deadline ?? undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unreachable' };
  }
}

/**
 * The money is taken; make everything else agree.
 *
 * Delivered is written HERE, on the driver's own completion request, and not
 * by a webhook: Stripe saying a payment succeeded is not evidence that an item
 * was handed to anybody.
 */
// deno-lint-ignore no-explicit-any
async function converge(supabase: any, requestId: string, totalPence: number) {
  await supabase.rpc('settle_fetch_capture', { p_request: requestId, p_state: 'captured', p_amount: totalPence });
  await supabase.from('delivery_requests')
    .update({ payment_status: 'captured', total_fee_pence: totalPence, status: 'delivered' })
    .eq('id', requestId);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

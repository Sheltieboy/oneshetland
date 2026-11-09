import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { expectedSecretKind, routeEditionEvent, verifyStripeSignature } from '../_shared/editions-commerce-core.ts';

/**
 * editions-stripe-webhook — the ONLY door through which provider events change Editions money state.
 *
 * NOT DEPLOYED. Separate endpoint and signing secrets (EDITIONS_STRIPE_WEBHOOK_SECRET for platform events, EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET for Connect
 * account events), so it can be switched on and off without touching the shared stripe-webhook (which now ignores Edition objects).
 *
 * Verify signature -> bookkeeping row (edition_webhook_begin: one processing per event id) -> pure routing (routeEditionEvent) -> service-role database call(s).
 * The database functions re-validate every amount against what it stored and are idempotent on the provider id, so a replay or a race changes nothing.
 * Non-Edition events are acknowledged and ignored (this endpoint receives all platform events). Any failure returns 500 so the provider retries.
 */
serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const body = await req.text();
  const header = req.headers.get('stripe-signature') ?? '';
  // Each secret may vouch only for its own kind of event: platform events (no `account`) are checked with the platform secret, Connect account events with the
  // Connect secret. A missing secret or a body we cannot classify is refused outright.
  const kind = expectedSecretKind(body);
  const secret = kind === 'connect' ? Deno.env.get('EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET') : kind === 'platform' ? Deno.env.get('EDITIONS_STRIPE_WEBHOOK_SECRET') : undefined;
  let event: Record<string, unknown> | null = null;
  if (secret) { try { event = await verifyStripeSignature(body, header, secret, Math.floor(Date.now() / 1000)); } catch { event = null; } }
  if (!event) return new Response('Webhook signature invalid', { status: 400 });

  const eventId = String(event.id ?? ''), type = String(event.type ?? '');
  const routed = routeEditionEvent(event);
  if (routed.action === 'ignore') return json({ received: true, ignored: routed.reason });

  const { data: fresh, error: beginErr } = await svc.rpc('edition_webhook_begin', { p_event: eventId, p_type: type });
  if (beginErr) { console.error('[editions-webhook] bookkeeping failed', beginErr.message); return new Response('retry', { status: 500 }); }
  if (fresh === false) return json({ received: true, duplicate: true });

  try {
    if (routed.onlyIfKnownPaymentIntent) {
      const { data: known } = await svc.rpc('edition_payment_known', { p_payment_intent: routed.onlyIfKnownPaymentIntent });
      if (known !== true) { await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'ignored', p_detail: 'not an Edition payment' }); return json({ received: true, ignored: 'not ours' }); }
    }
    // Optional enrichment: the provider's own fee numbers for the ledger (never used to decide whether to fulfil).
    let platformFee: number | null = null, stripeFee: number | null = null;
    if (routed.needsChargeDetail && stripeKey) {
      try {
        const r = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(routed.needsChargeDetail.chargeId)}?expand[]=balance_transaction`, { headers: { Authorization: `Bearer ${stripeKey}` } });
        if (r.ok) { const c = await r.json(); platformFee = Number.isInteger(c.application_fee_amount) ? c.application_fee_amount : null; stripeFee = Number.isInteger(c.balance_transaction?.fee) ? c.balance_transaction.fee : null; }
      } catch { /* enrichment is best effort */ }
    }
    for (const call of routed.calls) {
      const args = { ...call.args };
      if (call.fn === 'edition_membership_payment_succeeded') { args.p_stripe_fee = stripeFee; args.p_platform_fee = platformFee; }
      if (call.fn === 'edition_participation_payment_succeeded') { args.p_stripe_fee = stripeFee; }
      const { error } = await svc.rpc(call.fn, args);
      if (error) {
        // An amount the database refuses is a business problem, not a retry problem: record it for the administrator and acknowledge.
        if (/amount_mismatch|does not match/.test(error.message)) {
          await svc.rpc('edition_record_exception', { p_kind: 'amount_refused', p_ref: String(call.args.p_payment_intent ?? call.args.p_invoice ?? eventId), p_org: null, p_detail: { fn: call.fn, message: error.message } });
          await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'failed', p_detail: error.message });
          return json({ received: true, refused: 'amount' });
        }
        throw new Error(`${call.fn}: ${error.message}`);
      }
    }
    await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'ok' });
    return json({ received: true });
  } catch (err) {
    console.error('[editions-webhook] processing failed', eventId, (err as Error).message);
    await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'failed', p_detail: (err as Error).message });
    return new Response('retry', { status: 500 });
  }
});

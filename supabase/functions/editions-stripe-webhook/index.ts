import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { expectedSecretKind, invoiceRefs, routeEditionEvent, verifyStripeSignature } from '../_shared/editions-commerce-core.ts';

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
      if (known !== true) {
        // A PACKAGE order lives in edition_orders, not the payments ledger. A dispute or an unmarked refund on its payment must still reach it (otherwise the Edition would stay live after the money has gone).
        const { data: ord } = await svc.from('edition_orders').select('id, organiser_id, edition_id').eq('stripe_payment_intent_id', routed.onlyIfKnownPaymentIntent).maybeSingle();
        const first = routed.calls[0];
        if (ord && first?.fn === 'edition_payment_refunded') {
          const { error } = await svc.rpc('edition_refund_order', { p_order: ord.id, p_refunded_total: first.args.p_refunded_total });
          if (error) throw new Error(`edition_refund_order: ${error.message}`);
          await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'ok', p_detail: 'package order refund' }); return json({ received: true });
        }
        if (ord && first?.fn === 'edition_dispute_event') {
          // a dispute never silently changes entitlements: it is raised for the administrator, who can void the package if the dispute is lost
          await svc.rpc('edition_record_exception', { p_kind: 'dispute', p_ref: routed.onlyIfKnownPaymentIntent, p_org: ord.organiser_id, p_detail: { order: ord.id, edition: ord.edition_id, reason: first.args.p_reason, event_type: type } });
          await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'ok', p_detail: 'package order dispute raised' }); return json({ received: true });
        }
        await svc.rpc('edition_webhook_done', { p_event: eventId, p_outcome: 'ignored', p_detail: 'not an Edition payment' }); return json({ received: true, ignored: 'not ours' });
      }
    }
    // Our own reads pin Stripe-Version 2023-10-16, so these responses have the legacy shape whatever the endpoint's event version is.
    const PIN = { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };
    // A membership invoice event rendered in the 2025 shape may not carry the payment intent or charge (the payments list is not expanded in events). They are REQUIRED to record the payment (refunds and
    // disputes find it by payment intent), so the invoice is read here, and a failure to read it is a retryable failure (Stripe redelivers) rather than a ledger row without them.
    let invoiceFix: { payment_intent: string | null; charge: string | null; subscription: string | null } | null = null;
    let platformFee: number | null = null, stripeFee: number | null = null;
    if (routed.needsInvoiceDetail) {
      if (!stripeKey) throw new Error('cannot read the invoice: payments are not configured');
      const r = await fetch(`https://api.stripe.com/v1/invoices/${encodeURIComponent(routed.needsInvoiceDetail.invoiceId)}?expand[]=charge.balance_transaction`, { headers: PIN });
      if (!r.ok) throw new Error(`invoice read failed (${r.status})`);
      const refs = invoiceRefs(await r.json());
      if (!refs.payment_intent || !refs.charge) throw new Error('invoice has no payment yet');
      invoiceFix = refs; platformFee = refs.application_fee_amount; stripeFee = refs.stripe_fee;
    }
    // Optional enrichment: the provider's own fee numbers for the ledger (never used to decide whether to fulfil).
    if (!invoiceFix && routed.needsChargeDetail && stripeKey) {
      try {
        const r = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(routed.needsChargeDetail.chargeId)}?expand[]=balance_transaction`, { headers: PIN });
        if (r.ok) { const c = await r.json(); platformFee = Number.isInteger(c.application_fee_amount) ? c.application_fee_amount : null; stripeFee = Number.isInteger(c.balance_transaction?.fee) ? c.balance_transaction.fee : null; }
      } catch { /* enrichment is best effort */ }
    }
    for (const call of routed.calls) {
      const args = { ...call.args };
      if (call.fn === 'edition_membership_payment_succeeded') { args.p_stripe_fee = stripeFee; args.p_platform_fee = platformFee; if (invoiceFix) { args.p_payment_intent = args.p_payment_intent ?? invoiceFix.payment_intent; args.p_charge = args.p_charge ?? invoiceFix.charge; args.p_subscription = args.p_subscription ?? invoiceFix.subscription; } }
      if (call.fn === 'edition_participation_payment_succeeded') { args.p_stripe_fee = stripeFee; args.p_application_fee = platformFee; }   // the application fee Stripe actually collected, for the fee check and the variance
      const { data: result, error } = await svc.rpc(call.fn, args);
      if (!error && call.fn === 'edition_fulfil_order' && result === 'already_fulfilled') {
        // the order was already paid. The same payment arriving again is a harmless replay; a DIFFERENT payment for it is a duplicate charge that the administrator must refund.
        const { data: ord } = await svc.from('edition_orders').select('organiser_id, stripe_payment_intent_id').eq('id', call.args.p_order).maybeSingle();
        if (ord && ord.stripe_payment_intent_id && ord.stripe_payment_intent_id !== call.args.p_payment_intent) {
          await svc.rpc('edition_record_exception', { p_kind: 'missing_in_ledger', p_ref: String(call.args.p_payment_intent), p_org: ord.organiser_id, p_detail: { duplicate_payment_for_order: call.args.p_order, amount: call.args.p_amount, note: 'a second payment for an order that was already paid: refund it' } });
        }
      }
      if (error) {
        // An amount the database refuses is a business problem, not a retry problem: record it for the administrator and acknowledge.
        if (/amount_mismatch|does not match/.test(error.message)) {
          await svc.rpc('edition_record_exception', { p_kind: 'amount_refused', p_ref: String(call.args.p_payment_intent ?? call.args.p_invoice ?? eventId), p_org: null, p_detail: { fn: call.fn, message: error.message } });
          // A membership invoice for an amount other than the expected charge (proration, tier change, coupon, VAT): the subscription's fee is a PERCENTAGE of what was invoiced, so the fixed 20p part of the
          // processing-cost estimate is mis-scaled for that invoice. It is surfaced as amount_mismatch with that note; nothing is activated on the wrong money.
          if (call.fn === 'edition_membership_payment_succeeded') await svc.rpc('edition_record_exception', { p_kind: 'amount_mismatch', p_ref: String(call.args.p_invoice ?? eventId), p_org: null, p_detail: { invoiced_pence: call.args.p_charge_pence, application_fee_collected: platformFee, note: 'fee is a percentage of the invoice: the fixed component of the processing-cost estimate is mis-scaled for this invoice' } });
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

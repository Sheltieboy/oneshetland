import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeEqual, formBody, idempotencyKey, isRetryableProviderStatus, orderRefundParams, reconcileOrderCharge, refundParams, subscriptionCancelRequest, applicationFeeRefundRequest, transferReversalRequest, chargeRefs, findByMetadata, classifyProviderFailure } from '../_shared/editions-commerce-core.ts';

/**
 * editions-commerce-cron — scheduled housekeeping for Editions money. NOT DEPLOYED, NOT SCHEDULED. Service-role bearer required (same pattern as the other crons).
 *   action 'sweep'      membership expiry/cancellation/withdrawal sweep (database function)
 *   action 'cancels'    end the provider subscription of every card membership that has been cancelled or ended (queued by the database); safe to repeat
 *   action 'refunds'    drain pending refund requests: STEP 1 one provider refund each (participation: refund the customer with reverse_transfer and refund_application_fee=false; package orders: a plain refund, the
 *                       platform kept the whole price), the webhook confirms; then STEP 2 (the same action, or 'commission_refunds' alone): refund ONLY the commission share through the application-fee refund API
 *   action 'disputes'   recover LOST disputes from the organiser by a transfer reversal (an insufficient connected balance blocks, alerts and suspends: never loops), then the optional commission share
 *   action 'reconcile'  compare the provider's charges for the last N days with the ledger; mismatches become exceptions for the administrator (nothing is auto-fixed)
 */
serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!bearer || !safeEqual(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return json({ error: 'Unauthorised' }, 401);
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const { action, days = 2 } = await req.json().catch(() => ({}));
  try {
    if (action === 'sweep') { const { data, error } = await svc.rpc('edition_membership_sweep'); if (error) throw error; return json({ ok: true, ...data }); }
    if (!stripeKey) return json({ error: 'Payments are not configured' }, 503);
    // shared provider helper for the money-back steps (never logs a secret; returns the parsed body)
    const stripe = async (method: 'GET' | 'POST', path: string, params?: Record<string, string>, key?: string) => {
      const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16', ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: method === 'POST' ? formBody(params ?? {}) : undefined });
      const j = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json: j, code: (j?.error?.code ?? null) as string | null, message: String(j?.error?.message ?? res.status) };
    };
    // the application fee and transfer of a payment's charge, read at the moment of use (the ledger never trusts a stale id)
    const refsFor = async (chargeId: string | null, paymentIntent: string | null) => {
      let cid = chargeId;
      if (!cid && paymentIntent) { const pi = await stripe('GET', `/payment_intents/${encodeURIComponent(paymentIntent)}`); cid = pi.ok ? (typeof pi.json.latest_charge === 'string' ? pi.json.latest_charge : pi.json.latest_charge?.id ?? null) : null; }
      if (!cid) return null;
      const ch = await stripe('GET', `/charges/${encodeURIComponent(cid)}`); return ch.ok ? chargeRefs(ch.json) : null;
    };
    // STEP 2 of a refund: give back only the commission share (application-fee refund). Idempotent: the key derives from the request id and the amount, and a repeat beyond Stripe's 24 hours first looks for our own metadata.
    const commissionStep = async (rows: { request_id?: string; dispute_id?: string; amount_pence: number; stripe_charge_id: string | null; stripe_payment_intent_id: string | null }[], mark: (id: string, st: 'done' | 'retry' | 'failed', msg: string | null) => Promise<void>) => {
      let n = 0;
      for (const r of rows) {
        const id = String(r.request_id ?? r.dispute_id); let st: 'done' | 'retry' | 'failed' = 'retry', msg: string | null = null;
        try {
          const refs = await refsFor(r.stripe_charge_id, r.stripe_payment_intent_id);
          if (!refs) { st = 'retry'; msg = 'charge not readable yet'; }
          else if (!refs.application_fee) { st = 'failed'; msg = 'the charge has no application fee to refund'; }
          else {
            const q = applicationFeeRefundRequest({ application_fee_id: refs.application_fee, amount_pence: r.amount_pence, request_id: id });
            const existing = await stripe('GET', `/application_fees/${refs.application_fee}/refunds?limit=100`);
            if (existing.ok && findByMetadata(existing.json, 'request_id', id)) st = 'done';
            else { const res = await stripe(q.method, q.path, q.params, q.idempotencyKey); if (res.ok) st = 'done'; else { msg = res.message; st = classifyProviderFailure(res) === 'retry' ? 'retry' : 'failed'; } }
          }
        } catch (e) { st = 'retry'; msg = (e as Error).message; }
        await mark(id, st, msg); if (st === 'done') n++;
      }
      return n;
    };
    const refundCommissions = async () => {
      await svc.rpc('edition_commission_plan_pending');
      const { data: rows, error } = await svc.rpc('edition_commission_refunds_next'); if (error) throw error;
      return commissionStep(rows ?? [], async (id, st, msg) => { await svc.rpc('edition_commission_refund_mark', { p_request: id, p_status: st, p_error: msg }); });
    };
    if (action === 'commission_refunds') return json({ ok: true, commission_refunded: await refundCommissions() });
    if (action === 'disputes') {
      const { data: rows, error } = await svc.rpc('edition_dispute_recoveries_next'); if (error) throw error;
      let recovered = 0, blocked = 0, failed = 0;
      for (const r of rows ?? []) {
        let st: 'done' | 'retry' | 'insufficient' | 'failed' = 'retry', msg: string | null = null, reversal: string | null = null;
        try {
          const refs = await refsFor(r.stripe_charge_id, r.stripe_payment_intent_id);
          if (!refs) { st = 'retry'; msg = 'charge not readable yet'; }
          else if (!refs.transfer) { st = 'failed'; msg = 'the charge has no transfer to reverse'; }
          else {
            const q = transferReversalRequest({ transfer_id: refs.transfer, amount_pence: r.amount_pence, dispute_id: r.dispute_id });
            const existing = await stripe('GET', `/transfers/${refs.transfer}/reversals?limit=100`);
            const already = existing.ok ? findByMetadata(existing.json, 'dispute_id', r.dispute_id) : null;
            if (already) { st = 'done'; reversal = already; }
            else { const res = await stripe(q.method, q.path, q.params, q.idempotencyKey); if (res.ok) { st = 'done'; reversal = String(res.json.id ?? ''); } else { msg = res.message; st = classifyProviderFailure(res); } }
          }
        } catch (e) { st = 'retry'; msg = (e as Error).message; }
        await svc.rpc('edition_dispute_recovery_mark', { p_dispute: r.dispute_id, p_status: st, p_error: msg, p_reversal: reversal });
        if (st === 'done') recovered++; else if (st === 'insufficient') blocked++; else if (st === 'failed') failed++;
      }
      const { data: crows, error: cerr } = await svc.rpc('edition_dispute_commission_next'); if (cerr) throw cerr;
      const commission = await commissionStep(crows ?? [], async (id, st, msg) => { await svc.rpc('edition_dispute_commission_mark', { p_dispute: id, p_status: st, p_error: msg }); });
      return json({ ok: true, recovered, blocked, failed, commission_refunded: commission });
    }
    if (action === 'cancels') {
      const { data: rows, error } = await svc.rpc('edition_stripe_cancels_next'); if (error) throw error;
      let done = 0, failed = 0;
      for (const r of rows ?? []) {
        let ok = false, msg: string | null = null;
        try {
          const q = subscriptionCancelRequest(r.mode, String(r.subscription_id));
          const res = await fetch(`https://api.stripe.com/v1${q.path}`, { method: q.method, headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2023-10-16', 'Idempotency-Key': idempotencyKey('subcancel', r.membership_id, r.mode) }, body: formBody(q.params) });
          if (res.ok) ok = true;
          else { const j = await res.json().catch(() => ({})); msg = String(j.error?.message ?? res.status);
            // already cancelled or gone at the provider is a success for our purposes
            if (res.status === 404 || /already.*cancel|No such subscription/i.test(msg)) ok = true; }
        } catch (e) { msg = (e as Error).message; }
        await svc.rpc('edition_stripe_cancel_mark', { p_membership: r.membership_id, p_ok: ok, p_error: ok ? null : msg });
        if (ok) done++; else failed++;
      }
      // extra subscriptions that were still paid (a second subscription for a membership that already had one): end them now so they never bill again
      let strays = 0;
      const { data: stray, error: strayErr } = await svc.rpc('edition_stripe_stray_next'); if (strayErr) throw strayErr;
      for (const x of stray ?? []) {
        let ok = false, msg: string | null = null;
        try {
          const q = subscriptionCancelRequest('now', String(x.subscription_id));
          const res = await fetch(`https://api.stripe.com/v1${q.path}`, { method: q.method, headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2023-10-16', 'Idempotency-Key': idempotencyKey('stray-cancel', String(x.subscription_id), '1') }, body: formBody(q.params) });
          if (res.ok || res.status === 404) ok = true; else { const j = await res.json().catch(() => ({})); msg = String(j.error?.message ?? res.status); if (/already.*cancel|No such subscription/i.test(msg)) ok = true; }
        } catch (e) { msg = (e as Error).message; }
        await svc.rpc('edition_stripe_stray_mark', { p_subscription: x.subscription_id, p_ok: ok, p_error: ok ? null : msg });
        if (ok) strays++;
      }
      return json({ ok: true, cancelled: done, failed, strays });
    }
    if (action === 'refunds') {
      const { data: rows, error } = await svc.rpc('edition_refunds_next'); if (error) throw error;
      let done = 0;
      for (const r of rows ?? []) {
        let status: 'submitted' | 'retry' | 'failed' = 'failed', msg: string | null = null;
        try {
          const res = await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey('refund', r.request_id, '1') },
            body: formBody(r.order_id ? orderRefundParams({ payment_intent: r.stripe_payment_intent_id, amount_pence: r.amount_pence, request_id: r.request_id, order_id: r.order_id }) : refundParams({ payment_intent: r.stripe_payment_intent_id, amount_pence: r.amount_pence, request_id: r.request_id })) });
          if (res.ok) status = 'submitted';
          else {
            const j = await res.json().catch(() => ({}));
            msg = String(j.error?.message ?? res.status);
            // already refunded at the provider: the webhook will bring the ledger into line; anything temporary is retried later; everything else is a final refusal an administrator must see
            status = j.error?.code === 'charge_already_refunded' ? 'submitted' : isRetryableProviderStatus(res.status) ? 'retry' : 'failed';
          }
        } catch (e) { status = 'retry'; msg = (e as Error).message; }
        await svc.rpc('edition_refund_request_mark', { p_request: r.request_id, p_status: status, p_error: status === 'submitted' ? null : msg });
        if (status === 'submitted') done++;
      }
      return json({ ok: true, submitted: done, commission_refunded: await refundCommissions() });
    }
    if (action === 'reconcile') {
      const to = Math.floor(Date.now() / 1000), from = to - Math.min(Math.max(Number(days) || 2, 1), 31) * 86400;
      const snapshot: unknown[] = []; const orderCharges: { payment_intent: string; amount: number; refunded: number; paid: boolean }[] = []; let startingAfter = '';
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ limit: '100', 'created[gte]': String(from), 'created[lte]': String(to) }); for (const x of ['data.balance_transaction', 'data.application_fee', 'data.transfer']) q.append('expand[]', x); if (startingAfter) q.set('starting_after', startingAfter);
        // pinned to 2023-10-16: the legacy shape (charge.invoice) that the marker test below reads
        const r = await fetch(`https://api.stripe.com/v1/charges?${q}`, { headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' } });
        const j = await r.json(); if (!r.ok) throw new Error(j.error?.message);
        // Edition-marked charges, plus subscription invoice charges (which carry no marker on the charge itself); the database ignores unmarked ones it does not know.
        for (const c of j.data) {
          // package orders are held in edition_orders (not the payments ledger): compared separately below
          if (c.metadata?.kind === 'edition_order' && c.payment_intent) { orderCharges.push({ payment_intent: String(c.payment_intent), amount: c.amount, refunded: c.amount_refunded ?? 0, paid: c.status === 'succeeded' && c.paid === true }); continue; }
          const marked = String(c.metadata?.kind ?? '').startsWith('edition_'); if ((marked || c.invoice) && c.payment_intent) snapshot.push({ payment_intent: c.payment_intent, marked, amount: c.amount, application_fee: c.application_fee_amount ?? 0, refunded: c.amount_refunded, destination: c.transfer_data?.destination ?? c.destination ?? null, status: c.status === 'succeeded' ? 'succeeded' : c.status,
            // the money-back and cost facts the ledger is compared with: Stripe's actual fee, application fee refunded so far, the transfer and how much of it has been reversed
            ...(Number.isInteger(c.balance_transaction?.fee) ? { stripe_fee: c.balance_transaction.fee } : {}), ...(Number.isInteger(c.application_fee?.amount_refunded) ? { application_fee_refunded: c.application_fee.amount_refunded } : {}),
            ...(Number.isInteger(c.transfer?.amount) ? { transfer_amount: c.transfer.amount, transfer_reversed: c.transfer.amount_reversed ?? 0 } : {}) }); }
        if (!j.has_more) break; startingAfter = j.data[j.data.length - 1].id;
      }
      const { data, error } = await svc.rpc('edition_reconcile_apply', { p_snapshot: snapshot, p_from: new Date(from * 1000).toISOString(), p_to: new Date(to * 1000).toISOString() }); if (error) throw error;
      // package orders: raise an exception for anything the provider and the order table disagree about (never auto-corrected)
      let orderExceptions = 0;
      for (const oc of orderCharges) {
        const { data: ord } = await svc.from('edition_orders').select('organiser_id, amount_pence, refunded_pence, status').eq('stripe_payment_intent_id', oc.payment_intent).maybeSingle();
        for (const x of reconcileOrderCharge(oc, ord ?? null)) { await svc.rpc('edition_record_exception', { p_kind: x.kind, p_ref: x.ref, p_org: x.org, p_detail: x.detail }); orderExceptions++; }
      }
      return json({ ok: true, ...data, orders_checked: orderCharges.length, order_exceptions: orderExceptions });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (err) { console.error('[editions-commerce-cron]', (err as Error).message); return json({ error: 'failed' }, 500); }
});

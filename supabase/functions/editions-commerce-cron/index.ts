import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeEqual, formBody, idempotencyKey, isRetryableProviderStatus, refundParams, subscriptionCancelRequest } from '../_shared/editions-commerce-core.ts';

/**
 * editions-commerce-cron — scheduled housekeeping for Editions money. NOT DEPLOYED, NOT SCHEDULED. Service-role bearer required (same pattern as the other crons).
 *   action 'sweep'      membership expiry/cancellation/withdrawal sweep (database function)
 *   action 'cancels'    end the provider subscription of every card membership that has been cancelled or ended (queued by the database); safe to repeat
 *   action 'refunds'    drain pending refund requests: one provider refund each, reverse_transfer, application fee refunded per admin setting; the webhook confirms
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
            body: formBody(refundParams({ payment_intent: r.stripe_payment_intent_id, amount_pence: r.amount_pence, refund_application_fee: r.refund_application_fee, request_id: r.request_id })) });
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
      return json({ ok: true, submitted: done });
    }
    if (action === 'reconcile') {
      const to = Math.floor(Date.now() / 1000), from = to - Math.min(Math.max(Number(days) || 2, 1), 31) * 86400;
      const snapshot: unknown[] = []; let startingAfter = '';
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ limit: '100', 'created[gte]': String(from), 'created[lte]': String(to) }); if (startingAfter) q.set('starting_after', startingAfter);
        const r = await fetch(`https://api.stripe.com/v1/charges?${q}`, { headers: { Authorization: `Bearer ${stripeKey}` } }); const j = await r.json(); if (!r.ok) throw new Error(j.error?.message);
        // Edition-marked charges, plus subscription invoice charges (which carry no marker on the charge itself); the database ignores unmarked ones it does not know.
        for (const c of j.data) { const marked = String(c.metadata?.kind ?? '').startsWith('edition_'); if ((marked || c.invoice) && c.payment_intent) snapshot.push({ payment_intent: c.payment_intent, marked, amount: c.amount, application_fee: c.application_fee_amount ?? 0, refunded: c.amount_refunded, destination: c.transfer_data?.destination ?? c.destination ?? null, status: c.status === 'succeeded' ? 'succeeded' : c.status }); }
        if (!j.has_more) break; startingAfter = j.data[j.data.length - 1].id;
      }
      const { data, error } = await svc.rpc('edition_reconcile_apply', { p_snapshot: snapshot, p_from: new Date(from * 1000).toISOString(), p_to: new Date(to * 1000).toISOString() }); if (error) throw error;
      return json({ ok: true, ...data });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (err) { console.error('[editions-commerce-cron]', (err as Error).message); return json({ error: 'failed' }, 500); }
});

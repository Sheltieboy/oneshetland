/**
 * refund-reconcile.ts — production wiring for refund-reconcile-core.ts.
 *
 * The ONLY Stripe writes in this file are the two in repairOps below
 * (a transfer reversal carrying refund_application_fee, and an application-fee
 * refund). Everything else is a GET. Both writes are idempotent by key and by
 * recomputed gap, and are reached only through reconcileRefundedCharge's
 * policy gates (see autoRepairVerdict).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfigBulk } from './admin-config.ts';
import {
  reconcileRefundedCharge,
  type AutoRepairPolicy, type ReconStore, type ReconcileResult, type RefundFacts, type StripeOps,
} from './refund-reconcile-core.ts';

const STRIPE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2023-10-16';
const CLAIM_STALE_MINUTES = 5;

function stripeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Stripe-Version': STRIPE_API_VERSION,
    ...extra,
  };
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE}${path}`, { method: 'GET', headers: stripeHeaders() });
  const j = await res.json();
  if (!res.ok) throw new Error(`Stripe GET ${path.split('?')[0]} failed: ${j?.error?.message ?? res.status}`);
  return j;
}

async function stripePost(path: string, body: URLSearchParams, idempotencyKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE}${path}`, {
    method: 'POST',
    headers: stripeHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey }),
    body: body.toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message ?? `Stripe POST ${path.split('?')[0]} failed (HTTP ${res.status})`);
  return j;
}

export function stripeOps(): StripeOps {
  return {
    async getFacts(chargeId: string): Promise<RefundFacts> {
      const c = await stripeGet(`/charges/${chargeId}?expand[]=transfer&expand[]=application_fee`);
      const refunds = await stripeGet(`/refunds?charge=${chargeId}&limit=100`);
      const created = ((refunds.data ?? []) as { created: number }[]).map((r) => r.created);
      const t = c.transfer && typeof c.transfer === 'object' ? c.transfer as Record<string, unknown> : null;
      const f = c.application_fee && typeof c.application_fee === 'object' ? c.application_fee as Record<string, unknown> : null;
      return {
        charge_id: c.id as string,
        payment_intent_id: (c.payment_intent as string | null) ?? null,
        charge_amount: c.amount as number,
        amount_refunded: (c.amount_refunded as number) ?? 0,
        transfer: t ? { id: t.id as string, amount: t.amount as number, amount_reversed: (t.amount_reversed as number) ?? 0 } : null,
        fee: f ? { id: f.id as string, amount: f.amount as number, amount_refunded: (f.amount_refunded as number) ?? 0 } : null,
        last_refund_created_unix: created.length ? Math.max(...created) : null,
      };
    },

    // Debits the merchant the NET (transfer − fee) in a single Stripe operation.
    async reverseTransfer(transferId, amount, key) {
      const body = new URLSearchParams({
        amount: String(amount),
        refund_application_fee: 'true',
        'metadata[reason]': 'refund_reconciliation',
      });
      const r = await stripePost(`/transfers/${transferId}/reversals`, body, key);
      return { id: r.id as string };
    },

    async refundFee(feeId, amount, key) {
      const body = new URLSearchParams({ amount: String(amount), 'metadata[reason]': 'refund_reconciliation' });
      const r = await stripePost(`/application_fees/${feeId}/refunds`, body, key);
      return { id: r.id as string };
    },
  };
}

export function dbStore(svc: SupabaseClient): ReconStore {
  return {
    async railFor(paymentIntentId) {
      if (!paymentIntentId) return { rail: 'other', order_id: null };
      const { data } = await svc.from('event_ticket_orders')
        .select('id').eq('stripe_payment_intent_id', paymentIntentId).maybeSingle();
      return data ? { rail: 'event_ticket', order_id: data.id as string } : { rail: 'other', order_id: null };
    },

    async load(chargeId) {
      const { data } = await svc.from('refund_reconciliation')
        .select('charge_id, state, repair_attempts, first_flagged_at').eq('charge_id', chargeId).maybeSingle();
      return (data as { charge_id: string; state: never; repair_attempts: number; first_flagged_at: string | null } | null) ?? null;
    },

    async save(r) {
      const now = new Date().toISOString();
      const { data: existing } = await svc.from('refund_reconciliation')
        .select('first_flagged_at, repair_attempts, repaired_at').eq('charge_id', r.charge_id).maybeSingle();
      const flagged = r.state !== 'reconciled';
      const row = {
        charge_id: r.charge_id,
        payment_intent_id: r.payment_intent_id,
        rail: r.rail,
        order_id: r.order_id,
        state: r.state,
        charge_amount_pence: r.facts.charge_amount,
        amount_refunded_pence: r.facts.amount_refunded,
        transfer_id: r.facts.transfer?.id ?? null,
        transfer_amount_pence: r.facts.transfer?.amount ?? null,
        transfer_reversed_pence: r.facts.transfer?.amount_reversed ?? null,
        fee_id: r.facts.fee?.id ?? null,
        fee_amount_pence: r.facts.fee?.amount ?? null,
        fee_refunded_pence: r.facts.fee?.amount_refunded ?? null,
        transfer_gap_pence: r.transfer_gap,
        fee_gap_pence: r.fee_gap,
        last_error: r.last_error,
        last_refund_at: r.facts.last_refund_created_unix ? new Date(r.facts.last_refund_created_unix * 1000).toISOString() : null,
        first_flagged_at: existing?.first_flagged_at ?? (flagged ? now : null),
        repair_attempts: (existing?.repair_attempts ?? 0) + (r.attempted_repair ? 1 : 0),
        repaired_at: r.repaired ? now : (existing?.repaired_at ?? null),
        last_checked_at: now,
        updated_at: now,
      };
      const { error } = await svc.from('refund_reconciliation').upsert(row, { onConflict: 'charge_id' });
      if (error) throw new Error(`could not save refund reconciliation: ${error.code}`);
    },

    async claimRepair(chargeId) {
      const stale = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();
      const { data, error } = await svc.from('refund_reconciliation')
        .update({ repair_claimed_at: new Date().toISOString() })
        .eq('charge_id', chargeId)
        .or(`repair_claimed_at.is.null,repair_claimed_at.lt.${stale}`)
        .select('charge_id');
      if (error) throw new Error(`could not claim refund repair: ${error.code}`);
      return (data ?? []).length === 1;
    },

    async releaseRepair(chargeId) {
      await svc.from('refund_reconciliation').update({ repair_claimed_at: null }).eq('charge_id', chargeId);
    },

    async event(chargeId, kind, actor, detail) {
      const { error } = await svc.from('refund_reconciliation_events')
        .insert({ charge_id: chargeId, kind, actor, detail });
      if (error) console.error('[refund-reconcile] audit write failed:', error.code);
    },
  };
}

export async function loadPolicy(svc: SupabaseClient): Promise<AutoRepairPolicy> {
  const cfg = await getConfigBulk(svc, [
    'refunds.reconcile.auto_repair_enabled',
    'refunds.reconcile.auto_repair_max_age_hours',
  ]);
  const hours = Number(cfg.get('refunds.reconcile.auto_repair_max_age_hours'));
  return {
    enabled: cfg.get('refunds.reconcile.auto_repair_enabled') === 'true',
    max_refund_age_hours: Number.isFinite(hours) && hours > 0 ? hours : 72,
    nowUnix: Math.floor(Date.now() / 1000),
  };
}

export async function reconcileCharge(
  svc: SupabaseClient, chargeId: string,
  opts: { actor: string; allowRepair: boolean; force?: boolean },
): Promise<ReconcileResult> {
  return reconcileRefundedCharge(stripeOps(), dbStore(svc), chargeId, {
    actor: opts.actor, allowRepair: opts.allowRepair, force: opts.force, policy: await loadPolicy(svc),
  });
}

/** Distinct charge ids that have at least one refund, newest first. GET only. */
export async function listRefundedChargeIds(sinceUnix?: number): Promise<string[]> {
  const ids: string[] = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const q = `/refunds?limit=100${sinceUnix ? `&created[gte]=${sinceUnix}` : ''}${after ? `&starting_after=${after}` : ''}`;
    const j = await stripeGet(q);
    const data = (j.data ?? []) as { id: string; charge: string | null }[];
    for (const r of data) if (r.charge && !ids.includes(r.charge)) ids.push(r.charge);
    if (!j.has_more || data.length === 0) break;
    after = data[data.length - 1].id;
  }
  return ids;
}

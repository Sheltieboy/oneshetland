/**
 * refund-reconcile-core.ts — pure rules and orchestration for answering one
 * question after a card refund: did the MERCHANT's money come back too?
 *
 * Why this exists. On a destination charge Stripe moves the full amount to the
 * connected account and collects OneShetland's fee from it. Refunding the
 * customer does NOT touch either of those unless the refund asks for
 * reverse_transfer and refund_application_fee. A refund issued from the Stripe
 * Dashboard (or any path that forgets the flags) therefore refunds the
 * customer from OneShetland's own balance while the merchant keeps the money:
 * two real event-ticket refunds did exactly that, and the order rows still
 * said "refunded". An order row saying refunded proves only that the
 * customer was paid back — never that the merchant was.
 *
 * No imports and no I/O here: Stripe and storage are injected, so the same
 * code that runs in production is what the tests drive against a model of
 * Stripe's behaviour.
 */

export type ReconState =
  | 'reconciled'      // customer refunded AND merchant transfer reversed AND fee refunded (to within rounding)
  | 'repaired'        // was not reconciled; OneShetland completed the missing steps
  | 'needs_repair'    // full refund, merchant still holds money; not auto-repaired (policy or safety gate)
  | 'needs_review'    // partial refund with a gap, or anything a person must decide
  | 'repair_failed';  // an automatic repair was attempted and Stripe refused or errored

export interface RefundFacts {
  charge_id: string;
  payment_intent_id: string | null;
  charge_amount: number;
  amount_refunded: number;
  transfer: { id: string; amount: number; amount_reversed: number } | null;
  fee: { id: string; amount: number; amount_refunded: number } | null;
  /** Creation time of the most recent refund on the charge (unix seconds). */
  last_refund_created_unix: number | null;
}

export type Assessment =
  | { state: 'not_applicable'; reason: string }        // no connected-account transfer: nothing to reverse
  | { state: 'not_refunded'; reason: string }
  | {
      state: 'reconciled' | 'needs_repair' | 'needs_review';
      full: boolean;
      expected_transfer_reversed: number;
      expected_fee_refunded: number;
      transfer_gap: number;
      fee_gap: number;
      reason: string;
    };

/** Partial refunds are apportioned by Stripe with its own rounding. */
const PARTIAL_ROUNDING_TOLERANCE = 1;

export function assessRefund(f: RefundFacts): Assessment {
  if (!f.transfer) return { state: 'not_applicable', reason: 'charge has no connected-account transfer' };
  if (f.amount_refunded <= 0) return { state: 'not_refunded', reason: 'nothing refunded' };
  if (f.charge_amount <= 0) return { state: 'not_applicable', reason: 'zero-amount charge' };

  const full = f.amount_refunded >= f.charge_amount;
  const share = full ? 1 : f.amount_refunded / f.charge_amount;
  const expected_transfer_reversed = full ? f.transfer.amount : Math.round(f.transfer.amount * share);
  const expected_fee_refunded = f.fee ? (full ? f.fee.amount : Math.round(f.fee.amount * share)) : 0;

  const tol = full ? 0 : PARTIAL_ROUNDING_TOLERANCE;
  const rawTransferGap = Math.max(0, expected_transfer_reversed - f.transfer.amount_reversed);
  const rawFeeGap = f.fee ? Math.max(0, expected_fee_refunded - f.fee.amount_refunded) : 0;
  const transfer_gap = rawTransferGap <= tol ? 0 : rawTransferGap;
  const fee_gap = rawFeeGap <= tol ? 0 : rawFeeGap;

  if (transfer_gap === 0 && fee_gap === 0) {
    return {
      state: 'reconciled', full, expected_transfer_reversed, expected_fee_refunded, transfer_gap, fee_gap,
      reason: 'customer refunded, merchant transfer reversed and platform fee refunded',
    };
  }
  const parts: string[] = [];
  if (transfer_gap > 0) parts.push(`merchant still holds ${transfer_gap}p of the transfer`);
  if (fee_gap > 0) parts.push(`${fee_gap}p of the platform fee was not refunded`);
  return {
    state: full ? 'needs_repair' : 'needs_review',
    full, expected_transfer_reversed, expected_fee_refunded, transfer_gap, fee_gap,
    reason: parts.join('; '),
  };
}

export interface RepairStep {
  kind: 'reverse_transfer' | 'refund_fee';
  amount: number;
  idempotency_key: string;
}

/**
 * The missing steps for a FULL refund, recomputed from live state every time —
 * which is what makes a retry, a duplicate webhook, or a second actor safe: an
 * already-reversed transfer or already-refunded fee yields no step.
 *
 *   • reverse_transfer carries refund_application_fee, so the merchant is
 *     debited the NET (transfer − fee) in one Stripe operation. Reversing the
 *     gross and refunding the fee separately could fail halfway and leave the
 *     merchant out of pocket.
 *   • refund_fee on its own is only ever planned once the transfer is fully
 *     reversed. Refunding the fee while the merchant still holds the money
 *     would pay the merchant twice.
 */
export function repairPlan(f: RefundFacts, a: Assessment): RepairStep[] {
  if (a.state !== 'needs_repair' || !a.full || !f.transfer) return [];
  const steps: RepairStep[] = [];
  if (a.transfer_gap > 0) {
    steps.push({
      kind: 'reverse_transfer', amount: a.transfer_gap,
      idempotency_key: `recon:${f.charge_id}:reverse:${f.transfer.amount_reversed}:${a.transfer_gap}`,
    });
    return steps; // the fee refund rides on the reversal; anything left is re-planned next pass
  }
  if (a.fee_gap > 0 && f.fee) {
    steps.push({
      kind: 'refund_fee', amount: a.fee_gap,
      idempotency_key: `recon:${f.charge_id}:fee:${f.fee.amount_refunded}:${a.fee_gap}`,
    });
  }
  return steps;
}

export interface AutoRepairPolicy {
  enabled: boolean;
  /** Only refunds created within this window are auto-repaired. */
  max_refund_age_hours: number;
  nowUnix: number;
}

/**
 * Money is moved automatically only when ALL hold. Anything else is flagged
 * for a person. In particular the age window means a historical refund — or a
 * webhook someone re-sends from the Dashboard — can never trigger a clawback.
 */
export function autoRepairVerdict(
  rail: string, a: Assessment, f: RefundFacts, p: AutoRepairPolicy,
): { allowed: boolean; why: string } {
  if (a.state !== 'needs_repair') return { allowed: false, why: 'nothing to repair' };
  if (!p.enabled) return { allowed: false, why: 'automatic repair is switched off' };
  if (rail !== 'event_ticket') return { allowed: false, why: `automatic repair is not enabled for the ${rail} rail` };
  if (!a.full) return { allowed: false, why: 'partial refund — a person must decide' };
  if (f.last_refund_created_unix === null) return { allowed: false, why: 'refund time unknown' };
  const ageHours = (p.nowUnix - f.last_refund_created_unix) / 3600;
  if (ageHours > p.max_refund_age_hours) {
    return { allowed: false, why: `refund is ${Math.floor(ageHours)}h old — outside the ${p.max_refund_age_hours}h automatic window` };
  }
  return { allowed: true, why: 'recent full refund on an event-ticket destination charge' };
}

/* ── Orchestration, with Stripe and storage injected ──────────────────────── */

export interface StripeOps {
  getFacts(chargeId: string): Promise<RefundFacts>;
  reverseTransfer(transferId: string, amount: number, idempotencyKey: string): Promise<{ id: string }>;
  refundFee(feeId: string, amount: number, idempotencyKey: string): Promise<{ id: string }>;
}

export interface ReconRow {
  charge_id: string;
  state: ReconState;
  repair_attempts: number;
  first_flagged_at: string | null;
}

export interface ReconStore {
  railFor(paymentIntentId: string | null): Promise<{ rail: string; order_id: string | null }>;
  load(chargeId: string): Promise<ReconRow | null>;
  /** Upsert the snapshot. Must preserve first_flagged_at once set. */
  save(row: {
    charge_id: string; payment_intent_id: string | null; rail: string; order_id: string | null; state: ReconState;
    facts: RefundFacts; transfer_gap: number; fee_gap: number; last_error: string | null; repaired: boolean;
    attempted_repair: boolean;
  }): Promise<void>;
  /** True only for the one caller that wins the right to move money for this charge now. */
  claimRepair(chargeId: string): Promise<boolean>;
  releaseRepair(chargeId: string): Promise<void>;
  event(chargeId: string, kind: 'detected' | 'repaired' | 'repair_failed' | 'verified' | 'review', actor: string, detail: Record<string, unknown>): Promise<void>;
}

export interface ReconcileOptions {
  actor: string;
  /** Webhook / admin-after-approval may repair; the sweep never does. */
  allowRepair: boolean;
  /** Admin-approved repair: skips the age window and the kill switch, but never the "full refund" rule. */
  force?: boolean;
  policy: AutoRepairPolicy;
}

export interface ReconcileResult {
  charge_id: string;
  state: ReconState | 'not_applicable' | 'not_refunded' | 'error';
  rail?: string;
  transfer_gap: number;
  fee_gap: number;
  steps_run: string[];
  note: string;
}

export async function reconcileRefundedCharge(
  stripe: StripeOps, store: ReconStore, chargeId: string, opts: ReconcileOptions,
): Promise<ReconcileResult> {
  let facts: RefundFacts;
  try {
    facts = await stripe.getFacts(chargeId);
  } catch (e) {
    return { charge_id: chargeId, state: 'error', transfer_gap: 0, fee_gap: 0, steps_run: [], note: `could not read Stripe: ${msg(e)}` };
  }
  let a = assessRefund(facts);
  if (a.state === 'not_applicable' || a.state === 'not_refunded') {
    return { charge_id: chargeId, state: a.state, transfer_gap: 0, fee_gap: 0, steps_run: [], note: a.reason };
  }

  const { rail, order_id } = await store.railFor(facts.payment_intent_id);
  const prior = await store.load(chargeId);
  const steps_run: string[] = [];
  let lastError: string | null = null;
  let attempted = false;
  let repaired = false;

  if (a.state === 'needs_repair' && opts.allowRepair) {
    const verdict = opts.force
      ? (a.full ? { allowed: true, why: 'admin-approved repair' } : { allowed: false, why: 'partial refund — repair manually' })
      : autoRepairVerdict(rail, a, facts, opts.policy);

    if (verdict.allowed) {
      // Persist the flag FIRST so there is a row to claim, then take the claim.
      await store.save({
        charge_id: chargeId, payment_intent_id: facts.payment_intent_id, rail, order_id, state: 'needs_repair',
        facts, transfer_gap: a.transfer_gap, fee_gap: a.fee_gap, last_error: null, repaired: false, attempted_repair: false,
      });
      if (await store.claimRepair(chargeId)) {
        attempted = true;
        try {
          // At most two passes: the reversal (which refunds the fee with it), then any fee remainder.
          for (let pass = 0; pass < 2; pass++) {
            const plan = repairPlan(facts, a);
            if (plan.length === 0) break;
            for (const step of plan) {
              if (step.kind === 'reverse_transfer') await stripe.reverseTransfer(facts.transfer!.id, step.amount, step.idempotency_key);
              else await stripe.refundFee(facts.fee!.id, step.amount, step.idempotency_key);
              steps_run.push(`${step.kind}:${step.amount}`);
            }
            facts = await stripe.getFacts(chargeId);
            a = assessRefund(facts);
            if (a.state !== 'needs_repair') break;
          }
          repaired = steps_run.length > 0 && a.state === 'reconciled';
        } catch (e) {
          lastError = msg(e);
          // Someone else (the webhook, an admin) may have finished the job meanwhile.
          try { facts = await stripe.getFacts(chargeId); a = assessRefund(facts); } catch { /* keep the failure */ }
          if (a.state === 'reconciled') { lastError = null; repaired = true; } // it was un-reconciled when we started
        } finally {
          await store.releaseRepair(chargeId);
        }
      } else {
        lastError = null;
        steps_run.push('skipped:another-repair-in-progress');
      }
    } else {
      steps_run.push(`not-repaired:${verdict.why}`);
    }
  }

  const gapT = a.state === 'reconciled' || a.state === 'needs_repair' || a.state === 'needs_review' ? a.transfer_gap : 0;
  const gapF = a.state === 'reconciled' || a.state === 'needs_repair' || a.state === 'needs_review' ? a.fee_gap : 0;
  let state: ReconState;
  // A charge OneShetland repaired stays 'repaired' on later re-checks: flipping it back to
  // 'reconciled' would erase the fact that the merchant leg had to be completed.
  if (a.state === 'reconciled') state = repaired || prior?.state === 'repaired' ? 'repaired' : 'reconciled';
  else if (attempted && lastError) state = 'repair_failed';
  else state = a.state === 'needs_review' ? 'needs_review' : 'needs_repair';

  await store.save({
    charge_id: chargeId, payment_intent_id: facts.payment_intent_id, rail, order_id, state, facts,
    transfer_gap: gapT, fee_gap: gapF, last_error: lastError, repaired, attempted_repair: attempted,
  });

  // An event only when something worth remembering happened — a sweep that
  // re-confirms the same flag every half hour must not flood the audit trail.
  const changed = !prior || prior.state !== state;
  if (repaired) await store.event(chargeId, 'repaired', opts.actor, { steps: steps_run, transfer_gap: gapT, fee_gap: gapF });
  else if (state === 'repair_failed') await store.event(chargeId, 'repair_failed', opts.actor, { error: lastError, steps: steps_run });
  else if (changed && state === 'reconciled') await store.event(chargeId, 'verified', opts.actor, {});
  else if (changed && state === 'needs_review') await store.event(chargeId, 'review', opts.actor, { transfer_gap: gapT, fee_gap: gapF, reason: a.state === 'needs_review' ? a.reason : '' });
  else if (changed && state === 'needs_repair') await store.event(chargeId, 'detected', opts.actor, { transfer_gap: gapT, fee_gap: gapF });

  return {
    charge_id: chargeId, state, rail, transfer_gap: gapT, fee_gap: gapF, steps_run,
    note: a.state === 'reconciled' ? 'reconciled' : (a.state === 'needs_repair' || a.state === 'needs_review') ? a.reason : '',
  };
}

function msg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

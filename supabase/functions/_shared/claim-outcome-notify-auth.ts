/**
 * claim-outcome-notify-auth.ts — who may make notify-claim fire.
 *
 * Approving or rejecting a Directory business claim is an admin action, so
 * telling the claimant the outcome is one too: only an admin may raise this
 * notice, for any claim. This was already checked inline in notify-claim;
 * pulled out here so the rule is unit-testable the same way as every other
 * fan-out's gate, with the same input validation the others get.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export async function authoriseClaimOutcomeNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { claimId: unknown; outcome: unknown },
): Promise<NotifyDecision> {
  const { claimId, outcome } = input;
  if (!claimId || !outcome) return denyNotify(400, 'claim_id and outcome required');
  if (caller.isServiceRole) return { ok: true };
  if (!isUuid(claimId)) return denyNotify(400, 'claim_id and outcome required');

  const { data: me } = await svc.from('profiles').select('role').eq('id', caller.userId).maybeSingle();
  if ((me as { role?: string } | null)?.role !== 'admin') return denyNotify(403, 'Not allowed');

  return { ok: true };
}

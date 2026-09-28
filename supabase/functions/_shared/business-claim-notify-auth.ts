/**
 * business-claim-notify-auth.ts — who may make notify-business-claim fire.
 *
 * notify-business-claim checked only that the caller was signed in. claim_id
 * came straight from the request body, so any account could re-trigger "X
 * claimed Y" to every admin for a claim that was never theirs — spam aimed at
 * the admin team, in someone else's name.
 *
 * The gate ties the caller to the claim: only the person who lodged it (the
 * claimant named on the row) may ask that admins be told about it.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export async function authoriseBusinessClaimNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { claimId: unknown },
): Promise<NotifyDecision> {
  const { claimId } = input;
  if (!claimId) return denyNotify(400, 'claim_id required');
  if (caller.isServiceRole) return { ok: true };
  if (!isUuid(claimId)) return denyNotify(400, 'claim_id required');

  const { data: claim } = await svc
    .from('business_claims').select('user_id')
    .eq('id', claimId).maybeSingle();
  if (!claim) return denyNotify(404, 'Claim not found');
  if ((claim as { user_id?: string } | null)?.user_id !== caller.userId) return denyNotify(403, 'Not allowed');

  return { ok: true };
}

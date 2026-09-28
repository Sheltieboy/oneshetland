/**
 * hub-notify-auth.ts — who may make notify-hub send a given notice.
 *
 * notify-hub used to check only that the caller was SIGNED IN. Every field of the
 * notice — which hub, which user, which event — came straight from the request
 * body, so any account could:
 *
 *   approved      → push "You're now a member of <hub>" to ANY user, for ANY hub
 *   join_request  → tell a hub's admins that ANY user (named from their profile)
 *                   "asked to join", for a hub that user never approached
 *
 * That is notification spoofing in OneShetland's own name. The gate is now tied
 * to the hub, using the same authority the database's own policies use
 * (is_hub_admin / hub_members):
 *
 *   join_request     the caller IS the user, and that user has a PENDING request
 *   approved         the caller administers the hub, and the user is an ACTIVE member
 *   membership_paid  fulfilment only (service role): no client ever raises it
 *
 * A service-role caller is our own backend and is trusted for all three.
 *
 * Pure of I/O apart from the two lookups passed in through `svc`, so the whole
 * decision is testable with a fake.
 */

export type HubNotifyEvent = 'join_request' | 'membership_paid' | 'approved';

export const HUB_NOTIFY_EVENTS: readonly string[] = ['join_request', 'membership_paid', 'approved'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HubNotifyDecision = { ok: true } | { ok: false; status: number; error: string };

const deny = (status: number, error: string): HubNotifyDecision => ({ ok: false, status, error });

export async function authoriseHubNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; hubId: unknown; userId: unknown },
): Promise<HubNotifyDecision> {
  const { event, hubId, userId } = input;

  if (typeof event !== 'string' || !HUB_NOTIFY_EVENTS.includes(event)) return deny(400, 'unknown event');
  if (typeof hubId !== 'string' || !UUID.test(hubId)) return deny(400, 'event and hub_id required');
  if (userId != null && (typeof userId !== 'string' || !UUID.test(userId))) return deny(400, 'invalid user_id');

  // Our own backend (fulfilment, confirm-hub-membership) invokes with the service key.
  if (caller.isServiceRole) return { ok: true };

  if (event === 'membership_paid') return deny(403, 'Not allowed');
  if (typeof userId !== 'string') return deny(400, 'user_id required');

  if (event === 'join_request') {
    // You can only announce your own request, and only if you have one.
    if (userId !== caller.userId) return deny(403, 'Not allowed');
    const { data } = await svc
      .from('hub_members').select('id')
      .eq('hub_id', hubId).eq('user_id', userId).eq('status', 'pending')
      .limit(1);
    return Array.isArray(data) && data.length > 0 ? { ok: true } : deny(403, 'Not allowed');
  }

  // approved: an administrator of THIS hub, telling a member who is genuinely in.
  const { data: isAdmin, error } = await svc.rpc('is_hub_admin', { p_hub: hubId, p_user: caller.userId });
  if (error || isAdmin !== true) return deny(403, 'Not allowed');
  const { data: member } = await svc
    .from('hub_members').select('id')
    .eq('hub_id', hubId).eq('user_id', userId).eq('status', 'active')
    .limit(1);
  return Array.isArray(member) && member.length > 0 ? { ok: true } : deny(403, 'Not allowed');
}

/**
 * fetch-notify-auth.ts — who may make notify-drivers and notify-collected fire, and for which delivery request.
 *
 *   notify-drivers    the CUSTOMER raised a request ("New delivery request" to approved drivers / the matching run's driver)
 *                     or cancelled one that a driver had already accepted ("Delivery cancelled" to that driver)
 *   notify-collected  the DRIVER collected the item ("Item collected" to the customer)
 *
 * Both checked only that the caller was signed in; request_id came straight from the body. Any account could broadcast a customer's pickup and
 * destination to every approved driver, tell a driver a run was cancelled, or tell a customer their parcel was collected. The rule mirrors the
 * database's own authority over the request (RLS on delivery_requests) and is resolved from the caller's authenticated identity:
 *
 *   notify-drivers    caller = delivery_requests.customer_id
 *   notify-collected  caller = runs.driver_id of the request's run_id  (the driver who accepted it)
 *
 * The claimed fact must also be true: a new-request fan-out only for a request still `pending`; a cancellation only once the request is `cancelled`;
 * "collected" only once it is `collected` (or already `delivered`). Recipients come from the same rows (customer_id, the run's driver, the approved-driver
 * list), never from the request body.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

type Caller = { userId: string; isServiceRole: boolean };
// deno-lint-ignore no-explicit-any
type Svc = any;

export type FetchNotifyInput =
  | { action: 'drivers'; requestId: unknown; event?: unknown }
  | { action: 'collected'; requestId: unknown };

export async function authoriseFetchNotify(svc: Svc, caller: Caller, input: FetchNotifyInput): Promise<NotifyDecision> {
  if (!isUuid(input.requestId)) return denyNotify(400, 'request_id is required');
  if (input.action === 'drivers' && input.event != null && input.event !== 'cancelled' && input.event !== 'new') return denyNotify(400, "event must be 'new', 'cancelled' or omitted");
  if (caller.isServiceRole) return { ok: true };

  const { data: req } = await svc.from('delivery_requests').select('id, customer_id, run_id, status').eq('id', input.requestId).maybeSingle();
  if (!req) return denyNotify(404, 'Request not found');
  const r = req as { customer_id: string; run_id: string | null; status: string };

  if (input.action === 'drivers') {
    if (r.customer_id !== caller.userId) return denyNotify(403, 'Not allowed');
    if (input.event === 'cancelled') {
      if (r.status !== 'cancelled') return denyNotify(409, 'The request is not cancelled');
    } else if (r.status !== 'pending') {
      return denyNotify(409, 'The request is not open to drivers');
    }
    return { ok: true };
  }

  // collected
  if (!r.run_id) return denyNotify(403, 'Not allowed');
  const { data: run } = await svc.from('runs').select('driver_id').eq('id', r.run_id).maybeSingle();
  if (!run || (run as { driver_id?: string }).driver_id !== caller.userId) return denyNotify(403, 'Not allowed');
  if (r.status !== 'collected' && r.status !== 'delivered') return denyNotify(409, 'The request has not been collected');
  return { ok: true };
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json } from '../_shared/fetch-v2-payment-deps.ts';
import { verificationDeps } from '../_shared/fetch-v2-verification-deps.ts';
import { handleApply } from '../_shared/fetch-v2-verification.ts';

/**
 * become-driver
 *
 * Submits a Fetch driver application. Driver is a CAPABILITY, not an identity: it lives in driver_profiles.driver_status, never
 * profiles.role.
 *
 * An application only ever results in `pending` (or leaves an approved account unchanged). Approval is a reviewer's decision after
 * the evidence is checked (docs/FETCH_V2_IMPLEMENTATION.md, Step 6). Previously this function also put a suspended or rejected
 * driver straight back to pending and let an approved driver change vehicle without review; both now go through
 * fetch_v2_apply_driver, which refuses a suspended account, records every application, and applies re-verification to vehicle
 * changes.
 *
 * Body: { vehicle_type?, vehicle_reg?, statement?, vehicle_class?, max_size_class?, can_two_person_lift? } — anything else is ignored.
 * Returns: { ok: true, driver_status } or { ok: false, code, error }.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleApply(await callerId(req), await req.json().catch(() => ({})), verificationDeps('become-driver'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[become-driver]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

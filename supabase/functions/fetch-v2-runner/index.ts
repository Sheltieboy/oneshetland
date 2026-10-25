import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { runSweeps } from '../_shared/fetch-v2-payments.ts';
import { verificationDeps } from '../_shared/fetch-v2-verification-deps.ts';
import { runVerificationSweep } from '../_shared/fetch-v2-verification.ts';

/**
 * fetch-v2-runner — the Fetch v2 timed sweeps (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Cron-only (x-cron-secret).
 *
 * Expires overdue open requests, releases claims whose payment was not completed in time (void + retire), escalates unanswered
 * cancellation requests, then works through the payment queue: orphaned holds voided and retired, holds dying before collection
 * rotated to a new generation, holds dying after collection escalated, resolved returns captured, stale confirmations refreshed.
 * Then driver verification (Step 6): evidence expiry and reminders, lapsed drivers' live jobs surfaced, abandoned uploads removed.
 * Every item is repeat-safe; one failure never stops the rest. NOT scheduled yet.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;
  try {
    const payments = await runSweeps(paymentDeps('fetch-v2-runner'));
    const verification = await runVerificationSweep(verificationDeps('fetch-v2-runner'));
    return json({ ok: true, ...payments, verification });
  } catch (err) {
    console.error('[fetch-v2-runner]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error' }, 500);
  }
});

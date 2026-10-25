import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { runSweeps } from '../_shared/fetch-v2-payments.ts';
import { verificationDeps } from '../_shared/fetch-v2-verification-deps.ts';
import { runVerificationSweep } from '../_shared/fetch-v2-verification.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { drainNotifications } from '../_shared/fetch-v2-notify.ts';
import { expoPushGateway } from '../_shared/fetch-v2-push-gateway.ts';
import { photoDeps } from '../_shared/fetch-v2-photo-deps.ts';
import { runPhotoSweep } from '../_shared/fetch-v2-photos.ts';

/**
 * fetch-v2-runner — the Fetch v2 timed sweeps (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Cron-only (x-cron-secret).
 *
 * Expires overdue open requests, releases claims whose payment was not completed in time (void + retire), escalates unanswered
 * cancellation requests, then works through the payment queue: orphaned holds voided and retired, holds dying before collection
 * rotated to a new generation, holds dying after collection escalated, resolved returns captured, stale confirmations refreshed.
 * Then driver verification (Step 6): evidence expiry and reminders, lapsed drivers' live jobs surfaced, abandoned uploads removed.
 * Abandoned photo uploads are removed (Step 9). Finally the notification outbox (Step 8): inbox rows are written first, then due pushes go out and are settled.
 * Every item is repeat-safe; one failure never stops the rest. NOT scheduled yet.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;
  try {
    const payments = await runSweeps(paymentDeps('fetch-v2-runner'));
    const verification = await runVerificationSweep(verificationDeps('fetch-v2-runner'));
    const photos = await runPhotoSweep(photoDeps('fetch-v2-runner'));
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const notifications = await drainNotifications({
      rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
      push: expoPushGateway(svc),
    });
    return json({ ok: true, ...payments, verification, photos, notifications });
  } catch (err) {
    console.error('[fetch-v2-runner]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error' }, 500);
  }
});

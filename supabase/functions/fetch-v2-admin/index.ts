import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { handleAdmin } from '../_shared/fetch-v2-payments.ts';
import { verificationDeps } from '../_shared/fetch-v2-verification-deps.ts';
import { handleVerificationAdmin } from '../_shared/fetch-v2-verification.ts';

/**
 * fetch-v2-admin — administrator payment actions: cancel, return to board, resolve a cancellation or a return (capture or void),
 * retry a capture, void a stuck hold, reconcile with Stripe (Step 5, _shared/fetch-v2-payments.ts). With `area: "drivers"`, driver
 * verification: the review queue, a driver's record, evidence review, driver decisions, requirements, short-lived evidence links and
 * file deletion (Step 6, _shared/fetch-v2-verification.ts). Every action is audited by the database; this file only wires it.
 * Clients send identifiers and choices; every amount, account and intent comes from the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const out = body?.area === 'drivers'
      ? await handleVerificationAdmin(await callerId(req), body, verificationDeps('fetch-v2-admin'))
      : await handleAdmin(await callerId(req), body, paymentDeps('fetch-v2-admin'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-admin]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

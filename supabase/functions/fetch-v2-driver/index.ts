import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { handleDriverAction } from '../_shared/fetch-v2-payments.ts';

/**
 * fetch-v2-driver — the assigned driver refreshes the hold before collecting, releases the job, agrees to a cancellation
 * (void + retire), or delivers (capture what is owed, then record delivery).
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Logic lives in _shared/fetch-v2-payments.ts; this file only wires it.
 * Clients send identifiers and choices; every amount, account and intent comes from the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleDriverAction(await callerId(req), await req.json().catch(() => ({})), paymentDeps('fetch-v2-driver'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-driver]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

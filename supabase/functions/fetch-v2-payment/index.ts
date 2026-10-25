import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { handleRequesterPayment } from '../_shared/fetch-v2-payments.ts';

/**
 * fetch-v2-payment — the requester completes a hold Stripe could not finish on its own (3DS or a new card) or refreshes its state.
 * Returns a client_secret only to the requester, only for their own job's current intent.
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Logic lives in _shared/fetch-v2-payments.ts; this file only wires it.
 * Clients send identifiers and choices; every amount, account and intent comes from the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleRequesterPayment(await callerId(req), await req.json().catch(() => ({})), paymentDeps('fetch-v2-payment'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-payment]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

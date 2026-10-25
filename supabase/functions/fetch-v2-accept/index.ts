import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { handleAccept } from '../_shared/fetch-v2-payments.ts';

/**
 * fetch-v2-accept — a driver accepts a Fetch v2 job: eligibility, self-payment guard, race-safe claim, then the manual-capture card hold
 * from the frozen terms on the driver's Connect account.
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Logic lives in _shared/fetch-v2-payments.ts; this file only wires it.
 * Clients send identifiers and choices; every amount, account and intent comes from the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleAccept(await callerId(req), await req.json().catch(() => ({})), paymentDeps('fetch-v2-accept'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-accept]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

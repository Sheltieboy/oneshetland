import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json, paymentDeps } from '../_shared/fetch-v2-payment-deps.ts';
import { handleAdmin } from '../_shared/fetch-v2-payments.ts';

/**
 * fetch-v2-admin — administrator payment actions: cancel, return to board, resolve a cancellation or a return (capture or void),
 * retry a capture, void a stuck hold, reconcile with Stripe. Every action is audited by the database.
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 5). Logic lives in _shared/fetch-v2-payments.ts; this file only wires it.
 * Clients send identifiers and choices; every amount, account and intent comes from the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleAdmin(await callerId(req), await req.json().catch(() => ({})), paymentDeps('fetch-v2-admin'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-admin]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

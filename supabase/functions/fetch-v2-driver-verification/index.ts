import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json } from '../_shared/fetch-v2-payment-deps.ts';
import { verificationDeps } from '../_shared/fetch-v2-verification-deps.ts';
import { handleDriverVerification } from '../_shared/fetch-v2-verification.ts';

/**
 * fetch-v2-driver-verification — a driver's own verification: their status, their vehicle, and handing in evidence
 * (begin_upload → signed upload to a server-chosen path → submit, which checks the stored file's real size and type), plus a
 * short-lived link to their own document. Nothing here can approve anything.
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 6). Logic lives in _shared/fetch-v2-verification.ts; this file only wires it.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handleDriverVerification(await callerId(req), await req.json().catch(() => ({})), verificationDeps('fetch-v2-driver-verification'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-driver-verification]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

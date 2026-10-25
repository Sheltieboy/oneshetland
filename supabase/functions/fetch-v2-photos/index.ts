import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { callerId, corsHeaders, json } from '../_shared/fetch-v2-payment-deps.ts';
import { photoDeps } from '../_shared/fetch-v2-photo-deps.ts';
import { handlePhotos } from '../_shared/fetch-v2-photos.ts';

/**
 * fetch-v2-photos — a member's Fetch photos: begin a signed upload (item, collection, delivery, return or issue evidence, as the job
 * and the member's role allow), submit it (real type checked, metadata removed), or get a 60-second link to a photo they may see.
 * (docs/FETCH_V2_IMPLEMENTATION.md, Step 9). Logic lives in _shared/fetch-v2-photos.ts; this file only wires it.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const out = await handlePhotos(await callerId(req), await req.json().catch(() => ({})), photoDeps('fetch-v2-photos'));
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-photos]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

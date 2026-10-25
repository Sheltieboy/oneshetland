import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { googleGeocoder } from '../_shared/fetch-v2-geocode.ts';
import { handleQuote, type IntakeDeps } from '../_shared/fetch-v2-intake.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * fetch-v2-quote — what a Fetch v2 job would cost, before anyone commits (docs/FETCH_V2_IMPLEMENTATION.md, Step 4).
 *
 * Member-only, Fetch v2 flag, 18+, rate-limited per member before any (billed) geocode. The two ends are geocoded here with the
 * server key; the price, ferry and hold come from the database (fetch_v2_quote → fetch_v2_price). Writes nothing.
 * The legacy fetch-quote stays as it is for v1.
 *
 * Env: GOOGLE_GEOCODING_API_KEY (server-only)
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader ?? '' } } });
    const { data: { user } } = authHeader ? await anon.auth.getUser() : { data: { user: null } };
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const deps: IntakeDeps = {
      rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
      geocode: googleGeocoder(Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? '', (u) => fetch(u)),
      cardCheck: () => Promise.resolve('card_check_failed' as const),   // not used by quotes
      limit: async (userId, actions) => !('denied' in await enforceRateLimit('fetch-v2-quote', userSubject(userId), actions, corsHeaders)),
    };
    const out = await handleQuote(user?.id ?? null, await req.json().catch(() => ({})), deps);
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-quote]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

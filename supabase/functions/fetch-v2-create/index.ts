import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { chargeableCardFor } from '../_shared/saved-card.ts';
import { googleGeocoder } from '../_shared/fetch-v2-geocode.ts';
import { handleCreate, makeCardCheck, type IntakeDeps } from '../_shared/fetch-v2-intake.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * fetch-v2-create — commit a Fetch v2 request (docs/FETCH_V2_IMPLEMENTATION.md, Step 4).
 *
 * Member-only, Fetch v2 flag, 18+ and not restricted, rate-limited, and only with a chargeable card already on file (read-only check
 * against the member's existing Stripe Customer: nothing is created at Stripe and no card data is stored by Fetch). The two ends are
 * geocoded here; fetch_v2_create_request validates, prices, freezes the terms and creates the job in one transaction, idempotently on
 * the client's key. Only a shaped answer is returned.
 *
 * Env: GOOGLE_GEOCODING_API_KEY, STRIPE_SECRET_KEY (server-only)
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader ?? '' } } });
    const { data: { user } } = authHeader ? await anon.auth.getUser() : { data: { user: null } };
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

    const deps: IntakeDeps = {
      rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
      geocode: googleGeocoder(Deno.env.get('GOOGLE_GEOCODING_API_KEY') ?? '', (u) => fetch(u)),
      cardCheck: makeCardCheck({
        customerIdFor: async (userId) => {
          const { data, error } = await svc.from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle();
          if (error) throw new Error('profile lookup failed');
          return (data?.stripe_customer_id as string | null) ?? null;
        },
        chargeableCard: (customerId) => {
          if (!stripeKey) throw new Error('payments not configured');
          return chargeableCardFor(stripeKey, customerId);
        },
      }),
      limit: async (userId, actions) => !('denied' in await enforceRateLimit('fetch-v2-create', userSubject(userId), actions, corsHeaders)),
    };
    const out = await handleCreate(user?.id ?? null, await req.json().catch(() => ({})), deps);
    return json(out.body, out.status);
  } catch (err) {
    console.error('[fetch-v2-create]', err instanceof Error ? err.name : 'error');
    return json({ ok: false, code: 'server_error', error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

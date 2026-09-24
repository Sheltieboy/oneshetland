import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { resolveSavedCard } from '../_shared/saved-card-state.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * saved-card-state — does the caller actually have a usable saved card?
 *
 * READ-ONLY. No Stripe write, no Customer created or claimed, no profile edit,
 * no email search. It answers from the caller's own bound Customer and what
 * Stripe says is attached to it (see _shared/saved-card-state.ts), so a checkout
 * never has to trust profiles.has_payment_method.
 *
 * Body: none.
 * Returns exactly one of:
 *   { state: 'card', brand, last4 }
 *   { state: 'none', reason: 'no_customer' | 'no_card' }
 *   { state: 'unknown' }                 — Stripe could not be asked; NOT "none"
 *
 * Only brand and last4 are ever returned. The Customer id and payment-method id
 * stay on the server.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    // Each call reads Stripe, so it shares the ordinary Stripe ceiling.
    const limited = await enforceRateLimit('saved-card-state', userSubject(user.id), ['stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const found = await resolveSavedCard({ supabase: svc, stripeKey, userId: user.id });

    if (found.kind === 'card') return json({ state: 'card', brand: found.brand, last4: found.last4 });
    if (found.kind === 'none') return json({ state: 'none', reason: found.reason });
    return json({ state: 'unknown' });
  } catch (err) {
    console.error('[saved-card-state]', err);
    return json({ error: safeError('saved-card-state', err) }, 500);
  }
});

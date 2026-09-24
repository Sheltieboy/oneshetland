import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { safeError } from '../_shared/safe-error.ts';
import {
  reconcileSavedCard, reconcileCandidates, type ReconcileOutcome,
} from '../_shared/saved-card-reconcile.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

/**
 * reconcile-saved-cards — make profiles.has_payment_method match Stripe.
 *
 * Scheduled by pg_cron (and runnable once by hand from the database) through
 * pg_net with the shared `x-cron-secret`, exactly like the other scheduled
 * functions: deployed verify_jwt=false, and the secret check is the whole
 * boundary. It fails CLOSED — no server secret is a 503, a bad header a 401 —
 * and nothing privileged happens above that check.
 *
 * Body (all optional): { dry_run?: boolean }
 *   dry_run: true  → decide and report, write nothing.
 *
 * Returns counts and one masked line per profile (first 8 characters of the id,
 * what was found, what was done). No customer id, payment-method id, email or
 * card detail is ever returned or logged.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

    let dryRun = false;
    try { dryRun = (await req.json())?.dry_run === true; } catch { /* no body */ }

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const ids = await reconcileCandidates(svc);

    // One at a time: the set is small, and Stripe's rate limits are not ours to spend.
    const results: ReconcileOutcome[] = [];
    for (const id of ids) results.push(await reconcileSavedCard({ supabase: svc, stripeKey, userId: id, dryRun }));

    const counts: Record<string, number> = {};
    for (const r of results) counts[r.action] = (counts[r.action] ?? 0) + 1;

    return json({ dry_run: dryRun, checked: results.length, counts, results });
  } catch (err) {
    console.error('[reconcile-saved-cards]', err);
    return json({ error: safeError('reconcile-saved-cards', err) }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-billing-portal
 *
 * Creates a Stripe Customer Portal session for the business owner. The
 * customer portal is a Stripe-hosted page where the user can:
 *   • Cancel the subscription (cancel_at_period_end = true)
 *   • Re-activate a pending cancellation
 *   • Update the payment method
 *   • View invoice history
 *   • Switch plans (if multiple plans are enabled in the portal config)
 *
 * The app opens the returned URL in the system browser. When the user
 * makes changes, Stripe fires subscription / invoice webhooks back to
 * our stripe-webhook function, which updates the DB.
 *
 * Body: { business_id: string }
 * Returns: { url: string }
 *
 * Prerequisites:
 *   - Customer Portal must be enabled in Stripe Dashboard:
 *     https://dashboard.stripe.com/settings/billing/portal
 *   - Test mode + Live mode must be configured separately
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { business_id } = await req.json();
    if (!business_id) return json({ error: 'business_id required' }, 400);

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, stripe_customer_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!business.stripe_customer_id) {
      return json({ error: 'This business has no Stripe customer yet. Subscribe first to access billing.' }, 400);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const session = await stripe.billingPortal.sessions.create({
      customer:   business.stripe_customer_id,
      return_url: 'oneshetland-fetch://billing-return',
    });

    return json({ url: session.url });

  } catch (err) {
    console.error('[local-billing-portal]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@13?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-business-onboard
 *
 * Creates a Stripe Connect Express account for the business (if not already)
 * and returns an onboarding link the business owner opens in a browser.
 * After onboarding, Stripe redirects back via the existing connect-redirect function
 * which sets payout_enabled = true.
 *
 * Body: { business_id: string }
 * Returns: { url: string, account_id: string }
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
      .select('id, owner_id, name, email, stripe_account_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    let accountId = business.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'GB',
        email: business.email ?? undefined,
        business_profile: { name: business.name },
        capabilities: { transfers: { requested: true } },
        metadata: { business_id, owner_id: user.id, type: 'local_business' },
      });
      accountId = account.id;
      await svc
        .from('local_businesses')
        .update({ stripe_account_id: accountId })
        .eq('id', business_id);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${supabaseUrl}/functions/v1/connect-redirect?retry=1&business=${business_id}`,
      return_url:  `${supabaseUrl}/functions/v1/connect-redirect?ok=1&business=${business_id}`,
      type: 'account_onboarding',
    });

    return json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    console.error('[local-business-onboard]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

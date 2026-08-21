import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

function stripePostHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
async function stripePost(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST', headers: stripePostHeaders(), body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe ${path} failed (HTTP ${res.status})`);
  return json;
}

/**
 * hub-onboard
 *
 * Creates a Stripe Connect Express account for a HUB (the organisation's own
 * account, so membership money is destination-charged straight to them and the
 * platform only ever keeps the application fee). Returns an onboarding link.
 * Owner-only. payout_enabled is flipped by the stripe-webhook account.updated
 * handler once Stripe confirms the account can receive payouts.
 *
 * Body: { hub_id: string }
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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('hub-onboard', userSubject(user.id), ['stripe_account', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { hub_id, web_return_url } = await req.json();
    if (!hub_id) return json({ error: 'hub_id required' }, 400);

    const { data: hub } = await svc
      .from('hubs')
      .select('id, owner_id, name, contact_email, stripe_account_id, is_active')
      .eq('id', hub_id)
      .single();

    // Owner-only (payouts are financial — committee can't onboard).
    if (!hub || hub.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!hub.is_active) return json({ error: 'Hub is not active' }, 403);

    let accountId = hub.stripe_account_id;
    if (!accountId) {
      const accountParams: Record<string, string> = {
        type:                                 'express',
        country:                              'GB',
        'business_profile[name]':             hub.name,
        'capabilities[transfers][requested]': 'true',
        'metadata[hub_id]':                   hub_id,
        'metadata[owner_id]':                 user.id,
        'metadata[type]':                     'hub',
      };
      if (hub.contact_email) accountParams.email = hub.contact_email;

      const account = await stripePost('accounts', accountParams);
      accountId = account.id;
      await svc.from('hubs').update({ stripe_account_id: accountId }).eq('id', hub_id);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const returnUrl  = web_return_url ? `${web_return_url}?connected=1` : `${supabaseUrl}/functions/v1/connect-redirect?ok=1&hub=${hub_id}`;
    const refreshUrl = web_return_url ? `${web_return_url}?retry=1`     : `${supabaseUrl}/functions/v1/connect-redirect?retry=1&hub=${hub_id}`;
    const accountLink = await stripePost('account_links', {
      account:     accountId,
      refresh_url: refreshUrl,
      return_url:  returnUrl,
      type:        'account_onboarding',
    });

    return json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    console.error('[hub-onboard]', err);
    return json({ error: safeError('hub-onboard', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

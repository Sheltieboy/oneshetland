import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE = 'https://api.stripe.com/v1';

/**
 * create-connect-account
 *
 * Onboards (or resumes onboarding of) the caller's Stripe Connect Express
 * account — the account that receives Fetch driving payouts.
 *
 * IMPORTANT: the account id + status is written to BOTH profiles (the webhook's
 * source of truth, which the web /account/payments page reads) AND
 * driver_profiles (which the Fetch charge path — authorise-payment — reads).
 * Previously it wrote driver_profiles only, so the web page read profiles, never
 * saw the account, showed "Not connected" forever, and the button dead-ended:
 * driver_profiles said "onboarding complete" → already_complete → a bare refresh.
 *
 * The writes use the service role because profiles.stripe_* columns are locked
 * against client-context updates. Status is read live from Stripe rather than
 * trusting possibly-stale DB flags, and "already connected" is gated on
 * payouts_enabled (the real can-be-paid signal), not just details_submitted.
 *
 * Returns: { already_complete: true, ... }  when payouts are enabled, else
 *          { url }  — a fresh Stripe onboarding link to finish/fix setup.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anon.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorised' }, 401);

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-connect-account', userSubject(user.id), ['stripe_account', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);
    const sHeaders = { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' };

    // Resolve an existing Connect account — profiles first, then driver_profiles
    // (covers drivers who onboarded before profiles became the source of truth).
    const [{ data: prof }, { data: drv }] = await Promise.all([
      svc.from('profiles').select('stripe_account_id').eq('id', user.id).maybeSingle(),
      svc.from('driver_profiles').select('stripe_account_id').eq('id', user.id).maybeSingle(),
    ]);
    let accountId: string = prof?.stripe_account_id || drv?.stripe_account_id || '';

    // Create a new Express account if there isn't one yet.
    if (!accountId) {
      const accountRes = await fetch(`${STRIPE}/accounts`, {
        method: 'POST',
        headers: { ...sHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          type: 'express',
          country: 'GB',
          email: user.email ?? '',
          'capabilities[transfers][requested]': 'true',
          'business_type': 'individual',
          'individual[email]': user.email ?? '',
          'business_profile[product_description]': 'Community member picking up and delivering items for neighbours on the OneShetland platform',
          'metadata[supabase_user_id]': user.id,
        }),
      });
      const account = await accountRes.json();
      if (!accountRes.ok) throw new Error(`Connect account creation failed: ${account.error?.message}`);
      accountId = account.id;
    }

    // Read the live account status from Stripe (don't trust stale DB flags).
    const acctRes = await fetch(`${STRIPE}/accounts/${accountId}`, { headers: sHeaders });
    const acct = await acctRes.json();
    if (!acctRes.ok) throw new Error(`Stripe account lookup failed: ${acct.error?.message}`);
    const detailsSubmitted = !!acct.details_submitted;
    const payoutsEnabled = !!acct.payouts_enabled;
    const chargesEnabled = !!acct.charges_enabled;

    // Persist id + live status to BOTH tables so the web (profiles) and the
    // Fetch charge path (driver_profiles) agree. driver_profiles update is a
    // no-op for non-drivers (no row) — that's fine.
    const flags = {
      stripe_account_id: accountId,
      stripe_onboarding_complete: detailsSubmitted,
      stripe_payouts_enabled: payoutsEnabled,
      stripe_charges_enabled: chargesEnabled,
    };
    await Promise.all([
      svc.from('profiles').update(flags).eq('id', user.id),
      svc.from('driver_profiles').update(flags).eq('id', user.id),
    ]);

    // Genuinely payouts-ready → nothing more to do.
    if (payoutsEnabled) {
      return json({ already_complete: true, stripe_account_id: accountId, payouts_enabled: true });
    }

    // Otherwise hand back a fresh onboarding link to finish (or fix) setup.
    const linkRes = await fetch(`${STRIPE}/account_links`, {
      method: 'POST',
      headers: { ...sHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        account: accountId,
        refresh_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/connect-redirect?status=refresh`,
        return_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/connect-redirect?status=return`,
        type: 'account_onboarding',
      }),
    });
    const link = await linkRes.json();
    if (!linkRes.ok) throw new Error(`Account link creation failed: ${link.error?.message}`);

    return json({ url: link.url, stripe_account_id: accountId });
  } catch (err) {
    console.error('[create-connect-account]', err);
    return json({ error: safeError('create-connect-account', err) }, 500);
  }
});

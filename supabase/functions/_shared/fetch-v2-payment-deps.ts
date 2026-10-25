/**
 * fetch-v2-payment-deps.ts — the production wiring for fetch-v2-payments.ts (Deno only). Tests inject their own.
 *
 * Service-role database client, the Stripe gateway (STRIPE_SECRET_KEY), the requester's canonical Customer and chargeable card
 * (read-only: profiles.stripe_customer_id + chargeableCardFor), the driver's Connect account (driver_profiles), the admin check and the
 * shared rate limiter. Nothing here is client-supplied.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceRateLimit, userSubject } from './rate-limit.ts';
import { chargeableCardFor } from './saved-card.ts';
import { stripeGateway } from './fetch-v2-stripe.ts';
import type { PaymentDeps } from './fetch-v2-payments.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export async function callerId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await anon.auth.getUser();
  return user?.id ?? null;
}

export function paymentDeps(scope: string): PaymentDeps {
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  return {
    rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
    stripe: stripeGateway(stripeKey, (url, init) => fetch(url, init)),
    customerCard: async (userId) => {
      const { data, error } = await svc.from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle();
      if (error) throw new Error('profile lookup failed');
      const customerId = (data?.stripe_customer_id as string | null) ?? null;
      if (!customerId) return null;
      return { customerId, paymentMethodId: await chargeableCardFor(stripeKey, customerId) };
    },
    driverAccount: async (driverId) => {
      const { data, error } = await svc.from('driver_profiles').select('stripe_account_id, stripe_payouts_enabled').eq('id', driverId).maybeSingle();
      if (error) throw new Error('driver lookup failed');
      return { accountId: (data?.stripe_account_id as string | null) ?? null, payoutsEnabled: data?.stripe_payouts_enabled === true };
    },
    isAdmin: async (userId) => {
      const { data } = await svc.from('profiles').select('role').eq('id', userId).maybeSingle();
      return data?.role === 'admin';
    },
    limit: async (userId, actions) => !('denied' in await enforceRateLimit(scope, userSubject(userId), actions, corsHeaders)),
  };
}

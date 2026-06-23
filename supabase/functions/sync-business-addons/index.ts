import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { getConfig } from '../_shared/admin-config.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * sync-business-addons
 *
 * Keeps a business's monthly subscription in line with its enabled premium
 * add-ons. Premium includes ONE premium add-on; each additional premium add-on
 * is £10/mo, billed as a single recurring line item (quantity = number of
 * extras) on the SAME subscription as the tier — so the customer sees one
 * monthly total of £49.99 + £10 × extras.
 *
 * Call this after any add-on toggle. No-ops unless the business is on a paid
 * monthly Premium subscription (extras can't be billed on Free/Pro/Boost).
 *
 * Config: stripe.price.local_addon  (admin_config) or env STRIPE_PRICE_LOCAL_ADDON
 *   — the £10/mo recurring Price for the add-on product.
 *
 * Body: { business_id: string }
 * Returns: { extras: number, billed: boolean }
 */
const PREMIUM_ADDON_KEYS = ['bookings', 'services', 'events', 'membership', 'products'];

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

    const { business_id } = await req.json().catch(() => ({}));
    if (!business_id) return json({ error: 'business_id required' }, 400);

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, subscription_tier, stripe_subscription_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // Count enabled premium add-ons → extras beyond the one included.
    const { data: addons } = await svc
      .from('business_addons')
      .select('addon_key, enabled')
      .eq('business_id', business_id)
      .eq('enabled', true)
      .in('addon_key', PREMIUM_ADDON_KEYS);
    const extras = Math.max(0, (addons?.length ?? 0) - 1);

    // Extras are only billable on a live monthly Premium subscription.
    if (business.subscription_tier !== 'premium' || !business.stripe_subscription_id) {
      return json({ extras, billed: false });
    }

    const addonPrice = await getConfig(svc, 'stripe.price.local_addon', Deno.env.get('STRIPE_PRICE_LOCAL_ADDON') ?? null);
    if (!addonPrice) {
      return json({ error: 'Add-on price not configured. Set stripe.price.local_addon in Admin → Config.' }, 500);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const sub = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
    const existing = sub.items.data.find((i) => i.price.id === addonPrice);

    if (extras > 0) {
      if (existing) {
        if (existing.quantity !== extras) {
          await stripe.subscriptionItems.update(existing.id, { quantity: extras, proration_behavior: 'create_prorations' });
        }
      } else {
        await stripe.subscriptionItems.create({ subscription: sub.id, price: addonPrice, quantity: extras, proration_behavior: 'create_prorations' });
      }
    } else if (existing) {
      await stripe.subscriptionItems.del(existing.id, { proration_behavior: 'create_prorations' });
    }

    return json({ extras, billed: true });
  } catch (err) {
    console.error('[sync-business-addons]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

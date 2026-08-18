import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-subscription-cancel
 *
 * Cancels a business subscription — or takes a pending cancellation back.
 *
 * AT PERIOD END, NOT IMMEDIATELY. Every plan email says "no notice period, you
 * keep what you have paid for until the end of the month you have already paid",
 * and cancelling on the spot would make that a lie while also deleting the
 * listing features somebody has already paid for. Stripe's own portal does the
 * same, so this matches what a business would expect anyway.
 *
 * Undo matters as much as cancel. People cancel in a bad moment and want back in
 * ten minutes later; without this they would have to re-subscribe, which means a
 * fresh charge and a lost renewal date.
 *
 * Body: { business_id: string, resume?: boolean }
 * Returns: { ok: true, cancel_at_period_end: boolean, ends_at: string | null }
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

    const { business_id, resume = false } = await req.json();
    if (!business_id) return json({ error: 'business_id required' }, 400);

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, stripe_subscription_id, subscription_tier')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!business.stripe_subscription_id) {
      return json({ error: 'There is no subscription to change.', code: 'NO_SUBSCRIPTION' }, 409);
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Confirm the subscription is really live before touching it. A cancelled
    // one leaves its id behind on the row, and telling somebody we had cancelled
    // something that was already gone would be worse than an error.
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
    } catch {
      return json({ error: 'That subscription no longer exists at Stripe.', code: 'NO_SUBSCRIPTION' }, 409);
    }
    if (['canceled', 'incomplete_expired'].includes(sub.status)) {
      return json({ error: 'That subscription has already ended.', code: 'NO_SUBSCRIPTION' }, 409);
    }

    const updated = await stripe.subscriptions.update(business.stripe_subscription_id, {
      cancel_at_period_end: !resume,
    });

    // current_period_end moved onto the subscription ITEM in newer API versions,
    // so check both. Written out longhand because the compact version parsed as
    // `(a ?? b) ? c : d` and took the item's value even when the top-level one
    // was present.
    const topLevelEnd = (updated as unknown as { current_period_end?: number }).current_period_end;
    const itemEnd = updated.items?.data
      ?.map(i => (i as unknown as { current_period_end?: number }).current_period_end)
      .find(v => typeof v === 'number');
    const endSec = typeof topLevelEnd === 'number' ? topLevelEnd : itemEnd;
    const endsAt = typeof endSec === 'number' ? new Date(endSec * 1000).toISOString() : null;

    // Write it locally too. The webhook will confirm the same thing shortly, but
    // the owner is looking at the screen NOW and needs it to say what they just
    // did rather than waiting on a round trip through Stripe.
    await svc.from('local_businesses')
      .update({
        subscription_cancel_at_period_end: !resume,
        ...(endsAt ? { subscription_until: endsAt } : {}),
      })
      .eq('id', business_id);

    return json({ ok: true, cancel_at_period_end: !resume, ends_at: endsAt });
  } catch (err) {
    console.error('[local-subscription-cancel]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

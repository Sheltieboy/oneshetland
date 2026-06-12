import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-hub-membership
 *
 * After the membership PaymentIntent succeeds, verify it with Stripe and
 * activate (or renew) the membership via the activate_hub_membership RPC.
 * Idempotent on the payment_intent_id — calling twice won't double-extend.
 *
 * Body: { payment_intent_id: string }
 * Returns: { ok: true, member_no, paid_until }
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
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { payment_intent_id } = await req.json();
    if (!payment_intent_id) return json({ error: 'payment_intent_id required' }, 400);

    // Idempotency — already activated for this PI?
    const { data: existing } = await svc
      .from('hub_members')
      .select('id, member_no, paid_until')
      .eq('stripe_payment_intent_id', payment_intent_id)
      .maybeSingle();
    if (existing) {
      return json({ ok: true, member_no: existing.member_no, paid_until: existing.paid_until });
    }

    // Verify the PaymentIntent with Stripe
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
    );
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? `Stripe retrieve failed (HTTP ${piRes.status})`);

    if (pi.metadata?.type !== 'hub_membership') return json({ error: 'Not a membership payment' }, 400);
    if (pi.metadata?.user_id !== user.id)        return json({ error: 'Forbidden' }, 403);
    if (pi.status !== 'succeeded')               return json({ error: 'Payment not completed' }, 402);

    const { data: result, error: rpcErr } = await svc.rpc('activate_hub_membership', {
      p_hub:           pi.metadata.hub_id,
      p_user:          user.id,
      p_type:          pi.metadata.membership_type_id,
      p_period:        pi.metadata.period,
      p_payment_pence: parseInt(pi.metadata.face_pence ?? '0', 10) || 0,
      p_pi:            payment_intent_id,
    });
    if (rpcErr) throw rpcErr;

    // Fire-and-forget: notify hub admins of the new paying member.
    svc.functions.invoke('notify-hub', { body: { event: 'membership_paid', hub_id: pi.metadata.hub_id, user_id: user.id } }).catch(() => {});

    return json({ ok: true, member_no: result?.member_no, paid_until: result?.paid_until });
  } catch (err) {
    console.error('[confirm-hub-membership]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-hub-donation
 *
 * The fast answer for a donor watching the screen. Verifies the PaymentIntent,
 * then hands off to the SAME attempt-driven fulfilment the Stripe webhook uses,
 * so the donation lands once with the donor's real choices whichever arrives
 * first — and lands at all if this call never happens.
 *
 * The donor's anonymity, message and Gift Aid are NOT taken from this request.
 * They were validated and stored when the donation attempt was created, before
 * the payment existed.
 *
 * Body: { payment_intent_id }
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

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { payment_intent_id } = await req.json();
    if (!payment_intent_id) return json({ error: 'payment_intent_id required' }, 400);

    // Already recorded?
    const { data: existing } = await svc.from('hub_donations').select('id')
      .eq('stripe_payment_intent_id', payment_intent_id).maybeSingle();
    if (existing) return json({ ok: true, already: true });

    const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } });
    const pi = await piRes.json();
    if (!piRes.ok) {
      // A payment intent that does not exist is a bad request, not a server
      // fault. It used to throw and answer 500.
      if (piRes.status === 404) return json({ error: 'Payment not found' }, 404);
      throw new Error(pi.error?.message ?? `Stripe retrieve failed (HTTP ${piRes.status})`);
    }

    if (pi.metadata?.type !== 'hub_donation') return json({ error: 'Not a donation payment' }, 400);
    if (pi.metadata?.user_id !== user.id)      return json({ error: 'Forbidden' }, 403);
    if (pi.status !== 'succeeded')             return json({ error: 'Payment not completed' }, 402);

    // The donor's choices come from the attempt written before the payment, not
    // from this request — so the webhook and this call record the SAME donation
    // and neither can lose the donor's anonymity by winning the race.
    const { data: res, error: rpcErr } = await svc
      .rpc('fulfil_hub_donation', {
        p_pi: payment_intent_id,
        p_attempt: pi.metadata.attempt_id ?? null,
        p_user: user.id,
      })
      .maybeSingle();
    if (rpcErr) throw rpcErr;
    const out = res as { recorded: boolean; already: boolean; reason: string } | null;
    if (!out?.recorded && !out?.already) {
      return json({ error: 'This donation could not be recorded.', reason: out?.reason ?? 'unknown' }, 409);
    }
    if (out.already) return json({ ok: true, already: true });

    const { data: hub } = await svc.from('hubs').select('name').eq('id', pi.metadata.hub_id).maybeSingle();
    const { data: recorded } = await svc.from('hub_donations')
      .select('is_anonymous').eq('stripe_payment_intent_id', payment_intent_id).maybeSingle();
    const anonymous = !!recorded?.is_anonymous;

    // ── Notifications (best-effort — never fail the recorded donation) ───────
    try {
      const hubName = hub?.name ?? 'the hub';
      const pence   = parseInt(pi.metadata.face_pence ?? '0', 10) || 0;
      const amount  = `£${(pence / 100).toFixed(2)}`;

      // Donor receipt.
      await sendUserPush(svc, {
        userId: user.id, module: 'hubs', categoryId: 'hubs.donation_receipt',
        title: 'Thank you for your donation 💚',
        body: `Your ${amount} donation to ${hubName} has gone through.`,
        data: { hub_id: pi.metadata.hub_id },
      });

      // Hub admins (owner + committee). Respect anonymity — name the donor only
      // when they didn't tick anonymous.
      let donorName = 'An anonymous supporter';
      if (!anonymous) {
        const { data: donor } = await svc.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
        donorName = (donor as { full_name?: string } | null)?.full_name ?? 'A supporter';
      }
      const { data: admins } = await svc
        .from('hub_members').select('user_id')
        .eq('hub_id', pi.metadata.hub_id).in('role', ['owner', 'committee']).eq('status', 'active');
      const adminIds = [...new Set((admins ?? []).map(a => a.user_id).filter(Boolean) as string[])];
      await sendUserPushBulk(svc, adminIds, {
        module: 'hubs', categoryId: 'hubs.donation_received',
        title: 'New donation 💚',
        body: `${donorName} donated ${amount} to ${hubName}.`,
        data: { hub_id: pi.metadata.hub_id },
      });
    } catch (notifyErr) {
      console.error('[confirm-hub-donation] notify failed (non-fatal):', notifyErr);
    }

    return json({ ok: true, already: false });
  } catch (err) {
    console.error('[confirm-hub-donation]', err);
    return json({ error: safeError('confirm-hub-donation', err) }, 500);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-business-claim
 *
 * Fire-and-forget: when a user claims a business listing, alert the admins so
 * they can review it (the app calls approve_business_claim later). Previously
 * the app invoked this function but it didn't exist, so claims were never
 * surfaced to anyone.
 *
 * Body: { claim_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // This function had no caller check. verify_jwt is satisfied by the public
    // anon key, so anyone could send a business-claim notice to real people, in
    // someone else's name, with no account. Same fix as the Step 14 fan-outs.
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    // Our own backend invokes this with the service key; that is not internet
    // traffic and is not throttled.
    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('notify-business-claim', userSubject(caller.userId), ['notify_direct', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    const { claim_id } = await req.json();
    if (!claim_id) return json({ error: 'claim_id required' }, 400);

    const svc = createServiceClient();

    const { data: claim } = await svc
      .from('business_claims')
      .select('id, business_id, contact_name')
      .eq('id', claim_id)
      .maybeSingle();
    if (!claim) return json({ error: 'Claim not found' }, 404);

    const { data: biz } = await svc
      .from('local_businesses')
      .select('name')
      .eq('id', claim.business_id)
      .maybeSingle();
    const bizName = biz?.name ?? 'a business';

    // Push every admin who has a device token. Raw push — admin alerts shouldn't
    // be muted by per-module quiet hours.
    const { data: admins } = await svc
      .from('profiles')
      .select('push_token')
      .eq('role', 'admin')
      .not('push_token', 'is', null);

    let notified = 0;
    for (const a of (admins ?? []) as { push_token: string | null }[]) {
      if (!a.push_token) continue;
      await sendPush(
        a.push_token,
        'New business claim',
        `${claim.contact_name ?? 'Someone'} claimed "${bizName}". Tap to review.`,
        { kind: 'business_claim', claim_id, business_id: claim.business_id },
        'admin.business_claim',
      ).catch(() => {});
      notified++;
    }

    return json({ ok: true, notified });
  } catch (err) {
    console.error('[notify-business-claim]', err);
    return json({ error: safeError('notify-business-claim', err) }, 500);
  }
});

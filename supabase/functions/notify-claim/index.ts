import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';

/**
 * notify-claim
 *
 * Tells someone who claimed a Directory listing whether it was approved or
 * rejected (previously they were never told the outcome).
 *
 * Body: { claim_id: string, outcome: 'approved' | 'rejected' }
 * Module 'business' (it's about managing your own listing).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { claim_id, outcome } = await req.json();
    if (!claim_id || !outcome) return json({ error: 'claim_id and outcome required' }, 400);
    const svc = createServiceClient();

    const { data: claim } = await svc
      .from('business_claims').select('user_id, business_id').eq('id', claim_id).maybeSingle();
    if (!claim?.user_id) return json({ error: 'claim not found' }, 404);

    const { data: biz } = await svc
      .from('local_businesses').select('name').eq('id', claim.business_id).maybeSingle();
    const name = (biz as { name?: string } | null)?.name ?? 'your business';

    const approved = outcome === 'approved';
    await sendUserPush(svc, {
      userId:     claim.user_id,
      module:     'business',
      categoryId: approved ? 'business.claim_approved' : 'business.claim_rejected',
      title:      approved ? "You're verified ✅" : 'Claim update',
      body:       approved
        ? `Your claim for ${name} was approved — you can now manage your listing.`
        : `Your claim for ${name} wasn't approved this time. Get in touch if you think this is a mistake.`,
      data:       { business_id: claim.business_id },
    });
    return json({ ok: true, notified: 1 });
  } catch (err) {
    console.error('[notify-claim]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

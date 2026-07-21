import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-redeem-verify
 *
 * Staff (the business owner's session) confirm a customer's redemption by its
 * short code or QR token. Verifies it belongs to a business the caller owns and
 * is still pending, then APPLIES the effect and marks it consumed — this is the
 * moment the offer/reward/pass/points actually count. Proof of presence: no
 * effect happens without staff acting.
 *
 * Body: { code?: string, token?: string }
 * Returns: { ok, kind, detail }
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

    const { code, token } = await req.json();
    if (!code && !token) return json({ error: 'code or token required' }, 400);

    // Businesses this staff/owner controls.
    const { data: biz } = await svc.from('local_businesses').select('id').eq('owner_id', user.id);
    const bizIds = (biz ?? []).map((b: { id: string }) => b.id);
    if (bizIds.length === 0) return json({ error: 'You do not run a business' }, 403);

    let q = svc.from('local_redemptions').select('*').eq('status', 'pending').in('business_id', bizIds).gt('expires_at', new Date().toISOString());
    q = token ? q.eq('token', token) : q.eq('code', String(code).toUpperCase().trim());
    const { data: red } = await q.maybeSingle();
    if (!red) return json({ error: 'Code not found, already used, or expired' }, 404);

    // Apply the effect for the kind, then mark consumed.
    if (red.kind === 'offer') {
      const { data: offer } = await svc.from('local_offers').select('*').eq('id', red.ref_id).single();
      if (!offer || !offer.is_active) return json({ error: 'Offer no longer active' }, 410);
      const { error: insErr } = await svc.from('local_offer_redemptions').insert({ offer_id: red.ref_id, user_id: red.user_id });
      if (insErr && insErr.code === '23505') { await cancel(svc, red.id); return json({ error: 'Already redeemed' }, 409); }
      if (insErr) return json({ error: insErr.message }, 500);
      await svc.from('local_offers').update({ redemption_count: (offer.redemption_count ?? 0) + 1 }).eq('id', red.ref_id);
    } else if (red.kind === 'reward') {
      const { data: card } = await svc.from('local_loyalty_cards').select('*').eq('id', red.ref_id).single();
      const { data: program } = card ? await svc.from('local_loyalty_programs').select('stamps_required').eq('id', card.program_id).single() : { data: null };
      if (!card || !program || card.stamps_collected < (program.stamps_required ?? 999)) {
        return json({ error: 'Card is no longer complete' }, 409);
      }
      // Reset stamps and re-arm the "reward ready" reminder for the next cycle.
      await svc.from('local_loyalty_cards').update({ stamps_collected: 0, total_redeemed: (card.total_redeemed ?? 0) + 1, reward_reminded_at: null }).eq('id', card.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: card.user_id, business_id: card.business_id, type: 'reward', amount: program.stamps_required });
    } else if (red.kind === 'points') {
      const { data: card } = await svc.from('local_loyalty_cards').select('*').eq('id', red.ref_id).single();
      const spend = red.amount ?? 0;
      if (!card || (card.points_balance ?? 0) < spend) return json({ error: 'Not enough points' }, 409);
      await svc.from('local_loyalty_cards').update({ points_balance: (card.points_balance ?? 0) - spend, total_redeemed: (card.total_redeemed ?? 0) + 1 }).eq('id', card.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: card.user_id, business_id: card.business_id, type: 'redeem', amount: spend });
    } else if (red.kind === 'pass') {
      const { data: pass } = await svc.from('book_unit_purchases').select('*').eq('id', red.ref_id).single();
      if (!pass || (pass.uses_remaining ?? 0) <= 0) return json({ error: 'No uses left' }, 409);
      const left = pass.uses_remaining - 1;
      await svc.from('book_unit_purchases').update({ uses_remaining: left, fully_used_at: left === 0 ? new Date().toISOString() : null }).eq('id', pass.id);
    } else {
      return json({ error: 'Unknown redemption kind' }, 400);
    }

    await svc.from('local_redemptions').update({ status: 'consumed', consumed_at: new Date().toISOString(), consumed_by: user.id }).eq('id', red.id);
    return json({ ok: true, kind: red.kind, detail: red.detail });
  } catch (err) {
    console.error('[local-redeem-verify]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

async function cancel(svc: ReturnType<typeof createClient>, id: string) {
  await svc.from('local_redemptions').update({ status: 'cancelled' }).eq('id', id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';

/**
 * loyalty-till — the unified "one member card" till.
 *
 * A business owner/staff scans the customer's ONE permanent member_code and then
 * acts: look up their status, add a stamp, add points, redeem a reward, or apply
 * an offer — all for the caller's own business. Proof-of-presence = staff holding
 * the customer's code, so no rotating per-shop codes are needed.
 *
 * Body: { member_code, business_id?, action, amount_pence?, offer_id? }
 *   action: 'lookup' | 'stamp' | 'points' | 'redeem_reward' | 'redeem_offer'
 * Auth: the business owner's JWT.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

function normalizeTiers(raw: unknown): { stamps: number; reward: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => ({ stamps: Number(t?.stamps), reward: String(t?.reward ?? '') }))
    .filter((t) => Number.isFinite(t.stamps) && t.stamps > 0)
    .sort((a, b) => a.stamps - b.stamps);
}
function offerBadge(o: any): string {
  switch (o?.discount_type) {
    case 'percent': return o.discount_value ? `${o.discount_value}% off` : 'Offer';
    case 'fixed':   return o.discount_value != null ? `£${Number(o.discount_value).toFixed(2)} off` : 'Offer';
    case 'freebie': return 'Freebie';
    case 'bogo':    return '2 for 1';
    default:        return 'Offer';
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { member_code, business_id, action, amount_pence, offer_id } = await req.json();
    if (!member_code || !action) return json({ error: 'member_code and action required' }, 400);

    // Which of the caller's businesses is the till for?
    const { data: myBiz } = await svc.from('local_businesses').select('id, name, owner_id').eq('owner_id', user.id).eq('is_active', true);
    const biz = business_id ? (myBiz ?? []).find((b: any) => b.id === business_id) : (myBiz ?? [])[0];
    if (!biz) return json({ error: (myBiz ?? []).length ? 'Pick which business this is for' : 'You do not run a business' }, 403);

    // Resolve the customer from their member code.
    const { data: cust } = await svc.from('profiles').select('id, display_name, full_name').eq('member_code', String(member_code).toUpperCase().trim()).maybeSingle();
    if (!cust) return json({ error: 'Member code not found' }, 404);
    if (cust.id === user.id) return json({ error: "That's your own code" }, 400);
    const custName = cust.display_name || cust.full_name || 'Member';

    const { data: program } = await svc.from('local_loyalty_programs').select('*').eq('business_id', biz.id).eq('is_active', true).maybeSingle();

    // Load (or lazily create on write) the customer's card for this business.
    async function getCard(create = false) {
      if (!program) return null;
      let { data: card } = await svc.from('local_loyalty_cards').select('*').eq('user_id', cust.id).eq('program_id', program.id).maybeSingle();
      if (!card && create) {
        const { data: made } = await svc.from('local_loyalty_cards').insert({ user_id: cust.id, program_id: program.id, business_id: biz.id, stamps_collected: 0, points_balance: 0 }).select('*').single();
        card = made;
      }
      return card;
    }

    // Ladder helper.
    function readyTier(card: any) {
      const tiers = normalizeTiers(program?.reward_tiers);
      if (tiers.length) {
        const upto = card?.tiers_redeemed_upto ?? 0;
        return tiers.find((t) => t.stamps > upto && t.stamps <= (card?.stamps_collected ?? 0)) ?? null;
      }
      if (program?.type === 'stamps' && (card?.stamps_collected ?? 0) >= (program.stamps_required ?? 9999)) {
        return { stamps: program.stamps_required, reward: program.stamp_reward ?? 'Reward' };
      }
      return null;
    }

    // ── LOOKUP ────────────────────────────────────────────────────────────────
    if (action === 'lookup') {
      const card = await getCard(false);
      const now = new Date().toISOString();
      const { data: offers } = await svc.from('local_offers').select('id, title, discount_type, discount_value')
        .eq('business_id', biz.id).eq('is_active', true).lte('valid_from', now).gte('valid_until', now);
      const { data: used } = await svc.from('local_offer_redemptions').select('offer_id').eq('user_id', cust.id);
      const usedIds = new Set((used ?? []).map((r: any) => r.offer_id));
      const rt = readyTier(card);
      return json({
        ok: true,
        customer: { name: custName },
        business: { id: biz.id, name: biz.name },
        program: program ? { type: program.type, stamps_required: program.stamps_required, stamp_reward: program.stamp_reward, reward_tiers: normalizeTiers(program.reward_tiers), points_per_pound: program.points_per_pound, points_for_pound: program.points_for_pound } : null,
        card: card ? { stamps_collected: card.stamps_collected, points_balance: card.points_balance, tiers_redeemed_upto: card.tiers_redeemed_upto } : null,
        ready_reward: rt,
        offers: (offers ?? []).map((o: any) => ({ id: o.id, title: o.title, badge: offerBadge(o), claimed: usedIds.has(o.id) })),
      });
    }

    // ── ADD A STAMP ─────────────────────────────────────────────────────────
    if (action === 'stamp') {
      if (!program || program.type !== 'stamps') return json({ error: 'No stamp card here' }, 400);
      const card = await getCard(true);
      if (card?.last_stamp_at && (Date.now() - new Date(card.last_stamp_at).getTime()) < 60_000) {
        return json({ error: 'Just stamped — give it a moment' }, 429);
      }
      const newStamps = (card!.stamps_collected ?? 0) + 1;
      await svc.from('local_loyalty_cards').update({ stamps_collected: newStamps, last_stamp_at: new Date().toISOString(), nudge_reminded_at: null }).eq('id', card!.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card!.id, user_id: cust.id, business_id: biz.id, type: 'stamp', amount: 1 });
      const rt = readyTier({ ...card, stamps_collected: newStamps });
      if (rt) {
        await sendUserPush(svc, { userId: cust.id, module: 'loyalty', categoryId: 'loyalty.reward_ready', title: `🎉 Reward unlocked at ${biz.name}!`, body: rt.reward, data: { screen: 'local-my-cards' } }).catch(() => {});
      }
      return json({ ok: true, message: `Stamp added — ${newStamps} total`, stamps: newStamps, reward_ready: !!rt, reward: rt?.reward ?? null });
    }

    // ── ADD POINTS (per £ spent) ──────────────────────────────────────────────
    if (action === 'points') {
      if (!program || program.type !== 'points') return json({ error: 'No points card here' }, 400);
      const spend = Number(amount_pence);
      if (!Number.isFinite(spend) || spend <= 0) return json({ error: 'Enter the amount spent' }, 400);
      const pts = Math.floor((spend / 100) * (program.points_per_pound ?? 0));
      if (pts <= 0) return json({ error: 'That earns no points' }, 400);
      const card = await getCard(true);
      await svc.from('local_loyalty_cards').update({ points_balance: (card!.points_balance ?? 0) + pts, last_stamp_at: new Date().toISOString() }).eq('id', card!.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card!.id, user_id: cust.id, business_id: biz.id, type: 'points_earn', amount: pts, note: 'Earned at till' });
      return json({ ok: true, message: `+${pts} points`, points: (card!.points_balance ?? 0) + pts });
    }

    // ── REDEEM A REWARD (ladder-aware) ────────────────────────────────────────
    if (action === 'redeem_reward') {
      if (!program) return json({ error: 'No programme here' }, 400);
      const card = await getCard(false);
      if (!card) return json({ error: 'No card yet' }, 409);
      const tiers = normalizeTiers(program.reward_tiers);
      if (tiers.length) {
        const upto = card.tiers_redeemed_upto ?? 0;
        const ready = tiers.find((t) => t.stamps > upto && t.stamps <= (card.stamps_collected ?? 0));
        if (!ready) return json({ error: 'No reward ready' }, 409);
        const isTop = ready.stamps === tiers[tiers.length - 1].stamps;
        await svc.from('local_loyalty_cards').update(isTop
          ? { stamps_collected: 0, tiers_redeemed_upto: 0, total_redeemed: (card.total_redeemed ?? 0) + 1, reward_reminded_at: null, nudge_reminded_at: null }
          : { tiers_redeemed_upto: ready.stamps, total_redeemed: (card.total_redeemed ?? 0) + 1 }).eq('id', card.id);
        await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: cust.id, business_id: biz.id, type: 'reward', amount: ready.stamps });
        return json({ ok: true, message: `Redeemed: ${ready.reward}` });
      }
      if ((card.stamps_collected ?? 0) < (program.stamps_required ?? 9999)) return json({ error: 'Card not complete' }, 409);
      await svc.from('local_loyalty_cards').update({ stamps_collected: 0, total_redeemed: (card.total_redeemed ?? 0) + 1, reward_reminded_at: null }).eq('id', card.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: cust.id, business_id: biz.id, type: 'reward', amount: program.stamps_required });
      return json({ ok: true, message: `Redeemed: ${program.stamp_reward ?? 'reward'}` });
    }

    // ── APPLY AN OFFER ────────────────────────────────────────────────────────
    if (action === 'redeem_offer') {
      if (!offer_id) return json({ error: 'offer_id required' }, 400);
      const { data: offer } = await svc.from('local_offers').select('*').eq('id', offer_id).eq('business_id', biz.id).maybeSingle();
      if (!offer || !offer.is_active) return json({ error: 'Offer not available' }, 410);
      const { error: insErr } = await svc.from('local_offer_redemptions').insert({ offer_id, user_id: cust.id });
      if (insErr && (insErr as any).code === '23505') return json({ error: 'Already used by this member' }, 409);
      if (insErr) return json({ error: insErr.message }, 500);
      await svc.from('local_offers').update({ redemption_count: (offer.redemption_count ?? 0) + 1 }).eq('id', offer_id);
      return json({ ok: true, message: `Applied: ${offer.title}` });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error('[loyalty-till]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

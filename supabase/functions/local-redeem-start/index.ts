import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-redeem-start
 *
 * Customer starts a redemption. Validates the thing is redeemable, then creates
 * a pending `local_redemptions` row with a short staff code + QR token. Staff
 * verify it via local-redeem-verify, which applies the effect. Nothing changes
 * on the customer's balances until staff verify — no more sofa redemptions.
 *
 * Body: { kind: 'offer'|'reward'|'pass'|'points', ref_id: string, amount?: number }
 *   offer  → ref_id = offer_id
 *   reward → ref_id = loyalty card_id
 *   pass   → ref_id = book_unit_purchases.id
 *   points → ref_id = loyalty card_id, amount = points to spend
 * Returns: { id, code, token, kind, detail, expires_at }
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeCode(len = 4): string {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('local-redeem-start', userSubject(user.id), ['redeem_start'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { kind, ref_id, amount } = await req.json();
    if (!kind || !ref_id) return json({ error: 'kind and ref_id required' }, 400);

    let business_id: string;
    let detail: Record<string, unknown> = {};
    let pointsAmount: number | null = null;

    if (kind === 'offer') {
      const { data: offer } = await svc.from('local_offers').select('*').eq('id', ref_id).single();
      if (!offer) return json({ error: 'Offer not found' }, 404);
      if (!offer.is_active) return json({ error: 'Offer no longer active' }, 410);
      const now = Date.now();
      if (new Date(offer.valid_from).getTime() > now) return json({ error: 'Offer not started yet' }, 400);
      if (new Date(offer.valid_until).getTime() < now) return json({ error: 'Offer has expired' }, 410);
      if (offer.max_redemptions && offer.redemption_count >= offer.max_redemptions) {
        return json({ error: 'All redemptions used' }, 410);
      }
      const { data: already } = await svc.from('local_offer_redemptions')
        .select('offer_id').eq('offer_id', ref_id).eq('user_id', user.id).maybeSingle();
      if (already) return json({ error: "You've already used this offer" }, 409);
      business_id = offer.business_id;
      detail = { title: offer.title, subtitle: describeOffer(offer) };
    } else if (kind === 'reward' || kind === 'points') {
      const { data: card } = await svc.from('local_loyalty_cards').select('*').eq('id', ref_id).single();
      if (!card || card.user_id !== user.id) return json({ error: 'Not your card' }, 403);
      const { data: program } = await svc.from('local_loyalty_programs')
        .select('*').eq('id', card.program_id).single();
      if (!program) return json({ error: 'No loyalty program' }, 400);
      business_id = card.business_id;
      if (kind === 'reward') {
        if (program.type !== 'stamps') return json({ error: 'Not a stamp card' }, 400);
        const tiers = normalizeTiers(program.reward_tiers);
        if (tiers.length > 0) {
          // Ladder: the lowest tier reached but not yet claimed.
          const upto = card.tiers_redeemed_upto ?? 0;
          const ready = tiers.find((t) => t.stamps > upto && t.stamps <= (card.stamps_collected ?? 0));
          if (!ready) return json({ error: 'No reward ready to claim' }, 400);
          detail = { title: ready.reward || 'Reward', subtitle: `${ready.stamps}-stamp reward` };
        } else {
          if (card.stamps_collected < (program.stamps_required ?? 999)) {
            return json({ error: 'Card not complete yet' }, 400);
          }
          detail = { title: program.stamp_reward || 'Reward', subtitle: 'Stamp card reward' };
        }
      } else {
        if (program.type !== 'points') return json({ error: 'Not a points card' }, 400);
        const spend = Math.floor(Number(amount) || 0);
        const per = program.points_for_pound ?? 100;
        if (spend < per) return json({ error: `Need at least ${per} points` }, 400);
        if ((card.points_balance ?? 0) < spend) return json({ error: 'Not enough points' }, 400);
        pointsAmount = spend;
        detail = { title: `£${(spend / per).toFixed(2)} off`, subtitle: `${spend} points` };
      }
    } else if (kind === 'pass') {
      const { data: pass } = await svc.from('book_unit_purchases').select('*, item:book_unit_items(name)').eq('id', ref_id).single();
      if (!pass || pass.owner_id !== user.id) return json({ error: 'Not your pass' }, 403);
      if ((pass.uses_remaining ?? 0) <= 0) return json({ error: 'No uses left on this pass' }, 410);
      if (pass.expires_at && new Date(pass.expires_at).getTime() < Date.now()) {
        return json({ error: 'This pass has expired' }, 410);
      }
      business_id = pass.business_id;
      detail = { title: pass.item?.name ?? 'Pass', subtitle: `${pass.uses_remaining} use${pass.uses_remaining === 1 ? '' : 's'} left` };
    } else {
      return json({ error: 'Unknown kind' }, 400);
    }

    // Reuse an existing live pending redemption for the same thing.
    const { data: existing } = await svc.from('local_redemptions')
      .select('*')
      .eq('user_id', user.id).eq('kind', kind).eq('ref_id', ref_id).eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (existing) {
      return json({ id: existing.id, code: existing.code, token: existing.token, kind, detail: existing.detail, expires_at: existing.expires_at });
    }

    const code = makeCode();
    const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
    const { data: row, error: insErr } = await svc.from('local_redemptions').insert({
      business_id, user_id: user.id, kind, ref_id, code, status: 'pending', detail, amount: pointsAmount, expires_at,
    }).select('id, code, token, expires_at').single();
    if (insErr) return json({ error: insErr.message }, 500);

    return json({ id: row.id, code: row.code, token: row.token, kind, detail, expires_at: row.expires_at });
  } catch (err) {
    console.error('[local-redeem-start]', err);
    return json({ error: safeError('local-redeem-start', err) }, 500);
  }
});

function describeOffer(o: Record<string, unknown>): string {
  const t = o.discount_type as string;
  const v = o.discount_value as number;
  if (t === 'percent') return `${v}% off`;
  if (t === 'fixed') return `£${v} off`;
  if (t === 'bogo') return '2 for 1';
  if (t === 'freebie') return 'Freebie';
  return (o.title as string) ?? 'Offer';
}

/** Parse a programme's reward_tiers into a clean ascending list. */
function normalizeTiers(raw: unknown): { stamps: number; reward: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    // deno-lint-ignore no-explicit-any
    .map((t: any) => ({ stamps: Number(t?.stamps), reward: String(t?.reward ?? '') }))
    .filter((t) => Number.isFinite(t.stamps) && t.stamps > 0)
    .sort((a, b) => a.stamps - b.stamps);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

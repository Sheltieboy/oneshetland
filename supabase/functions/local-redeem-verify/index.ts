import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

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

    const { code, token, preview } = await req.json();
    if (!code && !token) return json({ error: 'code or token required' }, 400);

    // ── Look, don't spend ────────────────────────────────────────────────────
    // Counter mode calls this first so staff can see what they are about to
    // redeem. It writes nothing; the RPC is STABLE. Everything below this point
    // consumes, and only runs when staff explicitly confirm.
    if (preview === true) {
      const { data: seen, error: seenErr } = await svc.rpc('preview_redemption', {
        p_verifier: user.id,
        p_code:     token ? null : String(code).toUpperCase().trim(),
        p_token:    token ?? null,
      });
      if (seenErr) {
        console.error('[local-redeem-verify] preview failed', seenErr);
        return json({ error: 'Could not look that code up.' }, 500);
      }
      const p = seen as { ok: boolean; error?: string; kind?: string; title?: string; subtitle?: string; uses_remaining?: number };
      if (!p?.ok) {
        const map: Record<string, [string, number]> = {
          not_found:    ['Code not found, already used, or expired', 404],
          already_used: ['Already redeemed', 409],
          expired:      ['Code not found, already used, or expired', 404],
          no_uses_left: ['No uses left', 409],
        };
        const [msg, status] = map[p?.error ?? ''] ?? ['Code not found, already used, or expired', 404];
        return json({ error: msg }, status);
      }
      return json({ ok: true, preview: true, kind: p.kind, detail: { title: p.title, subtitle: p.subtitle }, uses_remaining: p.uses_remaining });
    }

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
      const { data: program } = card ? await svc.from('local_loyalty_programs').select('stamps_required, reward_tiers').eq('id', card.program_id).single() : { data: null };
      if (!card || !program) return json({ error: 'Card not found' }, 404);
      const tiers = normalizeTiers(program.reward_tiers);
      if (tiers.length > 0) {
        // Ladder: claim the lowest ready tier; reset the whole card only at the top.
        const upto = card.tiers_redeemed_upto ?? 0;
        const ready = tiers.find((t) => t.stamps > upto && t.stamps <= (card.stamps_collected ?? 0));
        if (!ready) return json({ error: 'No reward ready to claim' }, 409);
        const isTop = ready.stamps === tiers[tiers.length - 1].stamps;
        await svc.from('local_loyalty_cards').update(
          isTop
            ? { stamps_collected: 0, tiers_redeemed_upto: 0, total_redeemed: (card.total_redeemed ?? 0) + 1, reward_reminded_at: null, nudge_reminded_at: null }
            : { tiers_redeemed_upto: ready.stamps, total_redeemed: (card.total_redeemed ?? 0) + 1 },
        ).eq('id', card.id);
        await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: card.user_id, business_id: card.business_id, type: 'reward', amount: ready.stamps });
      } else {
        // Legacy single reward.
        if ((card.stamps_collected ?? 0) < (program.stamps_required ?? 999)) {
          return json({ error: 'Card is no longer complete' }, 409);
        }
        // Reset stamps and re-arm the "reward ready" reminder for the next cycle.
        await svc.from('local_loyalty_cards').update({ stamps_collected: 0, total_redeemed: (card.total_redeemed ?? 0) + 1, reward_reminded_at: null }).eq('id', card.id);
        await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: card.user_id, business_id: card.business_id, type: 'reward', amount: program.stamps_required });
      }
    } else if (red.kind === 'points') {
      const { data: card } = await svc.from('local_loyalty_cards').select('*').eq('id', red.ref_id).single();
      const spend = red.amount ?? 0;
      if (!card || (card.points_balance ?? 0) < spend) return json({ error: 'Not enough points' }, 409);
      await svc.from('local_loyalty_cards').update({ points_balance: (card.points_balance ?? 0) - spend, total_redeemed: (card.total_redeemed ?? 0) + 1 }).eq('id', card.id);
      await svc.from('local_loyalty_transactions').insert({ card_id: card.id, user_id: card.user_id, business_id: card.business_id, type: 'redeem', amount: spend });
    } else if (red.kind === 'pass') {
      // One transaction, holding the redemption row FOR UPDATE, so concurrent
      // presentations of the same code serialise and only the first spends a
      // use. The read-then-write this replaces let six concurrent verifies
      // succeed against three credits — reproduced on production fixtures.
      //
      // It returns early: redeem_pass_atomic also flips the redemption to
      // consumed, so the shared flip below must not run for this kind.
      const { data: spend, error: spendErr } = await svc.rpc('redeem_pass_atomic', {
        p_verifier: user.id,
        p_code:     token ? null : String(code).toUpperCase().trim(),
        p_token:    token ?? null,
      });
      if (spendErr) {
        console.error('[local-redeem-verify] redeem_pass_atomic failed', spendErr);
        return json({ error: 'Could not redeem that pass.' }, 500);
      }
      const outcome = spend as { ok: boolean; error?: string; uses_remaining?: number };
      if (!outcome?.ok) {
        const map: Record<string, [string, number]> = {
          not_found:         ['Code not found, already used, or expired', 404],
          wrong_kind:        ['Code not found, already used, or expired', 404],
          already_used:      ['Already redeemed', 409],
          expired:           ['Code not found, already used, or expired', 404],
          not_your_business: ['That code is not for your business', 403],
          wrong_business:    ['That code is not for your business', 403],
          pass_not_found:    ['Pass not found', 404],
          pass_expired:      ['This pass has expired', 410],
          no_uses_left:      ['No uses left', 409],
        };
        const [msg, status] = map[outcome?.error ?? ''] ?? ['Could not redeem that pass.', 409];
        return json({ error: msg }, status);
      }
      return json({
        ok: true,
        kind: 'pass',
        detail: {
          title: red.detail?.title ?? 'Pass',
          subtitle: `${outcome.uses_remaining} use${outcome.uses_remaining === 1 ? '' : 's'} left`,
        },
      });
    } else {
      return json({ error: 'Unknown redemption kind' }, 400);
    }

    await svc.from('local_redemptions').update({ status: 'consumed', consumed_at: new Date().toISOString(), consumed_by: user.id }).eq('id', red.id);
    return json({ ok: true, kind: red.kind, detail: red.detail });
  } catch (err) {
    console.error('[local-redeem-verify]', err);
    return json({ error: safeError('local-redeem-verify', err) }, 500);
  }
});

async function cancel(svc: ReturnType<typeof createClient>, id: string) {
  await svc.from('local_redemptions').update({ status: 'cancelled' }).eq('id', id);
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

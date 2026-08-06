import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-stamp-collect
 *
 * The customer types in the business's rotating 6-digit code.
 * Server validates the code is unexpired, then:
 *   - upserts loyalty card
 *   - increments stamps_collected
 *   - rate-limits 1 stamp per business per user per day
 *
 * Body: { code: string }
 * Returns: { ok, stamps, needed, reward_ready }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Unauthorised' }, 401);
    }

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

    const { code } = await req.json();
    if (!code || typeof code !== 'string' || code.length !== 6) {
      return json({ error: 'Invalid code' }, 400);
    }

    // Find the business whose current code matches
    const { data: codeRow } = await svc
      .from('local_business_codes')
      .select('business_id, expires_at')
      .eq('current_code', code)
      .maybeSingle();

    if (!codeRow) return json({ error: 'Code not found' }, 404);
    if (new Date(codeRow.expires_at).getTime() < Date.now()) {
      return json({ error: 'Code has expired' }, 410);
    }

    const businessId = codeRow.business_id;

    // Business cannot stamp themselves
    const { data: business } = await svc
      .from('local_businesses')
      .select('owner_id, name')
      .eq('id', businessId)
      .single();
    if (business?.owner_id === user.id) {
      return json({ error: "You can't stamp your own business" }, 403);
    }

    // Get the loyalty program
    const { data: program } = await svc
      .from('local_loyalty_programs')
      .select('*')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .maybeSingle();
    if (!program) return json({ error: 'No active loyalty program' }, 404);

    // Get or create card
    let { data: card } = await svc
      .from('local_loyalty_cards')
      .select('*')
      .eq('user_id', user.id)
      .eq('program_id', program.id)
      .maybeSingle();

    if (!card) {
      const { data: newCard, error } = await svc
        .from('local_loyalty_cards')
        .insert({
          user_id: user.id,
          program_id: program.id,
          business_id: businessId,
          stamps_collected: 0,
          points_balance: 0,
        })
        .select('*')
        .single();
      if (error) return json({ error: error.message }, 500);
      card = newCard;
    }

    // Rate limit — 1 stamp per business per user per day
    if (card.last_stamp_at) {
      const last = new Date(card.last_stamp_at).getTime();
      const hoursAgo = (Date.now() - last) / 3_600_000;
      if (hoursAgo < 4) {
        return json({ error: 'Already stamped today — come back tomorrow' }, 429);
      }
    }

    const newStamps = (card.stamps_collected ?? 0) + 1;
    const needed    = program.stamps_required ?? 10;
    const rewardReady = program.type === 'stamps' && newStamps >= needed;

    // Checked: an unchecked failure here reports "Stamp collected!" to the
    // customer while the card stays on zero.
    const { data: saved, error: saveErr } = await svc
      .from('local_loyalty_cards')
      .update({
        stamps_collected: newStamps,
        last_stamp_at: new Date().toISOString(),
        nudge_reminded_at: null,   // re-arm the "one more stamp" reminder as the card fills
      })
      .eq('id', card.id)
      .select('id')
      .maybeSingle();
    if (saveErr || !saved) {
      return json({ error: `Couldn't save your stamp: ${saveErr?.message ?? 'the card did not update'}` }, 500);
    }

    await svc.from('local_loyalty_transactions').insert({
      card_id: card.id,
      user_id: user.id,
      business_id: businessId,
      type: 'stamp',
      amount: 1,
    });

    // Push notification if reward is ready (preference-aware).
    if (rewardReady) {
      await sendUserPush(svc, {
        userId:     user.id,
        module:     'loyalty',
        categoryId: 'loyalty.reward_ready',
        title:      `🎉 Reward unlocked at ${business?.name ?? 'Local'}!`,
        body:       program.stamp_reward ?? 'Show this card next time you visit.',
        data:       { screen: 'local-my-cards' },
      });
    }

    return json({
      ok: true,
      stamps: newStamps,
      needed,
      reward_ready: rewardReady,
      business_name: business?.name,
    });
  } catch (err) {
    console.error('[local-stamp-collect]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

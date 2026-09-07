import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

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

    // Counted against notify_any as well as its own route: the aggregate only
    // means anything if every notification path claims it.
    const limited = await enforceRateLimit('local-stamp-collect', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

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

    // One transaction: created-or-locked card, gap under the lock, atomic
    // increment, ledger row in the same commit. The rotating-code check, the
    // owner block and the expiry check above are edge concerns and stay here.
    const { data: earned, error: earnErr } = await svc.rpc('loyalty_earn_stamp', {
      p_user:            user.id,
      p_business:        businessId,
      p_min_gap_seconds: 4 * 3600,
    });
    if (earnErr) {
      console.error('[local-stamp-collect] loyalty_earn_stamp failed', earnErr);
      return json({ error: "Couldn't save your stamp." }, 500);
    }
    const outcome = earned as {
      ok: boolean; error?: string;
      stamps_collected?: number; stamps_required?: number; reward_ready?: boolean;
    };
    if (!outcome?.ok) {
      if (outcome?.error === 'too_soon') {
        return json({ error: 'Already stamped today — come back tomorrow' }, 429);
      }
      if (outcome?.error === 'no_stamp_program') {
        return json({ error: 'No active loyalty program' }, 404);
      }
      return json({ error: "Couldn't save your stamp." }, 500);
    }
    const newStamps = outcome.stamps_collected ?? 0;
    const needed = outcome.stamps_required ?? 10;
    const rewardReady = outcome.reward_ready === true;

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
    return json({ error: safeError('local-stamp-collect', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

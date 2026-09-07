import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-redeem-reward
 *
 * Customer redeems a full stamp card.
 * Resets stamps_collected to 0, increments total_redeemed,
 * records a 'reward' transaction.
 *
 * Body: { card_id: string }
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

    const { card_id } = await req.json();
    if (!card_id) return json({ error: 'card_id required' }, 400);

    // The card is locked for the whole decision. This used to read the card,
    // decide in TypeScript, then UPDATE ... WHERE id with no lock, so two
    // simultaneous redemptions both reset one full card and both paid out.
    // Authority is unchanged: the RPC accepts the card's owner or the owner of
    // its business, and nobody else.
    const { data: applied, error: applyErr } = await svc.rpc('loyalty_redeem_card_atomic', {
      p_actor: user.id,
      p_card:  card_id,
    });
    if (applyErr) {
      console.error('[local-redeem-reward] loyalty_redeem_card_atomic failed', applyErr);
      return json({ error: 'Could not redeem that reward.' }, 500);
    }
    const outcome = applied as { ok: boolean; error?: string };
    if (!outcome?.ok) {
      const map: Record<string, [string, number]> = {
        not_yours:         ['Not your card', 403],
        not_ready:         ['Card not complete yet', 400],
        card_not_found:    ['Not your card', 403],
        program_not_found: ['No stamp program', 400],
      };
      const [msg, status] = map[outcome?.error ?? ''] ?? ['Could not redeem that reward.', 400];
      return json({ error: msg }, status);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('[local-redeem-reward]', err);
    return json({ error: safeError('local-redeem-reward', err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

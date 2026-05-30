import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    const { data: card } = await svc
      .from('local_loyalty_cards')
      .select('*')
      .eq('id', card_id)
      .single();

    if (!card || card.user_id !== user.id) return json({ error: 'Not your card' }, 403);

    const { data: program } = await svc
      .from('local_loyalty_programs')
      .select('stamps_required, type')
      .eq('id', card.program_id)
      .single();

    if (!program || program.type !== 'stamps') return json({ error: 'No stamp program' }, 400);
    if (card.stamps_collected < (program.stamps_required ?? 999)) {
      return json({ error: 'Card not complete yet' }, 400);
    }

    await svc
      .from('local_loyalty_cards')
      .update({
        stamps_collected: 0,
        total_redeemed: (card.total_redeemed ?? 0) + 1,
      })
      .eq('id', card_id);

    await svc.from('local_loyalty_transactions').insert({
      card_id,
      user_id: user.id,
      business_id: card.business_id,
      type: 'reward',
      amount: program.stamps_required,
    });

    return json({ ok: true });
  } catch (err) {
    console.error('[local-redeem-reward]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

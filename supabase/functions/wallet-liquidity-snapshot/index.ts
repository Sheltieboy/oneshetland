import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getWalletLiquiditySnapshot, getRecentWalletTopups } from '../_shared/wallet-liquidity.ts';
import { safeError } from '../_shared/safe-error.ts';

/**
 * wallet-liquidity-snapshot — ADMIN ONLY, read-only.
 *
 * Feeds the "Local Wallet liquidity" admin panel. Returns exactly the same
 * figures the Wallet-spend preflight gate itself computes (one canonical
 * function, see _shared/wallet-liquidity.ts), so the dashboard and the gate
 * can never disagree about what "available" means.
 *
 * Returns Stripe's GBP available/pending TOTALS only — never account ids,
 * keys, or anything else from the Stripe response.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

    const [snapshot, recentTopups] = await Promise.all([
      getWalletLiquiditySnapshot(svc),
      getRecentWalletTopups(svc),
    ]);
    return json({ ...snapshot, recent_topups: recentTopups });
  } catch (err) {
    console.error('[wallet-liquidity-snapshot]', err);
    return json({ error: safeError('wallet-liquidity-snapshot', err) }, 500);
  }
});

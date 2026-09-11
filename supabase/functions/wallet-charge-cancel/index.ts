import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * wallet-charge-cancel
 *
 * BUSINESS side of charge-by-scan — the merchant's own undo. Before this
 * existed, the till's "Cancel" button only cleared local UI state: a merchant
 * who fat-fingered £50 instead of £5 and tapped Cancel had no server-side
 * guarantee the customer couldn't still approve it. Money can be wrong here,
 * so this is the one path that actually closes a pending request.
 *
 * Safe by construction, the same way wallet-charge-approve's own claim step
 * already is: the transition is a single conditional UPDATE —
 *
 *   update wallet_charge_requests set status = 'cancelled', ...
 *   where id = :id and status = 'pending'
 *
 * — which only one caller can ever win, whoever commits first. Postgres
 * evaluates the WHERE against committed state, so a concurrent approve that
 * already claimed the row (status -> 'charging') makes this UPDATE match zero
 * rows; the reverse holds too, in either order or genuinely at once. No
 * SELECT-then-UPDATE, no read to go stale between steps. Nothing here ever
 * touches a wallet balance, a ledger row, a fee, a transfer or Stripe — those
 * only ever happen in wallet-charge-approve's approve branch, which this
 * cannot reach once the row has left 'pending'.
 *
 * Authorisation mirrors wallet-charge-request's own resolution exactly: the
 * caller must OWN the business the request belongs to. Not "whoever created
 * it" — the till is the business's, not one staff member's — and not the
 * customer, who is never the business owner for their own request's business.
 *
 * Body: { request_id: string }
 * Returns (success): { cancelled: true }
 * Returns (already settled another way): 409 { error, status }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { request_id } = await req.json();
    if (!request_id) return json({ error: 'request_id required' }, 400);

    const { data: reqRow } = await svc
      .from('wallet_charge_requests')
      .select('id, business_id, status, expires_at')
      .eq('id', request_id)
      .maybeSingle();
    if (!reqRow) return json({ error: 'Charge request not found' }, 404);

    // Same "my business" resolution as wallet-charge-request: the business
    // this request belongs to must be owned by the caller. Refuses another
    // business, another merchant/user, and the customer alike — none of them
    // own this business_id.
    const { data: biz } = await svc
      .from('local_businesses')
      .select('id')
      .eq('id', reqRow.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (!biz) return json({ error: 'Not authorised to cancel this request' }, 403);

    // A request past its window belongs in 'expired', not 'cancelled' — they
    // are different terminal states even though neither moves money. Reactive
    // expiry, same as wallet-charge-approve's own check: only takes effect if
    // the row is still 'pending' (guarded), so it can never overwrite a
    // status something else already settled.
    if (reqRow.status === 'pending' && new Date(reqRow.expires_at).getTime() < Date.now()) {
      await svc.from('wallet_charge_requests').update({ status: 'expired', resolved_at: new Date().toISOString() }).eq('id', reqRow.id).eq('status', 'pending');
      return json({ error: 'This request had already expired.', status: 'expired' }, 409);
    }

    // ── The one write: cancel, but only from 'pending' ──────────────────────────
    const { data: cancelled } = await svc
      .from('wallet_charge_requests')
      .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
      .eq('id', reqRow.id).eq('status', 'pending')
      .select('id');

    if (!cancelled || cancelled.length === 0) {
      // Lost the race (approve claimed it first, or it lapsed just now), or
      // this is a repeat call after cancelling once already — either way,
      // nothing moved, and the current status is the honest answer.
      const { data: cur } = await svc.from('wallet_charge_requests').select('status').eq('id', reqRow.id).maybeSingle();
      return json({ error: `This request is already ${cur?.status ?? 'closed'}.`, status: cur?.status }, 409);
    }

    return json({ cancelled: true });
  } catch (err) {
    console.error('[wallet-charge-cancel]', err);
    return json({ error: safeError('wallet-charge-cancel', err) }, 500);
  }
});

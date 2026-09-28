import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const STRIPE = 'https://api.stripe.com/v1';

/**
 * wallet-refund-business — a merchant returns a business Wallet payment.
 *
 * Until this existed, none of the four business rails could be refunded at all:
 * refund-payment is the only other caller of wallet_reverse_debit and it
 * resolves hub memberships, whose wallet rows carry business_id = NULL. So the
 * refundable set and the business set were disjoint, and the platform took
 * money it had no supported way to give back.
 *
 * Body: { transaction_id: string, reason?: string }
 *
 * The client sends a wallet transaction id and nothing else. Business, customer,
 * Stripe account, source type, source id and amount are all resolved here from
 * our own rows — a caller cannot name the business whose money this is, or the
 * purchase to void, because it is never asked.
 *
 * SEQUENCE, and why this order
 *
 *   1  claim     source none -> pending
 *   2  Stripe    reverse the destination transfer
 *   3  finalise  wallet_reverse_debit + source -> refunded + stock, atomically
 *
 * Claiming first looks backwards next to refund-payment, which writes its
 * source record last. A membership is not a bearer instrument; a pass is. If
 * the wallet were credited first and this process then died, the customer would
 * hold both the money and a spendable pass, and could spend it before anyone
 * retried. Freezing first can only ever remove the ability to spend. The rule
 * that actually matters financially — never credit the wallet before the
 * transfer is clawed back — is untouched, because the credit is still last.
 *
 * Every boundary fails conservatively and retries to the same outcome:
 *   after claim, before Stripe   pass frozen, no money moved
 *   after Stripe, before credit  merchant clawed back, customer not yet paid
 *   inside finalise              rolls the money back too; source stays pending
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Reverse a Connect transfer in full, treating one already fully reversed as
 * done rather than as a failure.
 *
 * Lifted from refund-payment, for the reason recorded there: an idempotency key
 * only replays inside Stripe's 24-hour window, and outside it Stripe reads the
 * retry as a NEW reversal and refuses it because nothing is left to reverse.
 * Reading the transfer first is what makes a retry independent of how long the
 * merchant took to press the button again.
 */
async function reverseTransfer(transferId: string): Promise<void> {
  const auth = {
    'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  const look = await fetch(`${STRIPE}/transfers/${transferId}`, { headers: auth });
  if (look.ok) {
    const t = await look.json();
    if (typeof t.amount === 'number' && typeof t.amount_reversed === 'number'
        && t.amount_reversed >= t.amount) return;
  }

  const res = await fetch(`${STRIPE}/transfers/${transferId}/reversals`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `reverse_${transferId}`,
    },
    body: new URLSearchParams({ description: 'OneShetland: business wallet payment refunded' }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `Transfer reversal failed (HTTP ${res.status})`);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const limited = await enforceRateLimit(
      'wallet-refund-business', userSubject(user.id), ['business_refund', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const body = await req.json().catch(() => ({}));
    const transactionId = body?.transaction_id;
    if (!transactionId || typeof transactionId !== 'string') {
      return json({ error: 'transaction_id required' }, 400);
    }
    const reasonText = typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 120) : null;

    // ── The payment, from our ledger ────────────────────────────────────────
    const { data: txn } = await svc
      .from('local_wallet_transactions')
      .select('id, user_id, business_id, type, amount_pence, transfer_state, stripe_transfer_id, description')
      .eq('id', transactionId)
      .maybeSingle();
    if (!txn) return json({ error: 'That payment could not be found.' }, 404);
    if (txn.type !== 'spend') {
      return json({ error: 'Only a payment can be refunded.' }, 400);
    }
    // Hub memberships, donations and boosts carry no business. They have their
    // own refund route and their own rules; this one must not touch them.
    if (!txn.business_id) {
      return json({ error: 'That payment is not a business payment.' }, 400);
    }

    // ── Authorisation, from the ledger row and never from the caller ────────
    const { data: biz } = await svc
      .from('local_businesses')
      .select('id, name, owner_id')
      .eq('id', txn.business_id)
      .maybeSingle();
    if (!biz) return json({ error: 'That payment could not be found.' }, 404);

    let allowed = biz.owner_id === user.id;
    if (!allowed) {
      const { data: me } = await svc
        .from('profiles').select('role, is_platform_owner').eq('id', user.id).maybeSingle();
      allowed = me?.role === 'admin' || me?.is_platform_owner === true;
    }
    if (!allowed) {
      return json({ error: 'That payment is not yours to refund.' }, 403);
    }

    // ── Merchant transfer verdict ───────────────────────────────────────────
    //
    // wallet_reverse_debit stays the authority; this only decides what to tell
    // it, and it may only say 'clawed_back' when this call actually clawed the
    // money back. An unresolved transfer is refused there outright, so it is
    // refused here in words a merchant can act on.
    const state = txn.transfer_state ?? 'none';
    if (state === 'unresolved') {
      return json({
        error: 'This payment is still unsettled with our payment provider, so it cannot be '
             + 'refunded yet. Please contact support.',
      }, 409);
    }

    // ── 1. Freeze the source ────────────────────────────────────────────────
    const { data: claim, error: claimErr } = await svc.rpc('business_refund_claim', {
      p_wallet_txn: txn.id,
    });
    if (claimErr) {
      console.error('[wallet-refund-business] claim failed', claimErr);
      return json({ error: 'Could not start that refund. Please try again.' }, 500);
    }
    const c = claim as { ok: boolean; outcome?: string; status?: string; uses_consumed?: number };
    if (!c?.ok) {
      const map: Record<string, [string, number]> = {
        not_found:            ['That payment could not be found.', 404],
        not_a_spend:          ['Only a payment can be refunded.', 400],
        not_a_business_spend: ['That payment is not a business payment.', 400],
        not_linked:           ['That payment could not be matched to its purchase.', 409],
        pass_used:            ['That pass has already been used, so it cannot be refunded.', 409],
        order_not_refundable: ['That order has already been sent out, so it cannot be refunded here.', 409],
      };
      const [msg, status] = map[c?.outcome ?? ''] ?? ['That payment cannot be refunded.', 409];
      return json({ error: msg }, status);
    }

    // ── 2. Claw the merchant's payout back first ────────────────────────────
    //
    // If this fails the customer has not been credited, so nothing is
    // half-done: the source stays pending and the merchant can press again.
    let transferReversed = false;
    if (txn.stripe_transfer_id) {
      try { await reverseTransfer(txn.stripe_transfer_id); transferReversed = true; }
      catch (e) {
        console.error('[wallet-refund-business] transfer reversal failed', e);
        return json({
          error: 'Could not take the money back from your payout account, so nothing was '
               + 'refunded. Please try again.',
          stage: 'nothing_changed',
          retry_safe: true,
        }, 502);
      }
    }

    // 'sent' is the only state that may be called back; 'pending' never
    // confirmed, so a reversal there means the merchant was never paid.
    const merchantOutcome = state === 'sent'
      ? (transferReversed ? 'clawed_back' : 'no_transfer')
      : state === 'pending'
        ? 'never_paid'
        : 'no_transfer';

    // ── 3. Money back, source finalised, stock restored — one transaction ───
    const { data: done, error: doneErr } = await svc.rpc('business_refund_finalise', {
      p_wallet_txn: txn.id,
      p_reason:     reasonText ? `Refund · ${reasonText}` : `Refund · ${txn.description ?? biz.name}`,
      p_merchant:   merchantOutcome,
    });
    if (doneErr) {
      console.error('[wallet-refund-business] finalise failed', doneErr);
      // Two different situations that used to share one message, and the shared
      // one was false in the worse of them: if the payout came back, the
      // merchant HAS been clawed back and walking away leaves them short.
      return json(
        transferReversed
          ? {
              error: 'Your payout was taken back, but the money has not reached the customer '
                   + 'yet. Nothing has been taken twice — press Refund again to finish it.',
              stage: 'merchant_reversed_wallet_pending',
              retry_safe: true,
            }
          : {
              error: 'Could not return the money to the customer. Nothing has been changed.',
              stage: 'nothing_changed',
              retry_safe: true,
            },
        502);
    }

    const d = done as { ok: boolean; error?: string; already_complete?: boolean; balance_pence?: number };
    if (!d?.ok) {
      console.error('[wallet-refund-business] finalise refused', d?.error);
      return json({ error: 'That payment cannot be refunded.' }, 409);
    }

    return json({
      ok: true,
      already_complete: d.already_complete === true,
      amount_pence: Math.abs(txn.amount_pence ?? 0),
    });
  } catch (err) {
    console.error('[wallet-refund-business]', err);
    return json({ error: safeError('wallet-refund-business', err) }, 500);
  }
});

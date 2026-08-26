import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const STRIPE = 'https://api.stripe.com/v1';

/**
 * refund-payment  (ADMIN ONLY)
 *
 * Issues a Stripe refund for a PaymentIntent. For destination charges (tickets,
 * donations, memberships, wallet pay-ins — anything that paid out to a connected
 * account) it ALSO reverses the transfer and the application fee, so the money is
 * clawed back from the recipient rather than coming out of the platform balance.
 *
 * The matching `charge.refunded` webhook updates app state (and also catches
 * refunds issued straight from the Stripe Dashboard).
 *
 * Body: { payment_intent_id: string, amount_pence?: number, reason?: string }
 * Returns: { ok, refund_id, amount_pence, reversed_transfer }
 */
type MembershipPurchase = {
  id: string;
  hub_id: string | null;
  user_id: string | null;
  tier_name: string;
  hub_name: string;
  face_pence: number;
  fee_pence: number | null;
  total_pence: number | null;
  payment_method: 'card' | 'wallet' | 'unknown';
  payment_intent_id: string;
  refunded_pence: number;
  refund_state: 'none' | 'partial' | 'full';
  stripe_transfer_id: string | null;
};

const jsonResponse = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

/** Stripe's authoritative running total for a payment, or null if unreadable. */
async function chargeAmountRefunded(
  headers: Record<string, string>, paymentIntentId: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${STRIPE}/payment_intents/${paymentIntentId}?expand[]=latest_charge`, { headers });
    if (!res.ok) return null;
    const pi = await res.json();
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    const n = charge?.amount_refunded;
    return typeof n === 'number' ? n : null;
  } catch { return null; }
}

/** Reverse a Connect transfer in full. Idempotent on the transfer id. */
async function reverseTransfer(transferId: string): Promise<void> {
  const res = await fetch(`${STRIPE}/transfers/${transferId}/reversals`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': `reverse_${transferId}`,
    },
    body: new URLSearchParams({ description: 'OneShetland: membership refunded' }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `Transfer reversal failed (HTTP ${res.status})`);
}

/**
 * Refund a membership that was paid from the OneShetland wallet.
 *
 * FULL ONLY. wallet_reverse_debit returns the whole original spend and records
 * exactly one reversal linked to it; it takes no amount. A partial wallet
 * refund would therefore have to be a loose credit with no link back to what it
 * reverses, which is precisely the thing the wallet ledger exists to prevent.
 * Rather than weaken that, partial wallet refunds are refused and said so.
 */
async function refundWalletMembership(
  // deno-lint-ignore no-explicit-any
  svc: any,
  m: MembershipPurchase,
  total: number,
  amountPence: number | null,
  adminId: string,
): Promise<Response> {
  if (amountPence != null && amountPence < total) {
    return jsonResponse({
      error: 'Wallet memberships can only be refunded in full — the wallet ledger reverses the '
           + 'original payment rather than issuing a separate credit.',
      wallet_full_only: true,
      remaining_pence: total - (m.refunded_pence ?? 0),
    }, 400);
  }

  // 'wallet_<transactionId>' is written by wallet-checkout at fulfilment, so the
  // ledger row that funded this membership is recoverable without guesswork.
  const txId = m.payment_intent_id.startsWith('wallet_')
    ? m.payment_intent_id.slice('wallet_'.length) : null;
  if (!txId) return jsonResponse({ error: 'This wallet payment has no ledger reference to reverse.' }, 400);

  // Claw the hub's payout back first. If this fails the customer has not yet
  // been credited, so nothing is half-done.
  let transferReversed = false;
  if (m.stripe_transfer_id) {
    try { await reverseTransfer(m.stripe_transfer_id); transferReversed = true; }
    catch (e) {
      console.error('[refund-payment] wallet transfer reversal failed', e);
      return jsonResponse({
        error: 'Could not reverse the hub payout, so nothing was refunded. Please try again.',
      }, 502);
    }
  }

  const { data: rev, error: revErr } = await svc.rpc('wallet_reverse_debit', {
    p_transaction_id: txId,
    p_reason: `Refund · ${m.tier_name} membership · ${m.hub_name}`,
  }).maybeSingle();
  if (revErr) {
    console.error('[refund-payment] wallet reversal failed', revErr);
    return jsonResponse({ error: 'Could not return the money to the wallet. Nothing has been changed.' }, 502);
  }

  const { data: rec, error: recErr } = await svc.rpc('record_membership_refund',
    { p_pi: m.payment_intent_id, p_cumulative: total });
  if (recErr) {
    console.error('[refund-payment] membership record failed', recErr);
    return jsonResponse({ error: 'The money was returned but the record could not be updated. Please report this.' }, 500);
  }

  console.log(`[refund-payment] wallet membership ${m.id} refunded by ${adminId}: ${JSON.stringify(rec)}`);
  return jsonResponse({
    ok: true,
    rail: 'wallet',
    amount_pence: total,
    reversed_transfer: transferReversed,
    already_reversed: (rev as { already_reversed?: boolean } | null)?.already_reversed ?? false,
    membership: rec,
  });
}

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

    // Admin gate. Matches public.is_admin(), which is what every other admin
    // surface uses — a platform owner is an admin everywhere else, and a refund
    // should not be the one place that disagrees.
    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;
    if (!isAdmin) return json({ error: 'Forbidden — admins only' }, 403);

    const { payment_intent_id, amount_pence = null, reason = 'requested_by_customer' } = await req.json();
    if (!payment_intent_id || typeof payment_intent_id !== 'string') {
      return json({ error: 'payment_intent_id required' }, 400);
    }

    // ── Is this a membership? ──────────────────────────────────────────────
    // Resolved from OUR ledger, never from anything the caller sent. The admin
    // supplies a payment reference and nothing else; the amount already
    // refunded, the total, and which rail paid for it all come from here.
    const { data: purchaseRow } = await svc.from('hub_membership_purchases')
      .select('id, hub_id, user_id, tier_name, hub_name, face_pence, fee_pence, total_pence, ' +
              'payment_method, payment_intent_id, refunded_pence, refund_state, stripe_transfer_id')
      .eq('payment_intent_id', payment_intent_id).maybeSingle();
    const membership = purchaseRow as MembershipPurchase | null;

    if (membership) {
      const total     = membership.total_pence ?? (membership.face_pence + (membership.fee_pence ?? 0));
      const already   = membership.refunded_pence ?? 0;
      const remaining = total - already;
      if (membership.refund_state === 'full' || remaining <= 0) {
        return json({ error: 'This membership payment is already fully refunded.' }, 400);
      }
      if (amount_pence != null) {
        const want = Number(amount_pence);
        if (!Number.isInteger(want) || want <= 0) {
          return json({ error: 'amount_pence must be a whole number of pence above zero' }, 400);
        }
        if (want > remaining) {
          return json({ error: `That is more than remains refundable (${remaining}p).` }, 400);
        }
      }

      // ── Wallet rail ──────────────────────────────────────────────────────
      // No Stripe charge exists, so there is nothing to refund at Stripe. The
      // money goes back through the wallet ledger as a reversal LINKED to the
      // original debit — never a bare credit, which would leave the accounts
      // showing a payment that was never made good.
      if (membership.payment_method === 'wallet') {
        return await refundWalletMembership(svc, membership, total, amount_pence, user.id);
      }
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const headers = { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': STRIPE_API_VERSION };

    // Fetch the PaymentIntent (+ its charge) to detect a Connect transfer.
    const piRes = await fetch(`${STRIPE}/payment_intents/${payment_intent_id}?expand[]=latest_charge`, { headers });
    const pi = await piRes.json();
    if (!piRes.ok) return json({ error: pi.error?.message ?? `Stripe lookup failed (HTTP ${piRes.status})` }, 502);
    if (pi.status !== 'succeeded') return json({ error: `Cannot refund a payment that is "${pi.status}".` }, 400);

    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    if (charge?.refunded) return json({ error: 'This payment is already fully refunded.' }, 400);
    const hasTransfer = !!(charge?.transfer) || !!(pi.transfer_data?.destination);

    // Partial-amount validation.
    let amount: number | null = null;
    if (amount_pence != null) {
      amount = Math.round(Number(amount_pence));
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount_pence must be a positive integer' }, 400);
      if (amount > (pi.amount as number)) return json({ error: 'amount_pence exceeds the original charge' }, 400);
    }

    // Build the refund. Only Stripe's enum reasons are valid; anything else goes
    // into metadata so we keep the operator's note without erroring.
    const allowedReasons = ['requested_by_customer', 'duplicate', 'fraudulent'];
    const form = new URLSearchParams();
    form.set('payment_intent', payment_intent_id);
    if (amount != null) form.set('amount', String(amount));
    if (allowedReasons.includes(reason)) form.set('reason', reason);
    else form.set('metadata[note]', String(reason).slice(0, 200));
    form.set('metadata[refunded_by]', user.id);
    if (hasTransfer) {
      form.set('reverse_transfer', 'true');       // claw the money back from the connected account
      form.set('refund_application_fee', 'true'); // and return our platform fee too
    }

    // Idempotency: a double-click or a retry after a timed-out response must not
    // issue a second refund (which, with reverse_transfer, claws back from the
    // driver/business twice or leaves the platform eating it). Keyed on the
    // payment + amount, so a genuine second partial refund of a DIFFERENT amount
    // still goes through, but an identical retry returns the original refund.
    const idemKey = `refund:${payment_intent_id}:${amount ?? 'full'}`;
    const refRes = await fetch(`${STRIPE}/refunds`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idemKey },
      body: form.toString(),
    });
    const refund = await refRes.json();
    if (!refRes.ok) return json({ error: refund.error?.message ?? `Refund failed (HTTP ${refRes.status})` }, 502);

    // Best-effort app-state update for Fetch deliveries (other flows are handled
    // by the charge.refunded webhook). Full vs partial.
    // Record it against the membership straight away rather than waiting for
    // charge.refunded. Both call the same RPC and it takes the cumulative
    // high-water mark, so whichever arrives first the answer is the same.
    if (membership) {
      const cumulative = await chargeAmountRefunded(headers, payment_intent_id)
        ?? ((membership.refunded_pence ?? 0) + (refund.amount as number));
      const { error: recErr } = await svc.rpc('record_membership_refund',
        { p_pi: payment_intent_id, p_cumulative: cumulative });
      if (recErr) console.error('[refund-payment] membership record failed', recErr);
    }

    const meta = (pi.metadata ?? {}) as Record<string, string>;
    const fully = amount == null || amount >= (pi.amount as number);
    if (meta.request_id) {
      await svc.from('delivery_requests')
        .update({ payment_status: fully ? 'refunded' : 'partially_refunded' })
        .eq('payment_intent_id', payment_intent_id);
    }

    return json({
      ok: true,
      refund_id: refund.id,
      amount_pence: refund.amount,
      reversed_transfer: hasTransfer,
    });
  } catch (err) {
    console.error('[refund-payment]', err);
    return json({ error: safeError('refund-payment', err) }, 500);
  }
});

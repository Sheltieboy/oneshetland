import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { reconcileCharge, reconcileWalletOrder } from '../_shared/refund-reconcile.ts';
import { isWalletRef, refundWalletEventOrder, type WalletRefundDeps } from '../_shared/event-wallet-refund-core.ts';
import { notifyRefund } from '../_shared/refund-notice.ts';
import { paymentBelongsToTicketOrder, refundableOnTicketPayment } from '../_shared/ticket-payment-binding.ts';

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
 *    or { event_order_id: string }   (an event ticket order, refunded IN FULL)
 * Returns: { ok, refund_id, amount_pence, reversed_transfer }
 *
 * Event ticket orders are addressed by the ORDER's own id, never by a Stripe
 * identifier: the payment reference is read from our row here, so a caller
 * cannot point a ticket refund at somebody else's payment. Authority for a
 * ticket order is public.can_refund_event_orders (platform admin, the owner of
 * the organising business, or the owner of the organising hub — whoever
 * controls the connected account the money was paid to). Everything after
 * that is the same canonical path as every other rail: refund the customer,
 * reverse the merchant transfer, refund the platform fee, stamp refunded_by,
 * be idempotent, and be checked by refund reconciliation.
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

type BoostPurchase = {
  id: string;
  business_id: string;
  owner_id: string;
  weeks: number;
  amount_pence: number;
  refunded_pence: number;
  refund_state: 'none' | 'partial' | 'full';
  status: string;
  expires_at: string | null;
  stripe_payment_intent_id: string | null;
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

/**
 * Reverse a Connect transfer in full, treating one already fully reversed as
 * done rather than as a failure.
 *
 * The idempotency key makes a retry inside Stripe's 24-hour replay window
 * return the original reversal. OUTSIDE that window Stripe reads the same
 * request as a new reversal and refuses it, because nothing is left to
 * reverse. That surfaced as "could not reverse the hub payout, so nothing was
 * refunded" — which is the exact opposite of the truth, and stranded the
 * refund permanently: the hub had already been clawed back, and every retry
 * died here before the customer could be credited.
 *
 * Reading the transfer first makes recovery independent of how long the
 * operator took to press the button again. A transfer we cannot read falls
 * through to the POST, so nothing that worked before behaves differently.
 */
async function reverseTransfer(transferId: string, description = 'OneShetland: membership refunded'): Promise<void> {
  const look = await fetch(`${STRIPE}/transfers/${transferId}`, {
    headers: {
      'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  });
  if (look.ok) {
    const t = await look.json();
    if (typeof t.amount === 'number' && typeof t.amount_reversed === 'number'
        && t.amount_reversed >= t.amount) return;
  }

  const res = await fetch(`${STRIPE}/transfers/${transferId}/reversals`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': `reverse_${transferId}`,
    },
    body: new URLSearchParams({ description }),
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

  // Only 'clawed_back' when this call actually clawed it back. A membership
  // whose transfer ended 'unresolved' carries no transfer id, so nothing was
  // reversed here and nothing may claim it was — the RPC refuses that row
  // outright rather than crediting a wallet Stripe may already have paid for.
  const { data: rev, error: revErr } = await svc.rpc('wallet_reverse_debit', {
    p_transaction_id: txId,
    p_reason: `Refund · ${m.tier_name} membership · ${m.hub_name}`,
    p_merchant: transferReversed ? 'clawed_back' : 'no_transfer',
  }).maybeSingle();
  if (revErr) {
    console.error('[refund-payment] wallet reversal failed', revErr);
    // Two genuinely different situations, and they used to share one message
    // that was false in the worse of them. If the transfer came back, the hub
    // HAS been clawed back and the refund is half-done: saying "nothing has
    // been changed" invites the operator to walk away from money they have
    // already taken off a business. Both states are safe to retry — Stripe
    // will not reverse twice, and the ledger will not credit twice.
    return jsonResponse(
      transferReversed
        ? {
            error: 'The hub payout was reversed, but the money has not reached the wallet yet. '
                 + 'Nothing has been taken twice — press Refund again to finish it.',
            stage: 'merchant_reversed_wallet_pending',
            retry_safe: true,
          }
        : {
            error: 'Could not return the money to the wallet. Nothing has been changed.',
            stage: 'nothing_changed',
            retry_safe: true,
          },
      502);
  }

  const { data: rec, error: recErr } = await svc.rpc('record_membership_refund',
    { p_pi: m.payment_intent_id, p_cumulative: total });
  if (recErr) {
    console.error('[refund-payment] membership record failed', recErr);
    return jsonResponse({
      error: 'The money is back in the wallet, but the membership record did not update. '
           + 'Press Refund again to finish it.',
      stage: 'wallet_credited_record_pending',
      retry_safe: true,
    }, 500);
  }

  console.log(`[refund-payment] wallet membership ${m.id} refunded by ${adminId}: ${JSON.stringify(rec)}`);
  await notifyRefund(svc, {
    userId: m.user_id, refundKey: `membership:${m.id}`, amountPence: total,
    what: `Your ${m.hub_name} membership`, destination: 'wallet', data: { screen: 'local-wallet' },
  });
  return jsonResponse({
    ok: true,
    rail: 'wallet',
    stage: 'completed',
    amount_pence: total,
    reversed_transfer: transferReversed,
    already_reversed: (rev as { already_reversed?: boolean } | null)?.already_reversed ?? false,
    membership: rec,
  });
}

/**
 * The canonical Wallet primitives behind a Wallet-funded event ticket refund:
 * the same transfer clawback and wallet_reverse_debit the Wallet membership
 * refund uses, plus the idempotent ticket void the webhook uses.
 */
// deno-lint-ignore no-explicit-any
function walletEventRefundDeps(svc: any): WalletRefundDeps {
  return {
    async loadLedgerRow(txId) {
      const { data } = await svc.from('local_wallet_transactions')
        .select('id, user_id, type, amount_pence, stripe_transfer_id, transfer_state, idempotency_key')
        .eq('id', txId).maybeSingle();
      return data ?? null;
    },
    async reverseTransfer(transferId) { await reverseTransfer(transferId, 'OneShetland: event ticket refunded'); },
    async reverseDebit(txId, reason, merchant) {
      const { data, error } = await svc.rpc('wallet_reverse_debit',
        { p_transaction_id: txId, p_reason: reason, p_merchant: merchant }).maybeSingle();
      if (error || !data) {
        console.error('[refund-payment] wallet event reversal failed', error?.code ?? 'no row');
        return { ok: false as const, message: 'reversal failed' };
      }
      return {
        ok: true as const, reversalId: data.reversal_id as string,
        alreadyReversed: data.already_reversed === true, balancePence: data.balance_pence as number,
      };
    },
    async voidTickets(ref) {
      const { data, error } = await svc.rpc('refund_event_tickets_for_payment',
        { p_payment_intent_id: ref, p_fully_refunded: true });
      if (error) { console.error('[refund-payment] wallet event ticket void failed', error.code); return { ok: false as const, message: 'void failed' }; }
      return { ok: true as const, action: String((data as { action?: string } | null)?.action ?? 'refunded') };
    },
  };
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

    const body = await req.json();
    const { amount_pence = null, reason = 'requested_by_customer', boost_purchase_id = null, event_order_id = null } = body;
    let payment_intent_id: string = body.payment_intent_id;

    // ── Business boost ─────────────────────────────────────────────────────
    //
    // Addressed by the purchase's own id, so no Stripe identifier has to
    // travel to the admin screen or back. The payment reference is looked up
    // HERE from the purchase row; a caller cannot supply one, and cannot
    // therefore point a boost refund at somebody else's payment.
    //
    // Platform admin only, deliberately narrower than memberships. A boost is
    // OneShetland platform revenue: no Connect transfer, no application fee,
    // no business payout. There is no connected account whose owner could
    // claim standing to reverse it, and the purchaser is the beneficiary — a
    // business that could refund its own boost could take three weeks of Pro
    // and hand itself the money back.
    let boost: BoostPurchase | null = null;
    if (boost_purchase_id) {
      if (typeof boost_purchase_id !== 'string') {
        return json({ error: 'boost_purchase_id must be an id' }, 400);
      }
      const { data: boostRow } = await svc.from('local_boost_purchases')
        .select('id, business_id, owner_id, weeks, amount_pence, refunded_pence, refund_state, ' +
                'status, expires_at, stripe_payment_intent_id')
        .eq('id', boost_purchase_id).maybeSingle();
      boost = boostRow as BoostPurchase | null;
      if (!boost) return json({ error: 'That boost purchase could not be found.' }, 404);
      if (boost.status !== 'succeeded' || !boost.stripe_payment_intent_id) {
        return json({ error: 'That boost was never paid for, so there is nothing to refund.' }, 400);
      }
      payment_intent_id = boost.stripe_payment_intent_id;
    }

    // ── Event ticket order ─────────────────────────────────────────────────
    //
    // Authorised BEFORE anything about the order is revealed, so a caller who
    // may not refund it learns nothing (not found and not permitted look the
    // same to them). Full refunds only: nothing in the schema says which
    // tickets a partial refund would cover.
    type TicketOrder = {
      id: string; event_id: string; buyer_id: string; status: string;
      total_pence: number; stripe_payment_intent_id: string | null; refunded_at: string | null;
    };
    let eventOrder: TicketOrder | null = null;
    let ownsThisEvent = false;
    if (event_order_id) {
      if (typeof event_order_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(event_order_id)) {
        return json({ error: 'event_order_id must be an id' }, 400);
      }
      if (boost_purchase_id) return json({ error: 'Send one of event_order_id or boost_purchase_id' }, 400);
      const { data: ord } = await svc.from('event_ticket_orders')
        .select('id, event_id, buyer_id, status, total_pence, stripe_payment_intent_id, refunded_at')
        .eq('id', event_order_id).maybeSingle();
      eventOrder = ord as TicketOrder | null;

      const { data: meRow } = await svc.from('profiles')
        .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
      const adminHere = meRow?.role === 'admin' || meRow?.is_platform_owner === true;
      if (eventOrder) {
        const { data: ok } = await svc.rpc('can_refund_event_orders',
          { p_event_id: eventOrder.event_id, p_user_id: user.id });
        ownsThisEvent = ok === true;
      }
      if (!eventOrder || !ownsThisEvent) {
        return adminHere && !eventOrder
          ? json({ error: 'That ticket order could not be found.' }, 404)
          : json({ error: 'Forbidden — only the organiser who received this payment, or OneShetland, can refund it.' }, 403);
      }
      if (amount_pence != null) return json({ error: 'A ticket order is refunded in full.' }, 400);
      if (eventOrder.status === 'refunded' || eventOrder.refunded_at) {
        return json({ error: 'This order has already been refunded.' }, 400);
      }
      if (eventOrder.status !== 'paid' || !eventOrder.stripe_payment_intent_id || !(eventOrder.total_pence > 0)) {
        return json({ error: 'Only a paid ticket order can be refunded.' }, 400);
      }
      payment_intent_id = eventOrder.stripe_payment_intent_id;

      // ── Paid from the customer's OneShetland WALLET ────────────────────────
      //
      // There is no PaymentIntent behind a Wallet order — its reference is the
      // synthetic wallet_<ledger id> — so a Stripe card refund is the wrong rail
      // and would only fail on a payment that does not exist. The Wallet refund
      // claws back the organiser's Connect transfer, credits the customer's
      // Wallet once through wallet_reverse_debit, and voids the tickets.
      if (isWalletRef(eventOrder.stripe_payment_intent_id)) {
        const { data: ev } = await svc.from('events').select('title').eq('id', eventOrder.event_id).maybeSingle();
        const out = await refundWalletEventOrder(
          walletEventRefundDeps(svc),
          { id: eventOrder.id, buyer_id: eventOrder.buyer_id, total_pence: eventOrder.total_pence, stripe_payment_intent_id: eventOrder.stripe_payment_intent_id },
          (ev as { title?: string } | null)?.title ?? 'event', user.id,
        );
        if (!out.ok) return json({ error: out.error, stage: out.stage, retry_safe: out.retry_safe }, out.status);
        console.log(`[refund-payment] wallet event order ${eventOrder.id} refunded by ${user.id}: ${JSON.stringify({ merchant_reversed: out.merchant_reversed, already: out.already_reversed })}`);
        // Tell the buyer the money is back in their Wallet. Never throws, never blocks the refund.
        await notifyRefund(svc, {
          userId: eventOrder.buyer_id, refundKey: `event_order:${eventOrder.id}`, amountPence: out.amount_pence,
          what: `Your tickets for ${(ev as { title?: string } | null)?.title ?? 'the event'}`, destination: 'wallet',
          data: { screen: 'my-event-tickets', order_id: eventOrder.id },
        });
        // Judge it from the ledger and the Connect transfer now. Reading only: a failure here
        // never changes the refund that has already happened.
        let reconciliation: { state: string; note: string } | null = null;
        try {
          const rr = await reconcileWalletOrder(svc, eventOrder.id, `refund-payment:${user.id}`);
          reconciliation = { state: rr.state, note: rr.note };
        } catch (e) {
          console.error('[refund-payment] wallet reconciliation check failed', e instanceof Error ? e.message : 'error');
        }
        return json({
          ok: true, rail: 'wallet', amount_pence: out.amount_pence,
          reversed_transfer: out.merchant_reversed, already_reversed: out.already_reversed,
          tickets: { action: out.tickets_action },
          reconciliation,
        });
      }
    }

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

    // ── Who may refund THIS payment ────────────────────────────────────────
    //
    // A platform admin may refund anything. A hub owner may refund a
    // membership sold by their own hub, and nothing else — the money came out
    // of their connected account, so putting it back is theirs to decide.
    //
    // Ownership is resolved from the PURCHASE, never from the request: the
    // caller supplies a payment reference and the server works out which hub
    // that belongs to. A hub id, an owner id or a destination account sent by
    // a client is not read at all, so none of them can be substituted.
    //
    // Committee members are deliberately excluded. They run parts of a hub,
    // but only the owner controls the Stripe Connect relationship the money
    // moves through, and refunds follow that boundary rather than the
    // hub-management one.
    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;

    let ownsThisHub = false;
    if (!isAdmin && membership?.hub_id) {
      const { data: hub } = await svc.from('hubs')
        .select('owner_id').eq('id', membership.hub_id).maybeSingle();
      ownsThisHub = (hub as { owner_id?: string } | null)?.owner_id === user.id;
    }
    // A hub owner's authority covers memberships their own hub sold, and
    // nothing else. It is NOT extended to boosts: this is checked before the
    // shared refusal below so the boost rail can never inherit it.
    if (boost && !isAdmin) {
      return json({ error: 'Forbidden — only OneShetland can refund a business boost.' }, 403);
    }
    if (!isAdmin && !ownsThisHub && !ownsThisEvent) {
      // Deliveries and every other rail stay platform-admin only: there is no
      // hub or event organiser whose owner could claim them. A ticket refund
      // reaches here only through event_order_id, authorised above.
      return json({ error: 'Forbidden — you cannot refund this payment.' }, 403);
    }

    if (boost) {
      const already   = boost.refunded_pence ?? 0;
      const remaining = boost.amount_pence - already;
      if (boost.refund_state === 'full' || remaining <= 0) {
        return json({ error: 'This boost is already fully refunded.' }, 400);
      }
      if (amount_pence != null && (typeof amount_pence !== 'number' || amount_pence <= 0 || amount_pence > remaining)) {
        return json({ error: `The most that can still be returned on this boost is £${(remaining / 100).toFixed(2)}.` }, 400);
      }
    }

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

    // ── A ticket order may refund ITS OWN payment, and nothing else ─────────
    //
    // The payment id above was read from the order row. A row is not proof: until migration 20261116000000 any signed-in
    // user could write one with a paid status and a payment id of their choosing, and everything below — a card refund
    // that reverses the organiser's transfer — would have run against whatever payment they named. What cannot be forged
    // is what OUR checkout stamped on the PaymentIntent: so refund only when the payment's own type, order, event, buyer,
    // amount and currency all agree with the order. A mismatch changes nothing and says so.
    let ticketRefundAmount: number | null = null;
    if (eventOrder) {
      const bound = paymentBelongsToTicketOrder(eventOrder, pi);
      if (!bound.ok) {
        console.error(`[refund-payment] ticket order ${eventOrder.id} refused: ${bound.reason}`);
        return json({ error: 'That payment does not belong to this ticket order, so nothing was refunded.' }, 409);
      }
      const refundable = refundableOnTicketPayment(pi.amount, charge?.amount_refunded);
      if (refundable <= 0) return json({ error: 'This payment is already fully refunded.' }, 400);
      // Part of it was already returned elsewhere (e.g. the Stripe Dashboard): refund exactly what is left, never more.
      if (refundable < (pi.amount as number)) ticketRefundAmount = refundable;
    }

    // Partial-amount validation.
    let amount: number | null = ticketRefundAmount;
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
    if (eventOrder) form.set('metadata[event_order_id]', eventOrder.id);
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

    // Do not trust that the flags above did what they were meant to: check the
    // merchant's side of this refund against Stripe now. The same check runs
    // again from charge.refunded, so this is for an immediate verdict, and a
    // failure here never changes the refund that has already happened.
    let reconciliation: { state: string; note: string } | null = null;
    try {
      const chargeId = typeof charge?.id === 'string' ? charge.id : null;
      if (chargeId) {
        const rr = await reconcileCharge(svc, chargeId, { actor: `refund-payment:${user.id}`, allowRepair: true });
        reconciliation = { state: rr.state, note: rr.note };
      }
    } catch (e) {
      console.error('[refund-payment] reconciliation check failed', e instanceof Error ? e.message : 'error');
    }

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

    // Record it against the boost straight away rather than waiting for
    // charge.refunded. Both call the same RPC and it takes the cumulative
    // high-water mark, so whichever arrives first the answer is the same.
    if (boost) {
      const cumulative = await chargeAmountRefunded(headers, payment_intent_id)
        ?? ((boost.refunded_pence ?? 0) + (refund.amount as number));
      const { error: bErr } = await svc.rpc('record_boost_refund',
        { p_pi: payment_intent_id, p_cumulative: cumulative });
      if (bErr) console.error('[refund-payment] boost record failed', bErr);
    }

    const meta = (pi.metadata ?? {}) as Record<string, string>;
    const fully = amount == null || amount >= (pi.amount as number);
    if (meta.request_id) {
      await svc.from('delivery_requests')
        .update({ payment_status: fully ? 'refunded' : 'partially_refunded' })
        .eq('payment_intent_id', payment_intent_id);
    }

    // A ticket order: apply the same idempotent state change the webhook applies
    // (order -> refunded, valid tickets void), so the organiser's screen is right
    // the moment this returns instead of whenever charge.refunded arrives.
    let ticketOutcome: Record<string, unknown> | null = null;
    if (eventOrder) {
      const { data: t, error: tErr } = await svc.rpc('refund_event_tickets_for_payment',
        { p_payment_intent_id: payment_intent_id, p_fully_refunded: true });
      if (tErr) console.error('[refund-payment] ticket void failed (webhook will retry)', tErr.code);
      else ticketOutcome = t as Record<string, unknown>;

      // The card refund has been issued: tell the buyer, and say it takes days to show.
      const { data: evCard } = await svc.from('events').select('title').eq('id', eventOrder.event_id).maybeSingle();
      await notifyRefund(svc, {
        userId: eventOrder.buyer_id, refundKey: `event_order:${eventOrder.id}`, amountPence: Number(refund.amount),
        what: `Your tickets for ${(evCard as { title?: string } | null)?.title ?? 'the event'}`, destination: 'card',
        data: { screen: 'my-event-tickets', order_id: eventOrder.id },
      });
    }

    return json({
      ok: true,
      refund_id: refund.id,
      amount_pence: refund.amount,
      reversed_transfer: hasTransfer,
      reconciliation,
      tickets: ticketOutcome,
    });
  } catch (err) {
    console.error('[refund-payment]', err);
    return json({ error: safeError('refund-payment', err) }, 500);
  }
});

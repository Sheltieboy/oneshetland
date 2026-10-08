import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { debitAndTransfer, selfPaymentBlock } from '../_shared/wallet-ledger.ts';
import { withWalletLiquidityGate } from '../_shared/wallet-liquidity-gate.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforcePaymentStart } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';
import { chargeableCardFor } from '../_shared/saved-card.ts';
import {
  attemptIdProblem, payModeFor, mapClaimError, createPaymentIntentOnce, retrievePaymentIntent, isCardDecline, EXPIRED_BODY, IN_PROGRESS_BODY,
} from '../_shared/purchase-attempt.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Which card, by the ONE canonical rule (the Customer's default when it is
// really attached, else the newest) rather than "whatever Stripe listed
// first". Throws when Stripe cannot be asked, so an outage never reads as
// "no saved card".
async function listSavedCard(customerId: string): Promise<string | null> {
  return chargeableCardFor(Deno.env.get('STRIPE_SECRET_KEY') ?? '', customerId);
}

/**
 * create-gift-intent
 *
 * Begins a gift purchase: CLAIMS the purchase attempt (one atomic database call that
 * writes the pending book_gifts row, or resolves a repeat of the same attempt to the
 * gift it already made), then creates a Stripe PaymentIntent (with the gift_id in
 * metadata so confirm-gift can route it back).
 *
 * ONE ATTEMPT, ONE GIFT. `client_request_id` is minted by the client once per deliberate
 * purchase and sent with every request for it, retries included. The database keys on
 * (purchaser, id): a double-click, a retry after a lost response, two tabs or a replayed
 * call all resolve to the SAME gift — no second PaymentIntent, no second wallet debit, and
 * so no second code and no second email. It is an idempotency token only; the item, price,
 * business and destination are resolved here. A reused id for a different gift is a 409,
 * and a cancelled attempt is never resurrected.
 *
 * Body:
 *   {
 *     client_request_id: string,   // 8-100 chars, one per deliberate purchase
 *     kind:           'unit' | 'booking',
 *     unit_item_id?:  string,   // required when kind = 'unit'
 *     service_id?:    string,   // required when kind = 'booking'
 *     recipient_email: string,
 *     recipient_name?: string,
 *     message?:       string,
 *     use_saved_card?: boolean,
 *   }
 *
 * Returns either:
 *   { charged: true, payment_intent_id, gift_id }            ← paid
 * or:
 *   { clientSecret, payment_intent_id, gift_id }             ← PaymentSheet path
 * A repeat returns the state of the SAME payment; one that is mid-flight in another request returns 409 { code: 'in_progress' }.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const reply = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return reply({ error: 'Unauthorised' }, 401);

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) return reply({ error: 'Unauthorised' }, 401);

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforcePaymentStart('create-gift-intent', user.id, corsHeaders);
    if ('denied' in limited) return limited.denied;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json();
    const { kind, unit_item_id, service_id, recipient_email, recipient_name, message, use_saved_card = false, pay_with_wallet = false, client_request_id } = body;

    // One id per deliberate purchase, sent again on every retry. Idempotency token ONLY — see the header.
    if (attemptIdProblem(client_request_id)) return reply({ error: 'client_request_id required', code: 'attempt_id_required' }, 400);

    if (!kind || (kind !== 'unit' && kind !== 'booking')) {
      return reply({ error: 'kind must be "unit" or "booking"' }, 400);
    }
    if (!recipient_email || !/^\S+@\S+\.\S+$/.test(recipient_email)) {
      return reply({ error: 'A valid recipient email is required.' }, 400);
    }

    // Resolve price + business from the item/service.
    let pricePence: number | null = null;
    let businessId: string | null = null;
    let itemLabel = '';

    if (kind === 'unit') {
      if (!unit_item_id) return reply({ error: 'unit_item_id required for unit gifts' }, 400);
      const { data: item } = await supabase
        .from('book_unit_items')
        .select('id, business_id, name, price_pence, stock, is_active')
        .eq('id', unit_item_id)
        .single();
      if (!item || !item.is_active) return reply({ error: 'Item not available' }, 404);
      if (item.stock !== null && item.stock <= 0) return reply({ error: 'stock_exhausted' }, 409);
      pricePence = item.price_pence;
      businessId = item.business_id;
      itemLabel  = item.name;
    } else {
      if (!service_id) return reply({ error: 'service_id required for booking gifts' }, 400);
      const { data: svc } = await supabase
        .from('book_services')
        .select('id, business_id, name, price_pence, is_active')
        .eq('id', service_id)
        .single();
      if (!svc || !svc.is_active || svc.price_pence <= 0) return reply({ error: 'Service not available for gifting' }, 404);
      pricePence = svc.price_pence;
      businessId = svc.business_id;
      itemLabel  = svc.name;
    }

    // Where does this business's money go for a gift? The same rule products
    // and event tickets already use: the business's own Connect account when
    // it has one, otherwise the owner's central account. This used to read
    // stripe_account_id/payout_enabled directly, which has no such fallback
    // and wrongly refused a business that only sells through its owner's
    // central account. business_payout_destination is that one rule, shared
    // with events and products.
    const { data: payoutRows, error: payoutErr } = await supabase.rpc('business_payout_destination', { p_business: businessId });
    if (payoutErr) return reply({ error: 'Could not check this business’s payment setup. Please try again.' }, 503);
    const giftPayout = Array.isArray(payoutRows) ? payoutRows[0] : payoutRows;
    const giftSellerAccountId: string | null = giftPayout?.account_id ?? null;
    // Demo businesses (slug 'demo-…') exist only for testing and may have no
    // real Stripe Connect account or owner account either — in test mode we
    // charge the platform directly (no destination transfer). Real
    // businesses must resolve to a real payout destination.
    const isDemoBiz = giftPayout?.is_demo === true;
    const giftHasAccount = !!giftSellerAccountId;
    if (!isDemoBiz && !giftHasAccount) return reply({ error: "This business isn't set up to take payments yet." }, 409);
    // ── You cannot pay yourself ───────────────────────────────────────────────
    // A gift sends the price (less commission) to the seller's connected account — by Connect transfer from the wallet, by
    // destination charge from a card. If the buyer controls that account — directly, through a second hub or business pointing at
    // it, or as the owner whose central account a business with no account of its own is paid into — the route is: pay for a gift
    // of your own → the money lands in YOUR account → charge it back. Asked of the DESTINATION ACCOUNT, exactly as wallet-checkout,
    // the till and the card membership do.
    //
    // Before the gift row exists, before any debit and before any PaymentIntent: a refusal creates nothing and costs nothing. A
    // demo business (no account) is not asked.
    {
      const selfPay = await selfPaymentBlock(supabase, user.id, giftSellerAccountId, pay_with_wallet ? 'wallet' : 'card');
      if (selfPay) return reply(selfPay.body, selfPay.status);
    }

    // Platform commission — admin-editable, see fees.gift.* in admin_config.
    // Default 5% (matches the previous hardcoded rate).
    const giftCfg = await getCommissionConfig(supabase, 'gift');
    const giftPlatformFee = calculateCommission(pricePence!, giftCfg, 'gift').fee_pence;

    // ── How this attempt pays — resolved BEFORE the claim, because it is part of the attempt ───────────
    // Asking for the saved card is a PREFERENCE, not an assertion that one
    // exists. A first-time buyer has no card on file, and turning that into
    // "No saved card found" made a first purchase impossible — the client had
    // no way to ask for the card form instead. Having no card is not an error;
    // it means the card form is the right screen. A saved card that FAILS
    // still errors further down, because that is a different thing.
    let customerId: string | null = null;
    let pmId: string | null = null;
    if (!pay_with_wallet && use_saved_card) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();
      customerId = profile?.stripe_customer_id ?? null;
      pmId = customerId ? await listSavedCard(customerId) : null;
    }
    const payMode = payModeFor({ wallet: !!pay_with_wallet, savedCard: !!(customerId && pmId) });

    // ── Claim the attempt (atomic): write the pending gift, or resolve a repeat to the one that exists ──────
    const { data: claim, error: claimErr } = await supabase.rpc('claim_gift_purchase', {
      p_purchaser: user.id, p_client_request_id: client_request_id, p_pay_mode: payMode,
      p_kind: kind, p_unit_item_id: kind === 'unit' ? unit_item_id : null, p_service_id: kind === 'booking' ? service_id : null,
      p_business_id: businessId,
      p_recipient_email: recipient_email.toLowerCase().trim(),
      p_recipient_name: recipient_name?.trim() || null,
      p_message: message?.trim().slice(0, 500) || null,
      p_price_pence: pricePence,
    });
    if (claimErr) {
      const mapped = mapClaimError(claimErr.message);
      if (mapped) return reply(mapped.body, mapped.status);
      console.error('[create-gift-intent] claim failed', claimErr);
      return reply({ error: 'Could not start gift.' }, 500);
    }
    const giftId: string = claim.gift_id;

    if (claim.status === 'cancelled') return reply(EXPIRED_BODY, 409);
    // Already paid and sent (or claimed / used): a repeat of a purchase that went through. Nothing to charge, nothing to resend.
    if (claim.status !== 'pending_payment') {
      return reply({ charged: true, payment_intent_id: claim.payment_intent_id ?? undefined, gift_id: giftId, replayed: true });
    }

    /** What the caller should be told about a PaymentIntent this attempt already started. */
    const respondForIntent = async (pi: Record<string, any>) => {
      const outcome = classifyIntent(pi);
      if (outcome.kind === 'succeeded') return reply({ charged: true, payment_intent_id: pi.id, gift_id: giftId, replayed: true });
      if (outcome.kind === 'processing') return reply({ status: 'processing', payment_intent_id: outcome.id, gift_id: giftId });
      if (outcome.kind === 'requires_action') return reply({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id, gift_id: giftId });
      // An unfinished card FORM payment is resumed with the same client secret; a saved-card intent in this state was declined.
      if (payMode === 'card_form' && ['requires_payment_method', 'requires_confirmation'].includes(pi.status) && pi.client_secret) {
        return reply({ clientSecret: pi.client_secret, payment_intent_id: pi.id, gift_id: giftId });
      }
      await supabase.rpc('cancel_pending_gift', { p_gift: giftId });
      return reply({ status: 'failed', error: failureMessage(outcome.status) }, 402);
    };

    // A card payment this attempt already started: resume it, never start another.
    if (payMode !== 'wallet' && claim.payment_intent_id) {
      return await respondForIntent(await retrievePaymentIntent(String(claim.payment_intent_id)));
    }
    // A wallet gift whose debit already went through (the reference is stamped only AFTER a successful debit + transfer).
    if (payMode === 'wallet' && claim.payment_intent_id) {
      return reply({ charged: true, payment_intent_id: claim.payment_intent_id, gift_id: giftId, replayed: true });
    }

    // ── Single-flight the money-moving step ────────────────────────────────────────
    // Whoever holds the lease creates the PaymentIntent / runs the wallet debit; a concurrent repeat is told to wait and moves
    // nothing. The lease goes stale after 90 s, and the Stripe and wallet keys below make a takeover safe.
    const { data: leased } = await supabase.rpc('claim_purchase_processing', { p_kind: 'gift', p_id: giftId });
    if (leased !== true) return reply(IN_PROGRESS_BODY, 409);
    try {
      // The previous holder may have finished between our claim and our lease: look again before moving money.
      const { data: fresh } = await supabase.from('book_gifts').select('payment_intent_id, status').eq('id', giftId).maybeSingle();
      if (fresh && fresh.status !== 'pending_payment') {
        return fresh.status === 'cancelled'
          ? reply(EXPIRED_BODY, 409)
          : reply({ charged: true, payment_intent_id: fresh.payment_intent_id ?? undefined, gift_id: giftId, replayed: true });
      }
      if (fresh?.payment_intent_id) {
        return payMode === 'wallet'
          ? reply({ charged: true, payment_intent_id: fresh.payment_intent_id, gift_id: giftId, replayed: true })
          : await respondForIntent(await retrievePaymentIntent(String(fresh.payment_intent_id)));
      }

      // ── Mode 0: pay from wallet (debit + transfer to the business, no card) ──
      if (payMode === 'wallet') {
        // Debit and ledger in one transaction, keyed on the gift row. The key is the gift id, which is now the same on every
        // repeat of this attempt, so a second run finds the debit already applied and neither takes the money nor makes the
        // transfer again. Demo businesses have no connected account, so the transfer is skipped and the wallet debit alone
        // funds the platform.
        const settleWallet = () => debitAndTransfer(supabase, {
          userId:           user.id,
          spendPence:       pricePence!,
          businessId,
          description:      `Gift — ${itemLabel}`,
          idempotencyKey:   `gift:${giftId}`,
          platformFeePence: giftPlatformFee,
          transfer: giftHasAccount ? {
            destination: giftSellerAccountId!,
            amountPence: pricePence! - giftPlatformFee,
            description: `OneShetland wallet gift — ${itemLabel}`,
            metadata: { type: 'gift_purchase_wallet', gift_id: giftId, buyer_id: user.id },
          } : undefined,
        });

        // Same liquidity gate as every Wallet merchant payment: the transfer to the
        // business comes out of the pooled Stripe balance. Refused BEFORE the
        // debit, so the buyer is not charged. The attempt is CANCELLED rather than deleted: a concurrent repeat must never
        // find the row it is working on gone.
        const gate = await withWalletLiquidityGate(supabase, giftHasAccount ? pricePence! - giftPlatformFee : 0, settleWallet);
        if (!gate.ok) {
          await supabase.rpc('cancel_pending_gift', { p_gift: giftId });
          return reply({ error: gate.error, reason: gate.reason }, gate.status);
        }
        const paid = gate.value;

        if (!paid.ok) {
          await supabase.rpc('cancel_pending_gift', { p_gift: giftId });
          const msg = paid.reason === 'insufficient'
            ? 'Not enough in your wallet — top up or pay by card.'
            : paid.error;
          return reply({ error: msg }, paid.status);
        }

        const ref = `wallet_${paid.transactionId}`;
        await supabase.from('book_gifts').update({ payment_intent_id: ref }).eq('id', giftId).is('payment_intent_id', null);
        return reply({ charged: true, payment_intent_id: ref, gift_id: giftId });
      }

      const baseParams: Record<string, string> = {
        amount:      String(pricePence!),
        currency:    'gbp',
        description: `OneShetland gift — ${itemLabel}`,
        'metadata[type]':        'gift_purchase',
        'metadata[gift_id]':     giftId,
        'metadata[kind]':        kind,
        'metadata[business_id]': businessId!,
        'metadata[buyer_id]':    user.id,
      };
      // Route to the resolved payout destination only when there is one (a
      // real, payout-ready business — its own account or its owner's central
      // one). Demo businesses with no resolved account → charge the platform.
      if (giftHasAccount) {
        baseParams['transfer_data[destination]'] = giftSellerAccountId!;
        baseParams['application_fee_amount']      = String(giftPlatformFee);
      }
      // The Stripe idempotency key comes from the GIFT ROW the database returned — never from anything the client sent. Every
      // repeat of this attempt resolves to the same gift id, so every repeat asks Stripe for the same object and gets it.
      const stripeKey = `gift-${giftId}`;

      // ── Mode 1: saved card, on-session ───────────────────────────────────────
      if (payMode === 'card_saved' && customerId && pmId) {
        let paymentIntent: Record<string, any>;
        try {
          paymentIntent = await createPaymentIntentOnce({ ...baseParams, ...onSessionConfirm(customerId, pmId) }, stripeKey);
        } catch (e) {
          // The issuer refused the card. Stripe answers the same way for this key every time, so this attempt is over.
          if (isCardDecline(e)) {
            await supabase.rpc('cancel_pending_gift', { p_gift: giftId });
            return reply({ status: 'failed', error: failureMessage('requires_payment_method') }, 402);
          }
          throw e;
        }
        // Bind the intent to the gift BEFORE any branch returns, so confirm-gift can find it idempotently and a repeat resumes
        // THIS intent instead of making another.
        await supabase.from('book_gifts').update({ payment_intent_id: paymentIntent.id }).eq('id', giftId).is('payment_intent_id', null);

        const outcome = classifyIntent(paymentIntent);
        if (outcome.kind === 'requires_action') {
          // The issuer wants the cardholder to authenticate. That is the middle of a
          // payment, not the end of one: hand back THIS intent's client secret so the
          // SDK can finish it. No second PaymentIntent, and nothing is fulfilled yet.
          return reply({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id, gift_id: giftId });
        }
        if (outcome.kind === 'processing') {
          // Stripe has it and has not settled. The webhook fulfils when it resolves.
          return reply({ status: 'processing', payment_intent_id: outcome.id, gift_id: giftId });
        }
        if (outcome.kind !== 'succeeded') {
          await supabase.rpc('cancel_pending_gift', { p_gift: giftId });
          return reply({ status: 'failed', error: failureMessage(outcome.status) }, 402);
        }
        return reply({ charged: true, payment_intent_id: paymentIntent.id, gift_id: giftId });
      }

      // ── Mode 2: PaymentSheet (no saved card) ─────────────────────────────────
      const paymentIntent = await createPaymentIntentOnce({ ...baseParams, 'automatic_payment_methods[enabled]': 'true' }, stripeKey);
      await supabase.from('book_gifts').update({ payment_intent_id: paymentIntent.id }).eq('id', giftId).is('payment_intent_id', null);

      return reply({
        clientSecret:      paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        gift_id:           giftId,
      });
    } finally {
      // Best-effort: a stale lease expires on its own, but there is no reason to make a retry wait for it.
      try { await supabase.rpc('release_purchase_processing', { p_kind: 'gift', p_id: giftId }); } catch { /* the lease expires */ }
    }

  } catch (err) {
    console.error('[create-gift-intent]', err);
    return reply({ error: safeError('create-gift-intent', err) }, 500);
  }
});

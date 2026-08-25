import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { debitAndTransfer, walletReverse, claimAttempt, settleAttempt,
         attemptFingerprint, attemptBlockedResponse, selfPaymentBlock } from '../_shared/wallet-ledger.ts';

const STRIPE_API_VERSION = '2023-10-16';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * wallet-checkout
 *
 * Pay for things using the OneShetland wallet instead of a card. The wallet is
 * pre-funded (top-ups sit in the platform Stripe balance), so paying = debit the
 * wallet + transfer the money to the recipient's connected account (no card
 * charge, no Stripe processing fee). Mirrors local-wallet-pay's debit→transfer→
 * refund-on-failure pattern, but for app pay gates rather than in-store codes.
 *
 * Body: { type, ...type-specific fields }
 *   type='hub_donation': { campaign_id, amount_pence, message?, anonymous?, gift_aid? }
 *   (more types added incrementally: hub_membership, unit_purchase, event_ticket, gift, booking, shift_boost)
 *
 * Returns: { ok: true, balance_pence, ...type-specific } or { error }.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const body = await req.json();
    const type = body?.type as string;

    // ── Attempt reference ────────────────────────────────────────────────
    //
    // REQUIRED. Without one, every flow below called the debit primitive with a
    // null idempotency key, so a double tap was two purchases — reproduced
    // against the production schema: two 1000p debits, two ledger rows, 2000p
    // gone for one thing bought.
    //
    // Validated here, before anything is read, resolved or charged. Objects and
    // arrays are rejected rather than stringified into a key that would differ
    // between two identical taps.
    const rid = body?.client_request_id;
    if (typeof rid !== 'string' || rid.trim().length < 8 || rid.length > 128) {
      return json({ error: 'A valid payment reference is required.' }, 400);
    }

    switch (type) {
      case 'hub_donation':   return await hubDonation(svc, user.id, body, rid);
      case 'hub_membership': return await hubMembership(svc, user.id, body, rid);
      case 'unit_purchase':  return await unitPurchase(svc, user.id, body, rid);
      case 'shift_boost':    return await shiftBoost(svc, user.id, body, rid);
      default:
        return json({ error: `Wallet payment isn't available for "${type}" yet.` }, 400);
    }
  } catch (err) {
    console.error('[wallet-checkout]', err);
    return json({ error: safeError('wallet-checkout', err) }, 500);
  }
});

/** Why a campaign cannot take a donation — same words the card path uses. */
const CAMPAIGN_INELIGIBLE: Record<string, string> = {
  closed:     'This campaign has closed, so it is no longer accepting donations.',
  not_active: 'This campaign is not accepting donations.',
  ended:      'This campaign has ended, so it is no longer accepting donations.',
};

/** Why a shift cannot be boosted — same words the card path uses. */
const BOOST_INELIGIBLE: Record<string, string> = {
  cancelled:       'This shift has been cancelled, so it cannot be boosted.',
  completed:       'This shift is complete, so it cannot be boosted.',
  filled:          'Every position on this shift is filled, so there is nothing to promote.',
  draft:           'Post this shift before boosting it.',
  not_open:        'This shift is not open, so it cannot be boosted.',
  ended:           'This shift has already finished, so boosting it would promote nothing.',
  already_boosted: 'This shift is already boosted. You can boost it again once that runs out.',
};

// ── hub_donation ────────────────────────────────────────────────────────────
async function hubDonation(svc: any, userId: string, body: any, rid: string): Promise<Response> {
  const campaignId = body.campaign_id as string;
  const amount = Math.round(Number(body.amount_pence));
  const message = body.message ? String(body.message).slice(0, 280) : null;
  const anonymous = !!body.anonymous;
  const giftAidIn = body.gift_aid ?? null;

  if (!campaignId) return json({ error: 'campaign_id required' }, 400);
  if (!Number.isFinite(amount) || amount < 100 || amount > 1_000_000) {
    return json({ error: 'Amount must be between £1 and £10,000.' }, 400);
  }

  // The SAME eligibility rule the card path uses, from the same SQL function
  // and the same database clock: active AND not past its end date. Checked
  // BEFORE the wallet is debited, so an ended campaign costs nobody anything.
  const { data: eligRows, error: eligErr } = await svc.rpc('campaign_donation_eligibility', { p_campaign: campaignId });
  if (eligErr) throw eligErr;
  const elig = Array.isArray(eligRows) ? eligRows[0] : eligRows;
  if (!elig || elig.reason === 'campaign_not_found') return json({ error: 'This campaign is not accepting donations.' }, 400);
  if (!elig.eligible) {
    return json({ error: CAMPAIGN_INELIGIBLE[elig.reason] ?? 'This campaign is not accepting donations.', reason: elig.reason }, 409);
  }
  const campaign = { id: elig.campaign_id, hub_id: elig.hub_id };

  const { data: hub } = await svc.from('hubs')
    .select('id, name, stripe_account_id, payout_enabled, is_charity, charity_number')
    .eq('id', campaign.hub_id).maybeSingle();
  if (!hub) return json({ error: 'Hub not found.' }, 404);
  if (!hub.stripe_account_id || !hub.payout_enabled) {
    return json({ error: 'This hub has not finished setting up payouts yet.' }, 400);
  }

  // Gift Aid (charity hubs only) — validate the postcode like confirm-hub-donation.
  const charityEligible = !!hub.is_charity && !!hub.charity_number;
  let ga = null;
  if (charityEligible && giftAidIn && giftAidIn.first_name && giftAidIn.last_name && giftAidIn.address && giftAidIn.postcode) {
    const pc = normaliseUkPostcode(String(giftAidIn.postcode));
    if (!pc) return json({ error: "That doesn't look like a valid UK postcode — please check it so your Gift Aid can be claimed." }, 400);
    ga = { ...giftAidIn, postcode: pc };
  }


  // Money must not go back to the person paying. Checked on the DESTINATION
  // ACCOUNT — a connected account can belong to more than one resource — and
  // BEFORE the attempt is claimed, so a refusal costs nothing and the same
  // reference works for a legitimate recipient.
  const selfPayDon = await selfPaymentBlock(svc, userId, hub.stripe_account_id);
  if (selfPayDon) return json(selfPayDon.body, selfPayDon.status);

  // Claim the attempt, bound to what it is FOR. The fingerprint uses the
  // resolved hub and the validated amount, so this reference cannot later be
  // replayed against a different campaign or a different sum.
  const attempt = await claimAttempt(svc, rid, userId,
    await attemptFingerprint([userId, 'hub_donation', hub.id, campaignId, amount]));
  const blocked = attemptBlockedResponse(attempt);
  if (blocked) return json(blocked.body, blocked.status);

  // Debit + ledger in one transaction, then transfer keyed on that ledger row.
  // No platform fee on wallet donations — the money is already on the platform
  // from the top-up.
  const paid = await debitAndTransfer(svc, {
    userId, spendPence: amount,
    description: `Donation to ${hub.name}`,
    idempotencyKey: `wallet-attempt:${rid}`,
    transfer: {
      destination: hub.stripe_account_id,
      amountPence: amount,
      description: `OneShetland wallet donation to ${hub.name}`,
      metadata: { type: 'hub_donation_wallet', user_id: userId, campaign_id: campaignId },
    },
  });
  if (!paid.ok) {
    // 'unresolved' keeps the attempt alive and pointing at the transaction, so a
    // retry resumes THAT transfer. It is never released — Stripe may have moved
    // the money, and a released reference would start a second payment.
    await settleAttempt(svc, rid, paid.reason === 'unresolved' ? 'unresolved' : 'failed', paid.transactionId ?? null);
    return json({ error: paid.error }, paid.status);
  }
  const newBalance = paid.balancePence;
  const transferId = paid.transferId;

  // Record the donation (+ Gift Aid). The reference is OUR wallet transaction
  // id, not the Stripe transfer id: it exists before the transfer is attempted
  // and is stable across retries, so the donation's own unique constraint keys
  // on something that cannot change underneath it.
  const ref = `wallet_${paid.transactionId}`;
  const { error: rpcErr } = await svc.rpc('record_hub_donation', {
    p_campaign: campaignId, p_hub: hub.id, p_user: userId,
    p_amount: amount, p_fee: 0, p_message: message, p_anon: anonymous,
    p_pi: ref, p_gift_aid: !!ga,
    p_title: ga?.title ?? null, p_first: ga?.first_name ?? null, p_last: ga?.last_name ?? null,
    p_address: ga?.address ?? null, p_postcode: ga?.postcode ?? null,
  });
  if (rpcErr) {
    // Money moved but the entitlement could not be granted. refundUnfulfilled
    // appends a linked reversal; the attempt becomes terminal so a retry of the
    // same reference returns that outcome instead of paying again.
    await settleAttempt(svc, rid, 'reversed', paid.transactionId);
    return await refundUnfulfilled(svc, {
      userId, refundPence: amount, transferId, walletTransactionId: paid.transactionId, purpose: 'hub_donation',
      recipientId: hub.id, detail: { campaign_id: campaignId }, cause: rpcErr,
    });
  }

  // No ledger insert here any more — debitAndTransfer already wrote it, in the
  // same transaction as the balance change. This insert used to be the last
  // step, unchecked, after two other awaits that could throw first.
  const payload = { ok: true, balance_pence: newBalance, gift_aid: !!ga };
  await settleAttempt(svc, rid, 'completed', paid.transactionId, payload);
  return json(payload);
}

// ── hub_membership ──────────────────────────────────────────────────────────
async function hubMembership(svc: any, userId: string, body: any, rid: string): Promise<Response> {
  const typeId = body.membership_type_id as string;
  if (!typeId) return json({ error: 'membership_type_id required' }, 400);

  const { data: t } = await svc.from('hub_membership_types')
    .select('id, hub_id, name, price_pence, period, is_active').eq('id', typeId).maybeSingle();
  if (!t || !t.is_active) return json({ error: 'Membership tier not available.' }, 400);
  if (t.price_pence <= 0) return json({ error: 'This tier is free — join directly.' }, 400);

  const { data: hub } = await svc.from('hubs')
    .select('id, name, stripe_account_id, payout_enabled').eq('id', t.hub_id).maybeSingle();
  if (!hub) return json({ error: 'Hub not found.' }, 404);
  if (!hub.stripe_account_id || !hub.payout_enabled) return json({ error: 'This hub has not finished setting up payouts yet.' }, 400);

  // The SAME fee the card path uses, from the same rail. This used to read
  // fees.hub_membership.flat_pence — a key only this route knew about, set to
  // 50 — so the identical £10 membership cost £10.95 by card and £10.50 by
  // wallet, and nobody had decided that. One source now: change
  // fees.membership.fixed_pence and both routes move together.
  //
  // Added on top, so the hub still receives the full membership price and the
  // customer covers the fee — exactly as on card.
  const membershipCfg = await getCommissionConfig(svc, 'membership');
  const flatFee = calculateCommission(t.price_pence, membershipCfg, 'membership').fee_pence;
  const debitTotal = t.price_pence + flatFee;

  // The customer is debited price + platform fee; only the price is transferred
  // to the hub. The fee stays on the platform, so the two amounts differ.

  // Money must not go back to the person paying. Checked on the DESTINATION
  // ACCOUNT — a connected account can belong to more than one resource — and
  // BEFORE the attempt is claimed, so a refusal costs nothing and the same
  // reference works for a legitimate recipient.
  const selfPayMem = await selfPaymentBlock(svc, userId, hub.stripe_account_id);
  if (selfPayMem) return json(selfPayMem.body, selfPayMem.status);

  const attempt = await claimAttempt(svc, rid, userId,
    await attemptFingerprint([userId, 'hub_membership', hub.id, t.id, debitTotal]));
  const blocked = attemptBlockedResponse(attempt);
  if (blocked) return json(blocked.body, blocked.status);

  const paid = await debitAndTransfer(svc, {
    userId, spendPence: debitTotal,
    description: `Membership · ${hub.name}`,
    idempotencyKey: `wallet-attempt:${rid}`,
    platformFeePence: flatFee,
    transfer: {
      destination: hub.stripe_account_id,
      amountPence: t.price_pence,
      description: `OneShetland wallet membership · ${hub.name}`,
      metadata: { type: 'hub_membership_wallet', user_id: userId, hub_id: hub.id, membership_type_id: t.id },
    },
  });
  if (!paid.ok) {
    await settleAttempt(svc, rid, paid.reason === 'unresolved' ? 'unresolved' : 'failed', paid.transactionId ?? null);
    return json({ error: paid.error }, paid.status);
  }
  const newBalance = paid.balancePence;
  const transferId = paid.transferId;

  const { data: result, error: rpcErr } = await svc.rpc('activate_hub_membership', {
    p_hub: hub.id, p_user: userId, p_type: t.id, p_period: t.period,
    p_payment_pence: t.price_pence, p_pi: `wallet_${paid.transactionId}`,
  });
  if (rpcErr) {
    await settleAttempt(svc, rid, 'reversed', paid.transactionId);
    return await refundUnfulfilled(svc, {
      userId, refundPence: debitTotal, transferId, walletTransactionId: paid.transactionId, purpose: 'hub_membership',
      recipientId: hub.id, detail: { membership_type_id: t.id }, cause: rpcErr,
    });
  }

  // Ledger row already written by debitAndTransfer, in the same transaction as
  // the balance change.
  const payload = { ok: true, balance_pence: newBalance, member_no: result?.member_no ?? null, paid_until: result?.paid_until ?? null };
  await settleAttempt(svc, rid, 'completed', paid.transactionId, payload);
  return json(payload);
}

// ── unit_purchase ───────────────────────────────────────────────────────────
async function unitPurchase(svc: any, userId: string, body: any, rid: string): Promise<Response> {
  const itemId = body.unit_item_id as string;
  if (!itemId) return json({ error: 'unit_item_id required' }, 400);

  const { data: item } = await svc.from('book_unit_items')
    .select('id, name, business_id, price_pence, stock, is_active, uses_per_purchase, valid_days').eq('id', itemId).maybeSingle();
  if (!item || !item.is_active) return json({ error: 'This item is not available.' }, 400);
  if (item.stock != null && item.stock <= 0) return json({ error: 'Sold out.' }, 409);

  const { data: biz } = await svc.from('local_businesses')
    .select('id, name, stripe_account_id, payout_enabled').eq('id', item.business_id).maybeSingle();
  if (!biz?.stripe_account_id || !biz.payout_enabled) return json({ error: 'This business has not finished setting up payouts yet.' }, 400);

  const fee = Math.round(item.price_pence * 0.05); // 5% platform fee, matching the card flow
  const toBusiness = item.price_pence - fee;


  // Money must not go back to the person paying. Checked on the DESTINATION
  // ACCOUNT — a connected account can belong to more than one resource — and
  // BEFORE the attempt is claimed, so a refusal costs nothing and the same
  // reference works for a legitimate recipient.
  const selfPayUnit = await selfPaymentBlock(svc, userId, biz.stripe_account_id);
  if (selfPayUnit) return json(selfPayUnit.body, selfPayUnit.status);

  const attempt = await claimAttempt(svc, rid, userId,
    await attemptFingerprint([userId, 'unit_purchase', biz.id, item.id, item.price_pence]));
  const blocked = attemptBlockedResponse(attempt);
  if (blocked) return json(blocked.body, blocked.status);

  const paid = await debitAndTransfer(svc, {
    userId, spendPence: item.price_pence,
    businessId: biz.id,
    description: `${item.name} · ${biz.name}`,
    idempotencyKey: `wallet-attempt:${rid}`,
    platformFeePence: fee,
    transfer: {
      destination: biz.stripe_account_id,
      amountPence: toBusiness,
      description: `OneShetland wallet purchase · ${item.name}`,
      metadata: { type: 'unit_purchase_wallet', user_id: userId, business_id: biz.id, unit_item_id: item.id, fee_pence: String(fee) },
    },
  });
  if (!paid.ok) {
    await settleAttempt(svc, rid, paid.reason === 'unresolved' ? 'unresolved' : 'failed', paid.transactionId ?? null);
    return json({ error: paid.error }, paid.status);
  }
  const newBalance = paid.balancePence;
  const transferId = paid.transferId;

  const expiresAt = item.valid_days ? new Date(Date.now() + item.valid_days * 86_400_000).toISOString() : null;
  const { data: purchase, error: insErr } = await svc.from('book_unit_purchases').insert({
    item_id: item.id, business_id: item.business_id, owner_id: userId,
    paid_amount_pence: item.price_pence, uses_remaining: item.uses_per_purchase,
    payment_intent_id: `wallet_${paid.transactionId}`, expires_at: expiresAt,
  }).select('id, uses_remaining, expires_at').single();
  if (insErr) {
    await settleAttempt(svc, rid, 'reversed', paid.transactionId);
    return await refundUnfulfilled(svc, {
      userId, refundPence: item.price_pence, transferId, walletTransactionId: paid.transactionId, purpose: 'unit_purchase',
      recipientId: item.business_id, detail: { unit_item_id: item.id }, cause: insErr,
    });
  }

  // Ledger row already written by debitAndTransfer.
  const payload = { ok: true, balance_pence: newBalance, purchase_id: purchase?.id ?? null, uses_remaining: purchase?.uses_remaining ?? null, expires_at: purchase?.expires_at ?? null };
  await settleAttempt(svc, rid, 'completed', paid.transactionId, payload);
  return json(payload);
}

// ── shift_boost (platform revenue — no transfer) ────────────────────────────
async function shiftBoost(svc: any, userId: string, body: any, rid: string): Promise<Response> {
  const shiftId = body.shift_id as string;
  if (!shiftId) return json({ error: 'shift_id required' }, 400);

  // The SAME rule the card path uses, from the same SQL function, judged
  // against the same database clock. Wallet and card cannot drift apart,
  // because there is only one definition to drift from.
  const { data: eligRows, error: eligErr } = await svc.rpc('shift_boost_eligibility', { p_shift: shiftId });
  if (eligErr) throw eligErr;
  const shift = Array.isArray(eligRows) ? eligRows[0] : eligRows;

  if (!shift || shift.reason === 'shift_not_found') return json({ error: 'Shift not found.' }, 404);
  if (shift.employer_id !== userId) return json({ error: 'You can only boost your own shifts.' }, 403);
  if (!shift.eligible) return json({ error: BOOST_INELIGIBLE[shift.reason] ?? 'This shift cannot be boosted.', reason: shift.reason }, 409);

  const PRICE = 299;
  // The platform keeps the £2.99, so there is no connected-account transfer —
  // but the debit and its accounting entry are still one transaction.
  const attempt = await claimAttempt(svc, rid, userId,
    await attemptFingerprint([userId, 'shift_boost', shiftId, PRICE]));
  const blocked = attemptBlockedResponse(attempt);
  if (blocked) return json(blocked.body, blocked.status);

  const paid = await debitAndTransfer(svc, {
    userId, spendPence: PRICE,
    description: 'Shift boost (24h)',
    idempotencyKey: `wallet-attempt:${rid}`,
    platformFeePence: PRICE,
  });
  if (!paid.ok) {
    await settleAttempt(svc, rid, paid.reason === 'unresolved' ? 'unresolved' : 'failed', paid.transactionId ?? null);
    return json({ error: paid.error }, paid.status);
  }

  // Entitlement and receipt in one transaction, keyed on this attempt — so a
  // retry resolves to the receipt it already wrote instead of buying a second
  // 24 hours, and a failure leaves neither behind for the reversal below to
  // contradict. The debit and the reversal are unchanged.
  const { data: granted, error: updErr } = await svc
    .rpc('grant_wallet_shift_boost', {
      p_shift: shiftId, p_employer: userId, p_rid: rid, p_amount: PRICE,
    })
    .maybeSingle();
  const boostedUntil = (granted as { boosted_until?: string } | null)?.boosted_until ?? null;
  if (updErr || !boostedUntil) {
    // The entitlement could not be granted, so put the money back — as an
    // appended reversal linked to the debit, not by editing it away.
    await walletReverse(svc, paid.transactionId, 'Shift boost could not be applied');
    await settleAttempt(svc, rid, 'reversed', paid.transactionId);
    return json({ error: 'Could not boost the shift — your wallet has been refunded.' }, 500);
  }

  const payload = { ok: true, balance_pence: paid.balancePence, boosted_until: boostedUntil };
  await settleAttempt(svc, rid, 'completed', paid.transactionId, payload);
  return json(payload);
}

// Reverse a Stripe Connect transfer in full (used when a purchase's money moved
// but the entitlement couldn't be granted). Idempotent on the transfer id.
async function reverseTransfer(transferId: string): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/transfers/${transferId}/reversals`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': `reverse_${transferId}`,
    },
    body: new URLSearchParams({ description: 'OneShetland: purchase could not be completed' }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `Transfer reversal failed (HTTP ${res.status})`);
}

/**
 * The money moved (wallet debited + transfer sent) but granting the entitlement
 * failed. Make the customer whole: reverse the transfer, refund the wallet, and
 * record the outcome in failed_fulfilments so nothing is ever silently lost.
 * Returns the Response to send the customer.
 */
async function refundUnfulfilled(svc: any, o: {
  userId: string; refundPence: number; transferId: string | null;
  /** The wallet ledger row this purchase debited, so the reversal can point at it. */
  walletTransactionId: string;
  purpose: string; recipientId: string | null; detail: Record<string, unknown>; cause: unknown;
}): Promise<Response> {
  let transferReversed = !o.transferId; // nothing to reverse counts as done
  let walletRefunded = false;

  if (o.transferId) {
    try { await reverseTransfer(o.transferId); transferReversed = true; }
    catch (e) { console.error(`[wallet-checkout] reverse transfer ${o.transferId} failed:`, e); }
  }
  // An appended, linked reversal rather than a bare credit — so the accounts
  // show the debit AND the refund, and a second attempt cannot refund twice.
  const back = await walletReverse(svc, o.walletTransactionId, `${o.purpose} could not be completed`);
  walletRefunded = back !== null;

  const fullyReversed = transferReversed && walletRefunded;
  try {
    await svc.from('failed_fulfilments').insert({
      user_id: o.userId, purpose: o.purpose, recipient_id: o.recipientId,
      amount_pence: o.refundPence, transfer_id: o.transferId,
      transfer_reversed: transferReversed, wallet_refunded: walletRefunded,
      resolved: fullyReversed,
      error: String((o.cause as { message?: string })?.message ?? o.cause).slice(0, 500),
      detail: o.detail,
    });
  } catch (e) { console.error('[wallet-checkout] failed_fulfilments insert failed:', e); }

  return json({
    error: fullyReversed
      ? "Something went wrong completing your purchase, so we've refunded you in full — you haven't been charged. Please try again."
      : "Something went wrong completing your purchase. We've been alerted and will make sure you're not left out of pocket — please contact us if anything looks off.",
  }, 502);
}

// Stripe Connect transfer (raw fetch, no SDK — matches local-wallet-pay).
async function stripeTransfer(destination: string, amount: number, description: string, meta: Record<string, string>): Promise<string> {
  const b = new URLSearchParams({ amount: String(amount), currency: 'gbp', destination, description });
  for (const [k, v] of Object.entries(meta)) b.set(`metadata[${k}]`, v);
  const res = await fetch('https://api.stripe.com/v1/transfers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: b,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `Stripe transfer failed (HTTP ${res.status})`);
  return j.id;
}

function normaliseUkPostcode(raw: string): string | null {
  const m = raw.toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

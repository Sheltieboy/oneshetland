import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    switch (type) {
      case 'hub_donation':   return await hubDonation(svc, user.id, body);
      case 'hub_membership': return await hubMembership(svc, user.id, body);
      case 'unit_purchase':  return await unitPurchase(svc, user.id, body);
      case 'shift_boost':    return await shiftBoost(svc, user.id, body);
      default:
        return json({ error: `Wallet payment isn't available for "${type}" yet.` }, 400);
    }
  } catch (err) {
    console.error('[wallet-checkout]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ── hub_donation ────────────────────────────────────────────────────────────
async function hubDonation(svc: any, userId: string, body: any): Promise<Response> {
  const campaignId = body.campaign_id as string;
  const amount = Math.round(Number(body.amount_pence));
  const message = body.message ? String(body.message).slice(0, 280) : null;
  const anonymous = !!body.anonymous;
  const giftAidIn = body.gift_aid ?? null;

  if (!campaignId) return json({ error: 'campaign_id required' }, 400);
  if (!Number.isFinite(amount) || amount < 100 || amount > 1_000_000) {
    return json({ error: 'Amount must be between £1 and £10,000.' }, 400);
  }

  // Campaign must be active; hub must be payout-ready.
  const { data: campaign } = await svc.from('hub_campaigns').select('id, hub_id, status').eq('id', campaignId).maybeSingle();
  if (!campaign || campaign.status !== 'active') return json({ error: 'This campaign is not accepting donations.' }, 400);

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

  // Debit the wallet (atomic; NULL = insufficient funds).
  const { data: newBalance, error: debitErr } = await svc.rpc('wallet_debit', { p_user: userId, p_spend: amount, p_cashback: 0 });
  if (debitErr) throw debitErr;
  if (newBalance == null) return json({ error: 'Not enough in your wallet — top up or pay by card.' }, 402);

  // Transfer the full donation to the hub's connected account (no platform fee on
  // wallet donations — the money is already on the platform from the top-up).
  let transferId: string | null = null;
  try {
    const tBody = new URLSearchParams({
      amount: String(amount),
      currency: 'gbp',
      destination: hub.stripe_account_id,
      description: `OneShetland wallet donation to ${hub.name}`,
      'metadata[type]': 'hub_donation_wallet',
      'metadata[user_id]': userId,
      'metadata[campaign_id]': campaignId,
    });
    const res = await fetch('https://api.stripe.com/v1/transfers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: tBody,
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message ?? `Stripe transfer failed (HTTP ${res.status})`);
    transferId = j.id;
  } catch (e) {
    console.error('[wallet-checkout] donation transfer failed:', e);
    await svc.rpc('wallet_credit', { p_user: userId, p_amount: amount }); // refund
    return json({ error: 'Donation failed — your wallet has been refunded.' }, 502);
  }

  // Record the donation (+ Gift Aid). A synthetic, unique reference stands in for
  // the (absent) PaymentIntent so the unique constraint + idempotency still hold.
  const ref = `wallet_${transferId}`;
  const { error: rpcErr } = await svc.rpc('record_hub_donation', {
    p_campaign: campaignId, p_hub: hub.id, p_user: userId,
    p_amount: amount, p_fee: 0, p_message: message, p_anon: anonymous,
    p_pi: ref, p_gift_aid: !!ga,
    p_title: ga?.title ?? null, p_first: ga?.first_name ?? null, p_last: ga?.last_name ?? null,
    p_address: ga?.address ?? null, p_postcode: ga?.postcode ?? null,
  });
  if (rpcErr) return await refundUnfulfilled(svc, {
    userId, refundPence: amount, transferId, purpose: 'hub_donation',
    recipientId: hub.id, detail: { campaign_id: campaignId }, cause: rpcErr,
  });

  await svc.from('local_wallet_transactions').insert({
    user_id: userId, business_id: null, type: 'spend', amount_pence: -amount,
    stripe_transfer_id: transferId, description: `Donation to ${hub.name}`,
  });

  return json({ ok: true, balance_pence: newBalance, gift_aid: !!ga });
}

// ── hub_membership ──────────────────────────────────────────────────────────
async function hubMembership(svc: any, userId: string, body: any): Promise<Response> {
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

  // Flat platform fee added on top (hub receives the full membership price), to
  // match the card flow. Wallet covers price + fee; hub gets price.
  const { data: feeRow } = await svc.from('admin_config').select('value').eq('key', 'fees.hub_membership.flat_pence').maybeSingle();
  const flatFee = Math.max(0, parseInt(feeRow?.value ?? '', 10) || 95);
  const debitTotal = t.price_pence + flatFee;

  const { data: newBalance, error: debitErr } = await svc.rpc('wallet_debit', { p_user: userId, p_spend: debitTotal, p_cashback: 0 });
  if (debitErr) throw debitErr;
  if (newBalance == null) return json({ error: 'Not enough in your wallet — top up or pay by card.' }, 402);

  let transferId: string;
  try {
    transferId = await stripeTransfer(hub.stripe_account_id, t.price_pence, `OneShetland wallet membership · ${hub.name}`,
      { type: 'hub_membership_wallet', user_id: userId, hub_id: hub.id, membership_type_id: t.id });
  } catch (e) {
    console.error('[wallet-checkout] membership transfer failed:', e);
    await svc.rpc('wallet_credit', { p_user: userId, p_amount: debitTotal });
    return json({ error: 'Membership payment failed — your wallet has been refunded.' }, 502);
  }

  const { data: result, error: rpcErr } = await svc.rpc('activate_hub_membership', {
    p_hub: hub.id, p_user: userId, p_type: t.id, p_period: t.period,
    p_payment_pence: t.price_pence, p_pi: `wallet_${transferId}`,
  });
  if (rpcErr) return await refundUnfulfilled(svc, {
    userId, refundPence: debitTotal, transferId, purpose: 'hub_membership',
    recipientId: hub.id, detail: { membership_type_id: t.id }, cause: rpcErr,
  });

  await svc.from('local_wallet_transactions').insert({
    user_id: userId, business_id: null, type: 'spend', amount_pence: -debitTotal,
    stripe_transfer_id: transferId, description: `Membership · ${hub.name}`,
  });

  return json({ ok: true, balance_pence: newBalance, member_no: result?.member_no ?? null, paid_until: result?.paid_until ?? null });
}

// ── unit_purchase ───────────────────────────────────────────────────────────
async function unitPurchase(svc: any, userId: string, body: any): Promise<Response> {
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

  const { data: newBalance, error: debitErr } = await svc.rpc('wallet_debit', { p_user: userId, p_spend: item.price_pence, p_cashback: 0 });
  if (debitErr) throw debitErr;
  if (newBalance == null) return json({ error: 'Not enough in your wallet — top up or pay by card.' }, 402);

  let transferId: string;
  try {
    transferId = await stripeTransfer(biz.stripe_account_id, toBusiness, `OneShetland wallet purchase · ${item.name}`,
      { type: 'unit_purchase_wallet', user_id: userId, business_id: biz.id, unit_item_id: item.id, fee_pence: String(fee) });
  } catch (e) {
    console.error('[wallet-checkout] unit transfer failed:', e);
    await svc.rpc('wallet_credit', { p_user: userId, p_amount: item.price_pence });
    return json({ error: 'Purchase failed — your wallet has been refunded.' }, 502);
  }

  const expiresAt = item.valid_days ? new Date(Date.now() + item.valid_days * 86_400_000).toISOString() : null;
  const { data: purchase, error: insErr } = await svc.from('book_unit_purchases').insert({
    item_id: item.id, business_id: item.business_id, owner_id: userId,
    paid_amount_pence: item.price_pence, uses_remaining: item.uses_per_purchase,
    payment_intent_id: `wallet_${transferId}`, expires_at: expiresAt,
  }).select('id, uses_remaining, expires_at').single();
  if (insErr) return await refundUnfulfilled(svc, {
    userId, refundPence: item.price_pence, transferId, purpose: 'unit_purchase',
    recipientId: item.business_id, detail: { unit_item_id: item.id }, cause: insErr,
  });

  await svc.from('local_wallet_transactions').insert({
    user_id: userId, business_id: biz.id, type: 'spend', amount_pence: -item.price_pence,
    stripe_transfer_id: transferId, description: `${item.name} · ${biz.name}`,
  });

  return json({ ok: true, balance_pence: newBalance, purchase_id: purchase?.id ?? null, uses_remaining: purchase?.uses_remaining ?? null, expires_at: purchase?.expires_at ?? null });
}

// ── shift_boost (platform revenue — no transfer) ────────────────────────────
async function shiftBoost(svc: any, userId: string, body: any): Promise<Response> {
  const shiftId = body.shift_id as string;
  if (!shiftId) return json({ error: 'shift_id required' }, 400);

  const { data: shift } = await svc.from('shifts').select('id, employer_id').eq('id', shiftId).maybeSingle();
  if (!shift) return json({ error: 'Shift not found.' }, 404);
  if (shift.employer_id !== userId) return json({ error: 'You can only boost your own shifts.' }, 403);

  const PRICE = 299;
  const { data: newBalance, error: debitErr } = await svc.rpc('wallet_debit', { p_user: userId, p_spend: PRICE, p_cashback: 0 });
  if (debitErr) throw debitErr;
  if (newBalance == null) return json({ error: 'Not enough in your wallet — top up or pay by card.' }, 402);

  // Platform keeps the £2.99 (no connected-account transfer needed).
  const boostedUntil = new Date(Date.now() + 86_400_000).toISOString();
  const { error: updErr } = await svc.from('shifts').update({ boosted_until: boostedUntil }).eq('id', shiftId);
  if (updErr) {
    await svc.rpc('wallet_credit', { p_user: userId, p_amount: PRICE });
    return json({ error: 'Could not boost the shift — your wallet has been refunded.' }, 500);
  }

  await svc.from('local_wallet_transactions').insert({
    user_id: userId, business_id: null, type: 'spend', amount_pence: -PRICE, description: 'Shift boost (24h)',
  });

  return json({ ok: true, balance_pence: newBalance, boosted_until: boostedUntil });
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
  purpose: string; recipientId: string | null; detail: Record<string, unknown>; cause: unknown;
}): Promise<Response> {
  let transferReversed = !o.transferId; // nothing to reverse counts as done
  let walletRefunded = false;

  if (o.transferId) {
    try { await reverseTransfer(o.transferId); transferReversed = true; }
    catch (e) { console.error(`[wallet-checkout] reverse transfer ${o.transferId} failed:`, e); }
  }
  try { await svc.rpc('wallet_credit', { p_user: o.userId, p_amount: o.refundPence }); walletRefunded = true; }
  catch (e) { console.error('[wallet-checkout] wallet refund failed:', e); }

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

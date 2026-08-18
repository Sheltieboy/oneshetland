/**
 * fulfilment.ts — shared, idempotent payment-fulfilment helpers
 *
 * WHY THIS EXISTS
 * ---------------
 * Most card payments are fulfilled when the CLIENT calls the matching
 * `confirm-*` edge function after Stripe's PaymentSheet succeeds. If the app is
 * backgrounded / killed / loses network in that window, the customer is charged
 * but never gets the thing. These helpers are the SAFETY NET: `stripe-webhook`
 * calls them on `payment_intent.succeeded` so fulfilment happens even when the
 * client never comes back.
 *
 * SAFE TO RUN ALONGSIDE THE confirm-* FUNCTIONS. Every grant here is idempotent
 * on the Stripe PaymentIntent id (DB UNIQUE constraints on
 * local_wallet_transactions / book_unit_purchases / event_ticket_orders /
 * hub_donations / hub_members, plus status guards for gifts). If both the client
 * confirm and this webhook run, only the first grants; the second is a no-op.
 *
 * These mirror the grant logic of the corresponding confirm-* functions — those
 * remain the primary path and are deliberately left untouched. Keep the two in
 * step if the grant logic ever changes. The webhook is already Stripe-signature
 * verified, so the PaymentIntent object it passes here is trusted (no re-fetch).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush, sendUserPushBulk } from './send-push.ts';
import { sendTicketReceipt } from './ticket-receipt.ts';
import { sendEmail } from './send-email.ts';

/** The subset of a Stripe PaymentIntent the webhook hands us. */
export interface FulfilPI {
  id:       string;
  amount:   number;
  metadata: Record<string, string>;
  status?:  string;
}

export interface FulfilResult {
  granted: boolean;   // true if THIS call performed the grant
  note:    string;    // short human-readable outcome (for logs)
}

const already = (what: string): FulfilResult => ({ granted: false, note: `already ${what}` });
const done    = (what: string): FulfilResult => ({ granted: true,  note: what });

// ── Wallet top-up ────────────────────────────────────────────────────────────
// Mirrors local-wallet-confirm-topup. Claims the PI by inserting the ledger row
// first (UNIQUE stripe_payment_intent_id); only the winner credits.
export async function fulfilWalletTopup(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const userId = pi.metadata.user_id;
  if (!userId) return { granted: false, note: 'no user_id' };

  const { error: ledgerErr } = await svc.from('local_wallet_transactions').insert({
    user_id: userId,
    type: 'topup',
    amount_pence: pi.amount,
    stripe_payment_intent_id: pi.id,
    description: 'Wallet top-up',
  });
  if (ledgerErr) {
    if (ledgerErr.code === '23505') return already('credited');
    throw ledgerErr;
  }

  const { data: newBalance, error: creditErr } = await svc.rpc('wallet_credit', { p_user: userId, p_amount: pi.amount });
  if (creditErr) throw creditErr;

  try {
    await sendUserPush(svc, {
      userId, module: 'wallet', categoryId: 'wallet.topup',
      title: 'Wallet topped up',
      body: `£${(pi.amount / 100).toFixed(2)} added to your wallet. New balance £${((newBalance ?? 0) / 100).toFixed(2)}.`,
      data: { screen: 'local-wallet' },
    });
  } catch (e) { console.error('[fulfil:topup] notify failed', e); }

  return done('credited wallet');
}

// ── Book unit / pass purchase ────────────────────────────────────────────────
// Mirrors confirm-unit-purchase.
export async function fulfilUnitPurchase(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const buyerId    = pi.metadata.buyer_id;
  const unitItemId = pi.metadata.unit_item_id;
  if (!buyerId || !unitItemId) return { granted: false, note: 'missing metadata' };

  const { data: existing } = await svc.from('book_unit_purchases')
    .select('id').eq('payment_intent_id', pi.id).maybeSingle();
  if (existing) return already('recorded');

  const { data: item } = await svc.from('book_unit_items')
    .select('id, business_id, uses_per_purchase, valid_days, name')
    .eq('id', unitItemId).single();
  if (!item) return { granted: false, note: 'item not found' };

  const expiresAt = item.valid_days
    ? new Date(Date.now() + item.valid_days * 86_400_000).toISOString()
    : null;

  const { error: insertErr } = await svc.from('book_unit_purchases').insert({
    item_id:           item.id,
    business_id:       item.business_id,
    owner_id:          buyerId,
    paid_amount_pence: pi.amount,
    uses_remaining:    item.uses_per_purchase,
    payment_intent_id: pi.id,
    expires_at:        expiresAt,
  });
  if (insertErr) {
    if (insertErr.code === '23505') return already('recorded');
    throw insertErr;
  }

  try {
    const itemName = (item as { name?: string }).name ?? 'your purchase';
    const paid = `£${(pi.amount / 100).toFixed(2)}`;
    await sendUserPush(svc, {
      userId: buyerId, module: 'wallet', categoryId: 'wallet.purchase',
      title: 'Purchase confirmed 🎟',
      body: `You bought ${itemName} for ${paid}. Find it in My Passes.`,
      data: { screen: 'local-my-passes' },
    });
    const { data: biz } = await svc.from('local_businesses').select('owner_id, name').eq('id', item.business_id).maybeSingle();
    if (biz?.owner_id) {
      await sendUserPush(svc, {
        userId: biz.owner_id, module: 'business', categoryId: 'business.sale',
        title: 'New sale 💷',
        body: `Someone bought ${itemName} (${paid})${biz.name ? ` at ${biz.name}` : ''}.`,
        data: { screen: 'local-business-dashboard' },
      });
    }
  } catch (e) { console.error('[fulfil:unit] notify failed', e); }

  return done('recorded purchase');
}

// ── Gift ─────────────────────────────────────────────────────────────────────
// Mirrors confirm-gift. Idempotent on the gift row's status (only a pending gift
// gets a code minted + email sent).
export async function fulfilGift(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const giftId = pi.metadata.gift_id;
  if (!giftId) return { granted: false, note: 'no gift_id' };

  const { data: gift } = await svc.from('book_gifts')
    .select('id, kind, status, code, business_id, unit_item_id, service_id, purchaser_id, recipient_email, recipient_name, message')
    .eq('id', giftId).single();
  if (!gift) return { granted: false, note: 'gift not found' };
  if (gift.status === 'sent' || gift.status === 'claimed' || gift.status === 'used') return already('sent');

  const { data: codeData, error: codeErr } = await svc.rpc('generate_gift_code');
  if (codeErr || !codeData) throw (codeErr ?? new Error('generate_gift_code returned nothing'));
  const code = codeData as string;

  // Atomic claim: only promote a gift that is STILL not sent — closes the race
  // with a concurrent client confirm so we don't email twice.
  const { data: promoted, error: updErr } = await svc.from('book_gifts')
    .update({ code, status: 'sent', payment_intent_id: pi.id })
    .eq('id', gift.id)
    .not('status', 'in', '(sent,claimed,used)')
    .select('id');
  if (updErr) throw updErr;
  if (!promoted || promoted.length === 0) return already('sent');

  try {
    const [{ data: purchaser }, { data: business }] = await Promise.all([
      svc.from('profiles').select('full_name').eq('id', gift.purchaser_id).maybeSingle(),
      svc.from('local_businesses').select('name').eq('id', gift.business_id).maybeSingle(),
    ]);
    let itemName = '';
    if (gift.kind === 'unit' && gift.unit_item_id) {
      const { data: it } = await svc.from('book_unit_items').select('name').eq('id', gift.unit_item_id).maybeSingle();
      itemName = it?.name ?? 'a gift';
    } else if (gift.kind === 'booking' && gift.service_id) {
      const { data: svcRow } = await svc.from('book_services').select('name').eq('id', gift.service_id).maybeSingle();
      itemName = svcRow?.name ?? 'a booking';
    }
    const escapedMsg = (gift.message ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const messageHtml = gift.message
      ? `<p style="margin:16px 0 0;font-style:italic;color:#374151;line-height:22px">&ldquo;${escapedMsg}&rdquo;</p>`
      : '';
    const claimUrl = `https://oneshetland.com/g/${code}`;
    const emailResult = await sendEmail(svc, {
      templateKey:    'local.gift_received',
      recipientEmail: gift.recipient_email,
      variables: {
        purchaser_name: purchaser?.full_name ?? 'Someone',
        recipient_name: gift.recipient_name ?? 'there',
        business_name:  business?.name ?? 'OneShetland',
        item_name:      itemName,
        message_html:   messageHtml,
        claim_url:      claimUrl,
        code,
      },
      metadata: { gift_id: gift.id, kind: gift.kind },
    });
    if (emailResult.ok && !emailResult.skipped) {
      await svc.from('book_gifts').update({ email_sent_at: new Date().toISOString() }).eq('id', gift.id);
    }
  } catch (e) { console.error('[fulfil:gift] email failed', e); }

  return done('sent gift');
}

// ── Event tickets ────────────────────────────────────────────────────────────
// Mirrors confirm-event-tickets.
export async function fulfilEventTickets(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const orderId = pi.metadata.order_id;
  if (!orderId) return { granted: false, note: 'no order_id' };

  const { data: order } = await svc.from('event_ticket_orders')
    .select('id, status, tickets_count, event_id, stripe_payment_intent_id, buyer_id')
    .eq('id', orderId).single();
  if (!order) return { granted: false, note: 'order not found' };
  if (order.status === 'paid') {
    // Another path got here first — commonly a saved card charged inline by
    // create-event-ticket-intent. The order is fine, but the receipt may never
    // have been sent, so try it here. sendTicketReceipt is idempotent.
    const buyer = (pi.metadata.buyer_id as string | undefined) ?? order.buyer_id;
    if (buyer) await sendTicketReceipt(svc, orderId, buyer);
    return already('paid');
  }

  // The order stored its own PI id at creation — never mark paid off a different PI.
  if (order.stripe_payment_intent_id && order.stripe_payment_intent_id !== pi.id) {
    return { granted: false, note: 'PI does not match order' };
  }

  await svc.from('event_ticket_orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), stripe_payment_intent_id: pi.id })
    .eq('id', orderId);
  await svc.from('event_tickets').update({ status: 'valid' }).eq('order_id', orderId);
  try {
    await svc.rpc('increment_event_tickets_sold', { p_event_id: order.event_id, p_count: order.tickets_count });
  } catch { /* non-critical counter */ }

  const buyerId = (pi.metadata.buyer_id as string | undefined) ?? order.buyer_id;

  try {
    const { data: event } = await svc.from('events').select('title, starts_at').eq('id', order.event_id).maybeSingle();
    if (event && buyerId) {
      const eventDate = new Date(event.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      await sendUserPush(svc, {
        userId: buyerId, module: 'events', categoryId: 'events.tickets_confirmed',
        title: 'Tickets confirmed 🎟',
        body: `${order.tickets_count} ticket${order.tickets_count !== 1 ? 's' : ''} for ${event.title} on ${eventDate}. Find them in My Wallet.`,
        data: { order_id: orderId },
      });
    }
  } catch (e) { console.error('[fulfil:tickets] notify failed', e); }

  // The receipt. This is the path the webhook takes, and usually the one that
  // wins the race with confirm-event-tickets — so omitting it here meant a buyer
  // got nothing in writing.
  if (buyerId) await sendTicketReceipt(svc, orderId, buyerId);

  return done('confirmed tickets');
}

// ── Hub donation ─────────────────────────────────────────────────────────────
// Mirrors confirm-hub-donation. No Gift Aid / message in the fallback (those are
// only supplied by the client) — the donation itself is still recorded.
export async function fulfilHubDonation(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const userId = pi.metadata.user_id;
  if (!userId) return { granted: false, note: 'no user_id' };

  const { data: existing } = await svc.from('hub_donations')
    .select('id').eq('stripe_payment_intent_id', pi.id).maybeSingle();
  if (existing) return already('recorded');

  const { error: rpcErr } = await svc.rpc('record_hub_donation', {
    p_campaign: pi.metadata.campaign_id,
    p_hub:      pi.metadata.hub_id,
    p_user:     userId,
    p_amount:   parseInt(pi.metadata.face_pence ?? '0', 10) || 0,
    p_fee:      parseInt(pi.metadata.fee_pence ?? '0', 10) || 0,
    p_message:  null,
    p_anon:     false,
    p_pi:       pi.id,
    p_gift_aid: false,
    p_title:    null,
    p_first:    null,
    p_last:     null,
    p_address:  null,
    p_postcode: null,
  });
  if (rpcErr) {
    if ((rpcErr as { code?: string }).code === '23505') return already('recorded');
    throw rpcErr;
  }

  try {
    const { data: hub } = await svc.from('hubs').select('name').eq('id', pi.metadata.hub_id).maybeSingle();
    const hubName = hub?.name ?? 'the hub';
    const amount = `£${((parseInt(pi.metadata.face_pence ?? '0', 10) || 0) / 100).toFixed(2)}`;
    await sendUserPush(svc, {
      userId, module: 'hubs', categoryId: 'hubs.donation_receipt',
      title: 'Thank you for your donation 💚',
      body: `Your ${amount} donation to ${hubName} has gone through.`,
      data: { hub_id: pi.metadata.hub_id },
    });
    const { data: donor } = await svc.from('profiles').select('full_name').eq('id', userId).maybeSingle();
    const donorName = (donor as { full_name?: string } | null)?.full_name ?? 'A supporter';
    const { data: admins } = await svc.from('hub_members').select('user_id')
      .eq('hub_id', pi.metadata.hub_id).in('role', ['owner', 'committee']).eq('status', 'active');
    const adminIds = [...new Set((admins ?? []).map((a) => a.user_id).filter(Boolean) as string[])];
    await sendUserPushBulk(svc, adminIds, {
      module: 'hubs', categoryId: 'hubs.donation_received',
      title: 'New donation 💚',
      body: `${donorName} donated ${amount} to ${hubName}.`,
      data: { hub_id: pi.metadata.hub_id },
    });
  } catch (e) { console.error('[fulfil:donation] notify failed', e); }

  return done('recorded donation');
}

// ── Hub membership ───────────────────────────────────────────────────────────
// Mirrors confirm-hub-membership.
export async function fulfilHubMembership(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const userId = pi.metadata.user_id;
  if (!userId) return { granted: false, note: 'no user_id' };

  const { data: existing } = await svc.from('hub_members')
    .select('id').eq('stripe_payment_intent_id', pi.id).maybeSingle();
  if (existing) return already('activated');

  const { error: rpcErr } = await svc.rpc('activate_hub_membership', {
    p_hub:           pi.metadata.hub_id,
    p_user:          userId,
    p_type:          pi.metadata.membership_type_id,
    p_period:        pi.metadata.period,
    p_payment_pence: parseInt(pi.metadata.face_pence ?? '0', 10) || 0,
    p_pi:            pi.id,
  });
  if (rpcErr) {
    if ((rpcErr as { code?: string }).code === '23505') return already('activated');
    throw rpcErr;
  }

  svc.functions.invoke('notify-hub', { body: { event: 'membership_paid', hub_id: pi.metadata.hub_id, user_id: userId } }).catch(() => {});

  return done('activated membership');
}

/**
 * Dispatch a succeeded PaymentIntent to the right fulfilment helper, keyed on
 * metadata.type. Returns null if the type isn't one this safety-net covers
 * (e.g. Fetch delivery / local_boost, which the webhook handles inline, or the
 * *_wallet variants, which are fulfilled synchronously at purchase time).
 */
/**
 * Spawn the Fetch delivery request for a PAID shop order with fulfilment
 * 'fetch'. Goods are already paid (already_paid=true); the delivery fee rides
 * the existing Fetch pre-auth/capture rails when a driver accepts. Fee is
 * estimated postcode→postcode via the calculate-fee function; falls back to
 * central Lerwick when the business address has no parseable postcode.
 * Idempotent via the delivery_request_id null-guard on the UPDATE.
 */
export async function spawnFetchRequest(svc: SupabaseClient, orderId: string): Promise<void> {
  const { data: order } = await svc
    .from('product_orders')
    .select('id, business_id, buyer_id, fulfilment, delivery_request_id, delivery_name, delivery_address, delivery_postcode, delivery_region_slug, contact_phone, buyer_note')
    .eq('id', orderId).maybeSingle();
  if (!order || order.fulfilment !== 'fetch' || order.delivery_request_id) return;

  const { data: biz } = await svc
    .from('local_businesses').select('name, address').eq('id', order.business_id).maybeSingle();
  if (!biz) return;

  // The drop-off region is what drivers' runs are matched on — without it the
  // request can never be covered by a run.
  const { data: region } = order.delivery_region_slug
    ? await svc.from('regions').select('id, name').eq('slug', order.delivery_region_slug).maybeSingle()
    : { data: null };

  // Fee estimate — business postcode from its address, Lerwick fallback.
  let feePence: number | null = null;
  try {
    const pickupPc = (biz.address ?? '').match(/ZE\d\s*\d[A-Z]{2}/i)?.[0] ?? 'ZE1 0LL';
    const svcKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/calculate-fee`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // calculate-fee rejects requests with no Authorization header — this
        // runs server-side, so the service key is the caller.
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
      body: JSON.stringify({ pickup_postcode: pickupPc, destination_postcode: order.delivery_postcode }),
    });
    const data = await res.json();
    if (res.ok && Number.isFinite(data.fee_pence)) feePence = data.fee_pence;
  } catch { /* fee stays null; the fetch flow's minimum applies */ }

  const { data: dr, error } = await svc.from('delivery_requests').insert({
    customer_id: order.buyer_id,
    category_slug: 'shop-collection',
    pickup_name: biz.name,
    pickup_location: biz.address ?? 'Shetland',
    pickup_notes: `Shop Shetland order — goods already paid. Ref ${order.id.slice(0, 8)}.`,
    already_paid: true,
    ready_for_collection: false, // merchant flips this via "Ready" on the order
    destination_region_id: region?.id ?? null,
    destination_area: region?.name ?? null,
    destination_address: [order.delivery_name, order.delivery_address, order.delivery_postcode].filter(Boolean).join(', '),
    delivery_notes: order.buyer_note ?? null,
    contact_phone: order.contact_phone ?? null,
    liability_acknowledged: true,
    base_fee_pence: feePence,
    total_fee_pence: feePence,
    status: 'pending',
  }).select('id').single();
  if (error || !dr) { console.error('[spawnFetchRequest] insert failed', error); return; }

  await svc.from('product_orders').update({ delivery_request_id: dr.id }).eq('id', orderId);
}

/* ── Shop Shetland product orders ─────────────────────────────────────────
   Unlike the flows above, the webhook is the PRIMARY finalisation path for
   card-paid product orders (there is no client confirm-* call). Idempotent
   via the pending→paid status guard on the UPDATE. */
export async function fulfilProductOrder(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult> {
  const orderId = pi.metadata.order_id;
  if (!orderId) return { granted: false, note: 'no order_id in metadata' };

  // Status-guarded flip: only ONE caller ever moves pending → paid.
  const { data: flipped } = await svc
    .from('product_orders')
    .update({ status: 'paid', paid_via: 'card', paid_at: new Date().toISOString(), expires_at: null, payment_intent_id: pi.id })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('id, business_id, buyer_id, total_pence, fulfilment')
    .maybeSingle();
  if (!flipped) return { granted: false, note: 'order not pending (already fulfilled or expired)' };

  // Commit reserved stock to sold.
  const { data: items } = await svc
    .from('product_order_items')
    .select('product_id, variant_id, qty, title')
    .eq('order_id', orderId);
  for (const it of items ?? []) {
    if (it.product_id) {
      await svc.rpc('commit_product_stock', { p_product: it.product_id, p_variant: it.variant_id ?? null, p_qty: it.qty });
    }
  }

  // Tell the shop.
  try {
    const { data: biz } = await svc.from('local_businesses').select('owner_id, name').eq('id', flipped.business_id).maybeSingle();
    if (biz?.owner_id) {
      const n = (items ?? []).reduce((s, i) => s + i.qty, 0);
      await sendUserPush(svc, {
        userId: biz.owner_id, module: 'business', categoryId: 'business.order',
        title: '🛍️ New shop order!',
        body: `£${(flipped.total_pence / 100).toFixed(2)} — ${n === 1 ? (items?.[0]?.title ?? '1 item') : `${n} items`} (${flipped.fulfilment})`,
        // NOTE: not `order_id` — that key routes to event tickets in the app.
        data: { screen: 'business-orders', product_order_id: orderId, business_id: flipped.business_id },
      });
    }
  } catch (e) { console.error('[fulfil:product] notify failed', e); }

  // Server-side conversion event (registered in analytics_event_defs).
  try {
    await svc.from('analytics_events').insert({
      event_name: 'product_order_paid', platform: 'web', user_type: 'user',
      user_id: flipped.buyer_id, business_id: flipped.business_id,
      is_conversion: true, category: 'sales',
      props: { order_id: orderId, total_pence: flipped.total_pence, fulfilment: flipped.fulfilment },
      consent: true,
    });
  } catch (e) { console.error('[fulfil:product] analytics failed', e); }

  // Fetch lane: spawn the community-driver delivery request.
  if (flipped.fulfilment === 'fetch') {
    try { await spawnFetchRequest(svc, orderId); }
    catch (e) { console.error('[fulfil:product] fetch spawn failed', e); }
  }

  return { granted: true, note: `order ${orderId} paid + stock committed` };
}

export async function fulfilByType(svc: SupabaseClient, pi: FulfilPI): Promise<FulfilResult | null> {
  switch (pi.metadata.type) {
    case 'local_wallet_topup': return fulfilWalletTopup(svc, pi);
    case 'unit_purchase':      return fulfilUnitPurchase(svc, pi);
    case 'gift_purchase':      return fulfilGift(svc, pi);
    case 'event_tickets':      return fulfilEventTickets(svc, pi);
    case 'hub_donation':       return fulfilHubDonation(svc, pi);
    case 'hub_membership':     return fulfilHubMembership(svc, pi);
    case 'product_order':      return fulfilProductOrder(svc, pi);
    default:                   return null;
  }
}

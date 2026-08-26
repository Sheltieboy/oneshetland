import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { debitAndTransfer } from '../_shared/wallet-ledger.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

function stripePostHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
function stripeGetHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
async function listSavedCard(customerId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
    { headers: stripeGetHeaders() },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `Stripe payment_methods list failed (HTTP ${res.status})`);
  return data.data?.[0]?.id ?? null;
}
async function createPaymentIntent(params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { ...stripePostHeaders() };
  // Idempotency-Key makes a retried create (lost response, double-tap) return the
  // ORIGINAL PaymentIntent instead of charging the saved card a second time.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res  = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers, body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe PaymentIntent failed (HTTP ${res.status})`);
  return json;
}

/**
 * create-gift-intent
 *
 * Begins a gift purchase: writes a pending book_gifts row, then creates a
 * Stripe PaymentIntent (with the gift_id in metadata so confirm-gift can
 * route it back).
 *
 * Body:
 *   {
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
 *   { charged: true, payment_intent_id, gift_id }            ← off-session success
 * or:
 *   { clientSecret, payment_intent_id, gift_id }             ← PaymentSheet path
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-gift-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json();
    const { kind, unit_item_id, service_id, recipient_email, recipient_name, message, use_saved_card = false, pay_with_wallet = false } = body;

    if (!kind || (kind !== 'unit' && kind !== 'booking')) {
      return new Response(JSON.stringify({ error: 'kind must be "unit" or "booking"' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!recipient_email || !/^\S+@\S+\.\S+$/.test(recipient_email)) {
      return new Response(JSON.stringify({ error: 'A valid recipient email is required.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve price + business from the item/service.
    let pricePence: number | null = null;
    let businessId: string | null = null;
    let itemLabel = '';

    if (kind === 'unit') {
      if (!unit_item_id) {
        return new Response(JSON.stringify({ error: 'unit_item_id required for unit gifts' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: item } = await supabase
        .from('book_unit_items')
        .select('id, business_id, name, price_pence, stock, is_active')
        .eq('id', unit_item_id)
        .single();
      if (!item || !item.is_active) {
        return new Response(JSON.stringify({ error: 'Item not available' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (item.stock !== null && item.stock <= 0) {
        return new Response(JSON.stringify({ error: 'stock_exhausted' }), {
          status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      pricePence = item.price_pence;
      businessId = item.business_id;
      itemLabel  = item.name;
    } else {
      if (!service_id) {
        return new Response(JSON.stringify({ error: 'service_id required for booking gifts' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: svc } = await supabase
        .from('book_services')
        .select('id, business_id, name, price_pence, is_active')
        .eq('id', service_id)
        .single();
      if (!svc || !svc.is_active || svc.price_pence <= 0) {
        return new Response(JSON.stringify({ error: 'Service not available for gifting' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      pricePence = svc.price_pence;
      businessId = svc.business_id;
      itemLabel  = svc.name;
    }

    // The business must be set up for payouts before we take money for a gift.
    const { data: giftBiz } = await supabase
      .from('local_businesses')
      .select('stripe_account_id, payout_enabled, slug')
      .eq('id', businessId)
      .single();
    // Demo businesses (slug 'demo-…') exist only for testing and have no real
    // Stripe Connect account — in test mode we charge the platform directly
    // (no destination transfer). Real businesses must be payout-ready.
    const isDemoBiz = (giftBiz?.slug ?? '').startsWith('demo-');
    const giftHasAccount = !!(giftBiz?.stripe_account_id && giftBiz.payout_enabled);
    if (!isDemoBiz && !giftHasAccount) {
      return new Response(JSON.stringify({ error: "This business isn't set up to take payments yet." }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Platform commission — admin-editable, see fees.gift.* in admin_config.
    // Default 5% (matches the previous hardcoded rate).
    const giftCfg = await getCommissionConfig(supabase, 'gift');
    const giftPlatformFee = calculateCommission(pricePence!, giftCfg, 'gift').fee_pence;

    // Insert pending gift row (no code yet — generated on confirm).
    const giftRow: Record<string, unknown> = {
      kind,
      status:           'pending_payment',
      code:             crypto.randomUUID(),  // placeholder; will be replaced with short code on confirm
      business_id:      businessId,
      unit_item_id:     kind === 'unit'    ? unit_item_id : null,
      service_id:       kind === 'booking' ? service_id   : null,
      purchaser_id:     user.id,
      recipient_email:  recipient_email.toLowerCase().trim(),
      recipient_name:   recipient_name?.trim() || null,
      message:          message?.trim().slice(0, 500) || null,
      price_paid_pence: pricePence,
    };

    const { data: gift, error: giftErr } = await supabase
      .from('book_gifts')
      .insert(giftRow)
      .select('id')
      .single();

    if (giftErr || !gift) {
      console.error('[create-gift-intent] gift insert failed', giftErr);
      return new Response(JSON.stringify({ error: giftErr?.message ?? 'Could not start gift.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Mode 0: pay from wallet (debit + transfer to the business, no card) ──
    if (pay_with_wallet) {
      // Debit and ledger in one transaction, keyed on the gift row that was just
      // created. Demo businesses have no connected account, so the transfer is
      // skipped and the wallet debit alone funds the platform.
      const paid = await debitAndTransfer(supabase, {
        userId:           user.id,
        spendPence:       pricePence!,
        businessId,
        description:      `Gift — ${itemLabel}`,
        idempotencyKey:   `gift:${gift.id}`,
        platformFeePence: giftPlatformFee,
        transfer: giftHasAccount ? {
          destination: giftBiz.stripe_account_id,
          amountPence: pricePence! - giftPlatformFee,
          description: `OneShetland wallet gift — ${itemLabel}`,
          metadata: { type: 'gift_purchase_wallet', gift_id: gift.id, buyer_id: user.id },
        } : undefined,
      });

      if (!paid.ok) {
        await supabase.from('book_gifts').delete().eq('id', gift.id);
        const msg = paid.reason === 'insufficient'
          ? 'Not enough in your wallet — top up or pay by card.'
          : paid.error;
        return new Response(JSON.stringify({ error: msg }), { status: paid.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const ref = `wallet_${paid.transactionId}`;
      await supabase.from('book_gifts').update({ payment_intent_id: ref }).eq('id', gift.id);
      return new Response(JSON.stringify({ charged: true, payment_intent_id: ref, gift_id: gift.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const baseParams: Record<string, string> = {
      amount:      String(pricePence!),
      currency:    'gbp',
      description: `OneShetland gift — ${itemLabel}`,
      'metadata[type]':        'gift_purchase',
      'metadata[gift_id]':     gift.id,
      'metadata[kind]':        kind,
      'metadata[business_id]': businessId!,
      'metadata[buyer_id]':    user.id,
    };
    // Route to the business's Connect account only when it has one (a real,
    // payout-ready business). Demo businesses have none → charge the platform.
    if (giftHasAccount) {
      baseParams['transfer_data[destination]'] = giftBiz!.stripe_account_id;
      baseParams['application_fee_amount']      = String(giftPlatformFee);
    }

    // ── Mode 1: saved card, off-session ──────────────────────────────────────
    // Asking for the saved card is a PREFERENCE, not an assertion that one
    // exists. A first-time buyer has no card on file, and turning that into
    // "No saved card found" made a first purchase impossible — the client had
    // no way to ask for the card form instead. Having no card is not an error;
    // it means the card form is the right screen. A saved card that FAILS
    // still errors further down, because that is a different thing.
    let customerId: string | null = null;
    let pmId: string | null = null;
    if (use_saved_card) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .single();
      customerId = profile?.stripe_customer_id ?? null;
      pmId = customerId ? await listSavedCard(customerId) : null;
    }

    if (customerId && pmId) {
      const paymentIntent = await createPaymentIntent({
        ...baseParams,
        ...onSessionConfirm(customerId, pmId),
      }, `gift-${gift.id}`);

      const outcome = classifyIntent(paymentIntent);
      if (outcome.kind === 'requires_action') {
        // The issuer wants the cardholder to authenticate. That is the middle of a
        // payment, not the end of one: hand back THIS intent's client secret so the
        // SDK can finish it. No second PaymentIntent, and nothing is fulfilled yet.
        return new Response(JSON.stringify({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id, gift_id: gift.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (outcome.kind === 'processing') {
        // Stripe has it and has not settled. The webhook fulfils when it resolves.
        return new Response(JSON.stringify({ status: 'processing', payment_intent_id: outcome.id, gift_id: gift.id }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (outcome.kind !== 'succeeded') {
        return new Response(JSON.stringify({ status: 'failed', error: failureMessage(outcome.status) }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Stash the PI on the gift now so confirm-gift can find it idempotently.
      await supabase
        .from('book_gifts')
        .update({ payment_intent_id: paymentIntent.id })
        .eq('id', gift.id);

      return new Response(
        JSON.stringify({ charged: true, payment_intent_id: paymentIntent.id, gift_id: gift.id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Mode 2: PaymentSheet (no saved card) ─────────────────────────────────
    const paymentIntent = await createPaymentIntent({
      ...baseParams,
      'automatic_payment_methods[enabled]': 'true',
    });
    await supabase
      .from('book_gifts')
      .update({ payment_intent_id: paymentIntent.id })
      .eq('id', gift.id);

    return new Response(
      JSON.stringify({
        clientSecret:      paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        gift_id:           gift.id,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[create-gift-intent]', err);
    return new Response(
      JSON.stringify({ error: safeError('create-gift-intent', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

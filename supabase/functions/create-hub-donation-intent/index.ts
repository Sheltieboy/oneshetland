import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from '../_shared/commission.ts';
import { getCommissionConfig } from '../_shared/commission-config.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { onSessionConfirm, classifyIntent, failureMessage } from '../_shared/stripe-sca.ts';
import { normaliseUkPostcode } from '../_shared/uk-postcode.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const MIN_PENCE = 100;       // £1 minimum
const MAX_PENCE = 1_000_000; // £10,000 cap per donation

/** Why a campaign cannot take a donation, said the way a donor would say it. */
const CAMPAIGN_INELIGIBLE: Record<string, string> = {
  closed:     'This campaign has closed, so it is no longer accepting donations.',
  not_active: 'This campaign is not accepting donations.',
  ended:      'This campaign has ended, so it is no longer accepting donations.',
};

function stripeHeaders(): HeadersInit {
  return {
    'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
}
async function listSavedCard(customerId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`,
    { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': STRIPE_API_VERSION } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `Stripe payment_methods list failed (HTTP ${res.status})`);
  return data.data?.[0]?.id ?? null;
}
async function createPaymentIntent(params: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = { ...stripeHeaders() };
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
 * create-hub-donation-intent
 *
 * Donate to a hub fundraising campaign. Destination charge to the hub's
 * connected account; optional flat platform fee (default 0). Payout-readiness
 * guarded. The donation row + Gift Aid declaration are written by
 * confirm-hub-donation after payment succeeds.
 *
 *   use_saved_card = true  → { charged, payment_intent_id }
 *   use_saved_card = false → { clientSecret, payment_intent_id }
 *
 * Body: { campaign_id, amount_pence, use_saved_card? }
 */
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

    // Abuse ceiling for this account. Limits live in rate_limit_policies,
    // not here; a broken limiter refuses rather than waving traffic through.
    const limited = await enforceRateLimit('create-hub-donation-intent', userSubject(user.id), ['stripe_intent', 'stripe_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const {
      campaign_id, amount_pence, use_saved_card = false, cover_fees = false,
      client_request_id = null, message = null, anonymous = false, gift_aid = null,
    } = await req.json();
    if (!campaign_id) return json({ error: 'campaign_id required' }, 400);

    // One deliberate donation = one attempt id, and it goes into the Stripe
    // idempotency key. Without it the key was `donation-<user>-<campaign>-<amount>`,
    // which Stripe honours for ~24 hours — so a donor giving £10 twice to the
    // same campaign in a day got the FIRST PaymentIntent back, fulfilment
    // deduplicated on it, and the page thanked them for a donation that never
    // happened. A declined card could not be retried at the same amount either.
    //
    // It is an idempotency token ONLY. The donor, the campaign, the hub, the
    // amount, the destination and the fee are all resolved server-side below.
    if (typeof client_request_id !== 'string' || client_request_id.trim().length === 0 ||
        client_request_id.length < 8 || client_request_id.length > 100) {
      return json({ error: 'client_request_id required' }, 400);
    }

    const amount = Math.round(Number(amount_pence));
    if (!Number.isFinite(amount) || amount < MIN_PENCE || amount > MAX_PENCE) {
      return json({ error: 'Donation must be between £1 and £10,000.' }, 400);
    }

    // Active AND not past its end date, on the database clock — the same
    // function the wallet path calls.
    const { data: eligRows, error: eligErr } = await svc.rpc('campaign_donation_eligibility', { p_campaign: campaign_id });
    if (eligErr) throw eligErr;
    const elig = Array.isArray(eligRows) ? eligRows[0] : eligRows;
    if (!elig || elig.reason === 'campaign_not_found') return json({ error: 'Campaign not available' }, 404);
    if (!elig.eligible) {
      return json({ error: CAMPAIGN_INELIGIBLE[elig.reason] ?? 'This campaign is not accepting donations.', reason: elig.reason }, 409);
    }
    const campaign = { id: elig.campaign_id, hub_id: elig.hub_id, title: elig.title };

    const { data: hub } = await svc.from('hubs')
      .select('id, name, stripe_account_id, payout_enabled, is_active, slug').eq('id', campaign.hub_id).single();
    if (!hub || !hub.is_active) return json({ error: 'Hub not available' }, 404);
    // Demo hubs (slug 'demo-…') exist only for testing and have no real Stripe
    // Connect account — in test mode we charge the platform directly (no
    // destination transfer). Real hubs must be payout-ready.
    const isDemoHub = (hub.slug ?? '').startsWith('demo-');
    const hubHasAccount = !!(hub.stripe_account_id && hub.payout_enabled);
    if (!isDemoHub && !hubHasAccount) {
      return json({ error: 'This hub has not finished setting up payouts yet.' }, 409);
    }

    // Donations earn the platform nothing. We retain an application_fee equal to
    // Stripe's estimated processing fee — the platform keeps it but immediately
    // pays it back to Stripe, netting ~£0, so the HUB effectively bears the fee.
    // If the donor opts to "cover the fee", we add the same estimate on top so
    // the hub still nets the full donation.
    // Platform commission — admin-editable, see fees.donation.* in admin_config.
    // Default 1.5% + 20p (matches the previous hardcoded ~Stripe-cost estimate).
    // Computed on the face donation amount, not the cover-fee-inclusive total.
    const donationCfg = await getCommissionConfig(svc, 'donation');
    const feeEstimate = calculateCommission(amount, donationCfg, 'donation').fee_pence;
    const coverPence = cover_fees ? feeEstimate : 0;
    const totalPence = amount + coverPence;

    // ── Gift Aid, validated HERE rather than at confirm time ─────────────
    //
    // It used to be checked when the browser came back, which is also where the
    // donor's anonymity and message lived — and the webhook, racing that call,
    // knew none of it. Validating and storing it now means the choices are
    // authoritative BEFORE the payment exists, and the webhook can honour them.
    const { data: hubCharity } = await svc.from('hubs')
      .select('is_charity, charity_number').eq('id', hub.id).maybeSingle();
    const charityEligible = !!hubCharity?.is_charity && !!hubCharity?.charity_number;
    const declared = charityEligible && gift_aid && gift_aid.first_name && gift_aid.last_name
                     && gift_aid.address && gift_aid.postcode;
    let ga: Record<string, string> | null = null;
    if (declared) {
      const normalised = normaliseUkPostcode(String(gift_aid.postcode));
      if (!normalised) {
        return json({ error: "That doesn't look like a valid UK postcode — please check it so your Gift Aid can be claimed." }, 400);
      }
      ga = { ...gift_aid, postcode: normalised };
    }

    // The platform only retains an application fee when there is a destination
    // to take it from. A demo hub is charged on the platform, so nothing is
    // retained from a transfer that never happens.
    const retainedFee = hubHasAccount ? feeEstimate : 0;

    // ── The authoritative attempt ────────────────────────────────────────
    //
    // Written before the PaymentIntent, so a webhook that arrives while the
    // browser is gone still records the donation the donor actually made.
    // Re-running the same reference resolves to the SAME attempt rather than
    // starting a second one — and refuses if that reference was already used
    // for a different campaign or a different sum.
    const attemptRow = {
      client_request_id: client_request_id,
      donor_user_id:     user.id,          // auth.uid(), never the request body
      campaign_id:       campaign.id,
      hub_id:            hub.id,
      face_pence:        amount,
      cover_pence:       coverPence,
      fee_pence:         retainedFee,
      is_anonymous:      !!anonymous,
      message:           message ? String(message).slice(0, 280) : null,
      gift_aid:          !!ga,
      ga_title:          ga?.title ?? null,
      ga_first_name:     ga?.first_name ?? null,
      ga_last_name:      ga?.last_name ?? null,
      ga_address:        ga?.address ?? null,
      ga_postcode:       ga?.postcode ?? null,
      method:            'card',
    };
    await svc.from('hub_donation_attempts').insert(attemptRow).select('id').maybeSingle();
    const { data: attempt } = await svc.from('hub_donation_attempts')
      .select('id, campaign_id, face_pence, cover_pence, payment_intent_id, status')
      .eq('donor_user_id', user.id).eq('client_request_id', client_request_id).maybeSingle();
    if (!attempt) return json({ error: 'Could not start the donation.' }, 500);
    if (attempt.campaign_id !== campaign.id || attempt.face_pence !== amount || attempt.cover_pence !== coverPence) {
      return json({ error: 'That payment reference belongs to a different donation.' }, 409);
    }

    const baseParams: Record<string, string> = {
      amount:      String(totalPence),
      currency:    'gbp',
      description: `OneShetland donation — ${hub.name} (${campaign.title})`,
      'metadata[type]':        'hub_donation',
      'metadata[campaign_id]': campaign.id,
      'metadata[hub_id]':      hub.id,
      'metadata[user_id]':     user.id,
      'metadata[face_pence]':  String(amount),
      // The fee actually retained, not a hardcoded zero. Every card donation
      // recorded fee_pence = 0 while the platform kept 1.5% + 20p, so the hub's
      // own record understated what came off it.
      'metadata[fee_pence]':   String(retainedFee),
      'metadata[cover_pence]': String(coverPence),
      // An opaque reference to the attempt. Nothing about the donor travels
      // through Stripe: no name, no address, no postcode, no message.
      'metadata[attempt_id]':  attempt.id,
    };
    // Route to the hub's Connect account only when it has one (a real,
    // payout-ready hub). Demo hubs have none → charge the platform.
    if (hubHasAccount) {
      baseParams['transfer_data[destination]'] = hub.stripe_account_id;
      baseParams['application_fee_amount']      = String(feeEstimate);
    }

    // Asking for the saved card is a PREFERENCE, not an assertion that one
    // exists. Someone donating for the first time has no card on file, and
    // turning that into "No saved card found" made a first donation impossible
    // — the client had no way to ask for the card form instead. Having no card
    // is not an error; it just means the card form is the right screen. A
    // saved card that FAILS still errors, further down, because that is a
    // different thing entirely.
    let customerId: string | null = null;
    let pmId: string | null = null;
    if (use_saved_card) {
      const { data: profile } = await svc.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
      customerId = profile?.stripe_customer_id ?? null;
      pmId = customerId ? await listSavedCard(customerId) : null;
    }

    if (customerId && pmId) {
      const pi = await createPaymentIntent({ ...baseParams, ...onSessionConfirm(customerId, pmId) }, `donation-${user.id}-${campaign.id}-${amount}-${client_request_id}`);
      // Bind the intent to its attempt BEFORE any branch returns — including
      // requires_action, where the webhook may fulfil while the donor is still
      // authenticating with their bank.
      await svc.from('hub_donation_attempts').update({ payment_intent_id: pi.id }).eq('id', attempt.id);
      const outcome = classifyIntent(pi);
      if (outcome.kind === 'requires_action') {
        // The issuer wants the cardholder to authenticate. That is the middle of a
        // payment, not the end of one: hand back THIS intent's client secret so the
        // SDK can finish it. No second PaymentIntent, and nothing is fulfilled yet.
        return json({ status: 'requires_action', clientSecret: outcome.clientSecret, payment_intent_id: outcome.id }, 200);
      }
      if (outcome.kind === 'processing') {
        // Stripe has it and has not settled. The webhook fulfils when it resolves.
        return json({ status: 'processing', payment_intent_id: outcome.id }, 200);
      }
      if (outcome.kind !== 'succeeded') {
        return json({ status: 'failed', error: failureMessage(outcome.status) }, 402);
      }
      return json({ charged: true, payment_intent_id: pi.id });
    }

    const pi = await createPaymentIntent({ ...baseParams, 'automatic_payment_methods[enabled]': 'true' },
      `donation-form-${user.id}-${campaign.id}-${amount}-${client_request_id}`);
    await svc.from('hub_donation_attempts').update({ payment_intent_id: pi.id }).eq('id', attempt.id);
    return json({ clientSecret: pi.client_secret, payment_intent_id: pi.id });
  } catch (err) {
    console.error('[create-hub-donation-intent]', err);
    return json({ error: safeError('create-hub-donation-intent', err) }, 500);
  }
});

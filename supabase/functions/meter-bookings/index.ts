import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfig } from '../_shared/admin-config.ts';
import { classifyStripeResponse, buildUsageRequest, type Settlement } from '../_shared/stripe-usage.ts';
import { safeError } from '../_shared/safe-error.ts';

/**
 * meter-bookings
 *
 * Bills Pro businesses 95p per booking, capped at 17 a month.
 *
 * WHY METERED BILLING AND NOT A CHARGE PER BOOKING.
 * Most bookings take no deposit, so there is no transaction to skim — the fee
 * has to ride the monthly subscription invoice. It also has to: as 18 separate
 * 95p charges, Stripe's fixed 20p would eat 21% of each one. Reported as usage
 * on the Pro subscription, a business with 17 bookings pays £28.15 in a single
 * charge and Stripe takes about 62p on the lot.
 *
 * WHY THE CAP IS 17 AND NOT "£17".
 * Pro is £12, Premium £29. 17 x 95p = £16.15, so a capped Pro month tops out at
 * £28.15 — strictly less than Premium, always. At 18 it would be £29.10 and a
 * business would be paying more than the plan that includes bookings outright,
 * which is precisely the trap this is designed not to set.
 *
 * PREMIUM IS MARKED, NOT BILLED. Bookings are included on Premium, but its
 * bookings are still marked processed — as 'skipped', which is terminal, so a
 * later move to Pro cannot turn them into a bill for bookings taken while the
 * plan included them.
 *
 * ── IDEMPOTENCY: THE DATABASE DECIDES, STRIPE IS THE SECOND NET ─────────────
 *
 * The old version reported a month's backlog as one event and then stamped
 * metered_at. Two overlapping reminder-runner passes could both report, and the
 * Billing Meter identifier it used — `bk-{business}-{month}-{already_billed}` —
 * was not the protection it looked like:
 *
 *   Report 5 units, crash before stamping, two more bookings arrive, retry.
 *   already_billed is still 0, so the identifier is the SAME but the payload now
 *   says 7. Stripe rejects the duplicate identifier and the code stamps all
 *   seven. Two bookings billed to nobody.
 *
 * Now the unit is ONE BOOKING. Quantity is always 1, so a payload cannot drift.
 * The external identity is the booking's metering_attempt_id: a uuid generated
 * in the database on first claim, never regenerated, never chosen by a caller.
 *
 * The sequence per booking is claim → report → settle:
 *
 *   claim_bookings_for_metering   atomic, cap-aware, one worker only
 *   Stripe call                   identifier AND Idempotency-Key = attempt id
 *   settle_booking_metering       reported | failed | unresolved
 *
 * Stripe's own guarantees are time-boxed — meter-event identifiers are unique
 * "within a rolling period of at least 24 hours", and idempotency keys are
 * pruned after about the same — so they cannot be the only control. They are
 * the second one.
 *
 * WHAT EACH FAILURE MEANS
 *
 *   4xx   Stripe definitively refused. 'failed' → back to pending, KEEPING the
 *         attempt id, so the retry is the same billing event.
 *   5xx   Stripe had a problem and may or may not have applied it. 'unresolved'.
 *   network / timeout                                              'unresolved'.
 *
 * 'unresolved' is never treated as success. It is retried only while Stripe
 * would still recognise the identity as a duplicate; past that window it is
 * left for a person and reported by metering_backlog_health().
 *
 * Config: stripe.price.booking_meter — the £0.95 usage-based Price on the Pro
 * product. Either generation works: a Price with a Billing Meter gets meter
 * events, one without gets legacy usage records. Both are made retry-safe.
 *
 * Body: none. Safe to run on a schedule, and safe to run twice at once.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BOOKING_FEE_PENCE = 95;
const MONTHLY_CAP_UNITS = 17;
/** Comfortably inside Stripe's "at least 24 hours" uniqueness window. */
const STRIPE_IDEMPOTENCY_WINDOW_HOURS = 12;
const STRIPE_TIMEOUT_MS = 20_000;

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

/**
 * Deliberately does NOT pin Stripe-Version, unlike the other functions here.
 *
 * They pin 2023-10-16, which predates Billing Meters — on that version
 * `price.recurring.meter` is not returned at all, so a meter-based price would
 * look like a legacy one and we would post usage to an endpoint that rejects it.
 * Omitting the header uses the account's own default version, which is new
 * enough to describe meters honestly. Pin this only to a version that still
 * returns `recurring.meter`.
 */
async function stripeGet(path: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe ${path} failed (${res.status})`);
  return json;
}

/**
 * A billing POST, classified rather than thrown.
 *
 * The distinction that matters is between "Stripe said no" and "we do not know
 * what Stripe did". Only the first is safe to retry as a fresh attempt; the
 * second must keep its identity and be resolved, never assumed.
 */
async function stripeReport(
  path: string,
  params: Record<string, string>,
  idempotencyKey: string,
): Promise<{ settlement: Settlement; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // "All POST requests accept idempotency keys." The key is the booking's
        // attempt id, so a retry of the same logical event cannot double-bill.
        'Idempotency-Key': idempotencyKey,
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
  } catch (e) {
    // Timeout or transport failure: the request may well have arrived, so this
    // is classified as no-status rather than as an error.
    return classifyStripeResponse(null, e instanceof Error ? e.name : 'network');
  }

  if (res.ok) return classifyStripeResponse(res.status);
  const body = await res.json().catch(() => ({} as any));
  return classifyStripeResponse(res.status, body?.error?.code ?? body?.error?.type);
}

function isServiceRole(token: string, injectedKey: string): boolean {
  if (!token) return false;
  if (injectedKey && token === injectedKey) return true;
  try {
    const [, payload] = token.split('.');
    if (!payload) return false;
    const pad = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.role === 'service_role';
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // Service role only. Supabase's gateway already requires SOME valid JWT, but
    // that includes the public anon key and every signed-in user — and this
    // function bills people. reminder-runner invokes it with the service key,
    // which is the only caller there should be.
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!isServiceRole(auth, serviceKey)) return json({ error: 'Forbidden' }, 403);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey);
    const meterPrice = await getConfig(svc, 'stripe.price.booking_meter', Deno.env.get('STRIPE_PRICE_BOOKING_METER') ?? null);

    const result = {
      billed: 0, units: 0, capped: 0, premium_marked: 0, skipped: 0,
      unresolved: 0, failed: 0, errors: [] as string[],
    };

    // ── Premium: mark processed, never bill ─────────────────────────────────
    const { data: premiumBiz } = await svc
      .from('local_businesses').select('id').eq('subscription_tier', 'premium');
    for (const b of premiumBiz ?? []) {
      const { data: n } = await svc.rpc('skip_bookings_for_metering', { p_business_id: b.id });
      result.premium_marked += (n as number | null) ?? 0;
    }

    // ── Pro: one Stripe event per booking, up to the monthly cap ────────────
    const { data: proBiz, error: proErr } = await svc
      .from('local_businesses')
      .select('id, stripe_subscription_id')
      .eq('subscription_tier', 'pro');
    if (proErr) throw proErr;

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    for (const biz of proBiz ?? []) {
      const businessId = biz.id as string;
      const subId = biz.stripe_subscription_id as string | null;

      // Claim first, always: it is what stops a second worker taking the same
      // booking, and what keeps the cap honest when two run at once.
      const { data: claimed, error: claimErr } = await svc.rpc('claim_bookings_for_metering', {
        p_business_id: businessId, p_month_start: monthStart, p_cap: MONTHLY_CAP_UNITS,
      });
      if (claimErr) { result.errors.push(`${businessId}: claim failed`); continue; }

      // Ambiguous attempts get another go while Stripe would still recognise
      // their identity — same attempt id, so a duplicate is rejected not billed.
      const { data: reclaimed } = await svc.rpc('reclaim_unresolved_metering', {
        p_business_id: businessId, p_within: `${STRIPE_IDEMPOTENCY_WINDOW_HOURS} hours`,
      });

      const work = [
        ...((claimed ?? []) as { booking_id: string; attempt_id: string }[]),
        ...((reclaimed ?? []) as { booking_id: string; attempt_id: string }[]),
      ];
      if (work.length === 0) {
        // Nothing claimable. Anything still pending is past the cap for this
        // month, so forgive it rather than carry it into next month.
        const { data: forgiven } = await svc.rpc('skip_bookings_for_metering', {
          p_business_id: businessId, p_month_start: monthStart,
        });
        result.capped += (forgiven as number | null) ?? 0;
        continue;
      }

      // A business with nowhere to send usage: release the claims rather than
      // leaving them held, so they are retried once it is configured.
      if (!subId || !meterPrice) {
        for (const w of work) {
          await svc.rpc('settle_booking_metering', {
            p_booking_id: w.booking_id, p_attempt_id: w.attempt_id,
            p_outcome: 'failed', p_error: 'no subscription or meter price configured',
          });
        }
        result.skipped += work.length;
        continue;
      }

      let meterEventName: string | null = null;
      let itemId: string | null = null;
      let customerId: string | null = null;
      try {
        const sub = await stripeGet(`subscriptions/${subId}`);
        const item = (sub.items?.data ?? []).find((i: any) => i.price?.id === meterPrice);
        if (!item) throw new Error('metered price is not on this subscription');
        itemId = item.id as string;
        customerId = sub.customer as string;
        const meterId = item.price?.recurring?.meter as string | undefined;
        if (meterId) meterEventName = (await stripeGet(`billing/meters/${meterId}`)).event_name as string;
      } catch (e) {
        for (const w of work) {
          await svc.rpc('settle_booking_metering', {
            p_booking_id: w.booking_id, p_attempt_id: w.attempt_id,
            p_outcome: 'failed', p_error: e instanceof Error ? e.message.slice(0, 200) : 'subscription lookup failed',
          });
        }
        result.errors.push(`${businessId}: subscription lookup failed`);
        continue;
      }

      for (const w of work) {
        // One booking, one unit, one stable identity. Both Stripe generations
        // get the attempt id — as the meter event's `identifier`, and as the
        // Idempotency-Key on either request.
        const req = buildUsageRequest({
          attemptId: w.attempt_id,
          meterEventName,
          subscriptionItemId: itemId,
          stripeCustomerId: customerId,
        });
        const outcome = await stripeReport(req.path, req.params, req.idempotencyKey);

        const { data: settled } = await svc.rpc('settle_booking_metering', {
          p_booking_id: w.booking_id, p_attempt_id: w.attempt_id,
          p_outcome: outcome.settlement, p_error: outcome.error ?? null,
        });

        if (outcome.settlement === 'reported' && settled) { result.billed++; result.units++; }
        else if (outcome.settlement === 'unresolved') result.unresolved++;
        else if (outcome.settlement === 'failed') result.failed++;
      }

      // Whatever the cap left over is forgiven, not carried forward.
      const { data: forgiven } = await svc.rpc('skip_bookings_for_metering', {
        p_business_id: businessId, p_month_start: monthStart,
      });
      result.capped += (forgiven as number | null) ?? 0;
    }

    return json({ ok: true, fee_pence: BOOKING_FEE_PENCE, cap_units: MONTHLY_CAP_UNITS, ...result });
  } catch (err) {
    console.error('[meter-bookings]', err);
    return json({ error: safeError('meter-bookings', err) }, 500);
  }
});

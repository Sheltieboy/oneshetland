import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfig } from '../_shared/admin-config.ts';

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
 * bookings still get metered_at stamped. Otherwise they would sit unmetered
 * forever and all land on the first invoice if that business ever moved down to
 * Pro — being charged for bookings taken while on a plan that included them.
 *
 * Idempotency: metered_at is set once and never cleared, so re-running this
 * cannot double-bill. Usage is reported BEFORE stamping; a crash in between
 * re-reports at worst, which Stripe's increment tolerates far better than a
 * business being billed twice.
 *
 * Config: stripe.price.booking_meter — the £0.95 usage-based Price on the Pro
 * product. Either generation of Stripe usage billing works: if the Price has a
 * Billing Meter attached we post a meter event, otherwise we post a legacy usage
 * record against the subscription item. The Price itself tells us which, so
 * whoever creates it in the dashboard doesn't have to know or care.
 *
 * Body: none. Safe to run on a schedule.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BOOKING_FEE_PENCE = 95;
const MONTHLY_CAP_UNITS = 17;

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
async function stripe(path: string, params?: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe ${path} failed (${res.status})`);
  return json;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // Service role only. Supabase's gateway already requires SOME valid JWT, but
    // that includes every signed-in user — and this function bills people. Any
    // customer could otherwise trigger a billing run at will. reminder-runner
    // invokes it with the service key, which is the only caller there should be.
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!serviceKey || auth !== serviceKey) {
      return json({ error: 'Forbidden' }, 403);
    }

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey);

    const meterPrice = await getConfig(svc, 'stripe.price.booking_meter', Deno.env.get('STRIPE_PRICE_BOOKING_METER') ?? null);

    const result = { billed: 0, units: 0, capped: 0, premium_marked: 0, skipped: 0, errors: [] as string[] };

    // ── Premium: stamp, don't charge ────────────────────────────────────────
    const { data: premiumBiz } = await svc
      .from('local_businesses').select('id').eq('subscription_tier', 'premium');
    for (const b of premiumBiz ?? []) {
      const { data: marked } = await svc
        .from('book_bookings')
        .update({ metered_at: new Date().toISOString() })
        .eq('business_id', b.id).is('metered_at', null).neq('status', 'cancelled')
        .select('id');
      result.premium_marked += (marked ?? []).length;
    }

    // ── Pro: report usage up to the cap ─────────────────────────────────────
    const { data: due, error: dueErr } = await svc.rpc('bookings_due_metering', { p_cap: MONTHLY_CAP_UNITS });
    if (dueErr) throw dueErr;

    // One row per business per BOOKING month, so each month's cap is spent on
    // that month's bookings and never on an older month's forgiven ones.
    for (const row of due ?? []) {
      const businessId = row.business_id as string;
      const billable   = row.billable_now as number;
      const subId      = row.stripe_subscription_id as string | null;
      const monthStart = row.month_start as string;
      const monthEnd   = new Date(new Date(monthStart).getTime());
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

      // At the cap: stamp the rest so they aren't carried into next month and
      // billed later for something this month's cap already forgave.
      if (billable <= 0) {
        const { data: forgiven } = await svc
          .from('book_bookings')
          .update({ metered_at: new Date().toISOString() })
          .eq('business_id', businessId).is('metered_at', null).neq('status', 'cancelled')
          .gte('created_at', monthStart).lt('created_at', monthEnd.toISOString())
          .select('id');
        result.capped += (forgiven ?? []).length;
        continue;
      }

      if (!subId || !meterPrice) { result.skipped += billable; continue; }

      try {
        // Find the metered item on this subscription.
        const sub = await stripe(`subscriptions/${subId}`);
        const item = (sub.items?.data ?? []).find((i: any) => i.price?.id === meterPrice);
        if (!item) { result.skipped += billable; continue; }

        // Stripe has two generations of usage-based billing and the Price tells
        // us which one this is, so we don't have to know when creating it:
        //
        //   • recurring.meter set  → Billing Meters. Report an event naming the
        //     meter and the CUSTOMER; Stripe attributes it to the subscription.
        //   • no meter             → legacy metered price. Report usage against
        //     the subscription ITEM.
        //
        // Both are increments, so the monthly cap holds either way.
        const meterId = item.price?.recurring?.meter as string | undefined;

        if (meterId) {
          const meter = await stripe(`billing/meters/${meterId}`);
          const eventName = meter.event_name as string;
          await stripe('billing/meter_events', {
            event_name: eventName,
            'payload[stripe_customer_id]': sub.customer as string,
            'payload[value]': String(billable),
            // Same business, same month, same count → same event. Stripe drops
            // the duplicate, so a retry can't bill twice.
            identifier: `bk-${businessId}-${monthStart.slice(0, 7)}-${row.already_billed}`,
          });
        } else {
          await stripe(`subscription_items/${item.id}/usage_records`, {
            quantity: String(billable),
            action:   'increment',
          });
        }

        // Stamp exactly the oldest `billable` bookings — the same ones the count
        // was based on, oldest first so nothing is left waiting indefinitely.
        const { data: toStamp } = await svc
          .from('book_bookings')
          .select('id')
          .eq('business_id', businessId).is('metered_at', null).neq('status', 'cancelled')
          .gte('created_at', monthStart).lt('created_at', monthEnd.toISOString())
          .order('created_at', { ascending: true })
          .limit(billable);
        const ids = (toStamp ?? []).map((b: { id: string }) => b.id);
        if (ids.length) {
          await svc.from('book_bookings').update({ metered_at: new Date().toISOString() }).in('id', ids);
        }
        result.billed++;
        result.units += billable;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[meter-bookings] ${businessId}:`, msg);
        result.errors.push(`${businessId}: ${msg}`);
      }
    }

    return json({ ok: true, fee_pence: BOOKING_FEE_PENCE, cap_units: MONTHLY_CAP_UNITS, ...result });
  } catch (err) {
    console.error('[meter-bookings]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

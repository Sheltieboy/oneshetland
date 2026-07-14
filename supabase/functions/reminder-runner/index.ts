import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * reminder-runner
 *
 * The single scheduled job behind every TIME-BASED notification. Invoke it on a
 * schedule (every ~15 min) — see DEPLOY-NOTIFICATIONS.md for the pg_cron wiring.
 * Each pass is idempotent: a "sent" timestamp on the row gates each reminder so
 * re-running (or overlapping runs) never double-sends.
 *
 * Covers today:
 *   • Booking reminders — 24h and 1h before the appointment (module 'bookings')
 *   • Event reminders   — 24h before the event, to every valid ticket-holder (module 'events')
 *
 * Extension points (left as TODO — Phase 3): daily "wird o' da day",
 * at-risk streak nudges, membership/boost expiry, cruise "arriving today".
 *
 * Auth: if CRON_SECRET is set, callers must send a matching `x-cron-secret`
 * header. (pg_cron / Scheduled Functions can attach it.)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const londonTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const londonDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Optional shared-secret gate.
  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'forbidden' }, 403);
  }

  try {
    const svc = createServiceClient();
    const now = new Date();
    const plus = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();
    const nowIso = now.toISOString();

    const result = { booking_24h: 0, booking_1h: 0, event_24h: 0, daily_wird: 0, streak_nudge: 0, analytics_renewed: 0, analytics_lapsed: 0, fetch_expired: 0 };

    // ── Fetch: expire unmatched delivery requests ────────────────────────────
    // A pending request past its expires_at (set from the customer's "when")
    // lapses to 'expired' — a no-blame "no driver found" state — and the
    // customer is nudged to post it again. Guarded to still-'pending' rows so
    // nothing a driver has accepted is ever touched.
    const { data: dueRequests } = await svc
      .from('delivery_requests')
      .select('id, customer_id, category_slug')
      .eq('status', 'pending')
      .not('expires_at', 'is', null)
      .lt('expires_at', nowIso)
      .limit(200);
    if (dueRequests && dueRequests.length > 0) {
      const ids = dueRequests.map((r) => r.id);
      await svc.from('delivery_requests').update({ status: 'expired' }).in('id', ids).eq('status', 'pending');
      for (const r of dueRequests) {
        await sendUserPush(svc, {
          userId:     r.customer_id,
          module:     'fetch',
          categoryId: 'fetch.expired',
          title:      'No driver found',
          body:       `No driver was able to take your ${r.category_slug ?? 'delivery'} in time. Tap to post it again.`,
          data:       { request_id: r.id, event: 'expired' },
        });
        result.fetch_expired++;
      }
    }

    // London-local date (YYYY-MM-DD) + hour, for once-a-day jobs.
    const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const todayStr = `${london.getFullYear()}-${String(london.getMonth() + 1).padStart(2, '0')}-${String(london.getDate()).padStart(2, '0')}`;
    const londonHour = london.getHours();

    // ── Booking reminders ────────────────────────────────────────────────────
    // 1h window first (imminent). Anything within ~90 min gets the "soon" nudge
    // and we stamp BOTH flags so it can't also collect a "24h" reminder.
    const { data: soon } = await svc
      .from('book_bookings')
      .select('id, customer_id, business_id, service_id, starts_at')
      .eq('status', 'confirmed')
      .is('reminder_1h_sent_at', null)
      .gt('starts_at', nowIso)
      .lte('starts_at', plus(90));

    for (const b of soon ?? []) {
      const where = await businessName(svc, b.business_id);
      await sendUserPush(svc, {
        userId:     b.customer_id,
        module:     'bookings',
        categoryId: 'bookings.reminder',
        title:      'Appointment soon',
        body:       `Your appointment${where ? ` at ${where}` : ''} is at ${londonTime(b.starts_at)} today.`,
        data:       { screen: 'local-my-bookings', booking_id: b.id },
      });
      await svc.from('book_bookings')
        .update({ reminder_1h_sent_at: nowIso, reminder_24h_sent_at: nowIso })
        .eq('id', b.id);
      result.booking_1h++;
    }

    // 24h window: between ~90 min and 24h out, not yet 24h-reminded.
    const { data: tomorrow } = await svc
      .from('book_bookings')
      .select('id, customer_id, business_id, starts_at')
      .eq('status', 'confirmed')
      .is('reminder_24h_sent_at', null)
      .gt('starts_at', plus(90))
      .lte('starts_at', plus(24 * 60));

    for (const b of tomorrow ?? []) {
      const where = await businessName(svc, b.business_id);
      await sendUserPush(svc, {
        userId:     b.customer_id,
        module:     'bookings',
        categoryId: 'bookings.reminder',
        title:      'Appointment reminder',
        body:       `Mind your appointment${where ? ` at ${where}` : ''} on ${londonDay(b.starts_at)} at ${londonTime(b.starts_at)}.`,
        data:       { screen: 'local-my-bookings', booking_id: b.id },
      });
      await svc.from('book_bookings').update({ reminder_24h_sent_at: nowIso }).eq('id', b.id);
      result.booking_24h++;
    }

    // ── Event reminders (24h before) ─────────────────────────────────────────
    const { data: events } = await svc
      .from('events')
      .select('id, title, starts_at')
      .is('reminder_sent_at', null)
      .gt('starts_at', nowIso)
      .lte('starts_at', plus(24 * 60));

    for (const ev of events ?? []) {
      const { data: tickets } = await svc
        .from('event_tickets')
        .select('holder_id')
        .eq('event_id', ev.id)
        .eq('status', 'valid');
      const holders = [...new Set((tickets ?? []).map(t => t.holder_id).filter(Boolean) as string[])];

      if (holders.length) {
        await sendUserPushBulk(svc, holders, {
          module:     'events',
          categoryId: 'events.reminder',
          title:      'Event tomorrow 🎟',
          body:       `${ev.title} is on ${londonDay(ev.starts_at)} at ${londonTime(ev.starts_at)}. Your tickets are in My Wallet.`,
          data:       { screen: 'my-event-tickets', event_id: ev.id },
        });
      }
      // Stamp even when there are no holders, so we don't re-scan it each run.
      await svc.from('events').update({ reminder_sent_at: nowIso }).eq('id', ev.id);
      result.event_24h++;
    }

    // ── Wird o' da day (once per London day, to anyone with a device) ────────
    const { data: wirdCfg } = await svc
      .from('admin_config').select('value').eq('key', 'last_daily_wird_date').maybeSingle();
    if (wirdCfg?.value !== todayStr) {
      const { count } = await svc
        .from('spik_dictionary').select('id', { count: 'exact', head: true })
        .in('word_status', ['approved', 'published']);
      if (count && count > 0) {
        // Deterministic word-of-the-day: same wird for everyone, rotates daily.
        const offset = Math.floor(london.getTime() / 86_400_000) % count;
        const { data: words } = await svc
          .from('spik_dictionary').select('word, short_meaning')
          .in('word_status', ['approved', 'published']).order('id').range(offset, offset);
        const w = words?.[0] as { word?: string; short_meaning?: string } | undefined;
        if (w?.word) {
          const recipients = new Set<string>();
          const { data: withCol } = await svc.from('profiles').select('id').not('push_token', 'is', null);
          for (const r of withCol ?? []) recipients.add(r.id);
          const { data: toks } = await svc.from('push_tokens').select('user_id');
          for (const r of toks ?? []) if (r.user_id) recipients.add(r.user_id as string);
          const body = w.short_meaning ? `${w.word} — ${w.short_meaning}` : w.word;
          const res = await sendUserPushBulk(svc, [...recipients], {
            module: 'spik', categoryId: 'spik.daily_wird',
            title: "Wird o' da day", body, data: { screen: 'spik' },
          });
          result.daily_wird = res.sent;
        }
      }
      // Stamp regardless, so a quiet day doesn't retry every 15 min.
      await svc.from('admin_config')
        .upsert({ key: 'last_daily_wird_date', value: todayStr, category: 'notifications' }, { onConflict: 'key' });
    }

    // ── Streak nudge (evening, once per day, to at-risk streaks) ─────────────
    if (londonHour >= 18) {
      const { data: streakCfg } = await svc
        .from('admin_config').select('value').eq('key', 'last_streak_nudge_date').maybeSingle();
      if (streakCfg?.value !== todayStr) {
        const { data: atRisk } = await svc
          .from('games_user_stats').select('user_id')
          .gt('current_streak_days', 0).lt('last_played_date', todayStr);
        const ids = [...new Set((atRisk ?? []).map(s => s.user_id).filter(Boolean) as string[])];
        const res = await sendUserPushBulk(svc, ids, {
          module: 'games', categoryId: 'games.streak',
          title: 'Keep your streak going! 🔥',
          body: "You've a daily streak on the go — play a game today so you don't lose it.",
          data: { screen: 'games' },
        });
        result.streak_nudge = res.sent;
        await svc.from('admin_config')
          .upsert({ key: 'last_streak_nudge_date', value: todayStr, category: 'notifications' }, { onConflict: 'key' });
      }
    }

    // ── Analytics add-on — wallet auto-renewal ────────────────────────────────
    // Card add-ons auto-renew via Stripe; wallet ones we re-debit here. Empty
    // wallet → pause the add-on and tell the owner.
    try {
      const { data: priceRow } = await svc.from('admin_config').select('value').eq('key', 'analytics.addon_price_pence').maybeSingle();
      const price = Math.round(Number(priceRow?.value)) || 1000;
      const { data: due } = await svc
        .from('business_addons')
        .select('business_id, business:local_businesses(owner_id, name)')
        .eq('addon_key', 'analytics').eq('enabled', true)
        .filter('config->>method', 'eq', 'wallet')
        .filter('config->>paid_until', 'lte', nowIso);
      for (const row of due ?? []) {
        // deno-lint-ignore no-explicit-any
        const biz = (row as any).business;
        const ownerId = biz?.owner_id;
        if (!ownerId) continue;
        const { error: debitErr } = await svc.rpc('wallet_debit', { p_user: ownerId, p_spend: price, p_cashback: 0 });
        if (debitErr) {
          await svc.from('business_addons').update({ enabled: false })
            .eq('business_id', (row as any).business_id).eq('addon_key', 'analytics');
          await sendUserPush(svc, {
            userId: ownerId, module: 'business', categoryId: 'business.analytics_lapsed',
            title: 'Analytics paused',
            body: `We couldn't renew analytics for ${biz?.name ?? 'your business'} from your wallet. Top up or add a card to turn it back on.`,
            data: { screen: 'local-business-dashboard' },
          });
          result.analytics_lapsed++;
        } else {
          await svc.from('local_wallet_transactions').insert({
            user_id: ownerId, business_id: null, type: 'spend', amount_pence: -price,
            description: 'OneShetland analytics add-on (renewal)',
          });
          const next = new Date(); next.setMonth(next.getMonth() + 1);
          await svc.from('business_addons')
            .update({ config: { method: 'wallet', paid_until: next.toISOString() } })
            .eq('business_id', (row as any).business_id).eq('addon_key', 'analytics');
          result.analytics_renewed++;
        }
      }
    } catch (e) { console.error('[reminder-runner] analytics renewal failed', e); }

    return json({ ok: true, ran_at: nowIso, ...result });
  } catch (err) {
    console.error('[reminder-runner]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// Best-effort business display name (null if not found).
async function businessName(
  svc: ReturnType<typeof createServiceClient>,
  businessId: string,
): Promise<string | null> {
  const { data } = await svc
    .from('local_businesses')
    .select('name')
    .eq('id', businessId)
    .maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

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
 *   • Fetch expiry nudges + auto-expiry (module 'fetch')
 *   • Analytics add-on wallet renewal (module 'business')
 *   • Loyalty "just one more stamp" — cards one short (module 'loyalty')
 *   • Loyalty "your reward is waiting" — completed stamp cards (module 'loyalty')
 *   • Pass expiry "use it before you lose it" — within 48h (module 'wallet')
 *
 * Extension points (left as TODO): daily "wird o' da day", at-risk streak
 * nudges, cruise "arriving today".
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

    const result = { booking_24h: 0, booking_1h: 0, event_24h: 0, daily_wird: 0, streak_nudge: 0, analytics_renewed: 0, analytics_lapsed: 0, fetch_reminded: 0, fetch_expired: 0, loyalty_nudge: 0, loyalty_reward: 0, pass_expiring: 0, ticket_orders_expired: 0, product_orders_expired: 0, fetch_orders_nudged: 0 };

    // ── Shop orders: expire unpaid checkouts + release their reserved stock ──
    // A pending product_order holds stock (reserved) so nobody else can buy
    // the last one; if payment never lands within the TTL the hold must die.
    // Status-guarded flip keeps this safe against a webhook racing in.
    try {
      const { data: staleOrders } = await svc
        .from('product_orders')
        .select('id')
        .eq('status', 'pending')
        .lt('expires_at', new Date().toISOString())
        .limit(100);
      for (const o of staleOrders ?? []) {
        const { data: flipped } = await svc
          .from('product_orders')
          .update({ status: 'expired' })
          .eq('id', o.id).eq('status', 'pending')
          .select('id').maybeSingle();
        if (!flipped) continue; // paid in the meantime — leave it alone
        const { data: its } = await svc
          .from('product_order_items')
          .select('product_id, variant_id, qty')
          .eq('order_id', o.id);
        for (const it of its ?? []) {
          if (it.product_id) {
            await svc.rpc('release_product_stock', { p_product: it.product_id, p_variant: it.variant_id ?? null, p_qty: it.qty });
          }
        }
        result.product_orders_expired++;
      }
    } catch (e) { console.error('[reminder-runner] product-order expiry failed', e); }

    // ── Shop orders on the Fetch lane: 48h with no driver → nudge both sides ──
    // The goods are paid; if no driver has picked the run up in two days the
    // buyer and merchant should talk about a plan B (collect, post, re-list).
    try {
      const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
      const { data: stuck } = await svc
        .from('product_orders')
        .select('id, buyer_id, business_id, delivery_request_id, paid_at')
        .eq('fulfilment', 'fetch')
        .is('fetch_nudged_at', null)
        .not('delivery_request_id', 'is', null)
        .lt('paid_at', twoDaysAgo)
        .in('status', ['paid', 'accepted', 'ready'])
        .limit(50);
      for (const o of stuck ?? []) {
        const { data: dr } = await svc.from('delivery_requests').select('status').eq('id', o.delivery_request_id).maybeSingle();
        if (dr?.status !== 'pending') continue; // matched/moving — no nudge needed
        const { data: biz } = await svc.from('local_businesses').select('name, owner_id').eq('id', o.business_id).maybeSingle();
        await sendUserPush(svc, {
          userId: o.buyer_id, module: 'wallet', categoryId: 'wallet.order_update',
          title: 'Still looking for a driver',
          body: `No Fetch driver has picked up your order from ${biz?.name ?? 'the shop'} yet. You could arrange collection with the shop instead.`,
          data: { screen: 'my-orders', product_order_id: o.id },
        });
        if (biz?.owner_id) {
          await sendUserPush(svc, {
            userId: biz.owner_id, module: 'business', categoryId: 'business.order',
            title: 'Fetch order still waiting',
            body: 'A shop order has waited 2 days for a driver. You may want to offer the buyer collection or post instead.',
            data: { screen: 'business-orders', product_order_id: o.id, business_id: o.business_id },
          });
        }
        await svc.from('product_orders').update({ fetch_nudged_at: nowIso }).eq('id', o.id);
        result.fetch_orders_nudged++;
      }
    } catch (e) { console.error('[reminder-runner] fetch-order nudge failed', e); }

    // ── Event tickets: release capacity held by abandoned orders ─────────────
    // Pending (never-paid) ticket orders keep their reserved seats forever,
    // slowly making a popular event look sold out. Expire orders older than 60
    // min (Stripe's success webhook flips genuinely-paid ones to 'paid' within
    // seconds, so only truly-dead orders are still pending by then) — giving the
    // seats back, voiding the tickets and cancelling the orders.
    try {
      const { data: expired } = await svc.rpc('expire_stale_ticket_orders', { p_older_than_minutes: 60 });
      result.ticket_orders_expired = typeof expired === 'number' ? expired : 0;
    } catch (e) { console.error('[reminder-runner] ticket-order expiry failed', e); }

    // ── Fetch: nudge the customer shortly BEFORE a request expires ───────────
    // Still pending, not yet reminded, expiring within the next ~2 hours. One
    // nudge per request (reminder_sent_at), so they can extend or cancel before
    // it silently lapses.
    const soonIso = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    const { data: expiringReq } = await svc
      .from('delivery_requests')
      .select('id, customer_id, category_slug')
      .eq('status', 'pending')
      .is('reminder_sent_at', null)
      .not('expires_at', 'is', null)
      .gt('expires_at', nowIso)
      .lt('expires_at', soonIso)
      .limit(200);
    for (const r of expiringReq ?? []) {
      await sendUserPush(svc, {
        userId:     r.customer_id,
        module:     'fetch',
        categoryId: 'fetch.expiring',
        title:      'Still need this delivery?',
        body:       `No driver has taken your ${r.category_slug ?? 'delivery'} yet. Tap to keep looking or cancel.`,
        data:       { request_id: r.id, event: 'expiring' },
      });
      await svc.from('delivery_requests').update({ reminder_sent_at: nowIso }).eq('id', r.id);
      result.fetch_reminded++;
    }

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

    // ── Loyalty: "just one more stamp" ───────────────────────────────────────
    // Cards that are exactly one stamp short and haven't been nudged for this
    // fill. nudge_reminded_at re-arms on every stamp, so it fires once per card
    // when it reaches N-1. (Two columns can't be compared in PostgREST — filter
    // in code.)
    try {
      const { data: near } = await svc
        .from('local_loyalty_cards')
        .select('id, user_id, stamps_collected, program:local_loyalty_programs(type, stamps_required, stamp_reward, is_active), business:local_businesses(name)')
        .is('nudge_reminded_at', null)
        .gt('stamps_collected', 0)
        .limit(500);
      for (const c of near ?? []) {
        // deno-lint-ignore no-explicit-any
        const prog = (c as any).program;
        // deno-lint-ignore no-explicit-any
        const bizName = (c as any).business?.name ?? 'a Shetland business';
        if (!prog || prog.type !== 'stamps' || prog.is_active === false) continue;
        const needed = prog.stamps_required ?? 0;
        // deno-lint-ignore no-explicit-any
        const left = needed - (c as any).stamps_collected;
        if (needed <= 0 || left !== 1) continue;   // exactly one to go
        const reward = (prog.stamp_reward as string | null)?.trim();
        await sendUserPush(svc, {
          userId:     (c as { user_id: string }).user_id,
          module:     'loyalty',
          categoryId: 'loyalty.almost_there',
          title:      'Just one more stamp ⭐️',
          body:       reward
            ? `One more visit to ${bizName} and ${reward} is yours.`
            : `You're one stamp away from your reward at ${bizName}.`,
          data:       { screen: 'local-my-cards', card_id: (c as { id: string }).id },
        });
        await svc.from('local_loyalty_cards').update({ nudge_reminded_at: nowIso }).eq('id', (c as { id: string }).id);
        result.loyalty_nudge++;
      }
    } catch (e) { console.error('[reminder-runner] loyalty almost-there nudges failed', e); }

    // ── Loyalty: "your reward is waiting" ────────────────────────────────────
    // Stamp cards that have reached their target but haven't been reminded yet.
    // PostgREST can't compare two columns, so we pull un-reminded cards with a
    // stamp on them + their programme/business, then filter in code.
    try {
      const { data: cards } = await svc
        .from('local_loyalty_cards')
        .select('id, user_id, stamps_collected, program:local_loyalty_programs(type, stamps_required, stamp_reward, is_active), business:local_businesses(name)')
        .is('reward_reminded_at', null)
        .gt('stamps_collected', 0)
        .limit(500);
      for (const c of cards ?? []) {
        // deno-lint-ignore no-explicit-any
        const prog = (c as any).program;
        // deno-lint-ignore no-explicit-any
        const bizName = (c as any).business?.name ?? 'a Shetland business';
        if (!prog || prog.type !== 'stamps' || prog.is_active === false) continue;
        const needed = prog.stamps_required ?? 0;
        // deno-lint-ignore no-explicit-any
        if (needed <= 0 || (c as any).stamps_collected < needed) continue;
        const reward = (prog.stamp_reward as string | null)?.trim();
        await sendUserPush(svc, {
          userId:     (c as { user_id: string }).user_id,
          module:     'loyalty',
          categoryId: 'loyalty.reward_ready',
          title:      'Your reward is waiting 🎁',
          body:       reward
            ? `You've earned ${reward} at ${bizName}. Show your phone at the till to redeem.`
            : `Your loyalty reward at ${bizName} is ready. Show your phone at the till to redeem.`,
          data:       { screen: 'local-my-cards', card_id: (c as { id: string }).id },
        });
        await svc.from('local_loyalty_cards').update({ reward_reminded_at: nowIso }).eq('id', (c as { id: string }).id);
        result.loyalty_reward++;
      }
    } catch (e) { console.error('[reminder-runner] loyalty reward reminders failed', e); }

    // ── Passes: "use it before it expires" ───────────────────────────────────
    // Purchased passes with uses left, expiring within ~48h, not yet reminded.
    try {
      const expiryWindow = new Date(now.getTime() + 48 * 60 * 60_000).toISOString();
      const { data: passes } = await svc
        .from('book_unit_purchases')
        .select('id, owner_id, business:local_businesses(name), item:book_unit_items(name)')
        .gt('uses_remaining', 0)
        .is('expiry_reminded_at', null)
        .not('expires_at', 'is', null)
        .gt('expires_at', nowIso)
        .lt('expires_at', expiryWindow)
        .limit(500);
      for (const p of passes ?? []) {
        // deno-lint-ignore no-explicit-any
        const bizName = (p as any).business?.name ?? 'a Shetland business';
        // deno-lint-ignore no-explicit-any
        const itemName = (p as any).item?.name ?? 'pass';
        await sendUserPush(svc, {
          userId:     (p as { owner_id: string }).owner_id,
          module:     'wallet',
          categoryId: 'wallet.pass_expiring',
          title:      'Your pass expires soon ⏳',
          body:       `Your ${itemName} at ${bizName} expires within 48 hours — use it before you lose it.`,
          data:       { screen: 'local-my-passes', purchase_id: (p as { id: string }).id },
        });
        await svc.from('book_unit_purchases').update({ expiry_reminded_at: nowIso }).eq('id', (p as { id: string }).id);
        result.pass_expiring++;
      }
    } catch (e) { console.error('[reminder-runner] pass expiry reminders failed', e); }

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

# Notifications rebuild — deploy checklist

> **STATUS (Jun 27 2026):** Migration applied + verified. All 12 edge functions deployed (Pass 1 + Pass 2) and smoke-verified live. stripe-webhook confirmed `verify_jwt=false`. Still TODO: set `CRON_SECRET` + schedule `reminder-runner` (no rush — no users yet); real push-on-trigger test on a device.


Running list of everything you (Darren) need to apply/deploy for the notifications
work. Code lands in the repo; deploys are manual. Tick as you go.

## 1. Database migration
- [x] `supabase db push` to apply **`20260627000000_notifications_spine.sql`** — APPLIED & verified live (all columns/table/RPCs present, Jun 27 2026)
  - Adds 8 new module columns to `notification_preferences` (cruise defaults OFF).
  - Rewrites `should_notify()` to cover all 15 modules + apply quiet hours to unknown modules.
  - New `push_tokens` table (multi-device) + RLS.
  - `notification_log.read_at` + unread index + `mark_notifications_read()` / `unread_notification_count()` RPCs (backs the in-app inbox).
  - Reminder idempotency columns on `book_bookings` + `events`.
  - Idempotent — safe to re-run.

## ⚠️ verify_jwt — READ FIRST
This project has **no `config.toml`**, so `supabase functions deploy <name>` defaults to `verify_jwt = true`. Three functions are called WITHOUT a Supabase JWT and MUST be deployed with `--no-verify-jwt` or they break:
- `stripe-webhook` (Stripe calls it → payments/refunds/subscriptions break if JWT is required)
- `connect-redirect` (Stripe redirect)
- `reminder-runner` (cron)
Everything else is app- or service-called (JWT / service-role key present), so the default is correct.

## Deploy commands (run from repo root)

**Pass 1 — spine, zero payment risk:**
```bash
supabase functions deploy reminder-runner --no-verify-jwt
supabase functions deploy notify-booking
supabase functions deploy notify-drivers
supabase functions deploy notify-hub
supabase functions deploy hub-broadcast
supabase functions deploy confirm-boost
supabase functions deploy local-stamp-collect
supabase functions deploy local-nfc-stamp
```
Optional (so they pick up the multi-device helper — they still work without it):
```bash
supabase functions deploy notify-collected
supabase functions deploy notify-application-update
supabase functions deploy notify-shift-application
supabase functions deploy notify-shift-complete
supabase functions deploy notify-worker-checkin
supabase functions deploy notify-matching-workers
supabase functions deploy notify-new-offer
```
→ then smoke-test before Pass 2.

**Pass 2 — payment-touching (after Pass 1 verified):**
```bash
supabase functions deploy authorise-payment
supabase functions deploy capture-payment
supabase functions deploy confirm-event-tickets
supabase functions deploy stripe-webhook --no-verify-jwt   # ← MUST keep the flag
```

## 2. Edge functions to (re)deploy
_(Phase 0 + spine so far. List grows as later phases land.)_
- [ ] `notify-drivers` — cancellation now notifies only the assigned driver (was spamming all drivers).
- [ ] `_shared/send-push.ts` is shared — **redeploy every function that imports it** so the multi-device + dead-token-pruning helper ships. (Affected: all `notify-*`, `authorise-payment`, `capture-payment`, `confirm-boost`, `hub-broadcast`, `confirm-event-tickets`, `stripe-webhook`, etc. — simplest is to redeploy all functions.)
- [ ] **`reminder-runner`** (new) — the scheduled time-based reminder job (see §3).
- [ ] **`notify-booking`** (new) — booking notifications (new booking → owner; cancellation → the other party).
- [ ] **`notify-job`** (new) — Jobs notifications (application → employer; status change → applicant; withdrawal → employer; job closed → pending applicants). App + web both invoke it. Deploy with default JWT (app/web send a token).
- [ ] **`notify-engagement`** (new) — social layer on `community` module (story comment/reaction → author; vessel reply → parent commenter; vessel comment → thread). App + web both invoke it. Default JWT.
- [ ] **`notify-shift-status`** (new) — Shifts gaps: shift cancelled → workers (urgent); application withdrawn → employer. App + web. Default JWT.
- [ ] **`notify-event-update`** (new) — event cancellation/changes → all valid ticket-holders (urgent). App posts updates; web has no event-update flow. Default JWT.
- [ ] **`notify-business-alert`** (new) — business urgent alert → its loyalty-card customers (`notices` module; emergency/disruption urgent). App + web. Default JWT.
- [ ] **`notify-claim`** (new) — Directory claim outcome → claimant (approved/rejected, `business` module). App + web admin. Default JWT.
- [ ] **`local-wallet-confirm-topup`** (changed) — top-up receipt → customer (`wallet`). Redeploy.
- [ ] **`local-wallet-pay`** (changed) — payment receipt → customer (`wallet`) + owner "payment received" (`business`). Redeploy.
- [ ] **`confirm-unit-purchase`** (changed) — purchase confirmation → buyer (`wallet`) + owner "new sale" (`business`). Redeploy.
- [ ] **`notify-hub-content`** (new) — hub new notice / new published event → active members (`hubs`). App + web. Default JWT.
- [ ] **`reminder-runner`** (changed, redeploy) — now also sends "Wird o' da day" (once/day, `spik`) + evening at-risk streak nudge (`games`), date-idempotent via admin_config. `--no-verify-jwt`. Only fires once the cron (§3) is scheduled.
- [ ] **`notify-matching-workers`** (redeploy, optional) — now actually invoked on every shift post (free posts included); works as-is, redeploy only to pick up the multi-device helper.
- [ ] **`confirm-hub-donation`** (changed) — now notifies the donor (receipt) + hub admins (new donation). Redeploy. App + web both call it, so web donations also notify.
- [ ] **`notify-hub`** — already deployed (Pass 1); now also invoked on member approval (app `approveMember` + web). No redeploy needed.
- [ ] **`stripe-webhook`** — now notifies a business owner when their subscription lapses/ends (silent-downgrade fix).
- [ ] **Raw → preference-aware sends (P1 #7)** — redeploy these now that they honour prefs/quiet-hours and log to the inbox: `authorise-payment`, `capture-payment`, `confirm-boost`, `local-stamp-collect`, `local-nfc-stamp`, `hub-broadcast`, `notify-hub`, `confirm-event-tickets`. (`notify-business-claim` deliberately stays raw — admin-only.)

## 3. Scheduler (for time-based reminders)
- [ ] Deploy the **`reminder-runner`** edge function (booking 24h/1h + event 24h reminders; idempotent via the sent-flag columns).
- [ ] (Recommended) Set a **`CRON_SECRET`** env on the function; the scheduler must send a matching `x-cron-secret` header.
- [ ] Schedule it every ~15 min via **one** of:
  - **Supabase Dashboard → Database → Cron** (pg_cron), e.g.
    ```sql
    select cron.schedule('reminder-runner', '*/15 * * * *', $$
      select net.http_post(
        url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/reminder-runner',
        headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
      );
    $$);
    ```
    (requires the `pg_cron` + `pg_net` extensions enabled), **or**
  - a Supabase **Scheduled Function**.
Until this is scheduled, booking/event reminders (and later daily wird, streak + expiry nudges) cannot fire.

## 4. App / web
- App + web ship via their normal build/deploy. No special steps beyond the above.

## Notes
- `has_payment_method`, `stripe_customer_id`, `push_token` clearing: `push_token` is NOT locked by `tg_profiles_lock_sensitive`, so client clears (sign-out) stick.

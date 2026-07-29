# OneShetland — Payment Test Plan (TEST mode)

_Exercise every payment flow with fake money before going live. You're already on test keys, so nothing needs switching. Tick each box as it passes._

## Test cards (Stripe test mode)
- **Success:** `4242 4242 4242 4242` · any future expiry · any CVC · any postcode
- **Declined:** `4000 0000 0000 0002`
- **Needs 3-D Secure prompt:** `4000 0025 0000 3155`

## Where to test
- **Web** is ready now (no build needed) — easiest. Use the deployed site or `npm run dev`.
- **App** needs a dev/production build first (the new member-card / wallet / loyalty UI isn't in a build yet). Test on web first; do the app once it's built (Phase 4).

## One-time setup — test webhook (only needed for Part B)
Stripe Dashboard with **Test mode ON** → Developers → Webhooks → Add endpoint:
- URL: `https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook`
- Same 9 events as the live one (payment_intent.succeeded, payment_intent.payment_failed, account.updated, customer.subscription.created/updated/deleted, invoice.payment_succeeded, transfer.created, charge.refunded)
- Copy the **test** signing secret and set it:
  ```bash
  cd ~/Claude/oneshetland-delivers
  supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_test_xxx'
  ```
  _(This is the TEST secret for now; you'll swap it for the live one at go-live.)_

---

## Part A — Every flow, happy path (no webhook needed)
Each: pay with `4242…`, then confirm the thing was actually granted.

- `[ ]` **Wallet top-up** → balance goes up by the amount
- `[ ]` **Pay at till** (needs wallet balance) → business receives it, your balance drops
- `[ ]` **Buy a pass / unit** → appears in My Passes with the right uses
- `[ ]` **Gift** → gift code created; recipient email arrives
- `[ ]` **Event ticket** → ticket issued, shows in wallet, scans as **valid**
- `[ ]` **Hub donation** → recorded on the campaign (try Gift Aid on a charity hub too)
- `[ ]` **Hub membership** → membership activates, member number shown
- `[ ]` **Business subscription (Pro)** → tier upgrades; then cancel via the billing portal
- `[ ]` **Boost** (shift or business Pro) → boost applies
- `[ ]` **Booking deposit** (Fetch) → pre-auth taken on driver accept; captured on delivery
- `[ ]` **Stripe Connect onboarding** → complete Stripe's test onboarding → payouts show enabled

### Failure paths (quick)
- `[ ]` Pay with `4000…0002` (declined) → clean error, **nothing** granted, no balance change
- `[ ]` Try to pay-at-till for more than your wallet holds → blocked with a clear message

---

## Part B — The webhook safety-net (the new bit)
Proves fulfilment still happens if the app never "phones home", and that it never double-grants.

1. `[ ]` **No double-grant:** make a successful test purchase (say a £1 top-up). In Stripe → Developers → **Events**, find its `payment_intent.succeeded` and click **Resend**. Re-check your balance — it must be **unchanged** (the webhook saw it was already done and did nothing). ✅ idempotent.
2. `[ ]` **Rescue works** (optional, technical): with the Stripe CLI —
   ```bash
   stripe listen --forward-to https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook
   stripe trigger payment_intent.succeeded
   ```
   Watch the reminder-runner/webhook logs (Supabase → Edge Functions → Logs) show it fulfilling.

---

## Watching what happens
- **Supabase → Edge Functions → Logs** — pick `stripe-webhook` to see each event handled (look for the `fulfil …` lines).
- **Stripe → Developers → Events / Logs** — every test charge + webhook delivery (green = 200).

## When Part A is all ticked
You've proven the whole payment system end-to-end on fake money. Then Phase 2 (go live) is just swapping test keys → live keys and repeating a couple of £1 real charges.

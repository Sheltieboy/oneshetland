# OneShetland — Launch Checklist

_One ordered list. Work top to bottom. Nothing here is vague — every step says exactly what to do._

**Legend:** `[ ]` = you do it · `[C]` = Claude does it (just ask) · `[✓]` = already done

**Your project ref:** `nkrtmakxygkvxuxriiil`
**Your live webhook URL will be:** `https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook`

---

## Where you are right now (the honest read)

The whole product is built and the payment security is done right. What's left is: a bit of payment *hardening* (code — Claude), a set of *config flips* to go from test to live (you), and the *store listing* tasks (you). That's it. You're close.

---

## Phase 1 — Payment hardening (code) · ✅ DONE (29 Jul 2026)

All five items complete and type-checked clean. They stop real customers being charged-without-getting-it.

- `[✓]` **1.1 Webhook safety-net fulfilment.** New `_shared/fulfilment.ts` + wired into `stripe-webhook` `payment_intent.succeeded` for wallet top-up, unit/pass, gift, event tickets, hub donation, hub membership. Idempotent on the PaymentIntent id — a no-op when the client already confirmed, a rescue when it didn't. `confirm-*` functions left untouched (zero regression risk).
- `[✓]` **1.2 Idempotency keys** added to the off-session charges in `local-wallet-topup-intent` and `create-boost-intent` (matches the pattern the other 5 already use). Top-up also accepts an optional client key so genuine repeat top-ups aren't blocked.
- `[✓]` **1.3 Event-ticket slot cleanup.** New migration `20260729020000_expire_stale_ticket_orders.sql` (RPC that releases seats + voids tickets + cancels dead orders, row-locked and safe), called each pass of `reminder-runner` with a 60-min window.
- `[✓]` **1.4 Apple Wallet diagnostic error reverted** (no longer leaks internal errors).
- `[✓]` **1.5 Stripe API version pinned** (`2023-10-16`) on all 7 raw-fetch functions — whole codebase now consistent.

**Now redeploy — you run (needs your password):**

⚠️ **`stripe-webhook` and `reminder-runner` MUST use `--no-verify-jwt`** — this project has no config.toml, so a plain deploy defaults JWT-auth ON, which blocks Stripe (and the cron) from ever reaching them.

```bash
cd ~/Claude/oneshetland-delivers
supabase db push

# The two PUBLIC functions — keep the flag every time:
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy reminder-runner --no-verify-jwt

# The rest are called by the app with a login token — JWT-auth ON is correct:
supabase functions deploy local-wallet-topup-intent create-boost-intent apple-wallet-pass authorise-payment capture-payment cancel-payment create-connect-account create-setup-intent confirm-card-setup remove-card
```
_(`supabase db push` applies the ticket-cleanup migration. Safe to run now — everything is backward-compatible and still works in test mode. `connect-redirect` is the 3rd public function but doesn't need redeploying here.)_

---

## Phase 2 — Switch Stripe TEST → LIVE · you do these

⚠️ **Nothing real can be charged until this is done.** Do it all in one sitting.

- `[ ]` **2.1 Get your LIVE keys** from Stripe Dashboard (toggle off "Test mode", top-right) → Developers → API keys. You need the `sk_live_…` (secret) and `pk_live_…` (publishable).
- `[ ]` **2.2 Create LIVE Products/Prices.** Test price IDs don't work with live keys. Recreate your subscription + add-on prices in live mode and note each new `price_…` id (Pro, Premium, Local add-on, Analytics add-on, Alert add-on).
- `[ ]` **2.3 Register the LIVE webhook.** Stripe Dashboard (live mode) → Developers → Webhooks → Add endpoint:
  - URL: `https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook`
  - Events to send: `payment_intent.succeeded`, `payment_intent.payment_failed`, `account.updated`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `transfer.created`, `charge.refunded`
  - Copy the endpoint's **signing secret** (`whsec_…`).
- `[ ]` **2.4 Set the LIVE secrets in Supabase** (run in `~/Claude/oneshetland-delivers`, with your live values):
  ```bash
  supabase secrets set \
    STRIPE_SECRET_KEY='sk_live_xxx' \
    STRIPE_WEBHOOK_SECRET='whsec_xxx' \
    STRIPE_PRICE_LOCAL_PRO='price_xxx' \
    STRIPE_PRICE_LOCAL_PREMIUM='price_xxx' \
    STRIPE_PRICE_LOCAL_ADDON='price_xxx' \
    STRIPE_PRICE_ANALYTICS_ADDON='price_xxx' \
    STRIPE_PRICE_ALERT_ADDON='price_xxx'
  ```
  _(Use straight quotes `'…'`, never smart/curly quotes.)_
  If you use Stripe Connect webhooks separately, also set `STRIPE_CONNECT_WEBHOOK_SECRET`.
- `[ ]` **2.5 Set the LIVE publishable key on the clients:**
  - **Web (Netlify):** Site settings → Environment variables → set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_live_…` → redeploy.
  - **App:** set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_live_…` (in your EAS build env / `.env`), then rebuild (Phase 4).

---

## Phase 3 — Web go-live · you do these

- `[ ]` **3.1 Domain cutover.** Point `oneshetland.com` DNS at Netlify (currently the site lives on `oneshetland.netlify.app`; the old WordPress is still on the domain).
- `[ ]` **3.2 Supabase Auth Site URL.** Once DNS is live, change Auth → URL Configuration Site URL from `oneshetland.netlify.app` → `https://oneshetland.com` (and update redirect URLs).
- `[ ]` **3.3 Submit sitemap in Google Search Console** (`https://oneshetland.com/sitemap.xml`) and run "Validate fix" on the earlier 404/soft-404 reports.

---

## Phase 4 — App store submission · you do these

- `[✓]` Store hard-blockers resolved: in-app purchases → web-only, account deletion, UGC report/block/EULA. _Done._
- `[ ]` **4.1 Production EAS build.** The app has unbuilt UI (member card, wallet passes, loyalty ladder) waiting on a build. Build with the **live** publishable key from 2.5:
  ```bash
  cd ~/Claude/oneshetland-delivers
  eas build --platform all --profile production
  ```
- `[ ]` **4.2 Demo review account** — create a test login for Apple/Google reviewers.
- `[ ]` **4.3 Data-safety / App-privacy forms** (Play Console + App Store Connect).
- `[ ]` **4.4 Privacy-policy URL** — point to your live `/privacy` page.
- `[ ]` **4.5 Submit** for review (`eas submit --platform all --profile production`).

---

## Phase 5 — Right after launch (not blocking)

- `[ ]` **5.0 Set `CRON_SECRET`** so the scheduler endpoint isn't publicly triggerable, then schedule reminder-runner (Dashboard → Database → Cron, every ~15 min, sending a matching `x-cron-secret` header). Low severity (jobs are idempotent) but close it before real traffic:
  ```bash
  cd ~/Claude/oneshetland-delivers
  supabase secrets set CRON_SECRET='pick-a-long-random-string'
  ```
- `[ ]` **5.1 Rotate the Google service-account key** (it was briefly in local git). Create a new key, update `GOOGLE_WALLET_SA_JSON` secret, delete the old one in Google Cloud.
- `[C]` **5.2 Notification coverage** for the sections that still lack it (task #11).
- `[C]` **5.3 Remove misleading free-tier toggles / QR copy mismatches** (task #89).
- `[C]` **5.4 Almanac Phase 2 recipes** (events roundups, cruise days) to keep content flowing.

---

## Phase 6 — Live smoke test (do once, after Phase 2)

With live keys on, make **one real low-value payment** through each path and confirm you got the thing (and can refund it):

- `[ ]` Wallet top-up (£1) → balance credited
- `[ ]` Pay-at-till from wallet → business receives it
- `[ ]` Buy a pass / unit → appears in your account
- `[ ]` Buy an event ticket → ticket issued + scans as valid
- `[ ]` Hub donation + membership → recorded
- `[ ]` Business subscription (Pro) → tier upgrades, then cancel via billing portal
- `[ ]` Refund one of them → money returns + access revoked

---

### The 3-line version
1. **Claude** hardens payments (Phase 1) → you redeploy.
2. **You** flip Stripe to live + webhook + domain (Phases 2–3).
3. **You** build & submit the apps (Phase 4), then smoke-test (Phase 6).

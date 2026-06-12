# OneShetland — Security & Data-Protection Audit

_Assessment date: 2026-06-12. Covers the Expo/React Native client, Supabase
(Postgres + RLS), Edge Functions, Stripe payments, and UK GDPR posture._

This report is organised so you can work top-down. Each issue has a **status**:

- ✅ **FIXED NOW** — I applied it in this session (still needs you to apply/deploy — see "How to ship the fixes").
- 🟡 **PROMPT READY** — copy the prompt block into a new chat with me when you're back and I'll do it.
- 📋 **YOUR ACTION** — a console/process/legal task only you can do.

> ⚠️ Two subagent recommendations were **wrong** and I did NOT act on them — see
> "Corrections" at the end. Verification matters; don't apply those blindly.

---

## 0. How to ship the fixes I already made

### Session 1 (done)
1. ✅ **Migration 064** applied — admin privilege-escalation closed.
2. ✅ **stripe-webhook** deployed — fail-closed + replay protection live.

### Session 2 — payment hardening + secure storage (apply/deploy these)
3. **Apply migration** `065_wallet_atomic_ops.sql` (adds `wallet_credit` / `wallet_debit` atomic RPCs). **Apply this BEFORE deploying the wallet functions below**, or they'll error calling the RPCs.
4. **Deploy the hardened edge functions** (after migration 065 is applied):
   ```
   npx supabase functions deploy authorise-payment
   npx supabase functions deploy capture-payment
   npx supabase functions deploy local-wallet-pay
   npx supabase functions deploy local-wallet-confirm-topup
   ```
   Then test on a real flow: a driver accepting/completing a delivery (should still charge), and a wallet top-up + pay (balance should move correctly).
5. **Secure-store for tokens** (`lib/supabase.ts`) ships on your next **app build**. ⚠️ Expect a **one-time forced re-login** for existing users (their old session lived in AsyncStorage). Test on a real device: sign in → kill app → reopen (should stay signed in) → sign out.

### Session 3 — mop-up (partial)
6. **Apply migration** `066_security_memory_reactions.sql` (tightens reaction reads to visible memories).
7. **Redeploy `stripe-webhook`** for the `account.updated` account-type guard: `npx supabase functions deploy stripe-webhook`.
8. **Email-injection fix** in `_shared/send-email.ts` (HTML-escapes interpolated values + footer): rides along whenever you next redeploy the email-sending functions — not urgent (needs an admin-config compromise or a malicious template var to exploit).
- **Corrected from the raw audit:** game leaderboards already display `games_handle ?? 'Anon'` (never real names) — no fix needed. EXIF-stripping needs the `expo-image-manipulator` dependency → see prompt below.

---

## 1. CRITICAL

### 1.1 ✅ FIXED NOW — Any user could make themselves an admin
- **Where:** `supabase/migrations/001_initial_schema.sql:28` — profiles UPDATE policy `WITH CHECK (auth.uid() = id)` with no guard on `role`.
- **Risk:** A signed-in user could PATCH their own profile row (`role = 'admin'`) directly via the REST API using the public anon key, then pass every `profiles.role = 'admin'` check in the app — approve business claims, edit platform config, read data, etc. Full takeover.
- **Fix applied:** `064_security_profiles_lock.sql` adds a BEFORE UPDATE trigger that resets `role`, `email_verified`, `is_active`, `has_payment_method`, `stripe_customer_id`, `stripe_account_id` to their old values on self-service updates. Service-role/edge-function writes (auth.uid() null) are unaffected, so nothing legitimate breaks.
- **Verify after applying:** as a normal user, try to set your role to admin from the app/REST — it should silently stay unchanged.

### 1.2 ✅ FIXED NOW — Stripe webhook accepted unsigned/forged events
- **Where:** `supabase/functions/stripe-webhook/index.ts:306` — `if (!secret) return JSON.parse(payload)` skipped signature checks when the secret was unset; no replay-timestamp check.
- **Risk:** If `STRIPE_WEBHOOK_SECRET` were ever empty in prod, anyone could POST a forged `payment_intent.succeeded` / `customer.subscription.updated` / `account.updated` and grant themselves free Premium, fake paid orders, or redirect payout state. Replay of an old signed event was also possible.
- **Fix applied:** fail-closed (throw if no secret) + reject events older than 5 minutes.
- **⚠️ Action before deploy:** ensure both webhook secrets are set (see §0), or live webhooks will start failing.

### 1.3 🟡 PROMPT READY — Payment endpoints trust the caller without verifying resource ownership
- **Where:** `supabase/functions/authorise-payment/index.ts` and `capture-payment/index.ts` — fetch a `delivery_request` by client-supplied `request_id` using the service-role key (bypasses RLS) but don't confirm the caller is the assigned driver. Similar IDOR shape in `local-business-onboard`, `alert-addon-intent` (validate ownership but not active state).
- **Risk:** A driver could authorise/capture a charge against a customer's card on a delivery that isn't theirs.
- **Why not auto-fixed:** touches live money flows; needs you to confirm the `runs`/`delivery_requests` ownership column names and test before deploy.

  ```
  PROMPT: In the OneShetland repo, audit and fix IDOR in the payment edge
  functions. In supabase/functions/authorise-payment and capture-payment,
  after verifying the JWT user, also verify that user is the driver assigned to
  the run behind request_id (load the run and check driver_id === user.id; 403
  otherwise). Do the same ownership/active-state checks in local-business-onboard
  and alert-addon-intent. Show me each change and the exact ownership column you
  used before I deploy.
  ```

### 1.4 🟡 PROMPT READY — Client-supplied amounts in wallet top-ups
- **Where:** `local-wallet-topup-intent` / `local-wallet-confirm-topup` use `amount_pence` from the request body.
- **Risk:** a tampered client could request arbitrary amounts (bounded only by client-side validation).
- **Note:** there IS server-side min/max validation (£5–£500), so this is lower-risk than a pure-trust case, but the confirm step should re-verify the PaymentIntent's actual amount against an allow-list.

  ```
  PROMPT: In OneShetland's local-wallet-confirm-topup edge function, after
  retrieving the PaymentIntent from Stripe, verify intent.amount is one of the
  allowed top-up amounts (and matches what was charged) before crediting the
  wallet, instead of trusting the amount path. Also fix the non-atomic wallet
  balance read-modify-write (see issue 2.4). Show me the diff.
  ```

---

## 2. HIGH

### 2.1 ✅ FIXED NOW (by migration 063) — Members-only notices logic
- The `notices` read policy in `045_concierge_schemas.sql:71` had an operator-precedence bug (missing parens → hidden/expired notices leaking). **My migration 063 already drops and recreates that policy with correct parentheses and visibility gating**, so once 063 is applied this is resolved. No action needed beyond applying 063 (which you've done).

### 2.2 🟡 PROMPT READY — Auth session stored in unencrypted AsyncStorage
- **Where:** `lib/supabase.ts:21` — `storage: AsyncStorage`. JWT/refresh tokens sit in plaintext app storage; extractable on rooted/jailbroken devices or via backups.
- **Why not auto-fixed:** swapping to `expo-secure-store` is the right move but SecureStore has a ~2KB per-key limit and Supabase sessions can exceed it, so it needs a **chunking adapter** and a rebuild + login test on a device — not safe to flip blind while you're away (could lock everyone out of login).

  ```
  PROMPT: In OneShetland, migrate the Supabase auth session from AsyncStorage to
  expo-secure-store using a chunked storage adapter (SecureStore has a ~2KB
  limit; split values across multiple keys). expo-secure-store is already in
  app.json. Keep autoRefreshToken/persistSession. Then walk me through testing
  sign-in, app-restart persistence, and sign-out on a real device before release.
  ```

### 2.3 📋 YOUR ACTION — Google Places API key is shippable & possibly unrestricted
- **Where:** `.env` `EXPO_PUBLIC_GOOGLE_PLACES_KEY=…` (correctly public, but only safe if locked down).
- **Action:** In Google Cloud Console, restrict the key by **iOS bundle id / Android package name**, and restrict **API scope** to just the Places APIs you use. Otherwise someone can lift it from the bundle and run up your bill. (No code change needed.)

### 2.4 🟡 PROMPT READY — Wallet balance race condition + missing Stripe idempotency keys
- **Where:** `local-wallet-confirm-topup` (read-modify-write of `balance_pence`) and `local-wallet-pay` (Stripe Transfer with no `Idempotency-Key`).
- **Risk:** concurrent top-ups overwrite each other; a retried transfer could double-pay a business.
- Bundled into the prompt in §1.4, plus:

  ```
  PROMPT: In OneShetland's local-wallet-pay edge function, add an Idempotency-Key
  header to the Stripe Transfer (derive a stable key from user+business+amount+
  order id). And replace any read-then-write of local_wallet_balances with an
  atomic SQL increment (UPDATE ... SET balance_pence = balance_pence + $1) or a
  Postgres RPC. Show me the diff.
  ```

### 2.5 🟡 PROMPT READY — Verbose error/CORS surface on edge functions
- Payment functions return raw Stripe error messages (leak object ids) and set `Access-Control-Allow-Origin: *`. Lower impact for a mobile app, but worth tightening.

  ```
  PROMPT: Across OneShetland's payment/admin edge functions, return generic
  client-facing error messages (log full detail server-side only), and replace
  the wildcard CORS with an allow-list of the app's known origins. List the
  functions you changed.
  ```

### 2.6 🟡 PROMPT READY — Hub committees can resolve members' personal data
- **Where:** `063_hubs_and_notices.sql` — `hub_members` is readable by hub admins (correct), but the `profiles` table has no hub-scoped restriction, so a committee could resolve members' names/phone/email. Sensitive given **youth** hubs.
- **Why not auto-fixed:** the right design (a privacy-preserving member view, or member-consented contact sharing) is a product decision, not a one-liner.

  ```
  PROMPT: In OneShetland, design and implement privacy-safe hub member listing:
  hub committees should see member display names but NOT phone/email unless the
  member opted into sharing. Add the needed column/flag + a SECURITY DEFINER view
  or RPC that returns only permitted fields, and update the hub-members screen to
  use it. Pay special attention to youth-type hubs.
  ```

---

## 3. MEDIUM

### 3.1 🟡 PROMPT READY — No rate limiting on payment-intent / claim / token endpoints
- Payment-intent creation, `approve_business_claim`, NFC tile (`nfc/[token]`) and gift code (`g/[code]`) claims have no throttle → brute-force / cost-amplification / enumeration risk.
  ```
  PROMPT: Add per-user (and where possible per-IP) rate limiting to OneShetland's
  payment-intent edge functions and to the NFC tile and gift-code claim RPCs, plus
  client-side debounce on the t/[token], nfc/[token] and g/[code] screens. Suggest
  a lightweight approach (e.g. a rate_limits table or a counter) and implement it.
  ```

### 3.2 🟡 PROMPT READY — Email-template HTML injection
- `supabase/functions/_shared/send-email.ts` interpolates admin-controlled footer/social values and template vars into HTML without escaping.
  ```
  PROMPT: In OneShetland's _shared/send-email.ts, HTML-escape all interpolated
  values (footer promo text/url, social labels/urls, and template variables) and
  cap variable length. Show me the diff.
  ```

### 3.3 🟡 PROMPT READY — `memory_reactions` / `games_scores` over-broad read
- `memory_reactions` is readable by any signed-in user regardless of memory visibility; game leaderboards expose real `full_name`.
  ```
  PROMPT: In OneShetland, (a) tighten the memory_reactions SELECT policy so a
  reaction is only readable if the caller can see the parent memory (or owns the
  reaction) — but first check how the app queries reactions so we don't break
  counts; (b) add an opt-in "show my name on leaderboards" setting and default
  game leaderboards to a handle/anonymised name instead of full_name.
  ```

### 3.4 🟡 PROMPT READY — Precise home coordinates + EXIF in uploads
- `profiles.home_lat/lng` stored at ~0.1m precision; memory photo uploads may carry EXIF GPS.
  ```
  PROMPT: In OneShetland, round stored user home_lat/lng to ~3 decimals for
  non-essential uses, and strip EXIF (esp. GPS) from images before upload in the
  image-upload pipeline. Show me where to change it.
  ```

---

## 4. LOW

- **Console logging of ids/PII** across `context/AuthContext.tsx`, several edge functions, `apply-driver.tsx`. → 🟡 `PROMPT: Replace sensitive console.log/console.error calls in OneShetland (client + edge functions) with a logger that only logs in __DEV__ and never logs tokens, emails, full profile objects or Stripe ids.`
- **`account.updated` webhook doesn't check account type** (`stripe-webhook`). Minor. Fold into the §1.3 prompt if you like.
- **`admin_config` has a redundant anon SELECT grant** (RLS still protects it). Cosmetic; remove for least-privilege when convenient.

---

## 5. UK GDPR / Data Protection (this is the biggest gap — mostly process, not code)

You're a UK data controller (Shetland), so UK GDPR + DPA 2018 apply. The `compliance_log` table is a genuine strength (immutable consent audit trail). The gaps below are **launch-blocking** for a public release.

| # | Gap | Principle | Status |
|---|-----|-----------|--------|
| 5.1 | **No privacy policy / terms surfaced in-app** (templates reference versions, but no document/links) | Transparency (Art. 13–14) | 📋 YOUR ACTION (author docs) + 🟡 prompt to wire acceptance UI |
| 5.2 | **No children's consent flow** despite youth clubs / playgroups / games with named leaderboards | Children (Art. 8) | 📋 + 🟡 |
| 5.3 | **No self-service account deletion** (right to erasure) — `account.deletion_req` is logged but nothing actions it | Erasure (Art. 17) | 🟡 |
| 5.4 | **No data export** (right to portability) | Portability (Art. 20) | 🟡 |
| 5.5 | **Voice transcription of memory audio has no consent capture** | Lawful basis / consent (Art. 6/7) | 🟡 |
| 5.6 | **No push-notification / location / payment consent log entries** | Consent (Art. 7) | 🟡 |
| 5.7 | **No Data Processing Agreements** with Stripe, Postmark, Expo, Google | Processors (Art. 28) | 📋 YOUR ACTION |
| 5.8 | **Event attendee PII handling undefined** (`requires_attendee_details` with no attendee table/RLS/retention) | Minimisation (Art. 5) | 🟡 |
| 5.9 | **No data-retention/purge policy** (notification_log, email_log kept forever) | Storage limitation (Art. 5) | 🟡 |
| 5.10 | **ICO registration** as a data controller (free, required) | Accountability | 📋 YOUR ACTION |

**Ready-to-run prompts:**

```
PROMPT (erasure + export): Build OneShetland account self-service: a "Delete my
account" flow (edge function that cascades deletion across all user tables,
anonymises/deletes the Stripe customer, revokes push tokens, logs
account.deletion in compliance_log, sends confirmation email) and a "Download my
data" export (JSON of the user's personal data, logged as data.export_requested).
Add the UI in the account screen. Walk me through what gets deleted vs retained.
```

```
PROMPT (children's consent): Implement an age gate at OneShetland signup and a
parental-consent flow for under-16s (capture parent email, require confirmation,
log age.confirmed + parental consent in compliance_log). Restrict under-16
accounts from public leaderboards and marketing. Tell me the schema changes.
```

```
PROMPT (consent capture): Add explicit in-app consent capture (with
compliance_log entries) for: push notifications (before registerPushToken),
storing home location, and voice transcription of memory audio (with an opt-out).
Show the UI and the logging.
```

```
PROMPT (attendee data + retention): Define an event_attendees schema with RLS
(buyer/organiser/admin scoped) for when requires_attendee_details is on, plus a
retention purge (delete attendee rows N months after the event) and scheduled
purges for notification_log/email_log older than 12 months.
```

**Your (non-code) actions:** author a Privacy Policy + Terms (cover Stripe/Postmark/Expo/Google/open-meteo, lawful bases, children, retention, ICO complaint route); sign DPAs with each processor; register with the ICO; consider a DPIA for voice transcription, location and children's data.

---

## 6. Corrections to the raw audit (do NOT apply these subagent suggestions)

- ❌ **"Revoke `anon` EXECUTE on `is_hub_member` / `is_hub_admin`."** These SECURITY DEFINER functions are called *inside the `notices` RLS read policy*, which evaluates as the caller's role. Revoking `anon` execute would break **public** notice reads for logged-out users. The functions only return booleans and need valid UUIDs to probe, so the enumeration risk is negligible. **Leave the grants as they are.**
- ❌ **The suggested profiles fix using `NEW`/`OLD` inside an RLS policy.** RLS policies can't reference `NEW`/`OLD` — that's trigger syntax. My migration 064 uses a proper BEFORE UPDATE trigger instead.
- ⚠️ **"notices read precedence bug" (045).** Real in 045, but already superseded by migration 063's rewritten policy. No separate fix needed.

---

## 7. Suggested order of attack when you're back

1. Apply migration **064** + deploy the hardened **stripe-webhook** (after confirming secrets). _(both already written)_
2. Lock down the **Google Places key** (5 min, console only).
3. Run the **§1.3 + §1.4 + §2.4** payment-hardening prompts (money path).
4. Run the **§2.2** secure-store prompt (token storage).
5. Work the **GDPR** prompts (5.3/5.4 erasure+export, then consent, then children) — these gate a public launch.
6. Mop up MEDIUM/LOW at leisure.

_Nothing in §3–§4 is exploitable for takeover; §1 and the payment items in §1.3–§1.4 + the GDPR erasure/consent gaps are the ones that matter most._

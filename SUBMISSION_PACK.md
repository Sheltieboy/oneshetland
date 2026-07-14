# OneShetland — App Store Submission Pack

Everything you need to submit to the **Apple App Store** and **Google Play**.
The engineering blockers are all resolved (see `SUBMISSION_PACK` status at the
bottom). This doc is the human/console side — copy-paste ready.

App: **OneShetland** · bundle id / package **com.oneshetland.app** · v **1.0.0**

---

## 1. Demo / review account  ⚠️ YOU MUST CREATE THIS

Apple **requires** working credentials (the app needs login). Google asks for
them too. Create a normal account in the app, then enrich it so reviewers can
see the gated sections:

1. In the app, sign up: `review@oneshetland.com` (use a real inbox you control) + a strong password.
2. In Supabase, for that user's `profiles` row, set `role = 'business_owner'` and claim/own a demo business (so the reviewer can see the business dashboard), and approve them as a driver if you want the Fetch driver flow visible. (Or just explain role-gating in the notes below.)
3. Keep the password handy for the review notes.

> Don't ship a hard-coded demo login in the app — just give Apple the credentials in App Review notes.

---

## 2. Apple — App Review Notes  (paste into "Notes" in App Store Connect)

```
Demo account:
  Email: review@oneshetland.com
  Password: <YOUR_PASSWORD_HERE>

OneShetland is a community super-app for the Shetland Islands: local business
directory, What's On / events, a delivery service (Fetch), bookings, jobs &
shifts, community hubs, a dialect ("Spik") section, local history ("Memories"
and "Da Boats"), and a payment wallet.

Navigation:
- Sign in with the demo account above (login is required to use the app).
- Main sections are on the home tabs and the "More" menu.
- The demo account is a business owner — open the business dashboard from the
  Local/Directory area to see seller features.

Payments / purchases:
- Consumer payments (event tickets, deliveries, bookings, gifts, wallet top-up,
  donations) are real-world goods/services processed by Stripe.
- Business/seller subscriptions and add-ons are NOT sold in the app — they are
  managed only on our website. The app shows plan status and locked features
  only; there is no in-app purchase of digital features (per guideline 3.1.1).

User-generated content safety:
- Every piece of user content (memories, comments, profiles, listings) has a
  Report option and a Block-user option. Blocked users are hidden.
- Terms with a zero-tolerance objectionable-content policy: https://oneshetland.com/terms
- We action reports within 24 hours.

Account deletion: Account/Settings → "Delete account" (two-step confirmation).

Location is used in the foreground only (to verify presence at a business via
NFC tiles, match nearby drivers, and show local weather/tides). No background
location.
```

---

## 3. Apple — App Privacy questionnaire  (App Store Connect → App Privacy)

**Do you or your partners collect data? → Yes.** **Tracking (ATT)? → NO** (no
IDFA/ad SDKs). For every type below: *Linked to the user = Yes*, *Used for
tracking = No*.

| Data type | Collected | Purpose |
|---|---|---|
| Contact Info — **Name, Email address** | Yes | App Functionality |
| **Phone Number** (optional, profile) | Yes | App Functionality |
| Location — **Precise Location** | Yes | App Functionality (foreground only) |
| User Content — **Photos or Videos** | Yes | App Functionality |
| User Content — **Audio Data** (voice notes) | Yes | App Functionality |
| User Content — **Customer Support / Other** (posts, comments, listings) | Yes | App Functionality |
| Identifiers — **User ID** | Yes | App Functionality |
| Identifiers — **Device ID** (push token) | Yes | App Functionality (notifications) |
| Purchases — **Purchase History** | Yes | App Functionality |
| Usage Data — **Product Interaction** | Yes | Analytics (first-party) |

- **Payment card data**: handled directly by **Stripe**; you do not collect/store card numbers — do **not** declare "Payment Info" as collected by you (Stripe is the processor).
- No "Sensitive Info", no "Browsing History", no "Health", no "Contacts".

---

## 4. Google Play — Data Safety form

- **Does your app collect or share user data? → Yes.**
- **Is all data encrypted in transit? → Yes.**
- **Can users request data deletion? → Yes** — and provide the deletion URL: **https://oneshetland.com/delete-account** (plus in-app: Account → Delete account).

Declare these **Data types collected** (purpose: *App functionality*; for analytics rows add *Analytics*). Mark **collected**, **not shared** with third parties for ads, processed by Stripe for payments:

| Category | Type |
|---|---|
| Location | Approximate location; **Precise location** |
| Personal info | Name; Email address; Phone number; User IDs |
| Financial info | **Purchase history** (payments processed by Stripe; you don't store card data) |
| Photos and videos | Photos; Videos |
| Audio | Voice or sound recordings |
| Messages | Other in-app content (posts/comments/listings) |
| App activity | App interactions (first-party analytics) |
| Device or other IDs | Device ID (push token) |

---

## 5. Store-listing fields

| Field | Value |
|---|---|
| Privacy Policy URL | **https://oneshetland.com/privacy** |
| Account deletion URL (Google) | **https://oneshetland.com/delete-account** |
| Support URL / email | https://oneshetland.com  ·  support@oneshetland.com |
| Primary category | Lifestyle (alt: Social Networking) |
| Content rating | see §6 |

---

## 6. Age rating

- The app self-declares **18+** at sign-up and hosts user-generated content + payments/marketplace features.
- **Apple**: answer the rating questionnaire honestly — UGC with moderation, no restricted-goods *sale* (alcohol/tobacco are explicitly prohibited in Fetch, not sold), no gambling. Expect **17+**.
- **Google**: complete the IARC questionnaire — social/UGC + user interaction + shares location + digital purchases (on web). Expect a teen/mature rating.
- **Do not** select a Kids / Everyone-with-no-interaction category.

---

## 7. Final build checklist (EAS)

- [ ] Build with the **production** EAS profile (`eas build --profile production --platform all`).
- [ ] After build, in the generated iOS project confirm **`aps-environment` = `production`** (EAS sets this with the push capability — verify).
- [ ] In the built **Android AAB merged manifest**, confirm there's **no `SYSTEM_ALERT_WINDOW`** (stale dev-tooling permission; CNG should drop it — verify).
- [ ] Screenshots for required device sizes (iPhone 6.7"/6.5"/5.5"; iPad if you keep `supportsTablet`; Android phone/tablet).
- [ ] App icon + feature graphic (Google), promo text, description.
- [ ] `eas submit` (or upload via Transporter / Play Console).

---

## 8. Engineering status (all DONE — for reference)

- ✅ **IAP**: 6 digital seller purchases removed from the app (web-only); read-only/locked status, link-free; consumer/physical Stripe flows intact.
- ✅ **Account deletion**: in-app flow + `delete-account` edge function (scrub + soft-delete) + public `/delete-account` web page.
- ✅ **UGC safety**: Report + Block across all public surfaces, blocked-author feed filtering, Blocked Users screen, zero-tolerance Terms, admin reports queue.
- ✅ **Config**: SDK 55, target API 35 / iOS 16.6, real bundle id, icons, privacy manifest, encryption flag, JS-engine split, no over-broad permissions, no background location.
- ✅ App typecheck clean.

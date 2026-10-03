# OneShetland — Support & Operator Runbook

Launch-sized, not a helpdesk. It answers one question: **a real person has written to
us or reported something — what do we do next, and where?**

Last verified: 3 Oct 2026.

## 1. How people reach us

| Where | What they see |
|---|---|
| Web footer (every page, signed in or out) | **Support** → https://oneshetland.com/support |
| Web `/support` | Contact, payments & refunds, account & login, businesses & organisations, legal links |
| Web error page | "let us know at hello@oneshetland.com" |
| Mobile → Me tab → Account | **Help & support** (opens /support) next to Privacy and Terms |
| Mobile → Account screen → "Help & legal" | **Help & support** |
| Mobile sign-in screen footer | **Help** (opens /support) — reachable by someone locked out |
| Every legal page (terms, privacy, delete-account, community guidelines, selling policy) | `hello@oneshetland.com` |

**Inbox:** `hello@oneshetland.com` is the single published support address. It is a real
mailbox on the domain's mail host (livemail.co.uk; MX `_dc-mx.082c10a7059f.oneshetland.com`).
`support@oneshetland.com` also exists and is what the App Store listing pack quotes
(SUBMISSION_PACK.md) — **check it reaches the same person as `hello@`**.
The App Store review contact `appreview@oneshetland.com` also exists.

**Owner:** Darren Fullerton (Darren Fullerton Consultancy Ltd t/a OneShetland). There is
no second operator yet. Daily routine: read `hello@` and `support@`, open
`/admin/reports`, glance at `/admin/payments`.

**Response promises already published (do not exceed them silently):**
- Objectionable content / abusive users: acted on **within 24 hours** of the report (Terms, §UGC).
- Account deletion requests by email: confirmed and completed **within 30 days**, usually sooner.
- Data-rights requests (UK GDPR): to `hello@`; complaints can go to the ICO.

## 2. What to do, by request type

Always: reply from the support address, ask for the **account email** if not given, and
**verify the requester writes from the address on the account** before changing or
deleting anything.

### Customer: account / sign-in
1. Point to *Forgot password* (`/forgot-password`) first.
2. Locked out of the email on the account, or wants it changed: verify identity (reply from the
   account address; otherwise ask for something only the owner would know, e.g. last order).
3. Look the user up in Supabase → Authentication → Users. Change email there only after verifying.

### Customer: payment, ticket, booking, pass, membership, refund
1. Get date, amount, what they bought.
2. Admin → **Payments** (`/admin/payments`): find the charge/order. The **Refund reconciliation**
   panel flags any refund where the customer refund, merchant transfer reversal or platform-fee
   refund did not all happen.
3. Refund due: use the product's own refund path (web admin / organiser refund, Wallet refund).
   Never refund straight from the Stripe Dashboard unless you intend to — the scheduled
   `refund-reconcile-sweep` will flag it if the webhook is missed.
4. A flagged reconciliation row: `refund-reconcile` (admin-only) has `list`, `scan` (read-only)
   and `repair` (moves money; card charges only; needs explicit `confirm: true`; a full refund only).
   Wallet-funded refunds are never repaired there — run the refund again.

### Failed Wallet settlement / Wallet balance looks wrong
1. Do not edit balances by hand.
2. Admin → Payments: check the order/ledger row and the reconciliation panel.
3. A paid-by-Wallet order that failed part-way is re-run through its own refund path.
4. Anything involving the Wallet reserve/funding: stop, and handle it as an incident (§3).

### Business / merchant / organiser
1. Listing ownership: Admin → **Business claims** (`/admin/claims`).
2. Payout / Stripe Connect onboarding: Stripe Dashboard → Connect → the account; Admin → Payments.
3. Hub/organiser/ticket orders: their own order screens + the refund path above.
4. Sellers follow the Selling policy; restricted goods follow `/restricted-goods`.

### Reporting a problem with content, a user, a listing (UGC)
1. In-app **Report** (and block) creates a row in `content_reports`.
2. Admin → **Reports** (`/admin/reports`, with an open-count badge in the sidebar). Mark
   **Reviewing**, then **Actioned** or **Dismissed**. That records the decision and who made it.
3. **The queue does not take content down.** Remove/hide the content or suspend the user
   separately (Supabase table editor / the content's owner screens), *then* mark Actioned.
4. Target: within 24 hours (published promise).
5. Illegal content (e.g. child safety, credible threats): remove immediately, keep the report row
   and details, and report to the police / relevant authority; do not delete evidence.
6. Gap (see §4): nothing emails or pushes the operator when a report arrives — the daily
   routine must include `/admin/reports`.

### Privacy / data requests (access, correction, deletion, portability, objection)
1. Arrives at `hello@`. Verify identity (§2 preface). Log the date received.
2. Deletion: the user can do it in the app (Account → Delete account → two-step confirm → the
   `delete-account` edge function). If they cannot sign in, they email from the account address
   (subject on `/delete-account`); delete via the same function path, not by hand-editing tables.
   Complete within **30 days**.
3. Access/portability: export the person's rows (profile, orders, tickets, wallet, messages)
   from Supabase and send securely to the verified address. One calendar month is the UK GDPR limit.
4. Consent/verification history: Admin → **Compliance log** (`/admin/compliance`).

### Urgent operational issue / outage / degraded service
1. Check what is actually broken: https://oneshetland.com loads? app signs in? checkout?
2. Platform dashboards: Netlify (web), Supabase (database, edge function logs), Stripe, Expo/EAS (app updates).
3. Web bad deploy: Netlify → Deploys → publish the previous deploy (rollback).
4. Bad app JS update: publish a corrected update to the same channel (or roll the update back in EAS).
5. Database trouble or loss: `DISASTER-RECOVERY-RUNBOOK.md` (restore rehearsed 28 Sep 2026).
6. Money-moving functions misbehaving: pause the feature flag in Admin → **Configuration**
   (`/admin/config`) if one exists for it, then investigate. Do not run `repair` actions under pressure.
7. Tell users what is happening on the Support page or via an alert (Admin → Alerts) if it lasts.

### Secret exposed / suspected compromise
Rotate the credential, check the provider's active-key list, record it in
`oneshetland-web/lib/launch-readiness-data.ts` (see `compliance-secret-rotation`).

## 3. Escalation
There is one operator today. For anything touching money, identity or legal exposure that
you are unsure about: stop, do not improvise a database edit, write down what you saw, and
take it to whoever you trust with finance/legal (accountant, solicitor, Stripe support).
Stripe support: dashboard.stripe.com → Help. Supabase: dashboard → Support.

## 4. Known gaps (as of 3 Oct 2026)
1. **No alert on a new content report.** Operator must look at `/admin/reports`.
2. **Report queue does not remove content** — takedown is a separate manual step.
3. **Single operator, single inbox** — no out-of-hours cover; the 24-hour promise depends on one person.
4. No error monitoring service (tracked as `operations-error-monitoring`).
5. App Store listing quotes `support@` and the bare site URL; the site and app use `hello@` and `/support`.
   Both mailboxes exist; confirm they reach the same person. Pointing the App Store *Support URL*
   at `https://oneshetland.com/support` is an App Store Connect metadata edit, deliberately not
   done here.

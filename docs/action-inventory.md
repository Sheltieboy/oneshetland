# OneShetland action inventory

Every place the system *does* something — takes money, writes data, or sends a
message — with an order to work through them in.

Built mechanically on 18 Aug 2026 (`supabase functions list`, migration scan,
client write scan), not from memory. The counts are exact. The per-function
auth column is a **grep heuristic**: only the three flagged as open were read
line by line. Treat a "has check" as unverified until it's been read.

## The surface

| Surface | Count | What guards it |
|---|---|---|
| Edge functions | 83 | JWT at the platform edge + in-code caller check |
| — of which move money | 34 | Stripe keys held server-side |
| SECURITY DEFINER RPCs | 78 | Their own internal checks — they bypass RLS by design |
| Tables | 124 | RLS policies (all 124 now have RLS) |
| Direct client writes | ~150 call sites | RLS only — there is no server code in the path |

## Findings — 18 Aug 2026

All fixed, deployed and verified against the downloaded live bundle unless
marked otherwise.

### Security

**Privilege escalation to admin — anyone signed in.** `is_admin()` reads
`role = 'admin' OR is_platform_owner = true`. The trigger that exists to stop
self-service escalation locked `role` and not the second column, and the profile
update policy is row-level with no column restriction, so
`update profiles set is_platform_owner = true where id = auth.uid()` stuck. That
unlocked RLS on 8 tables — `"Admins can read all profiles"` among them — and 11
RPCs including platform-wide revenue. Refunds were out of reach only because
`refund-payment` happens to check `profiles.role` directly. Fixed: the trigger
now locks `is_platform_owner` and the three `stripe_*` status flags, and the
migration clears the flag from anyone holding it without `role = 'admin'`.

**`send-email` — any signed-in user could mail anyone.** Took template key,
recipient and variables from the body with no check. Templates carry links, so
this was a phishing primitive as well as a way to burn the sending domain. Its
only HTTP caller is the admin "send test" button; the five functions that
actually send import the shared module directly. Now admins only.

**`notify-trade-lead` — unauthenticated fan-out.** `verify_jwt` off and no
caller check. Matches stay `sent` until answered, so every call re-notified the
same tradespeople. Now requires a session, requires the caller to be the brief's
author, and is deployed with JWT verification on.

**`request-password-reset` — unthrottled.** Correctly unauthenticated, but
nothing limited the rate, so anyone could drive reset mail at any address as
fast as they could post. Three per address per hour, counted from `email_log`.
Over the limit still returns ok — this endpoint must not reveal anything about
an address.

**`notify-business-alert`, `notify-new-offer` — unverified fan-out to a
business's whole customer base.** Content legitimate, repetition the abuse. Both
now require the caller to own the business.

### Money

**A top-up could take the money and never credit the wallet.** Both paths
claimed the payment by inserting the ledger row, then credited the balance in a
separate statement — two transactions. If the second failed, the claim was
committed, the PI was claimed forever, and every retry hit the unique violation
and reported success. Fixed with a `wallet_topup` function doing both in one
transaction.

**A double-tap at the till debited twice.** `executeWalletPayment` debits before
it transfers, and `local-wallet-pay` had no row to claim and sent a random
idempotency key. A Stripe key alone would not have helped — the debit is first,
so a deduplicated transfer leaves the customer down twice. Fixed with
`wallet_payment_claims`, keyed on a client-generated id per attempt so a genuine
second payment still goes through.

**Two paths could both claim a ticket order.** The webhook and
`confirm-event-tickets` race by design; both check-then-acted, so both could run
the side effects and `increment_event_tickets_sold` counted twice. Fixed with a
compare-and-swap. Overselling was never at risk — `reserve_ticket_slots` takes a
`FOR UPDATE` lock and is correct.

### Verified correct — no change needed

- **Capacity/overselling**: `reserve_ticket_slots`, row-locked and atomic.
- **`refund-payment`**: admin gate, amount validated against the original,
  idempotency key, `reverse_transfer` for Connect. The best-built function read.
- **`wallet-charge-approve`**: ownership, expiry, a real CAS claim before the
  debit, idempotency key, failure states. No notes.
- **`local-wallet-confirm-topup`** rejects any PaymentIntent whose
  `metadata.type` isn't a top-up — without it a donation or ticket PI could be
  replayed to mint free wallet credit.
- **Hub donation / membership / unit purchase / gift** fulfilment: all idempotent
  via unique indexes on the payment intent plus `on conflict do nothing`.
- **No payment amount is taken from the client** where it shouldn't be. The
  functions reading `amount_pence` from the body are genuinely user-chosen.
- **`connect-redirect`**: flagged by the scan, read, dismissed — 39 lines, no
  database access.

### Open — deliberately not changed unattended

**Nine `notify-*` functions fan out on an entity id with no caller check**:
`notify-booking`, `notify-business-claim`, `notify-claim`, `notify-engagement`,
`notify-event-update`, `notify-hub`, `notify-hub-content`, `notify-job`,
`notify-shift-status`. All require a signed-in user (`verify_jwt = true`), so the
exposure is notification spam by a member rather than by the open internet. Each
carries a different ownership model — event organiser, hub committee, employer,
claimant — and guessing at nine of those in one pass is how a working
notification quietly stops arriving. `notify-event-update` is the one to do
first: it reaches ticket holders by email.

Also open: `transcribe-audio` and `oneshetland-feed` have no caller check
(signed-in only). `transcribe-audio` costs money per call, so it wants a rate
limit on the same pattern as the password reset.

## Order to work through

Today's three tests produced ~20 defects. Not one was in the logic — every one
was in a **seam**: two code paths that had to agree and didn't. That is what
this order is built around.

### 1. Money, and the paths that mark it paid — 34 functions
Highest cost of being wrong, and the seam count is highest here too. The ticket
receipt failed because **four** separate paths mark an order paid and only one
sent the email.

For each: who can call it · where the amount comes from (and whether it can
disagree with what the site quotes) · every path that completes the payment ·
whether calling it twice charges twice · what the customer is told.

Start: `create-event-ticket-intent`, `confirm-event-tickets`,
`local-wallet-pay`, `wallet-charge-approve`, `create-product-order-intent`,
`refund-payment`.

### 2. The two open functions above
Small, self-contained, known.

### 3. Notification fan-out — 12 `notify-*` with no caller check
Cheap to review, and the blast radius is real users' lock screens.

### 4. SECURITY DEFINER RPCs — 78
They bypass RLS by definition, so each one *is* its own security boundary. The
`bookings_due_metering` bug was exactly this: it called an ownership-checked
function and only worked by accident of SQL NULL semantics.

Highest value first: anything named `approve_*`, `claim_*`, `activate_*`,
`commit_*`, `apply_*` — the ones that grant something or move stock.

### 5. Direct client writes — ~150 sites
RLS is the *only* thing between the browser and these tables. Busiest:
`event_ticket_types` (10), `shift_applications` (8), `products` (8),
`hub_members` (8), `shifts` (7), `delivery_requests` (7).

## The five questions that caught everything today

Ask these of each action rather than reading it for correctness:

1. **Who can call this?** — `meter-bookings` billed businesses and had no auth
   check at all.
2. **Is this logic written down twice?** — tier rules lived in six places and
   disagreed. Fee, price and tier constants must resolve to one definition.
3. **How many paths reach this end state?** — four paths marked a ticket paid;
   the receipt sat on one.
4. **What happens on the second call?** — retries, double taps, Stripe
   redelivering a webhook.
5. **If it fails, who finds out?** — a discarded error meant cancelling an event
   told nobody. A swallowed error is a defect even when the code is right.

## Method

Manual clicking found these, but slowly, and it cost a whole evening. Cheaper in
this order:

- **Mechanical scans** — `scripts/audit-tiers.mjs` found the homepage badging
  Pro as "★ Featured" with no human involved. Extend the same idea per area.
- **SQL assertions against the real schema** — `supabase/scripts/verify-metering.sql`
  runs 9 checks in a transaction and rolls back. Safe against production.
- **Pure-logic scenarios** — 57 of them for tiers, no database needed.
- **Manual scripts** — `docs/tier-manual-tests.md`. Last resort, for what only a
  real Stripe round-trip can prove.

One rule earned the hard way: **verify what is deployed, not what is in the
file.** Three fixes in a row looked broken because the running bundle wasn't the
source. `supabase functions download <slug> --project-ref <ref>` into a temp
directory and diff it.

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

## What the scan already found

**1. `notify-trade-lead` — unauthenticated, fans out notifications.**
`verify_jwt = false`, no caller check in the code, and it runs on the service
role. Anyone who can reach the URL with a `brief_id` can push notifications to
every matched tradesperson. Not a data leak — a spam lever aimed at real users'
phones.

**2. `request-password-reset` — unauthenticated with no rate limit.**
Open by necessity (you can't be signed in to reset a password), but nothing
throttles it. Anyone can drive password-reset mail at any address as fast as
they can post, which bombs the recipient and burns sending reputation on the
domain the rest of the product's email depends on.

**3. `connect-redirect` — not a problem.** Flagged by the scan, read, dismissed:
39 lines, no database access, just the HTTPS landing page Stripe requires before
deep-linking back into the app.

Also worth a decision, not a fix: **77 functions have `verify_jwt = true` but no
in-code check**, so any *signed-in* user can call them. For the 12 `notify-*`
functions that means a user can likely trigger notifications about content that
isn't theirs. Bounded, but worth a pass.

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

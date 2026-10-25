# Fetch v2 — Implementation Plan

**Status:** definitive build plan. No product code has changed.
**Written:** 25 Oct 2026, on branch `fetch-v2` (worktree `~/Claude/oneshetland-fetch-v2`), based on origin/main `312f7fc`.
**Scope:** the next OneShetland app release, plus the web and shared backend. iOS Build 148, which is with Apple App Review, is not touched by anything in this plan.

How to read this document. Sections A–B record what exists and where that knowledge came from. Sections C–R are the plan. Every claim about current behaviour carries a source reference. **V** means read in source. **P** means confirmed live in `supabase/production/*` snapshots (8 Oct). **I** means inferred from policy or code reading but not executed. No production query was run for this document.

---

## A. Existing product and spec sources recovered

No dedicated Fetch spec file exists in any repo. The agreed thinking lives in session transcripts, commits and scattered docs.

| # | Source | Date | What it is | Still binding? |
|---|---|---|---|---|
| 1 | Platform commission spec (transcript 58ae4876) | 31 May | Flat £1.50 Fetch platform fee, originally *inclusive* (taken from the driver's fare) | **Superseded by #4** |
| 2 | "Fetch as a section" (transcript 16adb084; commit 1a2c3da) | 23 Jun | Darren: Fetch "acts like its still its own app… fix it so its just a section". Driver became a capability, not a role. `become-driver` moved server-side | Yes |
| 3 | Darren's product statements (transcript extracts) | 9 Jun–14 Jul | "Fetch is not about sending packages… you either request a pick up by a driver or you are a driver and you set a route" (9 Jun). "a deliveroo/uber-eats thing but for a disparate set of islands… not only for food… also not for people" (14 Jul). "this will be a slow burn" (27 Jun) | Yes |
| 4 | Fee decision (Darren, 14 Jul) | 14 Jul | "I need the service fee, the delivery fee is 100% to the driver". The £1.50 is charged **on top**. The driver agreement (web `app/driver-agreement`) says the same | **Yes. Current rule** |
| 5 | "Reworking Fetch" proposal (artifact claude.ai/code/artifact/643a6d91-…; commits 42ec021, c0e8a31, f6b24fb, 5c4f031, 1f3eaba) | 14 Jul | Run-first rework. Introduced `needed_by`/scheduling, expiry plus "+24h" extend, catch-a-run, route-targeted pushes, and driver run cancel | Built; partly superseded by #8 |
| 6 | Restricted goods policy (web `/restricted-goods`) and driver agreement | 14 Jul | Banned items list; goods only, no passengers; pharmacy and takeaway liability tick; self-employed drivers declare licence, vehicle and hire-and-reward insurance | Yes |
| 7 | Paygate 12: authorisation, capture, price authority (commits 6d6b7a7, 20f7902, d978703, 98daa01, e1cd939, fc1acc7, 5210d31, da69f90, b3174b6) | 28 Aug | Server-side price via `fetch-quote`; a hold counts only when it is `requires_capture`; one hold per delivery; capture recovery; frozen terms; hold expiry and re-authorisation | Yes. **Keep untouched** |
| 8 | Fetch reality check (transcript 3a1667ca) | 29 Aug | "FETCH EXISTS BUT IS NOT CURRENTLY LAUNCH-READY". All 26 requests, 12 runs and 5 drivers are dev fixtures; mobile cannot price | Yes. Still true |
| 9 | Darren's pause decision (3a1667ca) | 29–30 Aug | "Paygate 12 is PAUSED by product decision". Fetch "paused/hidden as appropriate until separately approved". Shop `fetch_enabled=false` | Pause yes; **"hidden" was never done** |
| 10 | **Fetch 2.0 Architecture Blueprint** (3a1667ca, 30 Aug 11:59) | 30 Aug | Most complete spec. Darren's brief: request-first customer, carriers making journeys anyway, "No passenger lifts… not a taxi/ridesharing system", "Do not invent a rating economy unless necessary". Assistant answer: plans, legs, handovers and journeys, deterministic matching, ferry legs, Phases 0–7, and seven open decisions | Direction yes. Phasing revised here (see C) |
| 11 | Security fixes touching Fetch | 19 Aug, 7–8 Oct | Driver self-approval closed (20260819180000). Fetch hold self-payment guard (a670f1a). `notify-drivers`/`notify-collected` caller authorisation (beb333d) | Yes. Live |
| 12 | Under-16 gate (transcript 0e31ffcf) | 13 Aug | Fetch (both sides) gated off for minors | Yes |
| 13 | Docs: web `TEST_PLAN.md` Phase 4, `LAUNCH_CHECKLIST.md`, `MARKETING_PLAN.md`; app `PAYMENTS-TEST-PLAN.md` J1/J2, `LISTING_COPY.md`, `SECURITY_AUDIT.md` | Jun–Jul | Acceptance scripts and launch notes | **Partly stale** (see A.1) |

### A.1 Discrepancies found between sources

1. **Who pays the £1.50.** Sources #1 and #13 (`LAUNCH_CHECKLIST.md:38`, test plans) say it is "cut from delivery fee". Darren's 14 Jul decision, the driver agreement and the code (`authorise-payment`: `application_fee_amount` = service fee on top of the base fee) say it is paid by the customer on top. **v2 follows 14 Jul.** The stale docs should be corrected when v2 copy is written.
2. **Per-mile rate.** Web copy says "95p/mile" (`RequestComposer.tsx:440`). Mobile `step-4.tsx:39` hardcodes 95p. `web/lib/fetch-data.ts` uses 65p. The authoritative value is the `delivery_pricing_config.price_per_mile_pence` row in production, which this document did not read. **Action in Step 1:** read the row, then remove every client-side copy of the rate.
3. **Store copy.** `LISTING_COPY.md` says "send and receive parcels, shopping and takeaways". Darren said on 9 Jun that Fetch "is not about sending packages". v2 copy should follow Darren.
4. **Is Fetch live?** The funding audit (10 Aug) says "LIVE / Complete". The 29 Aug check and this baseline say it is not launch-ready.
5. **Paused vs visible.** Darren decided "paused/hidden", but Fetch is still linked publicly on web (header More menu, footer, home grid) and is in the app nav in every build, including 148.
6. **Catch a run.** It was built for customers on 14 Jul. The 30 Aug blueprint recommends moving it to the server. Darren's 14 Jul remark that "a lot of people… just request in the hope a driver will pick it up" supports the blueprint. v2 resolves this in I.

### A.2 The five "previously agreed principles" in the brief, checked

| Principle | Finding |
|---|---|
| Driver routes/runs may be publicly visible | **Supported in practice, not a recorded decision.** Baseline RLS "Open runs are publicly readable" (BL:8717). Darren on 27 Jun: "show the fetch 'runs' that are on at that moment". Note: today anon can also read `driver_id` and free-text `notes`. v2 narrows this (see J) |
| Must be a member to book/request | **Holds in code** (sign-in plus card on file). No explicit Darren quote found. Treated as a rule |
| Driver profiles minimal initially | **No Darren quote found.** It matches the blueprint and the current data (vehicle type, registration, statement). Treated as a rule |
| Business accounts not required for the first version | **No source says this.** Darren's 30 Aug brief lists business collections as in scope, and a Shop→Fetch bridge exists but is switched off. v2 P0 does not need business accounts; the Shop bridge moves to P2. **Darren to confirm** (R) |
| "Community-powered collections and deliveries across Shetland" | **That exact phrase was not found.** The nearest are "Fetch — community collections and deliveries" (funding audit) and "Community delivery — get things brought to your door, the island way" (web `lib/sections.ts`). Consistent with Darren's statements. Adopted as the proposition |

---

## B. Current implementation baseline

### B.1 Where the code is

| Layer | Location | Notes |
|---|---|---|
| Backend (tables, RLS, RPCs, 15+ edge functions) | `oneshetland-delivers/supabase/`, canonical on origin/main | Equals production as of the 8 Oct reconciliation |
| Web | `oneshetland-web`: `app/fetch/{page,about,new,apply,previous,connect-bank,[id],runs/new}`, `components/fetch/*` (15), `lib/fetch-data*.ts`, `app/admin/{drivers,operations}`, `components/admin/{DriverApprovals,DisputesManager}` | Publicly linked |
| Mobile (iOS and Android, one Expo codebase) | Build 148 source `~/Claude/oneshetland-build148` (`7317508`): `app/(tabs)/fetch.tsx`, `app/(customer)/request/step-1..4`, `app/(customer)/{dashboard,request-detail,previous-requests,saved-addresses,apply-driver}`, `app/(driver)/{dashboard,create-run,request-detail,connect-bank}`, `app/(admin)/{driver-approvals,delivery-requests,runs,disputes,regions,payments}`, `context/RequestContext.tsx` | In the nav for all users. Fetch screens are byte-identical between build-148 and origin/main, apart from the Places proxy |

> **Branch note.** origin/main's mobile tree (`app/`, `components/`, `lib/`) is about 110 files behind Build 148 overall, so mobile v2 UI work must not start from `fetch-v2`. See M.4.

### B.2 Data model today

| Table | Purpose | State |
|---|---|---|
| `delivery_requests` | The request: pickup name/location/notes, `destination_region_id/area/address`, `delivery_notes`, `contact_phone`, `category_slug`, `needed_by`, `scheduling_mode` (asap\|by\|flexible), `expires_at`, `status` (pending, matched, collected, delivered, cancelled, expired), `payment_status` (10 values), fees, `run_id`, `ready_for_collection`, `already_paid` | **No pickup region and no coordinates are stored.** No item description or size |
| `runs` | Driver journey: origin/destination region, departure window, `categories_accepted[]`, `ferry_crossing`, `capacity`, `notes`, status (open\|full\|completed\|cancelled) | Capacity is never enforced; 'full' is never set; mobile duplicates origin/destination into `notes` text and parses it back |
| `driver_profiles` | `driver_status` (not_applied\|pending\|approved\|rejected\|suspended), vehicle, Stripe Connect flags, `dispute_count`, `flagged_for_review` | Status and Stripe columns locked by `tg_zz_lock_driver_columns` |
| `waiting_events` | Arrival and collection timestamps that price the waiting fee | Anyone can insert against any `request_id` (BL:8632) |
| `fetch_authorisation_attempts`, `fetch_authorisation_generations` | Hold with frozen terms, capture state, generations | **0 rows**: has never run in production |
| `delivery_pricing_config`, `delivery_categories`, `regions` (17), `delivery_fees` | Pricing config and reference data | `delivery_fees` unused |
| `product_orders.delivery_request_id` + sync triggers | Shop→Fetch bridge | Off (`business_shipping.fetch_enabled=false`); uses a second price engine (`calculate-fee`) |

Production data (29 Aug count; not re-queried): 26 requests, 12 runs and 5 driver profiles, **all development fixtures**. There are no real users of Fetch.

### B.3 Area classification

| Area | Class | Evidence |
|---|---|---|
| Tables / relationships | **PARTIAL** | Core shape is sound; missing pickup region, coordinates, size, item description |
| User roles (member, driver capability, admin) | **WORKING** | Driver-as-capability; admin via `is_admin()`; minors excluded |
| Request creation — web | **PARTIAL** | Full form; quote via `fetch-quote` after insert; client deletes the row if quoting fails |
| Request creation — mobile | **NEEDS REPLACEMENT** | Prices on the client, never calls `fetch-quote`; the server nulls the client price, so the request is unpriced and accept returns `NOT_PRICED` (V `step-4.tsx:39-93,225-245`; trigger `20260905120000:183-211`, registered in production) |
| Driver availability / runs | **PARTIAL** | Real `runs` table; direct client inserts; no capacity; mobile stores regions in `notes` |
| Claiming / accepting | **NEEDS REPLACEMENT** | Direct client `UPDATE status='matched'` guarded only by `.eq('status','pending')`; the hold is a separate non-fatal call; RLS lets a driver set any `run_id`; accept auto-creates a 3-hour run on the client |
| Status lifecycle | **NEEDS REPLACEMENT** | No server-owned path for accept and cancel; direct PATCH to collected/delivered is allowed by RLS once the payment status is authorised (skipping freshness and capture); drivers can cancel without releasing the hold |
| Customer actions (cancel pending, extend, confirm ready) | **NEEDS REPLACEMENT** | No customer UPDATE policy exists, so these are **probably silent no-ops** on web and mobile (I, BL policies) |
| Communications | **NOT IMPLEMENTED** | Phone number only; the about page tells drivers to "message the customer" but nothing supports it |
| Payments (hold, capture, expiry, refund) | **WORKING** (backend rail) / **NEEDS REPLACEMENT** (mobile client) | Paygate 12 is solid and tested, but has never run live; refund is admin-only; `authorise-payment` charges to the platform if the driver has no Connect account |
| Location handling | **PARTIAL** | Google Places through a proxy; coordinates thrown away after pricing; `fetch-quote` falls back to the **minimum price** if geocoding fails |
| Routing / matching | **PARTIAL** | Destination region + category + needed_by only; origin region not stored; ferry and capacity unused; fallback pings every approved driver |
| Ratings / trust | **NOT IMPLEMENTED** | None. Consistent with direction |
| Cancellation | **PARTIAL** | `cancel-payment` releases the hold for matched requests; pending cancel is a no-op (I); no driver un-accept path; a driver can set cancelled through RLS without voiding the hold |
| Dispute / safety | **PLACEHOLDER** | `dispute_count`, `flagged_for_review`, `dispute_raised` have no writer; web "waive fee" writes `waiting_events` directly |
| Proof of collection/delivery | **NOT IMPLEMENTED** | — |
| Address privacy | **NEEDS REPLACEMENT** | Every approved driver can read `destination_address`, `contact_phone` and notes for every pending request (BL:8353/8362), and both clients render the address on the board |
| Notifications | **WORKING** (push + inbox) | 10 `fetch.*` categories, `fetch_enabled` preference, quiet hours; tap goes to the Fetch tab, not the request; no email; Android push likely non-functional (no FCM config, I) |
| Web implementation | **PARTIAL** | Most complete client; needs server-owned actions and redaction |
| iPhone implementation | **NEEDS REPLACEMENT** (money/status paths) on a substantial UI | Reusable screens; logic must move server-side |
| Android implementation | **PARTIAL** | Same code; `maps://` directions broken on Android; push likely broken |
| Admin tooling | **PARTIAL / NEEDS REPLACEMENT** | Approvals are direct client updates with no reason or notification; `become-driver` lets rejected or suspended drivers reset themselves to pending; operations page read-only, wrong filter values; no admin cancel or release |
| Feature flag | **NOT IMPLEMENTED** for Fetch | `admin_config` is global and admin-only to read; `launch_testers` gives a per-user allowlist but gates nothing |
| Tests | **PARTIAL** | 7 backend suites, **all production-touching** (4 use `service_key.txt`, 3 run rolled-back SQL with `--linked`); no isolated-PG Fetch tests; no RLS, lifecycle, matching or UI tests |

### B.4 Facts that change the plan

1. **Fetch is visible but non-functional on mobile in every installed build, including Build 148, which is in review.** The price-authority and authorisation migrations (5–10 Sep) are registered in production (`supabase/production/registered-migrations.json`). Mobile never calls `fetch-quote`, so a mobile request can never be held or collected. The UI shows "card pre-authorised" anyway. This plan does not change Build 148. **Darren should know a reviewer could open Fetch** (see R).
2. **There is no real Fetch data.** v2 can change `delivery_requests` semantics freely (additive migrations, fixtures retired by status) without a user migration.
3. **The payment rail is the most mature part.** v2 keeps it and builds the lifecycle around it, not the reverse.
4. **The current RLS is the main defect.** Most "NEEDS REPLACEMENT" items come from one cause: clients write lifecycle columns directly. Fixing that is Step 2 of the sequence, not a late hardening pass.

---

## C. Fetch v2 proposition

> **Fetch: community-powered collections and deliveries across Shetland.**
> Need something picked up? Ask, and a OneShetland neighbour already heading that way brings it. Going somewhere? Say so, and carry something for someone on the way.

Product rules carried forward (sources A.2–A.10):

- **Goods only.** No passengers, ever. Not a taxi or ride-share.
- **Request-first for the customer.** They describe what, where from, where to and by when, and are never asked to understand runs.
- **Journeys people are already making** are the supply. Drivers post runs or browse.
- **Platform sets the price.** The delivery fee goes 100% to the driver. The OneShetland service fee (currently £1.50, admin-configurable) is charged on top.
- **Members only.** Requesting and driving both require a signed-in, adult OneShetland account.
- **Minimal driver profile.** First name, vehicle type, registration (private to admin), area, Stripe payouts.
- **No rating economy at launch.** Admin approval, suspension and an issue record are the trust model.
- **Slow burn.** Built for low density: a handful of drivers, a few requests a week.

What v2 changes versus the 30 Aug blueprint. The blueprint's direction stands, but its **Phase 0 (plans, legs, handovers) is not P0**. Multi-leg, ferry handovers and multi-carrier payouts are a separate high-risk programme. P0 makes **single-leg Fetch genuinely work**. The P0 schema leaves room for legs (each request has at most one active assignment) without building them.

---

## D. P0 / P1 / P2 scope

### P0 — "Fetch works" (single leg, one driver, card payment, behind a flag)

| # | Capability |
|---|---|
| P0-1 | Requester creates a request through **one server call** that validates, geocodes, prices and inserts in one step. Fields: category, short item description, size class, collection place (address plus derived pickup region), delivery place (address plus region), timing (ASAP / by a date-time / flexible within N days), instructions, contact phone, liability tick where required. Price shown before submit comes from the server quote |
| P0-2 | Requester sees status, the price breakdown, the driver's first name and vehicle type once accepted, and a clear timeline |
| P0-3 | Drivers browse a **redacted board**: region and village, category, size, timing, price, and pickup and drop areas, but **no exact addresses, no phone, no notes**. Requests on or near their posted runs are sorted first |
| P0-4 | Drivers post runs (origin/destination region, window, categories, ferry flag) through a server call. The public sees a redacted "runs on today" view |
| P0-5 | **Atomic accept** through one server call: race-safe claim, card hold placed in the same call, and exact addresses and phone revealed to that driver only after the claim succeeds |
| P0-6 | Payment-needed handling: if the hold needs 3DS or a new card, the requester is told and finishes it. If it is not resolved within a window, the request returns to the board automatically |
| P0-7 | Driver actions through server calls only: arrived (optional), **collected**, **delivered** (capture), **cannot deliver** (with reason), plus release before collection |
| P0-8 | Proof: optional photo at delivery, **required** for a "left in a safe place" delivery. Timestamps on every transition |
| P0-9 | Minimal per-request message thread between requester and assigned driver (text only, party-only access, push and inbox notified). Phone stays private unless the requester chooses to share it |
| P0-10 | Cancellation: requester before collection (hold released). Driver before collection (back to the board, hold released, release counted). Nobody can cancel after collection; that route is "cannot deliver" |
| P0-11 | Expiry with reminder and "+24h" extend (exists; moved to server calls) |
| P0-12 | **Report a problem** on any active request, or within 72h of delivery or cancellation, creating an admin-visible issue |
| P0-13 | Admin: approve, reject and suspend drivers with a reason and notification; a request oversight list with full detail; admin cancel (with hold release) and admin "return to board"; refund (exists); issue queue |
| P0-14 | Notifications through the existing Notification Centre for every lifecycle event (L) |
| P0-15 | Feature flag `fetch_v2` (off / admins / testers / everyone), enforced **server-side** as well as in navigation |
| P0-16 | Web and mobile clients for all of the above, on the next app release |
| P0-17 | Isolated-PG tests and a real-device acceptance run (N, Q) |

### P1 — shortly after launch

- Region corridor table (Burra→Scalloway→Lerwick, Toft→Ulsta) used in matching, with capacity on runs and a "full" status.
- Recurring runs ("weekdays Brae→Lerwick 07:30").
- Suggested matches pushed to drivers whose run fits a new request, replacing the "ping every approved driver" fallback.
- Email notifications (activate the dormant `fetch.*` templates).
- Driver earnings history; driver document upload (licence and insurance) for admin review.
- Block a member; admin reassign to a named driver.
- Safe-place preferences saved per address; photo proof at collection.
- Android push (FCM credentials), with the Android `maps://` link fixed.
- Requester "confirm received" (optional; shortens the issue window).

### P2 — future

- Multi-leg plans, ferry legs, handovers and the per-leg payouts that need separate charges and transfers (blueprint Phases 0, 4–6).
- Grouped and bundled deliveries.
- Shop→Fetch bridge re-enabled on the v2 lifecycle (single price engine).
- Business senders and recurring business collections.
- Free or "favour" requests (see K).
- Shetland↔Aberdeen.
- Ratings, only if the issue data shows they are needed.

---

## E. User roles

| Role | How obtained | Can |
|---|---|---|
| **Visitor** (signed out) | — | Read Fetch about pages and the redacted public runs view. Cannot see any request |
| **Member** (adult, signed in) | Account; under-16 excluded (existing rule) | Create requests (needs a card on file), see and manage their own requests, message their assigned driver, report a problem, apply to drive |
| **Driver** (member capability) | `become-driver` → admin approval → Stripe Connect payouts enabled | Post runs; browse the redacted board; accept (only when approved **and** payouts enabled); see full detail of their own assigned requests; do driver actions |
| **Suspended driver** | Admin action | Nothing driver-side; their existing assignments are released by admin. Cannot re-apply by themselves (fixes the `become-driver` reset) |
| **Admin** | `profiles.role='admin'` / `is_admin()` | Everything, through audited admin RPCs |
| **Tester** | `launch_testers` row in programme `fetch-v2` | Sees Fetch v2 while the flag is at `testers` |

A member can be both requester and driver, but **never on the same request**. The self-payment guard already blocks this at the hold, and v2 also blocks it at accept.

---

## F. Request lifecycle (authoritative state machine)

### F.1 States

The existing status words are kept so that analytics, notifications, history views and the Paygate triggers keep their meaning. One state is added.

| Status | Meaning | Customer label |
|---|---|---|
| `pending` | Priced and open on the board (or attached to a run) awaiting a driver | "Looking for a driver" |
| `matched` | A driver has accepted. The hold is placed, or the requester is being asked to complete payment | "Driver found" / "Action needed: confirm payment" |
| `collected` | Driver has the item | "Collected — on its way" |
| `delivered` | Delivered; payment captured. **Closing state** | "Delivered" |
| `undeliverable` **(new)** | Collected, but delivery cannot be completed. Requires a reason and an admin resolution | "Delivery problem — we're on it" |
| `cancelled` | Closed before collection, or closed by admin resolution | "Cancelled" |
| `expired` | No driver before `expires_at` | "No driver found" |

States considered and rejected:

- `draft` stays client-side only, because a quote never creates a row.
- `quoted` disappears because create and price are now one call, so an unpriced row cannot exist.
- `in_transit` is the same as `collected` for a single leg.
- `completed` is the same as `delivered`; the 72h issue window runs on `delivered_at`.
- `disputed` is **not a status**. An issue record is attached to the request, so a dispute never freezes or rewinds the lifecycle, and money is resolved by admin refund.

Payment progress stays in `payment_status`, which is unchanged and server-managed by the existing triggers.

### F.2 Transitions

Every transition is a SECURITY DEFINER RPC or an edge function. **No client role has UPDATE on `delivery_requests`.**

| From → To | Actor | Through | Conditions | Side effects |
|---|---|---|---|---|
| (none) → `pending` | Member | `fetch-create` (edge: geocode, price, insert via `fetch_create_request`) | Flag on for caller; adult; card on file; category allowed; liability tick if required; addresses geocode or postcode given; price computed server-side; idempotency key | Notify matching drivers (L) |
| `pending` → `matched` | Approved driver with payouts | `fetch-accept` (edge) → `fetch_claim_request` (RPC) then the existing authorise path | Row lock; status still `pending`; not own request; driver approved, not suspended, payouts enabled; optional own open run; one active assignment | Hold placed (`claim_fetch_authorisation`, frozen terms); price locked; addresses revealed to the driver; requester notified |
| `matched` → `pending` | Driver (release), admin (return to board), system (payment not completed in time) | `fetch_release_request` | Not yet collected | Hold voided through `cancel-payment` logic; attempt settled terminal; `driver_release_count`++ for driver releases; requester and driver notified |
| `matched` → `collected` | Assigned driver | `fetch_mark_collected` (exists; kept) | Hold fulfillable (fresh within 2h, Stripe deadline not passed); status `matched` | Waiting fee measured on the server; requester notified |
| `collected` → `delivered` | Assigned driver | `capture-payment` (kept; tightened) | Status **must be `collected`** (new check); photo required if safe-place | Capture under frozen terms; requester notified; issue window opens |
| `collected` → `undeliverable` | Assigned driver | `fetch_mark_undeliverable` | Reason (recipient absent, address wrong, item refused, damaged, other); note | Issue auto-opened; admin and requester notified; **no capture yet** |
| `undeliverable` → `delivered` | Assigned driver (retry succeeded) | `capture-payment` | As above | As above |
| `undeliverable` → `cancelled` | Admin only | `fetch_admin_resolve` | Resolution: returned to sender / retained / disposed, plus a capture amount (0…hold) | Partial or zero capture, or void; both parties notified |
| `pending` / `matched` → `cancelled` | Requester | `fetch-cancel` (edge) | Not collected | Hold voided (also covers `requires_action` PaymentIntents, fixing today's gap); driver notified |
| any non-terminal → `cancelled` | Admin | `fetch_admin_cancel` | Reason required | Void or partial capture per resolution; parties notified |
| `pending` → `expired` | System (`reminder-runner`) | existing | `expires_at` passed | Requester notified |
| `pending` → `pending` (extend) | Requester | `fetch_extend_request` | Pending; at most N extends | `expires_at` + 24h |

**Prohibited:**

- Any transition out of `delivered`, `cancelled` or `expired`.
- `pending` → `collected`/`delivered`.
- Driver cancel after collection.
- Requester cancel after collection.
- Any status change by a client UPDATE.
- A driver accepting their own request.
- Two active drivers on one request.
- Delivering without a capture attempt (the no-PaymentIntent branch in `capture-payment` is removed; under v2 every request carries a hold).

### F.3 Immutable records

- **Append-only `fetch_request_events`** (new): request, from_status, to_status, actor_id, actor_role, reason, metadata, at. Written only inside the transition RPCs. No UPDATE or DELETE grants.
- **`fetch_authorisation_attempts` / `_generations`**: frozen terms (existing; unchanged).
- **Messages and issues**: no client UPDATE or DELETE. Admin can hide a message with a reason.
- **Delivery proof**: storage objects write-once by the assigned driver; readable by parties and admin.

---

## G. Data model changes

All changes are **additive migrations** in `oneshetland-delivers/supabase/migrations/`, isolated-PG tested, and applied only with Darren's go-ahead.

### G.1 `delivery_requests` — add columns

| Column | Purpose |
|---|---|
| `item_description text` (≤140) | What needs moved |
| `size_class text` check (`small`\|`medium`\|`large`\|`bulky`) | Board filtering; P1 capacity |
| `pickup_region_id`, `pickup_area` | Matching and redacted display (today only the destination region exists) |
| `pickup_lat/lng`, `dest_lat/lng` (numeric, server-written) | Pricing audit; never exposed on the board |
| `flexible_until timestamptz` | "Any time before" for flexible requests |
| `safe_place_allowed bool`, `safe_place_note` | Delivery without a handover |
| `driver_id uuid` | The assigned driver, written only by the claim RPC (today ownership is inferred through `run_id`) |
| `claimed_at`, `collected_at`, `delivered_at`, `cancelled_at`, `cancel_reason`, `undeliverable_reason` | Lifecycle timestamps |
| `share_phone_with_driver bool` default false | Phone privacy |
| `idempotency_key text unique` (per customer) | Duplicate-submit protection |
| `fetch_version smallint` default 1; v2 rows = 2 | Lets v1 fixture rows be fenced off |
| `status` check | Add `undeliverable` |

### G.2 New tables

| Table | Key columns | Access |
|---|---|---|
| `fetch_request_events` | see F.3 | Parties read their own; admin all; writes only from RPCs |
| `fetch_messages` | request_id, sender_id, body (≤1000), created_at, hidden_at, hidden_by | Parties (customer and assigned driver) insert and read while the request is active and for 30 days after; admin all |
| `fetch_issues` | request_id, reporter_id, kind (`not_delivered`, `damaged`, `wrong_item`, `driver_conduct`, `requester_conduct`, `payment`, `safety`, `other`), detail, status (`open`\|`resolved`), resolution, resolved_by, timestamps | Reporter and admin read; reporter inserts through RPC; admin resolves |
| `fetch_delivery_proofs` | request_id, kind (`delivery_photo`, `collection_photo`), storage_path, created_by | Parties and admin read; assigned driver inserts once |
| Storage bucket `fetch-proofs` (private) | — | Signed URLs only |

### G.3 `driver_profiles` — add columns

- `release_count int` and `last_release_at`, server-written.
- `suspended_reason`, `decided_by`, `decided_at`.
- `areas text[]` (optional "usually around" regions, shown to admin only).

### G.4 `runs` — changes

- Stop storing origin/destination in `notes`. The columns already exist; this is a client fix.
- Add `driver_first_name` exposure only through the public view.
- Insert, update and cancel through RPCs (`fetch_create_run`, `fetch_cancel_run`; cancelling a run with matched requests is refused unless those are released first).

### G.5 Views and RPCs (read side)

| Read side | What it returns | Who can call it |
|---|---|---|
| `fetch_board_for_driver()` | Pending v2 requests. Region and area, category, size, item description, timing, `base_fee_pence` (the driver's share), a "fits your run" flag. **No addresses, phone or notes** | Approved drivers |
| `fetch_request_detail(id)` | Full detail | Customer, or the assigned driver after claim, or admin. Phone only if shared |
| `fetch_public_runs` (view) | Open runs: origin/destination region, window, categories, ferry flag. **No `driver_id`, no notes** | anon |
| `fetch_admin_requests(filters)` | Admin list including payment state and issues | Admin |

### G.6 Fixture handling

Existing v1 rows (26 requests and 12 runs, all fixtures) keep `fetch_version=1` and are excluded from every v2 read. They are **retired by status, never deleted**, consistent with the "deactivate, not delete" fixture rule.

---

## H. Permissions (RLS and grants)

The principle: **reads through RLS or definer RPCs; every write through RPCs or edge functions.**

| Object | anon | authenticated | Through RPC only |
|---|---|---|---|
| `delivery_requests` | none (revoke the current `GRANT ALL`) | SELECT own rows (customer) and own assignments (`driver_id = auth.uid()`). **Drop both "approved drivers read all pending" policies and all four driver UPDATE policies.** No INSERT, UPDATE or DELETE | create, claim, release, collect, deliver, undeliverable, cancel, extend, confirm-ready |
| `runs` | none on the table (public reads go through `fetch_public_runs`) | SELECT own | create, cancel |
| `waiting_events` | none | SELECT for parties | arrive (driver, own assigned request, status matched); the collect RPC writes `collected_at`. **Drop the open INSERT policy** |
| `fetch_messages` / `fetch_issues` / `fetch_request_events` / `fetch_delivery_proofs` | none | SELECT per G.2 | insert through RPC |
| `driver_profiles` | none | own row SELECT; application through `become-driver` | approve, reject and suspend through `fetch_admin_decide_driver` |

Further rules:

- Every v2 RPC and edge function starts with `fetch_v2_enabled_for(auth.uid())` and fails closed (N.1).
- `become-driver` is fixed so `rejected`/`suspended` cannot be reset by the user. Re-application after a rejection goes through admin.
- **v1 client paths stop working once H lands.** Fetch is paused, has no real users and is already broken on mobile. The order of operations and the Build 148 timing are in P and R.

---

## I. Matching

The Shetland reality: a handful of drivers, a few requests a week, a road network that is largely a spine with ferry links. **No optimisation engine.** P0 matching is two deterministic mechanisms the existing code half-builds.

1. **Browse (primary).** Approved drivers see the redacted board, sorted by:
   1. fits one of my open runs;
   2. earliest deadline;
   3. newest.

   "Fits" means:
   - the request's pickup region equals the run's origin region, or the destination region equals the run's destination region (P0 uses **either end**, because origin was never stored before);
   - the timing window overlaps the run window;
   - the category is accepted.
2. **Run notification (push).** A new request triggers `notify-drivers` for drivers whose open run fits (existing logic, now using the pickup region too). **Change the fallback.** It currently pings every approved driver. v2 pings the approved drivers whose `areas` include the pickup or destination region, and only then everyone, at most once per request. Every ping respects the `fetch_enabled` preference and quiet hours.
3. **Catch a run (customer side).** Removed from the request form. The server attaches "this request fits Ann's run at 14:00" as a hint on the driver's board, and the requester sees "A driver is heading that way today", without choosing a driver. This resolves the A.1(6) conflict in favour of the blueprint.
4. **Acceptance is always manual by the driver.** There is no auto-assignment in P0.

P1 adds a corridor table, so that "Brae→Lerwick passes Voe" counts as a fit, plus capacity and recurrence.

---

## J. Trust, safety and privacy

| Concern | P0 rule |
|---|---|
| Authentication | Signed-in adult members only, for both sides. Existing Turnstile and Confirm-email controls stay |
| Identity | Drivers: admin-reviewed application (vehicle type, registration, statement), the driver agreement accepted **server-side** (recorded on the profile, not only a client compliance log), Stripe Connect KYC. Requesters: account plus card on file (Stripe) |
| Exact addresses | Visible only to the requester, the **assigned** driver (after claim, until 30 days after close) and admin. The board shows region and village only. The public runs view shows no identity |
| Phone numbers | Hidden by default. The requester may share it with their assigned driver; drivers' phones are never shown. Communication goes through `fetch_messages` |
| Ratings | None in P0 (agreed direction). `release_count`, issues and admin suspension are the trust signals |
| Abuse reporting | `fetch_issues` from either party, during the request and for 72h after it closes. `driver_conduct`, `requester_conduct` and `safety` are flagged to admin immediately (notification to admins) |
| Blocking | P1. In P0, admin suspends drivers or restricts a requester (admin-only flag `fetch_restricted` on the profile; the create RPC refuses) |
| Cancellation abuse | Driver releases are counted and visible to admin. Repeated requester cancellations after matching are visible in the admin list. No automatic penalties in P0 |
| Prohibited items | The existing restricted-goods list is shown at create time; the pharmacy and takeaway tick is kept and enforced server-side; drivers may refuse at collection, which is a release with reason `prohibited_item` |
| Admin intervention | Cancel, return to board, resolve undeliverable, refund, suspend, hide a message. All are logged to `fetch_request_events` with the admin's id and a reason |
| Proof | Server timestamps on every transition; delivery photo (optional, required for safe-place); waiting events. Collection photo is P1 |
| Suspicious behaviour | Admin list flags: self-dealing attempts (blocked by the guard and logged), high release counts, issues per member, geocode failures, many requests from new accounts. Rate limits on create, accept and message (existing `enforceRateLimit` machinery) |
| Minors | Existing under-16 exclusion applies on both sides |

---

## K. Payment model

**P0 uses the existing card-hold rail unchanged in principle.** It is the most mature, most tested part of Fetch, and Darren's fee decision (14 Jul) assumes a paid service. Making Fetch free would be a product change, not a simplification.

**Rail:**
- Platform price from `delivery_pricing_config`.
- Manual-capture PaymentIntent placed **at accept**: destination charge to the driver's Connect account, `application_fee_amount` = service fee.
- Hold = base + service + maximum waiting fee, under frozen terms.
- Capture on delivery up to the hold; hold expiry and re-authorisation; refund is admin-only.

**P0 changes:**
1. The hold is placed **inside `fetch-accept`**, not as a separate non-fatal client call. If Stripe needs customer action, the request is `matched` with `payment_status=requires_action`. The requester is notified, and the driver sees "waiting for the requester to confirm payment — do not collect yet". Collection is already blocked by `fetch_hold_is_fulfillable`. If nothing is resolved within **2 hours** (configurable), the system returns the request to the board and voids the PaymentIntent.
2. `authorise-payment`: **refuse** when the driver has no Connect account or payouts are disabled. Today the charge silently lands on the platform.
3. `fetch-quote`: **refuse** when geocoding fails and no postcode is given. Today it falls back to the £4 minimum.
4. `capture-payment`: require `status='collected'` (or `undeliverable` for a retry) and remove the no-PaymentIntent "delivered" branch.
5. `cancel-payment` (and the new cancel/release paths): also void `requires_action`/`requires_payment_method` PaymentIntents.
6. Refund "full vs partial" compares with the **captured** amount, not `pi.amount` (which includes headroom).
7. Capture idempotency key gains the authorisation generation.
8. **One price engine.** `calculate-fee` is retired from Fetch (it stays only if the Shop bridge needs it before P2). Every client-side copy of the rate is removed from both clients.
9. Wallet is **not** a Fetch payment method in P0. Wallet pays merchants through a different rail; adding it would need its own liquidity and self-payment review (memory: wallet liquidity gate).

**Free / favour requests:** **not in P0.** They would need a separate unpaid path with no hold, a different trust profile and different copy, and there is no recorded decision to offer them. Listed as a P2 decision.

**Live-money gate.** Paygate 12 has never run in production (`fetch_authorisation_attempts` = 0 rows). Before the flag reaches `everyone`, one real-card end-to-end run by admin testers must be reconciled: hold, capture, transfer and application fee, then a refund. This is acceptance step Q-12.

---

## L. Notifications

All notifications go through the existing Notification Centre: `sendUserPush` plus a `notification_log` inbox entry, preference `notification_preferences.fetch_enabled`, and quiet hours with `urgent` bypass. **The inbox entry is always written**, so Android users without working push still see every event in-app. Push is never a hard dependency.

| Event | Requester | Driver | Admin | Category | Exists? |
|---|---|---|---|---|---|
| New request fits your run / your area | | ✓ | | `fetch.request_on_route` / `fetch.new_request` | yes (fallback narrowed) |
| Driver accepted | ✓ | | | `fetch.driver_matched` | yes |
| Payment action needed | ✓ (urgent) | | | `fetch.payment_needed` | **new** |
| Payment confirmed — go ahead | | ✓ | | `fetch.payment_ready` | **new** |
| Request returned to board (release or timeout) | ✓ | ✓ | | `fetch.released` | **new** |
| Collected | ✓ | | | `fetch.collected` | yes |
| Delivered | ✓ | | | `fetch.delivered` | yes |
| Cannot deliver | ✓ (urgent) | | ✓ | `fetch.undeliverable` | **new** |
| Cancelled (by the other party or admin) | ✓ | ✓ | | `fetch.request_cancelled` | yes (extended to drivers) |
| Expiring soon / expired | ✓ | | | `fetch.expiring` / `fetch.expired` | yes |
| New message | ✓ | ✓ | | `fetch.message` (collapsed per request) | **new** |
| Issue reported / resolved | reporter | other party when relevant | ✓ | `fetch.issue` | **new** |
| Driver application decided | applicant | | | `fetch.driver_decision` | **new** |
| Payment failed / refunded | ✓ | | | `fetch.payment_failed` / `fetch.refunded` | yes |

Further requirements:

- Tapping a notification opens **the request**, not the Fetch tab. This is a fix in `lib/notifications.ts:79,135` (mobile) and `lib/notifications-inbox.ts:54,94` (web).
- Every notification is sent from the server inside the transition. The web and mobile calls to `notify-drivers` and `notify-collected` are removed.
- "Collection approaching" is **not** in P0: there is no scheduled collection time to anchor it.

---

## M. Web and app architecture

### M.1 The backend is authoritative

| Concern | Lives in |
|---|---|
| Price, validation, geocoding | `fetch-create` / `fetch-quote` (edge) |
| Every state change | SQL RPCs (row lock + conditional status) called from edge functions where Stripe is involved |
| Redaction | Read RPCs and views (G.5) |
| Notifications | Server-side, inside the transitions |
| Feature flag | `fetch_v2_enabled_for()` in SQL plus an RPC the clients call |

### M.2 New and changed edge functions

| Status | Functions |
|---|---|
| **New** | `fetch-create`, `fetch-accept`, `fetch-cancel` (requester), `fetch-driver-action` (arrive, release, undeliverable, proof upload URL), `fetch-admin` (admin actions with a Stripe component) |
| **Changed** | `authorise-payment` (called internally by `fetch-accept`; refuses a missing Connect account), `capture-payment`, `cancel-payment`, `fetch-quote`, `notify-drivers` (internal only), `become-driver`, `refund-payment` (comparison fix), `reminder-runner` (payment-needed timeout) |

Every function above is guarded by the flag, `requireCaller` and `enforceRateLimit`, which are existing patterns.

### M.3 Shared client layer

Neither client contains business logic; both call the same RPCs and edge functions.

- **Web:** a typed `lib/fetch-api.ts` that replaces the direct table writes in `AcceptRequestButton`, `CancelRequestButton`, `ExtendRequestButton`, `CustomerWaitingPanel`, `DriverActions`, `RunComposer`, `CancelRunButton`, `DriverApprovals` and `DisputesManager`.
- **Mobile:** the same `lib/fetch-api.ts` contract.

Status labels, the timeline model and category and size labels go in a small shared constants module, copied into both repos with a contract test as the existing pattern does. There is no shared package today, and introducing one is out of scope.

### M.4 Where each piece is built

| Piece | Repo / branch | Base |
|---|---|---|
| Migrations, RPCs, edge functions, backend tests, this doc | `oneshetland-delivers`, branch **`fetch-v2`** (this worktree) | origin/main `312f7fc` |
| Web | `oneshetland-web`, new branch `fetch-v2` (create when web work starts) | `oneshetland-web` origin/main |
| Mobile (iOS and Android) | `oneshetland-delivers`, branch `fetch-v2-mobile`, **created from the next-release mobile line (Build 148 lineage `7317508`, or its successor)** | **Not** origin/main: its `app/` tree is about 110 files behind Build 148 |

The Build 148 worktree and branch are never modified. Mobile Fetch screens are reused where sound: the request steps, request detail, driver dashboard, create-run and admin screens. Their data and money paths are rewritten. The mobile v2 UI ships only in a new native build or a compatible OTA for the next release. **No OTA is published to the Build 148 runtime.**

---

## N. Feature flag and testing strategy

### N.1 Feature flag (smallest mechanism that fits)

Built from two existing pieces, `admin_config` and the Launch Test Centre `launch_testers`. No new framework is needed.

- `admin_config` key `fetch.v2.audience`, one of `off` | `admins` | `testers` | `everyone`. Default `off`.
- A `launch_test_programmes` row `fetch-v2`. Testers are added in the existing Test Centre admin UI.
- `fetch_v2_enabled_for(uid)` (SECURITY DEFINER, stable) returns `audience='everyone'`, or `audience in ('admins','testers') and is_admin(uid)`, or `audience='testers' and launch_test_is_enabled_tester('fetch-v2')` for that user.
- RPC `fetch_v2_enabled()`, which clients call to decide navigation.
- **Server enforcement:** every v2 RPC and edge function checks it. Hiding the UI alone is not a gate.
- Clients:
  - Web: `/fetch` routes render a "Coming soon" page when the check is false; links are removed from `SECTIONS`, the More menu and the home grid until `everyone`.
  - Mobile: `constants/nav-model.ts` filters Fetch out of `NAV`; `app/(tabs)/fetch.tsx` renders a placeholder; the Home "Your delivery" tile is gated.

Building the flag is Step 0 of the sequence, because it is required before any v2 surface can deploy safely.

### N.2 Test rules

- **All new Fetch tests are isolated-PG**, using the existing isolated harness also used by the notification-centre, Launch Test Centre and security suites, plus mocked-Stripe handler tests.
- **None** use `service_key.txt` or `--linked`. The 7 existing Fetch suites are production-touching. They are kept but **excluded from routine runs**, and should be ported to isolated-PG in Step 12.

### N.3 Required test coverage

| Area | Tests |
|---|---|
| Request creation | Valid create; missing field; geocode failure without postcode is refused (no minimum fallback); client-sent price ignored; flag off is refused; minor is refused; no card is refused; restricted category without tick is refused |
| Duplicate submission | Same idempotency key twice gives one row; double-tap accept gives one claim; double collect / double deliver are idempotent; capture once |
| Ownership and permissions | A member cannot read another's request; an unassigned driver cannot read addresses; anon reads nothing but the public runs view; no authenticated UPDATE/INSERT/DELETE on `delivery_requests` succeeds (pg-level assertion per column); suspended driver blocked; driver cannot accept own request |
| Matching / browsing | The board returns no address, phone or notes columns; the fits-run flag is correct for origin and destination; v1 fixture rows are excluded |
| Acceptance race | Two concurrent `fetch_claim_request` calls give exactly one winner and one `ALREADY_TAKEN`; claim plus authorise failure leaves a consistent state |
| Status transitions | Every allowed edge passes; every prohibited edge from F.2 is refused (table-driven); deliver from `matched` is refused |
| Cancellation | Requester pending and matched (hold voided, including `requires_action`); driver release (back to pending, count incremented, hold voided); after collection refused; admin cancel with partial capture |
| Private location protection | Address visible to the assigned driver only after claim; hidden again 30 days after close; phone only when shared |
| Notification creation | Each transition writes the expected `notification_log` rows, for the right recipients, respecting `fetch_enabled` |
| Payment | Hold at accept; 3DS path; payment-needed timeout returns the request to the board; refuse when no Connect account; capture amount = frozen terms + waiting fee; refund full vs partial correct |
| Completion | Delivered closes; issue window; photo required for safe-place |
| Admin intervention | Approve, reject and suspend (with reason and notification); return to board; resolve undeliverable; all evented |
| Invalid transitions | Covered by the table-driven suite above |
| Flag | `off`, `admins`, `testers` and `everyone` each behave correctly for admin, tester and member, at the RPC level |

**End-to-end acceptance** (real devices, test cards first, then one live reconciliation) follows the Shetland scenarios in section O and the criteria in section Q.

---

## O. Real-world scenario walkthroughs

**A. Lerwick buyer, furniture elsewhere in Shetland.**
1. The requester picks category "Other", size `bulky`, item "2-seat sofa", collection at an address in Brae (pickup region North Mainland, derived), delivery in Lerwick, and "flexible until Saturday".
2. The server quotes the distance price. Bulky is shown so drivers with a car can decline. A size supplement is P1; Darren to decide whether bulky items are in P0 at all (R).
3. A van driver with a Brae→Lerwick run on Friday sees it first, marked "fits your run", and accepts. The card is held; the driver sees the exact addresses; they arrange the time through messages.
4. Collected, then delivered; the hold is captured.

**B. Lerwick→Yell traveller with spare room.**
1. The driver posts a run: Lerwick → Yell, Thursday 15:00–18:00, ferry ✓, categories small-parcel and shop-collection.
2. The public runs view shows "Lerwick → Yell, Thu afternoon". Requesters with something going to Yell post a request (they never pick the run). Requests with destination Yell, or pickup Lerwick and a timing that overlaps, are marked "fits your run" and pushed to this driver.
3. The ferry fare stays the driver's own; OneShetland books no ferries.
4. Price is by distance as today. Whether to add a ferry supplement is a pricing decision (R).

**C. Someone without a car needs shopping.**
1. Category "supermarket click-collect" or "shop-collection". "Already paid" is ticked; pickup is the shop.
2. ASAP or "by 17:00 today". Drivers whose area covers the pickup are notified.
3. Fetch never handles the shopping money. The goods must be prepaid, or the shop/pharmacy flow is used: prescriptions only through pharmacy collection with the liability tick.
4. Paying a driver back for goods bought on the requester's behalf is **not supported** (no cash and no reimbursement in P0). The form says so.

**D. Flexible request with no exact date.**
`scheduling_mode=flexible`, `flexible_until` = up to 7 days, and `expires_at` = `flexible_until`. It stays on the board and is matched as runs appear. A reminder 24h before expiry offers "+24h" (limited extends). It is never shown as urgent.

**E. Two drivers try to take the same job.**
`fetch_claim_request` locks the row (`SELECT … FOR UPDATE`) and updates only where `status='pending' and driver_id is null`. Exactly one claim wins. The other gets `ALREADY_TAKEN` and the board refreshes: "Someone else has just taken this one". The authorisation primary key and the Stripe idempotency key ensure that only one hold can exist even under retries. Covered by the race test.

**F. Requester cancels before collection.**
- From `pending`: closed, nothing charged.
- From `matched`: the hold is voided (including when 3DS is unfinished), the driver is notified, and the run stays open.
- No cancellation fee in P0. Darren to decide whether a late cancellation after the driver is en route should pay the driver something (R).

**G. Driver cancels after accepting.**
Before collection, `fetch_release_request` returns the request to `pending` with its original `expires_at` (extended by at least 2h if close). The hold is voided and re-placed for the next driver. The requester is told "Your driver can no longer make it — we're finding another". `release_count` goes up for admin visibility. After collection, the driver cannot cancel; they must deliver or mark undeliverable.

**H. Collected but delivery cannot be completed.**
1. The driver marks `undeliverable` with a reason and a note (and a photo if relevant). No capture yet.
2. The requester and admin are notified urgently, and an issue opens.
3. Options:
   - The requester and driver agree a retry through messages, and the driver then marks delivered (capture).
   - Admin resolves to `cancelled` with an outcome: returned to sender (capture the base fee, as the driver did the work), retained for collection, or disposed. A zero or partial capture is admin's choice under frozen terms.
4. The item always has a named custodian: the driver until admin records a resolution.

**I. A user attempts to expose another user's address.**
- **Through the API:** after Step 2 the table has no broad read policy. The board RPC returns no address columns, the detail RPC checks party membership, and anon has no table grant. Direct PostgREST queries return only the caller's own rows. Tests assert this column by column.
- **Through the public runs:** the view shows no driver identity or notes.
- **Through messages** (a party pasting someone's address): this is in-request and visible to admin. A report-a-problem `safety` issue lets admin hide the message and act.
- **After close:** the driver's access to addresses lapses after 30 days.

**J. A delivery is disputed.**
1. The requester reports "not delivered" or "damaged" within 72h. The issue opens; the lifecycle does not change (it stays `delivered`, captured).
2. Admin sees the timeline (`fetch_request_events`), the waiting events, the messages, and the delivery photo if any.
3. Admin resolves by refund (full or partial, through the existing `refund-payment`, which reverses the transfer and the application fee) or no action, records the resolution, and both parties are notified.
4. Repeated issues against a driver lead to admin suspension. There is no automated penalty and no ratings.

---

## P. Implementation sequence

Ordering principle: **flag, then the authoritative data and permissions, then the server actions, then clients.** Each step leaves production unchanged in behaviour until its deploy is approved. Because Fetch is paused and has no real data, backend steps can be deployed while the flag is `off` without user-visible change, **except Step 2**, which closes the v1 client write paths (see its risk).

**Build 148 impact for every step:** none to its source or binary. Steps 2–4, once deployed, change how the backend answers Build 148's Fetch screens, which are already non-functional. Hold those deploys until Build 148 has cleared review, unless Darren decides otherwise (R-1).

| # | Step | Objective | Files / components / tables | Depends on | Risk | Tests | Affects current production Fetch? |
|---|---|---|---|---|---|---|---|
| 0 | **Flag + hide v1** | `fetch.v2.audience`, `fetch-v2` tester programme, `fetch_v2_enabled_for/()`; web nav hidden (`lib/sections.ts`, SiteHeader, home grid, `/fetch` placeholder) | migration; `oneshetland-web` | — | Low | Flag matrix (isolated-PG) | **Yes:** Fetch disappears from web nav. Mobile nav changes only in the next release |
| 1 | **Data model** | G.1–G.4 columns and tables, `undeliverable` status, `fetch_version`, proofs bucket; verify the `price_per_mile_pence` row | migrations | 0 | Low (additive) | Migration replay; constraint tests | No |
| 2 | **Permissions / RLS** | H in full: drop broad policies and grants, add redacted reads, close `waiting_events` insert | migration | 1 | **Medium**: ends the v1 client write paths (already broken on mobile; web v1 stops working) | Column-level RLS assertions; anon/member/driver/admin matrix | **Yes:** v1 web Fetch actions stop. Deploy together with Step 0 |
| 3 | **Lifecycle RPCs** | F.2 transitions as SQL RPCs, `fetch_request_events`, idempotency | migration | 2 | Medium | Transition table, race, idempotency | No (not yet called) |
| 4 | **Service layer: edge functions** | `fetch-create`, `fetch-accept`, `fetch-cancel`, `fetch-driver-action`, `fetch-admin`; changes from K.1–K.8 to `authorise-payment`, `capture-payment`, `cancel-payment`, `fetch-quote`, `refund-payment`, `become-driver`, `reminder-runner` | `supabase/functions/*`, `_shared/fetch-*` | 3 | **High** (Stripe paths) | Mocked-Stripe handler tests; controls proving each guard is load-bearing | Changes deployed function behaviour; deploy as exact deltas per the staged-deploy recipe |
| 5 | **Matching** | Board RPC with the fits-run flag; narrowed `notify-drivers` targeting; `areas` | migration, `notify-drivers` | 3 | Low | Matching fixtures | No |
| 6 | **Notifications** | New categories in L, server-side sends, preference handling, inbox deep links | `_shared/send-push.ts` callers, notification constants | 4 | Low | `notification_log` assertions | No |
| 7 | **Messages, issues, proof** | `fetch_messages`, `fetch_issues`, photo upload with signed URLs | migration, edge | 3 | Low–Medium (storage access) | Party-only access; write-once proof | No |
| 8 | **Admin controls** | Driver decisions, request oversight, return to board, resolve undeliverable, issue queue, hide message | RPCs; web `app/admin/{drivers,operations}` rebuilt, `DisputesManager` replaced | 3, 4, 7 | Medium | Admin action tests | Web admin only, behind `requireAdmin` |
| 9 | **Web UI** | Requester and driver flows on `lib/fetch-api.ts`; redacted board; messages; report a problem; copy fixes (A.1); remove client price constants and client notify calls | `oneshetland-web` branch `fetch-v2` | 4–8 | Medium | Contract tests; Playwright-style smoke if available, else a scripted manual run | Behind the flag |
| 10 | **Mobile UI** | Same flows; nav gate; remove client price, status and notify writes; hardcoded production URLs replaced; Android directions fix | `fetch-v2-mobile` from the next-release line | 4–8 | Medium | Source contract tests; simulator run | **Next native build only.** Not Build 148 |
| 11 | **Payments live gate** | One real-card admin run, reconciled in Stripe | — | 9 or 10 | **High** (live money) | Reconciliation checklist | Live, admins only |
| 12 | **Port legacy tests** | Rewrite the 7 production-touching Fetch suites as isolated-PG; retire the originals | `supabase/tests` | 3–4 | Low | — | No |
| 13 | **Real-device acceptance** | Section Q on iPhone and Android with testers | — | 10, 11 | — | Q | Testers only |
| 14 | **Enable** | Audience `testers` → `everyone`; restore nav links | config | 13 + Darren | Medium | Smoke | Yes, by decision |

Payments are not a separate late step: the rail exists, and its P0 changes (K.1–K.8) belong in Step 4 with the actions that call them.

---

## Q. Acceptance criteria — "Fetch works"

Fetch v2 is launchable when all of the following are demonstrated on real devices (iPhone and Android, plus web), by testers under the `testers` flag, with evidence recorded in the Launch Test Centre:

1. A member creates a request on each platform; the price matches the server quote; no client value reaches the price.
2. A second member who is an approved driver with payouts enabled sees it on the board **without any address or phone**, and sees it marked "fits your run" when appropriate.
3. Two drivers accepting at the same moment: exactly one succeeds; the other sees "already taken".
4. On accept, the card is held (visible as `requires_capture` in Stripe); the driver now sees exact addresses; the requester is notified.
5. A 3DS test card: the requester completes the confirmation; the driver is told to go ahead. Left unfinished, the request returns to the board after the timeout and the PaymentIntent is cancelled.
6. Collected and delivered on the driver's device; the requester sees each step within seconds (realtime) and receives notifications (inbox on all platforms; push where available).
7. Capture equals the frozen terms plus the measured waiting fee; the driver's transfer equals the base fee plus the waiting fee; OneShetland keeps the service fee.
8. Requester cancel (pending and matched), driver release, undeliverable then admin resolution, and expiry with extend all behave as in section F, with holds voided correctly.
9. Messages work between the parties and are not visible to anyone else.
10. Report a problem reaches the admin queue; admin refunds; Stripe shows the transfer and the application fee reversed.
11. A non-party member, a non-assigned driver and a signed-out visitor cannot obtain an address through the UI or the API (checked with direct PostgREST calls).
12. One **live** card transaction by an admin tester is reconciled end to end: hold, capture, transfer, fee and refund.
13. Flag `off` hides Fetch on all clients **and** the server refuses every v2 action.
14. The isolated-PG suite passes; no production-touching suite was run.

---

## R. Risks and open decisions

### Decisions Darren needs to make

These are the only ones that block or shape P0.

1. **Build 148 and the visible-but-broken Fetch.** Fetch is in the nav of Build 148 (in review) and cannot complete a delivery on mobile. Options:
   - (a) leave it alone and hold every Fetch backend deploy until 148 clears review (recommended);
   - (b) after review, decide whether the next OTA or build hides Fetch until v2.

   Nothing in this plan touches 148.
2. **Hide Fetch on the web now (Step 0)?** You decided "paused/hidden" on 29–30 Aug; it was never hidden. Hiding it is a web deploy and is recommended before Step 2 lands.
3. **Business senders in P0?** No source excludes businesses, and your 30 Aug brief listed business collections. This plan puts the Shop bridge and business senders in P2 and keeps P0 member-to-member. Confirm.
4. **Public runs view.** Show open runs (region, time, categories, no driver identity) to signed-out visitors, members only, or not at all?
5. **Bulky items.** Is furniture-size in P0 (scenario A), or is P0 limited to small, medium and large (car-boot) items?
6. **Cancellation compensation.** Should a requester cancelling after a driver has set off pay the driver anything? P0 assumes no.
7. **Undeliverable outcome default.** When an item is returned to the sender, does the driver get the base fee (plan default: yes, admin can override)?
8. **Ferry supplement.** Add a fixed supplement per crossing to the platform price, or leave the price distance-only for P0?
9. **Driver vetting depth for launch.** Is the statement plus the agreement plus Stripe KYC enough, or must admins see a licence and hire-and-reward insurance before approval (the driver agreement already requires drivers to hold them)?

Still open from the 30 Aug blueprint, but **not needed for P0**: where goods wait between legs, person or place handovers, loss during handover, carrier-set prices (assumed no), person-to-person sending, ratings (recommended none), and Aberdeen. Revisit them before P2 multi-leg work.

### Risks

| Risk | Mitigation |
|---|---|
| Stripe changes (accept + hold in one call, refusals, capture tightening) regress the proven Paygate rail | Change by exact deltas; mocked-Stripe handler tests with controls; live gate Q-12 before `everyone` |
| Step 2 breaks the remaining v1 paths before v2 clients exist | Deploy Steps 0 + 2 together while Fetch is hidden; no real users exist |
| Mobile work started from the wrong base | M.4: branch from the next-release line, never origin/main `app/` |
| Production-touching test suites run by habit | N.2; suites excluded from routine runs and ported in Step 12 |
| Low driver supply makes "works" look like "broken" (unmatched requests) | Honest expiry messaging, a flexible default, and launching with recruited drivers per `MARKETING_PLAN.md` ("start with Lerwick and nearby routes") |
| Geocoding gaps in rural addresses | Postcode required on failure (Darren, 14 Jul); never price at the minimum silently |
| Android push not functional | Inbox-first notifications; FCM in P1 |
| Shop bridge drifts (still references v1 semantics and `calculate-fee`) | Leave `fetch_enabled=false`; P2 rewires it to v2 |
| Old installed mobile builds keep showing v1 Fetch screens after Step 2 | They are already non-functional; the next release gates them; consider a server-side message for v1 calls (a short "Fetch is being rebuilt" error) |

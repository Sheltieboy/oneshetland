# Fetch v2 — Implementation Plan

**Status:** definitive build plan, with Darren's product decisions recorded. No product code has changed. Implementation has not started.

**Written:** 25 Oct 2026, on branch `fetch-v2` (worktree `~/Claude/oneshetland-fetch-v2`), based on origin/main `312f7fc`.
- First version: commit `058b3c5`.
- Revision 2 (same day) records Darren's decisions on the nine section R questions (now section S) and the live mileage-rate check (section K.0).
- Revision 3 (same day) records Darren's **final P0 decisions** on pricing, bulky minimum, returns, ferries, timeouts, visibility, retention and insurance (S.12–S.19). No P0 product decision blocks Step 0 (R.1).

**Scope:** the next OneShetland app release, plus the web and shared backend. iOS Build 148, which is with Apple App Review, is not touched by anything in this plan (see S.1).

**How to read this document.** Sections A–B record what exists and where that knowledge came from. Sections C–R are the plan. Section S records Darren's decisions. Every claim about current behaviour carries a source tag:

| Tag | Meaning |
|---|---|
| **V** | Read in source |
| **P** | Confirmed live in `supabase/production/*` snapshots (8 Oct) |
| **L** | Read live from production on 25 Oct (read-only; see K.0) |
| **I** | Inferred from policy or code reading, not executed |

---

## A. Existing product and spec sources recovered

There is no dedicated Fetch spec file in any repo. The agreed thinking lives in session transcripts, commits and scattered docs.

| # | Source | Date | What it is | Still binding? |
|---|---|---|---|---|
| 1 | Platform commission spec (transcript 58ae4876) | 31 May | Flat £1.50 Fetch platform fee, originally *inclusive* (taken from the driver's fare) | **Superseded by #4** |
| 2 | "Fetch as a section" (transcript 16adb084; commit 1a2c3da) | 23 Jun | Darren: Fetch "acts like its still its own app… fix it so its just a section". Driver became a capability, not a role. `become-driver` moved server-side | Yes |
| 3 | Darren's product statements (transcript extracts) | 9 Jun–14 Jul | "Fetch is not about sending packages… you either request a pick up by a driver or you are a driver and you set a route" (9 Jun). "a deliveroo/uber-eats thing but for a disparate set of islands… not only for food… also not for people" (14 Jul). "this will be a slow burn" (27 Jun) | Yes |
| 4 | Fee decision (Darren, 14 Jul) | 14 Jul | "I need the service fee, the delivery fee is 100% to the driver". The £1.50 is charged **on top**; the driver agreement (web `app/driver-agreement`) agrees | **Yes. Current rule** |
| 5 | "Reworking Fetch" proposal (artifact claude.ai/code/artifact/643a6d91-…; commits 42ec021, c0e8a31, f6b24fb, 5c4f031, 1f3eaba) | 14 Jul | Run-first rework: `needed_by` and scheduling, expiry plus "+24h" extend, catch-a-run, route-targeted pushes, driver run cancel | Built; partly superseded by #10 |
| 6 | Restricted goods policy (web `/restricted-goods`) and driver agreement | 14 Jul | Banned items list; goods only, no passengers; pharmacy and takeaway liability tick; self-employed drivers declare licence, vehicle and hire-and-reward insurance | Yes |
| 7 | Paygate 12: authorisation, capture, price authority (commits 6d6b7a7, 20f7902, d978703, 98daa01, e1cd939, fc1acc7, 5210d31, da69f90, b3174b6) | 28 Aug | Server price via `fetch-quote`; a hold counts only as `requires_capture`; one hold per delivery; capture recovery; frozen terms; hold expiry and re-authorisation | Yes. **Keep** |
| 8 | Fetch reality check (transcript 3a1667ca) | 29 Aug | "FETCH EXISTS BUT IS NOT CURRENTLY LAUNCH-READY": all 26 requests, 12 runs and 5 drivers are dev fixtures, and mobile cannot price | Yes. Still true |
| 9 | Darren's pause decision (3a1667ca) | 29–30 Aug | "Paygate 12 is PAUSED by product decision". Fetch "paused/hidden as appropriate until separately approved". Shop `fetch_enabled=false` | Pause yes. **The "hidden" part was never done** (see S.2) |
| 10 | **Fetch 2.0 Architecture Blueprint** (3a1667ca, 30 Aug 11:59) | 30 Aug | The most complete spec. Darren's brief: request-first customer; carriers making journeys anyway; "No passenger lifts… not a taxi/ridesharing system"; "Do not invent a rating economy unless necessary". The assistant's answer covers plans, legs, handovers and journeys, deterministic matching, ferry legs, Phases 0–7 and seven open decisions | Direction yes. Phasing revised here (see C) |
| 11 | Security fixes touching Fetch | 19 Aug; 7–8 Oct | Driver self-approval closed (20260819180000); Fetch hold self-payment guard (a670f1a); `notify-drivers`/`notify-collected` caller authorisation (beb333d) | Yes. Live |
| 12 | Under-16 gate (transcript 0e31ffcf) | 13 Aug | Fetch (both sides) gated off for minors | Yes |
| 13 | Docs: web `TEST_PLAN.md` Phase 4, `LAUNCH_CHECKLIST.md`, `MARKETING_PLAN.md`; app `PAYMENTS-TEST-PLAN.md` J1/J2, `LISTING_COPY.md`, `SECURITY_AUDIT.md` | Jun–Jul | Acceptance scripts and launch notes | **Partly stale** (see A.1) |
| 14 | **Darren's Fetch v2 product decisions** | 25 Oct | Answers to the nine open questions | **Yes. Section S** |

### A.1 Discrepancies found between sources

1. **Who pays the £1.50.**
   - Says "cut from delivery fee": source #1 and the docs in #13 (`LAUNCH_CHECKLIST.md:38` and the test plans).
   - Says "on top, paid by the customer": Darren's 14 Jul decision, the driver agreement, and the code (`authorise-payment`: `application_fee_amount` = service fee, added to the base fee).
   - **v2 follows 14 Jul.** Correct the stale docs when v2 copy is written.
2. **Per-mile rate.** **Resolved (L): 65p.** Details in K.0.
3. **Store copy.** `LISTING_COPY.md` says "send and receive parcels, shopping and takeaways". Darren said on 9 Jun that Fetch "is not about sending packages". v2 copy follows Darren.
4. **Is Fetch live?** The funding audit (10 Aug) says "LIVE / Complete". The 29 Aug check and this baseline say not launch-ready.
5. **Paused vs visible.** Darren decided "paused/hidden", but Fetch is still linked publicly on web and is in the app nav in every build, including 148. Decided in S.2.
6. **Catch a run.** Built for customers on 14 Jul; the 30 Aug blueprint moves it to the server. v2 resolves this in I.

### A.2 The five "previously agreed principles" in the brief, checked

| Principle | Finding before 25 Oct | Now |
|---|---|---|
| Driver routes/runs may be publicly visible | Supported in practice (BL:8717); no recorded decision | **Confirmed by Darren (S.4)**, with redaction |
| Must be a member to book/request | Holds in code; no explicit quote | **Confirmed (S.4)**: any interaction needs membership |
| Driver profiles minimal initially | No Darren quote found | **Refined (S.9)**: the public profile stays minimal, but verification evidence is collected privately for admin |
| Business accounts not required for the first version | No source said this | **Confirmed (S.3)**: business-created requests are P2 |
| "Community-powered collections and deliveries across Shetland" | Exact phrase not found; consistent with Darren's statements | Adopted as the proposition |

---

## B. Current implementation baseline

### B.1 Where the code is

| Layer | Location | Notes |
|---|---|---|
| Backend (tables, RLS, RPCs, 15+ edge functions) | `oneshetland-delivers/supabase/`, canonical on origin/main | Equal to production as of the 8 Oct reconciliation |
| Web | `oneshetland-web`: `app/fetch/{page,about,new,apply,previous,connect-bank,[id],runs/new}`, `components/fetch/*` (15), `lib/fetch-data*.ts`, `app/admin/{drivers,operations}`, `components/admin/{DriverApprovals,DisputesManager}` | Publicly linked |
| Mobile (iOS + Android, one Expo codebase) | Build 148 source `~/Claude/oneshetland-build148` (`7317508`): `app/(tabs)/fetch.tsx`, `app/(customer)/request/step-1..4`, `app/(customer)/{dashboard,request-detail,previous-requests,saved-addresses,apply-driver}`, `app/(driver)/{dashboard,create-run,request-detail,connect-bank}`, `app/(admin)/{driver-approvals,delivery-requests,runs,disputes,regions,payments}`, `context/RequestContext.tsx` | In the nav for all users. Fetch screens are byte-identical between build-148 and origin/main apart from the Places proxy |

> **Branch note (preserved; see M.4 and S.10).** origin/main's mobile tree (`app/`, `components/`, `lib/`) is about 110 files behind Build 148 overall. Mobile v2 UI work must not start from `fetch-v2`, and must not be solved by merging `home-redesign`.

### B.2 Data model today

| Table | Purpose | State |
|---|---|---|
| `delivery_requests` | Pickup name, location and notes; `destination_region_id/area/address`; `delivery_notes`; `contact_phone`; `category_slug`; `needed_by`; `scheduling_mode` (asap\|by\|flexible); `expires_at`; `status` (pending, matched, collected, delivered, cancelled, expired); `payment_status` (10 values); fees; `run_id`; `ready_for_collection`; `already_paid` | **No pickup region, no coordinates, no item description or size** |
| `runs` | Driver journey: origin/destination region, departure window, `categories_accepted[]`, `ferry_crossing`, `capacity`, `notes`, status (open\|full\|completed\|cancelled) | Capacity is never enforced and 'full' is never set. Mobile packs origin/destination into `notes` text |
| `driver_profiles` | `driver_status` (not_applied\|pending\|approved\|rejected\|suspended), vehicle type and registration, Stripe Connect flags, `dispute_count`, `flagged_for_review` | Status and Stripe columns locked by `tg_zz_lock_driver_columns`. **No documents, no capacity** |
| `waiting_events` | Arrival and collection timestamps for the waiting fee | Anyone can insert against any `request_id` (BL:8632) |
| `fetch_authorisation_attempts`, `fetch_authorisation_generations` | Hold with frozen terms, capture state, generations | **0 rows**: never run in production |
| `delivery_pricing_config` (L: 1 row), `delivery_categories`, `regions` (17), `delivery_fees` | Pricing and reference data | `delivery_fees` unused |
| `product_orders.delivery_request_id` + sync triggers | Shop→Fetch bridge | Off (`business_shipping.fetch_enabled=false`); uses a second price engine (`calculate-fee`) |

Production data (29 Aug count; not re-queried): 26 requests, 12 runs and 5 driver profiles, **all development fixtures**. Fetch has no real users.

### B.3 Area classification

| Area | Class | Evidence |
|---|---|---|
| Tables / relationships | **PARTIAL** | Core shape is sound. Missing: pickup region, coordinates, size, description, verification, vehicle capacity |
| User roles | **WORKING** | Driver as a capability; admin via `is_admin()`; minors excluded |
| Request creation (web) | **PARTIAL** | Full form. Quoted via `fetch-quote` after the insert; the client deletes the row if quoting fails |
| Request creation (mobile) | **NEEDS REPLACEMENT** | Prices on the client and never calls `fetch-quote`. The server nulls the client price, so accept returns `NOT_PRICED` (V `step-4.tsx:39-93,225-245`; trigger `20260905120000:183-211`, registered in production) |
| Driver availability / runs | **PARTIAL** | Real `runs` table; direct client inserts; no capacity |
| Claiming / accepting | **NEEDS REPLACEMENT** | Direct client `UPDATE status='matched'` guarded by `.eq('status','pending')`; the hold is a separate non-fatal call; RLS lets a driver set any `run_id` |
| Status lifecycle | **NEEDS REPLACEMENT** | No server-owned accept or cancel. A direct PATCH to collected/delivered is allowed by RLS once payment shows authorised. Drivers can cancel without releasing the hold |
| Customer actions (cancel pending, extend, confirm ready) | **NEEDS REPLACEMENT** | There is no customer UPDATE policy, so these are **probably silent no-ops** (I) |
| Communications | **NOT IMPLEMENTED** | Phone number only |
| Payments (hold, capture, expiry, refund) | **WORKING** (backend rail) / **NEEDS REPLACEMENT** (mobile client) | Paygate 12 is solid but has never run live. `authorise-payment` charges to the platform if the driver has no Connect account |
| Location handling | **PARTIAL** | Places via a proxy. Coordinates are discarded. `fetch-quote` prices at the **minimum** if geocoding fails |
| Routing / matching | **PARTIAL** | Destination region + category + needed_by only. Fallback pings every approved driver |
| Ferries | **PLACEHOLDER** | A `runs.ferry_crossing` yes/no only. Not priced, not matched |
| Ratings / trust | **NOT IMPLEMENTED** | Consistent with direction |
| Cancellation | **PARTIAL** | `cancel-payment` for matched requests. Pending cancel is a no-op (I). No driver release path |
| Dispute / safety | **PLACEHOLDER** | `dispute_count`, `flagged_for_review`, `dispute_raised` have no writer |
| Proof of collection/delivery | **NOT IMPLEMENTED** | — |
| Driver vetting | **PARTIAL** | Admin approval exists (direct client update). No documents. `become-driver` lets a rejected or suspended driver reset to pending |
| Address privacy | **NEEDS REPLACEMENT** | Every approved driver can read every pending request's `destination_address`, `contact_phone` and notes (BL:8353/8362) |
| Notifications | **WORKING** (push + inbox) | 10 `fetch.*` categories and the `fetch_enabled` preference. Tapping opens the Fetch tab, not the request. Android push likely non-functional (I) |
| Web / iPhone / Android | **PARTIAL / NEEDS REPLACEMENT / PARTIAL** | Reusable screens; all logic must move to the server |
| Admin tooling | **PARTIAL / NEEDS REPLACEMENT** | Client-side approvals; read-only operations page; no admin cancel or release |
| Feature flag | **NOT IMPLEMENTED** for Fetch | `admin_config` is global and admin-read only. `launch_testers` exists but gates nothing |
| Tests | **PARTIAL** | 7 backend suites, **all production-touching**; no isolated-PG Fetch tests |

### B.4 Facts that change the plan

1. **Fetch is visible but non-functional on mobile in every installed build, including Build 148** (in review). The price-authority and authorisation migrations (5–10 Sep) are registered in production; mobile never calls `fetch-quote`.
2. **There is no real Fetch data.** v2 can extend `delivery_requests` freely. v1 fixtures are fenced off by version and retired by status.
3. **The payment rail is the most mature part.** v2 keeps it and builds around it.
4. **Current RLS is the main defect.** Clients write lifecycle columns directly. Fixing that is early, not a late hardening pass.

---

## C. Fetch v2 proposition

> **Fetch: community-powered collections and deliveries across Shetland — Mainland and the isles.**
> Need something picked up — a parcel, a bit of shopping, a sofa from the other end of the isles? Ask, and a vetted OneShetland neighbour already heading that way brings it. Going somewhere? Say so, and carry something for someone on the way.

Product rules:

- **Goods only.** No passengers, ever; not a taxi or ride-share.
- **Request-first for the customer.** They describe what, where from, where to and by when. They never need to understand runs.
- **Journeys people are already making** are the supply. Drivers post runs or browse.
- **Members only for any interaction.** Requesting, accepting, messaging and reporting all need a signed-in adult OneShetland account. Signed-out visitors may only *see* redacted runs (S.4).
- **Member-to-member in P0.** Business-created requests are P2 (S.3).
- **Platform sets the price**, and the requester sees the full price, including any ferry supplement, before submitting (S.8). The delivery fee and any ferry supplement go 100% to the driver; the OneShetland service fee is on top.
- **Vetted drivers.** Admin approval on verified identity, licence, vehicle and insurance evidence (S.9). The public profile stays minimal.
- **Ferry-aware from day one** (S.8). Bulky items are in scope (S.5), but Fetch is not a removals service.
- **No rating economy at launch.** Verification, admin approval and suspension, issue records and tracked behaviour are the trust model.
- **Slow burn.** Designed for low density.

**Relationship to the 30 Aug blueprint.** Its direction stands. Its multi-leg handovers and multi-carrier payouts remain P2. P0 makes **single-leg Fetch genuinely work, including single-driver ferry journeys** (the driver crosses with the item; there is no handover).

---

## D. P0 / P1 / P2 scope

### P0: "Fetch works" (single leg, one driver, card payment, ferry-aware, behind a server-side flag)

| # | Capability |
|---|---|
| P0-1 | **Create request** via one server call (validate, geocode, price, insert). Fields:<br>• category<br>• **item description**<br>• **size class** (small / medium / large / bulky)<br>• **item photo** (optional; required for bulky)<br>• **approximate dimensions** (required for large and bulky)<br>• **weight/handling warning** (heavy two-person lift, fragile, awkward shape)<br>• collection place (address plus derived pickup region)<br>• delivery place (address plus region)<br>• timing (ASAP / by a date-time / flexible until a date)<br>• instructions<br>• contact phone<br>• liability tick where required<br>The server quote is shown before submit: delivery fee, ferry journey supplement if any, service fee, total, and the "if a return is needed, up to £X" line. Pricing is 65p/mile × 1.40, with a £4 minimum, or **£8 for bulky** (S.12, S.13) |
| P0-2 | Requester sees status, the full price breakdown, the driver's first name and vehicle type once accepted, and a clear timeline |
| P0-3 | **Redacted driver board.** Shows region and village, category, size, description, photo, dimensions, handling warning, timing, the driver's pay (base + ferry), and a "fits your run" flag. **No addresses, phone or notes.** Items above the driver's declared vehicle capacity are hidden by default |
| P0-4 | **Runs.** Drivers post runs through a server call: origin/destination region, window, categories, ferry route if any, and the largest size they can take on this run. Signed-out visitors see a **redacted public runs view** (S.4) |
| P0-5 | **Atomic accept.** One server call: race-safe claim; the driver must **explicitly confirm the vehicle is suitable for this item** (recorded); hold placed in the same call; exact addresses revealed to that driver only after a successful claim |
| P0-6 | **Payment-needed handling.** 3DS or a new card is completed by the requester. If unresolved within a window, the request returns to the board |
| P0-7 | **Driver actions, server calls only:** arrived (optional), collected, delivered (capture), cannot deliver (reason + fault indication), return completed, release before collection |
| P0-8 | **Proof.** Server timestamps on every transition. Delivery photo optional, but **required** for safe-place deliveries and for returns |
| P0-9 | Minimal per-request **message thread** between requester and assigned driver. Phone stays private unless the requester shares it |
| P0-10 | **Cancellation (S.6).**<br>• Before accept: requester cancels freely.<br>• After accept and before collection: requester *requests* cancellation, the driver is informed and can agree (cancelled, hold voided), otherwise admin resolves.<br>• Driver releases before collection.<br>• After collection: no cancellation; use cannot-deliver / return.<br>Repeat cancellations and releases are tracked |
| P0-11 | Expiry, reminder and "+24h" extend (exists; moved to server calls) |
| P0-12 | **Return / problem workflow (S.7, S.14).** `undeliverable` → driver returns the item → admin resolution records the reason and the **fault attribution**. Payout follows fault:<br>• not the driver's fault → the delivery fee plus the **return mileage at the same 65p/mile basis**, computed from the actual return leg; the service fee is charged **once** for the job;<br>• driver's fault → no reward.<br>Admin override, fully evented |
| P0-13 | **Ferry-aware pricing (S.8, S.15).** Pickup and destination regions map to island groups. If the job involves one or more crossings, the quote adds a **flat £2 ferry journey supplement per job** (not per crossing, not by route). It is shown before submit, included in the hold, paid 100% to the driver, and stored with its pricing basis so route-aware pricing can replace it later. P0 isles: Bressay, Whalsay, Yell, Unst, Fetlar. Others are refused with "not yet available" |
| P0-14 | **Driver verification (S.9, S.18, S.19).** Application captures identity (OneShetland account), driving licence evidence (motor vehicles), vehicle details and capacity, and **insurance evidence covering the Fetch activity**.<br>• Which evidence is required comes from a **configurable requirements table** (per vehicle type), so it can change after broker/legal advice without redesign.<br>• Documents go to a **private** bucket only admin can read, and are **deletable separately from the approval and audit record**.<br>• Admin verifies each item, then approves, rejects or suspends with a reason. Expired evidence blocks accepting |
| P0-15 | **Report a problem** on any active request, or within 72h of close, creates an admin issue |
| P0-16 | **Admin.**<br>• Verification review and driver decisions<br>• Request oversight<br>• Cancel-request resolution<br>• Return/undeliverable resolution with payout<br>• Return to board<br>• Refund (exists)<br>• Issue queue<br>• Hide message<br>• Behaviour counters (cancellations, releases, fault-attributed returns) |
| P0-17 | **Notifications** through the existing Notification Centre for every lifecycle event (L) |
| P0-18 | **Feature flag `fetch_v2`** (off / admins / testers / everyone), enforced **server-side** in every v2 RPC and edge function, with clients reading it for navigation |
| P0-19 | **Retire the current public Fetch entry points.** Prepare hiding them on web and in the next mobile release. **Deploy timing is Darren's separate decision (S.2)** |
| P0-20 | Web and mobile clients for all of the above (next app release) |
| P0-21 | Isolated-PG tests and a real-device acceptance run (N, Q) |

### P1: shortly after launch

- **Region corridor table** (Burra→Scalloway→Lerwick; Brae→Lerwick passes Voe) for matching. Run capacity counting and a "full" status.
- **Recurring runs** ("weekdays Brae→Lerwick 07:30").
- Suggested-match pushes to drivers whose run fits, replacing the "ping every approved driver" fallback.
- **Fair late-cancellation fee**, *only if* the tracked data shows it is needed (S.6).
- **Email notifications** (activate the dormant `fetch.*` templates).
- **Driver earnings history.**
- **Block a member.** Admin reassign to a named driver.
- **Safe-place preferences** saved per address. Collection photo.
- **Android push** (FCM credentials) and the Android `maps://` directions fix.
- **Requester "confirm received"** (optional; shortens the issue window).
- **Automated reminders** when verification evidence is about to expire.

### P2: future

- **Business-created requests** and recurring business collections (S.3). The Shop→Fetch bridge rewired onto the v2 lifecycle with a single price engine.
- **Route-aware ferry pricing.** Per-route, per-vehicle, timetable-aware; possibly fed from SIC fare data (S.8).
- **Multi-leg plans**, ferry handovers, and per-leg payouts via separate charges and transfers (blueprint Phases 0, 4–6).
- **Grouped and bundled deliveries.**
- **Specialist removals**, very heavy goods and multi-person jobs (S.5).
- **Free / favour requests** (K.3).
- **Shetland↔Aberdeen.**
- **Ratings**, only if the issue data shows they are needed.

### How the 25 Oct decisions moved scope

| Item | Before | After |
|---|---|---|
| Bulky items with photo, dimensions, handling and vehicle confirmation | open | **P0** |
| Ferry supplement | open; distance-only proposed | **P0** (simple); route-aware pricing → P2 |
| Driver document verification | P1 | **P0** |
| Return with fault attribution and return amount | "admin decides capture" | **P0**, structured |
| Requester cancel after accept | immediate void | **request → driver/admin** |
| Late-cancellation fee | open | P1, *conditional on data* |
| Business senders | open | **P2, confirmed** |
| Public runs | open | **P0, confirmed**, redacted |

---

## E. User roles

| Role | How obtained | Can |
|---|---|---|
| **Visitor** (signed out) | — | Read Fetch about pages and the **redacted public runs view**. Cannot request, book, accept, message or see any request (S.4) |
| **Member** (adult, signed in) | Account; under-16 excluded | Create requests (card on file); see and manage their own requests; message their assigned driver; report a problem; apply to drive |
| **Driver applicant** | `become-driver` + verification submission | Upload and replace their own verification evidence; see their own application status |
| **Driver** (member capability) | Admin approval on verified evidence, **and** Stripe Connect payouts enabled, **and** evidence not expired | Post runs; browse the redacted board; accept (with the vehicle suitability confirmation); see full detail of their own assigned requests; use the driver actions |
| **Suspended / revoked driver** | Admin action with a reason | Nothing driver-side. Existing assignments are released by admin. Cannot re-apply by themselves (fixes the `become-driver` reset) |
| **Admin** | `profiles.role='admin'` / `is_admin()` | Everything, through audited admin RPCs. The only role that can read verification documents |
| **Tester** | `launch_testers` row in programme `fetch-v2` | Sees Fetch v2 while the flag is set to `testers` |

A member can be both requester and driver, but **never on the same request**. The self-payment guard blocks this at the hold, and v2 also blocks it at accept.

---

## F. Request lifecycle (authoritative state machine)

### F.1 States

The existing words are kept (analytics, notifications and Paygate triggers depend on them). Two states are added (`undeliverable`, `returned`) and one flag (`cancel_requested_at`).

| Status | Meaning | Customer label |
|---|---|---|
| `pending` | Priced and open on the board, awaiting a driver | "Looking for a driver" |
| `matched` | Driver accepted. Hold placed, or the requester is asked to complete payment | "Driver found" / "Action needed: confirm payment" / "Cancellation requested" (when the flag is set) |
| `collected` | Driver has the item | "Collected — on its way" |
| `delivered` | Delivered; payment captured. **Closing state** | "Delivered" |
| `undeliverable` **(new)** | Collected, but delivery could not be completed. The driver still has the item, a reason is recorded, and the driver is arranging a retry or a return | "Delivery problem — we're on it" |
| `returned` **(new)** | Item returned to the sender (or other agreed outcome) and the admin resolution recorded. **Closing state** | "Returned" |
| `cancelled` | Closed before collection | "Cancelled" |
| `expired` | No driver before `expires_at` | "No driver found" |

States not adopted:

- `draft`: client-side only.
- `quoted`: create and price are now one call.
- `in_transit`: the same as `collected` for a single leg.
- `completed`: the same as `delivered`.
- **`disputed`:** a dispute is an issue record attached to the request. It never freezes or rewinds the lifecycle; money is resolved by admin refund.
- **`cancellation_requested`:** a flag on a `matched` request, not a state, so the hold and the assignment are not disturbed while it is resolved.

### F.2 Transitions

Every transition is a SECURITY DEFINER RPC or an edge function. **No client role has UPDATE on `delivery_requests`.**

| From → To | Actor | Through | Conditions | Side effects |
|---|---|---|---|---|
| (none) → `pending` | Member | `fetch-create` → `fetch_create_request` | Flag on; adult; card on file; required item fields per size (photo and dimensions for bulky); liability tick; geocoded or postcode; ferry path exists if needed; idempotency key | Notify fitting drivers (L) |
| `pending` → `matched` | Approved driver | `fetch-accept` → `fetch_claim_request`, then the authorise path | Row lock; still `pending`; not own request; driver approved, evidence not expired, payouts enabled; size ≤ declared vehicle capacity; **vehicle suitability confirmed** | Hold placed (frozen terms incl. ferry supplement and return headroom); addresses revealed to the driver; requester notified |
| `matched` (flag set) | Requester | `fetch_request_cancel` | Not collected; reason optional | `cancel_requested_at` set; driver notified (urgent); `requester_cancel_requests`++ |
| `matched` → `cancelled` | Driver agrees to a cancel request; or admin resolves | `fetch_resolve_cancel` | Flag set | Hold voided; both notified; outcome recorded |
| `matched` → `pending` | Driver (release), admin (return to board), system (payment not completed within the window) | `fetch_release_request` | Not collected | Hold voided; attempt settled terminal; `driver_release_count`++ for driver releases; both notified |
| `matched` → `collected` | Assigned driver | `fetch_mark_collected` (exists) | Hold fulfillable; cancel-request flag **not** set (a pending cancel request must be resolved first) | Waiting fee measured; requester notified |
| `collected` → `delivered` | Assigned driver | `capture-payment` (tightened) | Status **must be** `collected` or `undeliverable`; photo if safe-place | Capture under frozen terms; requester notified; issue window opens |
| `collected` → `undeliverable` | Assigned driver | `fetch_mark_undeliverable` | Reason code + note; driver's fault indication (S.7 / K.4) | Issue opened automatically; requester and admin notified; **no capture yet** |
| `undeliverable` → `returned` | Admin (P0 always resolves) after the driver records the return | `fetch_admin_resolve_return` | Return photo; outcome (returned to sender / retained for collection / disposed with consent); **fault** (`not_driver`, `driver`, `undetermined`); payout computed by K.4 (admin may override within the hold, with a reason) | Partial or zero capture, or void; both notified; fault-attributed counters updated |
| `pending` → `cancelled` | Requester | `fetch-cancel` | — | Nothing to void (no hold before accept) |
| any non-terminal → `cancelled` | Admin | `fetch_admin_cancel` | Reason; not collected (after collection, use the return path) | Hold voided; both notified |
| `pending` → `expired` | System (`reminder-runner`) | existing | `expires_at` passed | Requester notified |
| `pending` → `pending` (extend) | Requester | `fetch_extend_request` | Pending; at most N extends | `expires_at` + 24h |

**Prohibited:**

- Any transition out of `delivered`, `returned`, `cancelled` or `expired`.
- `pending` → `collected`/`delivered`.
- Requester cancel (or cancel request) after collection.
- Driver release after collection.
- Any status change by a client UPDATE.
- A driver accepting their own request.
- Accepting an item above the driver's declared capacity, or without the suitability confirmation.
- Delivering without a capture attempt. The no-PaymentIntent branch in `capture-payment` is removed.

### F.3 Immutable records

- **Append-only `fetch_request_events`**: request, from_status, to_status, actor_id, actor_role, reason, fault, metadata (e.g. vehicle-suitability confirmation, payout breakdown, admin override reason), at. Written only inside the transition RPCs; no UPDATE or DELETE grants.
- **`fetch_authorisation_attempts` / `_generations`**: frozen terms (extended with ferry and return terms, see K).
- **Messages and issues**: no client UPDATE or DELETE. Admin hides a message with a reason.
- **Delivery, return and item photos**: write-once.
- **Driver verification evidence**: write-once per upload (new uploads supersede old ones; nothing is overwritten). Admin decisions are evented.

---

## G. Data model changes

All are **additive migrations** in `oneshetland-delivers/supabase/migrations/`, developed and tested against isolated Postgres and local fixtures. **None is applied to production until Build 148 has cleared review (S.1) and Darren approves the deploy.**

### G.1 `delivery_requests`: add

| Column | Purpose |
|---|---|
| `item_description text` (≤140) | What needs moving |
| `size_class text` check (`small`\|`medium`\|`large`\|`bulky`) | Board filtering; capacity matching |
| `approx_dimensions_cm jsonb` (`{l,w,h}`, optional) | Required for large and bulky |
| `handling_flags text[]` (`heavy_two_person`, `fragile`, `awkward_shape`) | Warning to drivers |
| `pickup_region_id`, `pickup_area` | Matching and redacted display |
| `pickup_lat/lng`, `dest_lat/lng` (server-written) | Pricing audit; never on the board |
| `pickup_island_group`, `dest_island_group`, `ferry_required bool`, `ferry_supplement_pence`, `ferry_pricing_basis text` (P0: `flat_per_job_v1`) | Ferry-aware quote (server-written). The basis column lets a later route-aware model coexist with old rows |
| `return_max_pence` | The disclosed "up to" return amount, computed at quote from the delivery→pickup leg (K.4) |
| `flexible_until timestamptz` | Flexible timing |
| `safe_place_allowed bool`, `safe_place_note` | Delivery without a handover |
| `driver_id uuid` | Assigned driver (claim RPC only) |
| `claimed_at`, `collected_at`, `delivered_at`, `cancelled_at`, `cancel_reason` | Lifecycle timestamps |
| `cancel_requested_at`, `cancel_request_reason` | S.6 |
| `undeliverable_reason`, `return_outcome`, `fault_party` (`not_driver`\|`driver`\|`undetermined`), `return_road_miles`, `return_fee_pence` | S.7, S.14 |
| `share_phone_with_driver bool` default false | Phone privacy |
| `idempotency_key text` (unique per customer) | Duplicate-submit protection |
| `fetch_version smallint` default 1 (v2 = 2) | Fences off v1 fixtures |
| `status` check | Add `undeliverable`, `returned` |

### G.2 New tables

| Table | Key columns | Access |
|---|---|---|
| `fetch_request_events` | see F.3 | Parties read own; admin all; RPC writes only |
| `fetch_messages` | request_id, sender_id, body (≤1000), created_at, hidden_at, hidden_by | Parties while active and for 30 days after; admin |
| `fetch_issues` | request_id, reporter_id, kind (`not_delivered`, `damaged`, `wrong_item`, `driver_conduct`, `requester_conduct`, `payment`, `safety`, `cancellation`, `return`, `other`), detail, status, resolution, resolved_by | Reporter + admin; RPC writes |
| `fetch_request_photos` | request_id, kind (`item`, `delivery`, `return`, later `collection`), storage_path, created_by | Item photo: requester, the assigned driver, and **approved drivers via the board RPC** (an item photo shows no address; the requester is warned not to photograph house numbers). Delivery and return photos: parties + admin |
| *(no ferry path table in P0)* | P0 ferry pricing needs only `regions.island_group` (G.3) and two config values (K.5). A `fetch_ferry_routes` table (route, crossings, fare basis) is the P2 extension point; the request's `ferry_pricing_basis` column already distinguishes models | — |
| `driver_verification_requirements` | vehicle_type, evidence_kind, required bool, needs_expiry bool, guidance_text, active | Admin-maintained (S.19). The set of evidence a driver must provide is **data, not code**, so broker or legal advice changes a row, not the design. Public read of guidance text only |
| `driver_verification_items` | driver_id, kind (open text checked against the requirements table: initially `licence`, `insurance`, `vehicle`, `identity_check`), details jsonb (e.g. licence expiry, insurer, policy type as stated, cover start/end, vehicle reg/type), status (`submitted`, `verified`, `rejected`, `expired`, `superseded`), verified_by, verified_at, expires_at, admin_note, **file_deleted_at, file_deleted_by, file_deletion_reason** | **The audit record.** Owner inserts and reads own metadata. Never exposed publicly. **Survives document deletion** (S.18) |
| `driver_verification_files` | item_id, storage_path, uploaded_at | **Separate from the item record**, so a file can be deleted (row + storage object) by an admin RPC or a future retention job while the item, its verified status and the approval history remain. Admin-only read |
| Storage buckets | `fetch-photos` (private; signed URLs) and `fetch-driver-verification` (private; **admin-only read**, owner write-once) | — |

### G.3 `regions`: add

- `island_group text`. Values: mainland (incl. Burra, Trondra, Muckle Roe — bridged), bressay, whalsay, yell, unst, fetlar, out_skerries, fair_isle, and further groups if added.
- **Ferry detection:** a job requires a ferry when `pickup_island_group <> dest_island_group` (Mainland↔isle, or isle↔isle such as Yell↔Unst).
- **P0-supported groups** (S.15): mainland, bressay, whalsay, yell, unst, fetlar. Held in config `fetch.ferry.supported_island_groups`. A request touching any other group is refused with "not yet available".

### G.4 `driver_profiles`: add

| Column | Purpose |
|---|---|
| `vehicle_type` | Values extended: `on_foot`, `bicycle`, `car`, `estate`, `van`, `pickup`, `car_with_trailer` |
| `max_size_class` | The largest size this vehicle takes |
| `can_two_person_lift bool` | Matches the heavy-item handling flag |
| `release_count`, `fault_return_count`, `last_release_at` | Server-written behaviour counters |
| `decision_reason`, `decided_by`, `decided_at` | Admin decision record |
| `areas text[]` | Usual regions; admin-visible only |
| `verification_ok_until timestamptz` | Earliest expiry among verified items; server-maintained |

Drivers without a motor vehicle (`on_foot`, `bicycle`) do not need licence or motor insurance evidence. They are capped at `small`.

### G.5 Requester behaviour counters (on `profiles` or a `fetch_member_stats` table)

- `requests_created`, `cancels_before_accept`, `cancel_requests_after_accept`, `fault_returns_requester_side`.
- Admin-visible only. These are the data for a possible late-cancellation fee (S.6).

### G.6 `runs`: changes

- Use the existing origin/destination columns (mobile must stop packing them into `notes`).
- Add `max_size_class` (defaults to the driver's). The origin and destination regions already give the run's island groups, so a run "crosses to Yell" without any extra column. The existing `ferry_crossing` flag becomes derived and display-only.
- Inserts, updates and cancels go through RPCs. Cancelling a run with matched requests is refused until those requests are released.

### G.7 Read side

| Read | Returns | Who |
|---|---|---|
| `fetch_board_for_driver()` | Pending v2 requests ≤ the driver's capacity: region and village, category, size, description, item photo (signed URL), dimensions, handling flags, timing, driver pay (base + ferry), fits-run flag. **No addresses, phone or notes** | Approved drivers |
| `fetch_request_detail(id)` | Full detail | Customer; the assigned driver after claim (until 30 days after close); admin. Phone only if shared |
| `fetch_public_runs` (view) | Open runs: **origin/destination region names** (broad areas, never addresses), departure date and part of day, categories, max size, "crosses to Yell" style ferry label. **No driver identity, no `driver_id`, no notes, no vehicle registration** | anon + members |
| `fetch_admin_requests(filters)`, `fetch_admin_driver_queue()` | Full admin views, including verification status | Admin |

### G.8 Fixtures

v1 rows keep `fetch_version=1`, are excluded from every v2 read, and are **retired by status, never deleted**.

---

## H. Permissions (RLS and grants)

The principle: **reads go through RLS or definer RPCs; every write goes through RPCs or edge functions.**

| Object | anon | authenticated | Writes via RPC only |
|---|---|---|---|
| `delivery_requests` | none (revoke the current `GRANT ALL`) | SELECT own (customer) and own assignments (`driver_id = auth.uid()`). **Drop both "approved drivers read all pending" policies and the four driver UPDATE policies.** No direct I/U/D | all transitions |
| `runs` | none on the table; `fetch_public_runs` view only | SELECT own | create, cancel |
| `waiting_events` | none | SELECT for the parties | arrive and collect RPCs. **Drop the open INSERT policy** |
| messages / issues / events / photos | none | SELECT per G.2 | RPC inserts |
| `driver_verification_items` + bucket | none | SELECT own metadata; INSERT own (write-once); **no file read except admin** | admin verify/reject |
| `regions`, `driver_verification_requirements` (guidance) | SELECT | SELECT | admin |
| `driver_verification_files` + bucket | none | none (owner uploads through a signed upload URL; cannot read back) | admin read and delete |
| `driver_profiles` | none | own row SELECT | `become-driver`; `fetch_admin_decide_driver` |

Further rules:

- Every v2 RPC and edge function starts with `fetch_v2_enabled_for(auth.uid())` and **fails closed** (N.1).
- `become-driver` is fixed so a `rejected` or `suspended` driver cannot reset themselves.
- **Timing:** these RLS changes alter how production answers Build 148's Fetch screens, so they are **not deployed until Apple has cleared Build 148** (S.1).

---

## I. Matching

Shetland reality: a handful of drivers, a few requests a week, a road spine with ferry links. **No optimisation engine.**

1. **Browse (primary).** Approved drivers see the redacted board, filtered to items ≤ their vehicle capacity (with the option to see all), sorted by:
   1. fits one of my open runs;
   2. earliest deadline;
   3. newest.

   "Fits" means **all** of these hold:
   - the pickup region equals the run's origin region, or the destination region equals the run's destination region;
   - the windows overlap;
   - the category is accepted;
   - the size is ≤ the run's max size;
   - and, if the request needs a ferry, the run's origin/destination island groups match the request's.
2. **Run notification.** A new request pushes drivers whose open run fits. The fallback is approved drivers whose `areas` include the pickup or destination region **and** whose capacity fits, then everyone, at most once per request. Every push respects `fetch_enabled` and quiet hours.
3. **Catch a run, customer side:** removed from the form. The server attaches the "fits Ann's run" hint for drivers. The requester sees "A driver is heading that way" without choosing a driver.
4. **Acceptance is always manual by the driver**, with an explicit vehicle-suitability confirmation (S.5).

P1 adds corridors, capacity counting and recurrence.

---

## J. Trust, safety and privacy

| Concern | P0 rule |
|---|---|
| Authentication | Signed-in adult members only for any interaction. Signed-out visitors see redacted runs only |
| Driver identity and vetting | OneShetland account (email-confirmed, Turnstile) + Stripe Connect KYC, plus **admin-verified evidence**: driving licence (motor vehicles); vehicle details; **insurance evidence showing cover for the actual Fetch activity**; identity check by admin (account name matches licence and Stripe). Statuses: `pending`, `approved`, `rejected`, `suspended` (covers revoked).<br>**The plan does not assert that ordinary private car insurance is sufficient.** Before public driver onboarding, Darren will take advice from a UK commercial motor/courier insurance broker (and legal advice if required) on the actual Fetch model. The evidence list is configurable data (`driver_verification_requirements`), so that advice changes rows, not the design (S.19) |
| Verification documents | Private bucket; admin-only read; never in any public or member view. Files live in `driver_verification_files`, **separately deletable** from the item and approval audit record. **Retention period not yet chosen:** it needs a privacy/data-retention decision before public driver onboarding (S.18). Until then, admin can delete a file on request, and no automatic deletion runs |
| Exact addresses | Requester, the **assigned** driver (after claim, until 30 days after close), and admin only. Never on the board, the public runs view or notifications |
| Public runs | Broad region names and part of day only; no driver identity, registration, notes or exact times that would locate a person's home departure |
| Phone numbers | Hidden by default. The requester may share with the assigned driver. Driver phones are never shown. Contact goes through `fetch_messages` |
| Item photos | Visible to drivers on the board. The requester is warned not to include house numbers or people. Admin can remove one |
| Ratings | None in P0 |
| Abuse reporting | `fetch_issues` from either party, during the request and for 72h after it closes. `safety` and conduct issues alert admin immediately |
| Blocking | P1. In P0, admin suspends drivers or sets `fetch_restricted` on a requester (the create RPC refuses) |
| Cancellation and return behaviour | Counted per member and per driver, visible to admin (S.6, S.7). No automatic penalties in P0 |
| Prohibited items | Restricted-goods list shown at create time. Pharmacy/takeaway tick enforced on the server. "Specialist removals / very heavy goods" are out of scope, and the bulky copy says so. A driver may refuse at collection (release with reason `prohibited_item` or `not_as_described`, which does **not** count against them) |
| Admin intervention | Every admin action is an RPC with a reason, evented |
| Proof | Timestamps; delivery photo (required for safe-place); return photo (required) |
| Suspicious behaviour | Admin flags: self-dealing attempts (blocked and logged), high release or cancel counts, fault-attributed returns, issues per member, geocode failures, burst requests from new accounts. Rate limits on create, accept, message and upload |
| Minors | Excluded on both sides |

---

## K. Payment model

### K.0 Mileage rate: authoritative value (read 25 Oct 2026)

| What | Value | Source |
|---|---|---|
| `price_per_mile_pence` | **65** | **L**: `public.delivery_pricing_config`, the single row `858db32a-632c-4d83-8302-e9e6a30091b8`, `updated_at` 2026-05-20 15:58 UTC. Read with the anon key through the public REST API (the table is intentionally public-read) |
| `min_fee_pence` | 400 | same row |
| `road_correction_factor` | 1.40 | same row |
| Waiting terms | grace 300s; 150p per 300s; max 600p | same row |
| Live pricing function check | `fetch_base_fee_pence(10)` = **910** (10 mi × 1.40 × 65p) | **L**: RPC call, read-only |
| Service fee | `fees.fetch.fixed_pence` = **150**, `fees.fetch.percent_bps` = **0** | **L**: `public.admin_config`, updated 2026-05-31 19:12 UTC (single SELECT through `supabase db query --linked`) |

**The authoritative source is the `delivery_pricing_config` row.** `fetch-quote` → `fetch_base_fee_pence()` is the only price that can reach a request, because the money trigger discards any client-sent fee.

**Why web and mobile disagree:**

1. 95p was the hardcoded rate in the original app code (commits 580654e, 20 May, and 25b80b9, 21 May). The database row was set to 65p on 20 May and never changed.
2. **Mobile** (`app/(customer)/request/step-4.tsx:53`, `PRICE_PER_MILE_PENCE = 95`) has never been updated. It is still in Build 148. It only affects mobile's on-screen estimate, but that estimate is overstated by 46% before the minimum fee applies.
3. **Web** fixed its preview constant to 65p in 20f7902 (28 Aug: "the browser charged 95p a mile while the database said 65p"), but the explanatory copy at `components/fetch/RequestComposer.tsx:440`, "Priced at 95p/mile", added in b977f30 (23 Jun), was not updated.
4. `calculate-fee/index.ts:102` falls back to 95p only if the config row is missing. Its default is stale, but it is unused in practice while the row exists.

**Nothing was changed.**

**Decision (S.12):** P0 keeps this production baseline exactly:
- 65p/mile;
- ×1.40 road factor;
- £4 minimum;
- **£8 minimum for bulky** (new config column `bulky_min_fee_pence` = 800, additive; the live row is not changed until the Step 4 deploy is approved);
- £1.50 service fee on top.

v2 removes every client-side copy of the rate, and the stale 95p copy is corrected in the v2 web and mobile clients. **Build 148 is not changed.**

### K.1 Rail

P0 uses the existing card-hold rail:

- The platform sets the price.
- At accept, a manual-capture PaymentIntent is created as a destination charge to the driver's Connect account, with `application_fee_amount` = the service fee.
- Capture happens on delivery, up to the hold. Expiry and re-authorisation work as today. Refunds are admin-only.

**The hold, frozen at accept:**

```
delivery fee      65p/mi × 1.40 road miles, min £4 (bulky: min £8)     → driver
+ ferry supplement  flat £2 per job if any crossing, else £0              → driver   [S.15]
+ service fee       £1.50, once per job                                   → OneShetland
+ waiting headroom  up to £6 (measured, charged only if incurred)         → driver
+ return headroom   return leg road miles × 65p, no minimum               → driver   [S.14]
                    (charged only on a not-driver-fault return)
```

**Worked example** (Darren's, S.15). 10 straight-line miles to Yell:

| Line | Amount |
|---|---|
| Delivery fee | £9.10 |
| Ferry journey supplement | £2.00 |
| OneShetland service fee | £1.50 |
| **Total charged on delivery** | **£12.60** |

The hold additionally covers up to £6 waiting and up to £9.10 return headroom, captured only if incurred.

Everything is disclosed to the requester before submit. For example: "You'll pay £12.60. If the driver has to wait, up to £6 more. If the item has to be returned for a reason outside the driver's control, up to £9.10 more."

### K.2 P0 changes to the rail

1. **Hold inside `fetch-accept`.**
   - If customer action is needed, the request becomes `matched` with `requires_action`. The driver is told not to collect yet (collection is blocked by `fetch_hold_is_fulfillable`).
   - It auto-releases after a configurable window (default 2h).
2. **`authorise-payment` refuses** when the driver has no Connect account, payouts are disabled, or verification has expired.
3. **`fetch-quote` refuses** when geocoding fails without a postcode (no silent £4 minimum). It refuses a pickup or destination whose island group is not P0-supported (S.15).
4. **`capture-payment`** requires `collected` or `undeliverable`. The no-PaymentIntent branch is removed.
5. **Cancel, release and resolve paths** also void `requires_action` and `requires_payment_method` PaymentIntents.
6. **Refund "full vs partial"** compares against the **captured** amount.
7. The **capture idempotency key** includes the authorisation generation.
8. **One price engine.** `calculate-fee` is retired from Fetch, and all client-side rate copies are removed.
9. **Frozen terms extended** with `ferry_supplement_pence`, `ferry_pricing_basis`, `return_per_mile_pence` (= the rate at accept) and `return_max_pence`, plus the minimum actually applied (£4 or £8). This touches the Paygate terms tables and functions (`claim_fetch_authorisation`, `fetch_capture_total_pence`). Use additive columns with the defaults of today's behaviour, and handler tests with controls.
10. **Admin resolution capture.** A new server path in `fetch-admin` captures a computed amount (K.4) through the existing `claim_fetch_capture`/`settle_fetch_capture`, never above `amount_capturable`.

### K.3 Not in P0

- **Wallet as a Fetch payment method** (separate rail and liquidity review).
- **Free / favour requests** (no recorded decision; different trust model).
- **Automatic late-cancellation fees** (S.6: P1, only if the data justifies it).
- **Route-aware ferry pricing** (P2).

### K.4 Return and undeliverable payout (S.7)

Kept simple and auditable. Admin always confirms in P0.

| Fault (recorded by admin; the driver's reason code is the starting suggestion) | Driver receives | Requester pays | Platform |
|---|---|---|---|
| `not_driver` (recipient absent, address wrong, item refused, item not as described, requester asked to abort after collection) | delivery fee + ferry supplement (once, £2, if the job involved a crossing) + **return fee** + measured waiting fee | the same sum + the service fee **once** | service fee (once) |
| `driver` (driver failed, e.g. vehicle unsuitable after accepting, did not attempt delivery) | nothing (hold voided) | nothing | nothing |
| `undetermined` / disputed | admin sets the amount within the hold, with a reason (override) | as set | service fee only if any charge is made |

**Return fee rule (S.14):** transparent, same basis, no separate rate.

- `return_fee = round(return_road_miles × 65p)`, where `return_road_miles` = server-measured straight-line miles from where the delivery was attempted back to the return point (normally the pickup) × 1.40.
- No minimum fee applies to the return leg.
- The return fee is capped at `return_max_pence`, which was disclosed and held. It is computed at quote from the stored delivery→pickup coordinates, so the cap always covers the normal return.
- The **ferry supplement is not charged twice**: it is per job.
- The **service fee is not charged twice**.
- **Admin override:** where fault or a dispute makes the automatic outcome inappropriate, admin sets any amount from £0 up to the hold, with a mandatory reason. A return to somewhere other than the pickup, at greater distance than the cap allows, is an admin decision within the cap.

Every resolution writes the full payout breakdown (inputs, miles, rate, cap, override and reason) to `fetch_request_events`.

### K.5 Ferry supplement (S.8)

**Principle (S.15).** The driver is already making the journey, so the requester does **not** reimburse the driver's ferry fare or journey cost. A small flat supplement recognises that the job crosses water.

**Rule:**

- If `ferry_required` (pickup and destination island groups differ), add a **flat £2 ferry journey supplement per Fetch job**.
- It is the same for one crossing or two (Lerwick→Unst), and the same on every route. It does not reproduce SIC fares.
- It is a separate line in the quote, shown before the requester commits, and included in the authorised total.
- It is frozen in the attempt's terms at accept and **never added after acceptance**.
- It is paid **100% to the driver** inside the destination-charge transfer. It is never OneShetland revenue, because `application_fee_amount` stays equal to the service fee alone.
- It is auditable: request columns `ferry_required`, `ferry_supplement_pence`, `ferry_pricing_basis='flat_per_job_v1'`, the frozen terms, and the payout breakdown in `fetch_request_events`.

**Config:**

| Key | Default |
|---|---|
| `delivery_pricing_config.ferry_supplement_pence` (new additive column) | 200 |
| `fetch.ferry.supported_island_groups` | mainland, bressay, whalsay, yell, unst, fetlar |

**Later:** route-aware pricing (P2) adds a `fetch_ferry_routes` table and a new `ferry_pricing_basis` value. The quote function chooses the basis. Request, terms and payout plumbing are unchanged, and old rows keep their recorded basis.

### K.6 Live-money gate

Paygate 12 has never run in production. Before the flag reaches `everyone`, one real-card admin run must be reconciled end to end: hold, capture, transfer, fee, and a refund. One ferry-supplement case and one return resolution must also be reconciled (Q-12).

---

## L. Notifications

All go through the existing Notification Centre: `sendUserPush` + a `notification_log` inbox entry, the `fetch_enabled` preference, and quiet hours with `urgent` bypass. **The inbox entry is always written**, so Android users without working push still see every event. Push is never a hard dependency.

| Event | Requester | Driver | Admin | Category | Exists? |
|---|---|---|---|---|---|
| New request fits your run / area / capacity | | ✓ | | `fetch.request_on_route` / `fetch.new_request` | yes (narrowed) |
| Driver accepted | ✓ | | | `fetch.driver_matched` | yes |
| Payment action needed | ✓ urgent | | | `fetch.payment_needed` | **new** |
| Payment confirmed: go ahead | | ✓ | | `fetch.payment_ready` | **new** |
| Requester asked to cancel | | ✓ urgent | ✓ (if unresolved after the window) | `fetch.cancel_requested` | **new** |
| Cancel request resolved | ✓ | ✓ | | `fetch.cancel_resolved` | **new** |
| Request returned to board | ✓ | ✓ | | `fetch.released` | **new** |
| Collected | ✓ | | | `fetch.collected` | yes |
| Delivered | ✓ | | | `fetch.delivered` | yes |
| Cannot deliver | ✓ urgent | | ✓ | `fetch.undeliverable` | **new** |
| Return resolved (with payout outcome) | ✓ | ✓ | | `fetch.returned` | **new** |
| Cancelled / expiring / expired | ✓ | ✓ when relevant | | existing | yes |
| New message | ✓ | ✓ | | `fetch.message` (collapsed per request) | **new** |
| Issue reported / resolved | reporter | other party when relevant | ✓ | `fetch.issue` | **new** |
| Verification item verified / rejected / expiring; driver decision | applicant | | | `fetch.driver_verification`, `fetch.driver_decision` | **new** |
| New driver application / evidence submitted | | | ✓ | `fetch.admin_review` | **new** |
| Payment failed / refunded | ✓ | | | existing | yes |

- Tapping opens **the request**, not the Fetch tab (mobile `lib/notifications.ts:79,135`; web `lib/notifications-inbox.ts:54,94`).
- Every notification is sent from the server inside the transition. Client calls to `notify-drivers` and `notify-collected` are removed.

---

## M. Web and app architecture

### M.1 The backend is authoritative

| Concern | Lives in |
|---|---|
| Price, validation, geocoding, ferry path | `fetch-create` / `fetch-quote` |
| Every state change | SQL RPCs (row lock + conditional status), called from edge functions where Stripe is involved |
| Redaction | Read RPCs and views |
| Verification document access | Storage policies + admin RPCs |
| Notifications | Server-side, inside the transitions |
| Feature flag | `fetch_v2_enabled_for()` + `fetch_v2_enabled()` RPC |

### M.2 Edge functions

**New:**

| Function | Covers |
|---|---|
| `fetch-create` | Request creation |
| `fetch-accept` | Accept + hold |
| `fetch-cancel` | Cancel, and cancel request after accept |
| `fetch-driver-action` | Arrive, release, undeliverable, return recorded, photo upload URLs |
| `fetch-driver-verification` | Upload URLs; submit |
| `fetch-admin` | Driver decisions, verification review, cancel-request and return resolution with capture, return to board |

**Changed:** `authorise-payment`, `capture-payment`, `cancel-payment`, `fetch-quote`, `refund-payment`, `become-driver`, `notify-drivers` (internal only), and `reminder-runner` (payment-needed and cancel-request timeouts, verification expiry).

Every function is guarded by the flag, `requireCaller` and `enforceRateLimit`.

### M.3 Shared client contract

Both clients call the same RPCs and edge functions through a typed `lib/fetch-api.ts` (one copy per repo, kept aligned by a contract test). There is no business logic in either client.

On web, these components are rewritten on top of `fetch-api`:

- `AcceptRequestButton`
- `CancelRequestButton`
- `ExtendRequestButton`
- `CustomerWaitingPanel`
- `DriverActions`
- `RunComposer`
- `CancelRunButton`
- `DriverApprovals`
- `DisputesManager`

### M.4 Where each piece is built (S.10)

| Piece | Repo / branch | Base |
|---|---|---|
| Migrations, RPCs, edge functions, backend tests, this doc | `oneshetland-delivers`, branch **`fetch-v2`** (this worktree) | origin/main `312f7fc` |
| Web (incl. preparing the hide of current entry points) | `oneshetland-web`, branch `fetch-v2` (created when web work starts) | `oneshetland-web` origin/main |
| Mobile (iOS + Android) | `oneshetland-delivers`, branch `fetch-v2-mobile` | **Derived from the current post-Build-148 mobile line / latest accepted app source** (`build-148` `7317508` or its accepted successor). **Not** origin/main, whose `app/` tree is about 110 files behind. **Not** by merging `home-redesign` or any unrelated work |

Further constraints:

- The mobile branch consumes the same backend contract as web. It has no backend copies of its own.
- The Build 148 worktree and branch are never modified.
- The mobile v2 UI ships only in the next release. **No OTA is published to the Build 148 runtime.**

---

## N. Feature flag and testing strategy

### N.1 Feature flag: server-authoritative (S.2)

- **Audience setting:** `admin_config` key `fetch.v2.audience`, one of `off` | `admins` | `testers` | `everyone`. Default `off`.
- **Tester list:** a `launch_test_programmes` row `fetch-v2`; testers are managed in the existing Test Centre.
- **Server check:** `fetch_v2_enabled_for(uid)` (SECURITY DEFINER) and the RPC `fetch_v2_enabled()`.
- **The server is the gate.** Every v2 RPC and edge function refuses when the check is false. Client hiding is presentation only.
- **Clients:**
  - Web `/fetch` routes render "coming soon" when the check is false, and nav links are removed.
  - Mobile filters Fetch out of `NAV`, shows a placeholder tab, and gates the Home tile.

**Retiring the current (v1) public entry points** is prepared in Step 0a as a web change on the `fetch-v2` web branch, and a mobile change for the next release. Deploy timing is Darren's separate decision (S.2). Installed builds' v1 screens stop working server-side only when Step 2 deploys, which waits for Build 148 (S.1).

### N.2 Test rules

- **All new Fetch tests run against isolated Postgres** (the existing isolated harness), plus mocked-Stripe handler tests, plus local fixtures.
- **None** use `service_key.txt` or `--linked`. The 7 existing Fetch suites touch production; they are excluded from routine runs and ported in Step 13.

### N.3 Coverage

| Area | Tests |
|---|---|
| Request creation | Valid create per size; bulky without photo or dimensions refused; **bulky minimum £8 vs normal £4** at short distances; geocode failure without postcode refused; client price ignored; £2 ferry supplement for Mainland↔isle and isle↔isle, **once for two crossings**, £0 within one island group; unsupported isle refused; flag off refused; minor refused; no card refused |
| Duplicate submission | Idempotent create; double-tap accept → one claim; idempotent collect, deliver and resolve; capture once |
| Ownership and permissions | Non-party cannot read; unassigned driver cannot read addresses; anon reads only `fetch_public_runs` (asserted column by column: no driver id, notes or registration); no authenticated I/U/D on `delivery_requests`; verification files unreadable by anyone but admin (including the owner's file read and other drivers) |
| Driver vetting | Unverified, expired, rejected or suspended drivers cannot accept; a rejected driver cannot self-reset; foot and bicycle drivers are capped at small |
| Matching | Board has no address, phone or notes; capacity filter; fits-run incl. ferry path; v1 fixtures excluded |
| Acceptance race | Two concurrent claims → one winner + `ALREADY_TAKEN`; claim without suitability confirmation refused; size over capacity refused |
| Status transitions | Table-driven: every allowed edge passes, every prohibited edge refused |
| Cancellation | Free before accept; cancel request after accept sets the flag and notifies the driver; driver agrees → cancelled with hold voided; collect blocked while a cancel request is open; admin resolves; counters increment; no cancel after collection |
| Returns | Undeliverable → returned with `not_driver` captures delivery + ferry (once) + return fee (miles × 65p, no minimum, ≤ cap) + waiting, with the **service fee once**; `driver` fault voids; admin override within the hold requires a reason; return photo required; counters; evented with the breakdown |
| Ferry | Supplement frozen at accept; a config change mid-flight does not alter held terms; `application_fee_amount` = service fee only (the supplement goes to the driver); basis recorded |
| Verification and retention | Requirements table drives which evidence is mandatory per vehicle type; changing a row changes the gate without code; deleting a file leaves the item, its status and the approval events intact; the owner cannot read files back |
| Timeouts | Each timeout reads its config value, falling back to the default |
| Location privacy | Address visible to the assigned driver only after claim, hidden 30 days after close; phone only if shared; item photos visible on the board, delivery photos not |
| Notifications | Each transition writes the expected `notification_log` rows and respects `fetch_enabled` |
| Payment | Hold at accept; 3DS; payment-needed timeout; refusal without Connect or with expired verification; capture = frozen terms; refund full vs partial |
| Admin | Verification review, driver decisions, cancel-request and return resolutions, return to board, hide message: all evented with a reason |
| Flag | Matrix of `off`, `admins`, `testers`, `everyone` × admin, tester and member, at the RPC level |

---

## O. Real-world scenario walkthroughs

**A. Lerwick buyer, sofa in Brae (bulky, S.5).**
1. Size `bulky`. A photo, approximate dimensions (190×85×80 cm) and the "heavy two-person lift" flag are required.
2. The quote is distance-priced. The requester sees the full price before submitting.
3. Only drivers whose `max_size_class` is bulky (van, pickup or trailer) see it by default.
4. A van driver with a Brae→Lerwick run on Friday sees "fits your run". On accept they must tick "My vehicle can carry this item and I can arrange the lift", which is recorded.
5. The driver finds the item is not as described (a three-seater, not a two-seater). They release with `not_as_described`, which does not count against them, and the requester is told why.
6. Removals-scale jobs ("whole flat") are refused by copy and policy.

**B. Lerwick→Yell traveller (ferry, S.8).**
1. The driver posts a run: Lerwick → Yell, Thursday afternoon, max size large.
2. Signed-out visitors see "Lerwick → Yell · Thu afternoon · crosses to Yell". No name, no registration.
3. A Mid Yell requester posts a parcel request from Lerwick (10 straight-line miles). The server derives that the island groups differ and quotes:

   | Line | Amount |
   |---|---|
   | Delivery fee | £9.10 |
   | Ferry journey supplement | £2.00 |
   | Service fee | £1.50 |
   | **Total** | **£12.60** |

   The waiting and return "up to" amounts are disclosed alongside.
4. The driver sees their pay as £11.10 (+ any waiting). The driver's fare is their own: they were making the journey anyway.
5. Unst (two crossings) still carries one £2 supplement. Out Skerries or Fair Isle is refused as "not yet available".

**C. Someone without a car needs shopping.**
1. Category supermarket click-collect or shop-collection, size small/medium, "already paid".
2. Pharmacy goes only through the pharmacy flow with the liability tick.
3. Fetch handles no shopping money. Reimbursing a driver for goods is not supported, and the form says so.
4. Bicycle and on-foot drivers can take small items locally.

**D. Flexible request, no exact date.**
1. `flexible_until` is up to 7 days, and the request expires then.
2. A reminder offers "+24h" (limited).
3. It is matched as runs appear and is never shown as urgent.

**E. Two drivers take the same job.**
1. `fetch_claim_request` locks the row and updates only `where status='pending' and driver_id is null`.
2. One driver wins. The other gets `ALREADY_TAKEN` and the board refreshes.
3. The authorisation primary key and the Stripe idempotency key ensure only one hold can ever exist. Covered by the race test.

**F. Requester cancels (S.6).**
1. **Before accept:** cancelled immediately, nothing charged, counter `cancels_before_accept`++.
2. **After accept, before collection:**
   - The requester taps "Ask to cancel". The job is **not** destroyed: the driver gets an urgent notification and sees "The requester has asked to cancel", and collection is blocked while the request is open.
   - The driver taps "OK, cancel" → cancelled, hold voided, no charge.
   - If the driver is already on the way and objects, or does not respond within the window, an admin resolves it. P0 has no automatic fee: admin may cancel with no charge, or record it.
   - `cancel_requests_after_accept`++ for the requester. These counts are the evidence for a possible P1 fee.
3. **After collection:** cancel is not offered. The requester uses "Report a problem", and the driver uses cannot-deliver / return.

**G. Driver cancels after accepting.**
1. Before collection: release → back to `pending` (expiry extended by at least 2h if close), hold voided and re-placed for the next driver. The requester sees "Your driver can no longer make it — we're finding another". `release_count`++.
2. Releases for `not_as_described` or `prohibited_item` are recorded but do not count.
3. After collection: no release. The driver must deliver or mark cannot-deliver.

**H. Collected, delivery cannot be completed (S.7).**
1. The driver marks `undeliverable`, for example "recipient not home, no safe place authorised", with a note. The requester and admin are notified urgently, and an issue opens.
2. The requester and driver may agree a retry through messages; the driver then marks delivered (normal capture).
3. Otherwise the driver returns the item to the sender and records it with a return photo.
4. Admin resolves:
   - The outcome is `returned to sender`.
   - The fault is `not_driver`, because the recipient was absent.
   - Payout per K.4: delivery fee + the £2 ferry supplement (once, if the job crossed water) + the return fee (return road miles × 65p, within the disclosed cap) + any waiting. The service fee is charged once.
5. If the driver was at fault (e.g. went to the wrong island), the fault is `driver` and the hold is voided; nothing is rewarded.
6. The driver is the named custodian until admin records the resolution. Everything is evented with the breakdown.

**I. Someone attempts to expose another user's address.**
- **Through the API:** the table has no broad read policy, the board RPC returns no address columns, the detail RPC checks the parties, and anon has no table grant. Tests assert this column by column.
- **Through public runs:** region names only, no identity.
- **Through item photos:** the requester is warned, and admin can remove a photo.
- **Through messages:** visible to admin; a `safety` issue lets admin hide the message and act.
- **After close:** the driver's address access lapses after 30 days.
- **Verification documents:** never readable by anyone except admin.

**J. A delivery is disputed.**
1. The requester reports "not delivered" or "damaged" within 72h. The lifecycle stays `delivered`.
2. Admin sees the timeline, waiting events, messages and delivery photo.
3. Admin resolves by refund (full or partial via `refund-payment`, which reverses the transfer and the application fee) or by no action, and both parties are notified.
4. Repeated issues lead to suspension. No automated penalty, no ratings.

---

## P. Implementation sequence

**Ordering principle:** flag and preparation first, then authoritative data and permissions, then server actions, then clients.

**Deploy rule (S.1).** Every step is developed and tested in isolated worktrees and branches against isolated Postgres and local fixtures. **No production Fetch backend change (migration, RLS, function) is deployed until Apple has cleared Build 148, and then only with Darren's approval.** "Affects Build 148" below means "would alter what production returns to Build 148's Fetch screens if deployed". None of these steps touches Build 148's source or binary.

| # | Step | Objective | Files / tables | Depends on | Risk | Tests | Affects current production Fetch | Affects Build 148 |
|---|---|---|---|---|---|---|---|---|
| 0a | **Prepare v1 retirement** | Web: remove Fetch from `lib/sections.ts`, SiteHeader More, footer, home grid; `/fetch/*` → "coming soon". Mobile: the equivalent NAV, tab and Home-tile gate, for the next release | web `fetch-v2` branch; mobile `fetch-v2-mobile` | — | Low | Render checks | Only when deployed; **timing is Darren's (S.2)** | No (web only; mobile change ships in the next release) |
| 0b | **Flag** | `fetch.v2.audience`, `fetch-v2` programme, `fetch_v2_enabled_for/()` | migration | — | Low | Flag matrix | No (new objects only) | No; deploy held anyway per S.1 |
| 1 | **Data model** | G.1–G.6: request item fields, size, ferry, return and cancel-request columns, statuses; events, messages, issues, photos, ferry paths, verification tables; private buckets; island groups; driver vehicle and capacity; counters | migrations | 0b | Low–Medium (status CHECK widened) | Migration replay; constraints | No behaviour change | Deploy after clearance |
| 2 | **Permissions / RLS** | DONE (see Step 2 status): v1 broad policies and grants retired; public runs, matching board and participant detail representations; phone, address and history windows | migration | 1 | **Medium**: ends v1 client write paths | Access matrix per audience | **Yes**: v1 web and app Fetch actions stop | **Yes**: deploy only after clearance, with 0a |
| 3 | **Lifecycle RPCs** | F.2 incl. cancel request, release, undeliverable, return resolution; events; idempotency; **plus run create/cancel and server-recorded arrival/collection waiting events** (client paths retired in Step 2) | migration | 2 | Medium | Transition table, race, idempotency | No (not yet called) | After clearance |
| 4 | **Pricing + ferry (edge and frozen terms)** | The SQL price is done (Step 3). Step 4: `fetch-create`/`fetch-quote` edge functions (server geocoding with the Google server key, postcode fallback, refuse when unresolved, card-on-file check, then `fetch_v2_create_request`); extend Paygate frozen terms (`claim_fetch_authorisation`, `fetch_capture_total_pence`) with the ferry supplement, minimum applied, return rate and return max; make one service-fee source; retire `calculate-fee` from Fetch | edge functions, Paygate term functions | 3 | **High** (terms tables) | Quote, freeze, capture-total tests with controls | Changes quote behaviour | After clearance |
| 5 | **Payment edge layer** | DONE (see Step 5 status): dedicated v2 functions `fetch-v2-accept`, `-payment`, `-driver`, `-admin`, `-runner`; Fetch v2 hand-off inside the existing `stripe-webhook`; manual capture with partial capture, Stripe's own `capture_before`, generation-based replacement, collection gate, admin payment actions | migration `20261202000000`, `supabase/functions/fetch-v2-*`, `_shared/fetch-v2-{payments,stripe,payment-deps}.ts`, `stripe-webhook` | 3, 4 | **High** (Stripe) | Mocked-Stripe handler tests against the real SQL; controls proving guards are load-bearing | `stripe-webhook` gains a v2-only branch; deploy as exact deltas | After clearance |
| 6 | **Driver verification** | DONE (see Step 6 status): application only ever pending; evidence upload to the service-only private bucket with real-type checks; audited review and decisions; `verification_ok_until` derived from the earliest required expiry; live claim and collection gates; expiry sweep, reminder outbox; per-vehicle re-verification | migration `20261203000000`, `fetch-v2-driver-verification`, `fetch-v2-admin` (`area: drivers`), `fetch-v2-runner`, `become-driver` | 1, 2, 5 | Medium (private document handling) | Storage access matrix; gating; expiry; controls | Driver application flow; admin approval screens must move to the new actions | After clearance |
| 7 | **Matching** | DONE (see Step 7 status): board only for claim-eligible drivers; capacity filter with show-all; direction- and ferry-aware run fit; tiers and plain-English reasons; requester hint; once-only recipient selection; admin diagnostics (`notify-drivers` moved to Step 8) | migration `20261204000000` | 3, 4, 6 | Low | Matching fixtures; controls | No | After clearance |
| 8 | **Notifications** | DONE (see Step 8 status): one server-fed outbox; Notification Centre row first, then push; opportunity vs activity policy; four time-critical kinds; deep-link contract; legacy `notify-drivers`/`notify-collected` refuse v2 | migration `20261205000000`, `fetch-v2-runner`, `notify-drivers`, `notify-collected`, `_shared/fetch-v2-notify.ts`, `_shared/fetch-v2-push-gateway.ts` | 5, 6, 7 | Low | `notification_log` assertions; controls | Legacy notifiers refuse v2 | After clearance |
| 9 | **Messages, issues, photos** | DONE (see Step 9 status): participant-only messages with admin hide and a collapsed notice; 72-hour issue reporting and audited resolution; five photo roles by signed upload with real-type checks and metadata stripping; stricter delivery/return evidence; service-only photo bucket | migration `20261206000000`, `fetch-v2-photos`, `fetch-v2-admin` (`area: support`), `fetch-v2-runner` | 3, 8 | Low–Medium | Party-only, write-once, storage matrix; controls | No | After clearance |
| 10 | **Admin controls** | Exact scope in "Step 10 scope" below: web admin console on the `fetch-v2` branch over the `fetch-v2-admin` areas (queues, job page, driver page); new audited RPCs to redact an item description, restrict a member, and a counters view; old direct-write approval screen replaced | RPCs; web admin rebuilt | 5, 6, 8, 9 | Medium | Admin action tests; render/contract | Web admin only | After clearance |
| 11 | **Web UI** | Requester and driver flows on `lib/fetch-api.ts`; bulky inputs; ferry line; cancel request; return flow; verification upload; copy fixes (A.1, K.0) | web `fetch-v2` | 5–10 | Medium | Contract tests; scripted run | Behind the flag | No |
| 12 | **Mobile UI** | The same flows, on `fetch-v2-mobile` derived from the post-148 line; remove client price, status and notify writes and hardcoded production URLs; Android directions fix | mobile branch | 5–10 | Medium | Contract tests; simulator | **Next native build only** | **No**: Build 148 untouched |
| 13 | **Port legacy tests** | Rewrite the 7 production-touching suites as isolated-PG | `supabase/tests` | 3–5 | Low | — | No | No |
| 14 | **Payments live gate** | One real-card admin run incl. a ferry supplement and a return resolution, reconciled in Stripe | — | 11 or 12; deploys done | **High** (live money) | Reconciliation checklist | Live, admins only | After clearance |
| 15 | **Real-device acceptance** | Section Q on iPhone, Android and web with testers | — | 12, 14 | — | Q | Testers only | No |
| 16 | **Enable** | Audience `testers` → `everyone`; nav restored. **Public driver onboarding** additionally needs the insurance/legal advice applied to the requirements table (S.19) and a retention period chosen (S.18) | config | 15 + Darren + S.18 + S.19 | Medium | Smoke | Yes, by decision | No |

**Step 0 status (25 Oct 2026): DONE, local only. Nothing applied or deployed.**

- **0b:** migration `20261127000000_fetch_v2_feature_flag.sql`, the edge helper `_shared/fetch-v2-flag.ts`, and tests, on `fetch-v2` (this repo).
- **0a:** the web hide, on branch `fetch-v2` of `oneshetland-web` (worktree `~/Claude/oneshetland-web-fetch-v2`).
- **Mobile part of 0a:** deferred to Step 12 on `fetch-v2-mobile`, per Darren's Step 0 instruction (web only now).

**Step 1 status (25 Oct 2026): DONE, local only. Not applied.**

- **Files:** migration `20261128000000_fetch_v2_data_model.sql`, an exact reversal at `supabase/rollbacks/20261128000000_fetch_v2_data_model.down.sql`, and the isolated suite `fetch-v2-data-model.node.test.ts`.
- **Departures from G**, each decided while building and documented in the migration:
  1. **v2 privacy lands now, not in Step 2.** RESTRICTIVE policies narrow every existing permissive policy for `fetch_version = 2` rows only. A v2 request is readable by its requester, its assigned driver (within the address window) and admins. No client, admins included, writes a v2 row directly. A permissive "assigned driver reads" policy is added because the v1 driver policies grant access through `runs`, not `driver_id`. v1 rows behave exactly as before.
  2. **`vehicle_class` is a new constrained column.** The free-text `vehicle_type` written by the current apply form is left unconstrained, so existing rows and v1 clients cannot break.
  3. **No `fetch_ferry_paths` table** (per S.15): ferry detection is `regions.island_group`.
  4. **Server-maintained columns are locked against client writes on v1 rows too.** This applies to every new `delivery_requests` column and the new driver counters and decision fields, so the migration opens no new client-writable field.
  5. **The `price_per_mile_pence` column DEFAULT changes from the obsolete 95 to 65.** The live row (65) is not touched.
  6. **`fetch_issues` are visible to their reporter and admins only**, not to the other party, by default.
- **Carried into Step 2:** with table-level reads, the assigned driver can read every column of the row, including `contact_phone`, even when `share_phone_with_driver` is false. Step 2 must keep the v2 phone where the driver cannot read it directly. Either a private contact table (requester and admins; the driver only when shared), or column-level grants plus a detail RPC. The same review applies to `pickup_notes` and `delivery_notes`.

**Step 2 status (25 Oct 2026): DONE, local only. Not applied.**

**Files:** migration `20261129000000_fetch_v2_access_boundary.sql`, the exact rollback `supabase/rollbacks/20261129000000_fetch_v2_access_boundary.down.sql`, and the suite `fetch-v2-access-boundary.node.test.ts`.

**Access tiers**

| Tier | Who | Through | Contains |
|---|---|---|---|
| A. Public | anyone, when the Fetch v2 audience admits them | `fetch_public_runs()` | origin/destination region and island, date, part of day, max size, categories, crosses water, opaque `run_key`. Never driver identity, ids, notes, exact times or registration |
| B. Matching | approved drivers (flag-gated) | `fetch_v2_board()` | region and village both ends, island groups, ferry, timing, category, `item_description`, size, dimensions, handling, photos the requester marked `matching_visible`, driver pay (delivery fee + ferry supplement). Never pickup name, addresses, notes, safe-place note, phone, coordinates or requester identity |
| C. Participant | requester, assigned driver | `fetch_v2_request_detail(id)` | shaped per viewer (below). Same "not found" for missing and not-yours |
| D. Requester-private | requester | the detail call | own phone, notes, money breakdown |
| E. Admin | admins | direct SELECT + the detail call | everything; **no direct writes** (Step 3's audited actions only) |

Direct table SELECT on a v2 row is **admin-only**. Requesters and drivers never read the raw v2 row.

**Field classification** (`delivery_requests`)

| Class | Fields |
|---|---|
| Public | none: requests are never public |
| Matching-safe | region/village (`pickup_area`, `destination_area`), island groups, `ferry_required`, timing fields, `category_slug`, `item_description`, `size_class`, `approx_dimensions_cm`, `handling_flags`, driver pay |
| After acceptance, within the exact-address window | `pickup_name`, `pickup_location`, `pickup_notes`, `destination_address`, `delivery_notes`, `safe_place_allowed`, `safe_place_note` |
| After acceptance, within the history window (job summary) | status, timeline, item, regions, cancel-request and undeliverable reasons and notes, return outcome and fault, return fee, requester first name |
| Phone | `contact_phone`: the requester's own; the assigned driver **only if `share_phone_with_driver` and the job is live** (`matched`/`collected`/`undeliverable`, not closed) |
| Requester-only | money breakdown (`total_fee_pence`, `min_fee_applied_pence`, `return_max_pence`, `resolution_capture_pence`); the driver sees their pay instead |
| Admin-only | `customer_id`, `driver_id` (parties see first names only), payment ids, coordinates, `resolution_override_reason`, `resolved_by` |

**Windows after a job closes (assigned driver)**

| What | Window |
|---|---|
| Exact addresses and access instructions | 72h (`exact_address_secs`) |
| Phone (only if shared) | while the job is live; never after close |
| Job summary, event timeline, waiting events | 30 days (`participant_history_secs`, renamed from `address_access_secs`) |
| Messages and evidence photos | 30 days: a problem reported near the end of the 72h window still needs them |

The requester keeps their own job indefinitely.

**Participant visibility is not administrative retention.** Admins can read every job's messages, photos and storage objects regardless of the participant windows, and nothing is deleted automatically. `fetch_v2_evidence_held(request)` (service-role only) is true while a job has an open issue. Any future retention clean-up must honour it, so evidence for an unresolved problem outlives the participant windows until it is resolved.

**v1 behaviours that cease when Steps 1–2 are deployed:**
- Approved drivers browsing every pending request (with addresses and phone).
- Accepting, collecting, cancelling, extending or "ready" by direct table write (web and every installed app build).
- Creating requests from the web/app composer.
- Drivers reading jobs through their runs.
- Anyone reading or creating runs directly; drivers creating or cancelling runs from the app.
- The public "runs live now" list from the raw table.
- Recording arrival/waiting from the client.

Admin screens become read-only. Requesters still read their own v1 history. Server-side v1 paths (`authorise-payment`, `capture-payment`, `fetch_mark_collected`, refunds, the Shop sync triggers) run as definer/service role and are unaffected.

**Rollback** restores exactly the pre-Step-2 grants, which never included TRUNCATE for client roles: an earlier hardening migration had removed it, so a naive `GRANT ALL` would have widened privileges.

**Carried into later steps:**
- Requester live updates: v2 requesters cannot subscribe to raw `delivery_requests` changes, so the clients will subscribe to `fetch_request_events` (party-readable) and re-fetch the detail call (Steps 11–12).
- `item_description` is free text on the board: the request form must warn against personal details, and Step 10 adds an admin "edit/redact description" action.

**Step 3 status (25 Oct 2026): DONE, local only. Not applied.**

**Files:** migration `20261130000000_fetch_v2_lifecycle.sql`, rollback `supabase/rollbacks/20261130000000_fetch_v2_lifecycle.down.sql`, and the suite `fetch-v2-lifecycle.node.test.ts` (63 tests, including a real two-session claim race and a concurrent double-create).

**State machine.** `fetch_v2_transition_allowed(from, to, role)` is the only definition of a legal move: 14 (from, to, role) triples. Every status-changing action asks it. Terminal states (`delivered`, `returned`, `cancelled`, `expired`) lead nowhere.

**Actions**

| Kind | Granted to | Actions |
|---|---|---|
| CLIENT | `authenticated`; the actor is `auth.uid()` | `fetch_v2_cancel_open`, `fetch_v2_request_cancellation`, `fetch_v2_decline_cancellation`, `fetch_v2_extend` (max 2 × 24h), `fetch_v2_confirm_ready`, `fetch_v2_mark_arrived`, `fetch_v2_mark_collected`, `fetch_v2_mark_undeliverable`, `fetch_v2_report_return`, `fetch_v2_create_run`, `fetch_v2_cancel_run` |
| SERVICE | `service_role` only; the actor is passed by the Step 4/5 edge function after verifying the JWT | `fetch_v2_create_request`, `fetch_v2_claim`, `fetch_v2_release` (driver, or admin return-to-board), `fetch_v2_agree_cancellation`, `fetch_v2_resolve_cancellation`, `fetch_v2_admin_cancel`, `fetch_v2_complete_delivery`, `fetch_v2_resolve_return`; sweeps `fetch_v2_expire_due`, `fetch_v2_release_unpaid_due`, `fetch_v2_escalate_cancel_requests` |

Every action checks the Fetch v2 flag for the actor, locks the job, writes an append-only event (actor, role, from → to, reason, fault, safe metadata: never addresses, phone or notes), and returns a shaped answer.
- Expected refusals are `{ok:false, code}`; "not yours" is the same "not found" as a missing job.
- Repeats return `{ok:true, already:true}` with no new effect.

**Payment hooks (no Stripe in Step 3)**

| Action | Hook |
|---|---|
| Claim | returns `{action:'authorise', amount_pence}` = total + waiting max + return max |
| Collect | requires the existing Paygate `fetch_hold_is_fulfillable` |
| Complete delivery | requires `payment_status = 'captured'` |
| Release / agree / admin cancel | return `{action:'void', payment_intent_id}` |
| Resolve return | returns `{action:'capture'|'void', amount_pence}` |

**Pricing pulled forward from Step 4.** A job can't be created without a server price, so `fetch_v2_price()` (65p × 1.40, £4/£8 minimum, flat £2 ferry, service fee once, return max = the same mileage with no minimum) and `fetch_v2_straight_miles()` now live in SQL. Distance is always measured from server-geocoded coordinates passed by the service.

**Requester long-term history (point 21, resolved).** The requester keeps every job permanently as a safe summary: status, timeline, item, regions and villages, money. Their own operational details (pickup name, addresses, access instructions, safe-place note, phone) are shown to them only during the 30-day participant-history window after the job closes; after that the detail call returns the summary only. The driver's narrower windows (72h addresses, phone only while live) are unchanged. Physical deletion of operational data is a separate retention decision (S.18) and must honour `fetch_v2_evidence_held`.

**Found while building**
- Under-16 accounts cannot be refused in SQL: no age data exists in the database. The gate must live in onboarding or the edge function, or an age attribute must be added.
- Card-on-file is a Stripe question, so `fetch-create` must check it before calling `fetch_v2_create_request`.
- After a release, the Paygate `fetch_authorisation_attempts` row (one per request) still holds the previous driver's hold. Step 5 must archive it, like the existing generations pattern, before the next driver's hold is placed.
- The service fee is now computed in two places: `fetch_v2_service_fee_pence` and `_shared/commission-config.ts`. Step 4 must make one the single source.
- Runs have no audit trail of their own, which is acceptable for P0 because v2 jobs are not attached to runs.
- Client actions are callable directly through PostgREST, so edge rate limits do not cover them. They are all idempotent or bounded (2 extends, 10 open runs, one arrival); per-actor rate limits can be added in SQL if abuse appears.

**Step 4 status (25 Oct 2026): DONE, local only. Not applied, not deployed.**

**Files**
- Migration `20261201000000_fetch_v2_pricing_terms.sql` and rollback `supabase/rollbacks/20261201000000_fetch_v2_pricing_terms.down.sql`.
- Edge functions `fetch-v2-quote` and `fetch-v2-create` (staged, see below), the shared modules `_shared/fetch-v2-intake.ts` and `_shared/fetch-v2-geocode.ts`.
- Tests: `supabase/tests/fetch-v2-pricing-terms.node.test.ts` (31, isolated database, real handlers with mocked Google, Stripe and limiter) and `_shared/fetch-v2-intake.node.test.ts` (10, no database).
- `supabase/production/staged-functions.json`: the manifest guard now accepts exactly these reviewed, undeployed functions and fails for any other, and for any listed function production already runs.

**Fetch 18+ (decision, 25 Oct).** Fetch v2 is for members aged 18 or over, both requesters and drivers. The server signal is the member's own explicit confirmation, recorded once with its wording version (`fetch_v2_confirm_adult` → `fetch_member_stats.adult_confirmed_at` / `adult_confirmation_version`). It is enforced in SQL by create, claim and run creation, as well as by the edge function. There is no date-of-birth store; driver verification adds the real-world check later. Build 148 and its store metadata are unchanged.

**Source of truth for price.** `fetch_v2_price()` in the database is the only place a Fetch v2 amount is computed. It reads `delivery_pricing_config` (65p, ×1.40, £4, £8 bulky, £2 ferry, waiting rules) and `admin_config fees.fetch.*` (£1.50).
- Step 3's separate service-fee helper is dropped.
- The edge functions pass prices through and never compute them; a test fails if any v2 edge file mentions a rate, commission maths or `calculate-fee`.
- `_shared/commission-config.ts` and `calculate-fee` remain for v1 and the other rails only; the same £1.50 default is pinned in both by a test.
- Clients display figures and never define them.

**Frozen terms (`fetch_v2_terms`, one immutable row per job, written in the create transaction).** Pricing version, rate, road factor, standard and bulky minimums, size class, straight and road miles, mileage, minimum applied, delivery fee, ferry flag/supplement/basis, service fee (fixed + bps), waiting grace/period/rate/cap, return rate and road factor, return maximum, normal total, maximum hold. The CHECKs tie total = delivery + ferry + service and max hold = total + waiting max + return max. The claim amount, the Paygate hold terms, the waiting cap and the return resolution all read these rows; later configuration changes do not touch an existing job, and fresh quotes use the new prices.

**Where a job is.** Coordinates come only from server geocoding (Google, server key): a client place_id is resolved by the server, otherwise address + postcode, then postcode alone. Client coordinates are ignored. The island is derived from coordinates (`fetch_island_areas`, admin data checked against terminals and settlements). A client-chosen region must be on that island (`region_mismatch` otherwise), so ferry status cannot be avoided by picking the wrong region.

| Situation | Answer |
|---|---|
| Location not placeable | `location_unresolved` (never a minimum price) |
| Outside Shetland | `outside_service_area` |
| Unsupported isle | `area_not_supported` |
| Google unreachable | `location_service_unavailable` |

**Quote contract** — `POST fetch-v2-quote` `{size_class, pickup:{region_id, address, postcode?, place_id?, area?}, destination:{…}}` → `{ok, quote}`. The quote contains:
- `driver_delivery_pence`, `ferry_supplement_pence`, `service_fee_pence`, `expected_total_pence`;
- `max_authorisation_pence` with `authorisation_breakdown {expected_total_pence, waiting_max_pence, return_max_pence}`;
- `explanation` (what will be charged vs only held, and why);
- `ferry_required`, `minimum_applied`, `size_class`, `road_miles`, `pricing_version`.

It writes nothing, and is limited to 40/hour and 200/day per member.

**Create contract** — `POST fetch-v2-create`. The quote fields plus `idempotency_key`, `category_slug`, `item_description`, size/dimensions/handling, notes, phone and sharing, safe place, timing, liability. Only an allow-list is forwarded. Returns 201 `{ok, request_id, status, already:false, quote, needs_item_photo, expires_at}`, or 200 with `already:true` and the same quote on a retry. Limited to 10/hour and 30/day per member.

**Card on file.** `fetch-v2-create` checks read-only that the member's existing Stripe Customer has a chargeable card (`chargeableCardFor`). It creates nothing at Stripe and stores no card data.
- No customer or no card → 402 `payment_method_required`.
- Stripe or the profile cannot be asked → 503 `card_check_failed`.

Either way nothing is created, and no geocoding is spent first.

**Order of checks (both functions):** authenticated → rate limit → Fetch v2 flag → 18+ and restriction (→ card) → input → geocode → database. Every failure is a stable `code`; provider and database text is never returned.

**The hold (unchanged policy, review still open — R.2).** The maximum authorisation is expected total + waiting max + return max, shown separately from the expected total with an explanation. Whether the full return exposure must be held up front, or a staged authorisation is better, remains the pre-launch review in R.2. Step 4 did not change that policy.

**Replacement holds after a release (contract for Step 5)**
- `fetch_v2_claim_authorisation(driver, request)` freezes a hold from the job's terms: driver part = delivery + ferry, application fee = service fee, waiting terms, amount = maximum hold. It continues the generation after any archived hold and returns the Stripe idempotency key (`fetch-auth-<id>` for the first, `fetch-auth-<id>-g<n>` after).
- `fetch_v2_retire_authorisation(request)` archives a released or cancelled job's hold into `fetch_authorisation_generations` and removes it. It only does so once the job is no longer assigned and the attempt is settled `terminal`; it refuses `hold_still_live` before, and never touches a captured hold.
- `fetch_capture_total_pence` returns the resolution amount for a v2 return.

**Rollback** restores the catalogue exactly (proved). It refuses while frozen terms or 18+ confirmations exist.

**Step 5 responsibilities (exact)**
1. `fetch-accept` edge: `fetch_v2_claim` → `fetch_v2_claim_authorisation` → Stripe PaymentIntent (manual capture, destination = the driver's Connect account, `application_fee_amount` = service fee, amount = maximum hold, idempotency key as returned) → `settle_fetch_authorisation` → hold state.
2. Release, cancellation and payment-timeout paths: Stripe cancel of the returned `payment_intent_id` → `settle_fetch_authorisation('terminal')` → `fetch_v2_retire_authorisation`.
3. Delivery and return capture: `claim_fetch_capture` → capture `fetch_capture_total_pence` (the resolution amount for returns, ≤ the hold) → `settle_fetch_capture` → `fetch_v2_complete_delivery` (delivery) or nothing further (returns are already resolved).
4. The reminder runner calls `fetch_v2_expire_due`, `fetch_v2_release_unpaid_due` (then step 2 for each intent) and `fetch_v2_escalate_cancel_requests`.
5. `authorise-payment` / `capture-payment` / `cancel-payment` either learn v2 or v2 gets its own functions (decision in Step 5); v1 behaviour is not changed in production by Steps 1–4.
6. The admin edge function for the service-only admin actions, passing the verified admin as actor.
7. Mocked-Stripe handler tests with controls, as for Paygate 12.

**Step 5 status (25 Oct 2026): DONE, local only. Not applied, not deployed. No live Stripe.**

**Files**
- Migration `20261202000000_fetch_v2_payments.sql` and rollback `supabase/rollbacks/20261202000000_fetch_v2_payments.down.sql` (refuses while any hold carries Stripe state; otherwise restores the catalogue exactly, proved).
- `_shared/fetch-v2-stripe.ts`: the only Stripe calls Fetch v2 makes (create hold, retrieve, cancel, capture), typed errors, never the key in an error.
- `_shared/fetch-v2-payments.ts`: every handler (accept, requester payment, driver actions, admin, runner, webhook). Pure: Supabase, Stripe, card lookup, Connect lookup, admin check and limiter are injected.
- `_shared/fetch-v2-payment-deps.ts`: the Deno production wiring.
- Edge functions `fetch-v2-accept`, `fetch-v2-payment`, `fetch-v2-driver`, `fetch-v2-admin` (JWT) and `fetch-v2-runner` (cron secret), all staged in `supabase/production/staged-functions.json`.
- `stripe-webhook`: a Fetch v2 hand-off before the existing `switch`. It is listed under the manifest's new `modified` section (deployed function, reviewed staged change). The guard fails if a listed function is not deployed, does not actually differ, or has no reason.
- Tests: `supabase/tests/fetch-v2-payments.node.test.ts` (47, isolated database, real handlers, in-memory Stripe) and `_shared/fetch-v2-stripe.node.test.ts` (8, fake fetch).

**Decision: dedicated v2 functions, not v1's.** `authorise-payment`, `capture-payment`, `cancel-payment` and the v1 webhook branches are untouched. v2 intents carry `metadata.fetch_v2_request_id` and never `request_id`, so no v1 branch can act on them (a test pins this). The only shared deployed code that changes is the webhook hand-off.

**Connect model (unchanged from v1).** A destination charge on the driver's Express account:
- `capture_method=manual`; `amount` = the frozen maximum hold;
- `transfer_data[destination]` = the driver's account;
- `application_fee_amount` = the frozen £1.50.

On capture, both `amount_to_capture` and `application_fee_amount` are sent: the fee is `least(service fee, capture)`, so a reduced capture never carries a fee larger than itself. The driver receives capture − fee, which is delivery + ferry + waiting (+ return mileage on a return). OneShetland receives the £1.50 once. Nothing is ever captured above Stripe's `amount_capturable`: the handler escalates to a person instead (`capture_exceeds_hold`).

**Authorisation (`fetch-v2-accept`).** The handler runs these steps in order:
1. Authenticate, then rate limit (`fetch_v2_accept`, plus the shared `stripe_intent` hourly and daily budgets).
2. Check the flag, the 18+ and restriction rules, and the driver rules.
3. Check the Connect account exists with payouts enabled (`driver_payouts_not_enabled`).
4. Self-payment guard (`wallet_destination_self_controlled`) → `self_payment`.
5. `fetch_v2_claim` (the row lock decides the race; the loser gets `already_taken`).
6. `fetch_v2_claim_authorisation` freezes the amount, generation and key.
7. Create the hold with the requester's saved card.
8. Apply the result through `fetch_v2_apply_payment_state`, the single Stripe → Fetch entry point.

The client sends only `request_id` and `vehicle_confirmed`. Amount, destination, fee, intent, generation and key are never read from the body (tested).

| Stripe outcome | Fetch outcome |
|---|---|
| `requires_capture` | `authorised`; stores Stripe's own `capture_before` (from `latest_charge.payment_method_details.card.capture_before`, never an assumed 7 days), `amount_capturable`, and the time it was confirmed |
| `requires_action` / decline / no saved card | `requester_action_required`; the driver keeps the job; collection is blocked |
| unreachable or lost response | `pending`; the retry reuses the same key, so Stripe returns the same intent (one intent, proved) |
| account refused | system release back to the board, **not** counted against the driver; `payment_could_not_start` |

**SCA.** The requester calls `fetch-v2-payment {action:'complete'}`. Only they, and only while the intent needs action, receive the `client_secret`, and they confirm 3DS in the browser. Either `{action:'refresh'}` or the webhook (`amount_capturable_updated`, which covers a closed tab) moves the job to `authorised`. If it is never completed, `fetch_v2_release_unpaid_due` releases the job after `payment_needed_secs` (2h). The clock is measured from the later of the claim and the current hold. The runner then voids and archives the hold.

**Collection gate.** `fetch_v2_hold_ready` is used by `fetch_v2_mark_collected` and shown to the driver as `can_collect`. All of these must hold:
- Paygate `fetch_hold_is_fulfillable` (authorised, valid or expiring-soon, confirmed within 2h, not past expiry);
- capturable ≥ total + waiting max;
- expiry ≥ now + `collect_min_hold_secs` (24h).

Each refusal has a reason: `stale` (refresh from Stripe with `refresh_hold`), `insufficient_hold`, `hold_expiring`, `payment_not_ready`.

**Hold expiry and replacement (generations).** Holds are classed `expiring_soon` inside `hold_expiry_margin_secs` (48h).

| When | What happens |
|---|---|
| Before collection, hold dying or expired | the runner **rotates**: void the old intent, archive it in `fetch_authorisation_generations`, `fetch_v2_rotate_authorisation`, then a new hold for the same driver with key `fetch-auth-<id>-g<n>`. If that needs SCA, the job shows action required and collection stays blocked |
| After collection | never rotated (that risks two holds or none): one `payment` issue is opened for a person |

Never two live holds: a new hold is only created once the previous one is settled `terminal` and archived. `fetch_v2_claim_authorisation` now refuses to reuse a different driver's hold (`previous_hold_not_retired`); the handler voids and retires it, then claims again.

**Delivery and capture (`fetch-v2-driver {action:'deliver'}`).** The steps:
1. Non-money checks first (`fetch_v2_delivery_precheck`: assigned driver, collected, safe-place rules).
2. The amount comes from SQL: `fetch_v2_capture_amount` = total + measured waiting.
3. Retrieve the intent. If it is already `succeeded`, treat it as done.
4. `claim_fetch_capture` → Stripe capture with key `fetch-v2-capture-<pi>` → apply → `settle_fetch_capture`.
5. Only then `fetch_v2_complete_delivery`.

| Capture result | Outcome |
|---|---|
| lost response | `capture_pending`; the job stays `collected`; the retry returns the original capture |
| failure | `capture_failed`; a payment issue opens; the admin can `retry_capture` |
| repeat | `already` |

**Cancellation and release.** Driver release, an agreed cancellation, admin cancel, admin return-to-board and the payment timeout all follow the same path. Stripe cancel with key `fetch-v2-void-<pi>` → `terminal` → `fetch_v2_retire_authorisation`. If Stripe cannot confirm the void, the job still changes state, and the runner's `void_orphan` / `retire` work finishes it.

**Returns.** `fetch-v2-admin {action:'resolve_return'}`:

| Fault | Capture |
|---|---|
| not the driver's fault | total + return mileage at 65p, still one £1.50 fee |
| the driver's fault | 0; the hold is voided |
| override | needs a reason and an integer amount within the hold; the fee shrinks with it |

Owed > capturable → escalated, nothing captured.

**Admin actions** (`fetch-v2-admin`): `cancel`, `return_to_board`, `resolve_cancellation`, `resolve_return`, `retry_capture`, `void_hold` and `reconcile`.
- Each needs an admin (checked on the server) and passes them as the actor of the audited SQL action, so every action writes an event.
- Every action that changes money or a job needs a reason.
- `void_hold` is refused while the item is in transit.

**Webhook reconciliation.** `isFetchV2Intent` (a `payment_intent.*` event whose metadata holds a UUID `fetch_v2_request_id`) hands the event to `handleFetchV2Webhook`, and every other event goes to the existing switch unchanged. The handler re-retrieves the intent (Stripe's current state beats a stale event) and falls back to the event snapshot only if Stripe is unreachable. `fetch_v2_apply_payment_state` is then:
- **Scoped:** only the current hold's intent counts. A retired generation is ignored as `retired_generation`, and a non-v2 job as `not_fetch_v2`.
- **Never backwards:** `already_captured`, `already_terminal`.
- **Replay-safe:** an unchanged state logs nothing.

The existing signature check (platform and Connect secrets) applies as before. There is no event-id dedupe table, and none is needed: the outcome depends only on Stripe's current state, so a replayed, duplicated or reordered event converges to the same result.

**Runner (`fetch-v2-runner`, cron secret).** It runs the lifecycle sweeps (`expire_due`, `release_unpaid_due` + void, `escalate_cancel_requests`), then `fetch_v2_payment_work()`:
- `void_orphan`, `retire`, `rotate`, `escalate`, `capture_return`;
- `refresh` (confirmations older than 1h on live jobs).

Every item is independent and repeat-safe, and one failure never stops the rest. It returns counts only.

**Idempotency keys (deterministic)**

| Call | Key |
|---|---|
| hold | `fetch-auth-<request>` (generation 1), `fetch-auth-<request>-g<n>` |
| capture | `fetch-v2-capture-<pi>` |
| void | `fetch-v2-void-<pi>` |

**Responses** never contain a Connect account, Customer, payment method, key, intent id or provider text (tested). Rate limits: `fetch_v2_accept` 30/h, `fetch_v2_payment` 60/h, `fetch_v2_driver` 120/h, `fetch_v2_admin` 300/h. Every new SQL function is `service_role` only.

**Not changed: the hold size (R.2 stays open).** The hold is still total + waiting max + return max.

**Concerns carried forward**
- A system release after a payment failure logs event `payment_timeout` with reason `payment_failed`. It is accurate in the reason, but the event name is broad.
- After-collection expiry depends on a person acting on the payment issue. Step 10's admin queue must surface `payment` issues prominently.
- Stripe's `capture_before` is only present once a charge exists. Until then, Fetch treats the hold as not ready (it never invents a deadline).
- `stripe-webhook` has 5 pre-existing `deno check` errors (`WalletAssessment`), identical before and after this change.

**Step 6 scope (exact): driver verification**
1. **Migration:**
   - The verification documents table, keyed to the driver, with a type from the requirements table (licence, insurance, MOT/vehicle, ID), its expiry date, a review status (`submitted`/`approved`/`rejected`/`expired`), reviewer, reason and timestamps.
   - The private storage bucket policy: owner upload, owner and admin read, no public URLs.
   - `fetch_v2_submit_verification`.
   - `fetch_v2_review_verification(admin, document, decision, reason)`, audited.
   - `verification_ok_until` recomputed as the earliest approved expiry across the required set.
   - An expiry sweep that marks expired documents, and a reminder window.
2. **`fetch-v2-driver-verification` edge function:** signed upload, then submit; flag and 18+ gated; rate limited.
3. **`fetch-v2-admin` additions:** list pending, view through short-lived signed URLs, approve or reject with a reason.
4. **Fix `become-driver`** so applying cannot self-approve or set vehicle, capacity or verification fields.
5. **Accept gating stays in `fetch_v2_driver_problem`.** An expired or missing verification refuses claims; already-assigned jobs are untouched.
6. **The runner** calls the expiry sweep.
7. **Isolated tests:** storage access matrix (driver, other driver, requester, admin, anonymous), review audit, expiry recompute, the gate, rollback.
8. **Not in Step 6:** the insurance/legal requirement wording (S.19, external), retention periods (S.18), UI (Steps 11–12).

**Step 6 status (25 Oct 2026): DONE, local only. Not applied, not deployed. No storage policy applied to production.**

**Files**
- Migration `20261203000000_fetch_v2_driver_verification.sql` and rollback `supabase/rollbacks/20261203000000_fetch_v2_driver_verification.down.sql` (refuses while any Step 6 record exists; otherwise restores the catalogue exactly — columns, constraints, indexes, triggers, functions with their grants, table grants, RLS and storage policies — proved, then re-applied).
- `_shared/fetch-v2-verification.ts` (handlers), `_shared/fetch-v2-verification-deps.ts` (Deno wiring: service database, private bucket, limiter).
- New edge function `fetch-v2-driver-verification` (staged). `fetch-v2-admin` gains `area: "drivers"`; `fetch-v2-runner` runs the verification sweep after the payment sweeps (both staged).
- `become-driver` rewritten (deployed function → manifest `modified`; it needs this migration applied first).
- Tests: `supabase/tests/fetch-v2-driver-verification.node.test.ts` (49, isolated database, real handlers, in-memory storage; storage RLS tested on the replayed `storage.objects`).

**Self-approval: what was found and fixed**
- `become-driver` never wrote `approved`, but it put a **suspended or rejected** driver straight back to `pending` (a suspension could be undone by re-applying), and let an **approved** driver rewrite their vehicle without review. Now it only forwards an allow-list to `fetch_v2_apply_driver`: flag, 18+ and restriction checked; a suspended account is refused; an approved account is left unchanged (vehicle changes go through `set_vehicle`); everything else becomes `pending`, recorded. Fields like `driver_status`, `verification_ok_until`, `decided_by` in the body are ignored (tested).
- The column lock trusted an **administrator's browser session** (`tg_is_trusted_writer`), so any admin client could set `driver_status = 'approved'` or `verification_ok_until` with no review record. Now every client session — admin included — is refused, loudly (42501), when it changes approval, verification, decision, vehicle class, size class, two-person lift or registration. Only the audited functions (SECURITY DEFINER) and the service role write them. A client INSERT still gets an ordinary `not_applied` row.
- **Consequence:** the existing admin "approve driver" screens (web `components/admin/DriverApprovals.tsx`, app `(admin)/driver-approvals.tsx` in Build 148) write `driver_status` directly; after this is deployed those writes fail with an error instead of approving. That is intended (approval needs evidence now); Step 10 replaces them with the `fetch-v2-admin` drivers actions. The production-linked `column-locks` test asserts the old admin path and must be updated in the same deploy.

**Two states, kept apart**

| | Values | Who changes it |
|---|---|---|
| Account (`driver_profiles.driver_status`) | `not_applied` → `pending` → `approved` / `rejected`; `approved`/`pending` → `suspended`; `suspended` → `approved` (reinstate); `rejected` → `pending` (re-apply) | applying: the member (to `pending` only). Everything else: a reviewer, with a reason (approve may omit it) |
| Evidence (`driver_verification_items.status`) | `submitted` → `verified` / `rejected`; `verified` → `expired` (sweep) / `superseded` (newer approval, vehicle change) / `rejected` (replacement requested) | submitting: the driver. Review: a reviewer. Expiry: the sweep |

Each submission is a new item with a `version`; nothing is overwritten. At most one awaiting review and one verified per kind (unique indexes). A renewal waiting for review does **not** unverify the current document; when it is approved, the older one becomes `superseded`. Expiry changes only the status — who reviewed it and when stay on the row. "Under review" is `submitted`; "replacement requested" is a rejection recorded as `replacement_requested`.

**Requirements are data.** `driver_verification_requirements` (per vehicle class: kind, required, needs_expiry, the new `per_vehicle`, guidance, active) decides what is needed. `fetch_v2_set_requirement` (admin, audited) changes it and immediately re-derives every affected driver; a newly required kind lapses existing drivers until they supply it (tested). The seeded rows are unchanged from Step 1: identity check, licence (expiry), vehicle (per vehicle), insurance (expiry, per vehicle; its guidance still says the exact cover is being confirmed). No legal statement was added; the motor, hire-and-reward and goods-in-transit requirements wait for the external advice (S.19).

**Storage and upload**
- The `fetch-driver-verification` bucket stays private, and now has **no client policy at all**: no member, driver or administrator can read, list, write or delete it directly. Only the service role reaches it.
- Upload: `begin_upload {kind, mime_type, size_bytes}` checks the account (pending/approved, not suspended), the vehicle, that the kind is configured for that vehicle, the type (PDF, JPEG, PNG, WEBP, HEIC/HEIF) and size (≤ 10 MB), and at most 10 uploads an hour. The server fixes the item id and the path `drivers/<driver>/<item>/<uuid>.<ext>` (a database CHECK ties the path to the driver and item) and returns a one-use signed upload (never an overwrite). `submit` reads the stored object back: its real size and its real type from the first bytes (a renamed executable is refused and deleted). Only then is the item created, as `submitted`; nothing in the request can set a status, expiry or reviewer. Unsubmitted uploads lapse after 15 minutes and the runner removes the object, then the record.
- Viewing: the driver gets a 60-second signed link to their own current document; a reviewer a 120-second link to any, and each view is recorded (`evidence_viewed`). Storage paths and reviewer identities never leave the server. Drivers read their own status through `fetch_v2_my_verification()` (requirements, each kind's current status, version, dates, a rejection note) — not the raw tables, which are reviewer-only.
- What is stored from a document: nothing but the file, its type and size, and the expiry date the reviewer reads off it. No licence, policy or ID numbers, addresses or dates of birth; the driver cannot send free-text details.

**Review flow (`fetch-v2-admin`, `area: "drivers"`):** `queue` (awaiting review, pending applications with what is missing, lapsed drivers with live jobs), `driver_record` (every version, reviews, history, live jobs), `view_evidence`, `review {item_id, outcome: approve|reject|request_replacement, reason, expires_on}`, `decide {driver_id, decision: approve|reject|suspend|reinstate, reason}`, `set_requirement`, `delete_file`. Approve needs the document's date where the requirement has an expiry, and treats it as valid through the end of that day (UK time); reject, replacement, suspend and reinstate need a reason; nobody reviews or decides on themselves. Approving a driver is refused (`evidence_incomplete`, with the missing kinds) until every required kind is verified and current.

**Reviewer permission.** `fetch_v2_is_verification_reviewer(user)` decides who sees and decides evidence. Today it is the existing platform administrators; it is the single place to narrow this to a dedicated reviewer permission later, so not every future administrator has to see driving licences.

**`verification_ok_until`** is derived (`fetch_v2_verification_state`): for the driver's vehicle class, every active **required** kind must have a current verified item (with an expiry if the requirement needs one, and not past it). Then it is the earliest of those expiries, or `infinity` when none expire; otherwise null. It is null unless the account is approved, and null when the class requires nothing. Optional evidence never affects it. The stored column is kept in line by every action and the sweep, but the gates read the live value, so an expiry blocks new claims the moment it passes, even before the sweep runs.

**Claim gate.** `fetch_v2_driver_problem` (used by claim, run creation, eligibility and so by Step 5's accept, before any card hold): not approved → `driver_not_approved`; suspended → `driver_suspended`; no vehicle class → `driver_vehicle_missing`; required evidence lapsed → `driver_verification_expired`; missing or awaiting review → `driver_verification_incomplete`; then payouts. Capacity (size ≤ the driver's max) and Step 3's bulky photo rule still apply at claim.

**Vehicle.** `set_vehicle {vehicle_class, max_size_class, can_two_person_lift, vehicle_reg}` (a registration is required for motor vehicles; on foot and bicycle are small only). A material change — a different class, a different registration, or a larger size class — supersedes the driver's per-vehicle evidence (vehicle details and insurance), so new jobs are blocked until fresh evidence is approved; the driver is told (`replacement_required`). A smaller size class or a two-person-lift change takes effect at once. Jobs already accepted are not affected.

**Expiry during a job (product rule, as built)**
- **Collected (or undeliverable) job:** nothing is blocked. The driver keeps the details they need and finishes, or returns, the item through the normal lifecycle.
- **Claimed, not yet collected:** collection is refused (`driver_verification_expired`) — licence and insurance are material to taking the item. The job is **not** returned to the board automatically: it stays with the driver, and a `driver_verification` issue opens for a person (once per job). Resolution: the driver renews and a reviewer approves (collection then proceeds, subject to the payment gate), or an administrator returns the job to the board (the audited Step 3 / Step 5 action, which also voids the hold).
- **New jobs:** refused as soon as verification lapses.
- **Suspension** follows the same rule (no new jobs, no collection); jobs in progress are left for an administrator, and `decide` reports how many there are.

**Sweep (`fetch_v2_verification_sweep`, run by `fetch-v2-runner`; not scheduled).** It marks verified evidence past its date `expired`; records one `evidence_expiring` reminder per item inside 30 days (`verification_reminder_secs`); brings every stored `verification_ok_until` in line; and opens one `driver_verification` issue per live job of a driver who can no longer take new jobs. Then the edge removes lapsed uploads. It never changes a job. Repeat runs change nothing (tested).

**Audit and reminders.** `driver_verification_events` is append-only (nothing edits or deletes it, the service role included; account deletion cascades). It records application submitted, resubmitted and updated; vehicle changed; evidence submitted, replaced, approved, rejected, replacement requested, expiring, expired, viewed and file deleted; verification valid and lapsed; driver approved, rejected, suspended and reinstated; and requirement changes. Each carries the actor, their role, a reason and a safe detail (kind, version, dates, from/to) — never document content or paths. Events the driver should hear about carry `notify_kind` (`evidence_expiring`, `evidence_expired`, `evidence_rejected`, `replacement_required`, `driver_approved`, `driver_rejected`, `driver_suspended`, `driver_reinstated`). That is the outbox Step 8 drains through the existing push/notification architecture (stamping `notified_at`, the only permitted update). Nothing is sent now.

**Retention (decision still outstanding, S.18).** No period is set and nothing is deleted automatically. The architecture supports what the decision will need. `delete_file {item_id, reason}` removes the object from storage first, then records who deleted it, when and why. The item, its review, its approval and the history stay, and a reviewed document stays reviewed. Files go one at a time without touching the rest of the driver's history.

**18+.** Applying, uploading and every driver action keep Step 4's 18+ confirmation and restriction checks. Verification is an additional control. No age-assurance mechanism was added; Build 148 and its store metadata are unchanged.

**Concerns carried forward**
- After deploy, the existing admin approval screens (web and Build 148) fail with an error until Step 10 ships the new review screens; drivers cannot be approved in the meantime except through `fetch-v2-admin`.
- The production-linked `column-locks` test (case 7, "admin may set driver_status from a client session") will fail once this is deployed; update it in the same change.
- `fetch_v2_board()` and `notify-drivers` still admit any `approved` driver regardless of verification. The board is redacted (no addresses), but Step 7 must switch both to the claim gate.
- The signed upload URL necessarily contains the driver's own object path.
- Step 5's `can_collect` reflects only the payment hold; a lapsed driver can be told "can collect" and then refused. The UI (Steps 11–12) should read `fetch_v2_my_verification` too.
- The insurance and courier requirements are placeholders until the broker/legal advice (S.19); `fetch_v2_set_requirement` applies it without a code change.

**Step 7 scope (exact): matching**
1. `fetch_v2_board()`: admit only drivers with no `fetch_v2_driver_problem` (approved, verified, not suspended, payouts on), instead of any `approved` driver.
2. Board filters and order (section I): items ≤ the driver's `max_size_class` by default, with an explicit "show all" (still claim-gated); sort by fits one of my open runs, then earliest deadline, then newest. "Fits" is computed in SQL as in section I, ferry-aware through island groups.
3. A per-request `fits_my_run` hint. The requester sees only "A driver is heading that way" — no driver identity.
4. Matching for notifications as a SQL function: drivers whose open run fits; else verified drivers whose `areas` include either region **and** whose capacity fits; else all verified drivers; at most once per request (a recorded fan-out). It respects `fetch_enabled` and quiet hours, and returns ids only.
5. `notify-drivers`: internal-only (service or cron), calling that function; client callers removed. Sends happen in Step 8, so Step 7 stops at the recipient list.
6. Isolated tests: board admission (lapsed, suspended and incomplete drivers refused), capacity filter, ferry fits, ordering, the recipient tiers, once-per-request, and rollback.
7. Not in Step 7: notification sending and templates (Step 8), corridors, capacity counting and recurrence (P1), UI.

**Step 7 status (25 Oct 2026): DONE, local only. Not applied, not deployed. Nothing sends.**

**Files.**
- Migration `20261204000000_fetch_v2_matching.sql` and rollback `supabase/rollbacks/20261204000000_fetch_v2_matching.down.sql`. The rollback refuses while any recipient record exists; otherwise it restores the catalogue exactly (proved, then re-applied).
- Suite `supabase/tests/fetch-v2-matching.node.test.ts`: 32 isolated tests, using real island geography and the real create, run, claim and release functions.
- `_shared/fetch-v2-payments.ts` gains one status code (`two_person_lift_required`).

**One eligibility rule, one capacity rule.**
- `fetch_v2_driver_eligibility_problem(driver)` means: Fetch v2 is on for them, they are 18+, not restricted, approved, verified, not suspended, and payouts are on. It is built from the same pieces as the claim gate.
- `fetch_v2_capacity_problem(driver, size, flags)` checks the size class against the driver's maximum, and a `heavy_two_person` item against `can_two_person_lift`.
- Both rules are used by the board, public journeys, the requester hint, recipient selection and the diagnostics. The claim now uses the capacity rule too; the two-person check is new there.
- Board, matching and notification eligibility therefore cannot drift apart.

**Run fit (`fetch_v2_run_fit(run, request)` → `run_match` or the first reason it fails).** A run fits only when every check below passes, in this order:

| Check | Fails as |
|---|---|
| The run is open and not finished | `run_closed` |
| The pickup and destination islands are both on the run's island route | `off_route` |
| ...and in the run's direction | `wrong_direction` |
| The pickup region is the run's origin, **or** the destination region is the run's destination (section I) | `region_mismatch` |
| The run sets off before the request's deadline | `timing_mismatch` |
| The category is accepted (an empty list accepts all) | `category_mismatch` |
| The item fits the run's size limit and the driver's vehicle | `capacity_mismatch` |

The run's best fit for a driver is their earliest-departing matching run.

**Islands and ferries.**
- Routes come from a fixed tree of the ferry links, not from distance:
  - Mainland – Yell;
  - Yell – Unst and Yell – Fetlar;
  - Mainland – Bressay, Whalsay, Out Skerries, Papa Stour, Foula, Fair Isle.
- `fetch_v2_island_route(from, to)` lists the islands a journey passes through, in order. For example, Lerwick → Unst is Mainland, Yell, Unst.
- So a Lerwick → Unst journey carries Mainland → Yell jobs. A Lerwick → Yell journey never reaches Unst. Yell → Lerwick is the reverse journey and does not fit a Lerwick → Yell run.
- A Mainland-only journey never fits Whalsay or Bressay, however close they are across the water.
- The £2 ferry supplement stays a pricing rule. It is not a matching score.
- There is no explicit return-journey field, so a run is one-way. A driver going both ways posts two runs.

**Timing.**
- Every open request is claimable until `expires_at`: 24 hours for as-soon-as-possible, the deadline for "by", and the end of the window for "flexible". A run fits if it sets off before that.
- Flexible requests (up to 7 days) therefore match more easily, by construction.
- There is no minute-level route planning.

**The board: `fetch_v2_board(p_show_all default false)`.**
- **Admission.** Only drivers with no eligibility problem get the board. Anyone else gets a 42501 error that names the claim gate's own reason. The old `fetch_v2_board()` admitted any `approved` driver; it is replaced.
- **Jobs shown.** Only open jobs: v2, `pending`, unassigned, not expired, and not the driver's own.
- **Tiers.** Each job is placed in one tier:
  1. `your_run`: fits one of the driver's runs and their vehicle.
  2. `your_area`: the pickup or destination is in the driver's `areas`, and it fits their vehicle.
  3. `other`: fits their vehicle.
  4. `beyond_vehicle`: does not fit their vehicle. Shown only with `show_all`, with `can_claim` false, and the claim refuses it anyway.
- **Order.** Tier, then deadline (`expires_at`), then newest, then id. It is deterministic.
- **Default view.** Demand is never hidden: the default view shows tiers 1–3. `show_all` adds tier 4. This is how the brief's "show all" is interpreted: it widens capacity, not area.
- **What each row says.** `match` (category), `match_reasons` (codes) and `match_summary` (plain English), plus `fits_run_id` (the driver's own run) and `can_claim`. No scores. For example: "Fits your Lerwick → Yell journey · Fits your vehicle · Flexible timing".
- **Reason codes.**
  - `fits_your_run`, `in_your_area`;
  - `fits_your_vehicle`, `too_large_for_vehicle`, `two_person_lift_required`;
  - `flexible_timing`, `needed_today`, `needed_by_date`, `as_soon_as_possible`.
- **Privacy.** The Step 2 matching-safe fields only: no addresses, phone, pickup name, notes, coordinates or requester identity (tested).

**Requester hint: `fetch_v2_heading_that_way(request)`.**
- Only the requester can call it, and only for an open job.
- It is true when some *eligible* driver (not the requester) has an open run that fits. It returns only the day and the sentence "A Fetch driver may be heading that way today / tomorrow / on Saturday. This isn't a booking: a driver still needs to accept your request."
- It never returns a driver, run, vehicle, registration or time.
- It is computed on every read, so it disappears as soon as the run is cancelled or expires, or the driver lapses. It reserves nothing.

**Public journeys (`fetch_public_runs`, Step 2).**
- Now only from drivers who can take jobs; an expired or suspended driver's journeys vanish.
- Ordered by date, part of day, origin, destination and opaque key, instead of by exact departure time. The old order let a reader infer relative times within a part of day.
- Fields are unchanged: regions, islands, date, part of day, size, categories, crosses water, and an opaque `run_key`.
- Residual (accepted for P0): in a very small community, a recurring route on a given day may itself be recognisable. The list shows no more precision than a part of day.

**Notification recipients: `fetch_v2_select_recipients(request, kind)`. Service-only; selects, never sends.**
- **Candidates** must be eligible, able to carry the item, not the requester, and the job must be open. For `back_on_board`, any driver who previously claimed the job is also excluded.
- **Tiers:**
  - `run`: an open run fits.
  - `area`: the driver's `areas` include either end.
  - `broad`: used only when nobody is in `run` or `area`. At most `fetch.matching.broad_max` (default 15) other eligible drivers, in a fixed order (driver id).
- **At most once.** Each choice is a row in `fetch_match_notifications`, unique on (request, driver, kind). The function returns only the drivers newly chosen by this call, so a rerun, retry or runner rerun chooses nobody twice. A later new run can add a newly fitting driver.
- **Kinds.** `new_request` and `back_on_board` are separate notices.
- **Sending.** `notified_at` is for Step 8 to stamp after sending.

**Admin diagnostics: `fetch_v2_match_diagnostics(request, driver)`.** Admin-only. It answers "why did this driver see or hear about this request, or not?" with codes:
- `job_open` / `job_not_open`;
- the driver's eligibility code;
- capacity;
- `in_area`;
- `board_match`;
- each of the driver's runs (route, day, `run_fit` result);
- any selection records.

It never includes addresses, phone or the requester.

**Performance.**
- `delivery_requests_v2_board_idx` (deadline and age of open v2 jobs);
- `runs_open_driver_idx` and `runs_open_departure_idx` (open runs);
- the recipient table's unique key, plus `(driver_id, selected_at)` and an unsent-rows index.
- The board evaluates each open job against the caller's own runs (a few jobs × at most 10 runs).
- Recipient selection evaluates approved drivers against one job.
- This is fine at Shetland scale. There is no search infrastructure; a GIN index on `areas` is not needed yet.

**Not in P0:** route corridors, optimisation, recurring runs, multi-stop loads, capacity consumption across jobs, AI matching, automatic assignment. Matching informs; drivers choose.

**Scope change against the earlier Step 7 line: `notify-drivers` is untouched.** Making it internal-only means rewriting the function that sends pushes, and sending is Step 8. The SQL recipient list it needs exists now. Until Step 8, the deployed `notify-drivers` still fans out to approved drivers for v1 requests only; v2 requests never reach it.

**Concerns carried forward**
- `fetch_v2_select_recipients` is not called by anything yet. Step 8 wires it to job creation and to "back on the board".
- The section I endpoint rule (either end must be the run's own) is permissive for detours, such as a Scalloway pickup on a Lerwick → Yell run. That is as approved; corridors are P1.
- A driver with no `areas` and no runs is reached only by the broad tier. Onboarding (Steps 11–12) should ask for areas.

**Step 8 scope (exact): notifications**
1. **Outbox.** A server-side outbox drains three sources:
   - `fetch_match_notifications` (`new_request` → `fetch.new_request` / `fetch.request_on_route` by tier; `back_on_board` → `fetch.released`);
   - `driver_verification_events` (`notify_kind` → `fetch.driver_verification` / `fetch.driver_decision`);
   - the lifecycle events in section L (driver matched, payment needed, payment ready, cancel requested / resolved, released, collected, delivered, undeliverable, returned, issue, message).

   Each is sent once and stamped (`notified_at` / an equivalent per-event record).
2. **Sending.** Through the existing Notification Centre (`sendUserPush` plus a `notification_log` inbox row, always written), honouring the `fetch_enabled` preference and quiet hours, with `urgent` for payment action needed, cancel requested and undeliverable.
3. **Calls.** `fetch_v2_select_recipients` is called at job creation (`fetch-v2-create`) and when a job returns to the board. The runner retries unsent items, repeat-safe.
4. **`notify-drivers`.** Made internal-only (service or cron), sending to the SQL recipient list. Client callers and the v1 fan-out are removed. `notify-collected`'s client path is removed.
5. **Content.** Deep links open the request (web and app routes per section L). Copy contains no addresses or phone numbers.
6. **Tests.** Isolated tests with a fake push sender and real `notification_log` rows:
   - once per event;
   - preferences and quiet hours;
   - urgent bypass;
   - no notice to ineligible or non-party users;
   - outbox rerun safety;
   - rollback.
7. **Not in Step 8:** UI (Steps 11–12), email (unless section L requires it), message threads and photos (Step 9).

**Step 8 status (25 Oct 2026): DONE, local only. Not applied, not deployed. Nothing was sent.**

**Files**
- Migration `20261205000000_fetch_v2_notifications.sql` and rollback `supabase/rollbacks/20261205000000_fetch_v2_notifications.down.sql`. The rollback refuses while the outbox holds anything; otherwise it restores the catalogue exactly. Inbox rows already written stay.
- `_shared/fetch-v2-notify.ts` (the drain), `_shared/fetch-v2-push-gateway.ts` (production Expo gateway).
- `fetch-v2-runner` drains the outbox after its sweeps.
- `notify-drivers` and `notify-collected` now refuse Fetch v2 jobs. Both are deployed functions, so the manifest lists them as `modified`.
- Tests:
  - `supabase/tests/fetch-v2-notifications.node.test.ts`: 26 isolated tests, using the real `notification_log`, real Step 3–7 functions and a fake push gateway.
  - `_shared/fetch-v2-push-gateway.node.test.ts`: 5 tests with a fake `fetch`, in the offline lane.

**Architecture: one outbox, fed only by the server**
- **The outbox.** `fetch_notifications` holds one row per logical notice, unique on `dedupe_key`.
- **Producers.** Rows are written only by AFTER INSERT triggers on the authoritative append-only tables:

  | Table | Produces |
  |---|---|
  | `fetch_match_notifications` | Step 7 selection; matching now runs automatically on `created` and whenever a job returns to the board |
  | `fetch_request_events` | job lifecycle |
  | `driver_verification_events` | Step 6 `notify_kind` events, each accepted document, and a daily admin review nudge |
  | `fetch_issues` | issue opened / resolved |

  A producer failure is logged and swallowed, so a notice can never undo a Fetch action (tested).
- **Content.** Kind, audience, urgency, category, wording and link all come from the server (`fetch_v2_notice_meta`, `fetch_v2_notice_copy`, `fetch_v2_notice_route`).
- **No client entry point.** No client can create, claim, settle or read outbox rows, or write an inbox row (tested).

**Notification Centre first** (`fetch_v2_claim_notifications`, inside the database)
1. **Opportunities that no longer stand are dropped.** A pending opportunity whose job is no longer open, or whose driver can no longer take jobs, is closed as `job_closed`, with no inbox row.
2. **The inbox row is written before any push.** This is `public.notification_log`, the existing Notification Centre inbox. The clients (including iOS Build 148) show statuses `sent`, `no_token` and `skipped_quiet`:

   | Situation | Inbox status | `error` |
   |---|---|---|
   | Push allowed | `no_token` (visible while pending) | `push_pending` |
   | Quiet hours | `skipped_quiet` (visible) | — |
   | Member muted Fetch or all notifications: an **opportunity** | `skipped_pref` (hidden: their choice, as for every module) | — |
   | Member muted Fetch or all notifications: an **activity / verification / admin** notice | `no_token` (visible) | `push_off` |
   | Opportunity push cap reached | `no_token` (visible) | `opportunity_limit` |

3. **Then pushes are leased.** Pushes that are due are leased (re-offered after 5 minutes if a worker dies).
4. **`fetch_v2_settle_notification` records the result.** `accepted` turns the inbox row into `sent`. Anything else leaves it visible as `no_token`, with the reason in `error`. The inbox row is never removed. Producers are stamped (`fetch_match_notifications.notified_at`, `driver_verification_events.notified_at`).

**Delivery results** (`push_result`):
- `accepted`: Expo accepted the push ticket. This is never reported as "delivered".
- `no_token`, `opted_out`, `quiet_hours`, `rate_limited`, `job_closed`.
- `invalid_token`: every device unregistered; the tokens are pruned.
- `push_unavailable`: push isn't configured for the device, e.g. Android without push credentials.
- `provider_error`.

A retryable failure (network, 5xx, 429, MessageRateExceeded) is retried with back-off (5 · attempts² minutes), up to `fetch.notify.max_push_attempts` (4) attempts in all, then `provider_error`. One member's failure never stops another's.

**Push gateway.** It uses the same Expo API, token sources (`push_tokens`, then legacy `profiles.push_token`) and pruning as `_shared/send-push.ts`. `send-push.ts` is left untouched because about 40 deployed functions bundle it, and its `sendUserPush` writes its own log row after pushing, which would break the inbox-first rule.

**Opportunity vs active-job notices**
- **Opportunities** (`new_request_run`, `new_request_area`, `new_request_broad`, `back_on_board`):
  - only Step 7's chosen drivers, each told at most once per job and kind;
  - never time-critical;
  - respect the Fetch switch, the master switch and quiet hours;
  - push-capped per driver at `fetch.notify.opportunity_hourly_max` (3) and `opportunity_daily_max` (8); beyond that they still reach the inbox;
  - dropped if the job closes first.
- **Activity, verification and admin notices** are never capped and are always kept in the inbox.

**Time-critical** (passes quiet hours, never a member's opt-out). Exactly four:
- `payment_action_needed` (the 2-hour timeout);
- `cancel_requested` (the driver must answer);
- `undeliverable`;
- `verification_blocks_collection` (an uncollected job that the driver's lapsed verification blocks).

Nothing else, and never an opportunity (a CHECK constraint enforces this).

**Preferences.** The existing single `fetch_enabled` switch plus the master `enabled` and quiet hours, through `should_notify`. The P0 split between opportunities and activity is enforced by policy (muted opportunities are hidden opt-outs; activity always reaches the inbox). Separate "Fetch opportunities" and "Fetch activity" toggles are a later settings change. They would need a new preference column and client settings UI.

**Event kinds** (event → recipient):

| Event | Recipient | Kind |
|---|---|---|
| `claimed` | requester | `driver_accepted` |
| `payment_requires_action` / `requires_payment_method` | requester | `payment_action_needed`, once per hold generation |
| `payment_authorised` | driver | `payment_ready`, **only** after the requester had to act and only when `fetch_v2_hold_ready` is true; an instant authorisation is not announced |
| `payment_timeout` | requester; released driver | `payment_not_completed`; `job_released_payment` (plus `back_on_board` matching) |
| `released` | requester | `driver_released` (plus matching; never to the driver who let it go) |
| `returned_to_board` | requester; driver | `returned_to_board_requester` / `_driver` |
| `cancellation_requested` | driver | `cancel_requested` |
| `cancellation_agreed` / `cancellation_declined` | requester | |
| `cancellation_resolved` / `admin_cancelled` | both | `job_cancelled` or `cancellation_kept` |
| `cancellation_escalated` | admins | `admin_cancel_review` |
| `expired` | requester | |
| `collected` / `delivered` | requester | |
| `undeliverable` | requester; admins | `undeliverable`; `admin_undeliverable` |
| `return_resolved` | both | |
| `payment_escalated` | admins | `admin_payment` |
| issue opened | admins | `admin_issue`; plus the driver's `verification_blocks_collection` for a verification issue on a matched job |
| issue resolved | reporter | `issue_resolved` |
| verification events | driver | `evidence_approved`, `evidence_rejected`, `replacement_required`, `evidence_expiring` (once per document), `evidence_expired` (once per document), `driver_approved` / `_rejected` / `_suspended` / `_reinstated` |
| application or evidence received | admins | `admin_review`, at most once per driver per day |

`message` is reserved (contract only) for Step 9.

**Privacy.** Wording uses only region names, a weekday, a size word and the destination region. It never includes:
- addresses, the pickup name, phone, notes or access instructions;
- the item description;
- payment, provider or card detail;
- anything from a verification document.

Data is `{screen:'fetch', route, kind, request_id?}` and nothing else (tested).

**Deep-link contract** (Steps 11–12 implement these routes; today's clients open the Fetch section from `screen`/`request_id`):

| Who | Route |
|---|---|
| Opportunity | `/fetch/board/<request>` |
| Requester | `/fetch/requests/<request>` (payment: `/fetch/requests/<request>/payment`) |
| Driver | `/fetch/jobs/<request>` |
| Verification | `/fetch/driver/verification` |
| Admin | `/admin/fetch/requests/<request>`, `/admin/fetch/drivers/<driver>` |

No private data and no query strings appear in links.

**Android / no push.** The inbox row is written regardless. A member with no device is `no_token`; an Expo `InvalidCredentials` answer (push not configured) is `push_unavailable`. Neither fails the event or blocks others.

**Legacy paths.** `notify-drivers` and `notify-collected` refuse any v2 request with `409 handled_by_fetch_v2`, for every caller, before authorising or sending. Their v1 behaviour is unchanged. This includes the shop's v1 Fetch-lane ping, which calls `notify-drivers` with the buyer's sign-in, so I did not make it service-only.

**Diagnostics.** `fetch_v2_notification_diagnostics(request?, recipient?)` (admin) lists each notice with kind, audience, urgency, state, inbox status, push result (`pending` while leased), attempts, last error and timestamps.

**Dedupe identities:**

| Notice | Key |
|---|---|
| Match | `match:<kind>:<request>:<driver>` |
| Lifecycle | `ev:<event id>:<r\|d\|admin id>` |
| Payment prompt / ready | `pay:<request>:g<generation>:action\|ready` |
| Verification | `verif:<event id>`; expiring and expired: `verif:<kind>:<item>` |
| Admin review | `admin_review:<driver>:<UK date>:<admin>` |
| Issues | `issue:<id>:open:<admin>`, `issue:<id>:driver`, `issue:<id>:resolved` |

**Concerns carried forward**
- **Latency.** Notices go out when `fetch-v2-runner` drains, so it should be scheduled about every minute when deployed. Until then nothing is pushed, though the inbox rows are still written on drain.
- **Muted members.** A member who muted Fetch still gets activity notices in their inbox, with no push. This is by design (it is their own job) but differs from other modules.
- **Shop Fetch lane.** It creates v1 requests that v2 drivers cannot see once Step 2 is deployed. Business requests are P2; that lane should be switched off or migrated before the v2 deploy.
- **Generic Notification Centre gap (not Fetch-specific).** `sendUserPush` logs provider errors as `error`, which every client hides. Other modules can lose a notice on a provider error. Fetch avoids this; fixing it for everyone needs a client change.
- **Single preference switch.** There is only one Fetch toggle; the opportunity/activity split needs a settings change.

**Step 9 scope (exact): messages, issues, photos**
1. **Messages**
   - `fetch_v2_send_message(request, body)`: parties only, while the job is live and for the participant window. Body ≤ 1000 characters; rate-limited; no links to phone numbers enforced in the UI.
   - Party read RPC.
   - Admin hide (`hidden_at`/`hidden_by`, audited).
   - A `safety` issue route to admin.
   - The `message` notice: collapsed to one unread notice per request and recipient, with no message text in the push.
2. **Issues.** A client `fetch_v2_report_issue(request, kind, detail)` for parties within the issue window, plus an admin resolve action. Both feed the Step 8 outbox, which already handles opened and resolved issues.
3. **Photos**
   - Signed uploads to the private `fetch-photos` bucket, at server-generated paths, with real-type checks (as Step 6).
   - Item photos from the requester, with `matching_visible` (bulky jobs need one before claim).
   - Delivery and return photos from the driver, write-once.
   - `fetch_v2_delivery_precheck`'s `delivery_photo_required` honoured.
   - Party and admin read through short-lived links; admin removal is audited.
   - Evidence is held while an issue is open (`fetch_v2_evidence_held`).
4. **Tests.** Isolated tests: party-only access, write-once, windows, hide and remove audit, notice collapsing, storage access matrix, rollback.
5. **Not in Step 9:** UI (Steps 11–12), retention deletion (S.18), the admin console (Step 10).

**Step 9 status (25 Oct 2026): DONE, local only. Not applied, not deployed. Nothing was sent.**

**Files**
- Migration `20261206000000_fetch_v2_messages_issues_photos.sql` and rollback `supabase/rollbacks/20261206000000_fetch_v2_messages_issues_photos.down.sql`. The rollback refuses while any Step 9 record exists; otherwise it restores the catalogue exactly (functions, table and storage policies) and re-applies (proved).
- `_shared/fetch-v2-photos.ts` (photo and support handlers), `_shared/fetch-v2-photo-deps.ts` (Deno wiring), `_shared/image-metadata.ts` (metadata removal).
- New edge function `fetch-v2-photos` (staged). `fetch-v2-admin` gains `area: "support"`; `fetch-v2-runner` removes abandoned photo uploads.
- Tests:
  - `supabase/tests/fetch-v2-messages-issues-photos.node.test.ts`: 27 isolated tests (real SQL, real Step 8 outbox, real storage RLS).
  - `_shared/image-metadata.node.test.ts`: 4 tests, in the offline lane.

**Access model.** Direct table reads of `fetch_messages`, `fetch_issues` and `fetch_request_photos` are now administrator-only (the Step 2 pattern). Participants use the functions below, which apply the windows.
- `fetch_v2_participant_role(request, user)` gives the requester or the *current* assigned driver, while the job is live and for `participant_history_secs` (30 days) after it closes. Administrators always.
- A released driver is no longer a participant. A driver who has not accepted never is.
- Exact addresses (72h) and phone (live and shared only) are unchanged; a message or photo outlasting them exposes neither (tested).

**Messages**
- **Sending.** `fetch_v2_send_message(request, body, client_ref?)`, client RPC:
  - only the requester and the assigned driver, once a driver exists (`no_driver_yet`), within the window (`message_window_closed`);
  - plain text, trimmed of whitespace, 1–1000 characters (`message_empty` / `message_too_long`), stored exactly as sent (markup is text);
  - a retry with the same `client_ref` returns the original message;
  - at most 20 per job in 10 minutes and 200 a day per sender (`rate_limited`).
- **Reading.** `fetch_v2_messages(request)`: oldest first, with `from` = you / requester / driver. A hidden message shows only `hidden: true`. Administrators see the text, who hid it, when and why.
- **Never edited or deleted.** Clients have no write access, and Step 1's trigger refuses any rewrite, including by the service role.
- **Hiding.** An administrator hides with `fetch_v2_hide_message(admin, message, reason)`, reason required. The record stays; participants lose the text.
- **Audit.** `message_sent` and `message_hidden` events carry the message id only.
- **Notice.** "New message about your Fetch" (Step 8 kind `message`) goes to the other party. At most one stands per job and recipient until its inbox row is read. The text is never in the notice.

**Issues**
- **Reporting.** `fetch_v2_report_issue(request, kind, detail, client_ref?)`, client RPC:
  - only the requester or the assigned driver, while the job is live or within `issue_window_secs` (72 hours) of it closing (`issue_window_closed`);
  - kinds: `not_delivered`, `damaged`, `wrong_item`, `payment`, `safety`, `other`, plus `driver_conduct` (requester only) or `requester_conduct` (driver only). `cancellation`, `return`, `driver_verification` remain system kinds;
  - detail is at most 2000 characters;
  - a retry with the same `client_ref` is the same issue;
  - at most 3 open issues per job per reporter and 10 a day (`rate_limited`).
- **Following up.** `fetch_v2_my_issues(request)` shows the reporter their issues and the recorded outcome.
- **Immutable.** The reporter cannot change kind, detail or time (no grants, plus Step 1's trigger). A resolved issue stays resolved.
- **Resolving.** `fetch_v2_resolve_issue(admin, issue, resolution)`, resolution required, records who and when.
- **Notices** (existing Step 8 producers): administrators on open, and the reporter on resolution. Neither the detail nor the kind wording is in any notice.

**Photos and evidence**

| Role | Who | When |
|---|---|---|
| `item` | requester | job open and unclaimed; at most 6 |
| `collection` | assigned driver | matched or collected; at most 4 |
| `delivery` | assigned driver | collected (or a delivery retry from undeliverable); at most 4 |
| `return` | assigned driver | undeliverable; at most 4 |
| `issue` | the issue's reporter | while the issue is open; at most 5 |

`fetch_v2_photo_problem` is the one rule, checked when the upload starts and again when it is registered (with the job row locked).

**Upload security** (`fetch-v2-photos`, `begin_upload` → signed one-use upload → `submit`)
- The server fixes request, kind, uploader and path (`requests/<request>/<kind>/<uuid>.<ext>`; a CHECK ties path to request and kind). The signed upload never overwrites, and lapses after 15 minutes.
- JPEG, PNG and WEBP only. HEIC is refused; the clients convert. Size ≤ 10 MB.
- On submit, the edge reads the object back: the real size, and the real type from the first bytes. A renamed executable is refused, deleted and forgotten.
- Embedded metadata is then stripped and the clean bytes written back before the photo is registered (`image-metadata.ts`):
  - JPEG: EXIF/XMP including GPS, IPTC, comments and maker data are removed; orientation is kept;
  - PNG: text and EXIF chunks;
  - WEBP: EXIF and XMP.
- Registering twice returns the same photo. At most 20 upload starts an hour per member, plus the `fetch_v2_photos` limiter (60/hour).
- Abandoned uploads are removed by the runner (object first, then the record).

**Board photos.** Only `item` photos the requester marked (`show_on_board` at upload, or `fetch_v2_set_item_photo(show_on_board | hide_from_board | withdraw)` before the job is claimed) appear in Step 7's `matching_photo_ids`.
- They are viewable only with `view_board`, by a driver who can take jobs, while the job is open and not their own.
- Collection, delivery, return and issue evidence never reach the board.
- Withdrawing keeps the record (`removed_*`, "Withdrawn by the requester").

**Viewing.** There are no client storage policies on `fetch-photos` any more: nobody, administrators included, reads, lists or deletes the bucket directly.
- Links come only from `fetch_v2_photo_for_view`:
  - `party`: participants within the window, not removed;
  - `board`: as above;
  - `admin`: always, including removed photos and after the windows.
- Lifetimes: 60 seconds for members, 120 for administrators. Storage paths never appear in responses.
- A Supabase signed link necessarily embeds the object path in its URL; that path holds only the job id the participant already knows.

**Evidence rules** (`fetch_v2_has_evidence`):
- **Safe-place delivery** (`fetch_v2_delivery_precheck`, `fetch_v2_complete_delivery`) needs a `delivery` photo from the assigned driver, taken after collection, and not removed.
- **Reporting a return** (`fetch_v2_report_return`) needs a `return` photo from the assigned driver, taken after the job became undeliverable.
- An old photo, a requester's photo or a removed photo does not count (tested).

**Evidence is write-once.** Step 1's trigger refuses any rewrite of a photo record, and clients have no write access.
- Administrators remove from view with `fetch_v2_remove_photo(admin, photo, reason)`, reason required. Who, when and why are recorded and the stored object stays.
- Physical deletion is the outstanding retention decision (S.18).

**Retention and evidence hold.** Participants lose messages, photos and issue views at their window; administrators keep everything.
- `fetch_v2_evidence_held(request)` (an open issue) is shown in the admin views. It is the signal any future purge must honour. No purge exists and none is added.

**Administrator support** (`fetch-v2-admin`, `area: "support"`):
- `record`: every message (hidden included), issue and photo record of a job, ids only, no paths;
- `hide_message`, `resolve_issue`, `remove_photo` (reasons required);
- `view_photo` (120-second link, with removed and evidence-held flags).

**Audit.** Every material action is a `fetch_request_events` row carrying ids and safe metadata only:
- `message_sent`, `message_hidden`;
- `issue_reported`, `issue_resolved`;
- `photo_added`, `photo_visibility_changed`, `photo_withdrawn`, `photo_removed`.

It never contains message text, issue detail, paths or image data.

**Concerns carried forward**
- Hiding a message keeps its text for administrators by design (disputes). The retention period for that text is part of S.18.
- `tg_fetch_v2_notice_from_message` collapses notices by the inbox row's `read_at`. A member who never opens the inbox gets one message notice per job until they read it.
- HEIC is refused for Fetch photos; the Steps 11–12 clients must convert to JPEG before upload.
- Metadata stripping keeps the image bytes, so a photo can still show a house number. The requester warning (section J) and admin removal remain the controls.

**Step 10 scope (exact): admin controls**
1. **Admin console** on the web `fetch-v2` branch (admin-gated routes under `/admin/fetch`), calling only the `fetch-v2-admin` edge areas (payments, `drivers`, `support`) and the admin RPCs. There are no direct table writes anywhere. The old `components/admin/DriverApprovals.tsx` (direct `driver_status` write, refused since Step 6) is replaced.
2. **Queues:**
   - driver verification (Step 6 `queue`);
   - open issues by kind and age, payment issues, unanswered cancellation requests, undeliverable jobs awaiting a return decision;
   - lapsed drivers with live jobs, and stuck notifications (Step 8 diagnostics).
3. **Job page:**
   - timeline (`fetch_request_events`), support record (messages, issues, photos with 120-second links);
   - payment state and actions (Step 5), match diagnostics (Step 7), notification diagnostics (Step 8);
   - the cancel / return-to-board / resolve-cancellation / resolve-return actions.
4. **Driver page:** verification record, decisions (approve / reject / suspend / reinstate), requirements editor.
5. **New audited admin RPCs:**
   - redact or edit a job's `item_description` (Step 2 carry-over), with reason and event;
   - restrict or unrestrict a member (`fetch_member_stats.restricted_at`/`restricted_reason`), with reason and event;
   - a read-only counters view (`fetch_member_stats`, driver release and fault-return counts).
6. **Tests:** isolated SQL tests for the new RPCs (admin-only, reasons, events, rollback), and web render/contract tests for the console. No production calls.
7. **Not in Step 10:** requester and driver UI (Steps 11–12), live payment gate (Step 14).

**Changes from revision 1 caused by the decisions:**

- Step 0 is split: 0a is *prepared, not deployed*.
- New Step 4 for pricing and ferry, depending on Darren's ferry amounts.
- New Step 6 for driver verification (moved from P1).
- Every backend deploy is gated on Build 148's clearance.
- Enabling also depends on the external insurance/legal confirmation.
- The data model grows: bulky item fields, return and fault columns, the cancel-request flag, verification tables, ferry paths and island groups.

---

## Q. Acceptance criteria: "Fetch works"

Demonstrated on real devices (iPhone, Android and web) by testers under the `testers` flag, with evidence recorded in the Launch Test Centre:

1. A member creates small, medium and bulky requests (bulky with photo, dimensions and handling) on each platform. The price equals the server quote and is shown in full before submit.
2. An approved, verified driver with payouts enabled sees requests on the board without any address or phone, filtered by vehicle capacity, with "fits your run" where appropriate.
3. Two drivers accepting at once: exactly one succeeds. Accept without the vehicle-suitability confirmation is refused.
4. On accept, the card is held (Stripe `requires_capture`) for the disclosed maximum. The driver now sees the addresses; the requester is notified.
5. 3DS: the requester completes it and the driver is told to go ahead. Left unfinished, the request returns to the board after the window.
6. Collected → delivered on the driver's device. The requester sees each step promptly (inbox on all platforms; push where available).
7. Capture = frozen terms + measured waiting. The driver's transfer = base + ferry supplement + waiting. OneShetland keeps the service fee.
8. **A Yell (ferry) delivery** shows the £2 ferry journey supplement in the quote before commit (e.g. £9.10 + £2.00 + £1.50 = £12.60). The driver receives it in full, and OneShetland's fee in Stripe is £1.50 only. An Unst job also shows £2, not £4. A bulky job under about 8.8 straight-line miles prices at the £8 minimum (a normal job under about 4.4 miles at £4).
9. **Cancel before accept** is immediate. **Cancel request after accept** notifies the driver, blocks collection, and is resolved by the driver or admin with the hold voided. Counters update. No cancel after collection.
10. **Undeliverable → return → admin resolution** with `not_driver` pays delivery + return mileage at 65p (no second service fee, no second ferry supplement) and is evented. With `driver` fault, the hold is voided. An admin override with a reason is recorded.
11. Driver verification:
    - An applicant uploads licence, insurance and vehicle evidence, and admin verifies each item and approves.
    - Unverified and expired drivers cannot accept.
    - No one but admin can open the documents, including through direct storage URLs.
12. **Live gate:** one real-card admin transaction (including a ferry case and a return resolution) is reconciled end to end, including a refund.
13. Messages work only between the parties. Report a problem reaches admin, and admin refunds.
14. A non-party member, a non-assigned driver and a signed-out visitor cannot obtain an address, phone, driver identity or verification document through the UI or the API (checked with direct PostgREST and storage calls).
15. Flag `off` hides Fetch on all clients **and** the server refuses every v2 action.
16. The isolated-PG suite passes. No production-touching suite was run.
17. **Before public driver onboarding:** broker (and, if needed, legal) advice has been obtained on the actual Fetch model and applied to `driver_verification_requirements`, and a document-retention period has been decided (S.18, S.19).

---

## R. Risks and remaining decisions

### R.1 Decisions still requiring Darren

**No P0 product decision blocks Step 0** (0a: prepare hiding the current Fetch; 0b: the server-side flag). Both are fully specified. Their deploy waits only for Build 148's clearance (S.1, S.17).

Pricing, bulky, returns, ferries and timeouts are decided (S.12–S.16). What remains is **not a blocker for building**, only for later gates:

| Item | Blocks | Owner |
|---|---|---|
| Insurance and legal requirement for drivers, from a UK commercial motor/courier broker and, if required, legal advice (S.19) | **Public driver onboarding** (Step 16). Not development: the evidence list is configurable | Darren (external) |
| Verification document retention period, a privacy/data-retention decision (S.18) | **Public driver onboarding.** Until then, no automatic deletion; admin can delete on request | Darren |
| Production timing of hiding the current public Fetch (S.17) | Deploy of Step 0a only. Not before Build 148 clears | Darren |
| Who the first `fetch-v2` testers are | Step 15 (acceptance) | Darren |
| **Payment-authorisation amount: product/UX review** (recorded 25 Oct; see R.2) | **Public launch** (Step 16). Not Step 0 or development | Darren |

These are implementation details I will settle and record in the PRs, not product decisions:
- config key names;
- the default number of "+24h" extends (proposed: 2);
- the copy wording for the "up to" disclosures.

### R.2 Review item: payment-authorisation amount (recorded, not solved)

The plan can hold substantially more than the visible delivery quote, to cover waiting time and a possible return journey. For example, Darren's £12.60 Yell job holds about £27.70: +£6 waiting, +£9.10 return.

Before Fetch launches publicly, review:
1. whether the full worst-case return amount needs to be authorised up front;
2. how the maximum authorisation is explained to the requester;
3. whether a staged or incremental authorisation model (e.g. hold the quote plus waiting, and authorise a return amount only when a return arises) would give a better experience.

This does not block Step 0 or any development step. Steps 4–5 implement the K.1 model as written, unless the review changes it first. The terms columns (K.2.9) already record the return headroom separately, so a staged model would be a change to the hold amount, not to the data model.

**Still open from the 30 Aug blueprint, not needed for P0:** where goods wait between legs, handover form, loss during handover, carrier-set prices (assumed no), person-to-person sending scope, ratings, Aberdeen. Revisit before P2.

### R.3 Risks

| Risk | Mitigation |
|---|---|
| Stripe and frozen-terms changes (ferry, return headroom, accept+hold, resolution capture) regress the Paygate rail | Additive term columns defaulting to today's behaviour; exact-delta deploys; mocked-Stripe tests with controls; live gate Q-12 |
| Return headroom roughly doubles the mileage part of the hold (e.g. £12.60 job → about £27.70 held), so there could be more card declines or confused requesters | Disclose "you'll pay £X; up to £Y only if waiting or a not-your-fault return occurs" before submit; nothing beyond the actual amount is captured; monitor declines in testing. If declines are a problem, the fallback is a smaller hold with admin-collected return fees, but that is a later product call, not P0 |
| Step 2 breaks remaining v1 paths before v2 clients exist | Deploy only after Build 148 clears, together with the 0a hide; no real users exist |
| Verification documents leak | Private bucket with admin-only read, tested through direct storage calls; retention decision (S.18) |
| Insurance requirement turns out stricter than drivers expect | Confirm before Step 16; P0 verification captures whatever evidence the answer requires |
| Mobile work started from the wrong base | M.4 / S.10 |
| Production-touching suites run by habit | N.2; suites ported in Step 13 |
| Low driver supply makes "works" look like "broken" | Honest expiry messaging; flexible default; recruit drivers first (`MARKETING_PLAN.md`: start with Lerwick and nearby routes) |
| Rural geocoding gaps | Postcode required on failure; never silently price at the minimum |
| Android push | Inbox-first notifications; FCM in P1 |
| Shop bridge drift | `fetch_enabled` stays false; rewired in P2 |
| Old installed builds after Step 2 | Already non-functional; the next release gates them; v1 calls get a clear "Fetch is being rebuilt" error |

---

## S. Darren's Fetch v2 product decisions (25 Oct 2026)

Recorded as given. Sections D–R above are updated to match.

**S.1 Build 148.**
- No Fetch backend change that could alter the behaviour of iOS Build 148 is deployed while it is in Apple App Review.
- Development continues in isolated worktrees and branches with local and test fixtures. No production Fetch backend change may affect Build 148 until Apple has cleared it.
- Build 148 remains untouched.
- **Applied in:** P (deploy rule and per-step column), H, G, M.4.

**S.2 Current public Fetch.**
- Fetch is not genuinely working, so it is not promoted as a functioning service.
- Prepare hiding and disabling the current public entry points, but do not deploy as part of this step; production timing is decided separately.
- The v2 flag must be server-authoritative, not merely hidden buttons.
- **Applied in:** P0-18, P0-19, N.1, Step 0a, R.1; see also S.17.

**S.3 Business users.**
- Business-created delivery requests are P2. P0 proves the member-to-member community marketplace, and business workflows must not complicate it.
- The architecture must not make future business support difficult.
- **Applied in:** C, D (P2), A.2. The request model keeps the sender as a profile reference, so a future `sender_business_id` is additive.

**S.4 Public run visibility.**
- Yes: available runs may be visible to signed-out visitors.
- Signed-out users cannot request, book, accept or interact.
- Exact private addresses and private contact details are never public, and unnecessary driver identity is not public.
- Public run information uses broad origin/destination areas. Interaction requires membership.
- **Applied in:** E, G.7 (`fetch_public_runs`), H, J, O-B.

**S.5 Bulky items and furniture.**
- In P0, as one of the clearest real Shetland use cases, but not a removals platform.
- Simple size model: small / medium / large / bulky. The requester provides a description, a photo, approximate dimensions and a weight/handling warning where relevant.
- The driver explicitly confirms their vehicle and capacity are suitable.
- Specialist removals, extremely heavy goods and multi-person jobs wait.
- **Applied in:** P0-1, P0-3, P0-5, G.1, G.4, I, J, O-A, Q-1/3.

**S.6 Requester cancellation after acceptance.**
- Before accept: cancel freely.
- After accept, before collection: the requester may *request* cancellation, which does not silently destroy the job. The driver is informed, and it can become admin-resolvable.
- No elaborate automatic late-cancellation charging in P0. Repeat or abusive cancellation is tracked so a fair fee can be introduced later if real usage shows the need.
- After collection: no normal cancellation; use cannot-deliver / return / problem.
- **Applied in:** P0-10, F (flag, not state), G.1, G.5, L, O-F, Q-9, P1.

**S.7 Returned items.**
- A driver should not lose all compensation after genuinely doing the collection work when delivery fails for reasons outside their control.
- P0 supports a return/problem state, an admin override, the recorded reason, and the distinction between driver fault and requester/recipient circumstances.
- Where the driver is not at fault, they are paid at least the agreed base work amount, and the model supports an additional return amount where return travel is material.
- No automatic reward for a return caused by the driver's own failure. Keep it understandable and auditable.
- **Applied in:** P0-12, F (`undeliverable`, `returned`), G.1, K.1, K.4, O-H, Q-10; amounts refined in S.14.

**S.8 Ferries.**
- P0 must be ferry-aware, because Fetch is for all of Shetland.
- No complicated fare engine and no SIC fare table in P0. Provide a simple, explicit supplement where a journey requires one.
- The requester sees the full price before agreeing, and the driver must not unexpectedly absorb ferry costs.
- Design for future route-aware ferry pricing.
- **Applied in:** P0-13, G.1, G.3, I, K.1, K.5, O-B, Q-8, P2. Pricing mechanism superseded by S.15 (flat £2 per job; no ferry path table).

**S.9 Driver vetting.**
- No self-declared approval. P0 includes admin approval with safely recorded verification of:
  - identity / OneShetland account;
  - a valid driving licence where using a motor vehicle;
  - vehicle details;
  - evidence that the motor insurance permits the actual Fetch activity.
- Do not state that ordinary private insurance is sufficient. Confirm the exact Scotland/UK requirement separately before launch.
- Documents are never public. Statuses: pending, approved, rejected, suspended/revoked.
- Drivers declare enough vehicle information (type, capacity) for sensible matching, without a fleet-management system.
- **Applied in:** P0-14, E, G.2, G.4, H, J, M.2, Step 6, Q-11/17; refined in S.18 and S.19.

**S.10 Mobile branching.**
- origin/main mobile code is materially behind Build 148.
- Mobile v2 is derived from the current post-Build-148 line / latest accepted app source, sharing the same backend contract.
- Not solved by merging unrelated `home-redesign` changes.
- **Applied in:** B.1, M.4, Step 12.

**S.11 Mileage rate.**
- Read the authoritative production configuration before pricing work. Do not change it.
- **Result: 65p/mile (K.0).**

### Final P0 decisions (25 Oct 2026, revision 3)

**S.12 Pricing.**
- Keep the production baseline for P0: 65p/mile, ×1.40 road factor, £4 normal minimum, £1.50 service fee on top.
- Do not change the production configuration.
- Correct the stale 95p mobile/web copy as part of v2, without changing Build 148.
- **Applied in:** K.0, K.1, P0-1, Step 11/12 copy fixes.

**S.13 Bulky items.**
- Remain P0. Same mileage pricing, with an **£8 minimum** for bulky jobs instead of £4.
- No further bulky supplements in P0.
- The requester gives a description, a photo, dimensions and handling information. The driver confirms vehicle suitability.
- **Applied in:** P0-1, K.0 (`bulky_min_fee_pence`), K.1, N.3, Q-8.

**S.14 Returns.**
- For a legitimate return where the driver is not at fault, the return mileage uses the same 65p/mile basis, computed transparently from the actual additional journey. There is no separate return rate.
- The £1.50 service fee is charged once per job, not again for the return.
- Admin keeps an override where fault or a dispute makes the automatic outcome inappropriate.
- **Applied in:** P0-12, G.1, K.1, K.4, O-H, N.3, Q-10.

**S.15 Ferries.**
- P0 isles: Bressay, Whalsay, Yell, Unst, Fetlar.
- The driver is already making the journey, so the requester does not reimburse the fare or the journey.
- A **flat £2 ferry journey supplement per Fetch job** applies when the job involves one or more crossings. It is not per crossing and not by route, and it does not reproduce SIC fares.
- It is shown before commit, included in the authorised total, paid 100% to the driver, separate from the £1.50 service fee, auditable, and never added after acceptance.
- No fare engine. The design keeps the option of route-aware pricing later.
- Darren's example: £9.10 + £2.00 + £1.50 = £12.60.
- *This later ferry message supersedes the earlier "ferry cost required" wording. Both are satisfied: the £2 is an explicit, disclosed, driver-paid component, not a fare reimbursement.*
- **Applied in:** P0-13, G.1, G.2, G.3, G.6, I, K.1, K.5, O-B, N.3, Q-8.

**S.16 Timeouts.** Initial defaults accepted:

| Timeout | Default | Config key (admin_config, with code fallback as in `commission-config.ts`) |
|---|---|---|
| Complete payment | 2h | `fetch.timeouts.payment_needed_secs` |
| Driver answers a cancellation request | 2h | `fetch.timeouts.cancel_request_secs` |
| Report a problem after completion | 72h | `fetch.timeouts.issue_window_secs` |
| Address access after a completed job | 30 days | `fetch.timeouts.address_access_secs` |

**Applied in:** F.2, J, N.3.

**S.17 Current Fetch visibility.**
- Prepare the hiding and feature-flag work now in the isolated Fetch workstream (Step 0a/0b).
- Do not deploy it while Build 148 is in Apple review. No production Fetch backend change may affect Build 148.
- **Applied in:** P (Steps 0a, 0b), N.1, R.1.

**S.18 Driver document retention.**
- No arbitrary period is chosen yet. A privacy/data-retention decision is required before public driver onboarding.
- Private verification documents must be **deletable separately** from the approval and audit record.
- **Applied in:** G.2 (`driver_verification_files` split from `driver_verification_items`, `file_deleted_*` columns), H, J, N.3, Step 16, Q-17, R.1.

**S.20 Fetch 18+ (25 Oct 2026).**
- Fetch v2 is for users aged 18 or over, both requesters and drivers.
- P0: an explicit 18+ confirmation in Fetch onboarding, recorded server-side as the authoritative eligibility signal.
- No date-of-birth database and no app-wide age assurance in this work. Driver verification adds a real-world layer later.
- Build 148 and its store metadata are unchanged.
- **Applied in:** Step 4 (`fetch_v2_confirm_adult`, `fetch_v2_member_problem`; create/claim/run creation/quote refuse without it).

**S.19 Insurance / legal.**
- A pre-production external verification item. Ordinary private motor insurance is **not** assumed sufficient.
- Before public driver onboarding, Darren will obtain advice from a UK commercial motor/courier insurance broker, and legal advice if required.
- Driver verification is architected so the required evidence can change without redesigning Fetch.
- **Applied in:** G.2 (`driver_verification_requirements`), J, P0-14, Step 16, Q-17, R.1.

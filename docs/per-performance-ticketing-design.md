# Per-performance OneShetland ticketing - design (end state)

Status: DESIGN ONLY. Nothing here is built, applied or deployed. Written 6 Nov 2026 on branch `events-phase2-backend` (from `events-occurrences-phase1`).

## 0. Why

Phase 1 ships a deliberate stop-gap: an event with 2+ live `event_occurrences` cannot have OneShetland ticket types, and `reserve_ticket_basket` raises `MULTI_PERFORMANCE`. That keeps a ticket from being sold for "the event" when the buyer needs a specific night. It is NOT the finished experience. Theatre runs, panto weeks, Up Helly Aa squads' multi-night shows and festival programmes are exactly the events people want to buy tickets for. The end state: a buyer chooses a night, buys seats for that night, the ticket is valid only that night, one night can be cancelled without touching the others.

Principles
- A ticket belongs to exactly one performance (occurrence) or, for legacy single-date events, to none (`occurrence_id IS NULL`).
- Old clients keep working: no new REQUIRED request field anywhere. The block stays for old clients (section 9).
- Money safety first: every change below keeps the existing order/refund/idempotency model (`client_request_id`, `refund_event_tickets_for_payment`, payment binding). A night's cancellation refunds only that night.
- Lock order is a hard rule (section 8). A mistake here is a production deadlock between a sale and a refund (found and fixed in Phase 1; see `docs/events-occurrences-phase1.md`, "Defect found and fixed in this comparison").

## 1. Schema

Existing (baseline): `event_ticket_types(id, event_id, name, price_pence, quantity_available, quantity_sold, per_order_max, sale_starts_at, sale_ends_at, is_active, ...)`, `event_ticket_orders(id, event_id, buyer_id, status, total_pence, ...)`, `event_tickets(id, order_id, event_id, ticket_type_id, holder_id, validation_token_hash, backup_code, status, checked_in_at, event_snapshot, ...)`.

Add (additive, all nullable / defaulted, so installed clients and old rows are unaffected):

1. `event_ticket_orders.occurrence_id uuid null references event_occurrences(id) on delete restrict`.
   One order = one performance (a basket for two nights is two orders; the web basket splits them; see section 4). Null = legacy single-date.
2. `event_tickets.occurrence_id uuid null references event_occurrences(id) on delete restrict`. Denormalised from the order so the scanner and the reminder query need no join. A CHECK/trigger keeps `ticket.occurrence_id = order.occurrence_id`.
3. Capacity model - RECOMMENDED: a join table
   `event_ticket_type_occurrences(ticket_type_id, occurrence_id, quantity_available int null, quantity_sold int not null default 0, is_active bool not null default true, primary key (ticket_type_id, occurrence_id))`.
   - Ticket TYPE stays the product (name, price, per-order max, sale window, attendee details). The row says "this type is on sale for this night with this stock".
   - Per-night stock differs naturally (a matinee in a small hall, a sold-out opening night); price per night is deliberately NOT per-night in V1 (one price per type; a different price = a second type).
   - Why not "per-occurrence quantity on the type": it cannot express different stock per night without a JSON blob and cannot be row-locked per night. Why not "one ticket type per night": it multiplies owner setup by the number of nights and breaks the existing dashboard.
   - Types with NO join rows keep today's meaning (event-level stock via `quantity_available`/`quantity_sold`) and only exist on single-date events. A type on a dated run MUST have join rows for the nights it is sold on; a night with no row is not on sale (fail-closed).
   - Dashboard default: when an owner creates a type on a run, the form offers "same stock for every night" and writes N join rows in one function call.
4. `events.tickets_sold` stays as the event-wide total (sum of nights) maintained by the existing counter function, so existing readers do not break. Per-night sold is `event_ticket_type_occurrences.quantity_sold`.
5. Constraints: join row's occurrence must belong to the type's event (trigger); `quantity_sold <= quantity_available` when not null (CHECK); an occurrence with sold tickets cannot be deleted (FK RESTRICT on tickets/orders) - cancel it instead.
6. Phase-1 guards are revised, not removed: the "second occurrence refused when an active ticket type/ticket/order exists" trigger and the "new ticket type refused on a run" trigger both become "refused unless the capability flag `events.per_performance_ticketing` is open AND the shape is valid (join rows present)". See section 9.

Feature flag: `admin_config` key `events.per_performance_ticketing` (absent = closed). Closed = Phase 1 behaviour exactly.

## 2. `reserve_ticket_basket` (SQL)

Signature stays `reserve_ticket_basket(uuid,uuid,jsonb,integer,integer,jsonb,text) returns jsonb` (old callers keep working). The occurrence travels inside the existing `p_snapshot jsonb` (`p_snapshot->>'occurrence_id'`) - no new parameter, no new overload (an overload would silently route old callers, and ACL/ownership have to be re-proved per overload).

Algorithm for a run (flag open):
1. Idempotent retry check by `client_request_id` first (unchanged; a retry is answered even if the night has since passed).
2. Read `occurrence_id`. Missing on a run -> `MULTI_PERFORMANCE` (old clients; unchanged message for them). Present on a non-run or a different event -> `OCCURRENCE_MISMATCH`.
3. Lock in the global order (section 8): ticket types `FOR UPDATE` (ordered by id), then the matching `event_ticket_type_occurrences` rows `FOR UPDATE` (ordered by type id), then the occurrence row `FOR KEY SHARE`, then the event row `FOR KEY SHARE`.
4. Refuse: occurrence cancelled (`OCCURRENCE_CANCELLED`), already started or ended (`OCCURRENCE_PAST`), sale window of the type closed, join row inactive/absent (`SOLD_OUT`-style "not on sale for this date"), stock short (`SOLD_OUT`).
5. Increment the join row's `quantity_sold` (not the type's); insert order and tickets with `occurrence_id`; the unchanged expiry/pending model applies.
New errors map to friendly sentences in `_shared/ticket-reserve-error.ts` (same file Phase 2 already added; a pure function, easy to test).

## 3. Edge Functions

- `create-event-ticket-intent`: accept optional `occurrence_id` in the body, validate it is a uuid, pass it in the snapshot; compute price/fees exactly as now (per type). The event snapshot stored on the ticket/order gains `occurrence_id`, `starts_at`, `ends_at`, `venue`, `locality` of THAT night (so a later edit to the event cannot rewrite what a buyer bought). Sale-window and per-order-max checks stay. Missing occurrence on a run: the existing friendly `MULTI_PERFORMANCE` sentence while the flag is closed, and a new "Please choose a date" 400 when the flag is open. Replay and saved-card/wallet branches unchanged.
- `confirm-event-tickets`: resolves by order id; no new input. Reads the night from the order for the receipt and the notification text (uses `order.occurrence_id` -> occurrence `starts_at`, falling back to `events.starts_at` when null).
- `stripe-webhook`: the paid-after-expiry and amount/binding checks are unchanged; the failure/refund branches already go through `refund_event_tickets_for_payment`. Receipts use the night's date. No new event types.
- `validate-event-ticket` / `redeem_ticket_atomic`: see section 5.
- `reminder-runner`: see section 6. `notify-event-update`: see section 7.
- `refund-payment`, `refund-reconcile*`: no signature change; they call `refund_event_tickets_for_payment`, which is made occurrence-aware (below). Add a test that the merchant-leg reconciliation still sees the same totals.
- `_shared/ticket-receipt.ts`, `event-wallet-refund-core.ts`: format the night (London time) when `occurrence_id` is set.

### `refund_event_tickets_for_payment`
Today it locks types first and then updates the event counter. Extend: for each refunded ticket with an occurrence, decrement the join row (`quantity_sold`) instead of (or in addition to, for the event-wide counter) the type. Lock order identical to the sale. A whole-payment refund of a single-night order is unchanged in shape.

### Cancel one night (new SQL function + staff/organiser flow)
`cancel_performance_with_tickets(p_occurrence_id, p_note, p_confirm_token)`:
1. Two-step with staff confirmation: step 1 returns a PREVIEW (count of valid tickets, orders, total pence to refund, count of used/checked-in tickets, whether the night has already started). Step 2 requires the preview's `confirm_token` (hash of the counts + occurrence version) so a late sale between preview and confirm forces a re-preview rather than a surprise refund.
2. Locks (section 8), sets the occurrence to `cancelled`, stops further sales (join rows `is_active=false`), marks that night's `valid` tickets `cancelled` (used tickets are left alone and reported), and queues the refunds through the existing refund pipeline per order (idempotent keys `occurrence-cancel:<occurrence>:<order>`), so Stripe/wallet legs and the merchant-leg check stay the single source of truth.
3. Writes `event_change_log`; fires `notify-event-update` (section 7).
4. Authorisation: staff always; the contributor's Phase-1 `report_performance_cancelled` is the free-event path only and REFUSES when tickets exist ("contact support"), because money moves. Business/hub owners of an official event may start step 1; step 2 is staff or the event's business owner with the commercial terms accepted.
5. A night that is cancelled stays visible with its status; it is never deleted.

## 4. Web and mobile display

- Event page: for a run, a date list (next live first) each with its own "Buy tickets" and its own remaining-stock state (Sold out / Few left / On sale / Cancelled). No ticket button on the run header itself.
- Checkout: the chosen night is shown at every step and on the receipt; the basket is for one night. A buyer who wants two nights checks out twice (V1; a multi-night basket would need an order group and is out of scope).
- My Tickets (web and app): each ticket shows its own night, grouped by upcoming/past using the night's `starts_at` (not the parent's). A cancelled night shows "Cancelled" with the refund status. Uses the already-built shared lifecycle helper; it needs `occurrence_id`/snapshot date in its input.
- Owner dashboard (web only in V1): create types with per-night stock grid; per-night sold/checked-in; "Cancel this night" with the preview step.
- Installed mobile builds: see section 9. The app only needs to be UPDATED to buy tickets for a run; until then it keeps the Phase-1 message.

## 5. Scanning and validation

- `redeem_ticket_atomic(p_ticket_id, p_event_id, p_scanner_id)`: keep the signature. Inside, after loading the ticket: if `occurrence_id IS NOT NULL` compare to the "current" night = the occurrence whose window `[starts_at - gate_open, coalesce(ends_at, starts_at + 4h) + grace]` contains `now()`, preferring the nearest. Outcomes (new `result` values; old scanners show the `message` field, which is plain English, so they degrade gracefully):
  - `wrong_night` - valid ticket, different night; message "This ticket is for <date>, not tonight." Ticket stays `valid`.
  - `performance_cancelled` - the ticket's night was cancelled.
  - existing results unchanged for `occurrence_id IS NULL`.
- Single-use invariant is unchanged: the one UPDATE ... WHERE status='valid' statement stays the choke point; the night check happens in the same statement's WHERE (or immediately before, inside the same transaction with the ticket row locked) so a race cannot spend a ticket on the wrong night.
- Gate window setting: default opens 3 hours before start and closes 6 hours after the start when `ends_at` is null. A scanner on the wrong night gets an explicit result, never a silent accept.
- `validate-event-ticket`: unchanged request shape; response gains `occurrence` (starts_at) for the scanner UI to show "Tonight 19:30".
- Live check-in counters (`ticket-live-checkin`): counts per night; the existing event-wide number stays for single-date events.

## 6. Reminders (`reminder-runner`)

Today: events with `reminder_sent_at is null` and `starts_at` in the next 24h, one reminder per event via the `reminder_deliveries` ledger (`family event_24h`, `subject_id = event id`).
Per-performance: add `event_occurrences.reminder_sent_at` (or key the ledger subject as `<event_id>:<occurrence_id>`; the ledger already supports arbitrary subject ids, so no new column is needed - prefer the ledger key). The runner selects tickets with `occurrence_id` whose night starts in the next 24h and notifies those holders only, text uses that night's date. Legacy tickets (`occurrence_id IS NULL`) follow the current path unchanged. A cancelled night sends no reminder. The deadline passed to `deliver` is the NIGHT's `starts_at`.

## 7. `notify-event-update`

Body gains optional `occurrence_id`. With it: recipients = holders of valid tickets for that night only, and the copy names the night ("Your 14 Nov performance..."). Without it: current behaviour (all valid holders of the event). Authorisation (`event-update-notify-auth.ts`) is unchanged: a caller who may update the event may update a night. A cancellation of a night always notifies that night's holders, once (ledger key `occurrence-cancel:<id>`).

## 8. Lock-order rules (HARD)

Global order for any function that touches both stock and rows: **ticket types (FOR UPDATE, by id) -> event_ticket_type_occurrences (FOR UPDATE, by type id then occurrence id) -> event_occurrences row -> events row**.
- Sales take the occurrence and event rows `FOR KEY SHARE` (conflicts with the occurrence guard's `FOR UPDATE`, does not conflict with a plain UPDATE of `tickets_sold`).
- Refund and cancel-night functions follow the same order; they UPDATE the event counter only after the types/join rows are locked.
- Occurrence-adding triggers keep locking the PARENT event row `FOR UPDATE` first (Phase 1). They never lock ticket types, so they cannot invert the order. The new "second occurrence while tickets exist" rule becomes legal under the flag; it must not wait on ticket-type locks while holding the event lock: implement it as a check on already-committed data after taking the event lock, never by locking types.
- Required tests (extend `events-occurrences-phase1` style): sale vs refund of the same night; sale vs cancel-night; two sales of different nights (must not block each other beyond the shared KEY SHARE); sale vs adding a date; each with a mutation control that reverts the lock mode and reproduces the deadlock/violation.

## 9. Compatibility with installed mobile builds

- No required new parameter anywhere. `occurrence_id` is optional in the body and inside the snapshot.
- Installed builds (144 on the App Store, 146, stale 145 and the OTA stream) never send `occurrence_id`. For a run they get `MULTI_PERFORMANCE` -> the friendly 409 sentence (Phase 2). For single-date events nothing changes at all.
- The block therefore stays for old clients permanently; it only stops applying to requests that carry a valid `occurrence_id` while the flag is open.
- A run must never silently route an old client to "the first night". Fail closed, always.
- New app UI ships in a normal release plus OTA once the web path is proven; until then the app's event page for a run shows the dates and the organiser's ticket link (Phase-1/2 reader rules).
- A minimum-version hint is NOT required; the server decides by whether `occurrence_id` is present.

## 10. Data migration for existing tickets

All existing orders/tickets are single-date: `occurrence_id` stays NULL. No backfill. Their night is `events.starts_at` as now. Readers use `coalesce(ticket.occurrence_id's starts_at, events.starts_at)`.
Edge case: an existing event with tickets sold that later becomes a run (Phase 1 forbids it; under the flag the owner must explicitly "convert": the single original date becomes occurrence #1 and EXISTING tickets are attached to it in the same transaction, with the type stock moved into a join row). That conversion is a staff-assisted function with a dry-run preview; it is NOT part of V1 (documented as refused with a clear message).

## 11. Test plan

Isolated Postgres lane only (`ISOLATED_ONLY=... npm run test:isolated`); pure helpers under node; nothing against production.
1. Schema: constraints, RLS (buyers read own tickets; nobody writes join rows directly), ACL per new function (no anon; service role only for reserve/cancel), rollback script restores Phase-1 state and keeps rows.
2. `reserve_ticket_basket`: run without occurrence -> MULTI_PERFORMANCE; wrong event's occurrence; cancelled/past night; per-night stock exhaustion independently; idempotent retry across flag flips; concurrent buyers on the last seat of one night (exactly one wins) and different nights (both win).
3. Lock order tests as in section 8 (with mutation controls).
4. Refund: whole-payment refund of a night order releases only that night's stock; merchant-leg reconciliation totals unchanged; used tickets are not refunded.
5. Cancel night: preview/confirm token invalidated by a late sale; refunds queued once (idempotent); other nights untouched; notification recipients exactly that night's holders.
6. Scanner: right night passes; other night -> wrong_night and ticket still valid; cancelled night; double scan race (single-use); legacy ticket unchanged; old scanner builds still show `message`.
7. Reminders: per-night, once per holder per night (ledger), cancelled night none, legacy unchanged.
8. Contract: old request bodies (no `occurrence_id`) behave exactly as in Phase 1/Phase 2; the pure error mapper test already covers wording.
9. Web: date list, checkout summary, My Tickets grouping, owner grid (component tests + a signed-in acceptance script on a local backend).
10. Staged production dry run (rolled back), as done for the Phase-1 migrations.

## 12. Rollout stages

1. Phase 1+2 shipped, flag closed (stop-gap in force). Pre-requisite.
2. Migration A (schema + functions, flag closed): no behaviour change; verify with the rolled-back dry run, then apply.
3. Edge Functions deployed in the order: shared mapper -> `create-event-ticket-intent` -> `confirm-event-tickets` -> `stripe-webhook` -> `refund-payment` -> `validate-event-ticket` -> `reminder-runner` -> `notify-event-update` (each staged deploy with the drift manifest updated afterwards).
4. Web deployed (date list, checkout, My Tickets, owner grid), still flag closed.
5. Internal test event with 2 nights, staff buying with a Stripe TEST payment only in a test environment; cancel one night end-to-end; scan on two days.
6. Open the flag for ONE named, willing organiser; watch refunds and scanner results.
7. Open generally. Mobile update later; old builds remain on the friendly message.

## 13. Honest effort estimate (one engineer who knows the codebase; includes tests)

| Area | File(s) | Estimate |
|---|---|---|
| Schema + constraints + RLS + rollback | new migration(s), `supabase/rollbacks/*` | 1.5 days |
| `reserve_ticket_basket` + errors | new migration, `_shared/ticket-reserve-error.ts` | 2 days |
| Refund + cancel-night function and preview/confirm | migration, `refund-payment`, `refund-reconcile*` tests | 3 days |
| Scanner (`redeem_ticket_atomic`, `validate-event-ticket`) | migration, function | 1.5 days |
| Intent/confirm/webhook/receipt wiring | 4 functions + `_shared` | 2 days |
| Reminders + notify-event-update | 2 functions + auth helper | 1.5 days |
| Lock-order and concurrency tests with mutation controls | `supabase/tests/*` | 2 days |
| Web (event page dates, checkout, My Tickets, owner grid + cancel flow) | oneshetland-web | 5 days |
| Mobile (date list, checkout, My Tickets, scanner display) | oneshetland-app, EAS build + review | 4 days + store review |
| Staging dry run, docs, acceptance | - | 1.5 days |
Total about 24 working days, roughly 4-5 weeks calendar with review and a store release. The money paths (refund, cancel-night, reconciliation) carry the risk; do not compress them.

## 14. Open decisions for Darren

1. One order per night (recommended) vs multi-night baskets later.
2. Price per night (not in V1) - needed for premieres?
3. Who may confirm a night cancellation with refunds: staff only at first (recommended) or the business owner too.
4. Gate window defaults (3h before / 6h after) acceptable?
5. Whether an existing ticketed event may be converted into a run (staff-assisted, post-V1).

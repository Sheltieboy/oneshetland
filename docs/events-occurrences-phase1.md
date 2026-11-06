# Events & Activities - Phase 1 backend (occurrences, member submissions, contributor self-service)

Status: written and tested LOCALLY on branch `events-occurrences-phase1`. NOTHING is applied or deployed. The member-submission master switch stays closed.

Migrations (add-only; versions chosen to collide with nothing, including unapplied Fetch work at 20261213000000 and 20261214000000-20261225000000):

| Version | File | Rollback (`supabase/rollbacks/`) |
|---|---|---|
| 20261230000000 | `event_occurrences` | `20261230000000_event_occurrences.rollback.sql` |
| 20261230010000 | `event_member_submissions` | `20261230010000_event_member_submissions.rollback.sql` |
| 20261230020000 | `event_contributor_self_service` | `20261230020000_event_contributor_self_service.rollback.sql` |

Roll back in reverse order. No event row is ever deleted by a rollback.

## 1. Schema

`events` gains: `is_dated_run` (trigger-maintained, clients cannot set it), `organiser_name` (<=120, trimmed), `source` (null or `community_submission`), `submission_id`, and an index on `starts_at`. `events.starts_at / ends_at` keep their meaning; installed apps and Social Studio need no change.

`event_occurrences(id, event_id, starts_at, ends_at, status scheduled|cancelled|changed, venue, locality, note<=200, created_at, updated_at)` - unique `(event_id, starts_at)`, `ends_at > starts_at`, indexes `(event_id, starts_at)` and `(starts_at)`.

Parent sync (trigger, definer): parent `starts_at` = earliest non-cancelled start; `ends_at` = latest non-cancelled `coalesce(ends_at, starts_at)`; all cancelled -> earliest/latest of all; `is_dated_run` = 2+ rows. Last row deleted -> parent keeps its times, flag false. Events with no occurrence rows are untouched.

**Reader rules (for the website/app teams)**
- A row with `is_dated_run = true` is a discrete run of performances. NEVER show it as running continuously between `starts_at` and `ends_at`; list the occurrence dates.
- Official OneShetland event = `is_platform_event AND source IS NULL`. Community event = `source = 'community_submission'` - show `organiser_name` as the organiser and never imply OneShetland organised it. The database guarantees a community event always has a non-blank `organiser_name`.
- Show `status` of each occurrence; a cancelled occurrence is not a live date.

New tables: `event_occurrences`, `event_submissions`, `event_change_requests`, `event_organiser_trust`, `event_change_log`. All have RLS; no client can INSERT/UPDATE/DELETE the last four (every write is a function).

## 2. Row security

- Occurrences: SELECT is "can you see the parent event" (it re-uses the events policies, so hub visibility, drafts and hidden events behave identically). Write = `attribution_staff()` OR `controls_event(event_id)` (business owner / hub admin or owner); platform events are staff-only. An occurrence cannot be moved to another event.
- Submissions: submitter reads own; staff (admin/moderator) read all; nobody writes directly.
- Change requests / change log: requester or the event's original contributor reads own; staff read all.
- Trust: staff read only; written only by `admin_set_organiser_trust` (staff).
- The events INSERT/UPDATE/DELETE policies, `events_attribution_exclusive`, and the business/hub approval paths are unchanged (tested). One addition to the events guard: clients (not staff) cannot set or change `source`, `submission_id`, `organiser_name`, `is_dated_run`, and cannot edit `starts_at/ends_at` directly while occurrence rows exist.

Existing-guard interplay (investigated): the sync runs in a SECURITY DEFINER function, so its UPDATE of the parent runs as the owner and takes the attribution guard's "server path" for owners and staff alike. `commercial_terms_guard` keys on `auth.uid()`, so a business that has not accepted the selling terms cannot change dates (same as editing the event; documented limitation, includes cancelling a date).

## 3. Ticketing safety

Every sale goes through `reserve_ticket_basket`, which looks at ticket TYPES and ignores `ticket_url`, `has_tickets` and `starts_at`. `has_tickets` is true for external-link events, so it is NOT gated.
- Trigger: a new or reactivated `event_ticket_types` row is refused when the event has 2+ non-cancelled occurrences.
- Trigger: a second occurrence is refused when the event has an ACTIVE ticket type, or any ticket, or any order (even refunded).
- Inactive types with no sales do not block extra dates; they cannot be reactivated while the event is a run.
- `reserve_ticket_basket` raises `MULTI_PERFORMANCE: ...` (errcode 22023) for a new reservation on a run (a retry of an earlier order is still answered).
- Races: the parent row is the lock (occurrence guard `FOR UPDATE`, ticket-type guard `FOR SHARE`); tested both orders.
- External `ticket_url` is unrestricted.
- **Edge Function change needed (NOT made in this phase):** `create-event-ticket-intent` maps unknown reserve failures to "Those tickets are not available". Add a case: if the error message starts with `MULTI_PERFORMANCE`, return a clear message ("This event has more than one date; its tickets can't be sold here") and a distinct code. Deploy only after the migrations are live.

## 4. Submissions

Master switch: `admin_config` key `events.member_submissions`; open only when the (trimmed, lower-cased) value is `open`; absent = closed. The row is NOT inserted. Staff (admin/moderator) may submit while closed so the flow can be acceptance-tested (their submissions still wait in the queue and publish nothing).

| Function | Who | Notes |
|---|---|---|
| `submit_event_submission(payload jsonb) -> uuid` | authenticated | validates everything; idempotent on `request_id`; max 3 pending, 10 per rolling 24h, 500 pending globally |
| `withdraw_event_submission(id)` | owner | only pending / changes_requested |
| `admin_review_event_submission(id, 'approve'\|'reject'\|'changes_requested', reason)` | staff | reason mandatory (<=500) for reject/changes; approve is idempotent and atomic |
| `admin_event_submission_counts()` / `admin_list_event_submissions(status, limit)` | staff | queue badge and list |
| `event_submissions_open()` | authenticated | for the "not open yet" screen |

Validation: organiser_name 1-120, title 1-200, description 1-2000 (no links, web addresses, e-mail or phone numbers), venue 1-200, locality <=100, price_text <=100, contact_info <=300 (e-mail and phone allowed, links not), ticket_url `https://` only, cover_url must be `https://nkrtmakxygkvxuxriiil.supabase.co/storage/v1/object/public/event-media/<submitter id>/events/<file>` (the event-media bucket's per-user folder convention; the project ref is hard-coded like other migrations - change if the project changes), occurrences 1-60 `{starts_at, ends_at?, note?}` with explicit UTC offset, all in the future, ends after start, span <= 400 days, no repeated start, `adult_confirmed` must be `true` (we treat it as "I am 18+ and have the organiser's permission").
`changes_requested` leaves the submission closed; the member submits a new one (no edit-and-resubmit in Phase 1).

Approval creates, in one transaction, a PLATFORM-owned event (`is_platform_event`, `source='community_submission'`, `submission_id`, `organiser_name`, `organiser_user_id` = submitter for audit only, `status='published'`, `has_tickets=false`, no business/hub). One date -> a plain one-off with no occurrence rows; several -> occurrence rows, parent synced. The submitter never gets write access through RLS. Approval is refused if every date has already passed.

### Category mapping (slug -> label stored in `events.category`)

| Slug | Stored label |
|---|---|
| theatre_performing_arts | Theatre & Performing Arts (NEW) |
| music_gigs | Music |
| festivals | Festival |
| exhibitions_arts_culture | Arts & Culture |
| markets_fairs | Market |
| fundraising_charity | Charity |
| talks_workshops | Community |
| community | Community |
| food_drink | Food & Drink |
| outdoors | Outdoors |
| family | Family |
| sport | Sport |
| business | Business |
| heritage | Arts & Culture |
| comedy_film_literature | Arts & Culture |
| other | Other |

The slug is kept on `event_submissions.category`. `public.event_category_label(slug)` is the single source. Legacy `events.category` values are untouched. The website's chip list (`EVENT_CATEGORIES` in `lib/events-api.ts`) needs 'Theatre & Performing Arts' added to filter on the new label.

## 5. Contributor self-service (original submitter of an approved community event, event not archived)

| Tier | Actions | Who decides |
|---|---|---|
| A - immediate, audited | `report_performance_cancelled(occurrence, note)`, `report_event_cancelled(event, note)` (works for one-offs with no occurrence rows: sets `status='cancelled'`), `report_performance_restored`, `report_event_restored` (24h, only if nothing else was logged for the event since), `set_performance_note` | nobody; logged in `event_change_log`. Past performances cannot be changed. Cancelling the last live performance also cancels the event. |
| B - moderated (default) | `request_event_change(event, payload, request_id)` for title, description, venue, poster (`cover_url`), ticket link, price text, contact info, and the full future-dates list; `withdraw_event_change(id)` | staff via `admin_review_event_change(id, 'approve'\|'reject', reason)`. Approve re-validates against the CURRENT state, applies atomically, is idempotent; a stale request raises and stays pending. |
| C - trusted | staff set `admin_set_organiser_trust(user, trusted, note)`; for a trusted requester, changes touching ONLY description, venue, ticket link, contact info and dates auto-apply and are recorded `auto_approved` | Title, poster, price text and brand-new events stay moderated. Dates never auto-apply on an event that has an active ticket type, ticket or order. Default untrusted; revoke by setting false. |

Request rules: unknown/forbidden keys (status, is_hidden, is_featured, ownership, source, category, has_tickets ...) are rejected; no-op requests are rejected; max 5 pending per event; 20 requests per user per 24h; the occurrences list replaces all FUTURE dates (past ones are never touched); a sold event may not gain a second date. Staff queue: `admin_list_event_changes('pending'|'auto_approved'|..., limit)` and `admin_event_change_counts()`. History: `event_change_log` / `event_change_requests` are readable by the contributor for their own events and by staff.

Not logged: staff edits made directly on the tables (the 24h restore check only sees logged actions). A second adult co-managing an event is NOT in scope (later).

No emails, notifications or contacting triggers exist anywhere in these migrations (tested: no `notification_log` rows).

## 6. Release checklist (before applying anything)

1. Run `node scripts/check-migration-collisions.mjs` from a trusted shell (it reads production's migration history; read-only) and confirm 20261230000000 / 010000 / 020000 are free and newer than the newest applied version.
2. Diff `reserve_ticket_basket` in production against the body in the third migration (that copy came from the migration history). If production differs, regenerate the migration from production's definition plus the marked MULTI_PERFORMANCE block.
3. Confirm `profiles.role` values and `attribution_staff()` in production match (admin, moderator).
4. Confirm no production `events` row has a non-null `organiser_name`/`source`/`submission_id` column already (columns are new) and that no other view selects `events.*` into a fixed-width structure.
5. Confirm production default privileges on `public` functions: the tests reproduce Supabase's grant-to-anon default and prove the migrations revoke it, but re-check `has_function_privilege('anon', ...)` on every new function after applying.
6. Confirm the `event-media` bucket path convention in production is still `<user_id>/events/<file>` and the project ref in the cover URL pattern.
7. Apply the three migrations in order, in a staging-first/deploy-without-unrelated-changes manner; re-run `supabase/tests/events-occurrences-phase1.node.test.ts` (isolated lane only) and `migration-immutability.node.test.ts`. Refresh the catalog fingerprint/snapshots the repo keeps (`supabase/production/*`) as part of the usual post-apply registration.
8. Leave `events.member_submissions` UNSET (closed). Open it only after the web/app screens and the staff queue exist; test with a staff account first.
9. Deploy the `create-event-ticket-intent` MULTI_PERFORMANCE mapping after the migrations.
10. Tell the website/app teams the reader rules in section 1 (dated runs, community vs official attribution).
11. Rollback: run the three `.rollback.sql` files in reverse order; verified to remove every new object, keep all event rows, restore the previous `reserve_ticket_basket`, and allow the migrations to be re-applied.

## 7. Tests

`supabase/tests/events-occurrences-phase1.node.test.ts` (89 tests incl. 15 mutation controls). Isolated cluster only; registered in `scripts/isolated-pg.mjs`:

    ISOLATED_ONLY=events-occurrences-phase1 npm run test:isolated

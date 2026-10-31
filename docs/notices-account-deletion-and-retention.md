# Notices & Alerts — account deletion, retention and the member-notification policy (31 Oct 2026)

STATUS: local only. Nothing here is deployed. Funeral retention (section 4) is a RECOMMENDATION awaiting approval; nothing about funeral records has been changed.

## 1. What account deletion does (the real function, run against the acceptance backend)
`supabase/functions/delete-account` is a scrub-and-soft-delete (the profile row is kept, scrubbed, so ~30 retained foreign keys stay valid). In order, for the caller's own id only (taken from their JWT):
1. deletes the member's own UGC, including **every personal notice in every state** (pending, published, withdrawn, declined, ended, resolved) with its areas — `publisher_user_id = uid`, no hub, no business, not a platform notice, no status filter. Hub, business and official-organisation notices are never selected.
2. **new:** `delete_member_notice_data(uid)` (service-role-only database function) removes the member's `member_areas`, `notice_notification_prefs` and `notice_deliveries`; and the existing `notification_preferences` row is deleted.
3. push tokens (so no push can reach the account), blocks, business deactivation, profile scrub, sign-in soft-deleted (the account can never sign in again).
"Former member" remains a defensive fallback for an orphaned record only.
Why a function and not three `delete()` calls: the Notices tables are locked even to direct service-role access (RLS, no grants) and the cascades never fire because the profile row is not deleted.

## 2. Deployment order (production does not have the new tables yet)
The updated function does NOT assume the new objects exist. Every new step goes through `runIfPresent`: PostgREST "not found" (PGRST205 table / PGRST202 function; Postgres 42P01 / 42883) is reported as `skipped: not present yet` and the deletion carries on; any other error is reported as an error. Tested with the function hidden (test 10 in `accept-delete-account.node.test.ts`): deletion succeeds, personal notices are still deleted.
Recommended order: (1) apply migrations 20261129000000 → …050000 (the function `delete_member_notice_data` is in `…020000`); (2) deploy the updated `delete-account` straight after `…020000` is applied (any time later is also safe, but between "member data exists" and "the new function is live" an old function would leave those rows behind); (3) the rest of the release as in `DEPLOY-NOTICES-ALERTS.md`. Deploying the function first is safe (the step is skipped); it simply does nothing for tables that do not exist yet. Rollback of migration `…020000` drops the function; the deployed function then reports `skipped` again.

## 3. Audit trail review (`notice_audit_log`, append-only)
Kept after deletion: `actor_id` (the account id of whoever acted; the profile row is scrubbed, so it is a pseudonymous id, not a name) and the structured `details`. What the details contain, by event: areas, kinds, flags, dates, ids; **no notice title or wording** (verified by test 6). Free text exists in only four staff-written fields: `person_notice_declined.reason`, `publisher_verified.note`, `essential_granted/revoked.reason`, `funeral_taken_down.reason` (each ≤ 500 characters, staff-only readable). `member_added.user` records the id of an organisation member. Funeral free text (`verification_note`, `review_note`, `review_message`) lives on `funeral_notices`, not in the audit log.
Findings: no direct identifiers, but staff free text can contain personal data (a phone number in a verification note was demonstrated in the test). Recommendations (not implemented; append-only history is not to be edited to satisfy a test): (a) staff guidance and a form hint: "do not write phone numbers, emails or the family's words in notes"; (b) a reviewed, audited, definer-only redaction routine for the four free-text fields after a retention period (suggest 12 months), which is the only sanctioned exception to append-only and writes its own audit row; (c) keep `actor_id` for accountability; if the account is later fully erased, replace it with a one-way hash through the same routine.

## 4. Funeral submissions when the submitting member deletes their account — CURRENT behaviour (nothing changes funeral data today)
Observed by running the real deletion (`accept-delete-account.node.test.ts`, test 11). The member's account is scrubbed and closed, but:
| Record | Pending / in review | Approved (public) | Withdrawn | Rejected |
|---|---|---|---|---|
| Row (deceased's name, dates, announcement, area) | kept | kept, **still public** until `display_until` (≥ 14 days from approval) | kept (never public) | kept (never public) |
| Submitter name, relationship, **phone, email** | **kept** | **kept** | **kept** | **kept** |
| `submitter_id` | kept (points at the scrubbed account) | kept | kept | kept |
| Verification evidence (`verification_method`, `verified_by/at`, `verification_note`) | none yet | **kept**; a staff note can contain the family's phone number | none | none |
| Staff notes (`review_note`, `review_message`) | kept | kept | kept | kept (e.g. "could not verify…") |
| Change / takedown requests (`requester_id`, `contact`, `message`) | kept | **kept** | n/a | n/a |
| Audit (`funeral_*` events) | kept | kept | kept | kept |
Public reads (`get_funeral_notice(s)`) never expose any contact, submitter or verification field — only the deceased's announcement fields.
Other: `funeral_director_members` rows cascade only on a hard delete (so they remain; a closed account cannot sign in, so they confer nothing). The member's area/preferences are now removed (section 1).

### Recommended retention and anonymisation policy (for approval)
Principles: the announcement is about the deceased and the family's wishes, not the account; a published announcement must not vanish because the submitter closes their account; private contact details need a purpose, and once the submitting account is closed there is no one to contact through them.
1. **Approved, public announcement:** keep. On account deletion detach the submitter: `submitter_id → NULL`, `submitter_name`, `submitter_relationship`, `submitter_phone`, `submitter_email → NULL`. Keep `verification_method`, `verified_at`, `verified_by` (staff id) as the integrity record. Replace `verification_note` / `review_note` / `review_message` with a fixed marker ("removed when the submitter closed their account") — staff free text is where stray personal data hides. Keep `announce_*` flags. After `display_until + 90 days` delete the row (or anonymise to a name-less stub) unless a request is open.
2. **Pending / in review / needs information:** the submitter was the only contact and is gone: treat as withdrawn, scrub as above, and delete the row after 30 days (a short grace so a reviewer mid-call is not surprised). Never publish it.
3. **Withdrawn:** scrub immediately, delete after 30 days. **Rejected:** scrub immediately; keep the rejection record 90 days for abuse patterns (hoaxes), then delete.
4. **Private family contact details:** never retained after the submitting account is closed, in any status. Retained only while the account is open and the notice is live or in review.
5. **Change / takedown requests:** while open, keep the requester's contact so staff can reply; when closed, scrub `contact` and `requester_id` after 30 days; on the requester's account deletion scrub immediately for closed requests.
6. **Surviving family and takedown:** with the contact gone, a relative cannot be reached through it. Keep the existing route (any signed-in person may request a correction or takedown via `request_funeral_notice_change`; staff verify by their own callback to a funeral director or another independent contact, never by the submitter details) and add a no-account route: a "Contact us about this announcement" link to the support address that staff can enter as a change request. Staff may always take down immediately (`admin_funeral_takedown`).
7. **Audit:** as section 3 — structured funeral events kept with the pseudonymous actor id; staff free text subject to the 12-month redaction routine.
8. **Implementation, once approved:** one reviewed definer function `anonymise_funeral_submitter(uid)` (service-role-only, idempotent, returns counts, writes an audit row), called by `delete-account` through `runIfPresent` exactly like `delete_member_notice_data`; a dry-run report first; tests in the existing real-function suite. Irreversible, so it ships only after approval.

## 5. Member-notification policy — RECORDED for the next implementation step (nothing implemented here)
The earlier exclusion of personal notices from Community Notices notifications (`notice_dispatchable`: "Only hub and business notices go to the community audience") was a design choice made while building the audience migration, **not an approved product decision**. The intended policy:
- Personal notices require moderation; **approval alone never sends a notification**.
- A moderator may **separately authorise a push** for an appropriate approved notice (an explicit, audited, once-only action; never the author, never automatic).
- Only members who explicitly opted in to Community Notices **and** follow a relevant area are eligible (unspecified-area notices still never qualify; an explicit Shetland-wide notice reaches opted-in members).
- Deduplication (one delivery per member per notice) and rate limits are mandatory (suggested: per moderator per day, per author per week, per area per day; to be set with the next step).
- Automatically imported notices remain silent.
Next step needs: a staff-only `staff_authorise_person_notice_push(notice)`; `notice_dispatchable` / `can_dispatch_notice` to accept an approved person notice only with that authorisation; rate-limit tables; the moderation screen button; tests. Until then the code still refuses member notices for push.

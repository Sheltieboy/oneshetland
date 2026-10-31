# Moderator-controlled Community Notice notifications (31 Oct 2026)

STATUS: implemented and tested LOCALLY (isolated backend, **mocked push sender**). Nothing is deployed, applied or sent. No real push notification has ever been sent by this feature.

## Workflow
1. A member posts a notice; staff **Approve** it (publishes it). Approving **never** sends anything and never preselects it. The approve button says so.
2. Separately, under "Published member notices", staff choose **Notify opted-in members…** for a notice that is published, public, started, un-expired, un-hidden, has an **explicit place** (specific areas or explicit Shetland-wide) and has not already been announced. Otherwise the button is disabled with the reason.
3. A **preview** shows the headline, "Posted by A OneShetland member", the area(s), the exact notification text, and an **estimated recipient count** (counts only: no names, addresses, tokens or preferences). **Cancel** does nothing. **Send to about N members** is the only thing that calls the function.
4. The Edge Function `notify-notice-audience` (kind `member`) asks the database whether the caller is staff, claims the dispatch (once per notice, ever), selects the audience in the database, and for each recipient: gate → reserve → push. The result (sent / held for quiet hours / skipped / failed) is recorded and shown on the notice.

## Authorisation (all in the database, never in the request)
`can_dispatch_notice(user, notice, 'member')`: moderator, administrator or platform owner, and the account must not be closed. The author, other members, hub owners, business owners, organisation publishers and delegates cannot, whatever the request says (the request names only a notice and an audience; extra fields are ignored; tested). No publisher entitlement exists or was added. The staff action is audited (`dispatch_claimed` with the staff id, `dispatch_completed`); the staff-only list/preview functions and the dispatch functions are not callable by any client role. `can_dispatch_notice` now also refuses a closed account for every audience.

## Recipient eligibility (ONE definition, `notice_member_audience`, used by the preview estimate and the dispatch)
Opted in to Community Notices; category preference matches; follows an area that matches by parent/child (never a sibling, never GPS); an **explicit Shetland-wide** notice reaches members who have chosen **any** area (deliberately stricter than the other audiences, which do not require one); a notice with **no place** is never announced; account active (not deleted/closed); a valid Expo device token; master switch on, notices switch on and **not in quiet hours** (the real `should_notify`); fewer than two member notifications in the last 24 hours; no existing final delivery for this notice. Nothing is switched on automatically; official imports stay silent; Essential, official, hub, business and funeral audiences are unchanged.

## Frequency and duplicates (server-side)
* one delivery row per (notice, member): several matching areas, several devices and retries give one push;
* **at most 2 member notifications per member in any rolling 24 hours**, enforced by `notice_member_reserve` under a per-member advisory lock (six simultaneous reservations admit exactly two; tested). Counts sent and reserved ones only; held, skipped, failed and older ones do not. A member over the limit is recorded as `skipped` (`daily_limit`): never as sent, and there is **no catch-up**;
* the existing once-only claim: a second request is refused (409); two simultaneous requests: one runs, one is refused; a completed dispatch is never reopened, so **editing and re-approving does not re-notify**; a crashed run resumes without re-pushing anyone;
* Essential Alerts use their own kind and are not counted by, or blocked by, the member cap.

## Quiet hours and status accuracy (updated 31 Oct: shared sender now FAILS CLOSED)
Quiet hours are never overridden for member notices (`urgent: false` always). Status meanings in `notice_deliveries`:
- `sent` — the provider (Expo) ACCEPTED the message for at least one device. It is not confirmation that a handset received it (no push receipt is checked).
- `skipped` — final, nothing will be retried. `last_error` says why: `quiet_hours`, `opted_out`, `no_device`, `preference_blocked`, member daily limit, closed account.
- `failed` — a provider error or an unreadable preference check; retried by the dispatcher up to 3 attempts, then final. Never counted as delivered.
- `pending` — a member-cap reservation held while a send is in flight.
- `held_quiet` — LEGACY. No longer written. Quiet hours is a final `skipped` (`quiet_hours`), because no catch-up exists; staff are shown "quiet hours", not "waiting".
`sendUserPush` now returns an additive `reason` (`accepted | preference_check_failed | opted_out | quiet_hours | preference_blocked | no_device | provider_error`). If `should_notify` errors, throws, times out (4 s) or answers anything other than true/false it is retried once and then NOTHING is sent: status `error`, reason `preference_check_failed`, logged as `error`. Urgent still bypasses quiet hours only; it never bypasses an opt-out or a failed check. A missing preferences row still means opted in (the existing production default, unchanged).
Callers that stamp "reminder sent" (`reminder-runner`) leave the item unstamped when the check failed, so the next 15-minute run retries it; `deferred_preference_check` in its result counts these.
**Remaining notes:**
3. `sent` means provider acceptance only.
4. A reservation (`pending`) left by a dispatch that crashed and is never resumed counts toward the member's cap for 24 hours (conservative).

## Not verified / needs a deployment
* **No real push has been sent.** All delivery outcomes above came from a mocked sender that records attempts and sends nothing. Real Expo behaviour (tokens, receipts, device delivery, timing) is untested.
* The Edge Function is not deployed (the other audiences' function was never deployed either); the browser test used the local host of the same handler code. Required first: migrations `…020000`…`…080000`, the function, then the website. `…080000` needs the production `should_notify` and `push_tokens` (they exist).
* The estimate is a snapshot: members entering quiet hours or hitting the cap between preview and send are then held/skipped, so "sent" may be lower than the estimate.
* The notification text is the notice's own (author-written, already public) title plus a fixed line; the body never repeats the author's text or any name.


## Verification of the fail-closed sender (31 Oct, after commit 9dbc855)
Runtime tests against the REAL handlers and sender with an in-memory database and a MOCK Expo (no physical device, no real push): `reminder-runner-runtime` (11 reminder families x accepted / unreadable / throw / opt-out / quiet / no device / provider failure / missing row, plus recovery and no-duplicate checks), `send-push-callers-runtime` (notify-job, notify-shift-status, notify-hub-content, notify-funeral-notice), `send-push-callers-contract` (all 41 caller files; urgent allow-list; the two raw `sendPush` admin alerts address `role = 'admin'` only).
Findings fixed locally: `reminder-runner` loyalty, pass-expiry and Fetch-order reminders also stamped "sent" whatever the push result (now deferred on an unreadable check); `notify-hub-content` called `sendUserPush` without importing it (every hub-notice send failed with a ReferenceError and was recorded `failed`).
Known, unchanged: overlapping reminder-runner invocations can double-send (select-then-stamp is not atomic; scheduler runs every 15 minutes); `should_notify` treats a missing `notification_preferences` row as enabled for EVERY module including `cruise` (the column default is off, but a missing row skips the column) - Notices audiences are unaffected because they are selected from explicit `notice_notification_prefs` rows (all default off).


## reminder-runner: database claims and per-recipient completion (31 Oct)
**Problems fixed.** (1) Two overlapping `reminder-runner` executions both selected the same unstamped reminder and both sent it (select, send, then stamp is not atomic). (2) An event reminder was stamped complete when ANY holder was reached, so a holder whose preference check failed temporarily was never retried.
**Mechanism (migration `20261129090000_reminder_delivery_ledger.sql`, service role only).** `reminder_deliveries` holds one row per (family, subject, recipient). `reminder_claim_many` takes the claim with `INSERT ... ON CONFLICT DO UPDATE ... WHERE`: PostgreSQL serialises writers on the row lock, so exactly one worker ever receives a token for a recipient, across independent workers and overlapping runs. Nothing is sent without a claim; if the ledger is unreachable the run sends nothing and reports `ledger_error`.
**Recipient states.** `claimed` (lease, provider not yet contacted) -> `dispatching` (written immediately before the provider is contacted, via the sender's `beforeProvider` hook) -> `sent` | `opted_out` | `quiet_hours` | `no_device` | `provider_error` (all final: existing no-catch-up policy) | `check_failed` (the ONLY retryable outcome: up to 12 attempts, always inside the reminder's own deadline) | `uncertain`.
**The parent reminder (booking, event, delivery, pass, loyalty card, digest day) is marked done only when no recipient is retryable or mid-send elsewhere.** Recipients already `sent`/final are never contacted again, so an event with three holders where two were reached and one had a temporary error retries only the third.
**Crash policy (duplicate prevention first).** Crash before the claim: nothing recorded, next run sends. Crash after the claim but before the provider was contacted: the 10-minute lease expires and the next run sends it once. Crash after the provider may have been contacted with no outcome recorded: marked `uncertain` and NEVER resent. Outcomes are recorded per batch of 25, so a crash mid-way keeps everything already done. A worker that wakes after its claim was reclaimed cannot mark `dispatching` (its token no longer matches) and sends nothing.
**Unavoidable uncertainty.** The provider accepting a message is not proof of handset delivery, and a crash between the provider accepting and the outcome being recorded leaves delivery unknowable: such reminders may have been delivered or not, and are not resent. Exactly-once physical delivery is not claimed.
**Deadlines.** Booking and event reminders stop at the start time, delivery and pass reminders at expiry, digests at the end of the London day; the database refuses a claim past the deadline. No catch-up, no extra reminders. Loyalty records are reusable after one hour, because `nudge_reminded_at` re-arms when a card fills again.
**Fetch "no driver found".** The status UPDATE itself is the claim, so only the run that flipped a request notifies its customer. It is not retried on an unreadable check.
**Deploy order.** Apply the migration BEFORE deploying `reminder-runner` (without it the new runner sends nothing and says so). Finished rows are purged after 14 days.

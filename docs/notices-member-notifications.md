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

## Quiet hours and status accuracy
Quiet hours are never overridden (`urgent: false` always). `notice_push_gate` decides at send time WITH the reason: `quiet_hours` → recorded `held_quiet`; muted/closed/no device/daily limit → `skipped`; an error → `failed` (retried up to 3 times, then final); `sent` only when the sender reports sent. A held notification is never retried later ("catch-up" would need your approval).
**Discrepancies found in the existing sender (documented, not changed, because 11 production functions use it):**
1. `sendUserPush` returns `skipped_pref` for BOTH a muted preference and quiet hours (`should_notify` returns only true/false). So for the other audiences (essential, official, community, hub) a quiet-hours refusal is stored in `notice_deliveries` as `skipped`, never `held_quiet`, although the dispatcher has the mapping. The member audience avoids this through the gate. (The notification inbox log is reclassified to `skipped_quiet` by an existing trigger.)
2. `sendUserPush` **fails open** if its `should_notify` check errors (it sends). The member path checks the gate first and treats an error as a failure, so for members an unreadable decision is never permission; the sender's own second check is then redundant.
3. `sent` means the provider accepted the message for at least one device. Delivery to the handset is asynchronous and no push receipt is checked by anything here.
4. A reservation (`pending`) left by a dispatch that crashed and is never resumed counts toward the member's cap for 24 hours (conservative).

## Not verified / needs a deployment
* **No real push has been sent.** All delivery outcomes above came from a mocked sender that records attempts and sends nothing. Real Expo behaviour (tokens, receipts, device delivery, timing) is untested.
* The Edge Function is not deployed (the other audiences' function was never deployed either); the browser test used the local host of the same handler code. Required first: migrations `…020000`…`…080000`, the function, then the website. `…080000` needs the production `should_notify` and `push_tokens` (they exist).
* The estimate is a snapshot: members entering quiet hours or hitting the cap between preview and send are then held/skipped, so "sent" may be lower than the estimate.
* The notification text is the notice's own (author-written, already public) title plus a fixed line; the body never repeats the author's text or any name.

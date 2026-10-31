# Notices — known outstanding issues

Recorded so they are not lost between stages. Each must be resolved or consciously accepted before the stage named.

## R2 — `notify-hub-content` does not validate the notice it announces
*Found: Notices Stage 3A.1 verification (31 Oct 2026). Status: OPEN — investigate before new notice-management / lifecycle interfaces (Stage 3A.2 onwards).*

`supabase/functions/notify-hub-content` (event `notice`) pushes "New notice from {hub}" to a hub's active members. It authorises the caller as the hub's owner/admin
(`_shared/hub-content-notify-auth.ts`) but never reads the notice: `ref_id` and `title` come straight from the request body. It therefore cannot check that the
notice exists, belongs to that hub, is `status = 'published'`, has started, is unexpired, public, or is not an official import (`source IS NOT NULL`).

Impact today: limited. Only a hub owner/admin can call it, only that hub's members are reached, and both shipped clients call it immediately after creating a
published notice. It becomes material once notices can be pending, scheduled, withdrawn or resolved from the management interfaces.

Proposed direction (NOT implemented): look the notice up by `ref_id` with the service role, require it to belong to `hub_id` and to be eligible under the same rule as
`_shared/notice-broadcast.ts`, take the title from the row rather than the request, and claim a once-only marker. Needs its own tests and a coordinated app/edge change.

The characterisation test `8.1` in `supabase/tests/notice-broadcast-eligibility.node.test.ts` fails when someone starts fixing this, so the record is updated.

## V1 — authenticated-admin smoke test of `notify-community-notice` v14 not performed
*Recorded: Notices Stage 3A.2 (31 Oct 2026). Status: verification limitation, NOT a deployment blocker (accepted by Darren).*

When Stage 3A.1 was deployed, the planned "authorised admin request with a non-existent notice id -> 404, no push" production check could not be run: it needs a
signed-in admin session. Instead v14 was verified by bundle comparison with commit 3ba5bdd, the gateway 401 (no header), the function's own 401 (anon key), and CORS
preflight, plus 54 isolated tests of the real source. If a manual check is ever wanted: an admin-signed call with a made-up id should return 404 `Notice not found` and
send nothing. Never call it with a genuine eligible production notice.

## R2 — still open after Stage 3A.2
Stage 3A.2 only changes how notices are displayed and read; `notify-hub-content` is untouched. R2 must still be assessed and resolved before any new notice lifecycle or
management interface is introduced.

## T1 — two app tests read a stale website checkout (not a Notices defect)
*Recorded: Notices Stage 3A.2 review (31 Oct 2026).* `supabase/tests/book-service-first-discovery.node.test.ts` and `local-passes-discovery.node.test.ts` read website source from `../oneshetland-web`,
a local `main` checkout that is 65 commits behind `origin/main` (105bbd4 vs 8904ced). Against it they fail (2 of 31); pointed at a current website baseline they pass 31/31 (verified with throwaway copies,
nothing committed). They fail identically on the unmodified app baseline. Suggested maintenance (not done here): fast-forward that stale checkout, or let the tests read the website root from an environment variable.

## L1 — Stage 3A.2 verification still outstanding (recorded at integration, 31 Oct 2026)
Not resolved; do not mark done until each is actually run:
* **Android emulator and a physical device** have not been run. Only the iOS simulator (iPhone 17e, dev client build 38) and a desktop/375px browser were.
* **Business detail destination** was reached with the right id but not verified with real data (the fixture lacks the public business view that screen reads).
* **Slow person-name RPC** can delay a feed by up to 1.5 s when a person notice is in the result (docs/notices-person-attribution-performance.md). No person notices exist in production today.
* **R2** (notify-hub-content) and **V1** (admin smoke test of notify-community-notice v14) remain open as recorded above.

## B1 — release baseline: builds 147 and 148 reconciled (31 Oct 2026)
Verified from EAS (read-only build list): iOS 148 = commit 7317508 (9 Oct), 147 = 938e0f1 (8 Oct), 146/145 = 10d1f00, 144 = 5b09e206; Android builds 2 and 3 = 7317508. Each is the shared base 10d1f00
plus those two linear commits, so nothing else shipped from outside the base. The newest OTA updates on the production channel are about four weeks old (before 147/148).
* **938e0f1 (one `client_request_id` per purchase attempt)** is ALREADY PRESENT on `home-redesign`: its four mobile files are byte-identical there (they arrived via fd037c4). Not cherry-picked.
* **7317508 (referral programme removed)** was MISSING from `home-redesign` (the 221-line referrals screen and the "Invite friends" row were still there). Cherry-picked cleanly; `app/referrals.tsx`,
  `app/(tabs)/me.tsx` and `account-hub-navigation.node.test.ts` are now byte-identical to build 148. `lib/referrals.ts` (unused, as in build 148) remains.
* The local `home-redesign` is still 88 commits ahead of `origin/home-redesign` (45dddf6); none are pushed.


## A1 / A2 / A3 — Android emulator findings (31 Oct 2026, source 5a5bf3b, local fixture backend)
- **A1 — Android crash without a Maps key.** `components/BusinessLocationMap.tsx` mounts `MapView`; with no `com.google.android.geo.API_KEY` in the manifest the native SDK throws and JavaScript cannot catch it. Seen on business detail for a business with coordinates. Mitigated at build time (EAS Android builds now fail when no key is present — `app.config.js`); the app code is unchanged and a keyless local build still crashes. Whether the production key is valid and enabled for "Maps SDK for Android" is NOT verified (values are sensitive; Google console not inspected).
- **A2 — Back chip overlaps the "ALL SHETLAND" label** on the legacy `/local-combined-feed` header. Not fixed.
- **A3 — event-generated notices open their hub, not the event.** `app/notices.tsx` orders destinations campaign, hub, business. Intended behaviour (event first) not implemented; the data model already supports it (`notices.event_id`, ownership enforced by `notice_event_belongs`; the loader already joins `events(... calendar_approved)` and hides unapproved events). A small routing change plus a rule for finished/cancelled events is needed; awaiting approval.
- Still outstanding: physical-Android verification, business detail against legitimate real data, empty/error states, Home Events card.


## R2 — STATUS UPDATE (31 Oct 2026): remediated IN CODE, awaiting deployment
`notify-hub-content` now reads the notice it announces and announces it only if the database says it is dispatchable to hub members (`notice_dispatchable(…, 'hub')`: published, started, unexpired, not hidden, a hub notice, public or members-only, never an official import), from the stored text (the caller's `title` is ignored), to active hub members, once (`notice_claim_dispatch`: a repeat call or a call after an edit returns 409). Proven: isolated-PG R2 matrix (audience suite 6b), dispatch-core tests with a mocked sender, source guards. **Not deployed to production**: until the function is redeployed (and migration `20261129020000` applied) the live function still has the old behaviour. The `event` branch of the same function is unchanged.


## Acceptance testing, 31 Oct 2026 (signed-in, writable backend) - findings
FIXED locally (not deployed):
* **F1 (important).** A notice with no area rows matched NO area filter, so a member who chose areas stopped seeing almost every hub and business notice (their forms have no area control). Reading now treats "no area" as island-wide (`notice_matches_areas`); push is unchanged (a notice with no area still notifies nobody).
* **F2.** A member could not edit their own person notice: the edit returns it to pending and Postgres refuses an UPDATE whose new row the author cannot read. Added `edit_my_person_notice` (additive, inside the unapplied core migration).
* **F3.** Mobile Essential Alert ordering ignored parent/child areas (an alert for North Mainland ranked below an island-wide one for a Voe member). The app now mirrors `area_neighbourhood`.
* **F4.** The admin console left the grant reason typed in the box and re-used it as the revoke reason; it is cleared after every success.
STILL OPEN (reported, not built): admins add organisation members by pasting a user id (no lookup by email); the Notify buttons call edge functions that are not deployed, so they were not exercised; real push, quiet-hours decisions (`should_notify`) and email are not exercised; the app's funeral screens were not driven on the device (sign-in and preferences were); a signed-in iPhone was not tested.

## Members publishing notices (31 Oct 2026) - added; limitations
* Built: submit, my notices (pending / published / ended / withdrawn / not approved, with the reason), edit (returns to moderation), withdraw, staff approve / decline - on the website and in the app (staff moderation is on the website only). Area states stay distinct: specific / explicit Shetland-wide / unspecified; the strict "Shetland-wide only" filter (`[]`) no longer includes unspecified notices; unspecified carries no label and is never a push audience; member notices are never pushed at all.
* The member's display name becomes public ("Posted by <name>") on approval; the form says so.
* **Account deletion (corrected 31 Oct):** the real `delete-account` function DELETES every personal notice of the member in any state (pending, published, withdrawn, declined, ended, resolved) together with its areas, before it scrubs the profile and soft-deletes the sign-in; hub, business and official-organisation notices survive. "Former member" is only a defensive fallback for an orphaned record and is not produced by normal deletion. Proven by `supabase/tests/api/accept-delete-account.node.test.ts`, which runs the real function body. The function now also removes the member's notice areas, notification preferences and delivery history (via `delete_member_notice_data`). Still kept: the append-only audit trail (staff-only; account id, no notice wording; staff free text) and funeral submissions with the submitter's private contact details (RETENTION POLICY RECOMMENDED, NOT YET APPROVED OR IMPLEMENTED). See `notices-account-deletion-and-retention.md`.
* **Push policy for member notices (APPROVED POLICY, NOT YET BUILT):** member notices are currently refused for push (`notice_dispatchable`) - that exclusion was my design choice, not an approved decision. Approved policy: moderation first; approval alone sends nothing; a moderator may separately authorise a push; only opted-in members following a relevant area are eligible; dedupe and rate limits mandatory; imports stay silent. Details in `notices-account-deletion-and-retention.md` section 5.
* No photo upload, no link field, no repeat/renew, no member-to-member contact; staff decline is final (the member posts a new notice).
* Moderators approve in /notices/moderate (website). There is no in-app moderation screen.

## Funeral privacy (31 Oct 2026) — remaining items
* The retention periods, lawful bases and the `/privacy#funeral-announcements` wording are **proposals awaiting owner review**; nothing is scheduled and the job is off by default.
* A pending submission whose account is deleted is **withdrawn** (cannot be verified without the family). If the owner prefers a funeral-director route for those, it is a small change in `delete_member_funeral_data`.
* The no-account contact form has no server-side bot check (the site has no Turnstile verification): honeypot + database rate limits only. Mobile opens the website form in the browser (no native form).
* Audit redaction is administrator-driven per entry; there is no bulk tool by design.
* `verification_note` on an approved announcement is retained (it cannot hold a phone number or email, but could still hold a name): the review guidance says not to.
* Not verified on a physical device or in a hosted environment: the funeral contact page, moderation and Privacy tab were exercised by tests and type-checked, not clicked through a hosted deployment.
* Member-notification decision recorded, **not built** (see `notices-account-deletion-and-retention.md` §9).

## Release blockers found by privacy acceptance (31 Oct 2026)
* **Anonymous contact form can be used to lock families out** (demonstrated locally): 3 junk requests exhaust one announcement's daily allowance; 20 scripted requests with different fake contacts exhaust the site-wide hourly limit, after which every genuine request is refused. The honeypot does not apply to a script calling the REST function directly. Needs server-side Turnstile verification + per-IP throttling in an edge function (reusing `_shared/rate-limit.ts` / `claim_rate_limits`), with `submit_funeral_enquiry` no longer callable by `anon`. Not built; requires a Turnstile secret as an edge-function secret (a configuration change outside this task).
* Closed-account tokens: fixed for everything in the Notices & Alerts migrations (`active_uid()`, `notices_staff()`); **not** fixed for older surfaces outside this work (e.g. hub / business ownership checks in already-deployed functions, which use `auth.uid()` directly). The platform-level fix is a PostgREST pre-request check or short JWT lifetimes, which are production settings and were not changed.

## Funeral enquiry spam protection (31 Oct 2026)
The "anonymous form can lock families out" blocker is FIXED locally (see `notices-funeral-enquiry-protection.md`). Still required before release: the production secrets/settings listed there; confirmation that the hosted edge supplies `cf-connecting-ip`; a decision on Turnstile widget domain settings. An attacker with many distinct addresses and solved challenges can still consume an announcement's shared 15/day (documented residual risk).

## Funeral enquiry: client address trust (31 Oct 2026) — RELEASE CHECK REQUIRED
Hosted behaviour of `cf-connecting-ip` (present? overwritten when forged?) is NOT verified and cannot be without a deployment. The code uses only that header and refuses (503) when it is absent or malformed. Checks A–F in `notices-funeral-enquiry-protection.md` ("Release verification") must pass before the form is released; A, B and D are release blockers.

## Member notice notifications (31 Oct 2026)
Built and tested locally with a MOCK sender; **no real push has been sent or tested**. Release needs: real-device/Expo verification on a test project (sent vs received, quiet hours, the 2-per-24-hours cap, tap-through to the notice); the existing sender's quiet-hours label (`skipped` instead of `held_quiet`) and fail-open on `should_notify` errors remain for the other audiences (see `notices-member-notifications.md`); no catch-up for held notifications unless approved.

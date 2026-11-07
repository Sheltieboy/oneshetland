# Events & Activities Phase 1 + 2 - release blockers and deploy order

Written 6 Nov 2026 (branch `events-phase2-backend`). Everything is LOCAL. Nothing has been pushed, applied or deployed. Items marked **[DARREN]** need Darren's explicit approval in chat before anyone runs them. Items marked **[CHECK]** are read-only.

## A. Release blockers (must be true before step 1)

1. **Migration collision / history check [CHECK]**: run `node scripts/check-migration-collisions.mjs` from a trusted shell (reads production migration history only). 20261230000000 / 010000 / 020000 must be free and newer than the newest applied version. The repo's migration history is in a reconciliation state (see memory: canonical 281-version branch, `db push` blocked until the repair decision is approved). Applying must use the approved route; do NOT use `supabase db push` or `migration repair` without Darren's decision.
2. **Re-diff `reserve_ticket_basket` against production [CHECK]** immediately before applying (the Phase-1 doc did it on 6 Nov; repeat if any ticketing change was deployed since).
3. **Rolled-back dry run on production [DARREN approves the read-only session] - MUST BE RE-RUN on the FINAL migration text.** The dry run that passed on 6 Nov used the earlier text; migration 20261230010000 has since gained the `events_oneshetland_is_platform` constraint and the explicit `source='oneshetland'` marker (merge of `efdd8e9`). Re-run all three migrations as they now stand, inside one transaction that is ROLLED BACK (about 1 s of lock). Strip each migration file's own `begin;` / `commit;` lines first, otherwise the dry run persists the change.
4. **Social Studio change lives on a SEPARATE branch**: `events-phase2-social` (worktree `/Users/darrenfullerton/Claude/oneshetland-events-phase2-social`, commit 772c4fd on base 5877114, the commit that matches the DEPLOYED functions byte for byte; section D). It is not merged into this branch on purpose. Review and deploy it on its own (step 6).
5. **Web and app reader rules**: the website/app must treat `is_dated_run` events as discrete dates, show community events with `organiser_name`, and show per-occurrence status. Without this, a dated run is mis-shown as a continuous span. (Owned by the web/app workstreams; blocker for step 6 only, not for steps 1-5.)
6. **Staff moderation queue** exists in the web admin before the member-submission switch is opened (step 8).
7. **Per-performance ticketing is NOT done.** Until `docs/per-performance-ticketing-design.md` is built, an event with 2+ dates cannot sell OneShetland tickets; organisers must use an external ticket link. Communicate this to any organiser who asks for ticketed runs. Not a technical blocker for release, but a product expectation to set.
8. Test evidence on file. This branch: `ISOLATED_ONLY=events-occurrences-phase1 npm run test:isolated`, `node --test supabase/tests/ticket-reserve-error.node.test.ts supabase/tests/edge-function-manifest.node.test.ts`. Social branch: `node --test --test-concurrency=1 supabase/tests/social-recipes.node.test.ts supabase/tests/social-autopilot-safety.node.test.ts supabase/tests/social-regular-access.node.test.ts supabase/tests/social-notice-images.node.test.ts supabase/tests/social-event-occurrences.node.test.ts` (201 pass).
9. `test-registration.node.test.ts` currently fails on this branch for reasons that pre-date it (many suites on disk not in any lane); not caused by this work, but it should be cleaned up separately.

## B. Exact deploy order

| # | Step | Needs approval | Notes |
|---|---|---|---|
| 0 | Blockers 1-3 above | [DARREN] for any production session | Read-only. |
| 1 | Apply migration 20261230000000 `event_occurrences` | **[DARREN]** | Add-only. Member-submission switch stays closed. Rollback file exists. |
| 2 | Apply 20261230010000 `event_member_submissions` | **[DARREN]** | Same session as 1 if approved together; in order. |
| 3 | Apply 20261230020000 `event_contributor_self_service` | **[DARREN]** | In order. |
| 4 | Post-apply verification [CHECK] | no | `has_function_privilege('anon', ...)` false on every new function; `reserve_ticket_basket` owner/ACL unchanged; re-run the isolated suite; refresh `supabase/production/*` snapshots per the usual registration. |
| 5 | Deploy `create-event-ticket-intent` (with `_shared/ticket-reserve-error.ts`) | **[DARREN]** | Safe before OR after step 3 (the new string never occurs before), but deploy AFTER so the friendly sentence is live the moment the block can fire. Staged deploy recipe; then update the manifest and remove it from `staged-functions.json` "modified". |
| 6 | Deploy `social-publisher` and `social-composer` (the composer bundles `_shared/social-recipes.ts`, `_shared/social-regular-access.ts`, `_shared/event-occurrence-dates.ts`; the publisher imports the same `social-recipes.ts`, so it must be redeployed to pick up the send-time check) from branch `events-phase2-social` | **[DARREN]** | Tolerant of the migration (separate fail-soft queries; table/columns absent = old behaviour), so order against steps 1-3 is not critical. Deploy the PUBLISHER first (it only ever skips more), then the composer. Check `social.publishing_paused` and recipe switches first; do not change them. Download the live source first and confirm it still hashes to the commit this branch is based on (5877114) so nothing live is overwritten. |
| 7 | Deploy web (reader rules, dated-run display, community attribution, category chip, submit form hidden while the switch is closed) | **[DARREN]** | The web must not query `event_occurrences` before step 1. |
| 8 | App: OTA/build with reader rules | **[DARREN]** | Optional for launch of occurrences; the app only reads. Installed builds never send `occurrence_id` and are safe (see design doc section 9). |
| 9 | Staff acceptance test of member submissions (staff may submit while the switch is closed) | **[DARREN]** to start | Nothing publishes from a staff test submission; it waits in the queue. |
| 10 | Open the flag: set `admin_config` `events.member_submissions` = `open` | **[DARREN]** | Last step. Only after the moderation queue works end to end. Rollback = set it back (instant). |

Rollback order if needed: close the flag; redeploy previous function versions (manifest has the hashes); run the three `.rollback.sql` files in reverse order (no event row is deleted).

## C. What Phase 2 changed in this branch (for review)

- `supabase/functions/_shared/ticket-reserve-error.ts` + `create-event-ticket-intent/index.ts`: friendly 409 for `MULTI_PERFORMANCE`; all other sentences identical.
- Social Studio: moved to branch `events-phase2-social` (see section D). Nothing social remains on this branch.
- `supabase/production/staged-functions.json`: `create-event-ticket-intent` declared as a reviewed, not-yet-deployed change (the drift guard stays green until deployed).
- Tests here: `supabase/tests/ticket-reserve-error.node.test.ts`, registered in the `npm test` lane.

## C2. Attribution rules in Social Studio (decided 6 Nov 2026) - implemented on `events-phase2-social`

Platform ownership (`is_platform_event`) never means "organised by OneShetland" (120 of 153 events are third-party events curated by staff). Community events (`source='community_submission'`) are credited "(shared by <organiser_name>)" in the What's On roundup (one with no usable name is not advertised); curated platform events and `source='oneshetland'` get no organiser wording; `event_spotlight` stays business-owned only and never spotlights anything carrying a source marker. The Regular Activities roundup used to print "(OneShetland)" for platform-owned activities; it now prints no organiser for them. `source`/`organiser_name` are read in a separate fail-soft query, so an old schema behaves as before.

## D. Where the Social Studio code really lives (CORRECTED 6 Nov 2026)

An earlier version of this section said the recipe chain was undeployed and that the repo manifest / `origin/main` reflected production. THAT WAS WRONG. Verified by downloading the live Edge Function source (read-only, into an empty scratch directory) and hashing it:
- live `social-composer/index.ts` b54714f68989..., `_shared/social-recipes.ts` 364bc5f8aa18..., `_shared/social-regular-access.ts` b25bfa062d68..., `social-publisher/index.ts` fb718026f826...; all four equal commit 5877114 ("Social Studio recipes: whitespace tidy and resource wording", branches `social-ac-recipes` and `fetch-safety-pause`).
- So the deployed system IS the 12-recipe lineage, including send-time revalidation (`revalidatePost`), the Regular Activities roundup and the Accessible recipes.
- `supabase/production/edge-function-manifest.json` (social-composer v28, 12a73fca...) is STALE for these functions, and `origin/main` is far behind production. Do not use either to decide what is deployed; download and hash.
- The work was therefore redone on `events-phase2-social` (from 5877114) and removed from this branch.
- Regular roundup: it lists `regular_activities` sessions through the `regular_activities_listing` function, with its own cancelled/break handling, and never touches `events` or `event_occurrences`, so dated-run logic does not apply to it; only its organiser wording was corrected.


## Added 7 Nov 2026: cancelled events keep a public page; reminder-runner fix

- **Migration 3 now adds `events_cancelled_public_read`** (a cancelled event stays openable by link; `is_hidden` stays true so every list that filters on it or on `status='published'` is unchanged) and a guard that a contributor cannot cancel an event with live OneShetland ticket buyers. Two already-cancelled TEST events (a 'DEMO' and a 'ZZ TEST' acceptance event, September) become openable by link; neither appears in any list.
- **`reminder-runner` (Edge Function) fix, independent of the migrations:** the 24h event reminder had no status filter, so a cancelled event with valid tickets would send 'Event tomorrow'. It now requires `status='published'` (test `0b` in reminder-runner-runtime). Deploy it with the other Edge Function (ticket-intent message) step; it is safe before or after the migrations. Not deployed.
- **Follow-ups (not blockers):** mobile `fetchHubEvents`/`fetchPendingHubEvents` have no status filter, so the (unpublished) app's public hub screens would show cancelled hub events; add `status='published'`. Optionally add `e.status='published'` to `search_site` as defence in depth, and let `event_updates_public_read` / `ticket_types_public_read` read cancelled events if an organiser's cancellation note should show on the cancelled page.

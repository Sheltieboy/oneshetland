# Events & Activities Phase 1 + 2 - release blockers and deploy order

Written 6 Nov 2026 (branch `events-phase2-backend`). Everything is LOCAL. Nothing has been pushed, applied or deployed. Items marked **[DARREN]** need Darren's explicit approval in chat before anyone runs them. Items marked **[CHECK]** are read-only.

## A. Release blockers (must be true before step 1)

1. **Migration collision / history check [CHECK]**: run `node scripts/check-migration-collisions.mjs` from a trusted shell (reads production migration history only). 20261230000000 / 010000 / 020000 must be free and newer than the newest applied version. The repo's migration history is in a reconciliation state (see memory: canonical 281-version branch, `db push` blocked until the repair decision is approved). Applying must use the approved route; do NOT use `supabase db push` or `migration repair` without Darren's decision.
2. **Re-diff `reserve_ticket_basket` against production [CHECK]** immediately before applying (the Phase-1 doc did it on 6 Nov; repeat if any ticketing change was deployed since).
3. **Rolled-back dry run on production [DARREN approves the read-only session] - MUST BE RE-RUN on the FINAL migration text.** The dry run that passed on 6 Nov used the earlier text; migration 20261230010000 has since gained the `events_oneshetland_is_platform` constraint and the explicit `source='oneshetland'` marker (merge of `efdd8e9`). Re-run all three migrations as they now stand, inside one transaction that is ROLLED BACK (about 1 s of lock). Strip each migration file's own `begin;` / `commit;` lines first, otherwise the dry run persists the change.
4. **Settle which social-composer lineage is the deployable one** (section D). The change in this branch is to the DEPLOYED single-file composer. The unmerged recipe branches (`social-ac-recipes` tip, in worktrees `oneshetland-social-ac`, `oneshetland-social-recipes`) will need the same three-line change when they are merged. Do not deploy a recipe-branch composer without it.
5. **Web and app reader rules**: the website/app must treat `is_dated_run` events as discrete dates, show community events with `organiser_name`, and show per-occurrence status. Without this, a dated run is mis-shown as a continuous span. (Owned by the web/app workstreams; blocker for step 6 only, not for steps 1-5.)
6. **Staff moderation queue** exists in the web admin before the member-submission switch is opened (step 8).
7. **Per-performance ticketing is NOT done.** Until `docs/per-performance-ticketing-design.md` is built, an event with 2+ dates cannot sell OneShetland tickets; organisers must use an external ticket link. Communicate this to any organiser who asks for ticketed runs. Not a technical blocker for release, but a product expectation to set.
8. Full test evidence on file: `ISOLATED_ONLY=events-occurrences-phase1 npm run test:isolated`, `node --test supabase/tests/ticket-reserve-error.node.test.ts supabase/tests/social-event-occurrences.node.test.ts`, plus `node --test supabase/tests/edge-function-manifest.node.test.ts`.
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
| 6 | Deploy `social-composer` and `social-publisher` (with `_shared/event-occurrence-dates.ts`) | **[DARREN]** | Tolerant of the migration (table absent = old behaviour), so order against steps 1-3 is not critical, but deploy the PUBLISHER first (it only ever skips), then the composer. Check `social.publishing_paused` and recipe switches first; do not change them. If the recipe branches are being released instead, port the change first (section D). |
| 7 | Deploy web (reader rules, dated-run display, community attribution, category chip, submit form hidden while the switch is closed) | **[DARREN]** | The web must not query `event_occurrences` before step 1. |
| 8 | App: OTA/build with reader rules | **[DARREN]** | Optional for launch of occurrences; the app only reads. Installed builds never send `occurrence_id` and are safe (see design doc section 9). |
| 9 | Staff acceptance test of member submissions (staff may submit while the switch is closed) | **[DARREN]** to start | Nothing publishes from a staff test submission; it waits in the queue. |
| 10 | Open the flag: set `admin_config` `events.member_submissions` = `open` | **[DARREN]** | Last step. Only after the moderation queue works end to end. Rollback = set it back (instant). |

Rollback order if needed: close the flag; redeploy previous function versions (manifest has the hashes); run the three `.rollback.sql` files in reverse order (no event row is deleted).

## C. What Phase 2 changed in this branch (for review)

- `supabase/functions/_shared/ticket-reserve-error.ts` + `create-event-ticket-intent/index.ts`: friendly 409 for `MULTI_PERFORMANCE`; all other sentences identical.
- `supabase/functions/_shared/event-occurrence-dates.ts`, `social-composer/index.ts`, `social-publisher/index.ts`: dated runs listed once under their next live date; a run with no live date is skipped at compose and at send time; no Phase-1 column is selected, so the migration is not a dependency.
- `supabase/production/staged-functions.json`: the three functions declared as reviewed, not-yet-deployed changes (the drift guard stays green and will flag them as pending until deployed).
- Tests: `supabase/tests/ticket-reserve-error.node.test.ts`, `supabase/tests/social-event-occurrences.node.test.ts` (with `_support/fake-svc.ts`, `_support/load-social-fns.ts`), both registered in the `npm test` lane.

## C2. Attribution rules in Social Studio (decided 6 Nov 2026)

Platform ownership (`is_platform_event`) never means "organised by OneShetland" (120 of 153 events are third-party events curated by staff). In the composer: community events (`source='community_submission'`) are credited "(shared by <organiser_name>)" in the roundup, and are left out if they have no usable name; curated platform events and the explicit `source='oneshetland'` marker get NO organiser wording; `event_spotlight` stays business-owned only ("Event by <business>") and never spotlights anything carrying a source marker; the roundup's caption brief tells Peerie Bot never to imply OneShetland organised the events. `source`/`organiser_name` are read in a separate tolerant query, so an old schema behaves exactly as before. Covered by the matrix tests in `social-event-occurrences.node.test.ts`.

## D. Where the Social Studio recipe code really lives (audit, 6 Nov 2026)

- The DEPLOYED `social-composer` is a single file, no `_shared/social-recipes.ts`. Its SHA-256 (12a73fca...) equals `supabase/functions/social-composer/index.ts` at this branch's base (the production manifest records version 28), and its recipes are: `wird_of_day`, `whats_on_roundup`, `event_spotlight`, `jobs_roundup`, `new_product`. The deployed publisher has no send-time re-check of any kind (only the pause and the 48h stale guard).
- `_shared/social-recipes.ts` and the twelve-recipe composer (notices, alerts, memories, Business Spotlight, hubs, games, cruise, Regular roundup, Accessible info, send-time re-checks `ORIGINAL_REVALIDATED`, shared daily limit) exist ONLY on unmerged local branches, as a linear chain: `social-recipes-expansion` -> `social-autopilot-safety` -> `social-notice-images` -> `business-spotlight-fairness` -> `social-ac-recipes` -> `fetch-safety-pause` (tip, includes `social-regular-access.ts`). Each of those commits says NOT DEPLOYED, and none of that code matches the production manifest hash. So the memory notes that "recipes shipped" are wrong for the composer/publisher functions: only the SQL seeding and the original five recipes are live.
- `origin/main` is also not the deployed truth: its `social-composer` (sha b9bf33c2...) differs from production's 12a73fca..., so main is behind or diverged. Trust the manifest hash, not main.
- Regular roundup is NOT deployed, so it was not changed here. When the recipe chain is merged, apply the same helper to it: its `selectRegularRoundup`/`eventPromotable`/`#ids=` re-check should call `runBlocksPost` (publisher) and `listOncePerProduction` (composer). Regular Activities are virtual occurrences and are already one row per activity, so the duplicate risk there is low; verify when merging.

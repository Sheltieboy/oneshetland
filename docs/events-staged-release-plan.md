# Events & Regular Activities: staged production release plan

Status: **READY FOR APPROVAL. Nothing in this plan has been executed.** Prepared 7 Nov 2026.
Nothing is applied, deployed, pushed or enabled. Fetch is not touched at any point and stays paused.

## 1. What is being released

| Piece | Branch @ head | What it is |
|---|---|---|
| Database | backend `events-phase2-backend` @ `9d0f4c6` (contains `events-occurrences-phase1` @ `556490d`) | 3 migrations + 3 rollbacks: `event_occurrences`, `events.is_dated_run/organiser_name/source/submission_id`, member submissions + staff moderation, contributor self-service, ticket-sale safeguards, cancelled-event public read, contributor own-event read |
| Edge Functions | same branch | `create-event-ticket-intent` (friendly MULTI_PERFORMANCE sentence, 7 lines), `reminder-runner` (no "Event tomorrow" for cancelled/postponed/draft events, 1 line) |
| Social Studio | backend `events-phase2-social` @ `772c4fd` (built on the DEPLOYED lineage, commit `5877114`) | `social-composer` + `social-publisher` shared modules: dated runs listed once under next live date, community events credited, send-time revalidation of cancelled dates |
| Website | web `events-rc-web` @ `4496a90` (fast-forward of web `main` `2b773a4`, 19 commits, 0 behind) | capability-tolerant loaders, performances/cancelled pages, hidden front door and submission/moderation/contributor screens (all DARK), SEO fixes, deterministic homepage order |

**The release is dark by design.** After every stage below, ordinary visitors see the current site: submissions stay CLOSED (no `events.member_submissions` row), the front door is a 404 (`EVENT_FRONT_DOOR` unset), nothing links to it. Opening it is a separate decision (section 7).

Product decisions already taken (7 Nov): adult wording "I confirm I am 18 or over and am authorised to submit this event."; a cancelled event keeps its public page marked **Cancelled** (lists/calendar/homepage/sitemap/social still exclude it); no notification claims (free-event cancellation notifications are deferred; ticket buyers get the existing business/hub email + in-app path, hub cancel now included); Regular Activities never show "OneShetland" as organiser; a platform-owned event never reads as OneShetland-organised unless explicitly marked.

## 2. Approvals needed (nothing proceeds without each one)

| # | Approval | Needed for |
|---|---|---|
| A1 | Land the backend release branch on backend `main` and push it | history stays canonical (apply, register, land in one sitting) |
| A2 | Apply the 3 migrations to production (permanent) and register them | Stage 1 |
| A3 | Deploy the 2 Edge Functions | Stage 2 |
| A4 | Deploy the 2 Social Studio functions | Stage 3 |
| A5 | Push the website to web `main` (Netlify deploys on push) | Stage 4 |
| A6 | Create clearly-labelled `ZZ TEST` fixtures, a second non-admin test account, and run the signed-in acceptance (writes test data; fixtures are retired, never deleted) | Stage 5 |
| A7 | Open submissions (config row + flag + entry-point links) | Stage 7 (separate, later) |
| A8 | (optional) archive the 2 old cancelled test events that become openable by link | tidy-up |

## 3. Pre-flight (read-only, before Stage 1)

1. **History consistent.** In a clean checkout of backend `origin/main`: `node scripts/check-migration-history.mjs` must print "agree" (283 versions, newest `20261212010000`, none of `20261230*` registered). Last run: 7 Nov, passed.
2. **Fingerprint BEFORE.** `supabase db query --linked -f supabase/production/events-release/production-fingerprint.sql -o json > fp-before.json` (read-only: row counts, data checksums, catalog counts, Fetch state, open transactions). Keep it.
3. **Production quiet.** The fingerprint's `open_txns` and `blocked_now` must be 0. Choose a low-traffic window (the earlier dry runs were at 23:30 to 00:30 UTC). Expect about 15 minutes for Stage 1 and 1 to 2 hours for everything.
4. **Backup.** Darren confirms in the Supabase dashboard that a recent backup (and point-in-time recovery, if enabled) exists. (See the backup/recovery note: restore was proven locally; this plan does not depend on a restore because every step has a rollback below.)
5. **Re-run the dry run if ANY migration file changed since 7 Nov (`cd95190` text).** `node scripts/events-release-dryrun.mjs --ids ids.json > dryrun.sql` assembles the rolled-back dry run from the actual files (strips each migration's own `begin;`/`commit;`, which would otherwise make the dry run permanent; refuses to emit anything that could commit). `ids.json` ids come from the read-only query in the appendix. Run `--minimal` first, then the full run; compare the fingerprint before and after: it must be identical.
6. **Branch heads match this document** (the table above). If any differs, stop and re-verify.

## 4. Stages

Every stage ends with a **gate**: if it fails, stop, do not continue, use that stage's rollback.

### Stage 1: database (A1, A2)

```bash
cd <backend worktree at events-phase2-backend>
for f in 20261230000000_event_occurrences 20261230010000_event_member_submissions 20261230020000_event_contributor_self_service; do
  { printf "set lock_timeout = '1500ms';\nset statement_timeout = '15s';\n"; cat supabase/migrations/$f.sql; } > /tmp/apply-$f.sql
  supabase db query --linked -f /tmp/apply-$f.sql     # ONE migration per call, in this order, stop at the first error
done
supabase migration repair --status applied 20261230000000 20261230010000 20261230020000
node scripts/snapshot-production-migrations.mjs        # refresh the tracked snapshot (283 -> 286 versions)
node scripts/check-migration-history.mjs               # must say "agree"
```
Each migration is its own transaction (it carries `begin;`/`commit;`), takes locks for about 40 ms, and the session timeouts make it fail fast instead of queueing behind customers. Then commit the snapshot and land the branch on backend `main` in the same sitting.

**Gate 1 (post-apply verification, rolled back):**
```bash
# render the 8 ids into the script (never commit the rendered file), run it, judge it
sed -e 's/@@ADMIN_ID@@/<id>/g' ... supabase/production/events-release/post-apply-checks.sql > /tmp/post-apply.sql
supabase db query --linked -f /tmp/post-apply.sql -o json > result.json
node scripts/events-release-check.mjs result.json      # exit 0 and "84/84 criteria passed"
supabase db query --linked -f supabase/production/events-release/production-fingerprint.sql -o json > fp-after.json
```
The script runs real functions under real roles in one rolled-back transaction (permissions, occurrences, ticket safeguards, submissions, moderation, contributor tools, cancelled-event read, the real refund function). In `fp-after.json` the events, ticketing and activities **data checksums and Fetch state must equal `fp-before.json`**; the only differences allowed are the 5 new tables, new functions/policies/triggers and `new_objects_present = 5`. The same script passes 84/84 on a migrated isolated database (test `release verification script`).

**Rollback 1:** run the three `supabase/rollbacks/20261230*.rollback.sql` files in REVERSE order (verified to remove every new object, keep every event row, restore the previous `reserve_ticket_basket`), then `supabase migration repair --status reverted <versions>`. No data is lost: nothing writes to the new tables until submissions open.

### Stage 2: Edge Functions (A3)

Verified 7 Nov: every shared file in both deployed bundles is byte-identical to the branch, and the only differences are the intended ones (ticket-intent 7 lines + new `_shared/ticket-reserve-error.ts`; reminder-runner 1 line). So deploying from the branch worktree ships only those changes. **Re-verify immediately before deploying** (download each deployed bundle into an EMPTY directory and diff; if anything unrelated differs, use the download-and-overlay recipe instead).
```bash
supabase functions deploy create-event-ticket-intent --project-ref nkrtmakxygkvxuxriiil
supabase functions deploy reminder-runner           --project-ref nkrtmakxygkvxuxriiil
```
**Gate 2:** download both back into an empty directory and confirm the hashes equal the branch files; the function settings are unchanged; unit tests pass (`ticket-reserve-error`, `reminder-runner-runtime` 98/98). Do NOT invoke `reminder-runner` by hand (it sends real pushes); check its next scheduled run's result instead. **Rollback 2:** redeploy the previous bundle (kept from the pre-deploy download).

### Stage 3: Social Studio (A4)

1. **Re-hash the live source first.** Download `social-composer` and `social-publisher` into an EMPTY directory; the hashes must be: composer `b54714f6…`, `_shared/social-recipes.ts` `364bc5f8…`, `social-regular-access.ts` `b25bfa06…`, publisher `fb718026…` (all equal commit `5877114`). If different, STOP: someone deployed since.
2. Deploy `social-publisher` then `social-composer` from `events-phase2-social`. Recipe state is not changed (disabled recipes stay disabled; Business Spotlight untouched).
3. **Gate 3:** download back and compare hashes with the branch; run the 201 social tests; at the next composer run (about 05:40 UTC) the drafts must be what they were before (no event has occurrences or a community source yet, so output is unchanged by construction). **Rollback 3:** redeploy the `5877114` files.

This lineage is not on backend `main` (main is behind production for Social). Deploying from the branch is deliberate; landing the lineage on `main` is a separate reconciliation task, not part of this release.

### Stage 4: website (A5)

Fast-forward web `main` to `events-rc-web` and push; Netlify deploys. The code is tolerant either way, and by now the schema is in place.
**Gate 4:** compare against the previous deployment (curl both): `/whats-on` (3 filters), `/whats-on/regular`, `/local`, `/`, 8 real event pages, 3 activity pages must match in text and structured data (the only intended differences are the Phase 1 SEO improvements: real description + own canonical on event pages, activities in the sitemap); `/whats-on/add` must be 404; `/account/event-submissions` and `/admin/events/submissions` must redirect to sign-in; the sitemap must contain the 3 published activities and no cancelled event. **Rollback 4:** Netlify "publish previous deploy" (instant), or revert the merge.

### Stage 5: real database, storage and signed-in checks (A6)

Done by Darren signing in himself in the built-in browser (Claude never types credentials). Use a LOCAL copy of the release candidate run against production with `EVENT_FRONT_DOOR=on`: the dark feature is then reachable only from this machine, with no public exposure and no Netlify change. Fixtures are labelled `ZZ TEST` and are retired (archived/deactivated), not deleted.

| # | Check | How | Pass |
|---|---|---|---|
| R1 | Real RPCs and RLS in production | Gate 1 script | 84/84 |
| R2 | **Storage**: poster upload | Verified read-only 7 Nov: bucket `event-media` is public, 10 MB, jpeg/png/webp; policy "event-media owner write" lets a signed-in user write under their own `<uid>/` folder, so `<uid>/events/<file>` is permitted. Real test: the ZZ member uploads a small PNG in the submission form | object appears at `event-media/<uid>/events/<file>`; the submission is accepted with that `cover_url`; the poster shows on the approved event page; anonymous can read it; the test object is deleted afterwards (owner delete policy) |
| R3 | Dark gating | as admin, as a non-admin member, signed out | admin sees the front door; non-admin and signed-out get 404 |
| R4 | Submission as an ordinary adult member (switch closed, then open for the test window only) | ZZ member submits a 3-performance ZZ pantomime | closed: "not open yet"; open: success page; it appears in My submissions as pending and NOT on the public site |
| R5 | Moderation | admin queue: approve, then a second submission: reject with reason, a third: ask for changes | approved event is public, credited "ZZ organiser" (never OneShetland), one card in lists, 3 calendar days, one homepage card; rejected/changes states show the reason to the member |
| R6 | Contributor tools | member cancels one performance, then the whole event; undo; asks for a change; admin approves; admin trusts the member, a second change auto-applies | performance shows Cancelled, other dates live; whole event: page stays, banner "Cancelled", off lists/calendar/homepage/sitemap; changes behave as designed |
| R7 | Ticketed event regression (existing path) | ZZ business ticketed event with a FREE ticket type; ZZ buyer gets a ticket via the real checkout | ticket issued, shows in My tickets; counters correct |
| R8 | Ticket buyers on cancel | cancel the R7 event as the ZZ business owner, then repeat on a ZZ hub event | the pre-confirm panel shows the buyer count and refund path; the buyer receives the cancellation email + in-app notice (business AND hub); the contributor-cancel of a community event with a buyer is refused with the contact panel |
| R9 | Social | next composer run; admin Social panel | no change to drafts; no errors |
| R10 | Regular Activities | the 3 live activities | unchanged; none says "OneShetland" as organiser |
| R11 | Accessibility/mobile | axe + keyboard on the cancelled page, performances list, form steps, admin queues at 375 and 1280 | no new violations (known pre-existing: site header/footer) |
| R12 | App compatibility | the parent `starts_at/ends_at` of a run stays first/last live date; the app (unpublished; build 148 in review) reads those columns | unchanged for every existing event |

**Gate 5:** every row passes. Then retire the fixtures, remove the test upload, make sure `events.member_submissions` has no row (closed) and the Netlify flag is unset.

### Stage 6: observation period

At least 24 hours dark before Stage 7. Watch: Netlify function errors; Supabase logs for 42501 / PGRST errors on `events`; the next two composer runs; `reminder-runner` results; ticket purchase success; the pending count in the admin queue (should stay 0).

### Stage 7: opening submissions (A7: a separate decision, not part of the stages above)

Preconditions: staff are ready to moderate and know the expected response time; the Community Guidelines gain one line that under-18s can contribute material but an adult submits it and is responsible (NOT yet written); the "Add an Event or Activity" entry points (What's On, Regular Activities, account, mobile menu, empty states) are designed and built (NOT yet built: the front door is currently linked from nowhere); Darren approves the wording of what members see.
Open: insert `admin_config('events.member_submissions','open','events')`, set `EVENT_FRONT_DOOR=on` in Netlify, deploy the entry-point links.
**Instant kill switch:** set the config value to anything but `open` (or delete the row): the database refuses all new submissions immediately; unset the flag to hide the UI. Existing events and approved submissions are unaffected.

## 5. Rollback matrix

| Stage | Rollback | Data impact |
|---|---|---|
| 1 | 3 rollback files in reverse + `migration repair --status reverted` | none (new tables empty until opening) |
| 2 | redeploy previous bundles | none |
| 3 | redeploy `5877114` files | none |
| 4 | Netlify previous deploy | none |
| 7 | close the switch / unset the flag | submissions made so far stay (reviewable) |

## 6. Known limitations and deferred work (not release blockers)

- **Proper per-performance OneShetland ticketing** is the desired end state (design: `docs/per-performance-ticketing-design.md`, about 24 working days). Until then OneShetland ticket sales are blocked for events with 2+ live performances in the database (`MULTI_PERFORMANCE`); an external ticket link is allowed; the public page shows "Ticket details come from the organiser".
- **Free-event cancellation notifications** are deferred; organisers are told plainly that OneShetland does not send them yet.
- A whole-event cancellation leaves the page up marked Cancelled, but the organiser's cancellation note (updates feed) and ticket types are not shown publicly (those policies still use `NOT is_hidden`).
- Two old cancelled test events (a "DEMO" and a "ZZ TEST" acceptance event, September) become openable by link; neither appears in any list. Optional tidy-up A8.
- Mobile app (unpublished): `fetchHubEvents` has no status filter, needs the Theatre category and cancelled-event handling. Site search (`search_site`) could add a published filter as defence in depth. Hub members-only cancelled events stay private by design.
- Business/hub activities and the Regular Activities RPC `regular_activities_listing` still return the string "OneShetland" when no owner is readable; the website ignores it (follow-up: return NULL).
- `ConfirmProvider` (shared dialog) no longer confirms on Enter when pressed on a link or button; used site-wide, review when merging.
- Pre-existing lint errors remain in `social-image/route.tsx` (3), `EventsManager.tsx` (2), `ConfirmProvider.tsx` (1); counts are identical on production `main`.
- Co-managing an event by a second adult, a staff UI to set the explicit OneShetland marker, and a staff reassignment tool are later work.

## Appendix: finding the 8 ids for the scripts (read-only)

```sql
select jsonb_build_object(
 'ADMIN_ID',(select id from public.profiles where role='admin' order by created_at limit 1),
 'MEMBER_ID',(select p.id from public.profiles p where coalesce(p.role,'user') not in ('admin','moderator')
    and not exists(select 1 from public.local_businesses b where b.owner_id=p.id) and not exists(select 1 from public.hub_members h where h.user_id=p.id)
    and not exists(select 1 from public.hubs h2 where h2.owner_id=p.id) order by p.created_at desc limit 1),
 'BUSINESS_OWNER_ID', ..., 'BUSINESS_ID', ..., 'BUSINESS_EVENT_ID', ...,
 'PLAIN_PLATFORM_EVENT_ID',(select id from public.events where is_platform_event and status='published' and starts_at>now()
    and not exists(select 1 from public.event_ticket_types t where t.event_id=events.id) order by starts_at limit 1),
 'TICKETED_EVENT_ID', ..., 'TICKET_TYPE_ID', ...)::text;
```
The business owner/business/event come from a future published business-owned event whose owner exists and which has no ticket types; the ticketed event/type from any existing ticket type. Do not use the ZZ test member for MEMBER_ID (the script acts as that user inside a rolled-back transaction).

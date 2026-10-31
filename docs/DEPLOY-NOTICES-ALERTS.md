# Notices & Alerts — production deployment, activation and recovery plan

STATUS: **NOTHING HAS BEEN APPLIED, DEPLOYED OR PUBLISHED.** Everything below is a plan for an approved release. Production project: `nkrtmakxygkvxuxriiil`. One Supabase CLI at a time; no wholesale production-linked test runs.

## 0. What ships, in dependency order
| # | Piece | Where | Reversible by |
|---|---|---|---|
| 1 | `20261129000000` publishers / entitlement / audit | database | `supabase/rollbacks/20261129000000_*_rollback.sql` (destroys the audit log: export first if any real grant exists) |
| 2 | `20261129010000` essential designation, official publishing, public reads | database | rollback script (notices stay; essential columns dropped) |
| 3 | `20261129020000` member areas, preferences, dispatch machinery | database | rollback script (destroys areas/opt-ins/delivery history) |
| 4 | `20261129030000` funeral notices | database | rollback script (destroys submissions: export first if any real exist) |
| 5 | `20261129040000` official-import framework (all sources disabled) | database | rollback script |
| 5b | `20261129050000` members publish notices (moderated): submit / list / edit / withdraw / staff approve & decline | database | rollback script (the notices members already posted stay) |
| 5c | `20261129060000` funeral privacy: account-deletion cleanup, memberships, retention (dry-run, gated OFF), no-account enquiries, audit redaction | database | rollback script (does not restore data already removed by a cleanup) |
| 5d | `20261129070000` funeral enquiry protection: `submit_funeral_enquiry` becomes service-role only + per-client limit policies (needs `20260821280000`) | database | rollback script (reopens the insecure anon call: only with the old website) |
| 6 | edge: `notify-hub-content` (R2 fix), `notify-notice-audience`, `notify-funeral-notice`, `import-official-notices` | functions | redeploy the previous `notify-hub-content`; delete the three new functions |
| 7 | website (`notices-alerts-web`) | Netlify | redeploy previous build |
| 8 | app (`notices-alerts-app-ui`, JS-only) | OTA / next build | OTA rollback to previous bundle |
Every migration is additive and proven to roll back and re-apply (`notices-alerts-rollback` suite). Old installed apps keep working unchanged (see §5).

## 1. Before anything (read-only checks on production)
1. Confirm applied migrations end at `20261128010000` (Supabase migration list).
2. Confirm prerequisites exist: `public.is_hub_admin(uuid, uuid)`, `public.is_business_owner(uuid, uuid)`, `public.attribution_staff()`, `public.areas`, `public.notice_categories` (9 rows), `public.notice_areas`, `public.profiles.display_name`, `public.profiles.is_platform_owner`, `public.hub_members(status, paid_until)`, `public.hubs(logo_url, brand_color, slug)`, `public.local_businesses(logo_url, brand_color, slug)`.
3. Confirm `notices` has 1 live notice (the original) and note its md5 (the suite proves it stays byte-identical).
4. Take a backup / confirm PITR window. Record the current deployed versions of `notify-hub-content` and `notify-community-notice`.

## 2. Apply (staged, with verification after each step)
Apply 1 → 5 (and 5b) one at a time (`supabase db push` of a single file, or SQL editor), and after each:
* `select count(*) from public.notices;` unchanged; `select count(*) from public.official_publishers;` = 0; `select count(*) from public.essential_alert_grants;` = 0 (**no entitlement exists until an administrator grants one**).
* An anonymous request to `get_public_notices` returns exactly the live notice; `get_essential_alerts` returns `[]`; `get_funeral_notices` returns `[]`.
* An anonymous request to `admin_list_official_publishers`, `notice_dispatch_recipients`, `can_dispatch_notice` is refused (`42501`). (The PostgREST suite `run-notices-alerts-api.sh` proves these on both PostgREST versions.)
* Old-client read shapes still return the same rows (suite test 10).

## 3. Edge functions (after the database, before clients)
Deploy in this order, each with `verify_jwt = true` (the functions also authorise the caller themselves):
1. `notify-hub-content` — **the R2 fix**. Verify with a hub owner on a TEST hub: a real new notice announces once to members; calling again returns 409; a made-up `ref_id` returns 404/400. (The old behaviour — announcing any `ref_id` — is gone.) Do not test with real members.
2. `notify-notice-audience`, `notify-funeral-notice`.
3. `submit-funeral-enquiry` — deploy ONLY with its secrets set (it answers 503 until all are) and in the same release as `…070000` and the website; see `docs/notices-funeral-enquiry-protection.md`.
4. `import-official-notices` — deploy, but **do not install the cron** (`supabase/deploy/notices-import-cron.sql` stays commented). With every source disabled it does nothing even if called.
Confirm `notify-community-notice` (the island-wide admin broadcast, deployed in Stage 3A.1) is untouched and still refuses imports.
Secrets: none new (uses `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` that already exist).

### 3b. delete-account (Edge Function) — ordering and failure rule
`supabase/functions/delete-account` calls `delete_member_notice_data` (created in `…020000`), `delete_member_funeral_data` and `delete_member_memberships` (both created in `…060000`). **Apply migrations 1 → 5c first, then deploy `delete-account`.** A function that does not exist yet is reported `skipped: not present yet` (so deploying early is safe but does nothing for that data); once the functions exist, any other failure in those steps (or in removing a staff role) is a critical failure: the deletion stops before the profile scrub and auth soft-delete and answers HTTP 500 with the failed steps, the account stays usable, and a retry completes it (all steps are idempotent). Verify with a throwaway account on a TEST project: `steps.notice_member_data`, `steps.funeral_notices`, `steps.organisation_memberships` and `steps.demote_privileges` must each be `ok`. Rolling `…060000` back drops its functions; the deployed function then skips those steps. Full detail and the retention policy: `docs/notices-account-deletion-and-retention.md`.

### 3c. Funeral retention job — NOT scheduled
`funeral_retention_run` is service-role only, defaults to a dry run, and refuses a real run while `notice_privacy_settings.funeral_retention_enabled` is false (the default). Nothing schedules it. Before enabling: owner approval of the periods, a reviewed dry run (`select funeral_retention_run(true)` as service role, or the Admin → Notices → Privacy report), then `admin_set_funeral_retention_enabled(true, '<release approval reference>')`, then decide the cadence.

## 4. Activation (deliberate administrator actions — none is automatic)
Done by a platform administrator after the release is live; each is audited in `notice_audit_log`.
1. Create the real Council organisation: `admin_upsert_official_publisher('shetland-islands-council', …)`; **verify** it (`admin_verify_official_publisher` with a note describing how identity was established); add the Council's authorised accounts (`admin_set_official_publisher_member`, role `publisher` for those who may mark alerts essential, `delegate` for the rest); only then `admin_grant_essential_alert`.
2. NHS Shetland and others: create and verify; grant the entitlement only when explicitly approved.
3. Funeral directors: `admin_set_funeral_director` (verify) per firm. Moderators handle the funeral queue.
4. Import sources: stay disabled (see `docs/notices-import-sources.md`). To enable one: written reuse confirmation → `admin_upsert_import_source` → `admin_set_import_source_enabled(..., '<how confirmed>')` → supervised first run → then (and only then) install the schedule.
5. Announcing: a publisher presses "Notify opted-in members" once per alert; editing/resolving never notifies. Members receive nothing until they opt in.

## 5. Old installed apps (builds 144–148 and the OTA stream)
* They read `notices` directly. The public-only read policy is unchanged, so they never see pending, withdrawn, resolved (including a resolved essential alert), hidden, scheduled, expired or members-only rows, and never see funeral notices (a separate table).
* An active essential alert is an ordinary published platform notice with severity `urgent`: those builds show it as an urgent notice, with the labelling they give every platform notice. They do not get the new top slot, filters or preferences until updated. Nothing breaks.
* No existing function, policy or column they use is altered. `manage_notices` etc. return the (wider) row type; released builds do not call them.

## 6. Website, then app
Recommended order: **database → edge functions → website → app (JS-only OTA after a build/OTA decision)**. The website can ship first because it is read-only until publishers/members sign in; the app gains the same features later and old builds are unaffected. Nothing in this change needs a new native build.

## 7. Recovery
* **Bad function deploy:** redeploy the previous version (notify-hub-content previous bundle; delete the three new functions). The database remains safe: dispatch is refused without the claim.
* **Wrong entitlement granted:** `admin_revoke_essential_alert(publisher, reason)` — live alerts are demoted (kept as ordinary official notices), nothing disappears in an incident. Wrong notice published: `official_set_notice_status(..., 'withdrawn')` or `manage_set_notice_status`.
* **Funeral notice published in error / family request:** `admin_funeral_takedown` is immediate; the submitter can also withdraw.
* **Roll a migration back:** reverse order with the scripts in `supabase/rollbacks/`; export `notice_audit_log` / funeral tables first if real data exists. Forward recovery (re-apply) is proven.
* **Unwanted notification sent:** a dispatch cannot be recalled; the audit log and `admin_notice_dispatch_history` show exactly who was sent what. Prevent by keeping publisher entitlement narrow.

## 8. Known limitations at release (also in the final report)
R2's sibling for the `event` branch of `notify-hub-content` is unchanged; person-name lookup still takes up to 1.5 s on first view; funeral photographs require an https URL (no upload flow); imports default to Shetland-wide because feeds carry no area; essential-alert creation is web-only; no real push, email or device-delivery verification has been possible locally (mocked sender only).

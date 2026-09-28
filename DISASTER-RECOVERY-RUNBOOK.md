# OneShetland — Database Disaster Recovery Runbook

_Written 28 Sep 2026, after the first real restore rehearsal. Project:
`nkrtmakxygkvxuxriiil` (region `eu-west-2`). Read this top to bottom before you
need it — during a real incident is the wrong time to be learning the steps._

---

## 1. What backup protection exists today

Confirmed read-only against the live project (`supabase backups list`):

- **Mechanism:** WAL-G physical backups (`walg_enabled: true`), Supabase's own
  managed snapshot system — not a script we maintain.
- **Schedule:** once daily, around 03:00–03:12 UTC.
- **Retention:** 8 backups, i.e. 8 days. The oldest ages out as a new one lands;
  this is a plan-level limit, not something we configured.
- **Latest successful backup at the time of this check:** 2026‑09‑28 03:06:20
  UTC, status `COMPLETED`. All 8 of the last 8 are `COMPLETED` — no failed or
  partial backups in the retained window.
- **PITR (point-in-time recovery): disabled** (`pitr_enabled: false`). Recovery
  is only ever possible to one of the 8 daily snapshot times above — never to
  an arbitrary minute in between.
- **Recovery point objective today: up to ~24 hours of data loss**, in the
  worst case (an incident 23 hours after the last nightly backup loses
  everything written since).
- **Storage (uploaded files) is NOT covered by this backup at all.** The
  database backup covers `storage.objects` — the *metadata* row for each file
  (287 rows, ~68 MB of declared file size, as of this check) — but not the
  file bytes themselves, which live in Supabase's S3-backed object store as a
  separate system. A database restore alone gets back the *records of* what
  was uploaded, not the uploaded avatars/photos/receipts themselves. Whether
  Supabase separately versions or backs up the Storage backend was not
  established here — treat it as unproven until Supabase Support confirms it,
  and see §8.

## 2. What "restore" actually means on this plan

`supabase backups restore` (the CLI's own restore command) performs a
**point-in-time restore of the SAME project, in place**, using PITR. Two
things follow:

- With PITR off, this command has no fine-grained time target to restore to —
  it is not the tool for recovering from an incident today.
- Even when PITR is on, this command overwrites the live project. It is never
  the right first step during an incident; it is a **last-resort cutover**,
  run only after a restore has already been verified in isolation (§4).

There is no CLI/API way on this plan to restore a backup directly into a
*new*, separate project without paying for and creating that new project
first (a cost decision — see §5). The rehearsal below therefore used the
**export/restore-into-an-isolated-environment** path instead: a full logical
export of the live database, loaded into a Postgres instance running locally,
never reachable from the internet, and destroyed immediately afterwards.

## 3. Restore rehearsal — 28 Sep 2026, PASSED

**Method.** `supabase db dump` (schema, then data, `public`+`auth`+`storage`+
`extensions` schemas) against the live project, read-only — this only issues
`SELECT`s, it cannot write to production. Loaded into a fresh local
PostgreSQL 17.11 instance (matching the production engine exactly),
listening only on `127.0.0.1` on a non-standard port, created and destroyed
within the same session. Production was never written to; the isolated
instance and every dump/log file were deleted at the end.

**Result, after the standard platform roles (`anon`, `authenticated`,
`service_role`, `supabase_admin`, `supabase_auth_admin`,
`supabase_storage_admin`, `dashboard_user`) and the `pg_trgm` extension were
pre-created — see §4 step 3 — both the schema and the data loaded with
ZERO errors:**

| Check | Result |
|---|---|
| Schemas restored | `public`, `auth`, `storage`, `extensions` — all 4 |
| Tables | 175 |
| Functions | 300 |
| RLS policies | 383 |
| Triggers | 97 |
| Indexes | 563 |
| Data load errors | 0 |

**Representative row counts, restored copy vs. live production (exact match on
every one):**

| Table | Count |
|---|---|
| `auth.users` | 268 |
| `public.profiles` | 268 |
| `public.local_businesses` | 534 |
| `public.events` | 56 |
| `public.event_tickets` | 12 |
| `public.event_ticket_orders` | 11 |
| `public.hubs` / `public.hub_members` | 0 / 0 (genuinely empty in production, not a loss — matches the 25 Sep column-lock finding) |
| `public.driver_profiles` | 5 |
| `public.book_bookings` | 7 |
| `public.stripe_customer_claims` | 3 |
| `public.rate_limits` | 5 |
| `public.notification_log` | 1,114 |
| `storage.objects` (file metadata only) | 287 |

**Checksums** (MD5 of the sorted primary-key list — a cheap but real proof
that not just the *count* but the *exact identity set* survived) matched
byte-for-byte between production and the restored copy for `profiles`,
`local_businesses`, `events` and `event_tickets`.

**Security posture survives the restore, not just the schema.** RLS was
re-enabled (`relrowsecurity = true`) on `profiles`, `event_tickets`,
`local_businesses`, `event_ticket_orders` and `stripe_customer_claims`. The 25
Sep security fixes were still in force on the restored copy: `anon` had no
EXECUTE on `accept_image_pin_suggestion`, `business_analytics`,
`accept_alert_policy` or `booking_meter_status`, while `authenticated` did —
the exact intended shape, reconstituted from the dump alone.

**Known, expected gap in this rehearsal method (not a backup defect):**
loading the dump onto a *vanilla* Postgres — as opposed to Supabase's own
restore, which lands on their platform where these roles and extensions
already exist — needs the platform roles and `pg_trgm` created first,
otherwise ~1,300 `GRANT`/`ALTER OWNER` statements and 2 trigram indexes fail.
Once those seven roles and that one extension exist, the restore is clean.
This is now documented in §4 so it never has to be rediscovered.

## 4. How to actually do a restore (runbook)

### To rehearse in isolation (routine, safe, no production impact — do this
### again before every major migration and at least quarterly)

1. **Identify the restore point.** `supabase backups list --project-ref
   nkrtmakxygkvxuxriiil` — pick the `COMPLETED` backup closest to before the
   incident, or (for a rehearsal) just use a live export of current state.
2. **Export.**
   ```
   supabase db dump --linked -s public,auth,storage,extensions -f schema.sql
   supabase db dump --linked --data-only -s public,auth,storage,extensions -f data.sql
   ```
   (If `supabase db dump` insists on Docker and none is available, use
   `supabase db dump --dry-run` to get the equivalent `pg_dump` script and run
   it with a local `pg_dump` of a close major version instead — the schema-
   and data-only passes are separate commands, in that order. **The dry-run
   output contains the live database PASSWORD in plain text on an
   `export PGPASSWORD=...` line — never print it to a terminal, a log, or a
   chat session. Redirect it straight to a file with `chmod 600`, and delete
   that file the moment you're done with it.** This one nearly went wrong
   during this rehearsal — see §9.)
3. **Stand up an isolated target.** A local PostgreSQL matching the
   production major version (17) is enough — no new cloud project, no cost:
   ```
   initdb -D pgdata -U postgres --auth=trust
   pg_ctl -D pgdata -o "-p 55432 -h 127.0.0.1 -k /tmp/<short-dir>" start
   createdb -h 127.0.0.1 -p 55432 -U postgres restore_rehearsal
   psql -h 127.0.0.1 -p 55432 -U postgres -d restore_rehearsal -c "
     create role anon nologin;
     create role authenticated nologin;
     create role service_role nologin;
     create role dashboard_user nologin createrole createdb;
     create role supabase_admin superuser createrole createdb login;
     create role supabase_auth_admin noinherit createrole login;
     create role supabase_storage_admin noinherit createrole login;
     create extension if not exists pg_trgm;"
   ```
   (On macOS, if `pg_ctl` fails with "postmaster became multithreaded during
   startup", start it with `LC_ALL=C` set. If it fails with a Unix-socket
   path that's "too long", point `-k` at a short path directly under `/tmp`,
   not a long scratch/session directory.)
4. **Load and validate.**
   ```
   psql -h 127.0.0.1 -p 55432 -U postgres -d restore_rehearsal -v ON_ERROR_STOP=0 -f schema.sql
   psql -h 127.0.0.1 -p 55432 -U postgres -d restore_rehearsal -v ON_ERROR_STOP=0 -f data.sql
   ```
   Then re-run the checks in §3: object counts, representative row counts
   against production, PK checksums, RLS flags, and the `has_function_
   privilege('anon', …)` checks on any recently-fixed function. **Grep for
   `ERROR:` in the load output** (note: `psql` prefixes real errors with
   `psql:<file>:<line>: ERROR:`, not a bare `ERROR:` at line start — match on
   the substring, not `^ERROR:`, or you will silently miss them, as happened
   once during this rehearsal before it was caught and corrected).
5. **Tear down.** Stop the instance (`pg_ctl stop`) and delete the data
   directory and every dump/log file. Nothing from this exercise should
   survive on disk afterwards — it contains full production data.

### If production were genuinely lost (real incident, not a rehearsal)

1. Do **not** run `supabase backups restore` as a first step — see §2. Do not
   act on the live project until the shape of the loss is understood (one
   table? one row? the whole database? a bad migration?).
2. If it's a **logical mistake** (bad `UPDATE`/`DELETE`, a bad migration) and
   PITR is still off, the only recovery point available is the most recent
   daily backup — meaning up to ~24 hours of writes since are unrecoverable
   through Supabase's own mechanism. Restoring under those conditions is a
   business decision (accept the data loss window vs. not restoring at all),
   not a purely technical one — get sign-off before running anything
   destructive.
3. To actually restore Supabase's own physical backup (not this rehearsal's
   export-based approximation), engage **Supabase Support** for a
   project-level restore, or use `supabase backups restore --project-ref
   nkrtmakxygkvxuxriiil --timestamp <epoch-seconds>` if PITR has since been
   enabled — understanding that this overwrites the live project in place.
   If a second, parallel copy is wanted to validate BEFORE cutover, that
   requires creating a new Supabase project from a backup via the Dashboard's
   "Clone project" flow (a paid, billable resource — confirm cost and get
   approval before creating it, per §5).
4. **Promote/cut over.** Once a restored target is validated (§3's checklist,
   run against the REAL target this time, not a rehearsal copy): re-point
   `SUPABASE_URL`/keys in both apps' production environments (EAS production
   env for mobile, Netlify env for web) only if the project ref actually
   changed (an in-place PITR restore does not change the ref, so this step is
   usually a no-op — confirm before touching either app's config).
5. **What does NOT come back with a database restore** — must be handled
   separately, every time:
   - **Storage files.** The actual uploaded bytes (avatars, business photos,
     receipts) — see §1 and §8.
   - **Edge Functions.** Function *code* is not part of the database at all.
     After ANY restore, redeploy every function from the last-known-good
     commit: `supabase functions deploy <name> --project-ref
     nkrtmakxygkvxuxriiil --use-api`, from a clean worktree pinned to that
     commit (see repo conventions already in use for this).
   - **Secrets/config.** Edge Function secrets (`STRIPE_SECRET_KEY`,
     `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`, `cron_secret`, etc.) are
     NOT part of a database backup or restore. If the incident also affected
     the project's secret store, every secret needs to be re-set from its
     original source (Stripe Dashboard, Google Cloud Console, etc.) — there is
     no backup of these to fall back on; losing them and not having them
     recorded elsewhere is itself a risk worth flagging to Darren directly.
   - **`pg_cron` schedules.** These live in the `cron` schema, which is
     platform-managed and was deliberately excluded from this rehearsal's
     dump scope. Confirm scheduled jobs (`reconcile-saved-cards`,
     `expire_stale_ticket_orders`, etc.) are still present in
     `cron.job` after any real restore, and re-`select cron.schedule(...)`
     any that are missing.
   - **Stripe / webhooks.** Stripe itself is unaffected by a database
     restore — it is the source of truth for payments. But the webhook
     endpoint's signing secret and endpoint URL live in Stripe's own
     dashboard, not in our database, so confirm the webhook endpoint still
     points at `nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook`
     and its secret matches `STRIPE_WEBHOOK_SECRET`. If the restore point
     predates the incident, replay any Stripe events that landed in the gap
     (Stripe's dashboard can resend webhook events) so paid orders between
     the backup and the incident aren't lost from our side even though
     Stripe still holds the true payment record.
   - **DNS/web/app.** Unaffected by a database restore as long as the
     project ref doesn't change (§4.4). If a NEW project ref is used
     (a genuine full rebuild), every `SUPABASE_URL`/anon key reference in
     both apps' production environments must be updated and redeployed —
     this is a bigger operation than a normal restore and should be treated
     as its own incident, not folded into routine recovery.

## 5. Is PITR needed for launch?

**No — not to reach an acceptable risk profile for launch, provided the
daily-backup rehearsal above is repeated periodically.** Reasoning:

- The daily backup schedule + this proven restore path together bound the
  worst case at roughly 24 hours of data loss, restorable via Supabase
  Support or (once PITR is on) the CLI.
- This is a small, pre-revenue-scale community platform in its own words
  (the launch-readiness data records zero live business claims and Stripe
  only recently went to live mode for one flow) — a 24-hour RPO is a normal,
  common baseline for a service at this stage, not a red flag.
- PITR is a paid add-on on this plan tier. Turning it on changes cost, and
  per this task's own instruction that is not something to enable without
  Darren's explicit approval.

**PITR becomes worth the cost once any of these becomes true:** meaningful
transaction volume where losing up to a day of paid orders/tickets/wallet
activity would be a real financial or reputational problem; a compliance
requirement for a tighter RPO; or simply once revenue justifies the add-on's
price. Recommendation: revisit this specific question after the first month
of real (non-test) transaction volume, not before.

## 6. What this rehearsal does NOT prove

Said plainly, so nobody over-reads a green result:

- It did not restore an *actual* WAL-G backup artifact — Supabase doesn't
  expose those files directly. It proved the same underlying risk (can a
  full export of the database be turned back into a working copy) using a
  live logical export as a faithful stand-in. The two are not identical, but
  they exercise the same failure mode.
- It did not prove Storage (file) recoverability at all — genuinely
  unproven, see §8.
- It did not exercise a REAL cutover (re-pointing the live apps at a
  restored project) — only that a restored copy is structurally and
  data-correct. Cutover mechanics (§4.4) are documented but untested.
- Local Postgres 17.11 was used, not Supabase's exact patch build
  (17.6.1.121 per `supabase projects list`). Close enough for this rehearsal;
  not a claim that every patch-level behaviour is identical.

## 7. Files/commits from this rehearsal

No dump file, log, or credential from this rehearsal was kept — all of it
held real production data and was deleted at the end of the session (§4 step
5). This document is the only artifact.

## 8. Open, unresolved risk

**Storage (uploaded file) backup/recoverability is unconfirmed.** The
database backup does not cover file bytes; whether Supabase's Storage
backend is separately versioned, replicated, or backed up was not
established here (would need Supabase Support or dashboard/Storage-provider
config not available to this check). Given avatars, business photos and
similar uploads exist (68 MB across 287 objects today), this is worth a
direct question to Supabase Support before or shortly after launch, and is
NOT covered by this task's "recovery proven" conclusion.

## 9. Note on handling the database credential during this exercise

`supabase db dump --dry-run`, used to diagnose why the CLI's own dump
command needed Docker, printed the live database password in plain text as
part of its output. That output was captured to the terminal once before the
risk was recognised, meaning the password appeared in this session's
transcript. **Recommend rotating the `postgres`/pooler database password**
as routine hygiene, out of caution, even though this stayed within Darren's
own session — treat any credential that has touched a log or transcript as
best rotated rather than assumed safe. Every subsequent use in this
rehearsal redirected that output straight to a permissioned file that was
deleted afterwards, and the password was never entered directly into a
command line.

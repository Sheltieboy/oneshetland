# Fetch safety pause (migration 20261212000000)

Applied to production 6 Nov 2026. Recorded in migration history as `20261212000000 fetch_safety_pause`.

## What it does
1. **Privacy (permanent).** Dropped `delivery_requests` policies: "Approved drivers can read all pending requests", "Approved drivers can read pending requests" (any approved driver saw every pending
   address/phone), "Approved drivers can accept pending requests" and "Drivers must have bank connected to accept requests" (any driver could change any request). A driver now reads only requests on their own run.
2. **Pause (switchable, fail-closed).** `admin_config` key `fetch.operations` is `paused`. Only the exact value `open` enables: new requests, accepting (status -> matched), direct client edits of requests, new runs,
   new driver applications, and approving a driver (status -> approved). Guard triggers `delivery_requests_a_fetch_pause`, `runs_a_fetch_pause`, `driver_profiles_a_fetch_pause` apply to the API roles
   (anon, authenticated, service_role). NOT blocked: cancel/refund/capture of an existing job through the server functions, rejecting or suspending a driver, SQL run as the database owner.
3. **Website.** `app/fetch/layout.tsx` (web repo) renders "Being prepared for launch" for every `/fetch` route unless `fetch_is_open()` is true.

## Files
- `supabase/migrations/20261212000000_fetch_safety_pause.sql`: the migration.
- `supabase/rollbacks/20261212000000_fetch_safety_pause.rollback.sql`: exact reversal (restores the exposure). Deliberately NOT in `migrations/`.
- `supabase/tests/fetch-safety-pause.verify.sql`: rolled-back verification against production with real role impersonation. Run any time:
  `supabase db query --linked -f supabase/tests/fetch-safety-pause.verify.sql` (every check should read as in the 6 Nov run: stranger driver sees 0 pending rows and 0 phones; create/accept/run/apply/approve BLOCKED).
- `supabase/tests/fetch-safety-pause.node.test.ts`: repository guards (part of `npm test`).
- `scripts/check-migration-history.mjs`: read-only collision / out-of-order check against production history.

## Reopening Fetch
Only with Darren's explicit approval, as a separate, deliberate act (not inside a feature migration):
`update public.admin_config set value = 'open' where key = 'fetch.operations';`  Re-run the verify script first and read what "driver_accepts_when_open" will then allow.

## Rules for any future change
- Before deploying ANY branch with migrations: `node scripts/check-migration-history.mjs`. Fix every COLLISION / OUT-OF-ORDER by renumbering the unapplied file ABOVE the newest applied version.
- A migration after 20261212000000 must not re-create the four dropped policies, touch `fetch.operations`, drop the guards, or add a SECURITY DEFINER function that writes `delivery_requests`/`runs`/`driver_profiles`
  without calling `public.fetch_is_open()` (definer functions run as the owner, which bypasses the guard triggers). `fetch-safety-pause.node.test.ts` enforces this.
- Never apply a rollback file, and never rebuild a database from a branch that lacks migration 20261212000000 (the baseline recreates the dangerous policies).

## Known repository state (6 Nov 2026)
- The migration lives on branch `fetch-safety-pause` (tag `fetch-safety-pause-2026-11-06`), pushed to origin. `origin/main` is far behind production and does NOT contain it.
- Fetch v2 migration files (branches fetch-v2, fetch-v2-rc) reuse version numbers 20261127000000-20261208000000 that production already applied for other migrations: they must be renumbered before any deployment.
- `20261122000000_shift_employer_stripe_customer_lock.sql` shares its version with production's `jobs_structural_readiness`; its protection IS live (column not readable by anon/authenticated) but its history entry is missing.

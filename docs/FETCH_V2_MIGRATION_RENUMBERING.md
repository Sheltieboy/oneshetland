# Fetch v2 migration renumbering (6 November 2026)

The twelve Fetch v2 migrations were written as 20261127000000 to 20261208000000. Production had meanwhile applied OTHER migrations under those exact version numbers
(geography, notices, analytics, Social Studio, home pin, business discovery, regular activities and more), so `supabase db push` would have treated every v2 migration as
already applied and silently skipped it. They are renumbered above production's newest version (20261212000000). Content is unchanged except where stated.

| Was | Now | Name |
|---|---|---|
| (new) | 20261213000000 | fetch_pause_covers_all_api_paths (pause guards now cover SECURITY DEFINER functions) |
| 20261127000000 | 20261214000000 | fetch_v2_feature_flag (**edited**: fetch_v2_audience() is `off` unless the master pause is open) |
| 20261128000000 | 20261215000000 | fetch_v2_data_model |
| 20261129000000 | 20261216000000 | fetch_v2_access_boundary |
| 20261130000000 | 20261217000000 | fetch_v2_lifecycle |
| 20261201000000 | 20261218000000 | fetch_v2_pricing_terms |
| 20261202000000 | 20261219000000 | fetch_v2_payments |
| 20261203000000 | 20261220000000 | fetch_v2_driver_verification |
| 20261204000000 | 20261221000000 | fetch_v2_matching |
| 20261205000000 | 20261222000000 | fetch_v2_notifications |
| 20261206000000 | 20261223000000 | fetch_v2_messages_issues_photos |
| 20261207000000 | 20261224000000 | fetch_v2_admin_controls |
| 20261208000000 | 20261225000000 | fetch_v2_member_lists |

Editing the v2 files was safe because none has ever been applied. Applied migrations must never be edited (supabase/tests/migration-immutability.node.test.ts).
Rollback scripts and tests were renamed with them; the access-boundary rollback no longer re-creates the four policies the safety fix dropped (guarded by fetch-safety-pause.node.test.ts).

## Pause
Fetch v2 can never be more open than Fetch: `fetch_v2_audience()` (the root of every v2 gate) returns `off` unless `admin_config fetch.operations = 'open'`. Opening v2 takes two keys:
fetch.operations = open AND fetch.v2.audience = admins | testers | everyone. Replayed test databases open the master switch automatically (supabase/tests/_support/replay-db.ts; pass keepFetchPaused to test the pause itself).

## Before applying ANY of this to production
1. Merge `migration-reconcile` (the canonical 281-version history) first; this branch carries the same files.
2. `node scripts/check-migration-collisions.mjs` must report 0 COLLISION / 0 OUT-OF-ORDER.
3. Apply 20261213000000 (pause hardening) on its own, verify with supabase/tests/fetch-safety-pause.verify.sql, THEN the v2 migrations in order, never reopening Fetch as a side effect.

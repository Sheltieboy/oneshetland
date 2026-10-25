# Migration history

**Status (8 October 2026): the repository and production's registered history agree — 247 migration files, 247 registered versions.**

## How we got here

Production's registered history (`supabase_migrations.schema_migrations`) had 218 versions. 29 migrations (20261031000000 … 20261121000000: notification and
claims hardening, launch-partner and outreach tooling, product import, and the six closed security fixes) had been applied by hand with
`supabase db query -f` and never recorded. On 2026-10-08 they were registered with the official history-repair command, after a rehearsal on an isolated copy
of the history table:

```bash
supabase migration repair --status applied <the 29 versions> --linked
```

`repair` inserts the version, name and statements into `schema_migrations` and **executes none of the SQL**. Nothing else changed: the 218 existing rows are
byte-identical (hash `633bbcf8…` before and after), the production catalog fingerprint (4,990 public objects) and the Edge Function versions are unchanged.
The record of what was registered is `registered_by_repair` in `supabase/production/hand-applied-migrations.json`.

## Guard

`node scripts/check-migration-history.mjs` compares the repository's migration files with production's registered versions
(`--snapshot` works offline against `supabase/production/registered-migrations.json`; with no flag it reads `supabase migration list --linked`, read-only).
It exits non-zero if a file is unregistered, a registered version has no file, or a hand-applied migration is listed and not registered.
`npm run db:push:guarded` runs it before `supabase db push`. **If you ever apply a migration by hand, register it in the same sitting** with
`supabase migration repair --status applied <version>` and refresh `registered-migrations.json`; until then add it to `hand-applied-migrations.json`
so the guard blocks a push.

Note `db push` compares VERSIONS only. The three hand-applied supplements below are not migrations and are never run by it; they exist so a replay reproduces production.

## Applied migrations are immutable

Four historical files had been edited after they were applied. They have been restored to what production recorded:

| Migration | Restored from |
|---|---|
| `20260721020000_loyalty_reminders` | the exact earlier blob in git history (`f9839e7`) |
| `20260829120000_boost_refunds` | reconstructed from the recorded statements |
| `20260903120000_subscription_same_second_reconcile` | reconstructed from the recorded statements |
| `20260925120000_public_business_view` | reconstructed from the recorded statements |

Reconstructed files carry a header saying so. Production later acquired anything those files had gained through other migrations
(for example `nudge_reminded_at` arrived with `20260803120000_fix_missing_nudge_reminded_at`); the chronology is preserved, not back-edited.
Every one of the 217 registered migrations with recorded statements now equals production's record. The 2 migrations that existed only as
untracked files (`20261015000000`, `20261015010000`) are committed byte-for-byte; the second equals the live `resolve_nfc_tile`.

Changes belong in a NEW migration. No corrective migration has been added by this reconciliation.

The files were restored BEFORE registration, so the 29 rows registered on 2026-10-08 hold the canonical file text.

## Hand-applied supplements (recorded, not hidden)

Production's live state includes three changes that no recorded migration contains. They are kept OUT of `supabase/migrations/` (so no
`db push` can run them) in `supabase/production/hand-applied-supplements/`, each attached to the migration after which it was run:

| Supplement | What it is |
|---|---|
| `20260807160000_listing_source` | widens `local_businesses_source_check` to `livinglerwick`, `shetlandindex`, `openstreetmap` — the DDL at the top of `supabase/scripts/seed-*.sql`, run in the SQL editor |
| `20260903120000_subscription_same_second_reconcile` | `drop function … claim_subscription_event(text, bigint, text)` — the trailing statement later added to that file |
| `20260925120000_public_business_view` | re-creation of the view without `owner_id` (the later text of that file). The file's trailing `revoke/grant` lines were not in effect: the live ACL is the default |

## Proving the repository rebuilds production

`npm run test:replay` (`scripts/migration-replay/replay.mjs`) builds a database from `supabase/migrations` alone in a throwaway PostgreSQL 17 cluster
(plus the supplements above and minimal Supabase stand-ins for `auth`, `storage`, `cron`, `net`, `vault`), fingerprints the catalog and compares it
with `supabase/production/catalog-fingerprint.tsv`, a read-only fingerprint of production taken on 2026-10-08. Result: 5,040 objects, all
identical except three cosmetic differences listed with reasons in `catalog-known-differences.json`. It never connects to production.
Environment preconditions the harness supplies: a pre-existing `reminder-runner` cron job holding the shared secret (needed by
`20260821140000_canonical_scheduled_jobs`) and `pg_trgm` installed in `public`.

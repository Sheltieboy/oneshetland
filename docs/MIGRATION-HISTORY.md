# Migration history — read this before `supabase db push`

**Do not run `supabase db push` against production.** Not yet.

## Why

Production's registered history (`supabase_migrations.schema_migrations`) and this repository disagree:

* **218 versions are registered** (snapshot: `supabase/production/registered-migrations.json`, captured read-only on 2026-10-08).
* **29 migrations are applied in production but were never registered** — they were applied by hand
  (`supabase db query -f`). They are listed, with their purpose, in `supabase/production/hand-applied-migrations.json`.
  Each was verified present in the live catalog on 2026-10-08. `db push` would try to run them a second time.

`node scripts/check-migration-history.mjs` compares the two and exits non-zero while they differ
(`--snapshot` works offline; with no flag it reads `supabase migration list --linked`, which is read-only).
`npm run db:push:guarded` runs the check and only then `supabase db push`.

Registering the 29 (a production write) is a separate, explicitly approved step. When it is done, empty
`hand-applied-migrations.json`, refresh `registered-migrations.json`, and the guard passes.

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

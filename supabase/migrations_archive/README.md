# Archived migrations (pre-baseline)

These are the original incremental migrations 001–080. On 2026-06-23 the live
schema was captured into a single baseline (`../migrations/20260623000000_baseline_remote_schema.sql`)
because the incremental history had drifted from the live database (objects had
been applied via the dashboard and standalone scripts, and the `schema_migrations`
tracker only reached 049).

They are kept for historical reference only. The baseline is the source of truth.
Do NOT move these back into `supabase/migrations/`.

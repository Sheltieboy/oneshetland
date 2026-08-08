-- Fix: the source/source_ref unique index was PARTIAL, which upserts can't use.
--
-- 20260807160000 created it as `... where source is not null`. Postgres will
-- only match a partial index in ON CONFLICT if the statement repeats the same
-- predicate, and PostgREST offers no way to express that — so every seeding
-- upsert failed with "no unique or exclusion constraint matching the ON
-- CONFLICT specification".
--
-- A plain unique index is correct anyway. Postgres treats NULLs as distinct in
-- a unique index, so the hand-entered listings (source null, source_ref null)
-- are entirely unaffected — there can be any number of them.

drop index if exists public.local_businesses_source_ref_uidx;

create unique index if not exists local_businesses_source_ref_uidx
  on public.local_businesses (source, source_ref);

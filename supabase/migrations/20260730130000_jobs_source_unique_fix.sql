-- Fix: the partial unique index on (source, source_ref) can't be used as an
-- ON CONFLICT arbiter by supabase-js upsert ("no unique or exclusion constraint
-- matching the ON CONFLICT specification"). Replace it with a plain UNIQUE
-- constraint.
--
-- Native, user-posted jobs have source = NULL and source_ref = NULL; NULLs are
-- treated as distinct in a UNIQUE constraint, so unlimited native jobs remain
-- allowed. Only external (syndicated) rows — which always set both — are
-- enforced unique, exactly as the sync-council-jobs upsert needs.

drop index if exists public.jobs_source_ref_uidx;

alter table public.jobs
  add constraint jobs_source_ref_key unique (source, source_ref);

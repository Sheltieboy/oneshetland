-- =============================================================================
-- Jobs aggregation — external (syndicated) job listings
-- =============================================================================
-- Lets the Work section carry public-sector vacancies pulled from external
-- boards (e.g. Shetland Islands Council on myjobscotland), where:
--   • there is no OneShetland employer account  → employer_id becomes nullable
--   • the "apply" always goes out to the official listing  → apply_url
--   • the employer name + logo come from the source, not a directory business
--   • rows are keyed on (source, source_ref) so the sync can upsert idempotently
--
-- Native, user-posted jobs are unaffected (source stays NULL).
-- The sync-council-jobs edge function owns these rows (service role); RLS
-- update/delete policies keyed on employer_id simply never match them.
-- =============================================================================

alter table public.jobs
  add column if not exists source                     text,   -- e.g. 'myjobscotland'
  add column if not exists source_ref                 text,   -- external id, for upsert/dedup
  add column if not exists source_label               text,   -- shown to users, e.g. 'via myjobscotland'
  add column if not exists external_employer_name     text,   -- when no OneShetland business is attached
  add column if not exists external_employer_logo_url text;

-- Aggregated jobs have no OneShetland employer profile.
alter table public.jobs alter column employer_id drop not null;

-- One row per external listing; lets the sync upsert on conflict.
create unique index if not exists jobs_source_ref_uidx
  on public.jobs (source, source_ref)
  where source is not null;

-- Fast "is this an external listing?" filtering.
create index if not exists jobs_source_idx
  on public.jobs (source)
  where source is not null;

comment on column public.jobs.source is
  'NULL for user-posted jobs. Set (e.g. ''myjobscotland'') for syndicated external listings synced by sync-council-jobs; apply is always external via apply_url.';
comment on column public.jobs.source_ref is
  'The external listing id within `source`; unique per source, used for idempotent upserts.';
comment on column public.jobs.external_employer_name is
  'Employer name for syndicated jobs that have no OneShetland business attached (posted_as_business_id is NULL).';

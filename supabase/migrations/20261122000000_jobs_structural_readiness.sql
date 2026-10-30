-- Jobs Stage 2 — structural readiness for many job sources and direct employer postings.
--
-- ADDITIVE. No existing row is changed by this migration (a generated column is computed for them; nothing is rewritten).
--
-- 1. contract_type gains 'temporary'. The council sync was filing source-"Temporary" posts under 'casual'; the vocabulary
--    had nowhere to put them. 'casual' stays for supply / relief / bank work.
-- 2. Source model, generic rather than council-only:
--      source / source_ref        already exist: WHICH source, and that source's own id for the job (unique together)
--      source_url                 the page we found the job on (apply_url remains where the person goes to apply)
--      source_reference           the source's human reference, e.g. the council's SIC09073 — kept for de-duplication across
--                                 aggregators, employer sites and the council itself
--      source_published_at        when the SOURCE says it was published
--      source_meta                the source's own labels we cannot map without losing something (e.g. its contract
--                                 and hours wording)
--    posted_at is NOT touched: it remains "when OneShetland first saw it".
-- 3. listed_at = coalesce(source_published_at, posted_at), generated: one orderable "newest first" date that is the source's
--    publication date when known and the first-seen date otherwise (so directly posted jobs and imported jobs sort together).
-- 4. tg_lock_job_columns, for ordinary (non-admin, non-service) writers:
--      · INSERT: a job always has a finite life — no closing date becomes 30 days after posting (posted_at is the database's clock);
--      · UPDATE: the closing date cannot be removed;
--      · a user can no longer claim to be an external source (source, source_ref, source_label, source_url, source_reference,
--        source_published_at, source_meta, external_employer_*) on insert, or change them afterwards. Nothing blocked that before,
--        so an employer could have posted a job labelled "Shetland Islands Council via myjobscotland" or taken a source_ref the
--        council sync later needed.
--    The service role (the council sync, future importers), SECURITY DEFINER functions, migrations and platform admins are
--    unchanged: they may still write these columns and may still omit a closing date.

begin;

alter table public.jobs drop constraint if exists jobs_contract_type_check;
alter table public.jobs add constraint jobs_contract_type_check
  check (contract_type = any (array['full-time','part-time','casual','temporary','apprenticeship','volunteer','freelance']));

alter table public.jobs
  add column if not exists source_url          text,
  add column if not exists source_reference    text,
  add column if not exists source_published_at timestamptz,
  add column if not exists source_meta         jsonb;

alter table public.jobs
  add column if not exists listed_at timestamptz generated always as (coalesce(source_published_at, posted_at)) stored;

create index if not exists jobs_source_reference_idx on public.jobs (source, source_reference) where source_reference is not null;
create index if not exists jobs_listed_at_idx on public.jobs (listed_at desc);

create or replace function public.tg_lock_job_columns()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- service role, SECURITY DEFINER paths, migrations, psql — and platform admins working from the admin screens.
  if public.tg_is_trusted_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Promotion is bought, never declared.
    new.is_featured   := false;
    new.boosted_until := null;
    -- A person posting a job is not an external source and cannot pretend to be one.
    new.source := null; new.source_ref := null; new.source_label := null; new.source_url := null;
    new.source_reference := null; new.source_published_at := null; new.source_meta := null;
    new.external_employer_name := null; new.external_employer_logo_url := null;
    -- first-seen / posting time is the database's, not the client's (it feeds the closing-date default and the sort order)
    new.posted_at := now();
    -- A job always has a finite life.
    if new.expires_at is null then
      new.expires_at := now() + interval '30 days';
    end if;
    return new;
  end if;

  -- UPDATE: silently preserve, matching the other locks (a successful write with the protected fields unchanged).
  new.is_featured   := old.is_featured;
  new.boosted_until := old.boosted_until;
  new.posted_at     := old.posted_at;
  new.source := old.source; new.source_ref := old.source_ref; new.source_label := old.source_label; new.source_url := old.source_url;
  new.source_reference := old.source_reference; new.source_published_at := old.source_published_at; new.source_meta := old.source_meta;
  new.external_employer_name := old.external_employer_name; new.external_employer_logo_url := old.external_employer_logo_url;
  if new.expires_at is null then
    new.expires_at := coalesce(old.expires_at, now() + interval '30 days');
  end if;
  return new;
end;
$function$;

commit;

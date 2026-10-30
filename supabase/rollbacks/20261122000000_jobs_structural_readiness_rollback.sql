-- Rollback for 20261122000000_jobs_structural_readiness.sql. Refuses to run if any job already uses the new values
-- (it would be destroying data). Restores the previous tg_lock_job_columns verbatim.
begin;
do $$
begin
  if exists (select 1 from public.jobs where contract_type = 'temporary') then
    raise exception 'rollback refused: jobs with contract_type=temporary exist';
  end if;
  if exists (select 1 from public.jobs where source_url is not null or source_reference is not null or source_published_at is not null or source_meta is not null) then
    raise exception 'rollback refused: jobs already carry the new source columns';
  end if;
end $$;

create or replace function public.tg_lock_job_columns()
returns trigger language plpgsql set search_path to 'public', 'pg_temp'
as $function$
begin
  if public.tg_is_trusted_writer() then return new; end if;
  if tg_op = 'INSERT' then
    new.is_featured := false; new.boosted_until := null; return new;
  end if;
  new.is_featured := old.is_featured; new.boosted_until := old.boosted_until; return new;
end;
$function$;

drop index if exists public.jobs_listed_at_idx;
drop index if exists public.jobs_source_reference_idx;
alter table public.jobs drop column if exists listed_at;
alter table public.jobs drop column if exists source_meta, drop column if exists source_published_at, drop column if exists source_reference, drop column if exists source_url;
alter table public.jobs drop constraint if exists jobs_contract_type_check;
alter table public.jobs add constraint jobs_contract_type_check
  check (contract_type = any (array['full-time','part-time','casual','apprenticeship','volunteer','freelance']));
commit;

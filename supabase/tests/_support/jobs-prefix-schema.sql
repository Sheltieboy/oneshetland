-- jobs-prefix-schema.sql — the PRE-Stage-2 production state of public.jobs and what its authorisation touches.
-- Columns, constraints, policies, triggers and functions are copied from read-only introspection of production on 30 Oct 2026
-- (information_schema, pg_policy, pg_get_functiondef). Test-only. Nothing here ships.
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;

create table profiles (id uuid primary key, role text not null default 'customer', is_platform_owner boolean default false);
create table local_businesses (id uuid primary key default gen_random_uuid(), owner_id uuid references profiles(id), name text);

create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true));
$$;
create function public.tg_is_trusted_writer() returns boolean language plpgsql stable set search_path to 'public' as $$
begin
  if current_user not in ('authenticated', 'anon') then return true; end if;
  return public.is_admin();
end; $$;

create table jobs (
  id uuid primary key default gen_random_uuid(),
  employer_id uuid references profiles(id) on delete cascade,
  posted_as_business_id uuid references local_businesses(id) on delete set null,
  title text not null, description text, category text, location text, locality text, lat numeric, lng numeric,
  contract_type text not null default 'full-time', pay_text text, apply_url text, apply_email text,
  is_featured boolean not null default false, is_hidden boolean not null default false,
  expires_at timestamptz, posted_at timestamptz not null default now(), created_at timestamptz not null default now(),
  pay_min numeric, pay_max numeric, pay_period text, pay_hidden boolean not null default false, boosted_until timestamptz,
  relocation_support boolean not null default false, housing_available boolean not null default false,
  is_seasonal boolean not null default false, season_label text, remote_mode text not null default 'on_site',
  views_count integer not null default 0, application_count integer not null default 0, status text not null default 'open',
  updated_at timestamptz not null default now(),
  source text, source_ref text, source_label text, external_employer_name text, external_employer_logo_url text,
  constraint jobs_contract_type_check check (contract_type = any (array['full-time','part-time','casual','apprenticeship','volunteer','freelance'])),
  constraint jobs_pay_period_check check (pay_period = any (array['hour','day','week','month','year','total'])),
  constraint jobs_remote_mode_check check (remote_mode = any (array['on_site','hybrid','remote'])),
  constraint jobs_status_check check (status = any (array['open','closed','filled'])),
  constraint jobs_title_check check (length(trim(both from title)) >= 1 and length(trim(both from title)) <= 200),
  constraint jobs_source_ref_key unique (source, source_ref)
);
alter table jobs enable row level security;
create policy "jobs read" on jobs for select using (
  ((not is_hidden) and (expires_at is null or expires_at > now()))
  or exists (select 1 from profiles p where p.id = auth.uid() and p.role = any (array['admin','moderator'])));
create policy "jobs insert" on jobs for insert with check (auth.uid() is not null and employer_id = auth.uid());
create policy "jobs update" on jobs for update using (employer_id = auth.uid()
  or exists (select 1 from profiles p where p.id = auth.uid() and p.role = any (array['admin','moderator'])));
create policy "jobs delete" on jobs for delete using (employer_id = auth.uid()
  or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
grant select, insert, update, delete on jobs to anon, authenticated, service_role;
grant select, insert, update on profiles, local_businesses to authenticated, service_role;
grant select on profiles, local_businesses to anon;

create function public.tg_jobs_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
create function public.tg_lock_job_columns() returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;
  if tg_op = 'INSERT' then new.is_featured := false; new.boosted_until := null; return new; end if;
  new.is_featured := old.is_featured; new.boosted_until := old.boosted_until; return new;
end; $$;
create trigger lock_job_columns before insert or update on jobs for each row execute function tg_lock_job_columns();
create trigger tg_jobs_touch before update on jobs for each row execute function tg_jobs_touch();

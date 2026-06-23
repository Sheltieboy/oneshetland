-- 078_jobs_board.sql
-- The Jobs board: turns the dormant `jobs` table (045, live:false) into a real
-- traditional-roles tier that sits alongside Shifts under one "Work" hub.
--
-- v1 scope (founder decisions): separate post tables, ONE shared worker profile;
-- businesses-only posting; posting + applicant pipeline FREE (a free 'jobs'
-- add-on), monetised later via featured boosts + a Jobs-Pro branding tier.
-- GDPR: per-employer RLS on applications + a 6-month auto-purge of stale ones.

-- ── 1. Extend the jobs table ──────────────────────────────────────────────────

alter table public.jobs
  add column if not exists pay_min            numeric(10,2),
  add column if not exists pay_max            numeric(10,2),
  add column if not exists pay_period         text check (pay_period in ('hour','day','week','month','year','total')),
  add column if not exists pay_hidden         boolean not null default false,
  add column if not exists boosted_until      timestamptz,
  add column if not exists relocation_support boolean not null default false,
  add column if not exists housing_available  boolean not null default false,
  add column if not exists is_seasonal        boolean not null default false,
  add column if not exists season_label       text,
  add column if not exists remote_mode        text not null default 'on_site'
                            check (remote_mode in ('on_site','hybrid','remote')),
  add column if not exists views_count        int not null default 0,
  add column if not exists application_count  int not null default 0,
  add column if not exists status             text not null default 'open'
                            check (status in ('open','closed','filled')),
  add column if not exists updated_at         timestamptz not null default now();

create or replace function public.tg_jobs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists tg_jobs_touch on public.jobs;
create trigger tg_jobs_touch before update on public.jobs
  for each row execute function public.tg_jobs_touch();

-- ── 2. Job applications ───────────────────────────────────────────────────────

create table if not exists public.job_applications (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs(id) on delete cascade,
  applicant_id     uuid not null references public.profiles(id) on delete cascade,
  status           text not null default 'applied'
                     check (status in ('applied','viewed','shortlisted','interview','offer','hired','declined','withdrawn')),
  cover_letter     text,
  profile_snapshot jsonb not null default '{}'::jsonb,   -- frozen CV at apply time
  visibility       text not null default 'full' check (visibility in ('full','snapshot')),
  employer_note    text,                                  -- private to the employer
  applied_at       timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_id, applicant_id)
);

create index if not exists idx_job_apps_job       on public.job_applications(job_id, status);
create index if not exists idx_job_apps_applicant on public.job_applications(applicant_id);

alter table public.job_applications enable row level security;

-- Applicant manages their own application (apply, withdraw, edit before viewed).
create policy "job_applications applicant" on public.job_applications
  for all using (applicant_id = auth.uid()) with check (applicant_id = auth.uid());

-- Employer of the job reads + updates (status/notes) applications to THEIR roles.
create policy "job_applications employer read" on public.job_applications
  for select using (
    exists (select 1 from public.jobs j where j.id = job_id and j.employer_id = auth.uid())
  );
create policy "job_applications employer update" on public.job_applications
  for update using (
    exists (select 1 from public.jobs j where j.id = job_id and j.employer_id = auth.uid())
  );

create policy "job_applications admin" on public.job_applications
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator')));

-- Touch + denormalised application_count + status timestamp.
create or replace function public.tg_job_application_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists tg_job_application_touch on public.job_applications;
create trigger tg_job_application_touch before insert or update on public.job_applications
  for each row execute function public.tg_job_application_touch();

create or replace function public.tg_job_application_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.jobs set application_count = application_count + 1 where id = new.job_id;
  elsif tg_op = 'DELETE' then
    update public.jobs set application_count = greatest(application_count - 1, 0) where id = old.job_id;
  end if;
  return null;
end;
$$;
drop trigger if exists tg_job_application_count on public.job_applications;
create trigger tg_job_application_count after insert or delete on public.job_applications
  for each row execute function public.tg_job_application_count();

-- ── 3. Application pipeline history (powers the candidate-visible tracker) ────

create table if not exists public.application_events (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete cascade,
  from_status    text,
  to_status      text not null,
  actor_id       uuid references public.profiles(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_application_events_app on public.application_events(application_id, created_at);

alter table public.application_events enable row level security;

-- Visible to the applicant and to the employer of the job; never editable by clients.
create policy "application_events read" on public.application_events
  for select using (
    exists (
      select 1 from public.job_applications ja
      join public.jobs j on j.id = ja.job_id
      where ja.id = application_id
        and (ja.applicant_id = auth.uid() or j.employer_id = auth.uid())
    )
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

create or replace function public.tg_application_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_events (application_id, from_status, to_status, actor_id)
    values (new.id, null, new.status, new.applicant_id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.application_events (application_id, from_status, to_status, actor_id)
    values (new.id, old.status, new.status, auth.uid());
  end if;
  return null;
end;
$$;
drop trigger if exists tg_application_event on public.job_applications;
create trigger tg_application_event after insert or update on public.job_applications
  for each row execute function public.tg_application_event();

-- ── 4. Shared worker (candidate) profile — one profile across Shifts & Jobs ───

create table if not exists public.worker_profiles (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  headline            text,
  summary             text,
  skills              text[] not null default '{}',
  qualifications      text[] not null default '{}',
  experience          jsonb  not null default '[]'::jsonb,   -- [{title, org, from, to, detail}]
  desired_pay_text    text,
  willing_to_relocate boolean not null default false,
  available_from      date,
  is_diaspora         boolean not null default false,        -- off-island, would move back
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.worker_profiles enable row level security;

create policy "worker_profiles owner" on public.worker_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- An employer may read a candidate's profile only once that candidate has
-- applied to one of the employer's jobs (controller separation).
create policy "worker_profiles employer read" on public.worker_profiles
  for select using (
    exists (
      select 1 from public.job_applications ja
      join public.jobs j on j.id = ja.job_id
      where ja.applicant_id = worker_profiles.user_id and j.employer_id = auth.uid()
    )
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

create or replace function public.tg_worker_profile_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
drop trigger if exists tg_worker_profile_touch on public.worker_profiles;
create trigger tg_worker_profile_touch before update on public.worker_profiles
  for each row execute function public.tg_worker_profile_touch();

-- ── 5. CV / cover-letter library (private to the user) ────────────────────────

create table if not exists public.cv_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  kind            text not null check (kind in ('cv','cover_letter')),
  label           text not null,
  body            text,            -- text content (AI-drafted cover letters, CV notes)
  external_url    text,            -- optional link to a hosted CV
  is_primary      boolean not null default false,
  generated_by_ai boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_cv_documents_user on public.cv_documents(user_id, kind);

alter table public.cv_documents enable row level security;
create policy "cv_documents owner" on public.cv_documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── 6. Saved jobs ─────────────────────────────────────────────────────────────

create table if not exists public.saved_jobs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  job_id     uuid not null references public.jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, job_id)
);
alter table public.saved_jobs enable row level security;
create policy "saved_jobs owner" on public.saved_jobs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── 7. Free 'jobs' business add-on (gates the Jobs management card) ───────────

alter table public.business_addons drop constraint if exists valid_addon_key;
alter table public.business_addons add constraint valid_addon_key check (
  addon_key in (
    'products','bookings','services','events','membership',
    'offers','stamps','enquiries','payments','featured','jobs'
  )
);

-- Seed 'jobs' (off by default — free to switch on) for new businesses.
create or replace function public.tg_seed_business_addons() returns trigger
language plpgsql security definer as $$
begin
  insert into public.business_addons (business_id, addon_key, enabled) values
    (new.id, 'offers',     true),
    (new.id, 'stamps',     true),
    (new.id, 'enquiries',  true),
    (new.id, 'payments',   true),
    (new.id, 'featured',   true),
    (new.id, 'jobs',       false),
    (new.id, 'bookings',   false),
    (new.id, 'services',   false),
    (new.id, 'events',     false),
    (new.id, 'membership', false),
    (new.id, 'products',   false)
  on conflict (business_id, addon_key) do nothing;
  return new;
end;
$$;

-- Backfill a 'jobs' row for every existing business.
insert into public.business_addons (business_id, addon_key, enabled)
select id, 'jobs', false from public.local_businesses
on conflict (business_id, addon_key) do nothing;

-- ── 8. GDPR: purge stale unsuccessful applications (6 months) ─────────────────
-- Call on a schedule (pg_cron / scheduled edge function). Successful (hired) and
-- in-flight applications are kept; rejected/withdrawn older than 6 months go.

create or replace function public.purge_old_job_applications() returns int
language plpgsql security definer set search_path = public as $$
declare v_deleted int;
begin
  with gone as (
    delete from public.job_applications
    where status in ('declined','withdrawn')
      and status_changed_at < now() - interval '6 months'
    returning 1
  )
  select count(*) into v_deleted from gone;
  return v_deleted;
end;
$$;
revoke all on function public.purge_old_job_applications() from public;

-- Launch Test Centre — private acceptance testing by trusted real users (web-only; no native app change).
--
-- Testers are existing OneShetland accounts that an administrator has explicitly enabled for a programme. They follow short
-- real-world journeys in the live app and record the outcome here. Nothing in this schema touches payments, the wallet, orders or
-- any commerce table: it only RECORDS what a person says happened.
--
-- Access model (database-enforced, not merely hidden):
--   · every table has RLS on; anon has nothing; authenticated can only SELECT, and only their own rows while still an ENABLED tester
--     (administrators see everything);
--   · every write is a SECURITY DEFINER function that re-checks auth.uid() — a tester can start and submit only their own attempts,
--     an administrator function can only be run by an administrator (the same launch_plan_authorised() gate the launch-partner tools use);
--   · attempts are APPEND-ONLY history: a re-run is a new row, a submitted result can never be edited (trigger), only an administrator's
--     review fields move;
--   · screenshots live in a PRIVATE bucket; a tester can add objects only under their own attempt id with a generated filename, and read
--     only their own; administrators read all; nobody can overwrite, and only administrators can delete.
--
-- Real-money tests (wallet / real card / donation) are instructions only. The Test Centre never calls Stripe, never moves value and never
-- stores payment details; for those tests the tester must acknowledge, at start, that the transaction is real.

begin;

-- ── tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.launch_test_programmes (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name                     text not null check (char_length(btrim(name)) between 3 and 120),
  description              text check (char_length(description) <= 2000),
  status                   text not null default 'draft' check (status in ('draft', 'active', 'completed')),
  expected_ios_build       text check (char_length(expected_ios_build) <= 60),
  expected_android_version text check (char_length(expected_android_version) <= 60),
  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id) on delete set null
);

create table public.launch_testers (
  id           uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.launch_test_programmes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  enabled      boolean not null default true,
  platforms    text[] not null default '{}' check (platforms <@ array['ios', 'android']::text[]),
  admin_notes  text check (char_length(admin_notes) <= 2000),
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  unique (programme_id, user_id)
);
create index launch_testers_user_idx on public.launch_testers (user_id) where enabled;

create table public.launch_tests (
  id                      uuid primary key default gen_random_uuid(),
  programme_id            uuid not null references public.launch_test_programmes (id) on delete cascade,
  slug                    text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  category                text not null check (char_length(btrim(category)) between 1 and 60),
  title                   text not null check (char_length(btrim(title)) between 3 and 140),
  purpose                 text not null check (char_length(purpose) <= 600),
  steps                   text[] not null default '{}' check (cardinality(steps) <= 12),
  expected_outcome        text not null check (char_length(expected_outcome) <= 1000),
  priority                text not null default 'high' check (priority in ('critical', 'high', 'normal')),
  mandatory               boolean not null default true,
  platform                text not null default 'all' check (platform in ('all', 'ios', 'android')),
  sort_order              integer not null default 100,
  active                  boolean not null default true,
  target_url              text check (target_url is null or target_url ~ '^https://[^\s]+$'),
  target_note             text check (char_length(target_note) <= 600),
  money_test_type         text not null default 'none' check (money_test_type in ('none', 'wallet', 'real_card', 'donation')),
  expected_max_spend_pence integer check (expected_max_spend_pence is null or expected_max_spend_pence between 0 and 100000),
  help_text               text check (char_length(help_text) <= 600),
  effort_minutes          integer check (effort_minutes is null or effort_minutes between 1 and 120),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (programme_id, slug)
);
create index launch_tests_programme_idx on public.launch_tests (programme_id, sort_order);

create table public.launch_test_sessions (
  id           uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.launch_test_programmes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android')),
  app_build    text check (char_length(app_build) <= 60),
  device_model text check (char_length(device_model) <= 80),
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  unique (programme_id, user_id, platform)
);

create table public.launch_test_attempts (
  id                   uuid primary key default gen_random_uuid(),
  programme_id         uuid not null references public.launch_test_programmes (id) on delete cascade,
  test_id              uuid not null references public.launch_tests (id) on delete cascade,
  session_id           uuid not null references public.launch_test_sessions (id) on delete cascade,
  user_id              uuid not null references auth.users (id) on delete cascade,
  status               text not null default 'in_progress' check (status in ('in_progress', 'passed', 'issue', 'blocked')),
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  tester_note          text check (char_length(tester_note) <= 2000),
  issue_description    text check (char_length(issue_description) <= 4000),
  money_acknowledged_at timestamptz,
  retest_of            uuid references public.launch_test_attempts (id) on delete set null,
  review_state         text check (review_state in ('open', 'reviewed', 'fix_pending', 'ready_for_retest', 'resolved')),
  admin_note           text check (char_length(admin_note) <= 2000),
  reviewed_by          uuid references auth.users (id) on delete set null,
  reviewed_at          timestamptz,
  retest_requested     boolean not null default false,
  retest_requested_at  timestamptz,
  retest_requested_by  uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint launch_attempt_complete_shape check ((status = 'in_progress') = (completed_at is null)),
  constraint launch_attempt_issue_needs_words check (status not in ('issue', 'blocked') or char_length(btrim(coalesce(issue_description, ''))) >= 3)
);
create index launch_attempts_test_user_idx on public.launch_test_attempts (test_id, user_id, created_at desc);
create index launch_attempts_programme_idx on public.launch_test_attempts (programme_id, created_at desc);
create unique index launch_attempts_one_open_idx on public.launch_test_attempts (test_id, session_id) where status = 'in_progress';

create table public.launch_test_attachments (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.launch_test_attempts (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  storage_path text not null unique,
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  created_at   timestamptz not null default now()
);
create index launch_attachments_attempt_idx on public.launch_test_attachments (attempt_id);

-- A submitted result is history: the tester-supplied fields, the identity of the attempt and its timestamps can never change again.
create or replace function public.tg_launch_attempt_immutable() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.test_id is distinct from old.test_id or new.session_id is distinct from old.session_id or new.user_id is distinct from old.user_id
     or new.programme_id is distinct from old.programme_id or new.started_at is distinct from old.started_at
     or new.retest_of is distinct from old.retest_of or new.money_acknowledged_at is distinct from old.money_acknowledged_at then
    raise exception 'A test attempt''s identity cannot change' using errcode = '42501';
  end if;
  if old.status <> 'in_progress' and (new.status is distinct from old.status or new.tester_note is distinct from old.tester_note
     or new.issue_description is distinct from old.issue_description or new.completed_at is distinct from old.completed_at) then
    raise exception 'A submitted test result is part of the history and cannot be edited' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger tg_launch_attempt_immutable before update on public.launch_test_attempts
  for each row execute function public.tg_launch_attempt_immutable();

-- ── authorisation helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Definer functions, so policies can ask about launch_testers without recursing into its own policy.
create or replace function public.launch_test_is_enabled_tester(p_programme uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.launch_testers t
     where t.programme_id = p_programme and t.user_id = auth.uid() and t.enabled
  );
$$;

-- Same gate the launch-partner administration uses: an admin session, the service role, or a direct SQL session; anything else is refused.
create or replace function public.launch_test_admin_ok() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.launch_plan_authorised() is not null; $$;

revoke all on function public.launch_test_is_enabled_tester(uuid), public.launch_test_admin_ok() from public, anon;
grant execute on function public.launch_test_is_enabled_tester(uuid), public.launch_test_admin_ok() to authenticated, service_role;

-- ── row-level security: read-only for clients, scoped to the caller ────────────────────────────────────────────────────────
alter table public.launch_test_programmes enable row level security;
alter table public.launch_testers         enable row level security;
alter table public.launch_tests           enable row level security;
alter table public.launch_test_sessions   enable row level security;
alter table public.launch_test_attempts   enable row level security;
alter table public.launch_test_attachments enable row level security;

revoke all on public.launch_test_programmes, public.launch_testers, public.launch_tests, public.launch_test_sessions,
              public.launch_test_attempts, public.launch_test_attachments from public, anon, authenticated;
grant select on public.launch_test_programmes, public.launch_testers, public.launch_tests, public.launch_test_sessions,
                public.launch_test_attempts, public.launch_test_attachments to authenticated;
grant all on public.launch_test_programmes, public.launch_testers, public.launch_tests, public.launch_test_sessions,
             public.launch_test_attempts, public.launch_test_attachments to service_role;

create policy "launch programmes read" on public.launch_test_programmes for select to authenticated
  using (public.is_admin() or (status <> 'draft' and public.launch_test_is_enabled_tester(id)));

create policy "launch testers read" on public.launch_testers for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and enabled));

create policy "launch tests read" on public.launch_tests for select to authenticated
  using (public.is_admin() or (active and public.launch_test_is_enabled_tester(programme_id)));

create policy "launch sessions read" on public.launch_test_sessions for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.launch_test_is_enabled_tester(programme_id)));

create policy "launch attempts read" on public.launch_test_attempts for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.launch_test_is_enabled_tester(programme_id)));

create policy "launch attachments read" on public.launch_test_attachments for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and exists (
    select 1 from public.launch_test_attempts a
     where a.id = launch_test_attachments.attempt_id and public.launch_test_is_enabled_tester(a.programme_id))));

-- ── tester functions ───────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.launch_test_open_session(p_programme uuid, p_platform text, p_build text, p_device text default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_t public.launch_testers%rowtype; v_p public.launch_test_programmes%rowtype; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_t from public.launch_testers where programme_id = p_programme and user_id = auth.uid() and enabled;
  if not found then raise exception 'This is not available' using errcode = '42501'; end if;
  select * into v_p from public.launch_test_programmes where id = p_programme;
  if v_p.status <> 'active' then raise exception 'This test programme is not open right now' using errcode = '55000'; end if;
  if p_platform not in ('ios', 'android') then raise exception 'Choose iPhone or Android' using errcode = '22023'; end if;
  if cardinality(v_t.platforms) > 0 and not (p_platform = any (v_t.platforms)) then
    raise exception 'That phone type is not part of your test assignment' using errcode = '42501';
  end if;
  insert into public.launch_test_sessions (programme_id, user_id, platform, app_build, device_model)
  values (p_programme, auth.uid(), p_platform, nullif(btrim(left(coalesce(p_build, ''), 60)), ''), nullif(btrim(left(coalesce(p_device, ''), 80)), ''))
  on conflict (programme_id, user_id, platform) do update
    set app_build = excluded.app_build, device_model = excluded.device_model, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.launch_test_start(p_test uuid, p_session uuid, p_ack boolean default false)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_test public.launch_tests%rowtype; v_s public.launch_test_sessions%rowtype; v_prev uuid; v_open uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_s from public.launch_test_sessions where id = p_session and user_id = auth.uid();
  if not found or not public.launch_test_is_enabled_tester(v_s.programme_id) then raise exception 'This is not available' using errcode = '42501'; end if;
  select * into v_test from public.launch_tests where id = p_test and programme_id = v_s.programme_id and active;
  if not found then raise exception 'That test is not available' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.launch_test_programmes where id = v_s.programme_id and status = 'active') then
    raise exception 'This test programme is not open right now' using errcode = '55000';
  end if;
  if v_test.platform <> 'all' and v_test.platform <> v_s.platform then raise exception 'That test is not for this phone type' using errcode = '22023'; end if;

  -- resuming is not starting twice
  select id into v_open from public.launch_test_attempts where test_id = p_test and session_id = p_session and status = 'in_progress';
  if v_open is not null then return v_open; end if;

  if v_test.money_test_type <> 'none' and p_ack is not true then
    raise exception 'Please confirm you understand this is a real transaction' using errcode = '22023';
  end if;

  select id into v_prev from public.launch_test_attempts
   where test_id = p_test and session_id = p_session order by created_at desc limit 1;

  insert into public.launch_test_attempts (programme_id, test_id, session_id, user_id, retest_of, money_acknowledged_at)
  values (v_s.programme_id, p_test, p_session, auth.uid(), v_prev, case when v_test.money_test_type <> 'none' then now() end)
  returning id into v_id;
  update public.launch_test_sessions set completed_at = null, updated_at = now() where id = p_session;
  return v_id;
end $$;

create or replace function public.launch_test_submit(p_attempt uuid, p_status text, p_note text default null, p_issue text default null)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare a public.launch_test_attempts%rowtype; v_issue text := nullif(btrim(coalesce(p_issue, '')), ''); v_left integer;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into a from public.launch_test_attempts where id = p_attempt and user_id = auth.uid() for update;
  if not found or not public.launch_test_is_enabled_tester(a.programme_id) then raise exception 'This is not available' using errcode = '42501'; end if;
  if a.status <> 'in_progress' then raise exception 'This result has already been sent' using errcode = '55000'; end if;
  if p_status not in ('passed', 'issue', 'blocked') then raise exception 'Choose how it went' using errcode = '22023'; end if;
  if p_status in ('issue', 'blocked') and (v_issue is null or char_length(v_issue) < 3) then
    raise exception 'Please tell us what happened' using errcode = '22023';
  end if;
  update public.launch_test_attempts
     set status = p_status, completed_at = now(),
         tester_note = nullif(btrim(left(coalesce(p_note, ''), 2000)), ''),
         issue_description = case when p_status = 'passed' then null else left(v_issue, 4000) end,
         review_state = case when p_status in ('issue', 'blocked') then 'open' end
   where id = p_attempt;
  -- a passing re-check closes the earlier attempt an administrator asked to be re-checked
  if p_status = 'passed' and a.retest_of is not null then
    update public.launch_test_attempts
       set review_state = 'resolved', reviewed_at = now(), retest_requested = false
     where id = a.retest_of and (retest_requested or review_state = 'ready_for_retest');
  end if;
  -- the session is finished when nothing applicable is left unanswered
  select count(*) into v_left from public.launch_tests t
    join public.launch_test_sessions s on s.id = a.session_id
   where t.programme_id = a.programme_id and t.active and (t.platform = 'all' or t.platform = s.platform)
     and not exists (select 1 from public.launch_test_attempts x where x.test_id = t.id and x.session_id = s.id and x.status <> 'in_progress');
  if v_left = 0 then update public.launch_test_sessions set completed_at = now(), updated_at = now() where id = a.session_id; end if;
end $$;

create or replace function public.launch_test_add_attachment(p_attempt uuid, p_path text, p_mime text, p_size integer)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare a public.launch_test_attempts%rowtype; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into a from public.launch_test_attempts where id = p_attempt and user_id = auth.uid();
  if not found or not public.launch_test_is_enabled_tester(a.programme_id) then raise exception 'This is not available' using errcode = '42501'; end if;
  if p_path is null or p_path !~ ('^' || p_attempt::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$') then
    raise exception 'That file is not valid' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'launch-test-evidence' and o.name = p_path) then
    raise exception 'The screenshot has not been uploaded' using errcode = '22023';
  end if;
  if (select count(*) from public.launch_test_attachments where attempt_id = p_attempt) >= 4 then
    raise exception 'You can add up to 4 screenshots to a result' using errcode = '22023';
  end if;
  insert into public.launch_test_attachments (attempt_id, user_id, storage_path, mime_type, size_bytes)
  values (p_attempt, auth.uid(), p_path, p_mime, p_size) returning id into v_id;
  return v_id;
end $$;

-- ── administrator functions ────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.launch_test_admin_testers(p_programme uuid)
  returns table (tester_id uuid, user_id uuid, enabled boolean, platforms text[], admin_notes text, created_at timestamptz,
                 email text, full_name text, display_name text)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  return query
    select t.id, t.user_id, t.enabled, t.platforms, t.admin_notes, t.created_at, u.email::text, p.full_name, p.display_name
      from public.launch_testers t
      join auth.users u on u.id = t.user_id
      left join public.profiles p on p.id = t.user_id
     where t.programme_id = p_programme
     order by t.created_at;
end $$;

create or replace function public.launch_test_admin_add_tester(p_programme uuid, p_email text, p_platforms text[] default '{}', p_notes text default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_user uuid; v_id uuid; v_plat text[] := coalesce(p_platforms, '{}');
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+$' then raise exception 'Enter an email address' using errcode = '22023'; end if;
  if not (v_plat <@ array['ios', 'android']::text[]) then raise exception 'Platforms can only be ios or android' using errcode = '22023'; end if;
  if not exists (select 1 from public.launch_test_programmes where id = p_programme) then raise exception 'No such programme' using errcode = 'P0002'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email)) and deleted_at is null limit 1;
  if v_user is null then
    raise exception 'There is no OneShetland account with that email yet. Ask them to create or sign in to their normal account first, then add them.' using errcode = 'P0002';
  end if;
  insert into public.launch_testers (programme_id, user_id, enabled, platforms, admin_notes, created_by)
  values (p_programme, v_user, true, v_plat, nullif(btrim(left(coalesce(p_notes, ''), 2000)), ''), auth.uid())
  on conflict (programme_id, user_id) do update
    set enabled = true, platforms = excluded.platforms, admin_notes = coalesce(excluded.admin_notes, public.launch_testers.admin_notes), updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.launch_test_admin_update_tester(p_tester uuid, p_enabled boolean, p_platforms text[], p_notes text)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  if not (coalesce(p_platforms, '{}') <@ array['ios', 'android']::text[]) then raise exception 'Platforms can only be ios or android' using errcode = '22023'; end if;
  update public.launch_testers
     set enabled = coalesce(p_enabled, enabled), platforms = coalesce(p_platforms, platforms),
         admin_notes = nullif(btrim(left(coalesce(p_notes, ''), 2000)), ''), updated_at = now()
   where id = p_tester;
  if not found then raise exception 'No such tester' using errcode = 'P0002'; end if;
end $$;

create or replace function public.launch_test_admin_update_programme(p_programme uuid, p_patch jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  update public.launch_test_programmes set
    name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
    description = case when p_patch ? 'description' then nullif(btrim(p_patch ->> 'description'), '') else description end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    expected_ios_build = case when p_patch ? 'expected_ios_build' then nullif(btrim(p_patch ->> 'expected_ios_build'), '') else expected_ios_build end,
    expected_android_version = case when p_patch ? 'expected_android_version' then nullif(btrim(p_patch ->> 'expected_android_version'), '') else expected_android_version end
  where id = p_programme;
  if not found then raise exception 'No such programme' using errcode = 'P0002'; end if;
end $$;

create or replace function public.launch_test_admin_update_test(p_test uuid, p_patch jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare k text;
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'purpose', 'steps', 'expected_outcome', 'priority', 'mandatory', 'platform', 'sort_order', 'active', 'target_url', 'target_note',
                 'money_test_type', 'expected_max_spend_pence', 'help_text', 'effort_minutes', 'category') then
      raise exception 'Cannot edit "%"', k using errcode = '22023';
    end if;
  end loop;
  update public.launch_tests set
    title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else title end,
    category = case when p_patch ? 'category' then btrim(p_patch ->> 'category') else category end,
    purpose = case when p_patch ? 'purpose' then btrim(p_patch ->> 'purpose') else purpose end,
    steps = case when p_patch ? 'steps' then array(select btrim(x) from jsonb_array_elements_text(p_patch -> 'steps') x where btrim(x) <> '') else steps end,
    expected_outcome = case when p_patch ? 'expected_outcome' then btrim(p_patch ->> 'expected_outcome') else expected_outcome end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    mandatory = case when p_patch ? 'mandatory' then (p_patch ->> 'mandatory')::boolean else mandatory end,
    platform = case when p_patch ? 'platform' then p_patch ->> 'platform' else platform end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::integer else sort_order end,
    active = case when p_patch ? 'active' then (p_patch ->> 'active')::boolean else active end,
    target_url = case when p_patch ? 'target_url' then nullif(btrim(p_patch ->> 'target_url'), '') else target_url end,
    target_note = case when p_patch ? 'target_note' then nullif(btrim(p_patch ->> 'target_note'), '') else target_note end,
    money_test_type = case when p_patch ? 'money_test_type' then p_patch ->> 'money_test_type' else money_test_type end,
    expected_max_spend_pence = case when p_patch ? 'expected_max_spend_pence' then nullif(p_patch ->> 'expected_max_spend_pence', '')::integer else expected_max_spend_pence end,
    help_text = case when p_patch ? 'help_text' then nullif(btrim(p_patch ->> 'help_text'), '') else help_text end,
    effort_minutes = case when p_patch ? 'effort_minutes' then nullif(p_patch ->> 'effort_minutes', '')::integer else effort_minutes end,
    updated_at = now()
  where id = p_test;
  if not found then raise exception 'No such test' using errcode = 'P0002'; end if;
end $$;

create or replace function public.launch_test_admin_review(p_attempt uuid, p_state text, p_note text default null)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  if p_state not in ('open', 'reviewed', 'fix_pending', 'ready_for_retest', 'resolved') then raise exception 'Unknown review state' using errcode = '22023'; end if;
  update public.launch_test_attempts
     set review_state = p_state, admin_note = coalesce(nullif(btrim(left(coalesce(p_note, ''), 2000)), ''), admin_note),
         reviewed_by = auth.uid(), reviewed_at = now(),
         retest_requested = case when p_state = 'ready_for_retest' then true when p_state = 'resolved' then false else retest_requested end,
         retest_requested_at = case when p_state = 'ready_for_retest' and not retest_requested then now() else retest_requested_at end
   where id = p_attempt and status in ('issue', 'blocked');
  if not found then raise exception 'Only an issue or a blocked result can be reviewed' using errcode = 'P0002'; end if;
end $$;

create or replace function public.launch_test_admin_request_retest(p_attempt uuid, p_note text default null)
  returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  update public.launch_test_attempts
     set retest_requested = true, retest_requested_at = now(), retest_requested_by = auth.uid(),
         admin_note = coalesce(nullif(btrim(left(coalesce(p_note, ''), 2000)), ''), admin_note),
         review_state = case when status in ('issue', 'blocked') then 'ready_for_retest' else review_state end
   where id = p_attempt and status <> 'in_progress';
  if not found then raise exception 'Only a submitted result can be sent for a re-check' using errcode = 'P0002'; end if;
end $$;

-- Latest attempt for every test × tester × phone type, plus what the matrix needs; the readiness rules are applied by the application.
create or replace function public.launch_test_admin_latest(p_programme uuid)
  returns table (attempt_id uuid, test_id uuid, user_id uuid, platform text, app_build text, status text, review_state text, retest_requested boolean,
                 started_at timestamptz, completed_at timestamptz, attempts_total integer)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.launch_test_admin_ok() then raise exception 'Only an administrator can do this' using errcode = '42501'; end if;
  return query
    select distinct on (a.test_id, a.user_id, s.platform)
           a.id, a.test_id, a.user_id, s.platform, s.app_build, a.status, a.review_state, a.retest_requested, a.started_at, a.completed_at,
           (select count(*)::integer from public.launch_test_attempts x where x.test_id = a.test_id and x.user_id = a.user_id and x.session_id = a.session_id)
      from public.launch_test_attempts a
      join public.launch_test_sessions s on s.id = a.session_id
     where a.programme_id = p_programme
     order by a.test_id, a.user_id, s.platform, a.created_at desc;
end $$;

revoke all on function
  public.launch_test_open_session(uuid, text, text, text), public.launch_test_start(uuid, uuid, boolean), public.launch_test_submit(uuid, text, text, text),
  public.launch_test_add_attachment(uuid, text, text, integer), public.launch_test_admin_testers(uuid), public.launch_test_admin_add_tester(uuid, text, text[], text),
  public.launch_test_admin_update_tester(uuid, boolean, text[], text), public.launch_test_admin_update_programme(uuid, jsonb), public.launch_test_admin_update_test(uuid, jsonb),
  public.launch_test_admin_review(uuid, text, text), public.launch_test_admin_request_retest(uuid, text), public.launch_test_admin_latest(uuid)
  from public, anon;
grant execute on function
  public.launch_test_open_session(uuid, text, text, text), public.launch_test_start(uuid, uuid, boolean), public.launch_test_submit(uuid, text, text, text),
  public.launch_test_add_attachment(uuid, text, text, integer), public.launch_test_admin_testers(uuid), public.launch_test_admin_add_tester(uuid, text, text[], text),
  public.launch_test_admin_update_tester(uuid, boolean, text[], text), public.launch_test_admin_update_programme(uuid, jsonb), public.launch_test_admin_update_test(uuid, jsonb),
  public.launch_test_admin_review(uuid, text, text), public.launch_test_admin_request_retest(uuid, text), public.launch_test_admin_latest(uuid)
  to authenticated, service_role;

-- ── private evidence bucket ────────────────────────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('launch-test-evidence', 'launch-test-evidence', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Object path is always <attempt id>/<generated uuid>.<ext>: a tester can only write under an attempt that is theirs, with a name the server-side
-- check below accepts; SELECT is the owner of that attempt or an administrator; nobody can overwrite (UPDATE is closed) and only an admin deletes.
create policy "launch-test-evidence insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'launch-test-evidence'
    and objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
    and exists (
      select 1 from public.launch_test_attempts a
       where a.id::text = (storage.foldername(objects.name))[1]
         and a.user_id = auth.uid()
         and public.launch_test_is_enabled_tester(a.programme_id)
    )
  );
create policy "launch-test-evidence read" on storage.objects for select to authenticated
  using (
    bucket_id = 'launch-test-evidence'
    and (public.is_admin() or exists (
      select 1 from public.launch_test_attempts a
       where a.id::text = (storage.foldername(objects.name))[1]
         and a.user_id = auth.uid()
         and public.launch_test_is_enabled_tester(a.programme_id)
    ))
  );
create policy "launch-test-evidence update" on storage.objects for update to authenticated
  using (bucket_id = 'launch-test-evidence' and false) with check (bucket_id = 'launch-test-evidence' and false);
create policy "launch-test-evidence delete" on storage.objects for delete to authenticated
  using (bucket_id = 'launch-test-evidence' and public.is_admin());

-- ── the first programme and its nine acceptance tests ──────────────────────────────────────────────────────────────────────
insert into public.launch_test_programmes (slug, name, description, status, expected_ios_build, expected_android_version)
values ('rc1', 'OneShetland Launch Acceptance – RC1',
        'Real journeys in the live OneShetland app, checked by trusted testers before launch.',
        'active', 'Build 148', '1.0.0 (version code 3)');

insert into public.launch_tests
  (programme_id, slug, category, title, purpose, steps, expected_outcome, priority, mandatory, sort_order, money_test_type, expected_max_spend_pence, effort_minutes, target_note)
select p.id, t.slug, t.category, t.title, t.purpose, t.steps, t.expected_outcome, t.priority, true, t.sort_order, t.money, t.max_spend, t.effort, t.target_note
from public.launch_test_programmes p
cross join (values
  ('sign-in-account', 'Account', 'Sign in and account',
   'Make sure people can get into their account and see their own details.',
   array['If you are signed in, sign out first.', 'Sign back in to your normal OneShetland account.', 'Tap your initials at the top right of Home to open Me / Profile.', 'Check your account screen loads normally.'],
   'You sign in without trouble and your normal profile and account information appears. No errors or strange jumps to other screens.',
   'critical', 10, 'none', null::integer, 3, null::text),
  ('home-navigation', 'Getting around', 'Home and core navigation',
   'Check the main parts of the app open and you can move between them.',
   array['Open Home.', 'Visit several of the main sections from the menu or tabs.', 'Go back to Home.'],
   'Every screen loads normally, moving around works, and nothing is blank or shows an error.',
   'critical', 20, 'none', null, 3, null),
  ('directory-map', 'Directory', 'Directory, a business and its map',
   'Check businesses can be found and that the map on a business page shows properly — we fixed Android maps recently.',
   array['Open Directory.', 'Search or browse and pick a real business.', 'Open its page.', 'Find and look at its map or location area.'],
   'Search or browse works, the business details appear, and the map shows (not a blank or grey box).',
   'critical', 30, 'none', null, 4, null),
  ('whats-on', 'What''s On', 'What''s On events',
   'Check the events list and an event page work and read clearly.',
   array['Open What''s On.', 'Pick an event.', 'Open it and read the date, time, place and any buttons.'],
   'The list and the event page load, the information makes sense, and any links or buttons behave properly. (You do not need to buy a ticket.)',
   'critical', 40, 'none', null, 3, null),
  ('shop-wallet', 'Shop', 'Buy something small with your Wallet',
   'Check a Wallet purchase takes the right amount once and creates one order.',
   array['Check you have enough Wallet balance for a low-value item. If you do not, choose "I couldn''t complete it" and say your balance was too low.', 'Open the item your tester guide names (or a low-value product).', 'Check out using your OneShetland Wallet.', 'Look at the order confirmation and your order history.'],
   'The payment completes once, your Wallet goes down by the right amount once, exactly one order appears, and the confirmation and order history are correct.',
   'critical', 50, 'wallet', 200, 6, 'Tester guide: name the low-value product to buy here.'),
  ('shop-card', 'Shop', 'Buy something small with your own card',
   'Check a real card payment works end to end with no duplicate charge or order.',
   array['Open the item your tester guide names (or a low-value product).', 'Check out and pay with your own bank card.', 'Complete the payment.', 'Look at the confirmation and your order history.'],
   'The payment succeeds, exactly one order exists, you are not charged twice, and the order shows in your history.',
   'critical', 60, 'real_card', 200, 6, 'Tester guide: name the low-value product to buy here.'),
  ('hub-donation', 'Hubs', 'Give a small donation to a Hub',
   'Check donating works and does not charge twice.',
   array['Open the Hub or campaign your tester guide names.', 'Choose a small amount and donate.', 'Follow the steps to the confirmation.', 'Go back to the Hub and check it still works.'],
   'The donation completes, a confirmation appears, you are charged once, and the Hub carries on working afterwards.',
   'critical', 70, 'donation', 200, 5, 'Tester guide: name the Hub or campaign here.'),
  ('wallet-history', 'Wallet', 'Wallet balance and history',
   'After the purchases above, check the Wallet tells a clear, correct story.',
   array['Open Wallet.', 'Look at your balance.', 'Look at the recent activity list.'],
   'Wallet loads, the balance and history make sense together, and nothing appears twice that should not.',
   'high', 80, 'none', null, 3, null),
  ('games-spik', 'Games and Spik', 'Games and Spik',
   'Check the fun parts of the app load and work.',
   array['Open Games.', 'Open at least one game and have a go.', 'Open Spik.', 'Browse or search for a word.'],
   'Both sections load, the game responds to what you do, and Spik words display properly. (Your score does not matter.)',
   'high', 90, 'none', null, 4, null)
) as t(slug, category, title, purpose, steps, expected_outcome, priority, sort_order, money, max_spend, effort, target_note)
where p.slug = 'rc1';

-- ── prove the end state inside the same transaction ────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['launch_test_programmes', 'launch_testers', 'launch_tests', 'launch_test_sessions', 'launch_test_attempts', 'launch_test_attachments'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '% has no RLS', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE') or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception '% is reachable by a client role beyond authenticated SELECT', t;
    end if;
  end loop;
  if (select public from storage.buckets where id = 'launch-test-evidence') then raise exception 'evidence bucket is public'; end if;
  if (select count(*) from public.launch_tests) <> 9 then raise exception 'expected the nine seeded tests'; end if;
end $$;

commit;

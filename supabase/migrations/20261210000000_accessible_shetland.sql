-- Accessible Shetland: practical access and assistance information for businesses, Hubs, Regular Activities and Events.
--
-- ONE set of records, four kinds of subject (business | hub | activity | event). Nothing here duplicates a listing: a profile is keyed by the listing's own id.
--
-- PRINCIPLES (enforced here, not just in the interface)
--   * Free for every owner: no plan check anywhere.
--   * Missing information never means "inaccessible": a facility with no row is simply "not provided". There is no overall rating, no score and no
--     "fully accessible" flag. Each facility is Available / Partly available / Not available / Not known, with a short plain-language detail.
--   * Provenance is explicit. Every profile says WHO provided it (the owner, or OneShetland staff from a stated source) and WHEN it was last updated or
--     confirmed. The verification level starts as 'owner_provided'. Only staff can raise it to 'official_source' or 'independently_checked', and
--     independently_checked REQUIRES a note saying who checked and when (a staff function refuses otherwise). Nothing is implied to be inspected.
--   * Owners manage their own: the same ownership rules as the rest of the product (business owner, Hub owner/committee, activity manager,
--     event organiser). Staff can read and edit everything, and can hide a profile; every change is written to an audit table.
--   * Corrections and suggestions come from signed-in members, are rate-limited, never change public details by themselves, and are reviewed by staff.
--     A reporter never has to say anything about themselves; their identity is hidden from the owner.
--   * No health or disability information about any person is collected anywhere here.
--
-- ROLLBACK: drop table accessibility_audit, accessibility_reports, accessibility_facts, accessibility_profiles, accessibility_sources (that order, CASCADE) and
-- the functions accessibility_*, save_accessibility, admin_*accessibility*.

-- 1. The vocabulary of facilities (labels live in the website; the database only knows the keys) ------------------------------------------------------
create or replace function public.accessibility_facility_keys()
returns text[] language sql immutable as $$
  select array[
    'step_free_entrance','ramp','lift','automatic_door','wide_doors','level_inside',
    'accessible_parking','drop_off',
    'accessible_toilet','changing_places',
    'wheelchair_seating','seating_available','space_to_move',
    'hearing_loop','communication_support','large_print_or_easy_read',
    'visual_support',
    'quiet_space','quiet_times','sensory_friendly',
    'assistance_dogs_welcome','staff_assistance','companion_or_carer','equipment_available'
  ]
$$;

-- 2. Profiles and facts ----------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.accessibility_profiles (
  subject_type       text not null check (subject_type in ('business','hub','activity','event')),
  subject_id         uuid not null,
  published          boolean not null default false,
  summary            text check (summary is null or char_length(summary) <= 1000),
  visit_tips         text check (visit_tips is null or char_length(visit_tips) <= 1000),
  access_contact     text check (access_contact is null or char_length(access_contact) <= 300),
  last_confirmed_at  timestamptz,
  last_editor_kind   text not null default 'owner' check (last_editor_kind in ('owner','staff')),
  verification       text not null default 'owner_provided' check (verification in ('owner_provided','official_source','independently_checked')),
  verification_note  text check (verification_note is null or char_length(verification_note) <= 500),
  verified_on        date,
  verified_by        uuid references auth.users(id) on delete set null,
  hidden_by_staff    boolean not null default false,
  hidden_reason      text check (hidden_reason is null or char_length(hidden_reason) <= 300),
  hidden_by          uuid references auth.users(id) on delete set null,
  hidden_at          timestamptz,
  created_by         uuid references auth.users(id) on delete set null,
  updated_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (subject_type, subject_id),
  -- a verification above 'owner_provided' must say how and when
  constraint ap_verification_explained check (verification = 'owner_provided' or (verification_note is not null and char_length(btrim(verification_note)) >= 10 and verified_on is not null))
);
create index if not exists idx_ap_published on public.accessibility_profiles (subject_type, updated_at desc) where published and not hidden_by_staff;

create table if not exists public.accessibility_facts (
  subject_type text not null,
  subject_id   uuid not null,
  facility     text not null check (facility = any (public.accessibility_facility_keys())),
  status       text not null check (status in ('available','partial','not_available','not_known')),
  detail       text check (detail is null or char_length(detail) <= 400),
  primary key (subject_type, subject_id, facility),
  foreign key (subject_type, subject_id) references public.accessibility_profiles(subject_type, subject_id) on delete cascade
);
create index if not exists idx_af_facility on public.accessibility_facts (facility, subject_type) where status in ('available','partial');

-- 3. Who may see, who may edit -----------------------------------------------------------------------------------------------------------------------------
-- Is the listing itself public right now? Each branch reads the listing's own table AS THE CALLER, so the listing's own row security decides (an
-- unpublished activity, a hidden event or a test fixture is simply not there for a visitor).
create or replace function public.accessibility_subject_visible(p_type text, p_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select case p_type
    when 'business' then exists (select 1 from public.local_businesses_public b where b.id = p_id) and not public.is_discovery_hidden('business', p_id)
    when 'hub'      then exists (select 1 from public.hubs h where h.id = p_id and h.is_active) and not public.is_discovery_hidden('hub', p_id)
    when 'activity' then exists (select 1 from public.regular_activities a where a.id = p_id and a.status = 'published' and not a.admin_paused)
    when 'event'    then exists (select 1 from public.events e where e.id = p_id and e.status = 'published' and not e.is_hidden)
    else false end
$$;

-- The people who run the listing, by the product's existing ownership rules. Staff are NOT included here.
create or replace function public.accessibility_is_manager(p_type text, p_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select auth.uid() is not null and case p_type
    when 'business' then public.controls_event_entity(p_id, null)
    when 'hub'      then public.controls_event_entity(null, p_id)
    when 'activity' then exists (select 1 from public.regular_activities a where a.id = p_id and not a.is_platform_activity and public.controls_event_entity(a.organiser_business_id, a.organiser_hub_id))
    when 'event'    then exists (select 1 from public.events e where e.id = p_id and public.controls_event_entity(e.organiser_business_id, e.organiser_hub_id))
    else false end
$$;

create or replace function public.accessibility_can_edit(p_type text, p_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select auth.uid() is not null and (public.accessibility_is_manager(p_type, p_id) or public.attribution_staff())
$$;

alter table public.accessibility_profiles enable row level security;
alter table public.accessibility_facts    enable row level security;

drop policy if exists ap_public_read on public.accessibility_profiles;
create policy ap_public_read on public.accessibility_profiles for select to anon, authenticated
  using (published and not hidden_by_staff and public.accessibility_subject_visible(subject_type, subject_id));
drop policy if exists ap_manager_read on public.accessibility_profiles;
create policy ap_manager_read on public.accessibility_profiles for select to authenticated using (public.accessibility_can_edit(subject_type, subject_id));
drop policy if exists ap_manager_insert on public.accessibility_profiles;
create policy ap_manager_insert on public.accessibility_profiles for insert to authenticated with check (public.accessibility_can_edit(subject_type, subject_id));
drop policy if exists ap_manager_update on public.accessibility_profiles;
create policy ap_manager_update on public.accessibility_profiles for update to authenticated using (public.accessibility_can_edit(subject_type, subject_id)) with check (public.accessibility_can_edit(subject_type, subject_id));
drop policy if exists ap_manager_delete on public.accessibility_profiles;
create policy ap_manager_delete on public.accessibility_profiles for delete to authenticated using (public.accessibility_can_edit(subject_type, subject_id));

-- A fact is visible exactly when its profile is (the profile subquery is itself row-secured), and editable exactly when its listing is.
drop policy if exists af_read on public.accessibility_facts;
create policy af_read on public.accessibility_facts for select to anon, authenticated
  using (exists (select 1 from public.accessibility_profiles p where p.subject_type = accessibility_facts.subject_type and p.subject_id = accessibility_facts.subject_id));
drop policy if exists af_manager_write on public.accessibility_facts;
create policy af_manager_write on public.accessibility_facts for all to authenticated
  using (public.accessibility_can_edit(subject_type, subject_id)) with check (public.accessibility_can_edit(subject_type, subject_id));

revoke all on public.accessibility_profiles, public.accessibility_facts from public, anon, authenticated;
-- Visitors read the content and the provenance. Owners write the content only: verification, hiding and who-did-what are not theirs to set.
grant select (subject_type, subject_id, published, summary, visit_tips, access_contact, updated_at, last_confirmed_at, last_editor_kind, verification, verification_note, verified_on)
  on public.accessibility_profiles to anon;
grant select (subject_type, subject_id, published, summary, visit_tips, access_contact, updated_at, last_confirmed_at, last_editor_kind, verification, verification_note, verified_on, hidden_by_staff, hidden_reason, created_at)
  on public.accessibility_profiles to authenticated;
grant insert (subject_type, subject_id, published, summary, visit_tips, access_contact, last_confirmed_at) on public.accessibility_profiles to authenticated;
grant update (published, summary, visit_tips, access_contact, last_confirmed_at) on public.accessibility_profiles to authenticated;
grant delete on public.accessibility_profiles to authenticated;
grant select on public.accessibility_facts to anon, authenticated;
grant insert, update, delete on public.accessibility_facts to authenticated;

-- 4. Housekeeping triggers ------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.tg_ap_stamp()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.verification := 'owner_provided'; new.verification_note := null; new.verified_on := null; new.verified_by := null;
    new.hidden_by_staff := false; new.hidden_reason := null; new.hidden_by := null; new.hidden_at := null;
  else
    if new.subject_type <> old.subject_type or new.subject_id <> old.subject_id then raise exception 'A profile cannot be moved to another listing' using errcode = '42501'; end if;
    -- only a change of CONTENT counts as an edit by this person; a staff verification or hide must not re-stamp the author
    if new.summary is not distinct from old.summary and new.visit_tips is not distinct from old.visit_tips and new.access_contact is not distinct from old.access_contact
       and new.published = old.published and new.last_confirmed_at is not distinct from old.last_confirmed_at then
      return new;
    end if;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  new.last_editor_kind := case when public.accessibility_is_manager(new.subject_type, new.subject_id) then 'owner' else 'staff' end;
  -- A staff verification describes the information as it was when it was checked. If the owner then changes it, it is no longer what was checked.
  if tg_op = 'UPDATE' and new.last_editor_kind = 'owner' and new.verification <> 'owner_provided' then
    new.verification := 'owner_provided'; new.verification_note := null; new.verified_on := null; new.verified_by := null;
  end if;
  return new;
end $$;
drop trigger if exists tg_ap_stamp on public.accessibility_profiles;
create trigger tg_ap_stamp before insert or update on public.accessibility_profiles for each row execute function public.tg_ap_stamp();

-- Same rule for the facility answers: an owner changing them ends any staff verification of the earlier version.
create or replace function public.tg_af_reset_verification()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare t text := coalesce(new.subject_type, old.subject_type); i uuid := coalesce(new.subject_id, old.subject_id);
begin
  if public.accessibility_is_manager(t, i) then
    update public.accessibility_profiles set verification = 'owner_provided', verification_note = null, verified_on = null, verified_by = null
     where subject_type = t and subject_id = i and verification <> 'owner_provided';
  end if;
  return null;
end $$;
revoke all on function public.tg_af_reset_verification() from public, anon, authenticated;
drop trigger if exists tg_af_reset on public.accessibility_facts;
create trigger tg_af_reset after insert or update or delete on public.accessibility_facts for each row execute function public.tg_af_reset_verification();

-- 5. Audit: who changed what, when. Written by triggers (the trigger function is the only writer), readable by staff only. ----------------------------
create table if not exists public.accessibility_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        uuid,
  action       text not null,
  subject_type text,
  subject_id   uuid,
  detail       jsonb
);
create index if not exists idx_aa_at on public.accessibility_audit (at desc);
create index if not exists idx_aa_subject on public.accessibility_audit (subject_type, subject_id, at desc);
alter table public.accessibility_audit enable row level security;
drop policy if exists aa_staff_read on public.accessibility_audit;
create policy aa_staff_read on public.accessibility_audit for select to authenticated using (public.attribution_staff());
revoke all on public.accessibility_audit from public, anon, authenticated;
grant select on public.accessibility_audit to authenticated;

create or replace function public.tg_accessibility_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; d jsonb;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  if tg_table_name = 'accessibility_profiles' then
    d := case tg_op
      when 'INSERT' then jsonb_build_object('published', new.published)
      when 'DELETE' then jsonb_build_object('deleted', true)
      else jsonb_strip_nulls(jsonb_build_object(
        'published', case when new.published is distinct from old.published then new.published end,
        'text_changed', case when new.summary is distinct from old.summary or new.visit_tips is distinct from old.visit_tips or new.access_contact is distinct from old.access_contact then true end,
        'confirmed', case when new.last_confirmed_at is distinct from old.last_confirmed_at then true end,
        'verification', case when new.verification is distinct from old.verification then new.verification end,
        'hidden', case when new.hidden_by_staff is distinct from old.hidden_by_staff then new.hidden_by_staff end,
        'editor', new.last_editor_kind)) end;
    insert into public.accessibility_audit(actor, action, subject_type, subject_id, detail) values (auth.uid(), 'profile_' || lower(tg_op), r.subject_type, r.subject_id, d);
  elsif tg_table_name = 'accessibility_facts' then
    if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.detail is not distinct from old.detail then return null; end if;
    insert into public.accessibility_audit(actor, action, subject_type, subject_id, detail)
    values (auth.uid(), 'fact_' || lower(tg_op), r.subject_type, r.subject_id, jsonb_build_object('facility', r.facility, 'status', case when tg_op = 'DELETE' then null else new.status end));
  end if;
  return null;
end $$;
revoke all on function public.tg_accessibility_audit() from public, anon, authenticated;
drop trigger if exists tg_ap_audit on public.accessibility_profiles;
create trigger tg_ap_audit after insert or update or delete on public.accessibility_profiles for each row execute function public.tg_accessibility_audit();
drop trigger if exists tg_af_audit on public.accessibility_facts;
create trigger tg_af_audit after insert or update or delete on public.accessibility_facts for each row execute function public.tg_accessibility_audit();

-- 6. Saving: one atomic call, run AS THE CALLER so row security is the authority ----------------------------------------------------------------------------
-- p_facts is the complete list of answered facilities: [{"facility":"hearing_loop","status":"available","detail":"..."}]. Anything not listed is removed
-- (it simply becomes "not provided"). Publishing needs at least one detail or a summary, so an empty page is never published.
create or replace function public.save_accessibility(p_type text, p_id uuid, p_publish boolean, p_profile jsonb, p_facts jsonb, p_confirm boolean default false)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  f jsonb; v_keys text[] := '{}'; v_n int := 0; v_status text; v_detail text; v_key text;
  v_summary text; v_tips text; v_contact text;
  clean text := '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]';
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if p_type not in ('business','hub','activity','event') then raise exception 'Unknown kind of listing' using errcode = '22023'; end if;
  if not public.accessibility_can_edit(p_type, p_id) then raise exception 'You cannot edit access information for this listing' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_facts, '[]'::jsonb)) <> 'array' then raise exception 'Facilities must be a list' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p_facts, '[]'::jsonb)) > 60 then raise exception 'Too many facilities' using errcode = '22023'; end if;

  v_summary := nullif(btrim(regexp_replace(coalesce(p_profile ->> 'summary', ''), clean, '', 'g')), '');
  v_tips    := nullif(btrim(regexp_replace(coalesce(p_profile ->> 'visit_tips', ''), clean, '', 'g')), '');
  v_contact := nullif(btrim(regexp_replace(coalesce(p_profile ->> 'access_contact', ''), clean, '', 'g')), '');
  if char_length(coalesce(v_summary, '')) > 1000 or char_length(coalesce(v_tips, '')) > 1000 then raise exception 'That text is too long (1,000 characters at most)' using errcode = '22023'; end if;
  if char_length(coalesce(v_contact, '')) > 300 then raise exception 'The contact details are too long (300 characters at most)' using errcode = '22023'; end if;

  for f in select * from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) loop
    v_key := f ->> 'facility'; v_status := f ->> 'status'; v_detail := nullif(btrim(regexp_replace(coalesce(f ->> 'detail', ''), clean, '', 'g')), '');
    if v_key is null or not (v_key = any (public.accessibility_facility_keys())) then raise exception 'Unknown facility: %', coalesce(v_key, '(none)') using errcode = '22023'; end if;
    if v_status is null or v_status not in ('available','partial','not_available','not_known') then raise exception 'Choose Yes, Partly, No or Not sure for each answer' using errcode = '22023'; end if;
    if char_length(coalesce(v_detail, '')) > 400 then raise exception 'A detail is too long (400 characters at most)' using errcode = '22023'; end if;
    if v_key = any (v_keys) then raise exception 'Each facility can be answered once' using errcode = '22023'; end if;
    v_keys := v_keys || v_key; v_n := v_n + 1;
  end loop;

  if p_publish and v_n = 0 and v_summary is null and v_tips is null and v_contact is null then
    raise exception 'Add at least one detail before publishing, or save it as a draft.' using errcode = 'P0001';
  end if;

  insert into public.accessibility_profiles as p (subject_type, subject_id, published, summary, visit_tips, access_contact, last_confirmed_at)
  values (p_type, p_id, p_publish, v_summary, v_tips, v_contact, case when p_confirm then now() end)
  on conflict (subject_type, subject_id) do update set
    published = excluded.published, summary = excluded.summary, visit_tips = excluded.visit_tips, access_contact = excluded.access_contact,
    last_confirmed_at = case when p_confirm then now() else p.last_confirmed_at end;

  delete from public.accessibility_facts where subject_type = p_type and subject_id = p_id and not (facility = any (v_keys));
  for f in select * from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) loop
    insert into public.accessibility_facts(subject_type, subject_id, facility, status, detail)
    values (p_type, p_id, f ->> 'facility', f ->> 'status', nullif(btrim(regexp_replace(coalesce(f ->> 'detail', ''), clean, '', 'g')), ''))
    on conflict (subject_type, subject_id, facility) do update set status = excluded.status, detail = excluded.detail;
  end loop;
  return jsonb_build_object('published', p_publish, 'facilities', v_n);
end $$;
revoke all on function public.save_accessibility(text, uuid, boolean, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.save_accessibility(text, uuid, boolean, jsonb, jsonb, boolean) to authenticated;

-- 7. Corrections and contributions ------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.accessibility_reports (
  id           uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('business','hub','activity','event')),
  subject_id   uuid not null,
  kind         text not null check (kind in ('incorrect','add','other')),
  message      text not null check (char_length(message) between 10 and 1000),
  reporter_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status       text not null default 'new' check (status in ('new','accepted','rejected','applied')),
  staff_note   text check (staff_note is null or char_length(staff_note) <= 500),
  reviewed_by  uuid references auth.users(id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ar_status on public.accessibility_reports (status, created_at desc);
create index if not exists idx_ar_subject on public.accessibility_reports (subject_type, subject_id, created_at desc);
create index if not exists idx_ar_reporter on public.accessibility_reports (reporter_id, created_at desc);
alter table public.accessibility_reports enable row level security;

create or replace function public.tg_ar_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.message := btrim(regexp_replace(new.message, '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g'));
  if char_length(new.message) < 10 then raise exception 'Please add a little more detail (10 characters at least).' using errcode = 'P0001'; end if;
  new.status := 'new'; new.staff_note := null; new.reviewed_by := null; new.reviewed_at := null; new.reporter_id := auth.uid();
  if (select count(*) from public.accessibility_reports where reporter_id = new.reporter_id and created_at > now() - interval '24 hours') >= 8 then
    raise exception 'You have sent several suggestions today. Please try again tomorrow.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.accessibility_reports where reporter_id = new.reporter_id and subject_type = new.subject_type and subject_id = new.subject_id and status = 'new') >= 2 then
    raise exception 'You already have suggestions waiting for this listing. We will review them soon.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.accessibility_reports where reporter_id = new.reporter_id and subject_type = new.subject_type and subject_id = new.subject_id and lower(message) = lower(new.message)) then
    raise exception 'We already have that suggestion.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.tg_ar_guard() from public, anon, authenticated;
drop trigger if exists tg_ar_guard on public.accessibility_reports;
create trigger tg_ar_guard before insert on public.accessibility_reports for each row execute function public.tg_ar_guard();

drop policy if exists ar_insert on public.accessibility_reports;
create policy ar_insert on public.accessibility_reports for insert to authenticated
  with check (reporter_id = auth.uid() and public.accessibility_subject_visible(subject_type, subject_id));
drop policy if exists ar_read on public.accessibility_reports;
create policy ar_read on public.accessibility_reports for select to authenticated
  using (reporter_id = auth.uid() or public.accessibility_is_manager(subject_type, subject_id));
revoke all on public.accessibility_reports from public, anon, authenticated;
-- The owner sees what was suggested about their listing and its status, never who suggested it, and never staff notes.
grant select (id, subject_type, subject_id, kind, message, status, created_at) on public.accessibility_reports to authenticated;
grant insert (subject_type, subject_id, kind, message) on public.accessibility_reports to authenticated;

create or replace function public.tg_accessibility_report_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.accessibility_audit(actor, action, subject_type, subject_id, detail)
  values (auth.uid(), 'report_' || lower(tg_op), new.subject_type, new.subject_id, jsonb_build_object('report', new.id, 'kind', new.kind, 'status', new.status));
  return null;
end $$;
revoke all on function public.tg_accessibility_report_audit() from public, anon, authenticated;
drop trigger if exists tg_ar_audit on public.accessibility_reports;
create trigger tg_ar_audit after insert or update on public.accessibility_reports for each row execute function public.tg_accessibility_report_audit();

-- 8. Source register (staff only): where information MIGHT come from, and what we are allowed to do with it ------------------------------------------------------
create table if not exists public.accessibility_sources (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 2 and 160),
  url            text not null check (url ~* '^https://[^\s]+$'),
  kind           text not null default 'other' check (kind in ('official','operator','organisation','venue','other')),
  status         text not null default 'candidate' check (status in ('candidate','linked','imported','rejected')),
  licence_status text not null default 'unknown' check (licence_status in ('unknown','link_only','permitted','not_permitted')),
  licence_note   text check (licence_note is null or char_length(licence_note) <= 500),
  reviewed_on    date,
  notes          text check (notes is null or char_length(notes) <= 1000),
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  -- 'imported' is only allowed once reuse is permitted and a review date is recorded
  constraint as_import_needs_permission check (status <> 'imported' or (licence_status = 'permitted' and reviewed_on is not null))
);
alter table public.accessibility_sources enable row level security;
drop policy if exists as_staff on public.accessibility_sources;
create policy as_staff on public.accessibility_sources for all to authenticated using (public.attribution_staff()) with check (public.attribution_staff());
revoke all on public.accessibility_sources from public, anon, authenticated;
grant select, insert, update, delete on public.accessibility_sources to authenticated;

-- 9. Staff functions (definer, each checks staff itself) -----------------------------------------------------------------------------------------------------
create or replace function public.admin_set_accessibility_verification(p_type text, p_id uuid, p_verification text, p_note text, p_on date)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  if p_verification not in ('owner_provided','official_source','independently_checked') then raise exception 'Unknown verification level' using errcode = '22023'; end if;
  if p_verification <> 'owner_provided' and (p_note is null or char_length(btrim(p_note)) < 10 or p_on is null or p_on > current_date) then
    raise exception 'Say who checked or which source was used (10 characters at least) and the date it was checked, which cannot be in the future.' using errcode = 'P0001';
  end if;
  update public.accessibility_profiles
     set verification = p_verification, verification_note = case when p_verification = 'owner_provided' then null else btrim(p_note) end,
         verified_on = case when p_verification = 'owner_provided' then null else p_on end, verified_by = case when p_verification = 'owner_provided' then null else auth.uid() end
   where subject_type = p_type and subject_id = p_id;
  if not found then raise exception 'There is no profile for that listing' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.admin_set_accessibility_verification(text, uuid, text, text, date) from public, anon;
grant execute on function public.admin_set_accessibility_verification(text, uuid, text, text, date) to authenticated;

create or replace function public.admin_hide_accessibility(p_type text, p_id uuid, p_hide boolean, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  if p_hide and (p_reason is null or btrim(p_reason) = '') then raise exception 'Say why you are hiding it' using errcode = '22023'; end if;
  update public.accessibility_profiles set hidden_by_staff = p_hide, hidden_reason = case when p_hide then left(btrim(p_reason), 300) end,
         hidden_by = case when p_hide then auth.uid() end, hidden_at = case when p_hide then now() end
   where subject_type = p_type and subject_id = p_id;
  if not found then raise exception 'There is no profile for that listing' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.admin_hide_accessibility(text, uuid, boolean, text) from public, anon;
grant execute on function public.admin_hide_accessibility(text, uuid, boolean, text) to authenticated;

create or replace function public.admin_accessibility_reports(p_status text default null, p_limit integer default 100)
returns table (id uuid, subject_type text, subject_id uuid, subject_label text, kind text, message text, status text, created_at timestamptz, reporter_id uuid, staff_note text, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can see these' using errcode = '42501'; end if;
  return query
    select r.id, r.subject_type, r.subject_id,
           case r.subject_type when 'business' then (select b.name from public.local_businesses b where b.id = r.subject_id)
                               when 'hub' then (select h.name from public.hubs h where h.id = r.subject_id)
                               when 'activity' then (select a.title from public.regular_activities a where a.id = r.subject_id)
                               when 'event' then (select e.title from public.events e where e.id = r.subject_id) end,
           r.kind, r.message, r.status, r.created_at, r.reporter_id, r.staff_note, r.reviewed_at
      from public.accessibility_reports r where p_status is null or r.status = p_status
     order by (r.status = 'new') desc, r.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;
revoke all on function public.admin_accessibility_reports(text, integer) from public, anon;
grant execute on function public.admin_accessibility_reports(text, integer) to authenticated;

create or replace function public.admin_review_accessibility_report(p_id uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  if p_status not in ('new','accepted','rejected','applied') then raise exception 'Unknown status' using errcode = '22023'; end if;
  update public.accessibility_reports set status = p_status, staff_note = nullif(left(btrim(coalesce(p_note, '')), 500), ''), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  if not found then raise exception 'Suggestion not found' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.admin_review_accessibility_report(uuid, text, text) from public, anon;
grant execute on function public.admin_review_accessibility_report(uuid, text, text) to authenticated;

-- Participation overview for staff: how many listings have published information, and which claimed listings have none. Counts and names only.
create or replace function public.admin_accessibility_coverage()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can see this' using errcode = '42501'; end if;
  select jsonb_build_object(
    'profiles_published', (select count(*) from public.accessibility_profiles where published and not hidden_by_staff),
    'profiles_draft', (select count(*) from public.accessibility_profiles where not published),
    'by_verification', (select coalesce(jsonb_object_agg(verification, n), '{}'::jsonb) from (select verification, count(*) n from public.accessibility_profiles where published group by 1) x),
    'reports_new', (select count(*) from public.accessibility_reports where status = 'new'),
    'claimed_businesses', (select count(*) from public.local_businesses b where b.is_claimed and b.is_active and not public.is_discovery_hidden('business', b.id)),
    'claimed_without_profile', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.name), '[]'::jsonb) from (
        select b.id, b.name from public.local_businesses b where b.is_claimed and b.is_active and not public.is_discovery_hidden('business', b.id)
           and not exists (select 1 from public.accessibility_profiles p where p.subject_type = 'business' and p.subject_id = b.id and p.published) order by b.name limit 200) b)
  ) into v;
  return v;
end $$;
revoke all on function public.admin_accessibility_coverage() from public, anon;
grant execute on function public.admin_accessibility_coverage() to authenticated;

comment on table public.accessibility_profiles is 'Practical access and assistance information for a listing. Owner-provided unless staff verification says otherwise. Never a rating; missing means not provided.';

-- Da Boats: let the community SUBMIT A WHOLE NEW BOAT (hull), not just propose
-- edits to an existing one (that's vessel_edit_proposals). A "boat" here is the
-- HULL — the physical vessel, which keeps its identity across renames and
-- re-registrations. Submissions land here as 'pending'; an admin approves them
-- in Control Centre, which creates the vessel (+ its current name, any former
-- names as history, and a registration) via approve_vessel_submission().
-- Mirrors the spik_word_submissions moderation pattern (is_admin() guard,
-- SECURITY DEFINER approve RPC). Community-sourced identity is recorded at
-- 'possible' confidence so it reads as unverified until a curator upgrades it.

create table if not exists public.vessel_submissions (
  id                 uuid primary key default gen_random_uuid(),
  -- Hull identity (the permanent thing)
  canonical_name     text not null,        -- current / best-known name of the hull
  primary_lk_number  text,                 -- e.g. LK123 (registration mark)
  built_year         integer,
  builder            text,                 -- yard / builder, e.g. "Herd & Mackenzie, Buckie"
  yard_number        text,
  hull_material      text,                 -- F/S/W/A/U/O (see boats-data hullMaterialLabel)
  country_of_build   text,
  status             text,                 -- e.g. "Active", "Lost", "Scrapped"
  -- History / context
  former_names       text,                 -- other names the hull has carried (comma-separated)
  registration_note  text,
  identity_notes     text,
  possible_duplicate_id uuid,              -- a hull the submitter saw that MIGHT be this one
  -- Attribution + moderation
  submitter_id       uuid references auth.users(id) on delete set null,
  submitter_name     text,
  show_name          boolean not null default true,
  submission_status  text not null default 'pending' check (submission_status in ('pending','approved','rejected')),
  published_vessel_id uuid,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists vessel_submissions_pending_idx
  on public.vessel_submissions (created_at desc) where submission_status = 'pending';

alter table public.vessel_submissions enable row level security;

-- Anyone (signed in or not) may submit a new boat.
drop policy if exists "anyone can submit a vessel" on public.vessel_submissions;
create policy "anyone can submit a vessel" on public.vessel_submissions
  for insert to anon, authenticated with check (true);

-- Admins can read + triage.
drop policy if exists "admins read vessel submissions" on public.vessel_submissions;
create policy "admins read vessel submissions" on public.vessel_submissions
  for select to authenticated using (public.is_admin());

drop policy if exists "admins update vessel submissions" on public.vessel_submissions;
create policy "admins update vessel submissions" on public.vessel_submissions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Approve & publish: create the hull, its current name (primary), any former
-- names as non-primary history, and a registration if one was given. Admin-only.
create or replace function public.approve_vessel_submission(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.vessel_submissions%rowtype;
  v_id       uuid;
  v_key      text;
  v_norm     text;
  former      text;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;

  select * into s from public.vessel_submissions where id = p_id;
  if not found then raise exception 'Submission not found'; end if;
  if s.submission_status = 'approved' then return s.published_vessel_id; end if;

  v_id := gen_random_uuid();
  -- vessel_key must be unique; slug the name and suffix with a short id.
  v_key := lower(regexp_replace(coalesce(s.canonical_name, 'boat'), '[^a-zA-Z0-9]+', '-', 'g'))
           || '-' || left(replace(v_id::text, '-', ''), 8);

  insert into public.vessels (
    id, vessel_key, canonical_name, primary_lk_number, built_year, builder,
    yard_number, hull_material, country_of_build, status, identity_confidence,
    identity_notes, source_family, created_at, updated_at
  ) values (
    v_id, v_key, s.canonical_name, nullif(s.primary_lk_number, ''), s.built_year,
    nullif(s.builder, ''), nullif(s.yard_number, ''), nullif(s.hull_material, ''),
    nullif(s.country_of_build, ''), nullif(s.status, ''), 'possible',
    nullif(s.identity_notes, ''), 'community', now(), now()
  );

  -- Current / primary name.
  v_norm := lower(regexp_replace(s.canonical_name, '\s+', ' ', 'g'));
  insert into public.vessel_names (vessel_id, name, normalised_name, is_primary, confidence)
  values (v_id, s.canonical_name, v_norm, true, 'possible');

  -- Former names → non-primary history (comma / newline separated).
  if coalesce(s.former_names, '') <> '' then
    foreach former in array regexp_split_to_array(s.former_names, '\s*[,;\n]\s*') loop
      if length(trim(former)) > 0 then
        insert into public.vessel_names (vessel_id, name, normalised_name, is_primary, confidence)
        values (v_id, trim(former), lower(regexp_replace(trim(former), '\s+', ' ', 'g')), false, 'possible');
      end if;
    end loop;
  end if;

  -- Registration mark (if given).
  if coalesce(s.primary_lk_number, '') <> '' then
    insert into public.registrations (vessel_id, registration, is_primary, confidence)
    values (v_id, s.primary_lk_number, true, 'possible');
  end if;

  update public.vessel_submissions
     set submission_status = 'approved', published_vessel_id = v_id, reviewed_at = now()
   where id = p_id;

  return v_id;
end;
$$;

grant execute on function public.approve_vessel_submission(uuid) to authenticated;

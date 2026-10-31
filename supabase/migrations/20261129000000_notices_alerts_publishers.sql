-- Notices & Alerts - step 1: verified organisation publishers, Essential Alert entitlement, and the audit trail.
--
-- WHAT THIS ADDS (additive; nothing existing is changed, renamed or loosened):
--   official_publishers          a VERIFIED ORGANISATION identity (Shetland Islands Council, later NHS Shetland, Scottish Water, ...). It is NOT a hub or a
--                                business and never pretends to own one. Created and verified by a platform administrator only.
--   official_publisher_members   the user accounts authorised to publish AS that organisation: role 'publisher' (may designate an Essential Alert when the
--                                organisation holds the entitlement) or 'delegate' (ordinary official notices only). Explicit add / remove, with who and when.
--   essential_alert_grants       the ENTITLEMENT. One ACTIVE grant per organisation (partial unique index); granted and revoked by a platform administrator
--                                only, with a reason, and kept for ever (revocation closes the row, it never deletes it).
--   notice_audit_log             append-only record of entitlement changes and every essential / official publication. UPDATE and DELETE are refused.
--
-- WHY NOT can_publish_urgent: that flag is a per-BUSINESS permission to mark a notice 'urgent' (the old, loose system). It is deliberately NOT
-- converted: an urgent notice is not an Essential Alert. Essential is a separate, deliberate, server-validated designation (next migration).
--
-- SECURITY: every table has RLS enabled and NO policy, and no grant to anon / authenticated: clients cannot read or write them directly. Every
-- operation is a SECURITY DEFINER function that authorises the caller itself. Only a platform administrator (profiles.role = 'admin' or the platform owner;
-- NOT a moderator) can create / verify an organisation, manage its members, or grant / revoke the entitlement - there is no self-service path.
-- NOTHING here assigns a real entitlement: the tables start empty. Granting the first one is a deliberate administrator action after deployment.
begin;

-- ── a CLOSED account has no authority of any kind ────────────────────────────────────────────────────────────────────────────────────────────
-- The delete-account function scrubs the profile (profiles.deleted_at) and soft-deletes the sign-in, but a JWT it issued earlier stays valid until it expires. Every
-- authority check below therefore also asks whether the caller's account is closed, so a deleted administrator, publisher or delegate cannot act on a leftover token.
create or replace function public.account_is_closed(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.deleted_at is not null or p.is_active is false from public.profiles p where p.id = p_user), false);
$$;

-- ── who is a platform administrator (stricter than attribution_staff(), which includes moderators) ───────────────────────────────�
create or replace function public.notices_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and not public.account_is_closed(auth.uid()) and exists (
    select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or coalesce(p.is_platform_owner, false)));
$$;

-- ── organisations ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.official_publishers (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z][a-z0-9-]*$' and length(slug) <= 64),
  name              text not null check (btrim(name) <> '' and length(name) <= 120),
  kind              text not null check (kind in ('council', 'health', 'utility', 'transport', 'emergency', 'other')),
  website_url       text check (website_url is null or website_url ~ '^https://[^\s]+$'),
  verified_at       timestamptz,
  verified_by       uuid references public.profiles(id) on delete set null,
  verification_note text,
  is_active         boolean not null default true,
  import_source     text unique check (import_source is null or btrim(import_source) <> ''),   -- the notices.source value this organisation's imports use
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint official_publishers_verified_pair check (verified_at is not null or verified_by is null)   -- verified_by may be NULL later (account deleted)
);

create table public.official_publisher_members (
  publisher_id uuid not null references public.official_publishers(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,      -- deleting an account removes its authority with it
  role         text not null check (role in ('publisher', 'delegate')),
  is_active    boolean not null default true,
  added_by     uuid references public.profiles(id) on delete set null,
  added_at     timestamptz not null default now(),
  removed_by   uuid references public.profiles(id) on delete set null,
  removed_at   timestamptz,
  primary key (publisher_id, user_id)
);

create table public.essential_alert_grants (
  id             uuid primary key default gen_random_uuid(),
  publisher_id   uuid not null references public.official_publishers(id) on delete restrict,
  granted_by     uuid references public.profiles(id) on delete set null,
  granted_at     timestamptz not null default now(),
  reason         text not null check (btrim(reason) <> ''),
  revoked_by     uuid references public.profiles(id) on delete set null,
  revoked_at     timestamptz,
  revoked_reason text,
  constraint essential_grants_revoke_pair check ((revoked_at is null) = (revoked_reason is null))
);
create unique index essential_alert_grants_one_active on public.essential_alert_grants (publisher_id) where revoked_at is null;

-- ── audit (append only) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.notice_audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,                                  -- no FK: the record outlives an account
  actor_role   text,
  event        text not null check (event in (
    'publisher_created', 'publisher_verified', 'publisher_updated', 'member_added', 'member_removed', 'member_role_changed',
    'essential_granted', 'essential_revoked', 'essential_demoted',
    'notice_published', 'essential_published', 'notice_corrected', 'notice_resolved', 'notice_withdrawn',
    'dispatch_claimed', 'dispatch_completed',
    'funeral_submitted', 'funeral_reviewed', 'funeral_published', 'funeral_corrected', 'funeral_taken_down', 'funeral_change_requested',
    'person_notice_submitted', 'person_notice_edited', 'person_notice_approved', 'person_notice_declined', 'person_notice_withdrawn',
    'audit_text_redacted', 'funeral_submitter_scrubbed', 'member_memberships_deactivated', 'funeral_enquiry_received', 'funeral_retention_run', 'funeral_retention_hold',
    'import_source_changed', 'import_run')),
  publisher_id uuid,
  notice_id    uuid,
  funeral_id   uuid,
  details      jsonb not null default '{}'::jsonb
);
create index notice_audit_log_at_idx on public.notice_audit_log (at desc);
create index notice_audit_log_notice_idx on public.notice_audit_log (notice_id) where notice_id is not null;
create index notice_audit_log_publisher_idx on public.notice_audit_log (publisher_id) where publisher_id is not null;

create function public.tg_notice_audit_immutable() returns trigger language plpgsql as $$
begin
  -- The ONE controlled exception: admin_redact_audit_text (a definer function that sets notices.audit_redaction for its own transaction) may replace an existing text
  -- value inside `details` with the marker. Nothing else may change: every other column is identical, the set of keys is identical, and each changed value was a
  -- string that is now exactly "[redacted]". Anyone else (including the owner, outside that function) still gets the refusal.
  if tg_op = 'UPDATE' and coalesce(current_setting('notices.audit_redaction', true), '') = 'on'
     and (to_jsonb(new) - 'details') = (to_jsonb(old) - 'details')
     and (select array_agg(k order by k) from jsonb_object_keys(new.details) k) is not distinct from (select array_agg(k order by k) from jsonb_object_keys(old.details) k)
     and not exists (select 1 from jsonb_each(new.details) n join jsonb_each(old.details) o using (key)
                      where n.value is distinct from o.value and not (n.value = '"[redacted]"'::jsonb and jsonb_typeof(o.value) = 'string')) then
    return new;
  end if;
  raise exception 'The notices audit log is append-only' using errcode = '42501';
end $$;
create trigger notice_audit_log_immutable before update or delete on public.notice_audit_log for each row execute function public.tg_notice_audit_immutable();
create trigger notice_audit_log_no_truncate before truncate on public.notice_audit_log for each statement execute function public.tg_notice_audit_immutable();

create function public.notice_audit(p_event text, p_publisher uuid default null, p_notice uuid default null, p_funeral uuid default null, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.notice_audit_log (actor_id, actor_role, event, publisher_id, notice_id, funeral_id, details)
  values (auth.uid(), coalesce((select p.role from public.profiles p where p.id = auth.uid()), current_user), p_event, p_publisher, p_notice, p_funeral, coalesce(p_details, '{}'));
end $$;

-- ── lock the tables ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.official_publishers        enable row level security;
alter table public.official_publisher_members enable row level security;
alter table public.essential_alert_grants     enable row level security;
alter table public.notice_audit_log           enable row level security;
revoke all on public.official_publishers, public.official_publisher_members, public.essential_alert_grants, public.notice_audit_log from anon, authenticated;
revoke all on function public.notice_audit(text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- ── administrator operations ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create function public.admin_upsert_official_publisher(p_slug text, p_name text, p_kind text, p_website_url text default null, p_import_source text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  select id into v_id from public.official_publishers where slug = p_slug;
  if v_id is null then
    insert into public.official_publishers (slug, name, kind, website_url, import_source, created_by)
    values (p_slug, p_name, p_kind, p_website_url, nullif(btrim(p_import_source), ''), auth.uid()) returning id into v_id;
    perform public.notice_audit('publisher_created', v_id, null, null, jsonb_build_object('slug', p_slug, 'kind', p_kind));
  else
    update public.official_publishers set name = p_name, kind = p_kind, website_url = p_website_url, import_source = nullif(btrim(p_import_source), ''), updated_at = now()
     where id = v_id;
    perform public.notice_audit('publisher_updated', v_id, null, null, jsonb_build_object('slug', p_slug, 'kind', p_kind));
  end if;
  return v_id;
end $$;

-- Verification is a separate, deliberate act with a note saying HOW the organisation's identity was established (a phone call to a published number, a
-- signed letter, ...). Nothing can publish as an organisation until it is verified AND active.
create function public.admin_verify_official_publisher(p_publisher uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_note is null or btrim(p_note) = '' then raise exception 'Say how the organisation was verified' using errcode = '22023'; end if;
  update public.official_publishers set verified_at = now(), verified_by = auth.uid(), verification_note = btrim(p_note), updated_at = now() where id = p_publisher;
  if not found then raise exception 'Unknown organisation' using errcode = 'P0002'; end if;
  perform public.notice_audit('publisher_verified', p_publisher, null, null, jsonb_build_object('note', btrim(p_note)));
end $$;

create function public.admin_set_official_publisher_active(p_publisher uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  update public.official_publishers set is_active = p_active, updated_at = now() where id = p_publisher;
  if not found then raise exception 'Unknown organisation' using errcode = 'P0002'; end if;
  perform public.notice_audit('publisher_updated', p_publisher, null, null, jsonb_build_object('is_active', p_active));
end $$;

create function public.admin_set_official_publisher_member(p_publisher uuid, p_user uuid, p_role text, p_active boolean default true) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.official_publisher_members%rowtype;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_role not in ('publisher', 'delegate') then raise exception 'Role must be publisher or delegate' using errcode = '22023'; end if;
  if not exists (select 1 from public.official_publishers where id = p_publisher) then raise exception 'Unknown organisation' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'Unknown user' using errcode = 'P0002'; end if;
  if p_active and public.account_is_closed(p_user) then raise exception 'That account has been closed and cannot hold authority' using errcode = '22023'; end if;
  select * into v_old from public.official_publisher_members where publisher_id = p_publisher and user_id = p_user;
  if not found then
    insert into public.official_publisher_members (publisher_id, user_id, role, is_active, added_by) values (p_publisher, p_user, p_role, p_active, auth.uid());
    perform public.notice_audit(case when p_active then 'member_added' else 'member_removed' end, p_publisher, null, null, jsonb_build_object('user', p_user, 'role', p_role));
  else
    update public.official_publisher_members
       set role = p_role, is_active = p_active,
           removed_by = case when p_active then null else auth.uid() end, removed_at = case when p_active then null else now() end
     where publisher_id = p_publisher and user_id = p_user;
    perform public.notice_audit(case when v_old.is_active and not p_active then 'member_removed' when v_old.role <> p_role then 'member_role_changed' else 'member_added' end,
                                p_publisher, null, null, jsonb_build_object('user', p_user, 'role', p_role, 'active', p_active));
  end if;
end $$;

create function public.admin_grant_essential_alert(p_publisher uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pub public.official_publishers%rowtype; v_id uuid;
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  select * into v_pub from public.official_publishers where id = p_publisher;
  if not found then raise exception 'Unknown organisation' using errcode = 'P0002'; end if;
  if v_pub.verified_at is null or not v_pub.is_active then raise exception 'Only a verified, active organisation can hold the Essential Alert entitlement' using errcode = '22023'; end if;
  if not exists (select 1 from public.official_publisher_members where publisher_id = p_publisher and role = 'publisher' and is_active) then
    raise exception 'Add at least one authorised publisher before granting the entitlement' using errcode = '22023';
  end if;
  insert into public.essential_alert_grants (publisher_id, granted_by, reason) values (p_publisher, auth.uid(), btrim(p_reason)) returning id into v_id;   -- unique index: one active grant
  perform public.notice_audit('essential_granted', p_publisher, null, null, jsonb_build_object('grant', v_id, 'reason', btrim(p_reason)));
  return v_id;
end $$;

create function public.admin_list_official_publishers()
returns table (id uuid, slug text, name text, kind text, website_url text, verified_at timestamptz, is_active boolean, import_source text,
               members integer, has_essential_grant boolean, granted_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query
    select p.id, p.slug, p.name, p.kind, p.website_url, p.verified_at, p.is_active, p.import_source,
           (select count(*)::int from public.official_publisher_members m where m.publisher_id = p.id and m.is_active),
           exists (select 1 from public.essential_alert_grants g where g.publisher_id = p.id and g.revoked_at is null),
           (select g.granted_at from public.essential_alert_grants g where g.publisher_id = p.id and g.revoked_at is null)
      from public.official_publishers p order by p.name;
end $$;

create function public.admin_list_official_publisher_members(p_publisher uuid)
returns table (user_id uuid, display_name text, role text, is_active boolean, added_at timestamptz, removed_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select m.user_id, pr.display_name, m.role, m.is_active, m.added_at, m.removed_at
                 from public.official_publisher_members m left join public.profiles pr on pr.id = m.user_id
                where m.publisher_id = p_publisher order by m.is_active desc, m.added_at;
end $$;

create function public.admin_notice_audit(p_limit integer default 100, p_before timestamptz default null)
returns setof public.notice_audit_log language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select * from public.notice_audit_log where p_before is null or at < p_before order by at desc, id desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ── what the signed-in user may publish as (drives the publisher UI; carries no secret) ─────────────────────────────────────────────────────────
create function public.my_official_publishers()
returns table (publisher_id uuid, slug text, name text, kind text, role text, can_publish boolean, can_essential boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.slug, p.name, p.kind, m.role,
         (p.verified_at is not null and p.is_active) as can_publish,
         (p.verified_at is not null and p.is_active and m.role = 'publisher'
          and exists (select 1 from public.essential_alert_grants g where g.publisher_id = p.id and g.revoked_at is null)) as can_essential
    from public.official_publisher_members m join public.official_publishers p on p.id = m.publisher_id
   where m.user_id = auth.uid() and m.is_active and not public.account_is_closed(auth.uid());
$$;

-- ── the single place that answers "may this caller publish as this organisation, and may they mark it essential?" (used by the next migration) ──────
create function public.official_publisher_authority(p_publisher uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when auth.uid() is null or public.account_is_closed(auth.uid()) then 'none'
    when not exists (select 1 from public.official_publishers p where p.id = p_publisher and p.verified_at is not null and p.is_active) then 'none'
    when not exists (select 1 from public.official_publisher_members m where m.publisher_id = p_publisher and m.user_id = auth.uid() and m.is_active) then 'none'
    when (select m.role from public.official_publisher_members m where m.publisher_id = p_publisher and m.user_id = auth.uid() and m.is_active) = 'publisher'
         and exists (select 1 from public.essential_alert_grants g where g.publisher_id = p_publisher and g.revoked_at is null) then 'essential'
    else 'official'
  end;
$$;

revoke all on function public.notices_admin(), public.admin_upsert_official_publisher(text, text, text, text, text), public.admin_verify_official_publisher(uuid, text),
  public.admin_set_official_publisher_active(uuid, boolean), public.admin_set_official_publisher_member(uuid, uuid, text, boolean),
  public.admin_grant_essential_alert(uuid, text), public.admin_list_official_publishers(),
  public.admin_list_official_publisher_members(uuid), public.admin_notice_audit(integer, timestamptz), public.my_official_publishers(),
  public.official_publisher_authority(uuid) from public, anon;
grant execute on function public.notices_admin(), public.admin_upsert_official_publisher(text, text, text, text, text), public.admin_verify_official_publisher(uuid, text),
  public.admin_set_official_publisher_active(uuid, boolean), public.admin_set_official_publisher_member(uuid, uuid, text, boolean),
  public.admin_grant_essential_alert(uuid, text), public.admin_list_official_publishers(),
  public.admin_list_official_publisher_members(uuid), public.admin_notice_audit(integer, timestamptz), public.my_official_publishers(),
  public.official_publisher_authority(uuid) to authenticated, service_role;

commit;

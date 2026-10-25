-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner PROFILE VERSIONS — the audit trail for promoting a prepared profile
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE PRODUCT MODEL. A launch partner has three different things, and this migration keeps them apart:
--
--   1. the CURRENT PUBLIC LISTING        — untouched. Nothing here reads or writes local_businesses.
--   2. the PREPARED page                 — launch_partner_campaigns.page_config: private, rich, may hold example commerce.
--   3. the future APPROVED LIVE page     — not built yet.
--
-- Only the PROFILE / PRESENTATION layer of the prepared page may be promoted: prepared -> owner-edited -> approved ->
-- (later) published. COMMERCE content (example products, example experience, booking illustration, suggested rewards,
-- internal notes) is NEVER promoted. The database enforces that by a whitelist, not by good manners:
--
--   top-level keys   hero, story, useful, emphasis, layout
--   inside hero      headline, tagline, eyebrow, locality, image, treatment, gallery
--
-- public._launch_partner_profile_extract(jsonb) returns ONLY those keys and DROPS everything else (products,
-- productsTitle, experience, booking, rewards, notes and any unknown key). An owner who SUBMITS any other key is
-- refused with 22023 naming it. The table itself also carries a CHECK on the same whitelist (defence in depth).
--
-- WHAT THIS MIGRATION DOES
--   · launch_partner_page_versions — an APPEND-ONLY table of profile snapshots. A trigger refuses UPDATE, DELETE and
--     TRUNCATE for everyone, the table owner included; no client role has any privilege on it.
--   · launch_partner_campaigns gains approved_version_id / approved_at / approved_by (set only by the owner's approve
--     function) and published_version_id (RESERVED, never set here). admin_launch_partner_update's whitelist is
--     unchanged and cannot reach any of them.
--   · RPCs (all SECURITY DEFINER, search_path public, pg_temp, anon cannot execute):
--       admin_launch_partner_record_prepared(p_id, p_note)                -> uuid         admin only
--       launch_partner_owner_save_profile(p_business_id, p_profile, p_note) -> uuid       the OWNER only (not admins)
--       launch_partner_owner_approve(p_business_id, p_version_id)         -> jsonb        the OWNER only (not admins)
--       launch_partner_profile_versions(p_business_id)                    -> jsonb array  admin OR owner, no bodies
--       launch_partner_version_profile(p_business_id, p_version_id)       -> jsonb        admin OR owner
--       launch_partner_approved_profile(p_business_id)                    -> jsonb        admin OR owner
--     and admin_launch_partner_get is extended (every existing field kept) with approved_version_id, approved_at,
--     approved_by, published_version_id and `versions`. admin_launch_partner_list is NOT changed.
--
-- WHO IS "THE OWNER". The same predicate as launch_partner_page_draft's owner branch: the caller is local_businesses
-- .owner_id AND holds an APPROVED business_claims row with source 'launch_partner_invitation' for that business. It
-- is written once more here as _launch_partner_is_owner (page_draft is not edited; a test proves the two agree for
-- every user in the access matrix). Readers return NULL to anyone else, never an error, so nobody can tell whether a
-- profile exists. The two owner WRITE functions raise 42501 with one generic message for every refusal.
--
-- WHAT IS NOT DONE HERE, AND MUST NOT BE
--   · Nothing publishes anything. Nothing here touches local_businesses, products, launch_invites, business_claims or
--     launch_plan_grants. live_at, setup_ready_at and published_version_id are never set.
--   · No email, no network call: there is no pg_net / http call anywhere in this file.
--   · The kind 'published' is RESERVED for the future Go-live step; nothing in this migration inserts it.
--
-- DESIGN CONTRACT ONLY — NOT IMPLEMENTED:
--   launch_partner_owner_go_live(p_business_id uuid, p_version_id uuid, ...)
--     The single, explicit, reversible OWNER action that would copy an APPROVED profile into the public presentation,
--     insert a 'published' version (parent = the approved version), set launch_partner_campaigns.published_version_id
--     and live_at. It needs a public-page switch that does not exist yet, so it is deliberately absent. When it is
--     written it must use the same owner predicate, refuse anything that is not an 'approved' version, and keep the
--     reversal (un-publish) as its own audited row rather than an edit.
--
-- WHAT THE AUDIT TRAIL ANSWERS
--   what Darren prepared                 'prepared' rows (actor_role 'admin', parent null)
--   what the owner changed               'owner_edit' rows, each with parent_id = the version it started from
--   what the owner approved, and when    'approved' rows (parent = the version approved) + approved_at / approved_by
--   what was eventually published        published_version_id (reserved; empty until Go-live exists)
-- Events (launch_partner_events) carry version ids only, never profile text, notes or emails.

begin;

-- ── 1. The whitelist, stated once ──────────────────────────────────────────
create or replace function public._launch_partner_profile_keys()
  returns text[] language sql immutable set search_path = public, pg_temp
as $$ select array['hero', 'story', 'useful', 'emphasis', 'layout']::text[] $$;

create or replace function public._launch_partner_hero_keys()
  returns text[] language sql immutable set search_path = public, pg_temp
as $$ select array['headline', 'tagline', 'eyebrow', 'locality', 'image', 'treatment', 'gallery']::text[] $$;

revoke all on function public._launch_partner_profile_keys(), public._launch_partner_hero_keys()
  from public, anon, authenticated;

-- Returns ONLY the profile layer. Everything else (commerce, notes, unknown keys, unknown hero keys) is dropped.
-- A hero that is not an object is dropped whole.
create or replace function public._launch_partner_profile_extract(p_page jsonb)
  returns jsonb
  language sql
  immutable
  set search_path = public, pg_temp
as $$
  select case
    when p_page is null or jsonb_typeof(p_page) <> 'object' then '{}'::jsonb
    else coalesce((
      select jsonb_object_agg(
               e.key,
               case when e.key = 'hero'
                    then (select coalesce(jsonb_object_agg(h.key, h.value), '{}'::jsonb)
                            from jsonb_each(e.value) h
                           where h.key = any (public._launch_partner_hero_keys()))
                    else e.value end)
        from jsonb_each(p_page) e
       where e.key = any (public._launch_partner_profile_keys())
         and (e.key <> 'hero' or jsonb_typeof(e.value) = 'object')
    ), '{}'::jsonb)
  end
$$;
revoke all on function public._launch_partner_profile_extract(jsonb) from public, anon, authenticated;

-- ── 2. The append-only version table ───────────────────────────────────────
-- Lets a version row carry the campaign's business and be FORCED to agree with it (composite foreign key below).
create unique index if not exists launch_partner_campaigns_id_business_uidx
  on public.launch_partner_campaigns (id, business_id);

create table if not exists public.launch_partner_page_versions (
  id          uuid primary key default gen_random_uuid(),
  -- A strictly increasing tie-break, so "latest" is well defined even inside one transaction.
  seq         bigint generated always as identity,
  campaign_id uuid not null,
  -- Denormalised for readers; the composite foreign key below makes it impossible to disagree with the campaign.
  business_id uuid not null,
  -- 'published' is RESERVED for the future Go-live step; nothing in this migration inserts it.
  kind        text not null check (kind in ('prepared', 'owner_edit', 'approved', 'published')),
  profile     jsonb not null
              check (jsonb_typeof(profile) = 'object'
                     and profile - public._launch_partner_profile_keys() = '{}'::jsonb
                     and (not (profile ? 'hero')
                          or (jsonb_typeof(profile -> 'hero') = 'object'
                              and (profile -> 'hero') - public._launch_partner_hero_keys() = '{}'::jsonb))
                     and octet_length(profile::text) <= 262144),
  parent_id   uuid references public.launch_partner_page_versions(id),
  actor       uuid,
  actor_role  text check (actor_role in ('admin', 'owner', 'system')),
  note        text check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  foreign key (campaign_id, business_id)
    references public.launch_partner_campaigns (id, business_id) on delete restrict
);

comment on table public.launch_partner_page_versions is
  'Append-only audit trail of launch-partner PROFILE snapshots (prepared / owner_edit / approved / published). Profile layer only: commerce is never stored here. Immutable by trigger; RLS on, no policy, no client grant.';
comment on column public.launch_partner_page_versions.kind is
  'prepared = recorded from page_config by an admin; owner_edit = saved by the owner; approved = the owner approved a snapshot; published = RESERVED for the future Go-live step, never inserted by this migration.';

create index if not exists launch_partner_page_versions_campaign_idx
  on public.launch_partner_page_versions (campaign_id, created_at desc);

alter table public.launch_partner_page_versions enable row level security;
revoke all on public.launch_partner_page_versions from public, anon, authenticated;
revoke all on public.launch_partner_page_versions from service_role;
grant select, insert on public.launch_partner_page_versions to service_role;
-- No policy, deliberately: read and written only through the functions below.

create or replace function public._launch_partner_versions_immutable()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  raise exception 'launch_partner_page_versions is append-only: % is not allowed', tg_op using errcode = '55000';
end;
$$;
revoke all on function public._launch_partner_versions_immutable() from public, anon, authenticated;

drop trigger if exists launch_partner_page_versions_no_change on public.launch_partner_page_versions;
create trigger launch_partner_page_versions_no_change
  before update or delete on public.launch_partner_page_versions
  for each row execute function public._launch_partner_versions_immutable();

drop trigger if exists launch_partner_page_versions_no_truncate on public.launch_partner_page_versions;
create trigger launch_partner_page_versions_no_truncate
  before truncate on public.launch_partner_page_versions
  for each statement execute function public._launch_partner_versions_immutable();

-- ── 3. Campaign columns ─────────────────────────────────────────────────────
alter table public.launch_partner_campaigns
  add column if not exists approved_version_id  uuid references public.launch_partner_page_versions(id),
  add column if not exists approved_at          timestamptz,
  add column if not exists approved_by          uuid,
  -- RESERVED for the future Go-live step. Nothing in this migration sets it.
  add column if not exists published_version_id uuid references public.launch_partner_page_versions(id);

comment on column public.launch_partner_campaigns.approved_version_id is
  'The CURRENT owner-approved profile version (an approved row). Set only by launch_partner_owner_approve.';
comment on column public.launch_partner_campaigns.published_version_id is
  'RESERVED for the future owner "Go live" step. Nothing in the profile-versions migration sets it.';

-- ── 4. Internal helpers ─────────────────────────────────────────────────────
-- The owner predicate: identical in effect to the owner branch of launch_partner_page_draft.
create or replace function public._launch_partner_is_owner(p_business_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and p_business_id is not null
     and exists (select 1 from public.local_businesses b where b.id = p_business_id and b.owner_id = auth.uid())
     and exists (select 1 from public.business_claims cl
                  where cl.business_id = p_business_id and cl.user_id = auth.uid()
                    and cl.source = 'launch_partner_invitation' and cl.status = 'approved');
$$;

-- Admin (launch_plan_authorised) OR owner: who may READ.
create or replace function public._launch_partner_can_read(p_business_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.launch_plan_authorised() is not null or public._launch_partner_is_owner(p_business_id);
$$;

-- The version list, newest first, WITHOUT profile bodies.
create or replace function public._launch_partner_versions_list(p_campaign_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'kind', v.kind, 'created_at', v.created_at, 'actor_role', v.actor_role,
           'parent_id', v.parent_id, 'note', v.note,
           'is_approved_current', v.id is not distinct from c.approved_version_id)
         order by v.seq desc), '[]'::jsonb)
    from public.launch_partner_page_versions v
    join public.launch_partner_campaigns c on c.id = v.campaign_id
   where v.campaign_id = p_campaign_id;
$$;

revoke all on function
  public._launch_partner_is_owner(uuid),
  public._launch_partner_can_read(uuid),
  public._launch_partner_versions_list(uuid)
  from public, anon, authenticated;

-- ── 5. Admin: record what was prepared ──────────────────────────────────────
create or replace function public.admin_launch_partner_record_prepared(p_id uuid, p_note text default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via     text := public.launch_plan_authorised();
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  c         public.launch_partner_campaigns;
  v_profile jsonb;
  v_last    public.launch_partner_page_versions;
  v_id      uuid;
begin
  if v_via is null then
    raise exception 'Only an administrator can record the prepared profile' using errcode = '42501';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'The note is limited to 500 characters' using errcode = '22023';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  v_profile := public._launch_partner_profile_extract(c.page_config);
  if not (v_profile ? 'hero') then
    raise exception 'The prepared page has no hero to record' using errcode = '22023';
  end if;

  select * into v_last from public.launch_partner_page_versions
   where campaign_id = c.id and kind = 'prepared' order by seq desc limit 1;
  if found and v_last.profile = v_profile then
    return v_last.id;                                  -- identical to what was recorded last: write nothing
  end if;

  insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, parent_id, actor, actor_role, note)
  values (c.id, c.business_id, 'prepared', v_profile, null, auth.uid(), 'admin', v_note)
  returning id into v_id;
  perform public._launch_partner_event(c.id, 'version_prepared', jsonb_build_object('version_id', v_id), v_via);
  return v_id;
end;
$$;

-- ── 6. Owner: save an edited profile ────────────────────────────────────────
create or replace function public.launch_partner_owner_save_profile(
  p_business_id uuid, p_profile jsonb, p_note text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  c        public.launch_partner_campaigns;
  k        text;
  s        text;
  v_parent uuid;
  v_id     uuid;
begin
  if not public._launch_partner_is_owner(p_business_id) then
    raise exception 'Only the approved owner of this launch-partner business can save its profile' using errcode = '42501';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'The note is limited to 500 characters' using errcode = '22023';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' or p_profile = '{}'::jsonb then
    raise exception 'The profile must be a non-empty JSON object' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_profile) loop
    if k <> all (public._launch_partner_profile_keys()) then
      raise exception 'Field "%" cannot be part of the profile', k using errcode = '22023';
    end if;
  end loop;
  if p_profile ? 'hero' then
    if jsonb_typeof(p_profile -> 'hero') <> 'object' then
      raise exception 'hero must be a JSON object' using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(p_profile -> 'hero') loop
      if k <> all (public._launch_partner_hero_keys()) then
        raise exception 'Field "hero.%" cannot be part of the profile', k using errcode = '22023';
      end if;
    end loop;
  end if;
  if octet_length(p_profile::text) > 262144 then
    raise exception 'The profile is too large (limit 256 KB)' using errcode = '22023';
  end if;
  -- Bound every piece of text, wherever it sits in the profile.
  for s in select (x #>> '{}') from jsonb_path_query(p_profile, 'strict $.**') x where jsonb_typeof(x) = 'string' loop
    if char_length(s) > 20000 then
      raise exception 'A text in the profile is too long (limit 20000 characters)' using errcode = '22023';
    end if;
  end loop;

  select * into c from public.launch_partner_campaigns where business_id = p_business_id for update;
  if not found then
    raise exception 'Only the approved owner of this launch-partner business can save its profile' using errcode = '42501';
  end if;

  select v.id into v_parent from public.launch_partner_page_versions v
   where v.campaign_id = c.id order by v.seq desc limit 1;

  insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, parent_id, actor, actor_role, note)
  values (c.id, c.business_id, 'owner_edit', p_profile, v_parent, auth.uid(), 'owner', v_note)
  returning id into v_id;
  perform public._launch_partner_event(c.id, 'version_owner_edit',
    jsonb_build_object('version_id', v_id, 'parent_id', v_parent), 'owner');
  return v_id;
end;
$$;

-- ── 7. Owner: approve a version ─────────────────────────────────────────────
create or replace function public.launch_partner_owner_approve(p_business_id uuid, p_version_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  c    public.launch_partner_campaigns;
  v    public.launch_partner_page_versions;
  v_id uuid;
  v_at timestamptz := now();
begin
  if not public._launch_partner_is_owner(p_business_id) then
    raise exception 'Only the approved owner of this launch-partner business can approve its profile' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where business_id = p_business_id for update;
  if not found then
    raise exception 'Only the approved owner of this launch-partner business can approve its profile' using errcode = '42501';
  end if;

  select * into v from public.launch_partner_page_versions x
   where x.id = p_version_id and x.campaign_id = c.id;
  if not found then
    raise exception 'No such version for this business' using errcode = 'P0002';
  end if;
  if v.kind not in ('prepared', 'owner_edit') then
    raise exception 'Only a prepared or an edited version can be approved' using errcode = '22023';
  end if;

  insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, parent_id, actor, actor_role)
  values (c.id, c.business_id, 'approved', v.profile, v.id, auth.uid(), 'owner')
  returning id into v_id;

  -- Only these three columns. live_at, setup_ready_at and published_version_id are never touched here.
  update public.launch_partner_campaigns
     set approved_version_id = v_id, approved_at = v_at, approved_by = auth.uid()
   where id = c.id;

  perform public._launch_partner_event(c.id, 'profile_approved',
    jsonb_build_object('version_id', v_id, 'source_version_id', v.id), 'owner');
  return jsonb_build_object('approved_version_id', v_id, 'approved_at', v_at);
end;
$$;

-- ── 8. Readers: admin OR owner, otherwise NULL ──────────────────────────────
create or replace function public.launch_partner_profile_versions(p_business_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare c_id uuid;
begin
  if p_business_id is null or not public._launch_partner_can_read(p_business_id) then return null; end if;
  select id into c_id from public.launch_partner_campaigns where business_id = p_business_id;
  if c_id is null then return null; end if;
  return public._launch_partner_versions_list(c_id);
end;
$$;

create or replace function public.launch_partner_version_profile(p_business_id uuid, p_version_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare v_profile jsonb;
begin
  if p_business_id is null or p_version_id is null or not public._launch_partner_can_read(p_business_id) then return null; end if;
  select v.profile into v_profile
    from public.launch_partner_page_versions v
    join public.launch_partner_campaigns c on c.id = v.campaign_id
   where v.id = p_version_id and c.business_id = p_business_id;
  return v_profile;
end;
$$;

create or replace function public.launch_partner_approved_profile(p_business_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if p_business_id is null or not public._launch_partner_can_read(p_business_id) then return null; end if;
  select jsonb_build_object('version_id', v.id, 'approved_at', c.approved_at, 'profile', v.profile) into v_out
    from public.launch_partner_campaigns c
    join public.launch_partner_page_versions v on v.id = c.approved_version_id
   where c.business_id = p_business_id;
  return v_out;
end;
$$;

-- ── 9. admin_launch_partner_get: every existing field, plus the approval state and the version list ──
create or replace function public.admin_launch_partner_get(p_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  c        public.launch_partner_campaigns;
  v_events jsonb;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read a launch-partner record' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'detail', e.detail,
                                               'actor', e.actor, 'actor_label', e.actor_label,
                                               'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    into v_events
    from (select * from public.launch_partner_events where campaign_id = p_id
           order by created_at desc, id limit 50) e;
  return public._launch_partner_summary(p_id) || jsonb_build_object(
    'preview_config', c.preview_config, 'page_config', c.page_config,
    'contact_email', c.contact_email, 'email_subject', c.email_subject, 'email_body', c.email_body,
    'notes', c.notes, 'events', v_events,
    'approved_version_id', c.approved_version_id, 'approved_at', c.approved_at, 'approved_by', c.approved_by,
    'published_version_id', c.published_version_id,
    'versions', public._launch_partner_versions_list(c.id));
end;
$$;

-- ── 10. Who may call what ───────────────────────────────────────────────────
revoke all on function
  public.admin_launch_partner_record_prepared(uuid, text),
  public.launch_partner_owner_save_profile(uuid, jsonb, text),
  public.launch_partner_owner_approve(uuid, uuid),
  public.launch_partner_profile_versions(uuid),
  public.launch_partner_version_profile(uuid, uuid),
  public.launch_partner_approved_profile(uuid),
  public.admin_launch_partner_get(uuid)
  from public, anon, authenticated;

grant execute on function
  public.admin_launch_partner_record_prepared(uuid, text),
  public.launch_partner_owner_save_profile(uuid, jsonb, text),
  public.launch_partner_owner_approve(uuid, uuid),
  public.launch_partner_profile_versions(uuid),
  public.launch_partner_version_profile(uuid, uuid),
  public.launch_partner_approved_profile(uuid),
  public.admin_launch_partner_get(uuid)
  to authenticated, service_role;

commit;

-- Notices Stage 2 - structural readiness for four publishers (person, hub, business, platform/official source).
--
-- ADDITIVE and backwards-compatible: no column renamed or removed; every new column has a safe default; an old client that sends none of them behaves
-- exactly as before (a hub/business notice is "published", public rules unchanged). The one live notice keeps every original value.
--
--  SOURCE      source, source_reference, source_url, source_label, source_published_at, source_verified_at + UNIQUE (source, source_reference).
--              Only platform notices may carry a source (CHECK) and only staff or the service role may set it (guard trigger), so no ordinary user can
--              spoof "Source: NHS Shetland". Imported notices MUST expire (CHECK).
--  LIFECYCLE   status pending | published | resolved | withdrawn, starts_at, resolved_at, withdrawn_at, updated_at (+ trigger that stamps them).
--              "Resolved" is not "expired": the notice and its source are kept.
--  PUBLISHER   is_person_notice marks a notice published by a signed-in PERSON (author = publisher_user_id, server-stamped = auth.uid()). It is a marker,
--              not an id, so deleting the account (publisher_user_id -> NULL) leaves a valid row. Hub/business ownership is untouched
--              (controls_event_entity), and the 8 Oct attribution guard is extended, not loosened.
--  MODERATION  person notices start PENDING (never self-published); edits to a published person notice return it to pending; max 5 pending per person;
--              person notices can never be urgent. Hub/business behaviour is unchanged (instant). Staff and the service role publish directly.
--  READ RULE   public: published AND not hidden AND started AND unexpired AND visibility rules (as before). Authors see their own person notices in every state;
--              a hub/business sees its own NON-published notices (pending/resolved/withdrawn). Staff see all. Resolved notices are not shown publicly yet
--              (old clients cannot label them) - a later stage can widen the rule.
--  CATEGORIES  nine canonical ids in notice_categories (FK). Severity stays priority.
--  GEOGRAPHY   notice_areas(notice_id, area_id -> public.areas). A shetland_wide row means Shetland-wide; NO rows means unspecified. Old free-text
--              locality/lat/lng are untouched.
--  (A person's display name is disclosed only for someone with an approved public notice, to themselves, or to staff.)
--  DISPLAY     notice_publisher_display(notice) -> {kind, label, is_official_source, source_label, source_url}: hub name | business name | person name |
--              "OneShetland" (platform) | source label (official import) - never "Member".
--  NOTIFICATIONS none: nothing here sends or schedules a push.
begin;

-- ── Categories ────────────────────────────────────────────────────────────────
create table public.notice_categories (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  description text,
  sort_order  integer not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
insert into public.notice_categories (id, label, description, sort_order) values
  ('travel_transport',     'Travel & transport',         'Ferries, roads, buses, flights, disruption and closures affecting travel', 10),
  ('health',               'Health',                     'Health service notices and public health information', 20),
  ('public_services',      'Council & public services',  'Bins, recycling, service changes and closures from public bodies', 30),
  ('schools_education',    'Schools & education',        'School and education notices', 40),
  ('community',            'Community',                  'Community news and information, clubs and groups', 50),
  ('consultations_funding','Consultations & funding',    'Public consultations, grants and funding deadlines', 60),
  ('lost_found',           'Lost & found',               'Lost and found items and animals', 70),
  ('appeals_volunteering', 'Appeals & volunteering',     'Charity appeals and volunteering requests', 80),
  ('other',                'Other',                      'Anything that does not fit another category', 90);

-- ── Columns ───────────────────────────────────────────────────────────────────
alter table public.notices
  add column source              text,
  add column source_reference    text,
  add column source_url          text,
  add column source_label        text,
  add column source_published_at timestamptz,
  add column source_verified_at  timestamptz,
  add column status              text not null default 'published',
  add column starts_at           timestamptz,
  add column resolved_at         timestamptz,
  add column withdrawn_at        timestamptz,
  add column is_person_notice    boolean not null default false,
  add column updated_at          timestamptz;
update public.notices set updated_at = created_at;           -- the live notice keeps a sensible value; no trigger exists yet
alter table public.notices alter column updated_at set default now(), alter column updated_at set not null;
alter table public.notices
  add column publisher_kind text generated always as (
    case when is_platform_notice then 'platform' when is_person_notice then 'person' when publisher_hub_id is not null then 'hub' else 'business' end) stored;

alter table public.notices add constraint notices_status_check check (status in ('pending', 'published', 'resolved', 'withdrawn'));
alter table public.notices drop constraint notices_attribution_exclusive;
alter table public.notices add constraint notices_attribution_exclusive check (
  (is_platform_notice and not is_person_notice and publisher_hub_id is null and publisher_business_id is null)
  or (is_person_notice and not is_platform_notice and publisher_hub_id is null and publisher_business_id is null)
  or (not is_platform_notice and not is_person_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1));
alter table public.notices add constraint notices_source_platform_only check (
  source is null or (is_platform_notice and btrim(source) <> '' and source_reference is not null and btrim(source_reference) <> '' and source_label is not null and btrim(source_label) <> ''));
alter table public.notices add constraint notices_source_fields_need_source check (
  source is not null or (source_reference is null and source_url is null and source_label is null and source_published_at is null and source_verified_at is null));
alter table public.notices add constraint notices_import_expires check (source is null or expires_at is not null);
alter table public.notices add constraint notices_window_check check (starts_at is null or expires_at is null or expires_at > starts_at);
alter table public.notices add constraint notices_category_fk foreign key (category) references public.notice_categories(id);

create unique index notices_source_uq on public.notices (source, source_reference) where source is not null and source_reference is not null;
create index notices_public_idx on public.notices (published_at desc) where status = 'published' and not is_hidden;
create index notices_person_idx on public.notices (publisher_user_id) where is_person_notice;
create index notices_expires_idx on public.notices (expires_at) where expires_at is not null;

-- ── Notice areas (canonical geography) ────────────────────────────────────────
create table public.notice_areas (
  notice_id  uuid not null references public.notices(id) on delete cascade,
  area_id    text not null references public.areas(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (notice_id, area_id)
);
create index notice_areas_area_idx on public.notice_areas (area_id);

create function public.tg_notice_areas_validate() returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $f$
declare a public.areas%rowtype;
begin
  select * into a from public.areas where id = new.area_id;
  if not found or not a.is_active then
    raise exception 'Area % is not an active canonical area', new.area_id using errcode = '23514';
  end if;
  if new.area_id = 'shetland_wide' then
    if exists (select 1 from public.notice_areas where notice_id = new.notice_id and area_id <> 'shetland_wide') then
      raise exception 'A Shetland-wide notice cannot also list specific areas' using errcode = '23514';
    end if;
  elsif exists (select 1 from public.notice_areas where notice_id = new.notice_id and area_id = 'shetland_wide') then
    raise exception 'A notice already marked Shetland-wide cannot also list specific areas' using errcode = '23514';
  end if;
  if (select count(*) from public.notice_areas where notice_id = new.notice_id and area_id <> new.area_id) >= 12 then
    raise exception 'A notice may list at most 12 areas' using errcode = '54000';
  end if;
  return new;
end;
$f$;
create trigger notice_areas_validate before insert or update on public.notice_areas for each row execute function public.tg_notice_areas_validate();

-- Who may edit a notice (and so its areas): staff, a person-author, or whoever controls the hub/business. Reuses the one ownership rule.
create function public.can_edit_notice(p_notice uuid) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select public.attribution_staff() or exists (
    select 1 from public.notices n
     where n.id = p_notice and not n.is_platform_notice
       and ((n.is_person_notice and n.publisher_user_id = auth.uid())
            or (not n.is_person_notice and public.controls_event_entity(n.publisher_business_id, n.publisher_hub_id))));
$f$;

-- ── Guard + lifecycle triggers ────────────────────────────────────────────────
create or replace function public.tg_notices_attribution_guard()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $function$
declare v_ok boolean; v_pending integer;
begin
  -- Service role, SECURITY DEFINER paths, migrations: unchanged (the trusted importer lives here).
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if public.attribution_staff() then return new; end if;

  if tg_op = 'INSERT' then
    if new.is_platform_notice then
      raise exception 'Only OneShetland staff can publish platform notices' using errcode = '42501';
    end if;
    if new.source is not null or new.source_reference is not null or new.source_url is not null or new.source_label is not null
       or new.source_published_at is not null or new.source_verified_at is not null then
      raise exception 'Official source fields are set by OneShetland staff or the importer only' using errcode = '42501';
    end if;
    if new.is_person_notice then
      if auth.uid() is null then raise exception 'Sign in to post a notice' using errcode = '42501'; end if;
      if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 0 then
        raise exception 'A personal notice cannot name a hub or business' using errcode = '42501';
      end if;
      if new.severity = 'urgent' then
        raise exception 'Only staff or an approved business can post urgent notices' using errcode = '42501';
      end if;
      if new.visibility <> 'public' or new.event_id is not null or new.campaign_id is not null then
        raise exception 'A personal notice is public and cannot link to a hub event or campaign' using errcode = '42501';
      end if;
      select count(*) into v_pending from public.notices where is_person_notice and publisher_user_id = auth.uid() and status = 'pending';
      if v_pending >= 5 then
        raise exception 'You already have 5 notices awaiting review' using errcode = '54000';
      end if;
      new.status := 'pending';                                   -- never self-published
    else
      if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 1 then
        raise exception 'A notice must belong to exactly one business or hub' using errcode = '42501';
      end if;
      if not public.controls_event_entity(new.publisher_business_id, new.publisher_hub_id) then
        raise exception 'You do not manage that business or hub' using errcode = '42501';
      end if;
      new.status := 'published';                                 -- existing behaviour: hub/business notices are immediate
    end if;
    if new.is_pinned or new.is_hidden or new.broadcast_at is not null or new.broadcast_by is not null then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.resolved_at := null; new.withdrawn_at := null;
    new.publisher_user_id := auth.uid();
  else
    if new.publisher_business_id is distinct from old.publisher_business_id
       or new.publisher_hub_id is distinct from old.publisher_hub_id
       or new.is_platform_notice is distinct from old.is_platform_notice
       or new.is_person_notice is distinct from old.is_person_notice then
      raise exception 'A notice''s publisher cannot be changed' using errcode = '42501';
    end if;
    if old.is_platform_notice then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    elsif old.is_person_notice then
      if old.publisher_user_id is distinct from auth.uid() then raise exception 'You no longer manage this notice' using errcode = '42501'; end if;
    elsif not public.controls_event_entity(old.publisher_business_id, old.publisher_hub_id) then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    end if;
    if new.is_pinned is distinct from old.is_pinned or new.is_hidden is distinct from old.is_hidden
       or new.broadcast_at is distinct from old.broadcast_at or new.broadcast_by is distinct from old.broadcast_by then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    if new.source is distinct from old.source or new.source_reference is distinct from old.source_reference or new.source_url is distinct from old.source_url
       or new.source_label is distinct from old.source_label or new.source_published_at is distinct from old.source_published_at
       or new.source_verified_at is distinct from old.source_verified_at then
      raise exception 'Official source fields are set by OneShetland staff or the importer only' using errcode = '42501';
    end if;
    new.publisher_user_id := old.publisher_user_id;
    new.resolved_at := old.resolved_at; new.withdrawn_at := old.withdrawn_at;       -- server-stamped by tg_notices_lifecycle
    if new.status is distinct from old.status then
      if old.is_person_notice then
        if not (new.status = 'withdrawn' or (new.status = 'resolved' and old.status = 'published')) then
          raise exception 'Only OneShetland staff can approve a personal notice' using errcode = '42501';
        end if;
      elsif new.status = 'pending' then
        raise exception 'Only OneShetland staff can place a notice in review' using errcode = '42501';
      end if;
    end if;
    -- A personal notice that was approved goes back to review if its content is changed.
    if old.is_person_notice and old.status = 'published' and new.status = 'published'
       and (new.title is distinct from old.title or new.body is distinct from old.body or new.image_url is distinct from old.image_url
            or new.category is distinct from old.category) then
      new.status := 'pending';
    end if;
  end if;

  -- A notice may only point at its OWN publisher's event / campaign.
  if new.event_id is not null and (tg_op = 'INSERT' or new.event_id is distinct from old.event_id) then
    v_ok := public.notice_event_belongs(new.event_id, new.publisher_business_id, new.publisher_hub_id);
    if not coalesce(v_ok, false) then
      raise exception 'A notice can only link to its own publisher''s event' using errcode = '42501';
    end if;
  end if;
  if new.campaign_id is not null and (tg_op = 'INSERT' or new.campaign_id is distinct from old.campaign_id) then
    v_ok := public.notice_campaign_belongs(new.campaign_id, new.publisher_hub_id);
    if not coalesce(v_ok, false) then
      raise exception 'A notice can only link to its own hub''s campaign' using errcode = '42501';
    end if;
  end if;
  return new;
end $function$;

create function public.tg_notices_lifecycle() returns trigger language plpgsql as $f$
begin
  new.updated_at := now();
  if new.status = 'resolved' and (tg_op = 'INSERT' or old.status is distinct from 'resolved') then new.resolved_at := coalesce(new.resolved_at, now()); end if;
  if new.status = 'withdrawn' and (tg_op = 'INSERT' or old.status is distinct from 'withdrawn') then new.withdrawn_at := coalesce(new.withdrawn_at, now()); end if;
  return new;
end;
$f$;
create trigger notices_lifecycle before insert or update on public.notices for each row execute function public.tg_notices_lifecycle();

-- Read-rule helper. The read policy runs for ANON too, and anon has no EXECUTE on controls_event_entity (found by the isolated suite: a direct call
-- made every signed-out read fail). This wrapper is executable by anon and answers false without a session, so the public read path never depends on it.
create function public.controls_notice_publisher(p_business uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select auth.uid() is not null and public.controls_event_entity(p_business, p_hub);
$f$;
revoke all on function public.controls_notice_publisher(uuid, uuid) from public;
grant execute on function public.controls_notice_publisher(uuid, uuid) to anon, authenticated, service_role;

-- ── Policies ──────────────────────────────────────────────────────────────────
drop policy "notices read"   on public.notices;
drop policy "notices insert" on public.notices;
drop policy "notices update" on public.notices;
drop policy "notices delete" on public.notices;

create policy "notices read" on public.notices for select using (
  ( (not is_hidden) and status = 'published' and (starts_at is null or starts_at <= now()) and (expires_at is null or expires_at > now())
    and ( visibility = 'public'
          or (visibility = 'members'   and public.is_hub_member(publisher_hub_id, auth.uid()))
          or (visibility = 'committee' and public.is_hub_admin(publisher_hub_id, auth.uid())) ) )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['admin', 'moderator']))
  or (is_person_notice and publisher_user_id = auth.uid())
  or ((status <> 'published' or starts_at > now()) and not is_platform_notice and not is_person_notice and public.controls_notice_publisher(publisher_business_id, publisher_hub_id))
);

create policy "notices insert" on public.notices for insert to authenticated with check (
  auth.uid() is not null
  and ( severity <> 'urgent'
        or exists (select 1 from public.local_businesses b where b.id = notices.publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
        or public.attribution_staff() )
  and ( public.attribution_staff()
        or ( not is_platform_notice
             and ( (is_person_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 0 and publisher_user_id = auth.uid())
                   or (not is_person_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
                       and public.controls_event_entity(publisher_business_id, publisher_hub_id)) ) ) )
);

create policy "notices update" on public.notices for update to authenticated
using ( public.attribution_staff()
        or ( not is_platform_notice
             and ( (is_person_notice and publisher_user_id = auth.uid())
                   or (not is_person_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)) ) ) )
with check (
  ( severity <> 'urgent'
    or exists (select 1 from public.local_businesses b where b.id = notices.publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
    or public.attribution_staff() )
  and ( public.attribution_staff()
        or ( not is_platform_notice
             and ( (is_person_notice and publisher_user_id = auth.uid())
                   or (not is_person_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
                       and public.controls_event_entity(publisher_business_id, publisher_hub_id)) ) ) )
);

create policy "notices delete" on public.notices for delete to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  or ( not is_platform_notice
       and ( (is_person_notice and publisher_user_id = auth.uid())
             or (not is_person_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)) ) )
);

-- notice_areas / notice_categories access
alter table public.notice_areas      enable row level security;
alter table public.notice_categories enable row level security;
revoke all on public.notice_areas, public.notice_categories from public, anon, authenticated;
grant select on public.notice_areas, public.notice_categories to anon, authenticated;
grant insert, update, delete on public.notice_areas, public.notice_categories to authenticated;
grant all on public.notice_areas, public.notice_categories to service_role;
create policy "notice areas read"  on public.notice_areas for select to anon, authenticated using (exists (select 1 from public.notices n where n.id = notice_id));
create policy "notice areas write" on public.notice_areas for all    to authenticated using (public.can_edit_notice(notice_id)) with check (public.can_edit_notice(notice_id));
create policy "notice categories read"  on public.notice_categories for select to anon, authenticated using (is_active or public.is_admin());
create policy "notice categories admin" on public.notice_categories for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── Publisher / source display (never "Member") ───────────────────────────────
create function public.notice_person_label(p_user uuid) returns text
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select case
    when p_user is null then 'Former member'
    when p_user = auth.uid() or public.attribution_staff()
         or exists (select 1 from public.notices n where n.is_person_notice and n.publisher_user_id = p_user and n.status = 'published')
      then coalesce(nullif(btrim((select display_name from public.profiles where id = p_user)), ''), 'A OneShetland member')
    else 'A OneShetland member' end;
$f$;

create function public.notice_publisher_display(p_notice uuid) returns jsonb
language sql stable security invoker set search_path to 'public', 'pg_temp' as $f$
  select case
    when n.is_platform_notice and n.source is not null then
      jsonb_build_object('kind', 'platform', 'label', n.source_label, 'is_official_source', true, 'source_label', n.source_label, 'source_url', n.source_url, 'byline', 'Source: ' || n.source_label)
    when n.is_platform_notice then
      jsonb_build_object('kind', 'platform', 'label', 'OneShetland', 'is_official_source', false, 'source_label', null, 'source_url', null, 'byline', 'Posted by OneShetland')
    when n.is_person_notice then
      jsonb_build_object('kind', 'person', 'label', public.notice_person_label(n.publisher_user_id), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || public.notice_person_label(n.publisher_user_id))
    when n.publisher_hub_id is not null then
      jsonb_build_object('kind', 'hub', 'label', coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || coalesce((select name from public.hubs h where h.id = n.publisher_hub_id), 'Community hub'))
    else
      jsonb_build_object('kind', 'business', 'label', coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'), 'is_official_source', false, 'source_label', null, 'source_url', null,
                         'byline', 'Posted by ' || coalesce((select name from public.local_businesses b where b.id = n.publisher_business_id), 'Local business'))
  end
  from public.notices n where n.id = p_notice;
$f$;

revoke all on function public.can_edit_notice(uuid), public.notice_person_label(uuid), public.notice_publisher_display(uuid) from public;
grant execute on function public.can_edit_notice(uuid), public.notice_publisher_display(uuid) to anon, authenticated, service_role;
grant execute on function public.notice_person_label(uuid) to anon, authenticated, service_role;

commit;

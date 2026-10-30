-- ROLLBACK of 20261128000000_notices_structural_readiness.sql.
-- Restores the pre-Stage-2 notices model (the 8 Oct attribution guard, policies and constraint, copied from 20261121000000 / production) and drops
-- everything Stage 2 added. DESTRUCTIVE for any person notice, source field, status, start time or notice_areas row written since: take a copy first.
-- Refuses to run while person notices or non-published notices exist, so a hidden/pending row cannot silently become public.
begin;
do $$ begin
  if exists (select 1 from public.notices where is_person_notice or status <> 'published') then
    raise exception 'rollback refused: person or non-published notices exist; resolve or export them first';
  end if;
end $$;

drop policy "notices read"   on public.notices;
drop policy "notices insert" on public.notices;
drop policy "notices update" on public.notices;
drop policy "notices delete" on public.notices;
drop trigger notices_lifecycle on public.notices;
drop trigger aa_notices_attribution_guard on public.notices;
drop table public.notice_areas;
alter table public.notices drop constraint notices_category_fk, drop constraint notices_window_check, drop constraint notices_import_expires,
  drop constraint notices_source_fields_need_source, drop constraint notices_source_platform_only, drop constraint notices_status_check, drop constraint notices_attribution_exclusive;
drop index public.notices_source_uq, public.notices_public_idx, public.notices_person_idx, public.notices_expires_idx;
alter table public.notices drop column publisher_kind, drop column source, drop column source_reference, drop column source_url, drop column source_label,
  drop column source_published_at, drop column source_verified_at, drop column status, drop column starts_at, drop column resolved_at, drop column withdrawn_at,
  drop column is_person_notice, drop column updated_at;
drop table public.notice_categories;
drop function public.notice_publisher_display(uuid), public.notice_person_label(uuid), public.can_edit_notice(uuid), public.controls_notice_publisher(uuid, uuid),
  public.tg_notices_lifecycle(), public.tg_notice_areas_validate();

alter table public.notices add constraint notices_attribution_exclusive check (
  (is_platform_notice and publisher_business_id is null and publisher_hub_id is null)
  or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1)
);

create or replace function public.tg_notices_attribution_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if public.attribution_staff() then return new; end if;

  if tg_op = 'INSERT' then
    if new.is_platform_notice then
      raise exception 'Only OneShetland staff can publish platform notices' using errcode = '42501';
    end if;
    if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 1 then
      raise exception 'A notice must belong to exactly one business or hub' using errcode = '42501';
    end if;
    if not public.controls_event_entity(new.publisher_business_id, new.publisher_hub_id) then
      raise exception 'You do not manage that business or hub' using errcode = '42501';
    end if;
    if new.is_pinned or new.is_hidden or new.broadcast_at is not null or new.broadcast_by is not null then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.publisher_user_id := auth.uid();
  else
    if new.publisher_business_id is distinct from old.publisher_business_id
       or new.publisher_hub_id is distinct from old.publisher_hub_id
       or new.is_platform_notice is distinct from old.is_platform_notice then
      raise exception 'A notice''s publisher cannot be changed' using errcode = '42501';
    end if;
    if old.is_platform_notice or not public.controls_event_entity(old.publisher_business_id, old.publisher_hub_id) then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    end if;
    if new.is_pinned is distinct from old.is_pinned or new.is_hidden is distinct from old.is_hidden
       or new.broadcast_at is distinct from old.broadcast_at or new.broadcast_by is distinct from old.broadcast_by then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.publisher_user_id := old.publisher_user_id;
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
end $$;
create trigger aa_notices_attribution_guard before insert or update on public.notices
  for each row execute function public.tg_notices_attribution_guard();

create policy "notices read" on public.notices for select using (
  ( (not is_hidden) and (expires_at is null or expires_at > now())
    and ( visibility = 'public'
          or (visibility = 'members'   and public.is_hub_member(publisher_hub_id, auth.uid()))
          or (visibility = 'committee' and public.is_hub_admin(publisher_hub_id, auth.uid())) ) )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['admin', 'moderator']))
);
create policy "notices insert" on public.notices for insert to authenticated with check (
  auth.uid() is not null
  and (severity <> 'urgent'
       or exists (select 1 from public.local_businesses b where b.id = publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
       or public.attribution_staff())
  and (public.attribution_staff()
       or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
           and public.controls_event_entity(publisher_business_id, publisher_hub_id)))
);
create policy "notices update" on public.notices for update to authenticated
  using (public.attribution_staff() or (not is_platform_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)))
  with check (
    (severity <> 'urgent'
       or exists (select 1 from public.local_businesses b where b.id = publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
       or public.attribution_staff())
    and (public.attribution_staff()
         or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
             and public.controls_event_entity(publisher_business_id, publisher_hub_id))));
create policy "notices delete" on public.notices for delete to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  or (not is_platform_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)));
commit;

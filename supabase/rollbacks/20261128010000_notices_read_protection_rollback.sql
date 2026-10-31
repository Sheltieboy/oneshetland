-- ROLLBACK of 20261128010000_notices_read_protection.sql: back to the Stage 2 read policy (author / controllers / staff read their non-published rows
-- directly). Re-opens the exposure that migration closes - only do this while no non-published notice exists, or the clients are updated.
-- Refuses to run if any non-published notice exists.
begin;
do $$ begin
  if exists (select 1 from public.notices where status <> 'published' or is_person_notice) then
    raise exception 'rollback refused: non-published or person notices exist; old app builds would show them';
  end if;
end $$;
drop function public.manage_notices(text, uuid, text, integer), public.manage_set_notice_status(uuid, text), public.manage_delete_notice(uuid);

create function public.controls_notice_publisher(p_business uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select auth.uid() is not null and public.controls_event_entity(p_business, p_hub);
$f$;
revoke all on function public.controls_notice_publisher(uuid, uuid) from public;
grant execute on function public.controls_notice_publisher(uuid, uuid) to anon, authenticated, service_role;

drop policy "notices read" on public.notices;
create policy "notices read" on public.notices for select using (
  ( (not is_hidden) and status = 'published' and (starts_at is null or starts_at <= now()) and (expires_at is null or expires_at > now())
    and ( visibility = 'public'
          or (visibility = 'members'   and public.is_hub_member(publisher_hub_id, auth.uid()))
          or (visibility = 'committee' and public.is_hub_admin(publisher_hub_id, auth.uid())) ) )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['admin', 'moderator']))
  or (is_person_notice and publisher_user_id = auth.uid())
  or ((status <> 'published' or starts_at > now()) and not is_platform_notice and not is_person_notice and public.controls_notice_publisher(publisher_business_id, publisher_hub_id))
);

drop policy "notice areas read" on public.notice_areas;
create policy "notice areas read" on public.notice_areas for select to anon, authenticated using (exists (select 1 from public.notices n where n.id = notice_id));

create or replace function public.notice_person_label(p_user uuid) returns text
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select case
    when p_user is null then 'Former member'
    when p_user = auth.uid() or public.attribution_staff()
         or exists (select 1 from public.notices n where n.is_person_notice and n.publisher_user_id = p_user and n.status = 'published')
      then coalesce(nullif(btrim((select display_name from public.profiles where id = p_user)), ''), 'A OneShetland member')
    else 'A OneShetland member' end;
$f$;
-- restore the Stage 2 guard (counts pending notices directly)
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
drop function public.my_pending_person_notice_count();
commit;

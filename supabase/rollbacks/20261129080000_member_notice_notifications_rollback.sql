-- Rollback of 20261129080000_member_notice_notifications. Restores the previous notice_dispatchable / can_dispatch_notice / notice_dispatch_recipients exactly,
-- drops the member-audience functions and removes the 'member' dispatch kind. Existing 'member' dispatch records must be deleted first (the check would fail).
begin;
delete from public.notice_deliveries where kind = 'member';
delete from public.notice_dispatches where kind = 'member';
drop function if exists public.staff_member_notice_preview(uuid), public.staff_published_person_notices(), public.notice_member_reserve(uuid, uuid),
  public.notice_member_push_text(uuid), public.notice_member_audience(uuid), public.notice_push_gate(uuid);

create or replace function public.notice_dispatchable(p_notice uuid, p_kind text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  select * into n from public.notices where id = p_notice;
  if not found then return 'That notice does not exist'; end if;
  if n.source is not null then return 'Official source notices are never announced'; end if;                  -- imports are silent: product rule
  if n.status <> 'published' then return 'That notice is not published'; end if;
  if n.is_hidden then return 'That notice is hidden'; end if;
  if n.starts_at is not null and n.starts_at > now() then return 'That notice has not started yet'; end if;
  if n.expires_at is not null and n.expires_at <= now() then return 'That notice has expired'; end if;
  if p_kind = 'essential' then
    if not public.notice_essential_active(n) then return 'That is not an active Essential Alert'; end if;
  elsif p_kind = 'official' then
    if n.official_publisher_id is null or n.is_essential then return 'Only an organisation''s ordinary official notice goes to the official audience'; end if;
    if n.visibility <> 'public' then return 'That notice is not public'; end if;
  elsif p_kind = 'community' then
    if n.visibility <> 'public' then return 'That notice is not public'; end if;
    if n.is_platform_notice or n.is_person_notice or (n.publisher_hub_id is null and n.publisher_business_id is null) then
      return 'Only hub and business notices go to the community audience';
    end if;
  elsif p_kind = 'hub' then
    if n.publisher_hub_id is null or n.is_platform_notice or n.is_person_notice then return 'That is not a hub notice'; end if;
    if n.visibility not in ('public', 'members') then return 'That notice is not for hub members'; end if;
  else
    return 'Unknown audience';
  end if;
  return null;
end $$;

create or replace function public.can_dispatch_notice(p_user uuid, p_notice uuid, p_kind text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_admin boolean;
begin
  select * into n from public.notices where id = p_notice;
  if not found or p_user is null then return false; end if;
  select exists (select 1 from public.profiles p where p.id = p_user and (p.role = 'admin' or coalesce(p.is_platform_owner, false))) into v_admin;
  if p_kind = 'essential' then
    return n.official_publisher_id is not null and (v_admin or exists (
      select 1 from public.official_publisher_members m join public.official_publishers o on o.id = m.publisher_id
       where m.publisher_id = n.official_publisher_id and m.user_id = p_user and m.is_active and m.role = 'publisher' and o.verified_at is not null and o.is_active
         and exists (select 1 from public.essential_alert_grants g where g.publisher_id = o.id and g.revoked_at is null)));
  elsif p_kind = 'official' then
    return n.official_publisher_id is not null and (v_admin or exists (
      select 1 from public.official_publisher_members m join public.official_publishers o on o.id = m.publisher_id
       where m.publisher_id = n.official_publisher_id and m.user_id = p_user and m.is_active and o.verified_at is not null and o.is_active));
  elsif p_kind in ('community', 'hub') then
    return v_admin
        or (n.publisher_hub_id is not null and public.is_hub_admin(n.publisher_hub_id, p_user))
        or (p_kind = 'community' and n.publisher_business_id is not null and public.is_business_owner(n.publisher_business_id, p_user));
  end if;
  return false;
end $$;

create or replace function public.notice_dispatch_recipients(p_notice uuid, p_kind text, p_limit integer default 1000) returns table (user_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_wide boolean; v_nb text[];
begin
  if public.notice_dispatchable(p_notice, p_kind) is not null then return; end if;           -- the authoritative state, every time
  select * into n from public.notices where id = p_notice;
  select exists (select 1 from public.notice_areas where notice_id = p_notice and area_id = 'shetland_wide') into v_wide;
  select public.area_neighbourhood(coalesce(array_agg(area_id), '{}')) into v_nb from public.notice_areas where notice_id = p_notice and area_id <> 'shetland_wide';
  p_limit := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  if p_kind = 'hub' then
    return query select distinct hm.user_id from public.hub_members hm
                  where hm.hub_id = n.publisher_hub_id and hm.status = 'active' and (hm.paid_until is null or hm.paid_until > now())
                    and (n.visibility = 'public' or hm.role in ('member', 'committee', 'owner', 'admin'))
                    and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'notice' and d.subject_id = p_notice and d.user_id = hm.user_id and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
                  limit p_limit;
    return;
  end if;
  return query
    select distinct p.user_id
      from public.notice_notification_prefs p
     where case p_kind when 'essential' then p.essential_alerts when 'official' then p.official_notices when 'community' then p.community_notices else false end
       and (p_kind <> 'community' or p.community_categories is null or n.category = any(p.community_categories))
       and (v_wide or exists (select 1 from public.member_areas ma where ma.user_id = p.user_id and ma.area_id = any(v_nb)))
       and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'notice' and d.subject_id = p_notice and d.user_id = p.user_id
                        and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
     limit p_limit;
end $$;

alter table public.notice_dispatches drop constraint notice_dispatches_kind_check;
alter table public.notice_dispatches add constraint notice_dispatches_kind_check check (kind in ('essential', 'official', 'community', 'hub', 'funeral'));
commit;

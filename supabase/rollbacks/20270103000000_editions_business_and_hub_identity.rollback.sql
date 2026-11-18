-- Rollback of 20270103000000_editions_business_and_hub_identity. Refuses if any organiser already belongs to a Business (that data would be lost); detach those first.
do $$ declare v_n int := 0; begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'edition_organisers' and column_name = 'business_id') then
    execute 'select count(*) from public.edition_organisers where business_id is not null' into v_n;
    if v_n > 0 then raise exception 'organisers belong to Businesses; remove or re-home them before rolling back' using errcode = '23514'; end if;
  end if;
end $$;
drop trigger if exists edition_sync_hub_name on public.hubs;
drop trigger if exists edition_sync_business_name on public.local_businesses;
drop function if exists public.edition_sync_parent_name();
drop trigger if exists edition_members_no_owner on public.edition_organiser_members;
drop function if exists public.edition_members_no_owner();
alter table public.edition_organisers drop constraint if exists edition_organisers_one_parent;
-- the Studio record returns to standalone if this migration attached it
update public.edition_organisers set hub_id = null where id in (select organiser_id from public.edition_audit_log where action = 'organiser_attached_to_hub' and detail ->> 'reason' like 'standalone organisers are retired%');
drop function if exists public.edition_ensure_organiser(text, uuid);
drop function if exists public.edition_slugify(text);
CREATE OR REPLACE FUNCTION public.edition_org_role(p_org uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select (array_agg(r order by public.edition_role_rank(r) desc))[1]
    from (select m.role as r from public.edition_organiser_members m where m.organiser_id = p_org and m.user_id = auth.uid() and auth.uid() is not null
          union all select public.edition_hub_role(p_org)) x
   where r is not null
$function$;

CREATE OR REPLACE FUNCTION public.edition_org_admin_users(p_org uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.user_id from public.edition_organiser_members m where m.organiser_id = p_org and m.role in ('owner', 'admin')
  union select h.owner_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = p_org and h.is_active
  union select hm.user_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id join public.hub_members hm on hm.hub_id = h.id
         where o.id = p_org and h.is_active and hm.status = 'active' and hm.role in ('owner', 'committee')
$function$;

CREATE OR REPLACE FUNCTION public.edition_org_team(p_org uuid)
 RETURNS TABLE(user_id uuid, role text, full_name text, joined_at timestamp with time zone, via_hub boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select * from (
    select m.user_id, m.role, p.full_name, m.created_at as joined_at, false as via_hub
      from public.edition_organiser_members m left join public.profiles p on p.id = m.user_id
     where m.organiser_id = p_org
    union all
    select u.user_id, u.role, p.full_name, u.joined_at, true
      from (select h.owner_id as user_id, 'owner'::text as role, h.created_at as joined_at
              from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = p_org and h.is_active
            union
            select hm.user_id, case hm.role when 'owner' then 'owner' else 'admin' end, hm.joined_at
              from public.edition_organisers o join public.hubs h on h.id = o.hub_id join public.hub_members hm on hm.hub_id = h.id
             where o.id = p_org and h.is_active and hm.status = 'active' and hm.role in ('owner', 'committee')) u
      left join public.profiles p on p.id = u.user_id
     where not exists (select 1 from public.edition_organiser_members m2 where m2.organiser_id = p_org and m2.user_id = u.user_id)
  ) t
  where public.edition_org_can(p_org, 'admin')
  order by public.edition_role_rank(t.role) desc, t.via_hub, t.joined_at
$function$;

CREATE OR REPLACE FUNCTION public.edition_my_organisers()
 RETURNS TABLE(organiser_id uuid, role text, via_hub boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select o.id, public.edition_org_role(o.id),
         not exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid())
    from public.edition_organisers o
   where auth.uid() is not null
     and (o.hub_id is not null or exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid()))
     and public.edition_org_role(o.id) is not null
$function$;

CREATE OR REPLACE FUNCTION public.edition_members_last_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.role <> 'owner')) and old.role = 'owner' then
    if not exists (select 1 from public.edition_organiser_members m where m.organiser_id = old.organiser_id and m.role = 'owner' and m.user_id <> old.user_id)
       and not exists (select 1 from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = old.organiser_id and h.is_active) then
      -- allow the cascade when the organiser itself is being deleted
      if exists (select 1 from public.edition_organisers o where o.id = old.organiser_id) then
        raise exception 'an organiser must keep at least one owner' using errcode = '23514', hint = 'last_owner';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $function$;

drop function if exists public.edition_controls_business(uuid);
drop function if exists public.edition_business_role(uuid);
drop function if exists public.edition_parent_live(uuid);
drop index if exists public.edition_organisers_one_per_business;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'edition_organisers' and column_name = 'business_id') then
    revoke select (business_id) on public.edition_organisers from anon, authenticated;
  end if;
end $$;
alter table public.edition_organisers drop constraint if exists edition_organisers_business_id_fkey;
alter table public.edition_organisers drop column if exists business_id;
alter table public.edition_organisers drop constraint if exists edition_organisers_hub_id_fkey;
alter table public.edition_organisers add constraint edition_organisers_hub_id_fkey foreign key (hub_id) references public.hubs (id) on delete set null;

-- OneShetland Editions 1.1, part 2: Hub-run Editions, with the Hub's committee as the live authority.
--
-- A Hub can run its own Editions through an organiser identity LINKED to it (edition_organisers.hub_id). Nothing is duplicated and nothing is synchronised: authority over a
-- Hub-linked organiser is DERIVED, at the moment of every check, from the Hub's own owner and committee (hub_members, status 'active'). Demote or remove a committee member
-- in the Hub and their Edition access ends on their next request; add one and it begins. The Hub owner counts as an organiser owner, a committee member as an organiser
-- administrator. Explicit organiser team members still work exactly as before and the higher of the two roles applies.
--
-- Everything that reads authority already goes through edition_org_role / edition_org_can (every policy and function), so replacing edition_org_role is what extends them all.
-- The few places that read organiser member rows DIRECTLY are updated here too: storage uploads, notification recipients, the team list, account deletion, "my organisers".
-- Additive: the three payment functions are untouched, no Hub or hub_members row or policy is altered.

-- ── the derived role ────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_hub_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when auth.uid() is null then null
    when h.owner_id = auth.uid() then 'owner'
    when exists (select 1 from public.hub_members m where m.hub_id = h.id and m.user_id = auth.uid() and m.status = 'active' and m.role = 'owner') then 'owner'
    when exists (select 1 from public.hub_members m where m.hub_id = h.id and m.user_id = auth.uid() and m.status = 'active' and m.role = 'committee') then 'admin'
  end
  from public.edition_organisers o join public.hubs h on h.id = o.hub_id
  where o.id = p_org and h.is_active
$$;

-- the higher of the explicit team role and the Hub-derived role
create or replace function public.edition_org_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select (array_agg(r order by public.edition_role_rank(r) desc))[1]
    from (select m.role as r from public.edition_organiser_members m where m.organiser_id = p_org and m.user_id = auth.uid() and auth.uid() is not null
          union all select public.edition_hub_role(p_org)) x
   where r is not null
$$;

-- ── places that read organiser members directly ─────────────────────────────────────────────────────────────────────
drop policy if exists "edition-media member write" on storage.objects;
drop policy if exists "edition-media member update" on storage.objects;
drop policy if exists "edition-media member delete" on storage.objects;
create policy "edition-media member write" on storage.objects for insert to authenticated
  with check (bucket_id = 'edition-media' and exists (select 1 from public.edition_organisers o where o.id::text = split_part(name, '/', 1) and public.edition_org_can(o.id, 'editor')));
create policy "edition-media member update" on storage.objects for update to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organisers o where o.id::text = split_part(name, '/', 1) and public.edition_org_can(o.id, 'editor')));
create policy "edition-media member delete" on storage.objects for delete to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organisers o where o.id::text = split_part(name, '/', 1) and public.edition_org_can(o.id, 'editor')));

create or replace function public.edition_org_admin_users(p_org uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.edition_organiser_members m where m.organiser_id = p_org and m.role in ('owner', 'admin')
  union select h.owner_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = p_org and h.is_active
  union select hm.user_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id join public.hub_members hm on hm.hub_id = h.id
         where o.id = p_org and h.is_active and hm.status = 'active' and hm.role in ('owner', 'committee')
$$;

-- the team list now says who is on it through the Hub (they cannot be removed here: change the Hub's committee)
drop function if exists public.edition_org_team(uuid);
create or replace function public.edition_org_team(p_org uuid)
returns table (user_id uuid, role text, full_name text, joined_at timestamptz, via_hub boolean)
language sql stable security definer set search_path = public, pg_temp as $$
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
$$;

-- account deletion: an organiser linked to a Hub always has the Hub's authority, so a sole explicit owner may go
create or replace function public.delete_member_editions(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null then raise exception 'user required' using errcode = '22004'; end if;
  if exists (select 1 from public.edition_organiser_members m join public.edition_organisers o on o.id = m.organiser_id
              where m.user_id = p_user and m.role = 'owner' and o.hub_id is null
                and not exists (select 1 from public.edition_organiser_members x where x.organiser_id = m.organiser_id and x.role = 'owner' and x.user_id <> p_user)) then
    raise exception 'sole owner of an organiser: transfer ownership before deleting this account' using errcode = 'P0001';
  end if;
  delete from public.edition_saves where user_id = p_user;
  delete from public.edition_plan_items where user_id = p_user;
  delete from public.edition_organiser_members where user_id = p_user;
end $$;

-- The last explicit owner may go when the organiser is run by an active Hub: the Hub's owner always remains its authority (Hub-derived owners hold no member row)
create or replace function public.edition_members_last_owner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
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
end $$;

-- ── a Hub's administrators, without knowing the organiser machinery ─────────────────────────────────────────────────
-- Organisers the signed-in person can act for: explicit team memberships plus Hub-derived authority.
create or replace function public.edition_my_organisers() returns table (organiser_id uuid, role text, via_hub boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select o.id, public.edition_org_role(o.id),
         not exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid())
    from public.edition_organisers o
   where auth.uid() is not null
     and (o.hub_id is not null or exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid()))
     and public.edition_org_role(o.id) is not null
$$;
create or replace function public.edition_has_organiser_access() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.edition_my_organisers())
$$;

-- The Hubs the signed-in person runs (owner or active committee), and where each stands with Editions.
create or replace function public.edition_my_hubs()
returns table (hub_id uuid, hub_name text, hub_slug text, hub_role text, organiser_id uuid, organiser_slug text, organiser_status text, edition_count integer, pending_invitations integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select h.id, h.name, h.slug,
         case when h.owner_id = auth.uid() or exists (select 1 from public.hub_members m where m.hub_id = h.id and m.user_id = auth.uid() and m.status = 'active' and m.role = 'owner') then 'owner' else 'committee' end,
         o.id, o.slug, o.status, (select count(*)::int from public.editions e where e.organiser_id = o.id),
         (select count(*)::int from public.edition_links l where l.hub_id = h.id and l.state = 'pending' and l.initiated_by = 'organiser')
    from public.hubs h
    left join lateral (select * from public.edition_organisers x where x.hub_id = h.id and x.status <> 'rejected' order by x.created_at limit 1) o on true
   where auth.uid() is not null and h.is_active and public.edition_controls_hub(h.id)
   order by h.name
$$;

-- One organiser per Hub. Slug rules and reserved-name review are the same as for any organiser; the dark-launch trigger still applies (while Editions is off only a platform
-- administrator can create one).
create unique index if not exists edition_organisers_one_per_hub on public.edition_organisers (hub_id) where hub_id is not null and status <> 'rejected';

create or replace function public.create_edition_organiser_for_hub(p_hub uuid, p_slug text, p_name text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hubs%rowtype; v_id uuid; v_flag boolean; v_name text;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select * into h from public.hubs where id = p_hub and is_active;
  if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
  if not public.edition_controls_hub(p_hub) then raise exception 'only the Hub''s owner or committee can set up Editions for it' using errcode = '42501'; end if;
  if exists (select 1 from public.edition_organisers o where o.hub_id = p_hub and o.status <> 'rejected') then
    raise exception 'this Hub already has an Editions organiser' using errcode = '23505', hint = 'hub_has_organiser';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 60 then raise exception 'choose a web address of 3 to 60 letters, numbers and hyphens' using errcode = '22023', hint = 'bad_slug'; end if;
  if p_slug in ('new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined') then
    raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), btrim(h.name));
  select exists (select 1 from public.edition_reserved_names r
                  where public.edition_normalise_name(v_name) like '%' || r.pattern || '%' or replace(p_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, reserved_name_flag, created_by, hub_id) values (p_slug, v_name, v_flag, auth.uid(), p_hub) returning id into v_id;
  perform public.edition_audit(v_id, null, 'organiser_created_for_hub', jsonb_build_object('hub_id', p_hub, 'reserved_name_flag', v_flag));
  return v_id;
end $$;

-- ── privileges ──────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array[
    'edition_hub_role(uuid)', 'edition_org_role(uuid)', 'edition_org_admin_users(uuid)', 'edition_org_team(uuid)', 'delete_member_editions(uuid)',
    'edition_my_organisers()', 'edition_has_organiser_access()', 'edition_my_hubs()', 'create_edition_organiser_for_hub(uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['edition_org_role(uuid)', 'edition_org_team(uuid)', 'edition_my_organisers()', 'edition_has_organiser_access()', 'edition_my_hubs()', 'create_edition_organiser_for_hub(uuid,text,text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  grant execute on function public.delete_member_editions(uuid) to service_role;
  grant execute on function public.edition_org_admin_users(uuid) to service_role;
end $$;

-- Rolls back 20270102170000_editions_hub_run.sql. Data written through the new features (Hub links, Hub items, Hub-run organisers) is removed or unlinked as stated; everything older is restored exactly as before.
create or replace function public.edition_org_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.edition_organiser_members m where m.organiser_id = p_org and m.user_id = auth.uid() and auth.uid() is not null
$$;
drop policy if exists "edition-media member write" on storage.objects;
create policy "edition-media member write" on storage.objects for insert to authenticated
  with check (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));
drop policy if exists "edition-media member update" on storage.objects;
create policy "edition-media member update" on storage.objects for update to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));
drop policy if exists "edition-media member delete" on storage.objects;
create policy "edition-media member delete" on storage.objects for delete to authenticated
  using (bucket_id = 'edition-media' and exists (select 1 from public.edition_organiser_members m
               where m.organiser_id::text = split_part(name, '/', 1) and m.user_id = auth.uid()));
create or replace function public.edition_org_admin_users(p_org uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.edition_organiser_members m where m.organiser_id = p_org and m.role in ('owner', 'admin')
$$;
drop function if exists public.edition_org_team(uuid);
create or replace function public.edition_org_team(p_org uuid)
returns table (user_id uuid, role text, full_name text, joined_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id, m.role, p.full_name, m.created_at
    from public.edition_organiser_members m left join public.profiles p on p.id = m.user_id
   where m.organiser_id = p_org and public.edition_org_can(p_org, 'admin')
   order by public.edition_role_rank(m.role) desc, m.created_at
$$;
revoke all on function public.edition_org_team(uuid) from public, anon;
grant execute on function public.edition_org_team(uuid) to authenticated;
create or replace function public.delete_member_editions(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null then raise exception 'user required' using errcode = '22004'; end if;
  if exists (select 1 from public.edition_organiser_members m where m.user_id = p_user and m.role = 'owner'
              and not exists (select 1 from public.edition_organiser_members o where o.organiser_id = m.organiser_id and o.role = 'owner' and o.user_id <> p_user)) then
    raise exception 'sole owner of an organiser: transfer ownership before deleting this account' using errcode = 'P0001';
  end if;
  delete from public.edition_saves where user_id = p_user;
  delete from public.edition_plan_items where user_id = p_user;
  delete from public.edition_organiser_members where user_id = p_user;
end $$;
create or replace function public.edition_members_last_owner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.role <> 'owner')) and old.role = 'owner' then
    if not exists (select 1 from public.edition_organiser_members m where m.organiser_id = old.organiser_id and m.role = 'owner' and m.user_id <> old.user_id) then
      -- allow the cascade when the organiser itself is being deleted
      if exists (select 1 from public.edition_organisers o where o.id = old.organiser_id) then
        raise exception 'an organiser must keep at least one owner' using errcode = '23514', hint = 'last_owner';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop function if exists public.create_edition_organiser_for_hub(uuid, text, text);
drop function if exists public.edition_my_hubs();
drop function if exists public.edition_has_organiser_access();
drop function if exists public.edition_my_organisers();
drop function if exists public.edition_hub_role(uuid);
-- Hub-run organisers keep their rows and their Hub link; they simply lose Hub-derived authority (an administrator can re-link or add team members).
drop index if exists public.edition_organisers_one_per_hub;

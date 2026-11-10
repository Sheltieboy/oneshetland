-- Editions: only a OneShetland Business or Hub can run Editions. The organiser record becomes the Editions profile of exactly ONE parent, created and kept in step automatically.
--
--   * edition_organisers.business_id (new) beside hub_id; exactly one parent (CHECK added NOT VALID so existing rows are untouched until the legacy record is attached below; validated by the
--     contract migration). One live profile per Hub and per Business. Deleting a parent that has Editions is refused (RESTRICT), so an organiser can never silently become standalone.
--   * Roles are derived live from the parent and never copied: Hub owner = owner, active committee = admin (unchanged); Business owner = owner (new). Helpers are the existing invited
--     members and can never be owner.
--   * edition_ensure_organiser(kind, parent) creates the profile on first entry (idempotent, owner-gated, address generated and collision-checked). Nobody registers an organiser.
--   * The organiser's name follows the parent's name. A parent that is inactive (or an unclaimed Business) is not "live"; edition_parent_live() is used by the public rules in the next migration.
--   * The one legacy standalone record ("OneShetland Editions Studio") is attached to the OneShetland Hub, only if that Hub is active and every explicit owner of the record is also an owner of the Hub.
-- Expand-only: nothing here removes or hides anything a deployed web build uses. Rollback: supabase/rollbacks/20270103000000_editions_business_and_hub_identity.rollback.sql

alter table public.edition_organisers add column if not exists business_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_organisers_business_id_fkey') then
    alter table public.edition_organisers add constraint edition_organisers_business_id_fkey foreign key (business_id) references public.local_businesses (id) on delete restrict;
  end if;
  -- a deleted Hub used to turn its organiser into a standalone one (ON DELETE SET NULL); refuse instead
  alter table public.edition_organisers drop constraint if exists edition_organisers_hub_id_fkey;
  alter table public.edition_organisers add constraint edition_organisers_hub_id_fkey foreign key (hub_id) references public.hubs (id) on delete restrict;
  if not exists (select 1 from pg_constraint where conname = 'edition_organisers_one_parent') then
    alter table public.edition_organisers add constraint edition_organisers_one_parent check (num_nonnulls(hub_id, business_id) = 1) not valid;
  end if;
end $$;
create unique index if not exists edition_organisers_one_per_business on public.edition_organisers (business_id) where business_id is not null and status <> 'rejected';
grant select (business_id) on public.edition_organisers to anon, authenticated;

-- ── parent helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_parent_live(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (o.hub_id is not null and coalesce(h.is_active, false))
                       or (o.business_id is not null and coalesce(b.is_active, false) and b.owner_id is not null)
                     from public.edition_organisers o left join public.hubs h on h.id = o.hub_id left join public.local_businesses b on b.id = o.business_id
                    where o.id = p_org), false)
$$;

create or replace function public.edition_business_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when auth.uid() is null then null when b.owner_id = auth.uid() then 'owner' end
    from public.edition_organisers o join public.local_businesses b on b.id = o.business_id
   where o.id = p_org and b.is_active
$$;

create or replace function public.edition_controls_business(p_business uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_business is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active and b.owner_id = auth.uid())
$$;

-- the caller's role: explicit helpers, the Hub's people, or the Business owner; the highest wins
create or replace function public.edition_org_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select (array_agg(r order by public.edition_role_rank(r) desc))[1]
    from (select m.role as r from public.edition_organiser_members m where m.organiser_id = p_org and m.user_id = auth.uid() and auth.uid() is not null
          union all select public.edition_hub_role(p_org)
          union all select public.edition_business_role(p_org)) x
   where r is not null
$$;

-- people to tell about an organiser's decisions: helpers (owner/admin), the Hub's owner and committee, the Business owner
create or replace function public.edition_org_admin_users(p_org uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.edition_organiser_members m where m.organiser_id = p_org and m.role in ('owner', 'admin')
  union select h.owner_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = p_org and h.is_active
  union select hm.user_id from public.edition_organisers o join public.hubs h on h.id = o.hub_id join public.hub_members hm on hm.hub_id = h.id
         where o.id = p_org and h.is_active and hm.status = 'active' and hm.role in ('owner', 'committee')
  union select b.owner_id from public.edition_organisers o join public.local_businesses b on b.id = o.business_id where o.id = p_org and b.is_active and b.owner_id is not null
$$;

-- team screen: explicit helpers plus everyone whose access comes from the parent
create or replace function public.edition_org_team(p_org uuid) returns table (user_id uuid, role text, full_name text, joined_at timestamptz, via_hub boolean)
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
             where o.id = p_org and h.is_active and hm.status = 'active' and hm.role in ('owner', 'committee')
            union
            select b.owner_id, 'owner'::text, b.created_at
              from public.edition_organisers o join public.local_businesses b on b.id = o.business_id where o.id = p_org and b.is_active and b.owner_id is not null) u
      left join public.profiles p on p.id = u.user_id
     where not exists (select 1 from public.edition_organiser_members m2 where m2.organiser_id = p_org and m2.user_id = u.user_id)
  ) t
  where public.edition_org_can(p_org, 'admin')
  order by public.edition_role_rank(t.role) desc, t.via_hub, t.joined_at
$$;

-- organisers the caller can work on (now including Businesses they own)
create or replace function public.edition_my_organisers() returns table (organiser_id uuid, role text, via_hub boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select o.id, public.edition_org_role(o.id),
         not exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid())
    from public.edition_organisers o
   where auth.uid() is not null
     and (o.hub_id is not null or o.business_id is not null or exists (select 1 from public.edition_organiser_members m where m.organiser_id = o.id and m.user_id = auth.uid()))
     and public.edition_org_role(o.id) is not null
$$;

-- ── a helpers' roles can never include owner on a parent-linked organiser (ownership stays with the Business or Hub owner) ──────────────────────
create or replace function public.edition_members_no_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role = 'owner' and (tg_op = 'INSERT' or old.role is distinct from 'owner') then
    raise exception 'ownership comes from the Business or Hub, so a helper cannot be an owner' using errcode = '42501', hint = 'helper_not_owner';
  end if;
  return new;
end $$;
drop trigger if exists edition_members_no_owner on public.edition_organiser_members;
create trigger edition_members_no_owner before insert or update of role on public.edition_organiser_members for each row execute function public.edition_members_no_owner();

-- an organiser may have no explicit owner when its parent is live (the parent's owner is the owner)
create or replace function public.edition_members_last_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.role <> 'owner')) and old.role = 'owner' then
    if not exists (select 1 from public.edition_organiser_members m where m.organiser_id = old.organiser_id and m.role = 'owner' and m.user_id <> old.user_id)
       and not public.edition_parent_live(old.organiser_id) then
      if exists (select 1 from public.edition_organisers o where o.id = old.organiser_id) then
        raise exception 'an organiser must keep at least one owner' using errcode = '23514', hint = 'last_owner';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- ── the organiser's name follows its parent ──────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_sync_parent_name() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.name is distinct from old.name then
    if tg_table_name = 'hubs' then
      update public.edition_organisers set name = left(btrim(new.name), 120) where hub_id = new.id and name is distinct from left(btrim(new.name), 120) and char_length(btrim(new.name)) >= 2;
    else
      update public.edition_organisers set name = left(btrim(new.name), 120) where business_id = new.id and name is distinct from left(btrim(new.name), 120) and char_length(btrim(new.name)) >= 2;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists edition_sync_hub_name on public.hubs;
create trigger edition_sync_hub_name after update of name on public.hubs for each row execute function public.edition_sync_parent_name();
drop trigger if exists edition_sync_business_name on public.local_businesses;
create trigger edition_sync_business_name after update of name on public.local_businesses for each row execute function public.edition_sync_parent_name();

-- ── a web address from a name: lower case, accents folded, one hyphen between words, at most 60 characters ─────────────────────────────────────
create or replace function public.edition_slugify(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select trim(both '-' from left(regexp_replace(translate(lower(coalesce(p, '')), 'áàâäãåéèêëíìîïóòôöõøúùûüçñ''’', 'aaaaaaeeeeiiiioooooouuuucn'), '[^a-z0-9]+', '-', 'g'), 60))
$$;

-- ── enter Editions from a Business or Hub: creates the Editions profile the first time, returns it every time after ─────────────────────────────
create or replace function public.edition_ensure_organiser(p_kind text, p_parent uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_org public.edition_organisers%rowtype; v_slug text; v_base text; v_n int := 0; v_flag boolean; v_id uuid;
  v_reserved text[] := array['new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined'];
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if p_kind not in ('hub', 'business') then raise exception 'bad kind' using errcode = '22023'; end if;
  if p_kind = 'hub' then
    select h.name into v_name from public.hubs h where h.id = p_parent and h.is_active;
    if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
    if not public.edition_controls_hub(p_parent) then raise exception 'only the Hub''s owner or committee can use Editions for it' using errcode = '42501'; end if;
    select * into v_org from public.edition_organisers x where x.hub_id = p_parent and x.status <> 'rejected' order by x.created_at limit 1;
  else
    select b.name into v_name from public.local_businesses b where b.id = p_parent and b.is_active and b.owner_id is not null;
    if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
    if not public.edition_controls_business(p_parent) then raise exception 'only the Business owner can use Editions for it' using errcode = '42501'; end if;
    select * into v_org from public.edition_organisers x where x.business_id = p_parent and x.status <> 'rejected' order by x.created_at limit 1;
  end if;
  if v_org.id is not null then return jsonb_build_object('id', v_org.id, 'slug', v_org.slug, 'created', false); end if;
  v_base := coalesce(nullif(public.edition_slugify(v_name), ''), 'organiser');
  if char_length(v_base) < 3 then v_base := v_base || '-editions'; end if;
  v_slug := v_base;
  while v_slug = any (v_reserved) or exists (select 1 from public.edition_organisers x where x.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := left(v_base, 60 - char_length('-editions' || case when v_n > 1 then '-' || v_n else '' end)) || '-editions' || case when v_n > 1 then '-' || v_n else '' end;
    if v_n > 200 then raise exception 'could not choose a web address' using errcode = '23505'; end if;
  end loop;
  select exists (select 1 from public.edition_reserved_names r where public.edition_normalise_name(v_name) like '%' || r.pattern || '%' or replace(v_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, reserved_name_flag, created_by, hub_id, business_id)
  values (v_slug, left(btrim(v_name), 120), v_flag, auth.uid(), case when p_kind = 'hub' then p_parent end, case when p_kind = 'business' then p_parent end) returning id into v_id;
  perform public.edition_audit(v_id, null, 'organiser_created_from_' || p_kind, jsonb_build_object('parent', p_parent, 'reserved_name_flag', v_flag));
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'created', true);
end $$;

-- ── the legacy standalone record joins the OneShetland Hub (only if ownership and identity line up); nothing is deleted or moved ──────────────────
do $$
declare o public.edition_organisers%rowtype; h public.hubs%rowtype; v_bad int;
begin
  select * into o from public.edition_organisers where slug = 'oneshetland-editions-studio' and hub_id is null and business_id is null;
  if not found then return; end if;
  select * into h from public.hubs where name = 'OneShetland' and is_active order by created_at limit 1;
  if not found then raise notice 'Editions Studio not attached: no active OneShetland Hub'; return; end if;
  if exists (select 1 from public.edition_organisers x where x.hub_id = h.id and x.status <> 'rejected') then raise notice 'Editions Studio not attached: the OneShetland Hub already has an Editions profile'; return; end if;
  select count(*) into v_bad from public.edition_organiser_members m
   where m.organiser_id = o.id and m.role = 'owner'
     and m.user_id <> h.owner_id and not exists (select 1 from public.hub_members hm where hm.hub_id = h.id and hm.user_id = m.user_id and hm.status = 'active' and hm.role = 'owner');
  if v_bad > 0 then raise notice 'Editions Studio not attached: an owner of the record is not an owner of the OneShetland Hub'; return; end if;
  update public.edition_organisers set hub_id = h.id where id = o.id;
  insert into public.edition_audit_log (actor, organiser_id, edition_id, action, detail)
    values (null, o.id, null, 'organiser_attached_to_hub', jsonb_build_object('hub_id', h.id, 'hub_name', h.name, 'previous_hub_id', null, 'reason', 'standalone organisers are retired; ownership and identity match'));
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['edition_parent_live(uuid)', 'edition_business_role(uuid)', 'edition_controls_business(uuid)', 'edition_slugify(text)', 'edition_ensure_organiser(text,uuid)',
    'edition_members_no_owner()', 'edition_sync_parent_name()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['edition_ensure_organiser(text,uuid)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- read helpers used inside policies and by signed-in screens, like the existing role functions
  grant execute on function public.edition_parent_live(uuid), public.edition_business_role(uuid), public.edition_controls_business(uuid) to anon, authenticated;
end $$;

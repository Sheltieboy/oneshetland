-- Editions R7: hardening from the independent pre-release security review. Additive and reversible; no data is changed.
--  H2  signed-out visitors could read internal organiser columns (admin verification note, verifier and creator user ids, the reserved-name flag, contact email).
--      Table-wide SELECT is replaced by column lists. Admins read the internal columns through definer functions.
--  L1  signed-out visitors could read venue notes and update author ids: same fix (column lists for anon).
--  M2  a business owner could read private columns of payments recorded for their business (offline-record notes, who recorded it, platform fee, net to organiser,
--      Stripe ids) and of their participation row (waiver note). The web app only reads these through definer functions, so direct table SELECT is withdrawn.
--  M4  an unverified organiser could send invitations (and so emails) to business owners: invitations now need a verified organiser, with a daily cap.

-- H2 -------------------------------------------------------------------------------------------------------------------------------------------------------
revoke select on public.edition_organisers from anon, authenticated;
grant select (id, slug, name, tagline, description, logo_url, cover_url, cover_focus, brand_color, website, hub_id, status, verified_at, is_test, created_at, updated_at) on public.edition_organisers to anon;
grant select (id, slug, name, tagline, description, logo_url, cover_url, cover_focus, brand_color, website, contact_email, hub_id, status, verified_at, is_test, created_at, updated_at) on public.edition_organisers to authenticated;

-- admin-only access to the internal columns
create or replace function public.admin_edition_org_internal(p_org uuid)
returns table (verification_note text, verified_by uuid, reserved_name_flag boolean, created_by uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select o.verification_note, o.verified_by, o.reserved_name_flag, o.created_by from public.edition_organisers o where o.id = p_org;
end $$;
create or replace function public.admin_edition_org_flags()
returns table (id uuid, reserved_name_flag boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select o.id, o.reserved_name_flag from public.edition_organisers o;
end $$;
revoke all on function public.admin_edition_org_internal(uuid), public.admin_edition_org_flags() from public, anon, authenticated;
grant execute on function public.admin_edition_org_internal(uuid), public.admin_edition_org_flags() to authenticated;

-- L1 -------------------------------------------------------------------------------------------------------------------------------------------------------
revoke select on public.edition_venues from anon;
grant select (id, organiser_id, name, address, lat, lng, created_at) on public.edition_venues to anon;
revoke select on public.edition_updates from anon;
grant select (id, edition_id, title, body, pinned, published_at, created_at, updated_at) on public.edition_updates to anon;

-- M2 -------------------------------------------------------------------------------------------------------------------------------------------------------
revoke select on public.edition_payments from authenticated;
revoke select on public.edition_participations from authenticated;

-- M4 -------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.edition_links_invite_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_status text; v_today int;
begin
  if new.initiated_by = 'organiser' and new.state = 'pending' then
    select o.id, o.status into v_org, v_status from public.editions e join public.edition_organisers o on o.id = e.organiser_id where e.id = new.edition_id;
    if v_status is distinct from 'verified' then raise exception 'only a verified organiser can send invitations' using errcode = '42501'; end if;
    select count(*) into v_today from public.edition_links l join public.editions e on e.id = l.edition_id
      where e.organiser_id = v_org and l.initiated_by = 'organiser' and l.created_at > now() - interval '24 hours';
    if v_today >= 60 then raise exception 'you have sent many invitations today; please try again tomorrow' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.edition_links_invite_guard() from public, anon, authenticated;
drop trigger if exists aa_edition_links_invite_guard on public.edition_links;
create trigger aa_edition_links_invite_guard before insert on public.edition_links for each row execute function public.edition_links_invite_guard();

-- Account deletion -----------------------------------------------------------------------------------------------------------------------------------------
-- The existing delete-account function SOFT-deletes the auth user, so database cascades never fire and Editions data would be left behind. This is the Editions
-- clean-up it calls (service role only, by the authenticated id only): the member's saved Editions and plans, and their organiser team memberships. A SOLE owner of an
-- organiser is refused (they must transfer ownership first) so an organisation is never left without an owner; the payment ledger is append-only by design and keeps
-- only an opaque id.
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
revoke all on function public.delete_member_editions(uuid) from public, anon, authenticated;
grant execute on function public.delete_member_editions(uuid) to service_role;

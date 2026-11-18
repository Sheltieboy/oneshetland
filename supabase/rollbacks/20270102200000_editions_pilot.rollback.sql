-- Rolls back 20270102200000: restores the two read predicates to their pre-pilot definitions (public only when editions.enabled is true), then drops the pilot functions and the approvals table.
-- Order matters: the predicates are restored FIRST so nothing references the functions being dropped. Pilot approval history is discarded with the table (the audit log keeps the actions).
create or replace function public.edition_is_public(p_edition uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.editions_enabled() and exists (
    select 1 from public.editions e join public.edition_organisers o on o.id = e.organiser_id
     where e.id = p_edition and e.status = 'published' and not e.is_test and not o.is_test and o.status = 'verified'
       and public.edition_entitled(e.id, 'publish'))
$$;
drop policy if exists "edition_organisers public read" on public.edition_organisers;
create policy "edition_organisers public read" on public.edition_organisers for select to anon, authenticated
  using (public.editions_enabled() and status = 'verified' and not is_test);

drop function if exists public.admin_grant_edition_pilot_publish(uuid, text, integer);
drop function if exists public.admin_revoke_edition_pilot(uuid, text);
drop function if exists public.admin_approve_edition_pilot(uuid, text);
drop function if exists public.admin_create_edition_organiser_for_hub(uuid, text, text, text);
drop function if exists public.admin_set_editions_pilot(boolean, text);
drop function if exists public.edition_pilot_visible(uuid);
drop table if exists public.edition_pilot_approvals;
drop function if exists public.edition_pilot_approvals_guard();
drop function if exists public.editions_pilot();
delete from public.admin_config where key = 'editions.pilot';

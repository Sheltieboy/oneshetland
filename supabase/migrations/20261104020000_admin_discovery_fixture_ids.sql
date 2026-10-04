-- Let an ADMINISTRATOR'S app label test fixtures.
--
-- discovery_fixtures (20261104010000) hides test/acceptance fixtures from public discovery, and deliberately lets an
-- administrator keep seeing them so the Wallet acceptance can still be run on a phone. The one thing missing: an admin
-- looking at a fixture in the app could not tell it from genuine content, because the table is not readable by the app.
--
-- This function hands the fixture ids to exactly the people who can SEE the fixtures: an administrator (all of them) and
-- a fixture's own owner (only their own, since the existing owner policies let them see it too). It reads the same
-- explicit list the hiding logic uses (no name matching), writes nothing, and changes no policy. Anyone else gets an
-- empty result and a signed-out caller is refused outright, so the public learns nothing about which records are tests.
begin;

create or replace function public.admin_discovery_fixture_ids()
returns table (entity text, entity_id uuid)
language plpgsql stable security definer set search_path = public
as $$
begin
  return query
    select f.entity, f.entity_id
    from public.discovery_fixtures f
    where coalesce(public.is_admin(), false)
       or (f.entity = 'business' and exists (select 1 from public.local_businesses b where b.id = f.entity_id and b.owner_id = auth.uid()))
       or (f.entity = 'hub'      and exists (select 1 from public.hubs h            where h.id = f.entity_id and h.owner_id = auth.uid()));
end;
$$;

revoke execute on function public.admin_discovery_fixture_ids() from public, anon;
grant  execute on function public.admin_discovery_fixture_ids() to authenticated, service_role;

commit;

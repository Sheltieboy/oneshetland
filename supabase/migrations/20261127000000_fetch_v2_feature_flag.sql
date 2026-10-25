-- Fetch v2 — server-authoritative feature flag (docs/FETCH_V2_IMPLEMENTATION.md, Step 0b, section N.1).
--
-- Fetch v2 is built behind one switch that the DATABASE answers, not the clients. Hiding a button is presentation; the gate is that
-- every Fetch v2 RPC and edge function asks this flag and refuses when it says no. This migration adds only the switch and the
-- question — no Fetch table, policy, trigger or function changes, so current (v1) Fetch behaves exactly as before.
--
-- The switch: admin_config 'fetch.v2.audience', one of
--   off       nobody (the default, and what any missing or unrecognised value means — the flag fails closed)
--   admins    profiles.role = 'admin' only
--   testers   admins, plus enabled testers of the Launch Test Centre programme 'fetch-v2'
--   everyone  every caller, signed in or not (actions still require membership on their own)
--
-- Selected testers reuse the existing Launch Test Centre: the 'fetch-v2' programme is seeded here as a draft, and an administrator
-- adds or disables people with launch_test_admin_add_tester / launch_test_admin_update_tester — no new tester machinery.
--
-- The questions:
--   fetch_v2_audience()        the normalised audience (definer: admin_config is admin-read only).          service_role only
--   fetch_v2_enabled_for(uuid) is Fetch v2 on for this user? Not callable by clients, so nobody can probe
--                              whether another account is an administrator or a tester.                    service_role only
--   fetch_v2_enabled()         is Fetch v2 on for ME? What the web and app ask to decide navigation.         anon, authenticated, service_role
--   fetch_v2_require()         raises 42501 unless on for the caller. Every Fetch v2 RPC calls it first.     authenticated, service_role
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves the deploy (plan S.1, S.17).

begin;

insert into public.admin_config (key, value, category, description, is_secret)
values (
  'fetch.v2.audience',
  'off',
  'fetch',
  'Who can use Fetch v2: off | admins | testers | everyone. Any other value is treated as off. Testers are the enabled testers of the Launch Test Centre programme "fetch-v2" (plus admins). Enforced by the database (fetch_v2_require), not only by hiding the UI.',
  false
)
on conflict (key) do nothing;

insert into public.launch_test_programmes (slug, name, description, status)
values (
  'fetch-v2',
  'Fetch v2',
  'Selected testers for Fetch v2. Enabled testers here can use Fetch v2 while fetch.v2.audience is "testers".',
  'draft'
)
on conflict (slug) do nothing;

create or replace function public.fetch_v2_audience() returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case lower(btrim(coalesce((select value from public.admin_config where key = 'fetch.v2.audience'), 'off')))
           when 'admins'   then 'admins'
           when 'testers'  then 'testers'
           when 'everyone' then 'everyone'
           else 'off'
         end;
$$;

create or replace function public.fetch_v2_enabled_for(p_user uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_audience text := public.fetch_v2_audience();
  v_admin    boolean;
begin
  if v_audience = 'everyone' then
    return true;
  end if;
  if v_audience = 'off' or p_user is null then
    return false;
  end if;

  select exists (select 1 from public.profiles p where p.id = p_user and p.role = 'admin') into v_admin;
  if v_admin then
    return true;
  end if;
  if v_audience = 'admins' then
    return false;
  end if;

  -- 'testers': an enabled tester of the fetch-v2 programme whose account still exists.
  return exists (
    select 1
      from public.launch_testers t
      join public.launch_test_programmes g on g.id = t.programme_id
      join auth.users u on u.id = t.user_id
     where g.slug = 'fetch-v2' and t.user_id = p_user and t.enabled and u.deleted_at is null
  );
end;
$$;

create or replace function public.fetch_v2_enabled() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.fetch_v2_enabled_for(auth.uid()); $$;

create or replace function public.fetch_v2_require() returns void
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.fetch_v2_enabled_for(auth.uid()) then
    raise exception 'Fetch is not available' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.fetch_v2_audience(), public.fetch_v2_enabled_for(uuid), public.fetch_v2_enabled(), public.fetch_v2_require()
  from public, anon, authenticated;
grant execute on function public.fetch_v2_audience(), public.fetch_v2_enabled_for(uuid) to service_role;
grant execute on function public.fetch_v2_enabled() to anon, authenticated, service_role;
grant execute on function public.fetch_v2_require() to authenticated, service_role;

comment on function public.fetch_v2_enabled_for(uuid) is
  'Fetch v2 feature flag for one user (fetch.v2.audience + the fetch-v2 Launch Test Centre programme). Fails closed. service_role only.';
comment on function public.fetch_v2_enabled() is
  'Is Fetch v2 available to the caller? For navigation only — every Fetch v2 action enforces the same answer server-side via fetch_v2_require().';
comment on function public.fetch_v2_require() is
  'Raises 42501 "Fetch is not available" unless Fetch v2 is enabled for the caller. The first statement of every Fetch v2 RPC.';

-- End-state assertions: the switch exists and is off, the programme exists, and clients cannot ask about other people.
do $$
begin
  if public.fetch_v2_audience() <> 'off' and (select value from public.admin_config where key = 'fetch.v2.audience') = 'off' then
    raise exception 'fetch_v2_audience() does not read the default';
  end if;
  if not exists (select 1 from public.launch_test_programmes where slug = 'fetch-v2') then
    raise exception 'fetch-v2 programme missing';
  end if;
  if has_function_privilege('authenticated', 'public.fetch_v2_enabled_for(uuid)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_enabled_for(uuid)', 'execute') then
    raise exception 'fetch_v2_enabled_for must not be callable by clients';
  end if;
end $$;

commit;

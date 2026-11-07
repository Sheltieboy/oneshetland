-- Reverses 20261230030000: the tester allowlist. event_submissions_open() returns to its original body (open only when the switch is exactly 'open').
-- Any 'testers' value left in the switch simply reads as closed afterwards. No data is touched.
begin;
create or replace function public.event_submissions_open() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(value)) from public.admin_config where key = 'events.member_submissions'), 'closed') = 'open'
$$;
drop function if exists public.event_submissions_tester();
commit;

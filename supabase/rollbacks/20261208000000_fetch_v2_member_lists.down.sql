-- Rollback of 20261208000000_fetch_v2_member_lists.sql (Fetch v2 Step 11). Read-only lists plus the areas setter; no data of its own.
begin;
drop function if exists public.fetch_v2_my_requests(), public.fetch_v2_my_jobs(), public.fetch_v2_my_runs(), public.fetch_v2_set_my_areas(uuid[]);
commit;

-- Count of distinct vessels with a Lerwick (LK) registration — for the Home
-- "Explore" Da Boats caption. SECURITY DEFINER + public read (the boats archive
-- is already publicly readable).
create or replace function public.count_lk_vessels()
returns integer
language sql
security definer
stable
as $$
  select count(distinct vessel_id)::int
  from public.registrations
  where port_mark = 'LK';
$$;

-- Public, aggregate-only social stats for an event, powering the What's On
-- "who's going" count and the "selling fast — N booked recently" urgency signal.
--
-- SECURITY DEFINER is safe here: the function returns ONLY integer counts (never
-- holder ids, names, or any row data), so it exposes no more than a public
-- "N going" badge. Callable by anon + authenticated so the public event page can
-- read it without leaking the per-ticket RLS-protected rows.

create or replace function public.get_event_social_stats(p_event_id uuid)
returns table (going_count integer, booked_recent integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where status in ('valid', 'used'))::int as going_count,
    count(*) filter (
      where status in ('valid', 'used')
        and created_at >= now() - interval '24 hours'
    )::int as booked_recent
  from public.event_tickets
  where event_id = p_event_id;
$$;

grant execute on function public.get_event_social_stats(uuid) to anon, authenticated;

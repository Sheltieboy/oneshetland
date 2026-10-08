-- F1 (19 Aug audit, re-confirmed 25 Sep): booking_meter_status had no ownership
-- check. It is SECURITY DEFINER and executable by `authenticated`, so any signed-in
-- user could read another business's monthly booking counts (booked / billed) by
-- passing its id. The only caller is the owner's own dashboard.
--
-- Same rule as business_analytics: the business's owner, a platform admin, or the
-- service role. Everyone else is refused (42501), not shown zeros. The body of the
-- count is unchanged; the return shape and grants are unchanged (create or replace
-- keeps the ACL: postgres, authenticated, service_role — never anon).

create or replace function public.booking_meter_status(p_business_id uuid, p_month date default null)
returns table(booked integer, billed integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (
    public.is_business_owner(p_business_id, auth.uid())
    or public.is_admin()
    or coalesce(auth.role(), '') = 'service_role'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    (count(*) filter (where b.status <> 'cancelled'))::int                               as booked,
    (count(*) filter (where b.status <> 'cancelled' and b.metered_at is not null))::int  as billed
  from public.book_bookings b
  where b.business_id = p_business_id
    and date_trunc('month', b.created_at) = date_trunc('month', coalesce(p_month::timestamptz, now()));
end;
$$;

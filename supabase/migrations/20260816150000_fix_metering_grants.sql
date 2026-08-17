-- ============================================================================
-- Lock down the two metering functions.
--
-- 20260816140000 ended with `revoke all on function bookings_due_metering from
-- public`, which was not enough. Supabase grants EXECUTE on functions in the
-- public schema to `anon` and `authenticated` by default, and revoking from the
-- PUBLIC pseudo-role does not remove those explicit grants. The function stayed
-- callable by anyone holding the anon key — which is every visitor to the site.
--
-- It is SECURITY DEFINER and returns business_id and stripe_subscription_id, so
-- that was an anonymous route to enumerating paying businesses and their Stripe
-- subscription IDs. Caught before any Pro business existed to enumerate.
--
-- booking_meter_count had a smaller version of the same problem: it took any
-- business_id and answered, so one signed-in user could read another business's
-- billed-booking count. It now checks ownership rather than relying on who is
-- allowed to call it.
-- ============================================================================

-- ── bookings_due_metering: service role only ────────────────────────────────
-- Nothing in the app calls this. Only meter-bookings does, with the service key,
-- which bypasses grants entirely.
revoke all on function public.bookings_due_metering(int) from public;
revoke all on function public.bookings_due_metering(int) from anon;
revoke all on function public.bookings_due_metering(int) from authenticated;

-- ── booking_meter_count: owners and admins only ─────────────────────────────
-- The dashboard calls this for the business you are looking at, so it stays
-- callable — but it now answers only for a business you own. An unauthenticated
-- caller has no auth.uid() and gets nothing.
create or replace function public.booking_meter_count(p_business_id uuid, p_month date default null)
returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.local_businesses where id = p_business_id;
  if v_owner is null then return 0; end if;
  if v_owner <> auth.uid() and not public.is_admin() then
    raise exception 'forbidden';
  end if;

  return (
    select count(*)::int
    from public.book_bookings
    where business_id = p_business_id
      and metered_at is not null
      and date_trunc('month', metered_at) = date_trunc('month', coalesce(p_month::timestamptz, now()))
  );
end;
$$;

comment on function public.booking_meter_count(uuid, date) is
  'Bookings already billed for this business this month. Owner or admin only — it is SECURITY DEFINER, so it checks who is asking rather than trusting the grant.';

revoke all on function public.booking_meter_count(uuid, date) from public;
revoke all on function public.booking_meter_count(uuid, date) from anon;
grant execute on function public.booking_meter_count(uuid, date) to authenticated;

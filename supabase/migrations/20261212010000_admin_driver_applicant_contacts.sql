-- ============================================================================
-- Admin: contact a Fetch driver applicant.
--
-- The Fetch driver applications screen needs the email address of each applicant's OneShetland account so an administrator can write to them. The address lives
-- in auth.users, which no client can read, so (as for the Launch Testing tester list) an ADMIN-ONLY SECURITY DEFINER function returns it.
--
--   * Only an administrator gets rows: anyone else (a driver, a customer) gets an authorisation error; anonymous callers cannot execute it at all.
--   * It returns ONLY (driver_id, email), for accounts that have a driver profile. No phone, no address, no name, no request data.
--   * It sends nothing and changes nothing. Fetch stays paused: this does not touch the pause switch, the guards, or any policy.
--
-- Version 20261212010000 sits between the safety fix (20261212000000) and the pending pause-hardening (20261213000000), so the pending migrations stay in order.
-- Reverse: supabase/rollbacks/20261212010000_admin_driver_applicant_contacts.rollback.sql
-- ============================================================================

begin;

create or replace function public.admin_driver_applicant_contacts()
returns table (driver_id uuid, email text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can do this' using errcode = '42501';
  end if;
  return query
    select dp.id, u.email::text
      from public.driver_profiles dp
      join auth.users u on u.id = dp.id
     where u.email is not null and u.deleted_at is null;
end $$;

revoke all on function public.admin_driver_applicant_contacts() from public, anon;
grant execute on function public.admin_driver_applicant_contacts() to authenticated, service_role;
comment on function public.admin_driver_applicant_contacts() is 'Administrator-only: (driver_id, account email) for every driver profile. Used to open a pre-addressed mail draft from the Fetch driver applications screen. Sends nothing.';

commit;

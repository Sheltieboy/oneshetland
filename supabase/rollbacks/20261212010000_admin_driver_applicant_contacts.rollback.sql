-- Reverses 20261212010000: removes the administrator-only applicant contact function. Nothing else was changed by that migration.
begin;
drop function if exists public.admin_driver_applicant_contacts();
commit;

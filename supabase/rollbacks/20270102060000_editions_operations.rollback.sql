-- Rollback for 20270102060000_editions_operations.sql (Editions R5 operations). Destroys ONLY what that migration created. Run the later migrations' rollbacks first (reverse order). Review before running; nothing else is touched.
begin;
drop trigger if exists zz_edition_links_email on public.edition_links;
drop trigger if exists zz_organiser_memberships_email on public.organiser_memberships;
drop trigger if exists zz_edition_payments_email on public.edition_payments;
drop function if exists public.edition_enqueue_email(text, uuid, text, jsonb) cascade;
drop function if exists public.edition_org_admin_users(uuid) cascade;
drop function if exists public.edition_subject_controller(text, uuid, uuid, uuid) cascade;
drop function if exists public.edition_subject_name(text, uuid, uuid, uuid) cascade;
drop function if exists public.edition_links_email() cascade;
drop function if exists public.organiser_memberships_email() cascade;
drop function if exists public.edition_payments_email() cascade;
drop function if exists public.edition_membership_enqueue_reminders() cascade;
drop function if exists public.edition_email_next(integer) cascade;
drop function if exists public.edition_email_mark(bigint, boolean, text) cascade;
drop function if exists public.edition_org_analytics(uuid, uuid, integer) cascade;
drop function if exists public.edition_my_org_invites() cascade;
drop table if exists public.edition_email_outbox cascade;
commit;

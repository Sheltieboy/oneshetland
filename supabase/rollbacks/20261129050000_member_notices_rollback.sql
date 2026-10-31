-- Rolls back 20261129050000_member_notices.sql. Notices members already posted stay (they are ordinary rows); only the functions go.
begin;
drop function if exists public.submit_person_notice(text, text, text, text[], timestamptz), public.my_person_notices(), public.withdraw_my_person_notice(uuid),
  public.staff_pending_person_notices(), public.staff_approve_person_notice(uuid), public.staff_decline_person_notice(uuid, text);
commit;

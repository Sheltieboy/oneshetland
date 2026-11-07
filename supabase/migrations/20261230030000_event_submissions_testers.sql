-- Events & Activities, controlled acceptance testing: a TESTER ALLOWLIST for member submissions.
--
-- The submissions switch (admin_config key 'events.member_submissions') has so far been all-or-nothing: absent = closed, 'open' = every signed-in member.
-- Acceptance testing needs real, signed-in, NON-staff accounts to try the journey on the real site WITHOUT opening it to the public. This adds a third
-- value, 'testers': submissions are then accepted ONLY from the accounts listed (comma / space / semicolon separated user ids) in the admin_config key
-- 'events.member_submissions.testers'. Everyone else is refused exactly as when it is closed; staff are unaffected (they may always submit; their
-- submissions only ever wait in the queue). Nothing here publishes anything, sends anything or changes any existing row.
--   absent or anything else -> closed          'open' -> every signed-in member          'testers' -> only the allowlisted accounts
-- The website uses event_submissions_tester() to let an allowlisted account reach the (otherwise hidden) pages; it is not callable by anon.
begin;

create or replace function public.event_submissions_tester() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null
     and coalesce((select lower(btrim(value)) from public.admin_config where key = 'events.member_submissions'), 'closed') = 'testers'
     and exists (
       select 1
         from regexp_split_to_table(coalesce((select value from public.admin_config where key = 'events.member_submissions.testers'), ''), '[\s,;]+') as t(tok)
        where lower(tok) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and lower(tok)::uuid = auth.uid())
$$;

-- Same signature and permissions as before (CREATE OR REPLACE keeps the grants): open for everyone when 'open', and for an allowlisted tester when 'testers'.
create or replace function public.event_submissions_open() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(value)) from public.admin_config where key = 'events.member_submissions'), 'closed') = 'open'
      or public.event_submissions_tester()
$$;

revoke all on function public.event_submissions_tester() from public, anon, authenticated;
grant execute on function public.event_submissions_tester() to authenticated, service_role;

commit;

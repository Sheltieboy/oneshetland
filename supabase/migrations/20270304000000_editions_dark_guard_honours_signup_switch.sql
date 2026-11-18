-- The dark-launch guard must honour the new organiser-registration switch.
--
-- NOT YET APPLIED. Found on 18 Nov 2026 by walking the organiser journey against a throwaway replica of the production schema.
--
-- WHAT IS WRONG. 20270303000000 split one overloaded switch into two so that organiser registration could be opened WITHOUT making
-- Editions public — the state a quiet launch needs, where a handful of invited festivals build their Editions in private before anything
-- is visible. edition_dark_launch_guard, a trigger on edition_organisers INSERT that predates that work, refuses every insert while
-- editions_enabled() is false unless the caller is a platform administrator. So editions.signup_open cannot take effect on its own:
-- registration only works once public visibility is already on, which is the opposite of what the split was for.
--
-- The admin screen states the unreachable case in as many words — "Eligible people can start Editions and work on them privately, but
-- nothing is visible to visitors yet" — so today the interface promises something the database refuses.
--
-- WHAT THIS CHANGES. One condition. The guard now lets an insert through when EITHER switch is on, instead of only the public one.
-- Both off still refuses, which is the dark-launch protection the trigger was written for and it is kept exactly. Administrators are
-- still exempt, as before. Nothing else about the guard, the trigger, or any other table changes.
--
-- WHAT IT DOES NOT CHANGE. Who may create an organiser is still decided by edition_ensure_organiser: the caller must control the
-- Business or Hub, and registration must be open or the caller staff. This trigger is the outer dark-launch shutter, not the rule.
-- The guard is on INSERT only, so an organiser that already exists is unaffected either way — verified against the replica.

create or replace function public.edition_dark_launch_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Was: `not public.editions_enabled()`. Now either switch opens the shutter, so registration can be opened on its own.
  if auth.uid() is not null and not public.editions_enabled() and not public.editions_signup_open() and not public.is_admin() then
    raise exception 'Editions is not open yet' using errcode = '23514', hint = 'editions_dark';
  end if;
  return new;
end $$;

-- post-checks: the shutter still shuts, and the trigger is still only on INSERT
do $$
declare n integer;
begin
  if to_regprocedure('public.editions_signup_open()') is null then raise exception 'post-check: editions_signup_open is missing — apply 20270303000000 first'; end if;
  select count(*) into n from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname = 'edition_organisers' and t.tgname = 'edition_organisers_dark_guard' and not t.tgisinternal and (t.tgtype::int & 4) > 0 and (t.tgtype::int & 16) = 0;
  if n <> 1 then raise exception 'post-check: the dark guard must remain a single INSERT trigger on edition_organisers'; end if;
end $$;

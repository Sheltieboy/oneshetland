-- Bressay Under 5s -> Regular Activity, STEP 2: GO LIVE. Run only after step 1 has been reviewed and approved.
-- ONE transaction. It first PROVES the activity produces exactly the sessions the seven live events show today; if even one start or end
-- differs it stops and changes nothing. Then it publishes the activity, records where each old event URL now points (so every old link
-- redirects to the activity), and archives ONLY those seven named event rows. Nothing else is touched. Step 3 undoes it.
begin;
do $$
declare
  a uuid; r uuid; n int; diffs int;
  ids uuid[] := array['631c1981-5ddc-834d-9456-1e62a30ce691','28a12d8c-c8be-7398-884a-c0f56842a890','82b66785-b681-99b2-16d9-c8643feaaf2e',
                      '03d78c64-c673-b340-8785-b5e2db410511','45d1ba64-f991-6414-4e41-d61318ee8144','00c6df8c-41cc-62d0-6204-a2d91de09229',
                      'a2e870ef-c163-bc6b-fb4a-7daf1bbde8c5']::uuid[];
begin
  select id into a from public.regular_activities where slug = 'bressay-under-5s' and status = 'draft' and is_platform_activity for update;
  if a is null then raise exception 'The prepared draft was not found (or is already live)'; end if;
  select id into r from public.activity_schedule_rules where activity_id = a;

  select count(*) into n from public.events where id = any (ids) and status = 'published' and is_platform_event and title = 'Bressay Under 5s';
  if n <> 7 then raise exception 'Expected 7 published source events, found %: someone has changed them; stop and re-preview', n; end if;

  -- The proof: sessions computed from the rule/exception == the events, exactly (set difference both ways is empty).
  select count(*) into diffs from (
    (select starts_at, ends_at from public.activity_sessions(timestamptz '2026-11-01', timestamptz '2027-01-15', a)
       where status in ('scheduled','moved','changed')
     except select starts_at, ends_at from public.events where id = any (ids))
    union all
    (select starts_at, ends_at from public.events where id = any (ids)
     except select starts_at, ends_at from public.activity_sessions(timestamptz '2026-11-01', timestamptz '2027-01-15', a)
       where status in ('scheduled','moved','changed'))) d;
  if diffs <> 0 then raise exception 'The activity does not reproduce the live events exactly (% differences); nothing was changed', diffs; end if;

  update public.regular_activities set status = 'published' where id = a;

  -- Old URLs: the one moved session (event 631c1981...) is rule session 6 Nov; the others are their own Fridays.
  insert into public.activity_legacy_events (event_id, activity_id, rule_id, occurrence_date)
  select e.id, a, r, case when e.id = '631c1981-5ddc-834d-9456-1e62a30ce691' then date '2026-11-06' else (e.starts_at at time zone 'Europe/London')::date end
    from public.events e where e.id = any (ids);

  update public.events set status = 'archived' where id = any (ids) and status = 'published';
end $$;
commit;

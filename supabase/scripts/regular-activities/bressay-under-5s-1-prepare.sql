-- Bressay Under 5s -> Regular Activity, STEP 1: prepare a DRAFT. Needs the Regular Activities migration. Run only when told to.
-- Creates ONE platform-owned DRAFT activity, ONE weekly rule (Fri 10:30-12:30) and ONE exception (the session that was moved to Sat 7 Nov
-- 10:00). A draft is invisible to the public, so nothing live changes: no event row is read for writing, edited, hidden or archived, and
-- no URL changes. Text is COPIED from the live event, not retyped. Review it as staff, then run step 2.
begin;
do $$
declare
  src public.events;
  a uuid;
  r uuid;
begin
  select * into src from public.events
   where id = '28a12d8c-c8be-7398-884a-c0f56842a890' and title = 'Bressay Under 5s' and is_platform_event;
  if not found then raise exception 'The source event is missing or has changed; stop and re-preview'; end if;
  if exists (select 1 from public.regular_activities where slug = 'bressay-under-5s') then raise exception 'Already prepared'; end if;

  insert into public.regular_activities
    (title, description, category, audience, venue, locality, lat, lng, cover_url, price_text, booking_mode, status, active_from, active_until, is_platform_activity)
  values
    (src.title, src.description, 'kids_family', 'Babies and under 5s', src.venue, src.locality, src.lat, src.lng, src.cover_url, src.price_text,
     'drop_in', 'draft', date '2026-11-06', date '2026-12-18', true)
  returning id into a;

  insert into public.activity_schedule_rules (activity_id, day_of_week, start_time, end_time, anchor_date)
  values (a, 5, time '10:30', time '12:30', date '2026-11-06') returning id into r;

  -- The Friday 6 Nov session was moved to Saturday 7 Nov at 10:00 (Roddy, 6 Nov). Same end time as the event row.
  insert into public.activity_exceptions (activity_id, rule_id, occurrence_date, kind, new_starts_at, new_ends_at, note)
  values (a, r, date '2026-11-06', 'changed', timestamptz '2026-11-07 10:00:00+00', timestamptz '2026-11-07 12:30:00+00', 'Moved to Saturday this week');
end $$;
commit;

-- Reverses 20261230010000: member submissions. Event rows are untouched (a community event simply becomes an ordinary platform event with its columns dropped).
begin;
create or replace function public.tg_events_occurrence_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;     -- server path and the definer sync, as the attribution guard does
  if tg_op = 'INSERT' then
    new.is_dated_run := false;
    return new;
  end if;
  new.is_dated_run := old.is_dated_run;
  if (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at)
     and public.event_has_occurrences(old.id) then
    raise exception 'This event has dated occurrences - change the dates there, not on the event itself' using errcode = 'P0001', hint = 'edit_occurrences';
  end if;
  return new;
end $$;
drop function if exists public.admin_list_event_submissions(text, int), public.admin_event_submission_counts(), public.admin_review_event_submission(uuid, text, text),
  public.withdraw_event_submission(uuid), public.submit_event_submission(jsonb), public.event_validate_occurrences(jsonb, timestamptz), public.event_clean_field(text, jsonb, uuid),
  public.event_submission_ts(jsonb), public.event_submissions_open();
alter table public.events drop constraint if exists events_community_needs_organiser, drop constraint if exists events_source_check, drop constraint if exists events_submission_id_fkey;
alter table public.events drop column if exists source, drop column if exists submission_id;
drop table if exists public.event_submissions;
drop function if exists public.tg_event_submissions_touch(), public.event_submission_text_problem(text, boolean), public.event_category_label(text);
commit;

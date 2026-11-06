-- Reverses 20261230000000: event occurrences. Every events row survives; the parent times already carry the synced values. Occurrence rows are dropped.
begin;
drop trigger if exists tg_event_ticket_types_run_guard on public.event_ticket_types;
drop trigger if exists ab_events_occurrence_guard on public.events;
drop trigger if exists tg_event_occurrences_sync on public.event_occurrences;
drop table if exists public.event_occurrences;
drop function if exists public.tg_event_ticket_types_run_guard(), public.tg_events_occurrence_guard(), public.tg_event_occurrences_guard(), public.tg_event_occurrences_sync(),
  public.event_has_occurrences(uuid), public.event_has_ticketing(uuid);
drop index if exists public.idx_events_starts_at;
alter table public.events drop constraint if exists events_organiser_name_check;
alter table public.events drop column if exists organiser_name, drop column if exists is_dated_run;
commit;

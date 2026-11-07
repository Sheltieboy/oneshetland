drop trigger if exists events_status_audit on public.events;
drop function if exists public.tg_events_status_audit();
-- Existing event_change_log rows are kept.

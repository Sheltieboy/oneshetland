-- Audit trail for whole-event status changes made DIRECTLY on public.events (the staff "Community events" screen
-- cancels / restores / archives with a plain UPDATE, which wrote nothing to event_change_log).
-- A deferred constraint trigger runs at commit and, only when this transaction wrote no log row for the event itself
-- (the contributor RPCs already log their own), records one 'staff_event_status' entry. Community events only.
-- Add-only: no table, column or existing function changes; the trigger never blocks or alters the update.

create or replace function public.tg_events_status_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.source = 'community_submission' and new.status is distinct from old.status then
    if not exists (select 1 from public.event_change_log l where l.event_id = new.id and l.created_at >= transaction_timestamp()) then
      insert into public.event_change_log (event_id, occurrence_id, actor_id, actor_kind, action, detail)
      values (new.id, null, auth.uid(), 'staff', 'staff_event_status',
              jsonb_build_object('from', old.status, 'to', new.status, 'hidden', new.is_hidden));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tg_events_status_audit() from public, anon, authenticated;

drop trigger if exists events_status_audit on public.events;
create constraint trigger events_status_audit after update of status on public.events
  deferrable initially deferred for each row execute function public.tg_events_status_audit();

-- ============================================================================
-- Analytics: authoritative stamping trigger
--
-- Makes analytics_event_defs the single source of truth for is_conversion +
-- category on EVERY insert path — the log_events() RPC, and direct service-role
-- inserts from edge functions. Clients/servers never decide conversion status.
-- ============================================================================

create or replace function public.tg_analytics_stamp()
returns trigger
language plpgsql
as $$
declare d record;
begin
  select is_conversion, category into d
    from public.analytics_event_defs
   where event_name = new.event_name;

  new.is_conversion := coalesce(d.is_conversion, false);  -- unknown events => not a conversion
  new.category      := d.category;                        -- null if unknown
  if new.received_at is null then new.received_at := now(); end if;
  return new;
end
$$;

drop trigger if exists analytics_stamp on public.analytics_events;
create trigger analytics_stamp
  before insert on public.analytics_events
  for each row execute function public.tg_analytics_stamp();

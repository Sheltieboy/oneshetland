-- Realtime: let a ticket holder's screen update the instant their ticket is
-- scanned (status → 'used'). Adds event_tickets to the realtime publication and
-- sets REPLICA IDENTITY FULL so the holder_id filter (a non-PK column) can be
-- evaluated on UPDATE events.

alter table public.event_tickets replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'event_tickets'
  ) then
    alter publication supabase_realtime add table public.event_tickets;
  end if;
end $$;

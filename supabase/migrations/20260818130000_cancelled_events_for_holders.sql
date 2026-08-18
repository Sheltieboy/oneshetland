-- ============================================================================
-- A ticket holder can always read the event they hold a ticket for.
--
-- Cancelling an event hides it (events_public_read requires NOT is_hidden), so
-- somebody holding a paid, valid ticket lost all trace of it: "My tickets"
-- embeds the event, the embed returned null under RLS, and the ticket rendered
-- with no title, date or venue. From the customer's side it had simply vanished
-- — while their money had not.
--
-- Hiding a cancelled event from the PUBLIC listings is right. Hiding it from the
-- person who paid to attend is not.
-- ============================================================================

create policy events_ticket_holder_read on public.events
  for select
  using (
    exists (
      select 1 from public.event_tickets t
      where t.event_id = events.id
        and t.holder_id = auth.uid()
        and t.status in ('valid', 'used')
    )
  );

comment on policy events_ticket_holder_read on public.events is
  'Somebody holding a valid or used ticket can always read that event, including once it is cancelled or hidden — otherwise their ticket appears to vanish.';

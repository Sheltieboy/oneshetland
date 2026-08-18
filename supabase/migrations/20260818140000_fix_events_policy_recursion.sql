-- ============================================================================
-- Fix the recursion my own policy introduced.
--
-- 20260818130000 added events_ticket_holder_read, which reads event_tickets.
-- But event_tickets_owner_read reads events. Postgres therefore has to evaluate
-- each policy to evaluate the other:
--
--   read events → check event_tickets → check its policy → read events → …
--
-- which it correctly refuses: "infinite recursion detected in policy for
-- relation events" (42P17). And because it fires on ANY read of events, it broke
-- event creation, the What's On listing and the organiser screens — not just the
-- ticket-holder case it was meant to help.
--
-- The fix is to ask the question through a SECURITY DEFINER function, which runs
-- as its owner and so does not trigger RLS on event_tickets. The cycle is cut
-- while the answer stays the same. (Same shape as the trade-brief recursion fix
-- in 20260809160000 — worth remembering that a policy on A which reads B is only
-- safe while nothing in B's policies reads A.)
-- ============================================================================

drop policy if exists events_ticket_holder_read on public.events;

create or replace function public.holds_ticket_for(p_event_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.event_tickets t
    where t.event_id = p_event_id
      and t.holder_id = auth.uid()
      and t.status in ('valid', 'used')
  )
$$;

comment on function public.holds_ticket_for(uuid) is
  'Does the caller hold a live ticket for this event? SECURITY DEFINER so it can be used inside an events policy without recursing through event_tickets policies.';

revoke all on function public.holds_ticket_for(uuid) from public;
grant execute on function public.holds_ticket_for(uuid) to authenticated;

create policy events_ticket_holder_read on public.events
  for select
  using (public.holds_ticket_for(id));

comment on policy events_ticket_holder_read on public.events is
  'Somebody holding a valid or used ticket can always read that event, including once it is cancelled or hidden — otherwise their ticket appears to vanish. Goes through holds_ticket_for() to avoid recursing into event_tickets policies.';

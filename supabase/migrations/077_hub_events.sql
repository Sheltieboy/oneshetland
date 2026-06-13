-- 077_hub_events.sql
-- Let community Hubs be a third kind of event organiser (alongside a person and
-- a business). A hub admin creates an event and picks its reach:
--   members  → visible only to hub members (+ a members notice)
--   hub      → public on the hub's own page, NOT on the islands-wide calendar
--   islands  → also on the main What's On calendar
-- Calendar moderation: verified hubs auto-publish to the calendar; unverified
-- hubs' islands-wide events wait for a one-tap platform-admin approval.
-- Tickets route to the hub's existing Stripe Connect account (edge function).

-- ── 1. Columns ────────────────────────────────────────────────────────────────

alter table public.events
  add column if not exists organiser_hub_id    uuid references public.hubs(id) on delete set null,
  add column if not exists hub_visibility      text check (hub_visibility in ('members','hub','islands')),
  add column if not exists calendar_approved    boolean not null default false,
  add column if not exists calendar_approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists calendar_approved_at timestamptz;

create index if not exists idx_events_hub on public.events(organiser_hub_id);

alter table public.notices
  add column if not exists event_id uuid references public.events(id) on delete cascade;

-- ── 2. Trigger: keep is_hidden in sync AND resolve calendar approval ──────────
-- Extends tg_events_sync_hidden (051). calendar_approved is never freely set by
-- a hub admin: verified hubs are auto-approved; otherwise it only becomes true
-- once a platform admin stamps calendar_approved_by.

create or replace function tg_events_sync_hidden()
returns trigger language plpgsql as $$
declare
  v_verified boolean := false;
begin
  new.is_hidden  := (new.status <> 'published');
  new.updated_at := now();

  if new.organiser_hub_id is not null and new.hub_visibility = 'islands' then
    select is_verified into v_verified from public.hubs where id = new.organiser_hub_id;
    if coalesce(v_verified, false) then
      new.calendar_approved := true;
    else
      -- Ignore any client attempt to self-stamp the approver; only a platform
      -- admin/moderator may change it.
      if new.calendar_approved_by is distinct from old.calendar_approved_by
         and not exists (
           select 1 from public.profiles
           where id = auth.uid() and role in ('admin','moderator')
         )
      then
        new.calendar_approved_by := old.calendar_approved_by;
      end if;
      new.calendar_approved := (new.calendar_approved_by is not null);
    end if;
  else
    -- members / hub tiers (and non-hub events) never appear on the calendar via
    -- this flag; non-hub events are gated by is_hidden alone.
    new.calendar_approved := false;
  end if;

  if new.calendar_approved and (tg_op = 'INSERT' or not coalesce(old.calendar_approved, false)) then
    new.calendar_approved_at := now();
  end if;

  return new;
end;
$$;

-- ── 3. RLS — events (widen 051 policies to hub admins/members) ────────────────

drop policy if exists "events_public_read" on public.events;
create policy "events_public_read" on public.events for select
  using (
    (not is_hidden and (organiser_hub_id is null or hub_visibility in ('hub','islands')))
    or (organiser_hub_id is not null and public.is_hub_member(organiser_hub_id, auth.uid()))
    or organiser_user_id = auth.uid()
    or exists (select 1 from public.local_businesses lb where lb.id = organiser_business_id and lb.owner_id = auth.uid())
    or (organiser_hub_id is not null and public.is_hub_admin(organiser_hub_id, auth.uid()))
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

drop policy if exists "events_owner_write" on public.events;
create policy "events_owner_write" on public.events for all
  using (
    organiser_user_id = auth.uid()
    or exists (select 1 from public.local_businesses lb where lb.id = organiser_business_id and lb.owner_id = auth.uid())
    or (organiser_hub_id is not null and public.is_hub_admin(organiser_hub_id, auth.uid()))
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator'))
  );

-- ── 4. RLS — ticketing tables (add the hub-admin branch) ──────────────────────

drop policy if exists "ticket_types_owner_all" on public.event_ticket_types;
create policy "ticket_types_owner_all" on public.event_ticket_types for all
  using (
    exists (
      select 1 from public.events e
      join public.local_businesses lb on lb.id = e.organiser_business_id
      where e.id = event_id and lb.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.organiser_hub_id is not null
        and public.is_hub_admin(e.organiser_hub_id, auth.uid())
    )
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "ticket_orders_buyer_read" on public.event_ticket_orders;
create policy "ticket_orders_buyer_read" on public.event_ticket_orders for select
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from public.events e
      join public.local_businesses lb on lb.id = e.organiser_business_id
      where e.id = event_id and lb.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.organiser_hub_id is not null
        and public.is_hub_admin(e.organiser_hub_id, auth.uid())
    )
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "event_tickets_owner_read" on public.event_tickets;
create policy "event_tickets_owner_read" on public.event_tickets for select
  using (
    exists (
      select 1 from public.events e
      join public.local_businesses lb on lb.id = e.organiser_business_id
      where e.id = event_id and lb.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.organiser_hub_id is not null
        and public.is_hub_admin(e.organiser_hub_id, auth.uid())
    )
  );

drop policy if exists "event_updates_owner_write" on public.event_updates;
create policy "event_updates_owner_write" on public.event_updates for insert
  with check (
    author_id = auth.uid()
    and (
      exists (
        select 1 from public.events e
        join public.local_businesses lb on lb.id = e.organiser_business_id
        where e.id = event_id and lb.owner_id = auth.uid()
      )
      or exists (
        select 1 from public.events e
        where e.id = event_id and e.organiser_hub_id is not null
          and public.is_hub_admin(e.organiser_hub_id, auth.uid())
      )
    )
  );

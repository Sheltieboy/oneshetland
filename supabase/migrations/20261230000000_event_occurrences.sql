-- Events & Activities, Phase 1 (part 1 of 2): event occurrences.
--
-- An event keeps ONE parent row (events.starts_at / ends_at stay exactly what installed apps and Social Studio read). A repeating or multi-date event
-- ("a dated run": a play on four nights, a market on three Saturdays) gets child rows in event_occurrences. A trigger keeps the PARENT in step:
--   parent starts_at = earliest NON-cancelled occurrence start (all cancelled: earliest of all)
--   parent ends_at   = latest   NON-cancelled occurrence end   (coalesce(ends_at, starts_at); all cancelled: latest of all)
--   parent is_dated_run = the event has 2+ occurrence rows (true => a discrete run; readers must NEVER treat it as continuously running between dates)
-- Events with no occurrence rows are completely untouched.
--
-- TICKETING SAFETY: checkout binds tickets to the EVENT, not to one performance. Every sale funnels through reserve_ticket_basket(), which looks at ticket
-- TYPES (never at has_tickets, which is also true for external-link events, nor at ticket_url or starts_at). So:
--   * an event with 2+ non-cancelled occurrences cannot get a NEW or REACTIVATED ticket type (trigger here), and reserve_ticket_basket refuses it with
--     MULTI_PERFORMANCE (next migration);
--   * an event that is already sold (an ACTIVE ticket type, or any ticket or order) cannot gain a second occurrence - existing tickets would become ambiguous.
--   * INACTIVE ticket types with no tickets or orders do NOT block adding occurrences; they simply cannot be reactivated while the event is a run.
--   * has_tickets and ticket_url are NOT gated: an external-link event may be a dated run.
-- Enforced in the database, serialised on the parent row, so two sessions racing cannot slip past each other.
--
-- Existing guards on events (read before writing this):
--   aa_events_attribution_guard  returns early when current_user is not authenticated/anon ("server path"). The sync function below is SECURITY DEFINER, so its
--                                UPDATE of the parent runs as the function owner and passes that early return for owner AND staff alike - nothing the caller
--                                can influence. The same function only ever sets starts_at, ends_at and is_dated_run.
--   commercial_terms_guard       keys on auth.uid() (still the caller). A business that has not accepted the selling terms therefore cannot change what it
--                                offers - including through occurrences - exactly as it cannot edit the parent. Staff are exempt. (Documented limitation.)
--   tg_events_sync               recomputes is_hidden / updated_at on every update; unaffected.
-- ab_events_occurrence_guard (new, BEFORE trigger) stops a client forging is_dated_run, and stops a client editing the parent's times directly while
-- occurrence rows exist (the occurrences are then the source of truth). service_role / the definer path are exempt.

begin;

-- ── columns on events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.events add column if not exists is_dated_run boolean not null default false;
alter table public.events add column if not exists organiser_name text;
alter table public.events drop constraint if exists events_organiser_name_check;
alter table public.events add constraint events_organiser_name_check
  check (organiser_name is null or (organiser_name = btrim(organiser_name) and char_length(organiser_name) between 1 and 120));
create index if not exists idx_events_starts_at on public.events (starts_at);

-- ── table ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.event_occurrences (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  status     text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'changed')),
  venue      text check (venue is null or char_length(venue) <= 200),
  locality   text check (locality is null or char_length(locality) <= 100),
  note       text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_occurrences_event_start_key unique (event_id, starts_at),
  constraint event_occurrences_ends_after_starts check (ends_at is null or ends_at > starts_at)
);
create index idx_event_occurrences_event_start on public.event_occurrences (event_id, starts_at);
create index idx_event_occurrences_starts on public.event_occurrences (starts_at);

alter table public.event_occurrences enable row level security;
-- Supabase's default privileges hand every new table to anon/authenticated; take it all back, then grant what is meant.
revoke all on public.event_occurrences from public, anon, authenticated;
grant select on public.event_occurrences to anon, authenticated;
grant insert, update, delete on public.event_occurrences to authenticated;
grant all on public.event_occurrences to service_role;

-- Read: exactly as visible as the parent. The sub-select runs under the CALLER's row security, so it is the events policies (hidden, hub visibility,
-- members, owners, staff, ticket holders) that decide - there is no second copy of that rule to drift.
create policy event_occurrences_read on public.event_occurrences for select
  using (exists (select 1 from public.events e where e.id = event_occurrences.event_id));
-- Write: whoever controls the event (business owner, hub admin/owner) or platform staff. controls_event() is false for platform events, so those are staff-only.
create policy event_occurrences_insert on public.event_occurrences for insert to authenticated
  with check (public.attribution_staff() or public.controls_event(event_id));
create policy event_occurrences_update on public.event_occurrences for update to authenticated
  using (public.attribution_staff() or public.controls_event(event_id))
  with check (public.attribution_staff() or public.controls_event(event_id));
create policy event_occurrences_delete on public.event_occurrences for delete to authenticated
  using (public.attribution_staff() or public.controls_event(event_id));

-- ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Is this event sold, or on sale, through OneShetland checkout? An ACTIVE ticket type, or any ticket or order ever. (Not has_tickets / ticket_url.)
create or replace function public.event_has_ticketing(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.event_ticket_types t where t.event_id = p_event and t.is_active)
      or exists (select 1 from public.event_tickets t where t.event_id = p_event)
      or exists (select 1 from public.event_ticket_orders o where o.event_id = p_event);
$$;

create or replace function public.event_has_occurrences(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.event_occurrences o where o.event_id = p_event);    -- definer: the answer must not depend on what the caller may see
$$;

-- ── sync parent from occurrences ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.tg_event_occurrences_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_n int; v_live int; v_start timestamptz; v_end timestamptz; v_dated boolean;
begin
  v_ids := array(select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.event_id end, case when tg_op <> 'DELETE' then new.event_id end]) x where x is not null);
  foreach v_id in array v_ids loop
    -- serialise with every other writer of this event (occurrences, ticket gates); a parent already deleted (cascade) simply is not found
    perform 1 from public.events where id = v_id for update;
    if not found then continue; end if;
    select count(*), count(*) filter (where status <> 'cancelled') into v_n, v_live from public.event_occurrences where event_id = v_id;
    v_dated := v_n >= 2;
    if v_n = 0 then
      update public.events set is_dated_run = false where id = v_id and is_dated_run;   -- the last occurrence is gone: parent keeps its last times
      continue;
    end if;
    select min(starts_at), max(coalesce(ends_at, starts_at)) into v_start, v_end
      from public.event_occurrences where event_id = v_id and (v_live = 0 or status <> 'cancelled');
    update public.events e set starts_at = v_start, ends_at = v_end, is_dated_run = v_dated
     where e.id = v_id and (e.starts_at, e.ends_at, e.is_dated_run) is distinct from (v_start, v_end, v_dated);
  end loop;
  return null;
end $$;

create trigger tg_event_occurrences_sync after insert or update or delete on public.event_occurrences
  for each row execute function public.tg_event_occurrences_sync();

-- ── occurrence row guard: immutable parent, updated_at, ticketing safety ────────────────────────────────────────────────────────────────────────
create or replace function public.tg_event_occurrences_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows int; v_live int;
begin
  if tg_op = 'UPDATE' and new.event_id is distinct from old.event_id then
    raise exception 'An occurrence cannot be moved to another event' using errcode = '42501';
  end if;
  new.updated_at := now();
  -- Lock the parent first: this is the serialisation point shared with has_tickets / ticket-type writes.
  perform 1 from public.events where id = new.event_id for update;
  if not found then raise exception 'That event does not exist' using errcode = '23503'; end if;
  if public.event_has_ticketing(new.event_id) then
    select count(*) filter (where id is distinct from new.id), count(*) filter (where id is distinct from new.id and status <> 'cancelled')
      into v_rows, v_live from public.event_occurrences where event_id = new.event_id;
    if (tg_op = 'INSERT' and v_rows + 1 >= 2) or (new.status <> 'cancelled' and v_live + 1 >= 2) then
      raise exception 'This event sells tickets through OneShetland, so it cannot have more than one date. Remove the tickets, or create a separate event for each date.'
        using errcode = 'P0001', hint = 'ticketed_event_single_date';
    end if;
  end if;
  return new;
end $$;
create trigger tg_event_occurrences_guard before insert or update on public.event_occurrences
  for each row execute function public.tg_event_occurrences_guard();

-- ── ticketing gate: new or reactivated ticket types ────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.tg_event_ticket_types_run_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not (new.is_active and (not old.is_active or new.event_id is distinct from old.event_id)) then return new; end if;
  if not new.is_active then return new; end if;
  perform 1 from public.events where id = new.event_id for share;    -- conflicts with the occurrence guard's FOR UPDATE
  if (select count(*) from public.event_occurrences o where o.event_id = new.event_id and o.status <> 'cancelled') >= 2 then
    raise exception 'This event has more than one date, so it cannot sell tickets through OneShetland. Use a ticket link, or create a separate event for each date.'
      using errcode = 'P0001', hint = 'run_cannot_sell_tickets';
  end if;
  return new;
end $$;
create trigger tg_event_ticket_types_run_guard before insert or update of is_active, event_id on public.event_ticket_types
  for each row execute function public.tg_event_ticket_types_run_guard();

-- ── events guard: no forged is_dated_run, no direct time edits while occurrences exist ─────────────────────────────────────────────────────────
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
create trigger ab_events_occurrence_guard before insert or update on public.events
  for each row execute function public.tg_events_occurrence_guard();

-- ── privileges: none of these are for clients ──────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.event_has_ticketing(uuid), public.event_has_occurrences(uuid), public.tg_event_occurrences_sync(), public.tg_event_occurrences_guard(),
  public.tg_event_ticket_types_run_guard(), public.tg_events_occurrence_guard() from public, anon, authenticated;
grant execute on function public.event_has_ticketing(uuid) to service_role;
-- called by the invoker-security events guard (it must see current_user), so the signed-in role needs it; it answers one boolean for one id
grant execute on function public.event_has_occurrences(uuid) to authenticated, service_role;

commit;

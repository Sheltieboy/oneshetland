-- Event and notice attribution: a row belongs to ONE legitimate owner, and only that owner's current controllers may write it.
--
-- WHAT WAS WRONG
--
-- events_owner_write (FOR ALL, no WITH CHECK) let `organiser_user_id = auth.uid()` authorise a write on its own, so any signed-in user
-- could publish an event attributed to ANY hub (a verified hub's event was auto-approved onto the islands calendar), publish a
-- standalone event, detach or re-point an event after publication, and — as the owner of any business — attribute an event to
-- a hub as well, which moves the ticket payout to that hub (hub precedence in _event_payout_resolve) while the attacker keeps
-- ticket-type and refund rights through the business. The only thing stopping attribution to another BUSINESS was commercial_terms_guard,
-- a selling-terms check that happens to refuse a business the caller does not own. A former owner kept edit, delete, scan and
-- notify rights through organiser_user_id for ever.
-- notices had the same shape: `publisher_user_id = auth.uid()` authorised ANY publisher_business_id / publisher_hub_id, and the
-- UPDATE policy (no WITH CHECK) let the author re-point a notice; is_pinned / broadcast_* / is_hidden were client-writable.
--
-- WHAT THIS DOES
--   · is_platform_event / is_platform_notice: the one explicit "OneShetland itself" owner. Existing entity-less events are grandfathered
--     as platform-managed legacy (content untouched).
--   · CHECK: exactly one of business / hub, or an explicit platform row — never both, never neither.
--   · BEFORE INSERT/UPDATE guards for DIRECT client writes (current_user = authenticated/anon): exactly one entity, caller controls it,
--     attribution and platform marker immutable, organiser_user_id / publisher_user_id server-stamped and never an authority,
--     notice privileged fields staff-only, notice event_id / campaign_id must belong to the same entity.
--   · Explicit per-command RLS policies with their own WITH CHECK, TO authenticated; anon loses DML on both tables.
--   · can_scan_event no longer honours organiser_user_id (and counts the hub's OWNER row, not only its membership row).
--   · events -> business / hub FKs RESTRICT (an entity that owns events cannot silently turn them into standalone public events);
--     notices -> business CASCADE (like hubs already do).
-- Refund authority is unchanged and already correct: can_refund_event_orders = platform admin, business owner, hub OWNER (not committee).

-- ── pre-flight: refuse to run on data the invariant cannot describe ───────────────────────────────
do $$
declare v_e int; v_n int;
begin
  select count(*) into v_e from public.events where organiser_business_id is not null and organiser_hub_id is not null;
  if v_e > 0 then raise exception 'events: % row(s) have BOTH a business and a hub; resolve them first', v_e; end if;
  select count(*) into v_n from public.notices
   where (publisher_business_id is not null and publisher_hub_id is not null)
      or (publisher_business_id is null and publisher_hub_id is null);
  if v_n > 0 then raise exception 'notices: % row(s) have both or neither of business/hub; resolve them first', v_n; end if;
end $$;

-- ── platform markers ─────────────────────────────────────────────────────────────────────────────
alter table public.events  add column if not exists is_platform_event  boolean not null default false;
alter table public.notices add column if not exists is_platform_notice boolean not null default false;

-- Grandfather every existing entity-less event as platform-managed legacy. The row's own triggers are switched off for this one
-- statement only so that nothing but the marker changes (tg_events_sync_hidden would otherwise touch updated_at).
alter table public.events disable trigger tg_events_sync;
alter table public.events disable trigger commercial_terms_guard;
update public.events set is_platform_event = true
 where organiser_business_id is null and organiser_hub_id is null and not is_platform_event;
alter table public.events enable trigger commercial_terms_guard;
alter table public.events enable trigger tg_events_sync;

alter table public.events add constraint events_attribution_exclusive check (
  (is_platform_event and organiser_business_id is null and organiser_hub_id is null)
  or (not is_platform_event and num_nonnulls(organiser_business_id, organiser_hub_id) = 1)
);
alter table public.notices add constraint notices_attribution_exclusive check (
  (is_platform_notice and publisher_business_id is null and publisher_hub_id is null)
  or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1)
);

-- ── entity deletion: content must never silently become standalone ───────────────────────────────
alter table public.events drop constraint events_organiser_business_id_fkey;
alter table public.events add constraint events_organiser_business_id_fkey
  foreign key (organiser_business_id) references public.local_businesses(id) on delete restrict;
alter table public.events drop constraint events_organiser_hub_id_fkey;
alter table public.events add constraint events_organiser_hub_id_fkey
  foreign key (organiser_hub_id) references public.hubs(id) on delete restrict;
alter table public.notices drop constraint notices_publisher_business_id_fkey;
alter table public.notices add constraint notices_publisher_business_id_fkey
  foreign key (publisher_business_id) references public.local_businesses(id) on delete cascade;

-- ── authority helpers (use the caller's own JWT identity; nothing here takes a user id from the client) ──
create or replace function public.attribution_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator'));
$$;

-- Does the CALLER currently control this business / hub? Owner of the business; owner or committee of the hub.
create or replace function public.controls_event_entity(p_business uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and (
    (p_business is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid()))
    or (p_hub is not null and (
          public.is_hub_admin(p_hub, auth.uid())
          or exists (select 1 from public.hubs h where h.id = p_hub and h.owner_id = auth.uid())))
  );
$$;

-- Does the CALLER currently control the entity that owns this event (never platform events; those are staff-only)?
create or replace function public.controls_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.events e
                  where e.id = p_event and not e.is_platform_event
                    and public.controls_event_entity(e.organiser_business_id, e.organiser_hub_id));
$$;

-- Link checks for notices: does this event / campaign belong to the SAME publisher? (definer: the answer must not depend on what the caller can see)
create or replace function public.notice_event_belongs(p_event uuid, p_business uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.events e where e.id = p_event
                  and ((p_hub is not null and e.organiser_hub_id = p_hub) or (p_business is not null and e.organiser_business_id = p_business)));
$$;
create or replace function public.notice_campaign_belongs(p_campaign uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_hub is not null and exists (select 1 from public.hub_campaigns c where c.id = p_campaign and c.hub_id = p_hub);
$$;

revoke all on function public.attribution_staff(), public.controls_event_entity(uuid, uuid), public.controls_event(uuid),
  public.notice_event_belongs(uuid, uuid, uuid), public.notice_campaign_belongs(uuid, uuid) from public;
grant execute on function public.attribution_staff(), public.controls_event_entity(uuid, uuid), public.controls_event(uuid),
  public.notice_event_belongs(uuid, uuid, uuid), public.notice_campaign_belongs(uuid, uuid) to authenticated, service_role;

-- ── guards (SECURITY INVOKER on purpose: current_user is the caller's role, so definer RPCs, the service role and migrations
--    are not mistaken for a client; the CHECK constraint still applies to them) ──────────────────────────
create or replace function public.tg_events_attribution_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;     -- server path
  if public.attribution_staff() then return new; end if;                        -- platform staff; the CHECK still holds

  if tg_op = 'INSERT' then
    if new.is_platform_event then
      raise exception 'Only OneShetland staff can create platform events' using errcode = '42501';
    end if;
    if num_nonnulls(new.organiser_business_id, new.organiser_hub_id) <> 1 then
      raise exception 'An event must belong to exactly one business or hub' using errcode = '42501';
    end if;
    if not public.controls_event_entity(new.organiser_business_id, new.organiser_hub_id) then
      raise exception 'You do not manage that business or hub' using errcode = '42501';
    end if;
    new.organiser_user_id := auth.uid();           -- audit metadata only; never read as authority
    return new;
  end if;

  -- UPDATE
  if new.organiser_business_id is distinct from old.organiser_business_id
     or new.organiser_hub_id is distinct from old.organiser_hub_id
     or new.is_platform_event is distinct from old.is_platform_event then
    raise exception 'An event''s owner cannot be changed' using errcode = '42501';
  end if;
  if old.is_platform_event or not public.controls_event_entity(old.organiser_business_id, old.organiser_hub_id) then
    raise exception 'You no longer manage this event' using errcode = '42501';
  end if;
  new.organiser_user_id := old.organiser_user_id;
  return new;
end $$;

create or replace function public.tg_notices_attribution_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if public.attribution_staff() then return new; end if;

  if tg_op = 'INSERT' then
    if new.is_platform_notice then
      raise exception 'Only OneShetland staff can publish platform notices' using errcode = '42501';
    end if;
    if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 1 then
      raise exception 'A notice must belong to exactly one business or hub' using errcode = '42501';
    end if;
    if not public.controls_event_entity(new.publisher_business_id, new.publisher_hub_id) then
      raise exception 'You do not manage that business or hub' using errcode = '42501';
    end if;
    if new.is_pinned or new.is_hidden or new.broadcast_at is not null or new.broadcast_by is not null then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.publisher_user_id := auth.uid();
  else
    if new.publisher_business_id is distinct from old.publisher_business_id
       or new.publisher_hub_id is distinct from old.publisher_hub_id
       or new.is_platform_notice is distinct from old.is_platform_notice then
      raise exception 'A notice''s publisher cannot be changed' using errcode = '42501';
    end if;
    if old.is_platform_notice or not public.controls_event_entity(old.publisher_business_id, old.publisher_hub_id) then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    end if;
    if new.is_pinned is distinct from old.is_pinned or new.is_hidden is distinct from old.is_hidden
       or new.broadcast_at is distinct from old.broadcast_at or new.broadcast_by is distinct from old.broadcast_by then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.publisher_user_id := old.publisher_user_id;
  end if;

  -- A notice may only point at its OWN publisher's event / campaign.
  if new.event_id is not null and (tg_op = 'INSERT' or new.event_id is distinct from old.event_id) then
    v_ok := public.notice_event_belongs(new.event_id, new.publisher_business_id, new.publisher_hub_id);
    if not coalesce(v_ok, false) then
      raise exception 'A notice can only link to its own publisher''s event' using errcode = '42501';
    end if;
  end if;
  if new.campaign_id is not null and (tg_op = 'INSERT' or new.campaign_id is distinct from old.campaign_id) then
    v_ok := public.notice_campaign_belongs(new.campaign_id, new.publisher_hub_id);
    if not coalesce(v_ok, false) then
      raise exception 'A notice can only link to its own hub''s campaign' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- zz/aa prefixes fix the order: the attribution guard runs BEFORE commercial_terms_guard and tg_events_sync.
create trigger aa_events_attribution_guard before insert or update on public.events
  for each row execute function public.tg_events_attribution_guard();
create trigger aa_notices_attribution_guard before insert or update on public.notices
  for each row execute function public.tg_notices_attribution_guard();

-- ── RLS: explicit per-command policies, each with its own WITH CHECK; writes TO authenticated only ─────
drop policy if exists events_owner_write on public.events;
drop policy if exists events_public_read on public.events;

create policy events_public_read on public.events for select using (
  ((not is_hidden) and (organiser_hub_id is null or hub_visibility = any (array['hub', 'islands'])))
  or (organiser_hub_id is not null and is_hub_member(organiser_hub_id, auth.uid()))
  or is_business_owner(organiser_business_id, auth.uid())
  or (organiser_hub_id is not null and is_hub_admin(organiser_hub_id, auth.uid()))
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array['admin', 'moderator']))
);
create policy events_insert on public.events for insert to authenticated with check (
  public.attribution_staff()
  or (not is_platform_event and num_nonnulls(organiser_business_id, organiser_hub_id) = 1
      and public.controls_event_entity(organiser_business_id, organiser_hub_id))
);
create policy events_update on public.events for update to authenticated
  using (public.attribution_staff() or (not is_platform_event and public.controls_event_entity(organiser_business_id, organiser_hub_id)))
  with check (public.attribution_staff()
      or (not is_platform_event and num_nonnulls(organiser_business_id, organiser_hub_id) = 1
          and public.controls_event_entity(organiser_business_id, organiser_hub_id)));
create policy events_delete on public.events for delete to authenticated
  using (public.attribution_staff() or (not is_platform_event and public.controls_event_entity(organiser_business_id, organiser_hub_id)));

-- Ticket types follow the event's CURRENT entity (platform events: admin only, as before).
drop policy if exists ticket_types_owner_all on public.event_ticket_types;
create policy ticket_types_owner_read on public.event_ticket_types for select to authenticated using (
  public.controls_event(event_id) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy ticket_types_insert on public.event_ticket_types for insert to authenticated with check (
  public.controls_event(event_id) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy ticket_types_update on public.event_ticket_types for update to authenticated
  using (public.controls_event(event_id) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (public.controls_event(event_id) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy ticket_types_delete on public.event_ticket_types for delete to authenticated using (
  public.controls_event(event_id) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "notices insert" on public.notices;
drop policy if exists "notices update" on public.notices;
drop policy if exists "notices delete" on public.notices;
create policy "notices insert" on public.notices for insert to authenticated with check (
  auth.uid() is not null
  and (severity <> 'urgent'
       or exists (select 1 from public.local_businesses b where b.id = publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
       or public.attribution_staff())
  and (public.attribution_staff()
       or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
           and public.controls_event_entity(publisher_business_id, publisher_hub_id)))
);
create policy "notices update" on public.notices for update to authenticated
  using (public.attribution_staff() or (not is_platform_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)))
  with check (
    (severity <> 'urgent'
       or exists (select 1 from public.local_businesses b where b.id = publisher_business_id and b.owner_id = auth.uid() and b.can_publish_urgent = true)
       or public.attribution_staff())
    and (public.attribution_staff()
         or (not is_platform_notice and num_nonnulls(publisher_business_id, publisher_hub_id) = 1
             and public.controls_event_entity(publisher_business_id, publisher_hub_id))));
create policy "notices delete" on public.notices for delete to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  or (not is_platform_notice and public.controls_event_entity(publisher_business_id, publisher_hub_id)));

-- anon never writes either table (RLS already refused it; the grant goes too).
revoke insert, update, delete on public.events, public.notices from anon;

-- ── scanning / order viewing / event-update notifications: current entity authority only ─────────────
-- Same signature and grants as before (service-side only). organiser_user_id is gone; the hub OWNER counts via hubs.owner_id too.
create or replace function public.can_scan_event(p_event_id uuid, p_user_id uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  v_event public.events%rowtype;
begin
  if p_event_id is null or p_user_id is null then
    return false;
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    return false;
  end if;

  -- Platform admin. Matches is_admin()'s rule, including is_platform_owner.
  if exists (
    select 1 from public.profiles
     where id = p_user_id
       and (role = 'admin' or is_platform_owner is true)
  ) then
    return true;
  end if;

  -- Platform events are staff-only; the entity branches below cannot match them.
  -- The owner of the organising business.
  if v_event.organiser_business_id is not null and exists (
    select 1 from public.local_businesses
     where id = v_event.organiser_business_id
       and owner_id is not null
       and owner_id = p_user_id
  ) then
    return true;
  end if;

  -- The owner, or an active committee member, of the organising hub. Ordinary hub members are NOT scanners.
  if v_event.organiser_hub_id is not null and (
    exists (
      select 1 from public.hub_members
       where hub_id  = v_event.organiser_hub_id
         and user_id = p_user_id
         and status  = 'active'
         and role in ('owner', 'committee'))
    or exists (
      select 1 from public.hubs
       where id = v_event.organiser_hub_id and owner_id is not null and owner_id = p_user_id)
  ) then
    return true;
  end if;

  return false;
end;
$$;

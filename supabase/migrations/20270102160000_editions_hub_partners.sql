-- OneShetland Editions 1.1, part 1: Hubs as first-class partners.
--
-- Any Edition (whoever runs it) may invite an existing Hub exactly as it invites a business: a two-sided consent link that only the Hub's own owner or active committee can
-- answer, withdraw at any time, with the Hub choosing which of ITS OWN public events and activities to showcase. Nothing about a Hub is copied: the public views read the Hub's
-- live row through its public column whitelist (never members, owner, payout or contact fields), so a rename, a logo change or a withdrawal shows at once.
--
-- Additive and isolated: one nullable column on edition_links, one new table, new/replaced Editions functions, two new public views. No Hub, business, event, activity or payment
-- table or policy is altered, and nothing here touches money (hub links are free: edition_participation_ok already treats every non-business link as eligible).

-- ── schema ──────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.edition_links add column if not exists hub_id uuid references public.hubs (id) on delete cascade;
alter table public.edition_links drop constraint if exists edition_links_kind_check;
alter table public.edition_links add constraint edition_links_kind_check check (kind in ('business', 'event', 'activity', 'hub'));
alter table public.edition_links drop constraint if exists edition_links_one_subject;
alter table public.edition_links add constraint edition_links_one_subject check (
  (kind = 'business' and business_id is not null and event_id is null and activity_id is null and hub_id is null) or
  (kind = 'event'    and event_id    is not null and business_id is null and activity_id is null and hub_id is null) or
  (kind = 'activity' and activity_id is not null and business_id is null and event_id is null and hub_id is null) or
  (kind = 'hub'      and hub_id      is not null and business_id is null and event_id is null and activity_id is null));
create unique index if not exists edition_links_active_hub on public.edition_links (edition_id, hub_id) where hub_id is not null and state in ('pending', 'approved');
create index if not exists edition_links_hub_idx on public.edition_links (hub_id) where hub_id is not null;
grant select (hub_id) on public.edition_links to anon;   -- the public views join on it; authenticated already has table-level select

-- A Hub's own choice of which of its events and activities to show under its Hub card in an Edition (separate from, and in addition to, any event or activity the organiser
-- links individually). Written only by edition_set_hub_items.
create table if not exists public.edition_link_hub_items (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.edition_links (id) on delete cascade,
  kind        text not null check (kind in ('event', 'activity')),
  event_id    uuid references public.events (id) on delete cascade,
  activity_id uuid references public.regular_activities (id) on delete cascade,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint edition_link_hub_items_one check ((kind = 'event' and event_id is not null and activity_id is null) or (kind = 'activity' and activity_id is not null and event_id is null))
);
create unique index if not exists edition_link_hub_items_event on public.edition_link_hub_items (link_id, event_id) where event_id is not null;
create unique index if not exists edition_link_hub_items_activity on public.edition_link_hub_items (link_id, activity_id) where activity_id is not null;
alter table public.edition_link_hub_items enable row level security;
revoke all on public.edition_link_hub_items from public, anon, authenticated;

-- ── who answers for a Hub ───────────────────────────────────────────────────────────────────────────────────────────
-- The SAME authority the platform already uses for a Hub's events: the Hub's owner, or an ACTIVE committee/owner member, read live. Platform staff are not a consent route.
create or replace function public.edition_controls_hub(p_hub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_hub is not null and exists (select 1 from public.hubs h where h.id = p_hub
           and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
$$;

create or replace function public.edition_controls_subject(p_kind text, p_business uuid, p_event uuid, p_activity uuid, p_hub uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and case p_kind
    when 'business' then exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid())
    when 'event' then exists (select 1 from public.events e where e.id = p_event and not e.is_platform_event
                               and public.controls_event_entity(e.organiser_business_id, e.organiser_hub_id))
    when 'activity' then exists (select 1 from public.regular_activities a where a.id = p_activity and not a.is_platform_activity
                               and public.controls_event_entity(a.organiser_business_id, a.organiser_hub_id))
    when 'hub' then public.edition_controls_hub(p_hub)
    else false end
$$;
-- the original four-argument form keeps working for the three older kinds
create or replace function public.edition_controls_subject(p_kind text, p_business uuid, p_event uuid, p_activity uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.edition_controls_subject(p_kind, p_business, p_event, p_activity, null::uuid)
$$;

create or replace function public.edition_link_controls(p_link uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id, l.hub_id) from public.edition_links l where l.id = p_link), false)
$$;

drop policy if exists "edition_links entity read" on public.edition_links;
create policy "edition_links entity read" on public.edition_links for select to authenticated
  using (public.edition_controls_subject(kind, business_id, event_id, activity_id, hub_id));

-- a link's subject never changes (hub_id included)
create or replace function public.edition_links_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.edition_id, new.kind, new.business_id, new.event_id, new.activity_id, new.hub_id, new.initiated_by, new.created_by)
     is distinct from (old.edition_id, old.kind, old.business_id, old.event_id, old.activity_id, old.hub_id, old.initiated_by, old.created_by) then
    raise exception 'a partnership''s subject and initiator cannot change' using errcode = '23514';
  end if;
  return new;
end $$;

-- leaving 'approved' clears whatever the subject had chosen to show (offers for a business, items for a Hub): a later re-approval needs a fresh choice
create or replace function public.edition_links_clear_offers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.state = 'approved' and new.state <> 'approved' then
    delete from public.edition_link_offers where link_id = new.id;
    delete from public.edition_link_hub_items where link_id = new.id;
  end if;
  return new;
end $$;

-- items may only be attached to an approved Hub link, for that Hub's own events and activities
create or replace function public.edition_link_hub_items_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_l public.edition_links; v_hub uuid;
begin
  select * into v_l from public.edition_links where id = new.link_id;
  if v_l.id is null or v_l.kind <> 'hub' or v_l.state <> 'approved' then raise exception 'items can only be attached to an approved Hub partnership' using errcode = '23514'; end if;
  if new.kind = 'event' then select organiser_hub_id into v_hub from public.events where id = new.event_id;
  else select organiser_hub_id into v_hub from public.regular_activities where id = new.activity_id; end if;
  if v_hub is distinct from v_l.hub_id then raise exception 'a Hub can only show its own events and activities' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists edition_link_hub_items_guard on public.edition_link_hub_items;
create trigger edition_link_hub_items_guard before insert on public.edition_link_hub_items for each row execute function public.edition_link_hub_items_guard();

create policy "edition_link_hub_items public read" on public.edition_link_hub_items for select to anon, authenticated
  using (exists (select 1 from public.edition_links l where l.id = link_id and l.state = 'approved' and public.edition_is_public(l.edition_id) and public.edition_participation_ok(l.id)));
create policy "edition_link_hub_items parties read" on public.edition_link_hub_items for select to authenticated
  using (public.edition_link_controls(link_id)
         or exists (select 1 from public.edition_links l where l.id = link_id and (public.edition_can(l.edition_id, 'editor') or public.edition_staff())));
grant select on public.edition_link_hub_items to anon, authenticated;

-- ── discovery ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- Hubs an organiser may invite: active Hubs the public can already see.
create or replace function public.edition_find_hubs(p_edition uuid, p_q text)
returns table (id uuid, name text, type text, area text, logo_url text, slug text, is_verified boolean, link_state text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return; end if;
  return query
    select h.id, h.name, h.type, h.area, h.logo_url, h.slug, h.is_verified,
           (select l.state from public.edition_links l where l.edition_id = p_edition and l.hub_id = h.id and l.state in ('pending', 'approved') limit 1)
      from public.hubs h
     where h.is_active and not public.is_discovery_hidden('hub', h.id)
       and (h.name ilike '%' || public.edition_like_escape(v_q) || '%' escape '\' or coalesce(h.area, '') ilike '%' || public.edition_like_escape(v_q) || '%' escape '\'
            or h.type ilike '%' || public.edition_like_escape(v_q) || '%' escape '\')
     order by (h.name ilike public.edition_like_escape(v_q) || '%' escape '\') desc, h.name
     limit 20;
end $$;

-- ── the partnership journey, now for four kinds ─────────────────────────────────────────────────────────────────────
create or replace function public.edition_link_precheck(p_edition uuid, p_kind text, p_subject uuid) returns public.editions
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_e public.editions; v_ok boolean; v_claimed boolean;
begin
  select * into v_e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if v_e.status in ('suspended', 'archived') then raise exception 'this Edition is not open for new partners' using errcode = '23514'; end if;
  if p_kind not in ('business', 'event', 'activity', 'hub') then raise exception 'unknown kind' using errcode = '22023'; end if;

  if p_kind = 'business' then
    select (b.is_active and not public.is_discovery_hidden('business', b.id)), b.owner_id is not null into v_ok, v_claimed from public.local_businesses b where b.id = p_subject;
  elsif p_kind = 'hub' then
    select (h.is_active and not public.is_discovery_hidden('hub', h.id)), true into v_ok, v_claimed from public.hubs h where h.id = p_subject;
    -- a Hub-run Edition already carries its own Hub's identity; inviting that same Hub as a partner would only duplicate it
    if exists (select 1 from public.edition_organisers o where o.id = v_e.organiser_id and o.hub_id = p_subject) then
      raise exception 'this Edition is run by that Hub already' using errcode = '23514';
    end if;
  elsif p_kind = 'event' then
    select (e.status = 'published' and not e.is_hidden and not e.is_platform_event and (e.organiser_business_id is not null or e.organiser_hub_id is not null)),
           true into v_ok, v_claimed from public.events e where e.id = p_subject;
  else
    select (a.status = 'published' and not a.admin_paused and not a.is_platform_activity and (a.organiser_business_id is not null or a.organiser_hub_id is not null)),
           true into v_ok, v_claimed from public.regular_activities a where a.id = p_subject;
  end if;
  if v_ok is null or not v_ok then raise exception 'that listing is not available to invite' using errcode = '23514'; end if;
  if not v_claimed then raise exception 'that business has not been claimed yet, so nobody can answer for it' using errcode = '23514'; end if;
  return v_e;
end $$;

create or replace function public.edition_invite_partner(p_edition uuid, p_kind text, p_subject uuid, p_label text default null, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_e public.editions; v_id uuid; v_self boolean; v_pending int; v_subject_pending int; v_cool timestamptz;
        v_b uuid := case when p_kind = 'business' then p_subject end;
        v_ev uuid := case when p_kind = 'event' then p_subject end;
        v_ac uuid := case when p_kind = 'activity' then p_subject end;
        v_h uuid := case when p_kind = 'hub' then p_subject end;
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  v_e := public.edition_link_precheck(p_edition, p_kind, p_subject);
  if char_length(coalesce(p_message, '')) > 500 then raise exception 'message is too long' using errcode = '22001'; end if;
  if p_label is not null and char_length(btrim(p_label)) not between 1 and 60 then raise exception 'label must be 1 to 60 characters' using errcode = '22001'; end if;

  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state in ('pending', 'approved')
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac and l.hub_id is not distinct from v_h) then
    raise exception 'already invited or taking part' using errcode = '23505';
  end if;

  v_self := public.edition_controls_subject(p_kind, v_b, v_ev, v_ac, v_h);
  if not v_self then
    -- anti-spam: a declined invite is not repeated for 30 days; one subject does not collect a pile of unanswered invites.
    select max(l.decided_at) into v_cool from public.edition_links l
      where l.state = 'declined' and l.ended_by = 'entity' and l.initiated_by = 'organiser'
        and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac and l.hub_id is not distinct from v_h
        and l.edition_id in (select e2.id from public.editions e2 where e2.organiser_id = v_e.organiser_id);
    if v_cool is not null and v_cool > now() - interval '30 days' then raise exception 'they declined recently; please wait before inviting again' using errcode = '23514'; end if;
    select count(*) into v_subject_pending from public.edition_links l
      where l.state = 'pending' and l.initiated_by = 'organiser'
        and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac and l.hub_id is not distinct from v_h;
    if v_subject_pending >= 10 then raise exception 'they already have several invitations waiting; please try again later' using errcode = '23514'; end if;
    select count(*) into v_pending from public.edition_links l join public.editions e2 on e2.id = l.edition_id
      where e2.organiser_id = v_e.organiser_id and l.state = 'pending' and l.initiated_by = 'organiser';
    if v_pending >= 100 then raise exception 'too many invitations are waiting for an answer' using errcode = '23514'; end if;
  end if;

  insert into public.edition_links (edition_id, kind, business_id, event_id, activity_id, hub_id, initiated_by, state, label, created_by, decided_by, decided_at)
  values (p_edition, p_kind, v_b, v_ev, v_ac, v_h, 'organiser', case when v_self then 'approved' else 'pending' end, nullif(btrim(p_label), ''), auth.uid(),
          case when v_self then auth.uid() end, case when v_self then now() end)
  returning id into v_id;
  insert into public.edition_link_notes (link_id, message) values (v_id, nullif(btrim(p_message), ''));
  perform public.edition_audit(v_e.organiser_id, p_edition, case when v_self then 'partner_self_approved' else 'partner_invited' end,
                               jsonb_build_object('link', v_id, 'kind', p_kind, 'subject', p_subject));
  return v_id;
end $$;

create or replace function public.edition_request_to_join(p_edition uuid, p_kind text, p_subject uuid, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_e public.editions; v_id uuid; v_pending int;
        v_b uuid := case when p_kind = 'business' then p_subject end;
        v_ev uuid := case when p_kind = 'event' then p_subject end;
        v_ac uuid := case when p_kind = 'activity' then p_subject end;
        v_h uuid := case when p_kind = 'hub' then p_subject end;
begin
  if auth.uid() is null or not public.edition_controls_subject(p_kind, v_b, v_ev, v_ac, v_h) then raise exception 'not permitted' using errcode = '42501'; end if;
  -- visible to the requester only if the Edition is public, or the requester already holds an approved link to it.
  if not public.edition_is_public(p_edition) and not exists (
       select 1 from public.edition_links l where l.edition_id = p_edition and l.state = 'approved'
          and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id, l.hub_id)) then
    raise exception 'edition not found' using errcode = 'P0002';
  end if;
  v_e := public.edition_link_precheck(p_edition, p_kind, p_subject);
  if char_length(coalesce(p_message, '')) > 500 then raise exception 'message is too long' using errcode = '22001'; end if;
  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state in ('pending', 'approved')
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac and l.hub_id is not distinct from v_h) then
    raise exception 'already invited or taking part' using errcode = '23505';
  end if;
  select count(*) into v_pending from public.edition_links l where l.edition_id = p_edition and l.state = 'pending' and l.initiated_by = 'entity';
  if v_pending >= 100 then raise exception 'this Edition has a lot of requests waiting; please try again later' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state = 'declined' and l.ended_by = 'organiser' and l.decided_at > now() - interval '30 days'
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac and l.hub_id is not distinct from v_h) then
    raise exception 'the organiser declined recently; please wait before asking again' using errcode = '23514';
  end if;
  insert into public.edition_links (edition_id, kind, business_id, event_id, activity_id, hub_id, initiated_by, state, created_by)
  values (p_edition, p_kind, v_b, v_ev, v_ac, v_h, 'entity', 'pending', auth.uid()) returning id into v_id;
  insert into public.edition_link_notes (link_id, message) values (v_id, nullif(btrim(p_message), ''));
  perform public.edition_audit(v_e.organiser_id, p_edition, 'partner_requested', jsonb_build_object('link', v_id, 'kind', p_kind, 'subject', p_subject));
  return v_id;
end $$;

create or replace function public.edition_link_act(p_link uuid, p_action text, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links; v_e public.editions; v_ent boolean; v_org boolean; v_to text; v_by text;
begin
  if auth.uid() is null then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into l from public.edition_links where id = p_link for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into v_e from public.editions where id = l.edition_id;
  v_ent := public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id, l.hub_id);
  v_org := public.edition_org_can(v_e.organiser_id, 'editor');
  if not v_ent and not v_org then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'note is too long' using errcode = '22001'; end if;

  if p_action in ('approve', 'decline') then
    if l.state <> 'pending' then raise exception 'this request has already been answered' using errcode = '23514'; end if;
    if l.initiated_by = 'organiser' and not v_ent then raise exception 'only the owner can answer this invitation' using errcode = '42501'; end if;
    if l.initiated_by = 'entity' and not v_org then raise exception 'only the organiser can answer this request' using errcode = '42501'; end if;
    if p_action = 'approve' and v_e.status in ('suspended', 'archived') then raise exception 'this Edition is not open for new partners' using errcode = '23514'; end if;
    v_to := case p_action when 'approve' then 'approved' else 'declined' end;
    v_by := case when l.initiated_by = 'organiser' then 'entity' else 'organiser' end;
  elsif p_action = 'cancel' then
    if l.state <> 'pending' then raise exception 'only a waiting request can be cancelled' using errcode = '23514'; end if;
    if not ((l.initiated_by = 'organiser' and v_org) or (l.initiated_by = 'entity' and v_ent)) then raise exception 'only the sender can cancel' using errcode = '42501'; end if;
    v_to := 'cancelled'; v_by := l.initiated_by;
  elsif p_action = 'withdraw' then
    if l.state <> 'approved' then raise exception 'only an active partnership can be withdrawn' using errcode = '23514'; end if;
    if not v_ent then raise exception 'only the owner can withdraw' using errcode = '42501'; end if;
    v_to := 'withdrawn'; v_by := 'entity';
  elsif p_action = 'remove' then
    if l.state <> 'approved' then raise exception 'only an active partnership can be removed' using errcode = '23514'; end if;
    if not v_org then raise exception 'only the organiser can remove' using errcode = '42501'; end if;
    v_to := 'withdrawn'; v_by := 'organiser';
  else
    raise exception 'unknown action' using errcode = '22023';
  end if;

  update public.edition_links set state = v_to, ended_by = case when v_to = 'approved' then null else v_by end,
         decided_by = auth.uid(), decided_at = now() where id = p_link;
  if p_note is not null and btrim(p_note) <> '' then
    insert into public.edition_link_notes (link_id, response_note) values (p_link, btrim(p_note))
      on conflict (link_id) do update set response_note = excluded.response_note;
  end if;
  perform public.edition_audit(v_e.organiser_id, l.edition_id, 'partner_' || v_to, jsonb_build_object('link', p_link, 'kind', l.kind, 'by', case when v_ent then 'entity' else 'organiser' end));
  return v_to;
end $$;

-- ── what a Hub shows under its card ─────────────────────────────────────────────────────────────────────────────────
-- The Hub's own upcoming public events and calendar-approved activities, with what it has already chosen.
create or replace function public.edition_hub_item_options(p_link uuid)
returns table (kind text, id uuid, title text, starts_at timestamptz, venue text, selected boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l public.edition_links;
begin
  select x.* into l from public.edition_links x where x.id = p_link;
  if auth.uid() is null or l.id is null or l.kind <> 'hub' or not public.edition_link_controls(p_link) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    (select 'event'::text, e.id, e.title, e.starts_at, e.venue,
            exists (select 1 from public.edition_link_hub_items i where i.link_id = p_link and i.event_id = e.id)
       from public.events e
      where e.organiser_hub_id = l.hub_id and not e.is_platform_event and e.status = 'published' and not e.is_hidden and e.hub_visibility in ('hub', 'islands')
        and coalesce(e.ends_at, e.starts_at) >= now()
      order by e.starts_at limit 60)
    union all
    (select 'activity'::text, a.id, a.title, null::timestamptz, a.venue,
            exists (select 1 from public.edition_link_hub_items i where i.link_id = p_link and i.activity_id = a.id)
       from public.regular_activities a
      where a.organiser_hub_id = l.hub_id and not a.is_platform_activity and a.status = 'published' and not a.admin_paused and a.calendar_approved
        and (a.active_until is null or a.active_until >= current_date)
      order by a.title limit 60);
end $$;

create or replace function public.edition_set_hub_items(p_link uuid, p_events uuid[], p_activities uuid[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links; v_e public.editions; v_n integer := 0; x uuid; i integer := 0;
begin
  select * into l from public.edition_links where id = p_link for update;
  if auth.uid() is null or l.id is null or l.kind <> 'hub' or not public.edition_link_controls(p_link) then raise exception 'not permitted' using errcode = '42501'; end if;
  if l.state <> 'approved' then raise exception 'the Hub is not taking part yet' using errcode = '23514'; end if;
  p_events := coalesce(p_events, '{}'); p_activities := coalesce(p_activities, '{}');
  if cardinality(p_events) + cardinality(p_activities) > 12 then raise exception 'choose at most 12 items' using errcode = '23514'; end if;
  delete from public.edition_link_hub_items where link_id = p_link;
  foreach x in array p_events loop
    insert into public.edition_link_hub_items (link_id, kind, event_id, position) values (p_link, 'event', x, i) on conflict do nothing; i := i + 1; v_n := v_n + 1;
  end loop;
  foreach x in array p_activities loop
    insert into public.edition_link_hub_items (link_id, kind, activity_id, position) values (p_link, 'activity', x, i) on conflict do nothing; i := i + 1; v_n := v_n + 1;
  end loop;
  select * into v_e from public.editions where id = l.edition_id;
  perform public.edition_audit(v_e.organiser_id, l.edition_id, 'hub_items_set', jsonb_build_object('link', p_link, 'count', v_n));
  return v_n;
end $$;

-- ── what the signed-in owner sees ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_my_partnerships()
returns table (link_id uuid, kind text, subject_id uuid, subject_name text, subject_business_id uuid, state text, initiated_by text, ended_by text, label text,
               message text, response_note text, created_at timestamptz, decided_at timestamptz,
               edition_id uuid, edition_title text, edition_slug text, edition_summary text, edition_starts_on date, edition_ends_on date,
               edition_cover_url text, edition_status text, edition_is_public boolean, organiser_name text, organiser_slug text, offers_selected integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, l.kind, coalesce(l.business_id, l.event_id, l.activity_id, l.hub_id),
         coalesce(b.name, ev.title, ac.title, hb.name), coalesce(l.business_id, ev.organiser_business_id, ac.organiser_business_id), l.state, l.initiated_by, l.ended_by, l.label,
         n.message, n.response_note, l.created_at, l.decided_at,
         e.id, e.title, e.slug, e.summary, e.starts_on, e.ends_on, e.cover_url, e.status, public.edition_is_public(e.id),
         o.name, case when o.status = 'verified' and not o.is_test then o.slug end,
         case when l.kind = 'hub' then (select count(*)::int from public.edition_link_hub_items x where x.link_id = l.id) else (select count(*)::int from public.edition_link_offers x where x.link_id = l.id) end
    from public.edition_links l
    join public.editions e on e.id = l.edition_id
    join public.edition_organisers o on o.id = e.organiser_id
    left join public.edition_link_notes n on n.link_id = l.id
    left join public.local_businesses b on b.id = l.business_id
    left join public.events ev on ev.id = l.event_id
    left join public.regular_activities ac on ac.id = l.activity_id
    left join public.hubs hb on hb.id = l.hub_id
   where auth.uid() is not null and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id, l.hub_id)
   order by (l.state = 'pending') desc, l.updated_at desc
$$;

create or replace function public.edition_partner_rows(p_edition uuid)
returns table (link_id uuid, kind text, subject_id uuid, subject_name text, subject_slug text, subject_logo text, owner_claimed boolean, state text, initiated_by text, ended_by text, label text,
               sort_order integer, message text, response_note text, created_at timestamptz, decided_at timestamptz, offers_selected integer, in_window boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    select l.id, l.kind, coalesce(l.business_id, l.event_id, l.activity_id, l.hub_id), coalesce(b.name, ev.title, ac.title, hb.name),
           coalesce(b.slug, ac.slug, hb.slug), coalesce(b.logo_url, hb.logo_url), true,
           l.state, l.initiated_by, l.ended_by, l.label, l.position, n.message, n.response_note, l.created_at, l.decided_at,
           case when l.kind = 'hub' then (select count(*)::int from public.edition_link_hub_items x where x.link_id = l.id) else (select count(*)::int from public.edition_link_offers x where x.link_id = l.id) end,
           case l.kind when 'event' then ((ev.starts_at at time zone 'Europe/London')::date between e.starts_on and e.ends_on) else true end
      from public.edition_links l
      join public.editions e on e.id = l.edition_id
      left join public.edition_link_notes n on n.link_id = l.id
      left join public.local_businesses b on b.id = l.business_id
      left join public.events ev on ev.id = l.event_id
      left join public.regular_activities ac on ac.id = l.activity_id
      left join public.hubs hb on hb.id = l.hub_id
     where l.edition_id = p_edition
     order by (l.state = 'pending') desc, l.position, l.created_at;
end $$;
-- (edition_my_pending_count counts pending organiser invitations the signed-in person controls: it must use the five-argument authority)
create or replace function public.edition_my_pending_count() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.edition_links l
   where auth.uid() is not null and l.state = 'pending' and l.initiated_by = 'organiser'
     and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id, l.hub_id)
$$;

-- ── public views (security_invoker: the Hub's own column grants and row policy still decide what is visible) ─────────
-- A Hub's identity as the Edition shows it: public whitelist columns ONLY. Never owner_id, members, payout, charity number or contact details.
create or replace view public.edition_public_hubs with (security_invoker = true) as
  select l.id as link_id, l.edition_id, l.label, l.position, h.id as hub_id, h.name, h.slug, h.type, h.description, h.area, h.website,
         h.logo_url, h.cover_url, h.brand_color, h.is_verified, h.is_charity
    from public.edition_links l join public.hubs h on h.id = l.hub_id
   where l.kind = 'hub' and l.state = 'approved' and public.edition_participation_ok(l.id) and h.is_active;

-- what that Hub chose to show: the live events and activities (their own row-level rules apply, so a members-only event never appears)
create or replace view public.edition_public_hub_items with (security_invoker = true) as
  select i.link_id, l.edition_id, l.hub_id, i.position, i.kind, i.id as item_id,
         e.id as event_id, e.title as event_title, e.starts_at, e.ends_at, e.venue as event_venue, e.cover_url as event_cover_url, e.price_text as event_price_text,
         a.id as activity_id, a.slug as activity_slug, a.title as activity_title, a.venue as activity_venue, a.cover_url as activity_cover_url, a.price_text as activity_price_text
    from public.edition_link_hub_items i
    join public.edition_links l on l.id = i.link_id
    left join public.events e on e.id = i.event_id and e.status = 'published' and not e.is_hidden
    left join public.regular_activities a on a.id = i.activity_id and a.status = 'published' and not a.admin_paused
   where l.kind = 'hub' and l.state = 'approved' and public.edition_participation_ok(l.id)
     and (e.id is not null or a.id is not null);
revoke all on public.edition_public_hubs, public.edition_public_hub_items from public, anon, authenticated;
grant select on public.edition_public_hubs, public.edition_public_hub_items to anon, authenticated;

-- ── who is told ─────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_hub_admin_users(p_hub uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select h.owner_id from public.hubs h where h.id = p_hub
  union select m.user_id from public.hub_members m where m.hub_id = p_hub and m.status = 'active' and m.role in ('owner', 'committee')
$$;
create or replace function public.edition_subject_controllers(p_kind text, p_business uuid, p_event uuid, p_activity uuid, p_hub uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u from (
    select public.edition_subject_controller(p_kind, p_business, p_event, p_activity) as u where p_kind <> 'hub'
    union all select public.edition_hub_admin_users(p_hub) where p_kind = 'hub'
  ) x where u is not null
$$;
create or replace function public.edition_subject_name(p_kind text, p_business uuid, p_event uuid, p_activity uuid, p_hub uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_kind = 'hub' then (select name from public.hubs where id = p_hub) else public.edition_subject_name(p_kind, p_business, p_event, p_activity) end
$$;

create or replace function public.edition_links_email() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_name text; v_ctrl uuid; u uuid; v_payload jsonb;
begin
  select * into e from public.editions where id = new.edition_id; select * into o from public.edition_organisers where id = e.organiser_id;
  v_name := public.edition_subject_name(new.kind, new.business_id, new.event_id, new.activity_id, new.hub_id);
  v_payload := jsonb_build_object('edition_title', e.title, 'organiser_name', o.name, 'subject_kind', new.kind, 'subject_name', v_name, 'link_id', new.id);
  if tg_op = 'INSERT' then
    if new.state = 'pending' and new.initiated_by = 'organiser' then
      for v_ctrl in select * from public.edition_subject_controllers(new.kind, new.business_id, new.event_id, new.activity_id, new.hub_id) loop
        perform public.edition_enqueue_email('partner_invited', v_ctrl, 'pi:' || new.id || ':' || v_ctrl, v_payload);
      end loop;
    end if;
    if new.state = 'pending' and new.initiated_by = 'entity' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_requested', u, 'pr:' || new.id || ':' || u, v_payload); end loop; end if;
  elsif new.state is distinct from old.state then
    if new.state in ('approved', 'declined') and old.state = 'pending' then
      if new.initiated_by = 'organiser' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_answered', u, 'pa:' || new.id || ':' || new.state || ':' || u, v_payload || jsonb_build_object('answer', new.state)); end loop;
      else
        for v_ctrl in select * from public.edition_subject_controllers(new.kind, new.business_id, new.event_id, new.activity_id, new.hub_id) loop
          perform public.edition_enqueue_email('partner_request_answered', v_ctrl, 'pq:' || new.id || ':' || new.state || ':' || v_ctrl, v_payload || jsonb_build_object('answer', new.state));
        end loop;
      end if;
    elsif new.state = 'withdrawn' and new.ended_by = 'entity' then
      for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_withdrew', u, 'pw:' || new.id || ':' || u, v_payload); end loop;
    elsif new.state = 'withdrawn' and new.ended_by = 'organiser' then
      for v_ctrl in select * from public.edition_subject_controllers(new.kind, new.business_id, new.event_id, new.activity_id, new.hub_id) loop
        perform public.edition_enqueue_email('partner_removed', v_ctrl, 'pm:' || new.id || ':' || v_ctrl, v_payload);
      end loop;
    end if;
  end if;
  return new;
end $$;

-- ── privileges (explicit: Supabase grants EXECUTE on new functions by default, and Editions functions are signed-in only unless reviewed) ──
do $$ declare f text; begin
  foreach f in array array[
    'edition_controls_hub(uuid)', 'edition_controls_subject(text,uuid,uuid,uuid,uuid)', 'edition_controls_subject(text,uuid,uuid,uuid)', 'edition_link_controls(uuid)',
    'edition_links_immutable()', 'edition_links_clear_offers()', 'edition_link_hub_items_guard()',
    'edition_find_hubs(uuid,text)', 'edition_link_precheck(uuid,text,uuid)', 'edition_invite_partner(uuid,text,uuid,text,text)', 'edition_request_to_join(uuid,text,uuid,text)',
    'edition_link_act(uuid,text,text)', 'edition_hub_item_options(uuid)', 'edition_set_hub_items(uuid,uuid[],uuid[])',
    'edition_my_partnerships()', 'edition_partner_rows(uuid)', 'edition_my_pending_count()',
    'edition_hub_admin_users(uuid)', 'edition_subject_controllers(text,uuid,uuid,uuid,uuid)', 'edition_subject_name(text,uuid,uuid,uuid,uuid)', 'edition_links_email()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'edition_controls_hub(uuid)', 'edition_controls_subject(text,uuid,uuid,uuid,uuid)', 'edition_controls_subject(text,uuid,uuid,uuid)', 'edition_link_controls(uuid)',
    'edition_find_hubs(uuid,text)', 'edition_invite_partner(uuid,text,uuid,text,text)', 'edition_request_to_join(uuid,text,uuid,text)',
    'edition_link_act(uuid,text,text)', 'edition_hub_item_options(uuid)', 'edition_set_hub_items(uuid,uuid[],uuid[])',
    'edition_my_partnerships()', 'edition_partner_rows(uuid)', 'edition_my_pending_count()'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

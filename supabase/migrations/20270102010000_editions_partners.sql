-- OneShetland Editions R2: partnerships. An organiser invites a Directory business (or an independently owned event or
-- regular activity) into an Edition; the OWNER of that business/event/activity approves, declines or withdraws.
--
-- Principles (each is enforced by the database, not the UI):
--  * Two-sided consent. A link is public only while state = 'approved'. Only the controlling entity can approve its side;
--    only the organiser team can approve a request from an entity. Platform staff are NOT a consent route.
--  * Withdrawal is immediate: public reads go straight to the live row; there is no cache or copy.
--  * Nothing here can edit a business, event, activity or offer. Offers are chosen by the business and re-checked at read
--    time against the ORIGINAL public rules (active, in date, Pro tier or above) so a lapsed plan drops them at once.
--  * Additive: no column added to events, hubs, local_businesses or any other mobile-shared table.
--  * Public reads use security_invoker views, so existing RLS and column grants on the subject tables still apply.

-- ── tables ──────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.edition_links (
  id           uuid primary key default gen_random_uuid(),
  edition_id   uuid not null references public.editions (id) on delete cascade,
  kind         text not null check (kind in ('business', 'event', 'activity')),
  business_id  uuid references public.local_businesses (id) on delete cascade,
  event_id     uuid references public.events (id) on delete cascade,
  activity_id  uuid references public.regular_activities (id) on delete cascade,
  initiated_by text not null check (initiated_by in ('organiser', 'entity')),
  state        text not null default 'pending' check (state in ('pending', 'approved', 'declined', 'cancelled', 'withdrawn')),
  ended_by     text check (ended_by in ('organiser', 'entity')),
  label        text check (label is null or char_length(btrim(label)) between 1 and 60),
  position     integer not null default 0,
  created_by   uuid references auth.users (id) on delete set null,
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint edition_links_one_subject check (
    (kind = 'business' and business_id is not null and event_id is null and activity_id is null) or
    (kind = 'event'    and event_id    is not null and business_id is null and activity_id is null) or
    (kind = 'activity' and activity_id is not null and business_id is null and event_id is null)),
  constraint edition_links_end_consistent check ((state in ('declined', 'cancelled', 'withdrawn')) = (ended_by is not null))
);
create unique index if not exists edition_links_active_business on public.edition_links (edition_id, business_id) where business_id is not null and state in ('pending', 'approved');
create unique index if not exists edition_links_active_event    on public.edition_links (edition_id, event_id)    where event_id    is not null and state in ('pending', 'approved');
create unique index if not exists edition_links_active_activity on public.edition_links (edition_id, activity_id) where activity_id is not null and state in ('pending', 'approved');
create index if not exists edition_links_edition_idx on public.edition_links (edition_id, state);
create index if not exists edition_links_business_idx on public.edition_links (business_id) where business_id is not null;
create index if not exists edition_links_event_idx on public.edition_links (event_id) where event_id is not null;
create index if not exists edition_links_activity_idx on public.edition_links (activity_id) where activity_id is not null;

-- Free-text exchanged between the two sides. Kept apart from edition_links so the public policy on the link never exposes it.
create table if not exists public.edition_link_notes (
  link_id       uuid primary key references public.edition_links (id) on delete cascade,
  message       text check (message is null or char_length(message) <= 500),
  response_note text check (response_note is null or char_length(response_note) <= 300)
);

-- Which of a business's own offers it has chosen to show in the Edition.
create table if not exists public.edition_link_offers (
  link_id    uuid not null references public.edition_links (id) on delete cascade,
  offer_id   uuid not null references public.local_offers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (link_id, offer_id)
);

-- ── access helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

-- Does the signed-in user genuinely control this subject? Same authority the existing event/activity/business policies use.
-- Platform staff do NOT count: consent to appear in someone else's Edition belongs to the owner alone.
create or replace function public.edition_controls_subject(p_kind text, p_business uuid, p_event uuid, p_activity uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and case p_kind
    when 'business' then exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid())
    when 'event' then exists (select 1 from public.events e where e.id = p_event and not e.is_platform_event
                               and public.controls_event_entity(e.organiser_business_id, e.organiser_hub_id))
    when 'activity' then exists (select 1 from public.regular_activities a where a.id = p_activity and not a.is_platform_activity
                               and public.controls_event_entity(a.organiser_business_id, a.organiser_hub_id))
    else false end
$$;

create or replace function public.edition_link_controls(p_link uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id) from public.edition_links l where l.id = p_link), false)
$$;

-- The single insertion point for later commercial eligibility (paid participation, R4d). Today every approved partnership is eligible.
-- Deliberately a plain function with no data access: R2 holds no price, fee or payment information. Every public read of a partnership
-- (the two public policies and the four public views) calls it, so a later release changes one function and nothing else.
create or replace function public.edition_participation_ok(p_link uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$ select true $$;

-- ── policies ────────────────────────────────────────────────────────────────────────────────────────────────────────

alter table public.edition_links enable row level security;
alter table public.edition_link_notes enable row level security;
alter table public.edition_link_offers enable row level security;
revoke all on public.edition_links, public.edition_link_notes, public.edition_link_offers from public, anon, authenticated;

-- The public sees approved links of public Editions and nothing else (no message text, no decision metadata).
create policy "edition_links public read" on public.edition_links for select to anon, authenticated
  using (state = 'approved' and public.edition_is_public(edition_id) and public.edition_participation_ok(id));
create policy "edition_links team read" on public.edition_links for select to authenticated
  using (public.edition_can(edition_id, 'editor') or public.edition_staff());
create policy "edition_links entity read" on public.edition_links for select to authenticated
  using (public.edition_controls_subject(kind, business_id, event_id, activity_id));
grant select (id, edition_id, kind, business_id, event_id, activity_id, state, label, position) on public.edition_links to anon;
grant select on public.edition_links to authenticated;

create policy "edition_link_notes parties read" on public.edition_link_notes for select to authenticated
  using (public.edition_link_controls(link_id)
         or exists (select 1 from public.edition_links l where l.id = link_id and (public.edition_can(l.edition_id, 'editor') or public.edition_staff())));
grant select on public.edition_link_notes to authenticated;

create policy "edition_link_offers public read" on public.edition_link_offers for select to anon, authenticated
  using (exists (select 1 from public.edition_links l where l.id = link_id and l.state = 'approved' and public.edition_is_public(l.edition_id) and public.edition_participation_ok(l.id)));
create policy "edition_link_offers parties read" on public.edition_link_offers for select to authenticated
  using (public.edition_link_controls(link_id)
         or exists (select 1 from public.edition_links l where l.id = link_id and (public.edition_can(l.edition_id, 'editor') or public.edition_staff())));
grant select on public.edition_link_offers to anon, authenticated;

-- ── triggers ────────────────────────────────────────────────────────────────────────────────────────────────────────

create trigger edition_links_touch before update on public.edition_links for each row execute function public.edition_touch();

-- Offers can be attached only to an approved link of the same business; leaving 'approved' clears them so that a later
-- re-approval needs a fresh choice from the business.
create or replace function public.edition_link_offers_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_l public.edition_links; v_b uuid;
begin
  select * into v_l from public.edition_links where id = new.link_id;
  select business_id into v_b from public.local_offers where id = new.offer_id;
  if v_l.kind <> 'business' or v_l.state <> 'approved' or v_b is distinct from v_l.business_id then
    raise exception 'offers can only be attached to an approved link for the offer''s own business' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger edition_link_offers_guard before insert on public.edition_link_offers for each row execute function public.edition_link_offers_guard();

create or replace function public.edition_links_clear_offers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.state = 'approved' and new.state <> 'approved' then delete from public.edition_link_offers where link_id = new.id; end if;
  return new;
end $$;
create trigger edition_links_clear_offers after update of state on public.edition_links for each row execute function public.edition_links_clear_offers();

-- State machine guard: whoever writes (RPC or a future caller), illegal transitions are refused.
create or replace function public.edition_links_transition() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.state = 'pending' and new.state in ('pending', 'approved', 'declined', 'cancelled') then return new; end if;
  if old.state = 'approved' and new.state in ('approved', 'withdrawn') then return new; end if;
  if old.state = new.state then return new; end if;
  raise exception 'illegal partnership transition % -> %', old.state, new.state using errcode = '23514';
end $$;
create trigger edition_links_transition before update on public.edition_links for each row execute function public.edition_links_transition();

create or replace function public.edition_links_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.edition_id, new.kind, new.business_id, new.event_id, new.activity_id, new.initiated_by, new.created_by)
     is distinct from (old.edition_id, old.kind, old.business_id, old.event_id, old.activity_id, old.initiated_by, old.created_by) then
    raise exception 'a partnership''s subject and initiator cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger aa_edition_links_immutable before update on public.edition_links for each row execute function public.edition_links_immutable();

-- ── discovery for the organiser ─────────────────────────────────────────────────────────────────────────────────────

create or replace function public.edition_like_escape(p text) returns text language sql immutable set search_path = public, pg_temp as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- Businesses an organiser may invite: the ones the public can already see. 'claimed' says whether a person can answer.
create or replace function public.edition_find_businesses(p_edition uuid, p_q text)
returns table (id uuid, name text, category text, address text, logo_url text, slug text, claimed boolean, link_state text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return; end if;
  return query
    select b.id, b.name, b.category, b.address, b.logo_url, b.slug, (b.owner_id is not null),
           (select l.state from public.edition_links l where l.edition_id = p_edition and l.business_id = b.id and l.state in ('pending', 'approved') limit 1)
      from public.local_businesses b
     where b.is_active and not public.is_discovery_hidden('business', b.id)
       and (b.name ilike '%' || public.edition_like_escape(v_q) || '%' escape '\' or b.category ilike '%' || public.edition_like_escape(v_q) || '%' escape '\')
     order by (b.name ilike public.edition_like_escape(v_q) || '%' escape '\') desc, b.name
     limit 20;
end $$;

-- Events and regular activities an organiser may ask to include: public, independently owned (a business or hub controls them).
create or replace function public.edition_find_activities(p_edition uuid, p_q text)
returns table (kind text, id uuid, title text, when_text text, starts_at timestamptz, venue text, owner_name text, link_state text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return; end if;
  return query
    (select 'event'::text, e.id, e.title, null::text, e.starts_at, e.venue,
            coalesce((select b.name from public.local_businesses b where b.id = e.organiser_business_id), (select h.name from public.hubs h where h.id = e.organiser_hub_id)),
            (select l.state from public.edition_links l where l.edition_id = p_edition and l.event_id = e.id and l.state in ('pending', 'approved') limit 1)
       from public.events e
      where e.status = 'published' and not e.is_hidden and not e.is_platform_event
        and (e.organiser_business_id is not null or e.organiser_hub_id is not null)
        and (e.organiser_hub_id is null or e.hub_visibility in ('hub', 'islands'))
        and coalesce(e.ends_at, e.starts_at) >= now()
        and e.title ilike '%' || public.edition_like_escape(v_q) || '%' escape '\'
      order by e.starts_at limit 15)
    union all
    (select 'activity'::text, a.id, a.title, null::text, null::timestamptz, a.venue,
            coalesce((select b.name from public.local_businesses b where b.id = a.organiser_business_id), (select h.name from public.hubs h where h.id = a.organiser_hub_id)),
            (select l.state from public.edition_links l where l.edition_id = p_edition and l.activity_id = a.id and l.state in ('pending', 'approved') limit 1)
       from public.regular_activities a
      where a.status = 'published' and not a.admin_paused and not a.is_platform_activity
        and (a.organiser_business_id is not null or a.organiser_hub_id is not null)
        and (a.active_until is null or a.active_until >= current_date)
        and a.title ilike '%' || public.edition_like_escape(v_q) || '%' escape '\'
      order by a.title limit 15);
end $$;

-- ── partnership actions ─────────────────────────────────────────────────────────────────────────────────────────────

-- Shared checks for any new link. Returns the edition row. Raises friendly, specific errors.
create or replace function public.edition_link_precheck(p_edition uuid, p_kind text, p_subject uuid) returns public.editions
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_e public.editions; v_ok boolean; v_claimed boolean; v_cool timestamptz;
begin
  select * into v_e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if v_e.status in ('suspended', 'archived') then raise exception 'this Edition is not open for new partners' using errcode = '23514'; end if;
  if p_kind not in ('business', 'event', 'activity') then raise exception 'unknown kind' using errcode = '22023'; end if;

  if p_kind = 'business' then
    select (b.is_active and not public.is_discovery_hidden('business', b.id)), b.owner_id is not null into v_ok, v_claimed from public.local_businesses b where b.id = p_subject;
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
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  v_e := public.edition_link_precheck(p_edition, p_kind, p_subject);
  if char_length(coalesce(p_message, '')) > 500 then raise exception 'message is too long' using errcode = '22001'; end if;
  if p_label is not null and char_length(btrim(p_label)) not between 1 and 60 then raise exception 'label must be 1 to 60 characters' using errcode = '22001'; end if;

  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state in ('pending', 'approved')
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac) then
    raise exception 'already invited or taking part' using errcode = '23505';
  end if;

  v_self := public.edition_controls_subject(p_kind, v_b, v_ev, v_ac);
  if not v_self then
    -- anti-spam: a declined invite is not repeated for 30 days; one subject does not collect a pile of unanswered invites.
    select max(l.decided_at) into v_cool from public.edition_links l
      where l.state = 'declined' and l.ended_by = 'entity' and l.initiated_by = 'organiser'
        and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac
        and l.edition_id in (select e2.id from public.editions e2 where e2.organiser_id = v_e.organiser_id);
    if v_cool is not null and v_cool > now() - interval '30 days' then raise exception 'they declined recently; please wait before inviting again' using errcode = '23514'; end if;
    select count(*) into v_subject_pending from public.edition_links l
      where l.state = 'pending' and l.initiated_by = 'organiser'
        and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac;
    if v_subject_pending >= 10 then raise exception 'they already have several invitations waiting; please try again later' using errcode = '23514'; end if;
    select count(*) into v_pending from public.edition_links l join public.editions e2 on e2.id = l.edition_id
      where e2.organiser_id = v_e.organiser_id and l.state = 'pending' and l.initiated_by = 'organiser';
    if v_pending >= 100 then raise exception 'too many invitations are waiting for an answer' using errcode = '23514'; end if;
  end if;

  insert into public.edition_links (edition_id, kind, business_id, event_id, activity_id, initiated_by, state, label, created_by, decided_by, decided_at)
  values (p_edition, p_kind, v_b, v_ev, v_ac, 'organiser', case when v_self then 'approved' else 'pending' end, nullif(btrim(p_label), ''), auth.uid(),
          case when v_self then auth.uid() end, case when v_self then now() end)
  returning id into v_id;
  insert into public.edition_link_notes (link_id, message) values (v_id, nullif(btrim(p_message), ''));
  perform public.edition_audit(v_e.organiser_id, p_edition, case when v_self then 'partner_self_approved' else 'partner_invited' end,
                               jsonb_build_object('link', v_id, 'kind', p_kind, 'subject', p_subject));
  return v_id;
end $$;

-- An owner asks to take part in a public Edition (or proposes one more of its own events/activities).
create or replace function public.edition_request_to_join(p_edition uuid, p_kind text, p_subject uuid, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_e public.editions; v_id uuid; v_pending int;
        v_b uuid := case when p_kind = 'business' then p_subject end;
        v_ev uuid := case when p_kind = 'event' then p_subject end;
        v_ac uuid := case when p_kind = 'activity' then p_subject end;
begin
  if auth.uid() is null or not public.edition_controls_subject(p_kind, v_b, v_ev, v_ac) then raise exception 'not permitted' using errcode = '42501'; end if;
  -- visible to the requester only if the Edition is public, or the requester already holds an approved link to it.
  if not public.edition_is_public(p_edition) and not exists (
       select 1 from public.edition_links l where l.edition_id = p_edition and l.state = 'approved'
          and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id)) then
    raise exception 'edition not found' using errcode = 'P0002';
  end if;
  v_e := public.edition_link_precheck(p_edition, p_kind, p_subject);
  if char_length(coalesce(p_message, '')) > 500 then raise exception 'message is too long' using errcode = '22001'; end if;
  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state in ('pending', 'approved')
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac) then
    raise exception 'already invited or taking part' using errcode = '23505';
  end if;
  select count(*) into v_pending from public.edition_links l where l.edition_id = p_edition and l.state = 'pending' and l.initiated_by = 'entity';
  if v_pending >= 100 then raise exception 'this Edition has a lot of requests waiting; please try again later' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_links l where l.edition_id = p_edition and l.state = 'declined' and l.ended_by = 'organiser' and l.decided_at > now() - interval '30 days'
              and l.business_id is not distinct from v_b and l.event_id is not distinct from v_ev and l.activity_id is not distinct from v_ac) then
    raise exception 'the organiser declined recently; please wait before asking again' using errcode = '23514';
  end if;
  insert into public.edition_links (edition_id, kind, business_id, event_id, activity_id, initiated_by, state, created_by)
  values (p_edition, p_kind, v_b, v_ev, v_ac, 'entity', 'pending', auth.uid()) returning id into v_id;
  insert into public.edition_link_notes (link_id, message) values (v_id, nullif(btrim(p_message), ''));
  perform public.edition_audit(v_e.organiser_id, p_edition, 'partner_requested', jsonb_build_object('link', v_id, 'kind', p_kind, 'subject', p_subject));
  return v_id;
end $$;

-- approve | decline | cancel | withdraw | remove.  The side allowed to act is decided here, from who started the link.
create or replace function public.edition_link_act(p_link uuid, p_action text, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links; v_e public.editions; v_ent boolean; v_org boolean; v_to text; v_by text;
begin
  if auth.uid() is null then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into l from public.edition_links where id = p_link for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into v_e from public.editions where id = l.edition_id;
  v_ent := public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id);
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

-- Organiser-side tidy-up: heading and order only.
create or replace function public.edition_link_set_display(p_link uuid, p_label text, p_position integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ed uuid;
begin
  select edition_id into v_ed from public.edition_links where id = p_link;
  if auth.uid() is null or v_ed is null or not public.edition_can(v_ed, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_label is not null and char_length(btrim(p_label)) not between 1 and 60 then raise exception 'label must be 1 to 60 characters' using errcode = '22001'; end if;
  update public.edition_links set label = nullif(btrim(p_label), ''), position = coalesce(p_position, position) where id = p_link;
end $$;

-- ── offers: the business picks; eligibility is the existing public rule ────────────────────────────────────────────

create or replace function public.edition_offer_options(p_link uuid)
returns table (offer_id uuid, title text, description text, discount_type text, discount_value numeric, valid_until timestamptz, selected boolean, eligible boolean, reason text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l public.edition_links; v_pro boolean;
begin
  select * into l from public.edition_links where id = p_link;
  if auth.uid() is null or l.id is null or l.kind <> 'business' or not public.edition_link_controls(p_link) then raise exception 'not permitted' using errcode = '42501'; end if;
  v_pro := public.business_meets_tier(l.business_id, 'pro');
  return query
    select o.id, o.title, o.description, o.discount_type, o.discount_value, o.valid_until,
           exists (select 1 from public.edition_link_offers x where x.link_id = p_link and x.offer_id = o.id),
           (v_pro and o.is_active and (o.valid_until is null or o.valid_until > now()) and (o.valid_from is null or o.valid_from <= now())),
           case when not o.is_active then 'This offer is switched off.'
                when o.valid_until is not null and o.valid_until <= now() then 'This offer has ended.'
                when o.valid_from is not null and o.valid_from > now() then 'This offer has not started yet.'
                when not v_pro then 'Offers are shown publicly on a Pro or Premium listing.'
                else null end
      from public.local_offers o where o.business_id = l.business_id
     order by o.created_at desc;
end $$;

create or replace function public.edition_set_link_offers(p_link uuid, p_offer_ids uuid[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links; v_ed public.editions; v_ids uuid[] := coalesce(p_offer_ids, '{}'); v_bad int;
begin
  select * into l from public.edition_links where id = p_link for update;
  if auth.uid() is null or l.id is null or l.kind <> 'business' or not public.edition_link_controls(p_link) then raise exception 'not permitted' using errcode = '42501'; end if;
  if l.state <> 'approved' then raise exception 'approve the invitation first' using errcode = '23514'; end if;
  if coalesce(array_length(v_ids, 1), 0) > 6 then raise exception 'choose up to 6 offers' using errcode = '23514'; end if;
  select count(*) into v_bad from unnest(v_ids) i where not exists (
    select 1 from public.local_offers o where o.id = i and o.business_id = l.business_id and o.is_active
       and (o.valid_until is null or o.valid_until > now()) and (o.valid_from is null or o.valid_from <= now()));
  if v_bad > 0 then raise exception 'one of those offers is not available to show' using errcode = '23514'; end if;
  if array_length(v_ids, 1) > 0 and not public.business_meets_tier(l.business_id, 'pro') then
    raise exception 'offers are shown publicly on a Pro or Premium listing' using errcode = '23514';
  end if;
  delete from public.edition_link_offers where link_id = p_link and offer_id <> all (v_ids);
  insert into public.edition_link_offers (link_id, offer_id) select p_link, i from unnest(v_ids) i on conflict do nothing;
  select * into v_ed from public.editions where id = l.edition_id;
  perform public.edition_audit(v_ed.organiser_id, l.edition_id, 'partner_offers_set', jsonb_build_object('link', p_link, 'count', coalesce(array_length(v_ids, 1), 0)));
  return coalesce(array_length(v_ids, 1), 0);
end $$;

-- ── views for people ────────────────────────────────────────────────────────────────────────────────────────────────

-- What a business/event/activity owner sees: every request or invitation addressed to, or sent by, something they control.
create or replace function public.edition_my_partnerships()
returns table (link_id uuid, kind text, subject_id uuid, subject_name text, subject_business_id uuid, state text, initiated_by text, ended_by text, label text,
               message text, response_note text, created_at timestamptz, decided_at timestamptz,
               edition_id uuid, edition_title text, edition_slug text, edition_summary text, edition_starts_on date, edition_ends_on date,
               edition_cover_url text, edition_status text, edition_is_public boolean, organiser_name text, organiser_slug text, offers_selected integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, l.kind, coalesce(l.business_id, l.event_id, l.activity_id),
         coalesce(b.name, ev.title, ac.title), coalesce(l.business_id, ev.organiser_business_id, ac.organiser_business_id), l.state, l.initiated_by, l.ended_by, l.label,
         n.message, n.response_note, l.created_at, l.decided_at,
         e.id, e.title, e.slug, e.summary, e.starts_on, e.ends_on, e.cover_url, e.status, public.edition_is_public(e.id),
         o.name, case when o.status = 'verified' and not o.is_test then o.slug end,
         (select count(*)::int from public.edition_link_offers x where x.link_id = l.id)
    from public.edition_links l
    join public.editions e on e.id = l.edition_id
    join public.edition_organisers o on o.id = e.organiser_id
    left join public.edition_link_notes n on n.link_id = l.id
    left join public.local_businesses b on b.id = l.business_id
    left join public.events ev on ev.id = l.event_id
    left join public.regular_activities ac on ac.id = l.activity_id
   where auth.uid() is not null and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id)
   order by (l.state = 'pending') desc, l.updated_at desc
$$;

-- What the organiser team sees for one Edition.
create or replace function public.edition_partner_rows(p_edition uuid)
returns table (link_id uuid, kind text, subject_id uuid, subject_name text, subject_slug text, subject_logo text, owner_claimed boolean, state text, initiated_by text, ended_by text, label text,
               sort_order integer, message text, response_note text, created_at timestamptz, decided_at timestamptz, offers_selected integer, in_window boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    select l.id, l.kind, coalesce(l.business_id, l.event_id, l.activity_id), coalesce(b.name, ev.title, ac.title),
           coalesce(b.slug, ac.slug), b.logo_url, true,
           l.state, l.initiated_by, l.ended_by, l.label, l.position, n.message, n.response_note, l.created_at, l.decided_at,
           (select count(*)::int from public.edition_link_offers x where x.link_id = l.id),
           case l.kind when 'event' then ((ev.starts_at at time zone 'Europe/London')::date between e.starts_on and e.ends_on) else true end
      from public.edition_links l
      join public.editions e on e.id = l.edition_id
      left join public.edition_link_notes n on n.link_id = l.id
      left join public.local_businesses b on b.id = l.business_id
      left join public.events ev on ev.id = l.event_id
      left join public.regular_activities ac on ac.id = l.activity_id
     where l.edition_id = p_edition
     order by (l.state = 'pending') desc, l.position, l.created_at;
end $$;

-- Count of things waiting for the signed-in owner (for a dashboard badge).
create or replace function public.edition_my_pending_count() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.edition_links l
   where auth.uid() is not null and l.state = 'pending' and l.initiated_by = 'organiser'
     and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id)
$$;

-- Public Editions a signed-in owner could ask to join (kept deliberately small).
create or replace function public.edition_joinable()
returns table (edition_id uuid, title text, slug text, summary text, starts_on date, ends_on date, organiser_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id, e.title, e.slug, e.summary, e.starts_on, e.ends_on, o.name
    from public.editions e join public.edition_organisers o on o.id = e.organiser_id
   where auth.uid() is not null and public.edition_is_public(e.id) and e.ends_on >= current_date
   order by e.starts_on limit 30
$$;

-- ── public views (security_invoker: the subject tables' own RLS and column grants still decide what is visible) ─────

create or replace view public.edition_public_businesses with (security_invoker = true) as
  select l.id as link_id, l.edition_id, l.label, l.position, b.id as business_id, b.name, b.slug, b.category, b.description, b.address,
         b.logo_url, b.cover_url, b.brand_color
    from public.edition_links l join public.local_businesses b on b.id = l.business_id
   where l.kind = 'business' and l.state = 'approved' and public.edition_participation_ok(l.id) and b.is_active;

create or replace view public.edition_public_offers with (security_invoker = true) as
  select l.id as link_id, l.edition_id, l.business_id, o.id as offer_id, o.title, o.description, o.discount_type, o.discount_value,
         o.valid_until, o.image_url, o.terms
    from public.edition_links l
    join public.edition_link_offers x on x.link_id = l.id
    join public.local_offers o on o.id = x.offer_id
   where l.kind = 'business' and l.state = 'approved' and public.edition_participation_ok(l.id) and o.is_active
     and (o.valid_until is null or o.valid_until > now()) and (o.valid_from is null or o.valid_from <= now());

create or replace view public.edition_public_events with (security_invoker = true) as
  select l.id as link_id, l.edition_id, l.label, l.position, e.id as event_id, e.title, e.description, e.starts_at, e.ends_at, e.venue, e.locality,
         e.cover_url, e.price_text, e.ticket_url, e.has_tickets, e.status, e.category
    from public.edition_links l
    join public.events e on e.id = l.event_id
    join public.editions ed on ed.id = l.edition_id
   where l.kind = 'event' and l.state = 'approved' and public.edition_participation_ok(l.id) and e.status in ('published', 'cancelled', 'postponed')
     -- visibility (drafts, hub-only events) is decided by the events table's own RLS, which applies to the invoker
     and (e.starts_at at time zone 'Europe/London')::date between ed.starts_on and ed.ends_on;

create or replace view public.edition_public_activities with (security_invoker = true) as
  select l.id as link_id, l.edition_id, l.label, l.position, a.id as activity_id, a.slug, a.title, a.description, a.category, a.venue, a.locality,
         a.cover_url, a.price_text, a.booking_mode, a.booking_url
    from public.edition_links l join public.regular_activities a on a.id = l.activity_id
   where l.kind = 'activity' and l.state = 'approved' and public.edition_participation_ok(l.id) and a.status = 'published' and not a.admin_paused;

revoke all on public.edition_public_businesses, public.edition_public_offers, public.edition_public_events, public.edition_public_activities from public, anon, authenticated;
grant select on public.edition_public_businesses, public.edition_public_offers, public.edition_public_events, public.edition_public_activities to anon, authenticated;

revoke all on function public.edition_participation_ok(uuid) from public, anon, authenticated;
grant execute on function public.edition_participation_ok(uuid) to anon, authenticated;

-- ── function privileges ─────────────────────────────────────────────────────────────────────────────────────────────

do $$ declare f text; begin
  foreach f in array array[
    'edition_controls_subject(text,uuid,uuid,uuid)', 'edition_link_controls(uuid)', 'edition_like_escape(text)',
    'edition_link_offers_guard()', 'edition_links_clear_offers()', 'edition_links_transition()', 'edition_links_immutable()',
    'edition_link_precheck(uuid,text,uuid)',
    'edition_find_businesses(uuid,text)', 'edition_find_activities(uuid,text)',
    'edition_invite_partner(uuid,text,uuid,text,text)', 'edition_request_to_join(uuid,text,uuid,text)',
    'edition_link_act(uuid,text,text)', 'edition_link_set_display(uuid,text,integer)',
    'edition_offer_options(uuid)', 'edition_set_link_offers(uuid,uuid[])',
    'edition_my_partnerships()', 'edition_partner_rows(uuid)', 'edition_my_pending_count()', 'edition_joinable()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'edition_controls_subject(text,uuid,uuid,uuid)', 'edition_link_controls(uuid)',
    'edition_find_businesses(uuid,text)', 'edition_find_activities(uuid,text)',
    'edition_invite_partner(uuid,text,uuid,text,text)', 'edition_request_to_join(uuid,text,uuid,text)',
    'edition_link_act(uuid,text,text)', 'edition_link_set_display(uuid,text,integer)',
    'edition_offer_options(uuid)', 'edition_set_link_offers(uuid,uuid[])',
    'edition_my_partnerships()', 'edition_partner_rows(uuid)', 'edition_my_pending_count()', 'edition_joinable()'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

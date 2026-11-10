-- Rolls back 20270102160000_editions_hub_partners.sql. Data written through the new features (Hub links, Hub items, Hub-run organisers) is removed or unlinked as stated; everything older is restored exactly as before.
drop view if exists public.edition_public_hub_items;
drop view if exists public.edition_public_hubs;
drop policy if exists "edition_links entity read" on public.edition_links;
drop policy if exists "edition_link_hub_items public read" on public.edition_link_hub_items;
drop policy if exists "edition_link_hub_items parties read" on public.edition_link_hub_items;
drop trigger if exists edition_link_hub_items_guard on public.edition_link_hub_items;
drop table if exists public.edition_link_hub_items;
-- Hub partnerships are removed (the older kinds are untouched)
delete from public.edition_links where kind = 'hub';
drop trigger if exists aa_edition_links_immutable on public.edition_links;
drop trigger if exists zz_edition_links_email on public.edition_links;
create or replace function public.edition_links_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.edition_id, new.kind, new.business_id, new.event_id, new.activity_id, new.initiated_by, new.created_by)
     is distinct from (old.edition_id, old.kind, old.business_id, old.event_id, old.activity_id, old.initiated_by, old.created_by) then
    raise exception 'a partnership''s subject and initiator cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create or replace function public.edition_links_clear_offers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.state = 'approved' and new.state <> 'approved' then delete from public.edition_link_offers where link_id = new.id; end if;
  return new;
end $$;
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
create trigger aa_edition_links_immutable before update on public.edition_links for each row execute function public.edition_links_immutable();
create policy "edition_links entity read" on public.edition_links for select to authenticated
  using (public.edition_controls_subject(kind, business_id, event_id, activity_id));
create or replace function public.edition_link_controls(p_link uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id) from public.edition_links l where l.id = p_link), false)
$$;
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
create or replace function public.edition_my_pending_count() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.edition_links l
   where auth.uid() is not null and l.state = 'pending' and l.initiated_by = 'organiser'
     and public.edition_controls_subject(l.kind, l.business_id, l.event_id, l.activity_id)
$$;
create or replace function public.edition_links_email() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_name text; v_ctrl uuid; u uuid; v_payload jsonb;
begin
  select * into e from public.editions where id = new.edition_id; select * into o from public.edition_organisers where id = e.organiser_id;
  v_name := public.edition_subject_name(new.kind, new.business_id, new.event_id, new.activity_id);
  v_ctrl := public.edition_subject_controller(new.kind, new.business_id, new.event_id, new.activity_id);
  v_payload := jsonb_build_object('edition_title', e.title, 'organiser_name', o.name, 'subject_kind', new.kind, 'subject_name', v_name, 'link_id', new.id);
  if tg_op = 'INSERT' then
    if new.state = 'pending' and new.initiated_by = 'organiser' then perform public.edition_enqueue_email('partner_invited', v_ctrl, 'pi:' || new.id, v_payload); end if;
    if new.state = 'pending' and new.initiated_by = 'entity' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_requested', u, 'pr:' || new.id || ':' || u, v_payload); end loop; end if;
  elsif new.state is distinct from old.state then
    if new.state in ('approved', 'declined') and old.state = 'pending' then
      if new.initiated_by = 'organiser' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_answered', u, 'pa:' || new.id || ':' || new.state || ':' || u, v_payload || jsonb_build_object('answer', new.state)); end loop;
      else perform public.edition_enqueue_email('partner_request_answered', v_ctrl, 'pq:' || new.id || ':' || new.state, v_payload || jsonb_build_object('answer', new.state)); end if;
    elsif new.state = 'withdrawn' and new.ended_by = 'entity' then
      for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_withdrew', u, 'pw:' || new.id || ':' || u, v_payload); end loop;
    elsif new.state = 'withdrawn' and new.ended_by = 'organiser' then perform public.edition_enqueue_email('partner_removed', v_ctrl, 'pm:' || new.id, v_payload);
    end if;
  end if;
  return new;
end $$;
create trigger zz_edition_links_email after insert or update of state on public.edition_links for each row execute function public.edition_links_email();
drop function if exists public.edition_find_hubs(uuid, text);
drop function if exists public.edition_hub_item_options(uuid);
drop function if exists public.edition_set_hub_items(uuid, uuid[], uuid[]);
drop function if exists public.edition_link_hub_items_guard();
drop function if exists public.edition_subject_controllers(text, uuid, uuid, uuid, uuid);
drop function if exists public.edition_subject_name(text, uuid, uuid, uuid, uuid);
drop function if exists public.edition_hub_admin_users(uuid);
drop function if exists public.edition_controls_subject(text, uuid, uuid, uuid, uuid);
drop function if exists public.edition_controls_hub(uuid);
drop index if exists public.edition_links_active_hub;
drop index if exists public.edition_links_hub_idx;
alter table public.edition_links drop constraint if exists edition_links_one_subject;
alter table public.edition_links drop constraint if exists edition_links_kind_check;
alter table public.edition_links drop column if exists hub_id;
alter table public.edition_links add constraint edition_links_kind_check check (kind in ('business', 'event', 'activity'));
alter table public.edition_links add constraint edition_links_one_subject check (
  (kind = 'business' and business_id is not null and event_id is null and activity_id is null) or
  (kind = 'event'    and event_id    is not null and business_id is null and activity_id is null) or
  (kind = 'activity' and activity_id is not null and business_id is null and event_id is null));

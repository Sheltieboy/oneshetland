-- Notices Stage 3A (step 1) - protect EXISTING app builds from non-published notices.
--
-- THE PROBLEM (reproduced in supabase/tests/notices-read-protection.node.test.ts against the Stage 2 state):
--   20261128000000 widened "notices read" so a person-author, the controllers of a hub / business, and staff could read their own pending / resolved /
--   withdrawn / scheduled notices straight from the table. Released app builds (144, 146 and the OTA stream) and the live website read the table
--   directly and never filter status or starts_at, so those rows would appear in the PUBLIC feeds of exactly those people - a person's pending notice
--   in their own feed (labelled "Member"), a withdrawn hub notice on the hub owner's home screen, every pending notice on an admin's.
--
-- THE FIX (database level, no client change needed):
--   1. "notices read" is back to a PUBLIC-ONLY rule for EVERYONE (staff included): published, not hidden, started, unexpired, visibility rules.
--      A direct table read can no longer return a non-public row, whoever asks. Old clients are protected without being updated.
--   2. Management reads move to SECURITY DEFINER functions that authorise the caller for ONE explicit scope (a hub they control, a business they own,
--      their own person notices, or - staff - everything) and return only that scope. manage_notices / manage_set_notice_status / manage_delete_notice.
--   3. notice_areas stays readable for the notice's own managers (it used to follow the parent's visibility, which is now public-only).
--   4. notice_person_label no longer treats "published" as enough: a name is disclosed to the public only while the person has a notice that is
--      CURRENTLY public (published, not hidden, started, unexpired, public visibility). Self and staff keep access for management screens.
--
-- UPDATE / DELETE policies are unchanged, but Postgres applies the SELECT policy to rows an UPDATE touches: the old row must be readable AND the new row
-- must still be readable. So a direct UPDATE that keeps a notice public (edit the text, pin it, change its category) still works, a direct DELETE of a
-- public notice still works, and a direct UPDATE that would make a notice non-public (withdraw, resolve, hide, send back to review) is refused by RLS
-- instead of silently succeeding. No released client does that (they only insert and delete). Those transitions, and anything on a row that is already
-- non-public (approve a pending person notice, delete a withdrawn one), go through manage_set_notice_status / manage_delete_notice.
-- Known and intended: an INSERT ... RETURNING of a row that is not yet public (a pending person notice, a scheduled hub notice) is likewise refused on the
-- RETURNING step; later publishing screens must submit through a function. Existing clients only ever insert immediately-public notices.
begin;

drop policy "notices read" on public.notices;
create policy "notices read" on public.notices for select using (
  (not is_hidden) and status = 'published'
  and (starts_at is null or starts_at <= now())
  and (expires_at is null or expires_at > now())
  and ( visibility = 'public'
        or (visibility = 'members'   and public.is_hub_member(publisher_hub_id, auth.uid()))
        or (visibility = 'committee' and public.is_hub_admin(publisher_hub_id, auth.uid())) )
);
-- The anon-safe wrapper only served the removed branch.
drop function public.controls_notice_publisher(uuid, uuid);

-- ── The pending-notice cap must count rows the author can no longer read ───────
-- tg_notices_attribution_guard is SECURITY INVOKER, so under the new read rule its count of the author's own PENDING notices saw none and the
-- cap of 5 was silently bypassed (caught by Stage 2 test 12). The count moves to a definer function that can only ever count the caller's own rows.
create function public.my_pending_person_notice_count() returns integer
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select count(*)::integer from public.notices where is_person_notice and publisher_user_id = auth.uid() and status = 'pending';
$f$;
revoke all on function public.my_pending_person_notice_count() from public, anon;
grant execute on function public.my_pending_person_notice_count() to authenticated, service_role;

create or replace function public.tg_notices_attribution_guard()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $function$
declare v_ok boolean; v_pending integer;
begin
  -- Service role, SECURITY DEFINER paths, migrations: unchanged (the trusted importer lives here).
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if public.attribution_staff() then return new; end if;

  if tg_op = 'INSERT' then
    if new.is_platform_notice then
      raise exception 'Only OneShetland staff can publish platform notices' using errcode = '42501';
    end if;
    if new.source is not null or new.source_reference is not null or new.source_url is not null or new.source_label is not null
       or new.source_published_at is not null or new.source_verified_at is not null then
      raise exception 'Official source fields are set by OneShetland staff or the importer only' using errcode = '42501';
    end if;
    if new.is_person_notice then
      if auth.uid() is null then raise exception 'Sign in to post a notice' using errcode = '42501'; end if;
      if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 0 then
        raise exception 'A personal notice cannot name a hub or business' using errcode = '42501';
      end if;
      if new.severity = 'urgent' then
        raise exception 'Only staff or an approved business can post urgent notices' using errcode = '42501';
      end if;
      if new.visibility <> 'public' or new.event_id is not null or new.campaign_id is not null then
        raise exception 'A personal notice is public and cannot link to a hub event or campaign' using errcode = '42501';
      end if;
      v_pending := public.my_pending_person_notice_count();
      if v_pending >= 5 then
        raise exception 'You already have 5 notices awaiting review' using errcode = '54000';
      end if;
      new.status := 'pending';                                   -- never self-published
    else
      if num_nonnulls(new.publisher_business_id, new.publisher_hub_id) <> 1 then
        raise exception 'A notice must belong to exactly one business or hub' using errcode = '42501';
      end if;
      if not public.controls_event_entity(new.publisher_business_id, new.publisher_hub_id) then
        raise exception 'You do not manage that business or hub' using errcode = '42501';
      end if;
      new.status := 'published';                                 -- existing behaviour: hub/business notices are immediate
    end if;
    if new.is_pinned or new.is_hidden or new.broadcast_at is not null or new.broadcast_by is not null then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    new.resolved_at := null; new.withdrawn_at := null;
    new.publisher_user_id := auth.uid();
  else
    if new.publisher_business_id is distinct from old.publisher_business_id
       or new.publisher_hub_id is distinct from old.publisher_hub_id
       or new.is_platform_notice is distinct from old.is_platform_notice
       or new.is_person_notice is distinct from old.is_person_notice then
      raise exception 'A notice''s publisher cannot be changed' using errcode = '42501';
    end if;
    if old.is_platform_notice then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    elsif old.is_person_notice then
      if old.publisher_user_id is distinct from auth.uid() then raise exception 'You no longer manage this notice' using errcode = '42501'; end if;
    elsif not public.controls_event_entity(old.publisher_business_id, old.publisher_hub_id) then
      raise exception 'You no longer manage this notice' using errcode = '42501';
    end if;
    if new.is_pinned is distinct from old.is_pinned or new.is_hidden is distinct from old.is_hidden
       or new.broadcast_at is distinct from old.broadcast_at or new.broadcast_by is distinct from old.broadcast_by then
      raise exception 'Pinning, hiding and broadcasting are staff-only' using errcode = '42501';
    end if;
    if new.source is distinct from old.source or new.source_reference is distinct from old.source_reference or new.source_url is distinct from old.source_url
       or new.source_label is distinct from old.source_label or new.source_published_at is distinct from old.source_published_at
       or new.source_verified_at is distinct from old.source_verified_at then
      raise exception 'Official source fields are set by OneShetland staff or the importer only' using errcode = '42501';
    end if;
    new.publisher_user_id := old.publisher_user_id;
    new.resolved_at := old.resolved_at; new.withdrawn_at := old.withdrawn_at;       -- server-stamped by tg_notices_lifecycle
    if new.status is distinct from old.status then
      if old.is_person_notice then
        if not (new.status = 'withdrawn' or (new.status = 'resolved' and old.status = 'published')) then
          raise exception 'Only OneShetland staff can approve a personal notice' using errcode = '42501';
        end if;
      elsif new.status = 'pending' then
        raise exception 'Only OneShetland staff can place a notice in review' using errcode = '42501';
      end if;
    end if;
    -- A personal notice that was approved goes back to review if its content is changed.
    if old.is_person_notice and old.status = 'published' and new.status = 'published'
       and (new.title is distinct from old.title or new.body is distinct from old.body or new.image_url is distinct from old.image_url
            or new.category is distinct from old.category) then
      new.status := 'pending';
    end if;
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
end $function$;

-- ── Management reads ──────────────────────────────────────────────────────────
create function public.manage_notices(p_scope text, p_id uuid default null, p_status text default null, p_limit integer default 100)
returns setof public.notices
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $f$
begin
  if auth.uid() is null then raise exception 'Sign in to manage notices' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('pending', 'published', 'resolved', 'withdrawn') then
    raise exception 'Unknown notice status' using errcode = '22023';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  if p_scope = 'hub' then
    if p_id is null or not (public.attribution_staff() or public.controls_event_entity(null, p_id)) then
      raise exception 'You do not manage that hub' using errcode = '42501';
    end if;
    return query select n.* from public.notices n where n.publisher_hub_id = p_id and (p_status is null or n.status = p_status)
                 order by n.is_pinned desc, n.published_at desc limit p_limit;
  elsif p_scope = 'business' then
    if p_id is null or not (public.attribution_staff() or public.controls_event_entity(p_id, null)) then
      raise exception 'You do not manage that business' using errcode = '42501';
    end if;
    return query select n.* from public.notices n where n.publisher_business_id = p_id and (p_status is null or n.status = p_status)
                 order by n.published_at desc limit p_limit;
  elsif p_scope = 'mine' then
    return query select n.* from public.notices n where n.is_person_notice and n.publisher_user_id = auth.uid() and (p_status is null or n.status = p_status)
                 order by n.created_at desc limit p_limit;
  elsif p_scope = 'all' then
    if not public.attribution_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
    return query select n.* from public.notices n where (p_status is null or n.status = p_status)
                 order by n.created_at desc limit p_limit;
  else
    raise exception 'Unknown scope (hub, business, mine, all)' using errcode = '22023';
  end if;
end;
$f$;

-- Status changes on notices the caller manages, including ones they can no longer read directly. The same rules as the guard trigger (which a
-- definer function bypasses, so they are restated here): staff may set any status; a person may only withdraw, or resolve a published notice;
-- a hub / business may publish, resolve or withdraw its own, but never place a notice in review and never lift one staff placed there.
create function public.manage_set_notice_status(p_notice uuid, p_status text) returns text
language plpgsql security definer set search_path to 'public', 'pg_temp' as $f$
declare n public.notices%rowtype; v_staff boolean;
begin
  if auth.uid() is null then raise exception 'Sign in to manage notices' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('pending', 'published', 'resolved', 'withdrawn') then
    raise exception 'Unknown notice status' using errcode = '22023';
  end if;
  select * into n from public.notices where id = p_notice for update;
  if not found then raise exception 'Notice not found' using errcode = '42501'; end if;   -- same answer as "not yours": no probing
  v_staff := public.attribution_staff();
  if not v_staff then
    if n.is_platform_notice then raise exception 'You do not manage that notice' using errcode = '42501'; end if;
    if n.is_person_notice then
      if n.publisher_user_id is distinct from auth.uid() then raise exception 'You do not manage that notice' using errcode = '42501'; end if;
      if not (p_status = 'withdrawn' or (p_status = 'resolved' and n.status = 'published')) then
        raise exception 'Only OneShetland staff can approve a personal notice' using errcode = '42501';
      end if;
    else
      if not public.controls_event_entity(n.publisher_business_id, n.publisher_hub_id) then
        raise exception 'You do not manage that notice' using errcode = '42501';
      end if;
      if p_status = 'pending' or n.status = 'pending' then
        raise exception 'Only OneShetland staff can change a notice that is in review' using errcode = '42501';
      end if;
    end if;
  end if;
  update public.notices set status = p_status where id = p_notice;   -- tg_notices_lifecycle stamps resolved_at / withdrawn_at / updated_at
  return p_status;
end;
$f$;

-- Delete a notice the caller manages (the DELETE policy's rule), including a non-public one that a plain DELETE .. WHERE cannot see.
create function public.manage_delete_notice(p_notice uuid) returns boolean
language plpgsql security definer set search_path to 'public', 'pg_temp' as $f$
declare n public.notices%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to manage notices' using errcode = '42501'; end if;
  select * into n from public.notices where id = p_notice;
  if not found then raise exception 'Notice not found' using errcode = '42501'; end if;
  if not (
       exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
       or (not n.is_platform_notice
           and ((n.is_person_notice and n.publisher_user_id = auth.uid())
                or (not n.is_person_notice and public.controls_event_entity(n.publisher_business_id, n.publisher_hub_id))))) then
    raise exception 'You do not manage that notice' using errcode = '42501';
  end if;
  delete from public.notices where id = p_notice;
  return true;
end;
$f$;

revoke all on function public.manage_notices(text, uuid, text, integer), public.manage_set_notice_status(uuid, text), public.manage_delete_notice(uuid) from public, anon;
grant execute on function public.manage_notices(text, uuid, text, integer), public.manage_set_notice_status(uuid, text), public.manage_delete_notice(uuid) to authenticated, service_role;

-- ── notice_areas: the notice's own managers can still read its areas ───────────
drop policy "notice areas read" on public.notice_areas;
create policy "notice areas read" on public.notice_areas for select to anon, authenticated
  using (exists (select 1 from public.notices n where n.id = notice_id) or public.can_edit_notice(notice_id));

-- ── Person identity: disclosed only while the person has a notice that is public NOW ──
create or replace function public.notice_person_label(p_user uuid) returns text
language sql stable security definer set search_path to 'public', 'pg_temp' as $f$
  select case
    when p_user is null then 'Former member'
    when p_user = auth.uid() or public.attribution_staff()
         or exists (select 1 from public.notices n
                     where n.is_person_notice and n.publisher_user_id = p_user
                       and n.status = 'published' and not n.is_hidden and n.visibility = 'public'
                       and (n.starts_at is null or n.starts_at <= now()) and (n.expires_at is null or n.expires_at > now()))
      then coalesce(nullif(btrim((select display_name from public.profiles where id = p_user)), ''), 'A OneShetland member')
    else 'A OneShetland member' end;
$f$;

commit;

-- Notices & Alerts step 6 - ordinary MEMBERS publish notices (moderated). LOCAL, additive, NOT applied.
--
-- The rules that already existed are unchanged and are re-stated here because these functions are SECURITY DEFINER (the attribution guard trusts definer paths,
-- so each rule is enforced in the function itself): a member posts as themselves; the notice starts PENDING and is invisible to the public (and to everyone
-- but its author and staff) until staff approve it; never urgent, never essential, never platform / hub / business, never linked to an event or campaign;
-- at most 5 pending at once; staff approve or decline; editing a published notice returns it to review (edit_my_person_notice, core migration).
--
-- AREA TARGETING keeps its three states (see person_notice_clean_areas): specific areas, explicit Shetland-wide ('shetland_wide'), or unspecified (no rows).
-- EXPIRY: optional. Left out, the notice runs for 30 days; at most 90.
begin;

create function public.submit_person_notice(p_title text, p_body text, p_category text, p_area_ids text[] default '{}', p_expires_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := gen_random_uuid(); v_areas text[];
begin
  if public.active_uid() is null then raise exception 'Sign in to post a notice' using errcode = '42501'; end if;
  p_title := btrim(coalesce(p_title, '')); p_body := btrim(coalesce(p_body, ''));
  if char_length(p_title) < 5 or char_length(p_title) > 120 then raise exception 'The title must be 5 to 120 characters' using errcode = '22023'; end if;
  if char_length(p_body) < 10 or char_length(p_body) > 2000 then raise exception 'The text must be 10 to 2000 characters' using errcode = '22023'; end if;
  if p_category is null or not exists (select 1 from public.notice_categories c where c.id = p_category and c.is_active) then raise exception 'Choose one of the listed categories' using errcode = '22023'; end if;
  v_areas := public.person_notice_clean_areas(p_area_ids);
  if p_expires_at is null then p_expires_at := now() + interval '30 days';
  elsif p_expires_at <= now() or p_expires_at > now() + interval '90 days' then raise exception 'The expiry must be in the future and within 90 days' using errcode = '22023'; end if;
  perform 1 from public.profiles where id = public.active_uid() for update;                      -- serialise this member's submissions so the limit cannot be raced
  if (select count(*) from public.notices where is_person_notice and publisher_user_id = public.active_uid() and status = 'pending') >= 5 then
    raise exception 'You already have 5 notices awaiting review' using errcode = '54000';
  end if;
  insert into public.notices (id, title, body, category, is_person_notice, publisher_user_id, status, expires_at)
  values (v_id, p_title, p_body, p_category, true, public.active_uid(), 'pending', p_expires_at);
  insert into public.notice_areas (notice_id, area_id) select v_id, a from unnest(v_areas) a;
  perform public.notice_audit('person_notice_submitted', null, v_id, null, jsonb_build_object('areas', v_areas));
  return v_id;
end $$;

-- A member's OWN notices in every state, with what they can do next. `state` is what the member should be told:
--   pending (awaiting approval) | published | expired | withdrawn (by them) | declined (by staff, with the reason) | resolved
create function public.my_person_notices() returns table (
  id uuid, title text, body text, category text, category_label text, state text, created_at timestamptz, published_at timestamptz, expires_at timestamptz,
  area_ids text[], area_names text[], decline_reason text, can_edit boolean, can_withdraw boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select n.id, n.title, n.body, n.category, c.label,
         case when n.status = 'withdrawn' and d.reason is not null then 'declined'
              when n.status = 'withdrawn' then 'withdrawn'
              when n.status = 'resolved' then 'resolved'
              when n.status = 'published' and n.expires_at is not null and n.expires_at <= now() then 'expired'
              else n.status end,
         n.created_at, case when n.status = 'pending' then null else n.published_at end, n.expires_at,
         coalesce((select array_agg(na.area_id order by na.area_id) from public.notice_areas na where na.notice_id = n.id), '{}'),
         coalesce((select array_agg(a.name_display order by a.name_display) from public.notice_areas na join public.areas a on a.id = na.area_id where na.notice_id = n.id), '{}'),
         d.reason,
         n.status in ('pending', 'published') and (n.expires_at is null or n.expires_at > now()),
         n.status in ('pending', 'published') and (n.expires_at is null or n.expires_at > now())
    from public.notices n
    left join public.notice_categories c on c.id = n.category
    left join lateral (select l.details ->> 'reason' as reason from public.notice_audit_log l
                        where l.notice_id = n.id and l.event = 'person_notice_declined' order by l.at desc limit 1) d on true
   where public.active_uid() is not null and n.is_person_notice and n.publisher_user_id = public.active_uid()
   order by n.created_at desc
   limit 100;
$$;

create function public.withdraw_my_person_notice(p_notice uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  if public.active_uid() is null then raise exception 'Sign in to manage your notices' using errcode = '42501'; end if;
  select * into n from public.notices where id = p_notice for update;
  if not found or not n.is_person_notice or n.publisher_user_id is distinct from public.active_uid() then raise exception 'You can only withdraw your own notices' using errcode = '42501'; end if;
  if n.status not in ('pending', 'published') then raise exception 'That notice is already closed' using errcode = '22023'; end if;
  update public.notices set status = 'withdrawn', withdrawn_at = now(), updated_at = now() where id = p_notice;
  perform public.notice_audit('person_notice_withdrawn', null, p_notice, null, jsonb_build_object('was', n.status));
end $$;

-- ── staff: the moderation queue, approve, decline ────────────────────────────────────────────────────────────────────────────────────────────
create function public.staff_pending_person_notices() returns table (
  id uuid, title text, body text, category_label text, created_at timestamptz, expires_at timestamptz, area_ids text[], area_names text[],
  author_name text, author_pending integer, edited boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return query
  select n.id, n.title, n.body, c.label, n.created_at, n.expires_at,
         coalesce((select array_agg(na.area_id order by na.area_id) from public.notice_areas na where na.notice_id = n.id), '{}'),
         coalesce((select array_agg(a.name_display order by a.name_display) from public.notice_areas na join public.areas a on a.id = na.area_id where na.notice_id = n.id), '{}'),
         coalesce(p.display_name, 'A OneShetland member'),
         (select count(*)::integer from public.notices x where x.is_person_notice and x.publisher_user_id = n.publisher_user_id and x.status = 'pending'),
         exists (select 1 from public.notice_audit_log l where l.notice_id = n.id and l.event = 'person_notice_edited')
    from public.notices n left join public.notice_categories c on c.id = n.category left join public.profiles p on p.id = n.publisher_user_id
   where n.is_person_notice and n.status = 'pending'
   order by n.created_at
   limit 200;
end $$;

create function public.staff_approve_person_notice(p_notice uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  if not public.notices_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  select * into n from public.notices where id = p_notice for update;
  if not found or not n.is_person_notice then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if n.status <> 'pending' then raise exception 'Only a notice awaiting approval can be approved' using errcode = '22023'; end if;
  if n.expires_at is not null and n.expires_at <= now() then raise exception 'This notice has already expired' using errcode = '22023'; end if;
  update public.notices set status = 'published', published_at = now(), updated_at = now() where id = p_notice;
  perform public.notice_audit('person_notice_approved', null, p_notice, null, '{}');
end $$;

create function public.staff_decline_person_notice(p_notice uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  if not public.notices_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  p_reason := btrim(coalesce(p_reason, ''));
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'Say why (5 to 500 characters): the member is shown this' using errcode = '22023'; end if;
  select * into n from public.notices where id = p_notice for update;
  if not found or not n.is_person_notice then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  if n.status <> 'pending' then raise exception 'Only a notice awaiting approval can be declined' using errcode = '22023'; end if;
  update public.notices set status = 'withdrawn', withdrawn_at = now(), updated_at = now() where id = p_notice;
  perform public.notice_audit('person_notice_declined', null, p_notice, null, jsonb_build_object('reason', p_reason));
end $$;

revoke all on function public.submit_person_notice(text, text, text, text[], timestamptz), public.my_person_notices(), public.withdraw_my_person_notice(uuid),
  public.staff_pending_person_notices(), public.staff_approve_person_notice(uuid), public.staff_decline_person_notice(uuid, text) from public, anon;
grant execute on function public.submit_person_notice(text, text, text, text[], timestamptz), public.my_person_notices(), public.withdraw_my_person_notice(uuid),
  public.staff_pending_person_notices(), public.staff_approve_person_notice(uuid), public.staff_decline_person_notice(uuid, text) to authenticated, service_role;

commit;

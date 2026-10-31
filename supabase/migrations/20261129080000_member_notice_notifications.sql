-- Notices & Alerts — moderator-controlled Community Notice notifications for members' personal notices.   NOT APPLIED.
--
-- POLICY (agreed 31 Oct 2026, docs/notices-account-deletion-and-retention.md §9): approving a member's notice NEVER sends a push. A moderator (or administrator)
-- may separately choose "Notify opted-in members", once per notice. This migration adds the 'member' audience to the existing dispatch machinery
-- (claim / deliveries / audit are unchanged and shared with the other audiences), plus:
--   * staff-only authorisation (moderator, administrator, platform owner; a CLOSED account is refused). No publisher entitlement exists or is introduced.
--   * eligibility: a published, public, unexpired, started, un-hidden PERSONAL notice with an EXPLICIT place (specific areas or explicit Shetland-wide).
--     A notice with no place chosen is never announced.
--   * ONE audience definition (notice_member_audience) used by the preview estimate AND the real dispatch, so the estimate cannot drift from what is sent:
--       opted in to Community Notices; category preference matches; follows an area that matches by parent/child (never siblings, never GPS; an explicit
--       Shetland-wide notice reaches members who have chosen ANY area); active account; a valid Expo device token; the master switch and the notices module
--       switch are on and quiet hours are not in force (should_notify, the same function the sender uses); fewer than 2 member notifications in the last 24 h.
--   * notice_push_gate: the same decision at send time, with the REASON, so a quiet-hours hold is recorded as held_quiet (the sender reports every refusal as
--     'skipped_pref'), a muted/closed/no-device recipient as skipped, and an error as failed. Never as sent.
--   * notice_member_reserve: an atomic per-recipient reservation (advisory lock) enforcing "at most 2 member notifications per recipient in any rolling 24 h"
--     even when two dispatches run at the same time. A recipient over the cap is recorded as skipped (daily_limit); there is NO catch-up.
--   * one notification per notice per recipient: notice_deliveries is keyed (notice, user), so several matching areas, retries and several devices give one.
--   * no re-notification after an edit: a completed dispatch for a notice can never be claimed again (existing rule), edits do not call it.
-- Nothing here sends a push. The Edge Function notify-notice-audience (not deployed) does, through the existing sender.
begin;

alter table public.notice_dispatches drop constraint notice_dispatches_kind_check;
alter table public.notice_dispatches add constraint notice_dispatches_kind_check check (kind in ('essential', 'official', 'community', 'hub', 'funeral', 'member'));

-- ── may THIS notice be announced RIGHT NOW to THIS audience? (unchanged for the other audiences; adds 'member') ──────────────────────────────────
create or replace function public.notice_dispatchable(p_notice uuid, p_kind text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype;
begin
  select * into n from public.notices where id = p_notice;
  if not found then return 'That notice does not exist'; end if;
  if n.source is not null then return 'Official source notices are never announced'; end if;                  -- imports are silent: product rule
  if n.status <> 'published' then return 'That notice is not published'; end if;
  if n.is_hidden then return 'That notice is hidden'; end if;
  if n.starts_at is not null and n.starts_at > now() then return 'That notice has not started yet'; end if;
  if n.expires_at is not null and n.expires_at <= now() then return 'That notice has expired'; end if;
  if p_kind = 'essential' then
    if not public.notice_essential_active(n) then return 'That is not an active Essential Alert'; end if;
  elsif p_kind = 'official' then
    if n.official_publisher_id is null or n.is_essential then return 'Only an organisation''s ordinary official notice goes to the official audience'; end if;
    if n.visibility <> 'public' then return 'That notice is not public'; end if;
  elsif p_kind = 'community' then
    if n.visibility <> 'public' then return 'That notice is not public'; end if;
    if n.is_platform_notice or n.is_person_notice or (n.publisher_hub_id is null and n.publisher_business_id is null) then
      return 'Only hub and business notices go to the community audience';
    end if;
  elsif p_kind = 'member' then
    if not n.is_person_notice or n.is_platform_notice or n.is_essential or n.publisher_hub_id is not null or n.publisher_business_id is not null then
      return 'Only a member''s own notice goes to the member audience';
    end if;
    if n.visibility <> 'public' then return 'That notice is not public'; end if;
    if not exists (select 1 from public.notice_areas where notice_id = p_notice) then return 'That notice has no place chosen, so it cannot be announced by area'; end if;
  elsif p_kind = 'hub' then
    if n.publisher_hub_id is null or n.is_platform_notice or n.is_person_notice then return 'That is not a hub notice'; end if;
    if n.visibility not in ('public', 'members') then return 'That notice is not for hub members'; end if;
  else
    return 'Unknown audience';
  end if;
  return null;
end $$;

-- ── who may ask for a dispatch (the edge function passes the verified caller). A CLOSED account may not, for any audience. ──────────────────────
create or replace function public.can_dispatch_notice(p_user uuid, p_notice uuid, p_kind text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_admin boolean;
begin
  select * into n from public.notices where id = p_notice;
  if not found or p_user is null or public.account_is_closed(p_user) then return false; end if;
  select exists (select 1 from public.profiles p where p.id = p_user and (p.role = 'admin' or coalesce(p.is_platform_owner, false))) into v_admin;
  if p_kind = 'essential' then
    return n.official_publisher_id is not null and (v_admin or exists (
      select 1 from public.official_publisher_members m join public.official_publishers o on o.id = m.publisher_id
       where m.publisher_id = n.official_publisher_id and m.user_id = p_user and m.is_active and m.role = 'publisher' and o.verified_at is not null and o.is_active
         and exists (select 1 from public.essential_alert_grants g where g.publisher_id = o.id and g.revoked_at is null)));
  elsif p_kind = 'official' then
    return n.official_publisher_id is not null and (v_admin or exists (
      select 1 from public.official_publisher_members m join public.official_publishers o on o.id = m.publisher_id
       where m.publisher_id = n.official_publisher_id and m.user_id = p_user and m.is_active and o.verified_at is not null and o.is_active));
  elsif p_kind in ('community', 'hub') then
    return v_admin
        or (n.publisher_hub_id is not null and public.is_hub_admin(n.publisher_hub_id, p_user))
        or (p_kind = 'community' and n.publisher_business_id is not null and public.is_business_owner(n.publisher_business_id, p_user));
  elsif p_kind = 'member' then
    -- STAFF ONLY (the existing moderation rule: moderator, administrator, platform owner). Never the author, never a publisher, never an organisation.
    return n.is_person_notice and exists (select 1 from public.profiles p where p.id = p_user and (p.role in ('admin', 'moderator') or coalesce(p.is_platform_owner, false)));
  end if;
  return false;
end $$;

-- ── can this person be sent a notification RIGHT NOW, and if not, why? (service role only; used by the audience AND at send time) ──────────────────
-- 'ok' | 'inactive' (closed account) | 'no_device' (no valid Expo token) | 'quiet_hours' | 'preferences_off' (master switch or the notices module is off)
-- should_notify is the SAME function the sender applies. Called with urgent = true it differs only by ignoring quiet hours, which is how a hold is told
-- apart from a mute. An error is NOT turned into permission: the caller treats it as a failure.
create function public.notice_push_gate(p_user uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_user is null or public.account_is_closed(p_user) or not exists (select 1 from public.profiles where id = p_user) then return 'inactive'; end if;
  if not exists (select 1 from public.push_tokens t where t.user_id = p_user and t.token like 'ExponentPushToken[%')
     and not exists (select 1 from public.profiles p where p.id = p_user and coalesce(to_jsonb(p)->>'push_token', '') like 'ExponentPushToken[%') then return 'no_device'; end if;
  if public.should_notify(p_user, 'notices', false) then return 'ok'; end if;
  if public.should_notify(p_user, 'notices', true) then return 'quiet_hours'; end if;
  return 'preferences_off';
end $$;

-- ── THE audience for a member notice (one definition: the preview estimate and the dispatch both call it) ───────────────────────────────────────
create function public.notice_member_audience(p_notice uuid) returns setof uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_wide boolean; v_nb text[];
begin
  if public.notice_dispatchable(p_notice, 'member') is not null then return; end if;               -- authoritative state, every call
  select * into n from public.notices where id = p_notice;
  select exists (select 1 from public.notice_areas where notice_id = p_notice and area_id = 'shetland_wide') into v_wide;
  select public.area_neighbourhood(coalesce(array_agg(area_id), '{}')) into v_nb from public.notice_areas where notice_id = p_notice and area_id <> 'shetland_wide';
  return query
    select distinct p.user_id
      from public.notice_notification_prefs p
      join public.profiles pr on pr.id = p.user_id and pr.deleted_at is null and coalesce(pr.is_active, true)
     where p.community_notices
       and (p.community_categories is null or n.category = any(p.community_categories))
       and (case when v_wide then exists (select 1 from public.member_areas ma where ma.user_id = p.user_id)
                 else exists (select 1 from public.member_areas ma where ma.user_id = p.user_id and ma.area_id = any(v_nb)) end)
       and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'notice' and d.subject_id = p_notice and d.user_id = p.user_id
                        and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
       and (select count(*) from public.notice_deliveries d2 where d2.user_id = p.user_id and d2.kind = 'member' and d2.subject_id <> p_notice
              and ((d2.status = 'sent' and d2.updated_at > now() - interval '24 hours') or (d2.status = 'pending' and d2.created_at > now() - interval '24 hours'))) < 2
       and public.notice_push_gate(p.user_id) = 'ok';
end $$;

create or replace function public.notice_dispatch_recipients(p_notice uuid, p_kind text, p_limit integer default 1000) returns table (user_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_wide boolean; v_nb text[];
begin
  if public.notice_dispatchable(p_notice, p_kind) is not null then return; end if;           -- the authoritative state, every time
  p_limit := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  if p_kind = 'member' then
    return query select a from public.notice_member_audience(p_notice) a limit p_limit;
    return;
  end if;
  select * into n from public.notices where id = p_notice;
  select exists (select 1 from public.notice_areas where notice_id = p_notice and area_id = 'shetland_wide') into v_wide;
  select public.area_neighbourhood(coalesce(array_agg(area_id), '{}')) into v_nb from public.notice_areas where notice_id = p_notice and area_id <> 'shetland_wide';
  if p_kind = 'hub' then
    return query select distinct hm.user_id from public.hub_members hm
                  where hm.hub_id = n.publisher_hub_id and hm.status = 'active' and (hm.paid_until is null or hm.paid_until > now())
                    and (n.visibility = 'public' or hm.role in ('member', 'committee', 'owner', 'admin'))
                    and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'notice' and d.subject_id = p_notice and d.user_id = hm.user_id and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
                  limit p_limit;
    return;
  end if;
  return query
    select distinct p.user_id
      from public.notice_notification_prefs p
     where case p_kind when 'essential' then p.essential_alerts when 'official' then p.official_notices when 'community' then p.community_notices else false end
       and (p_kind <> 'community' or p.community_categories is null or n.category = any(p.community_categories))
       and (v_wide or exists (select 1 from public.member_areas ma where ma.user_id = p.user_id and ma.area_id = any(v_nb)))
       and not exists (select 1 from public.notice_deliveries d where d.subject_type = 'notice' and d.subject_id = p_notice and d.user_id = p.user_id
                        and (d.status in ('sent', 'held_quiet', 'skipped') or d.attempts >= 3))
     limit p_limit;
end $$;

-- ── the push text (ONE source for the preview and the real push; no names, no personal details, no recipient data) ───────────────────────────────
create function public.notice_member_push_text(p_notice uuid) returns table (title text, body text)
language sql stable security definer set search_path = public, pg_temp as $$
  select left(regexp_replace(btrim(n.title), '\s+', ' ', 'g'), 110),
         case when exists (select 1 from public.notice_areas a where a.notice_id = n.id and a.area_id = 'shetland_wide')
              then 'A community notice for Shetland. Tap to read.' else 'A community notice for your area. Tap to read.' end
    from public.notices n where n.id = p_notice;
$$;

-- ── atomic reservation: at most TWO member notifications per recipient in any rolling 24 hours ───────────────────────────────────────────────────
-- Counts this person's 'member' deliveries for OTHER notices that were sent, or reserved (pending), in the last 24 h. The per-person advisory lock makes two
-- simultaneous dispatches queue here, so neither can read "1 of 2" and both proceed. A retry of the SAME notice re-reserves its own row. 'daily_limit' means:
-- do not send, record as skipped. There is no catch-up.
create function public.notice_member_reserve(p_notice uuid, p_user uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('member-push:' || p_user::text, 0));
  select status into v_status from public.notice_deliveries where subject_type = 'notice' and subject_id = p_notice and user_id = p_user;
  if v_status in ('sent', 'held_quiet', 'skipped') then return 'already'; end if;
  if (select count(*) from public.notice_deliveries d where d.user_id = p_user and d.kind = 'member' and d.subject_id <> p_notice
        and ((d.status = 'sent' and d.updated_at > now() - interval '24 hours') or (d.status = 'pending' and d.created_at > now() - interval '24 hours'))) >= 2 then
    return 'daily_limit';
  end if;
  insert into public.notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice', p_notice, p_user, 'member', 'pending')
  on conflict (subject_type, subject_id, user_id) do update set status = 'pending', updated_at = now() where public.notice_deliveries.status in ('failed', 'pending');
  return 'ok';
end $$;

-- ── staff: the published member notices and whether each can be announced ───────────────────────────────────────────────────────────────────────
create function public.staff_published_person_notices() returns table (
  id uuid, title text, category_label text, area_ids text[], area_names text[], area_state text, published_at timestamptz, expires_at timestamptz,
  can_notify boolean, reason text, dispatch_status text, delivery jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  return query
  select n.id, n.title, c.label, a.ids, a.names,
         case when cardinality(a.ids) = 0 then 'none' when a.ids = array['shetland_wide'] then 'shetland_wide' else 'specific' end,
         n.published_at, n.expires_at,
         (public.notice_dispatchable(n.id, 'member') is null and d.status is distinct from 'completed' and d.status is distinct from 'claimed'),
         coalesce(public.notice_dispatchable(n.id, 'member'), case when d.status = 'completed' then 'Members have already been notified about this notice' when d.status = 'claimed' then 'A notification is in progress' end),
         d.status,
         jsonb_build_object('sent', (select count(*) from public.notice_deliveries l where l.subject_type = 'notice' and l.subject_id = n.id and l.status = 'sent'),
                            'held_quiet', (select count(*) from public.notice_deliveries l where l.subject_type = 'notice' and l.subject_id = n.id and l.status = 'held_quiet'),
                            'skipped', (select count(*) from public.notice_deliveries l where l.subject_type = 'notice' and l.subject_id = n.id and l.status = 'skipped'),
                            'failed', (select count(*) from public.notice_deliveries l where l.subject_type = 'notice' and l.subject_id = n.id and l.status = 'failed'))
    from public.notices n
    left join public.notice_categories c on c.id = n.category
    cross join lateral (select coalesce(array_agg(na.area_id order by na.area_id), '{}') ids,
                               coalesce(array_agg(ar.name_display order by ar.name_display), '{}') names
                          from public.notice_areas na join public.areas ar on ar.id = na.area_id where na.notice_id = n.id) a
    left join public.notice_dispatches d on d.subject_type = 'notice' and d.subject_id = n.id and d.kind = 'member'
   where n.is_person_notice and n.status = 'published' and (n.expires_at is null or n.expires_at > now())
   order by n.published_at desc nulls last
   limit 100;
end $$;

-- ── staff: the confirmation preview. Counts and text only: no recipient, address or preference is ever returned. ───────────────────────────────
create function public.staff_member_notice_preview(p_notice uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_reason text; v_txt record; d public.notice_dispatches%rowtype; v_areas text[]; v_ids text[];
begin
  if not public.notices_staff() then raise exception 'Staff only' using errcode = '42501'; end if;
  select * into n from public.notices where id = p_notice;
  if not found or not n.is_person_notice then raise exception 'Unknown notice' using errcode = 'P0002'; end if;
  v_reason := public.notice_dispatchable(p_notice, 'member');
  select * into d from public.notice_dispatches where subject_type = 'notice' and subject_id = p_notice and kind = 'member';
  if v_reason is null and found and d.status in ('completed', 'claimed') then
    v_reason := case when d.status = 'completed' then 'Members have already been notified about this notice' else 'A notification is in progress' end;
  end if;
  select coalesce(array_agg(na.area_id order by na.area_id), '{}'), coalesce(array_agg(ar.name_display order by ar.name_display), '{}')
    into v_ids, v_areas from public.notice_areas na join public.areas ar on ar.id = na.area_id where na.notice_id = p_notice;
  select * into v_txt from public.notice_member_push_text(p_notice);
  return jsonb_build_object(
    'notice_id', n.id, 'title', n.title, 'status', n.status, 'published_at', n.published_at, 'expires_at', n.expires_at,
    'publisher', 'A OneShetland member',
    'area_state', case when cardinality(v_ids) = 0 then 'none' when v_ids = array['shetland_wide'] then 'shetland_wide' else 'specific' end,
    'areas', to_jsonb(v_areas),
    'push_title', v_txt.title, 'push_body', v_txt.body,
    'can_notify', v_reason is null, 'reason', v_reason,
    'estimate', case when v_reason is null then (select count(*) from public.notice_member_audience(p_notice)) else 0 end,
    'only_opted_in', true, 'daily_limit', 2);
end $$;

-- ── privileges ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.notice_push_gate(uuid), public.notice_member_audience(uuid), public.notice_member_push_text(uuid), public.notice_member_reserve(uuid, uuid),
  public.staff_published_person_notices(), public.staff_member_notice_preview(uuid) from public, anon, authenticated;
grant execute on function public.notice_push_gate(uuid), public.notice_member_audience(uuid), public.notice_member_push_text(uuid), public.notice_member_reserve(uuid, uuid) to service_role;
grant execute on function public.staff_published_person_notices(), public.staff_member_notice_preview(uuid) to authenticated, service_role;

commit;

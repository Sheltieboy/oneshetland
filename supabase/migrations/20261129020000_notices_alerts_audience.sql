-- Notices & Alerts - step 3: member areas, notice notification preferences, and server-side audience selection with idempotent, deduplicated dispatch.
--
-- DESIGN RULES (all enforced here, not in a client):
--   * Areas and consent are separate. Choosing areas (member_areas) NEVER turns on a notification; each audience is an explicit, default-OFF opt-in
--     (notice_notification_prefs). Browsing anonymously subscribes nobody. Location, IP and device are never read.
--   * A member with NO selected areas is handled explicitly: they receive Shetland-wide notices (if opted in) and nothing area-specific. They are never
--     treated as "following everything".
--   * Recipients are selected by the database from authoritative state at dispatch time. No function accepts a recipient list. Authority to dispatch is
--     decided by can_dispatch_notice(), not by the caller's claim.
--   * One push per notice per member, whatever the number of followed areas, matching subscriptions or devices: notice_deliveries is keyed (subject, user).
--   * One dispatch per notice per audience (notice_dispatches unique). Editing, resolving or re-saving a notice can never dispatch again: a completed
--     dispatch is final, and a withdrawn / resolved / hidden / expired / scheduled notice is not dispatchable at all.
--   * OFFICIAL IMPORTS REMAIN SILENT: a notice with source IS NOT NULL is refused by notice_dispatchable(), by the claim, by the recipient query, and by a
--     trigger on notice_deliveries - four independent layers, none of which an alternative route can skip.
--   * Master switch, the notices module toggle, quiet hours, device tokens and the notification inbox stay exactly as they are: the SENDER (sendUserPush ->
--     should_notify) still applies them to every recipient this migration selects. This migration never bypasses quiet hours.
-- NOTHING here sends a push; the edge functions in this change do, through the existing sender, and are not deployed.
begin;

-- ── member areas ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.member_areas (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  area_id    text not null references public.areas(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, area_id)
);
create index member_areas_area_idx on public.member_areas (area_id);

create table public.notice_notification_prefs (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  essential_alerts     boolean not null default false,
  official_notices     boolean not null default false,
  community_notices    boolean not null default false,
  community_categories text[],                       -- NULL = every community category; otherwise only these notice_categories ids
  funeral_notices      boolean not null default false,
  updated_at           timestamptz not null default now()
);

alter table public.member_areas enable row level security;
alter table public.notice_notification_prefs enable row level security;
create policy "own areas read" on public.member_areas for select to authenticated using (user_id = public.active_uid());
create policy "own prefs read" on public.notice_notification_prefs for select to authenticated using (user_id = public.active_uid());
revoke all on public.member_areas, public.notice_notification_prefs from anon, authenticated;
grant select on public.member_areas, public.notice_notification_prefs to authenticated;      -- writes only through the validating functions below

create function public.set_my_notice_areas(p_areas text[]) returns text[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_clean text[];
begin
  if public.active_uid() is null then raise exception 'Sign in to choose your areas' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct a), '{}') into v_clean from unnest(coalesce(p_areas, '{}')) a;
  if cardinality(v_clean) > 12 then raise exception 'Choose at most 12 areas' using errcode = '54000'; end if;
  if exists (select 1 from unnest(v_clean) a where not exists (select 1 from public.areas x where x.id = a and x.is_active and x.is_physical)) then
    raise exception 'Choose real Shetland areas (Shetland-wide notices reach everyone who has opted in)' using errcode = '22023';
  end if;
  delete from public.member_areas where user_id = public.active_uid() and not (area_id = any(v_clean));
  insert into public.member_areas (user_id, area_id) select public.active_uid(), a from unnest(v_clean) a on conflict do nothing;
  return v_clean;
end $$;

create function public.my_notice_areas() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(area_id order by area_id), '{}') from public.member_areas where user_id = public.active_uid();
$$;

-- Preferences: every parameter is optional (NULL = leave unchanged); the row starts with everything OFF. p_all_community_categories = true clears the
-- category filter (receive every community category).
create function public.set_my_notice_prefs(
  p_essential boolean default null, p_official boolean default null, p_community boolean default null, p_categories text[] default null,
  p_funeral boolean default null, p_all_community_categories boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.active_uid() is null then raise exception 'Sign in to choose your notifications' using errcode = '42501'; end if;
  if p_categories is not null and exists (select 1 from unnest(p_categories) c where not exists (select 1 from public.notice_categories x where x.id = c and x.is_active)) then
    raise exception 'Unknown notice category' using errcode = '22023';
  end if;
  insert into public.notice_notification_prefs (user_id) values (public.active_uid()) on conflict do nothing;
  update public.notice_notification_prefs set
    essential_alerts  = coalesce(p_essential, essential_alerts), official_notices = coalesce(p_official, official_notices),
    community_notices = coalesce(p_community, community_notices), funeral_notices = coalesce(p_funeral, funeral_notices),
    community_categories = case when p_all_community_categories then null when p_categories is not null then p_categories else community_categories end,
    updated_at = now()
   where user_id = public.active_uid();
  return public.my_notice_prefs();
end $$;

create function public.my_notice_prefs() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public.active_uid() is null then raise exception 'Sign in to see your notification settings' using errcode = '42501'; end if;   -- also refuses a token whose account has been closed
  return coalesce((select jsonb_build_object('essential_alerts', essential_alerts, 'official_notices', official_notices, 'community_notices', community_notices,
                                             'community_categories', community_categories, 'funeral_notices', funeral_notices)
                     from public.notice_notification_prefs where user_id = public.active_uid()),
                  jsonb_build_object('essential_alerts', false, 'official_notices', false, 'community_notices', false, 'community_categories', null, 'funeral_notices', false));
end $$;

-- ── dispatch records ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.notice_dispatches (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('notice', 'funeral')),
  subject_id    uuid not null,
  kind          text not null check (kind in ('essential', 'official', 'community', 'hub', 'funeral')),
  claimed_by    uuid,
  claimed_at    timestamptz not null default now(),
  completed_at  timestamptz,
  status        text not null default 'claimed' check (status in ('claimed', 'completed', 'failed')),
  recipients    integer, sent integer, held integer, failed integer,
  error         text,
  unique (subject_type, subject_id, kind)
);
create table public.notice_deliveries (
  subject_type  text not null check (subject_type in ('notice', 'funeral')),
  subject_id    uuid not null,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'held_quiet', 'skipped', 'failed')),
  attempts      integer not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (subject_type, subject_id, user_id)
);
create index notice_deliveries_user_idx on public.notice_deliveries (user_id);
alter table public.notice_dispatches enable row level security;
alter table public.notice_deliveries enable row level security;
revoke all on public.notice_dispatches, public.notice_deliveries from anon, authenticated;

-- ── may THIS notice be announced RIGHT NOW to THIS audience? (authoritative database state; null = yes, otherwise the reason) ────────────────────
create function public.notice_dispatchable(p_notice uuid, p_kind text) returns text
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
  elsif p_kind = 'hub' then
    if n.publisher_hub_id is null or n.is_platform_notice or n.is_person_notice then return 'That is not a hub notice'; end if;
    if n.visibility not in ('public', 'members') then return 'That notice is not for hub members'; end if;
  else
    return 'Unknown audience';
  end if;
  return null;
end $$;

-- ── who may ask for a dispatch (explicit user: the edge function passes the verified caller; nothing is trusted from the request) ────────────────
create function public.can_dispatch_notice(p_user uuid, p_notice uuid, p_kind text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_admin boolean;
begin
  select * into n from public.notices where id = p_notice;
  if not found or p_user is null then return false; end if;
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
  end if;
  return false;
end $$;

-- ── claim: one dispatch per notice per audience, ever. A crashed run can be RESUMED (same row), a completed one never repeats. ─────────────────────
create function public.notice_claim_dispatch(p_notice uuid, p_kind text, p_by uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text := public.notice_dispatchable(p_notice, p_kind); v_row public.notice_dispatches%rowtype;
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '22023'; end if;
  select * into v_row from public.notice_dispatches where subject_type = 'notice' and subject_id = p_notice and kind = p_kind for update;
  if found then
    if v_row.status = 'completed' then raise exception 'Already announced' using errcode = '23505'; end if;
    if v_row.status = 'claimed' and v_row.claimed_at > now() - interval '10 minutes' then raise exception 'A dispatch is already in progress' using errcode = '23505'; end if;
    update public.notice_dispatches set status = 'claimed', claimed_at = now(), error = null where id = v_row.id;       -- resume a failed / stale run
    return v_row.id;
  end if;
  insert into public.notice_dispatches (subject_type, subject_id, kind, claimed_by) values ('notice', p_notice, p_kind, p_by) returning id into v_row.id;
  perform public.notice_audit('dispatch_claimed', null, p_notice, null, jsonb_build_object('kind', p_kind, 'by', p_by));
  return v_row.id;
end $$;

-- ── the audience (SERVER-selected; re-checks eligibility on every call, so a notice withdrawn mid-run yields nobody) ──────────────────────────────
create function public.notice_dispatch_recipients(p_notice uuid, p_kind text, p_limit integer default 1000) returns table (user_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n public.notices%rowtype; v_wide boolean; v_nb text[];
begin
  if public.notice_dispatchable(p_notice, p_kind) is not null then return; end if;           -- the authoritative state, every time
  select * into n from public.notices where id = p_notice;
  select exists (select 1 from public.notice_areas where notice_id = p_notice and area_id = 'shetland_wide') into v_wide;
  select public.area_neighbourhood(coalesce(array_agg(area_id), '{}')) into v_nb from public.notice_areas where notice_id = p_notice and area_id <> 'shetland_wide';
  p_limit := least(greatest(coalesce(p_limit, 1000), 1), 5000);
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

-- ── record one delivery outcome (a 'sent' row is final: nothing can downgrade or repeat it) ─────────────────────────────────────────────────────
create function public.notice_record_delivery(p_notice uuid, p_user uuid, p_kind text, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('sent', 'held_quiet', 'skipped', 'failed') then raise exception 'Unknown delivery status' using errcode = '22023'; end if;
  insert into public.notice_deliveries (subject_type, subject_id, user_id, kind, status, attempts, last_error)
  values ('notice', p_notice, p_user, p_kind, p_status, case when p_status = 'failed' then 1 else 0 end, left(p_error, 300))
  on conflict (subject_type, subject_id, user_id) do update
    set status = excluded.status, attempts = public.notice_deliveries.attempts + case when excluded.status = 'failed' then 1 else 0 end,
        last_error = excluded.last_error, updated_at = now()
    where public.notice_deliveries.status not in ('sent', 'held_quiet', 'skipped');
end $$;

create function public.notice_complete_dispatch(p_dispatch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.notice_dispatches%rowtype;
begin
  select * into d from public.notice_dispatches where id = p_dispatch for update;
  if not found then raise exception 'Unknown dispatch' using errcode = 'P0002'; end if;
  update public.notice_dispatches x set status = 'completed', completed_at = now(),
    recipients = (select count(*) from public.notice_deliveries l where l.subject_type = d.subject_type and l.subject_id = d.subject_id),
    sent = (select count(*) from public.notice_deliveries l where l.subject_type = d.subject_type and l.subject_id = d.subject_id and l.status = 'sent'),
    held = (select count(*) from public.notice_deliveries l where l.subject_type = d.subject_type and l.subject_id = d.subject_id and l.status = 'held_quiet'),
    failed = (select count(*) from public.notice_deliveries l where l.subject_type = d.subject_type and l.subject_id = d.subject_id and l.status = 'failed')
   where x.id = p_dispatch;
  perform public.notice_audit('dispatch_completed', null, case when d.subject_type = 'notice' then d.subject_id end, case when d.subject_type = 'funeral' then d.subject_id end,
                              jsonb_build_object('kind', d.kind));
end $$;

create function public.notice_fail_dispatch(p_dispatch uuid, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.notice_dispatches set status = 'failed', error = left(p_error, 300) where id = p_dispatch and status = 'claimed';
$$;

-- ── last line of defence: no delivery row can ever be written for an imported (or non-existent) notice ──────────────────────────────────────────
create function public.tg_notice_deliveries_silence_imports() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.subject_type = 'notice' and exists (select 1 from public.notices n where n.id = new.subject_id and n.source is not null) then
    raise exception 'Official source notices are never announced' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger notice_deliveries_silence_imports before insert on public.notice_deliveries for each row execute function public.tg_notice_deliveries_silence_imports();

-- ── what happened to a notice (administrators) ───────────────────────────────────────────────────────────────────────────────────────────────────
create function public.admin_notice_dispatch_history(p_notice uuid)
returns table (kind text, status text, claimed_at timestamptz, completed_at timestamptz, recipients integer, sent integer, held integer, failed integer, error text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.notices_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query select d.kind, d.status, d.claimed_at, d.completed_at, d.recipients, d.sent, d.held, d.failed, d.error
                 from public.notice_dispatches d where d.subject_type = 'notice' and d.subject_id = p_notice order by d.claimed_at;
end $$;

-- An organisation's OWN notices in every state (including scheduled, resolved and withdrawn, which are not public), for its members and platform administrators.
create function public.my_official_notices(p_publisher uuid)
returns table (id uuid, title text, body text, status text, severity text, is_essential boolean, category text, starts_at timestamptz, expires_at timestamptz, review_at timestamptz,
               published_at timestamptz, action_text text, link_url text, area_ids text[], announced boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public.official_publisher_authority(p_publisher) = 'none' and not public.notices_admin() then raise exception 'You are not authorised to see that organisation''s notices' using errcode = '42501'; end if;
  return query
    select n.id, n.title, n.body, n.status, n.severity, n.is_essential, n.category, n.starts_at, n.expires_at, n.review_at, n.published_at, n.action_text, n.link_url,
           coalesce((select array_agg(na.area_id order by na.area_id) from public.notice_areas na where na.notice_id = n.id), '{}'),
           exists (select 1 from public.notice_dispatches d where d.subject_type = 'notice' and d.subject_id = n.id and d.status = 'completed')
      from public.notices n where n.official_publisher_id = p_publisher order by n.created_at desc limit 200;
end $$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.set_my_notice_areas(text[]), public.my_notice_areas(), public.set_my_notice_prefs(boolean, boolean, boolean, text[], boolean, boolean),
  public.my_notice_prefs(), public.notice_dispatchable(uuid, text), public.can_dispatch_notice(uuid, uuid, text), public.notice_claim_dispatch(uuid, text, uuid),
  public.notice_dispatch_recipients(uuid, text, integer), public.notice_record_delivery(uuid, uuid, text, text, text), public.notice_complete_dispatch(uuid),
  public.notice_fail_dispatch(uuid, text), public.admin_notice_dispatch_history(uuid), public.my_official_notices(uuid) from public, anon, authenticated;
grant execute on function public.set_my_notice_areas(text[]), public.my_notice_areas(), public.set_my_notice_prefs(boolean, boolean, boolean, text[], boolean, boolean),
  public.my_notice_prefs(), public.admin_notice_dispatch_history(uuid), public.my_official_notices(uuid) to authenticated;
-- dispatch machinery: the service role (edge functions) only. Not callable by any client, so no client can choose recipients or mark anything delivered.
grant execute on function public.notice_dispatchable(uuid, text), public.can_dispatch_notice(uuid, uuid, text), public.notice_claim_dispatch(uuid, text, uuid),
  public.notice_dispatch_recipients(uuid, text, integer), public.notice_record_delivery(uuid, uuid, text, text, text), public.notice_complete_dispatch(uuid),
  public.notice_fail_dispatch(uuid, text) to service_role;

-- ── account deletion: remove ONE member's notice areas, notice preferences and delivery history ─────────────────────────────────────────────
-- The delete-account Edge Function soft-deletes (it scrubs the profile and keeps the row), so these tables' ON DELETE CASCADE never fires. The tables are locked
-- against every client AND the service role's direct table access (RLS, no grants), so the function calls this instead. It acts ONLY on the id it is given, and
-- only the service role can call it (the function passes the authenticated caller's own id, taken from their JWT). Returns what it removed, for the function's log.
create function public.delete_member_notice_data(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a integer; p integer; d integer;
begin
  if p_user is null then raise exception 'A member id is required' using errcode = '22023'; end if;
  delete from public.member_areas where user_id = p_user; get diagnostics a = row_count;
  delete from public.notice_notification_prefs where user_id = p_user; get diagnostics p = row_count;
  delete from public.notice_deliveries where user_id = p_user; get diagnostics d = row_count;
  return jsonb_build_object('member_areas', a, 'notice_notification_prefs', p, 'notice_deliveries', d);
end $$;
revoke all on function public.delete_member_notice_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_member_notice_data(uuid) to service_role;

commit;

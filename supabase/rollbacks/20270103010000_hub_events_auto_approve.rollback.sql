-- Rollback of 20270103010000_hub_events_auto_approve: event and activity moderation reads the Hub verification badge again (as before). Run only if that coupling is wanted back.
CREATE OR REPLACE FUNCTION public.tg_lock_hub_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    new.is_verified       := false;
    new.payout_enabled    := false;
    new.stripe_account_id := null;
    return new;
  end if;

  new.is_verified       := old.is_verified;
  new.payout_enabled    := old.payout_enabled;
  new.stripe_account_id := old.stripe_account_id;
  new.owner_id          := old.owner_id;
  new.slug              := old.slug;
  new.created_at        := old.created_at;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tg_events_sync_hidden()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.tg_ra_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_hub_verified boolean := false;
  v_privileged boolean := current_user not in ('authenticated', 'anon') or public.attribution_staff();
  v_base text;
  v_slug text;
  v_n int := 1;
begin
  new.updated_at := now();

  -- Slug: set once, never changed (URLs are forever), unique.
  if tg_op = 'INSERT' then
    v_base := left(trim(both '-' from lower(regexp_replace(coalesce(new.title, 'activity'), '[^a-zA-Z0-9]+', '-', 'g'))), 60);
    if v_base = '' then v_base := 'activity'; end if;
    v_slug := v_base;
    while exists (select 1 from public.regular_activities where slug = v_slug) loop
      v_n := v_n + 1; v_slug := v_base || '-' || v_n;
    end loop;
    if new.slug is null or not v_privileged then new.slug := v_slug; end if;
  else
    new.slug := old.slug;
  end if;

  if new.organiser_hub_id is not null then
    select coalesce(is_verified, false) into v_hub_verified from public.hubs where id = new.organiser_hub_id;
  end if;

  if v_privileged then
    -- Staff and server paths: the CHECK still holds. A verified hub is approved automatically.
    if new.organiser_hub_id is not null and v_hub_verified then new.calendar_approved := true; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_platform_activity then raise exception 'Only OneShetland staff can create platform activities' using errcode = '42501'; end if;
    if num_nonnulls(new.organiser_business_id, new.organiser_hub_id) <> 1 then
      raise exception 'An activity must belong to exactly one business or hub' using errcode = '42501';
    end if;
    if not public.controls_event_entity(new.organiser_business_id, new.organiser_hub_id) then
      raise exception 'You do not manage that business or hub' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.admin_paused := false; new.admin_pause_reason := null; new.admin_paused_by := null; new.admin_paused_at := null;
    new.calendar_approved := v_hub_verified and new.organiser_hub_id is not null; new.calendar_approved_by := null; new.calendar_approved_at := null;
    return new;
  end if;

  -- UPDATE by a client
  if new.organiser_business_id is distinct from old.organiser_business_id
     or new.organiser_hub_id is distinct from old.organiser_hub_id
     or new.is_platform_activity is distinct from old.is_platform_activity then
    raise exception 'An activity''s owner cannot be changed here' using errcode = '42501';
  end if;
  if old.is_platform_activity or not public.controls_event_entity(old.organiser_business_id, old.organiser_hub_id) then
    raise exception 'You no longer manage this activity' using errcode = '42501';
  end if;
  new.created_by := old.created_by;
  new.admin_paused := old.admin_paused; new.admin_pause_reason := old.admin_pause_reason;
  new.admin_paused_by := old.admin_paused_by; new.admin_paused_at := old.admin_paused_at;
  new.calendar_approved_by := old.calendar_approved_by; new.calendar_approved_at := old.calendar_approved_at;
  new.calendar_approved := old.calendar_approved or (new.organiser_hub_id is not null and v_hub_verified);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_assign_activity_owner(p_activity_id uuid, p_business_id uuid, p_hub_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  a public.regular_activities;
  v_from text; v_to text;
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can hand over an activity' using errcode = '42501'; end if;
  if v_reason is null or char_length(v_reason) < 10 then raise exception 'Say why (at least 10 characters)' using errcode = '22023'; end if;
  if num_nonnulls(p_business_id, p_hub_id) <> 1 then raise exception 'Choose exactly one business or hub' using errcode = '22023'; end if;
  select * into a from public.regular_activities where id = p_activity_id for update;
  if not found then raise exception 'No such activity' using errcode = 'P0002'; end if;
  if p_business_id is not null and not exists (select 1 from public.local_businesses where id = p_business_id) then raise exception 'No such business' using errcode = 'P0002'; end if;
  if p_hub_id is not null and not exists (select 1 from public.hubs where id = p_hub_id) then raise exception 'No such hub' using errcode = 'P0002'; end if;

  v_from := case when a.is_platform_activity then 'platform' when a.organiser_hub_id is not null then 'hub:' || a.organiser_hub_id when a.organiser_business_id is not null then 'business:' || a.organiser_business_id end;
  v_to   := case when p_hub_id is not null then 'hub:' || p_hub_id else 'business:' || p_business_id end;

  update public.regular_activities
     set is_platform_activity = false, organiser_business_id = p_business_id, organiser_hub_id = p_hub_id,
         -- A hub's activity is public only once the hub is verified or staff approve it: handover does not skip that gate.
         calendar_approved = (p_hub_id is not null and coalesce((select is_verified from public.hubs where id = p_hub_id), false)),
         calendar_approved_by = null, calendar_approved_at = null
   where id = p_activity_id;
  insert into public.activity_owner_log (activity_id, kind, from_owner, to_owner, reason, actor)
  values (p_activity_id, 'handover', v_from, v_to, v_reason, auth.uid());
  return jsonb_build_object('activity_id', p_activity_id, 'from', v_from, 'to', v_to);
end;
$function$;

drop function if exists public.admin_set_hub_events_auto_approve(uuid, boolean, text);
alter table public.hubs drop column if exists events_auto_approve;

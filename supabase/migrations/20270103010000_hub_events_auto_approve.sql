-- Hub verification and event moderation become two separate decisions.
--
-- Until now a Hub's "verified" badge ALSO auto-approved its islands-wide events and regular activities (three functions read hubs.is_verified). Verification is a trust badge; skipping
-- event moderation is a separate, deliberate privilege. This migration adds hubs.events_auto_approve (default FALSE for every Hub, administrator-only, audited) and points the three
-- functions at it. Nothing changes for any existing Hub: no Hub was verified before this week's testing and no event is auto-approved today. The Editions approval flow never reads or writes
-- either flag, so neither an Edition approval nor a verification action can change event moderation.
-- Expand-only. Rollback: supabase/rollbacks/20270103010000_hub_events_auto_approve.rollback.sql

alter table public.hubs add column if not exists events_auto_approve boolean not null default false;
grant select (events_auto_approve) on public.hubs to authenticated;

-- locked like is_verified: only trusted writers (service role, definer functions, administrators) can change it
CREATE OR REPLACE FUNCTION public.tg_lock_hub_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    new.is_verified       := false;
    new.events_auto_approve := false;
    new.payout_enabled    := false;
    new.stripe_account_id := null;
    return new;
  end if;

  new.is_verified       := old.is_verified;
  new.events_auto_approve := old.events_auto_approve;
  new.payout_enabled    := old.payout_enabled;
  new.stripe_account_id := old.stripe_account_id;
  new.owner_id          := old.owner_id;
  new.slug              := old.slug;
  new.created_at        := old.created_at;
  return new;
end;
$function$;

-- the three event-moderation functions read the new switch instead of the verification badge
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
    select events_auto_approve into v_verified from public.hubs where id = new.organiser_hub_id;
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
    select coalesce(events_auto_approve, false) into v_hub_verified from public.hubs where id = new.organiser_hub_id;
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
         calendar_approved = (p_hub_id is not null and coalesce((select events_auto_approve from public.hubs where id = p_hub_id), false)),
         calendar_approved_by = null, calendar_approved_at = null
   where id = p_activity_id;
  insert into public.activity_owner_log (activity_id, kind, from_owner, to_owner, reason, actor)
  values (p_activity_id, 'handover', v_from, v_to, v_reason, auth.uid());
  return jsonb_build_object('activity_id', p_activity_id, 'from', v_from, 'to', v_to);
end;
$function$;

create or replace function public.admin_set_hub_events_auto_approve(p_hub uuid, p_on boolean, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hubs%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'a note is required' using errcode = '23514', hint = 'note_required'; end if;
  select * into h from public.hubs where id = p_hub for update;
  if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
  if h.events_auto_approve is not distinct from coalesce(p_on, false) then raise exception 'the Hub is already in that state' using errcode = '23514', hint = 'no_change'; end if;
  update public.hubs set events_auto_approve = coalesce(p_on, false) where id = p_hub;
  perform public.edition_audit(null, null, case when p_on then 'hub_events_auto_approve_on' else 'hub_events_auto_approve_off' end,
    jsonb_build_object('hub_id', p_hub, 'hub_name', h.name, 'note', btrim(p_note)));
end $$;
revoke all on function public.admin_set_hub_events_auto_approve(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_set_hub_events_auto_approve(uuid, boolean, text) to authenticated;

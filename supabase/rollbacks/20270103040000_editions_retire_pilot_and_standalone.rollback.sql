-- Rollback of 20270103040000_editions_retire_pilot_and_standalone: recreates the pilot table and functions (empty: history lives in the audit log) and the retired organiser functions.
-- Run BEFORE the rollbacks of 20270103030000 downward. The pilot switch is restored as OFF.
do $$ begin
  alter table public.edition_organisers drop constraint if exists edition_organisers_one_parent;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'edition_organisers' and column_name = 'business_id') then
    alter table public.edition_organisers add constraint edition_organisers_one_parent check (num_nonnulls(hub_id, business_id) = 1) not valid;
  end if;
end $$;
grant update (name) on public.edition_organisers to authenticated;
-- OneShetland Editions: CONTROLLED PILOT. A scoped, administrator-only way for ONE approved organiser or Hub to be publicly visible while Editions stays dark for everyone else.
--
-- The model, in one paragraph. `editions.enabled` keeps its meaning (open to everybody) and is untouched. A second switch, `editions.pilot`, only matters together with a per-organiser
-- APPROVAL row. An Edition is public in the pilot when: the pilot switch is on AND the organiser holds a live approval AND the organiser is verified and not a test AND (for a Hub-run
-- organiser) the Hub is active and verified AND, as always, the Edition is published, not a test, and holds a live publish entitlement. Turning the pilot switch on therefore exposes
-- nothing by itself. Suspending the Hub, withdrawing the approval, letting the entitlement lapse or switching the pilot off each end public access at once (everything is evaluated at read time).
--
-- What this migration deliberately does NOT touch: the dark-launch guard (organiser creation stays administrator-only), edition_commerce_enabled (payments need `editions.enabled`, so they
-- stay impossible in the pilot), edition_tier_public (membership tiers stay hidden), every business/member/content privacy policy. Additive: one table, five functions, and two
-- redefinitions that add an OR-branch to an existing read predicate.

-- ── the switch and the approvals ────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.editions_pilot() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(c.value)) = 'true' from public.admin_config c where c.key = 'editions.pilot'), false)
$$;

create table if not exists public.edition_pilot_approvals (
  id            uuid primary key default gen_random_uuid(),
  organiser_id  uuid not null references public.edition_organisers (id) on delete cascade,
  approved_by   uuid not null references auth.users (id),
  approved_at   timestamptz not null default now(),
  note          text not null check (char_length(btrim(note)) >= 5),
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users (id),
  revoke_reason text,
  constraint edition_pilot_revoke_complete check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null or char_length(btrim(coalesce(revoke_reason, ''))) >= 5))
);
-- one live approval per organiser; history of withdrawn ones is kept
create unique index if not exists edition_pilot_one_live_approval on public.edition_pilot_approvals (organiser_id) where revoked_at is null;

alter table public.edition_pilot_approvals enable row level security;
revoke all on public.edition_pilot_approvals from public, anon, authenticated;
drop policy if exists "edition_pilot_approvals admin read" on public.edition_pilot_approvals;
create policy "edition_pilot_approvals admin read" on public.edition_pilot_approvals for select to authenticated using (coalesce(public.is_admin(), false));
grant select on public.edition_pilot_approvals to authenticated;

-- Approvals are append-only except for withdrawal.
create or replace function public.edition_pilot_approvals_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'pilot approvals cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'revoked_at' - 'revoked_by' - 'revoke_reason') is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_by' - 'revoke_reason') or old.revoked_at is not null then
    raise exception 'pilot approvals are append-only (only a first withdrawal is allowed)' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists edition_pilot_approvals_guard on public.edition_pilot_approvals;
create trigger edition_pilot_approvals_guard before update or delete on public.edition_pilot_approvals for each row execute function public.edition_pilot_approvals_guard();

-- The single read-time predicate. Evaluated live, so nothing needs to be "cleaned up" when anything below changes.
create or replace function public.edition_pilot_visible(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.editions_pilot() and exists (
    select 1
      from public.edition_pilot_approvals a
      join public.edition_organisers o on o.id = a.organiser_id
      left join public.hubs h on h.id = o.hub_id
     where a.organiser_id = p_org and a.revoked_at is null
       and o.status = 'verified' and not o.is_test
       and (o.hub_id is null or (h.is_active and coalesce(h.is_verified, false))))
$$;

-- ── administrator functions (admin only, audited, signed-in role only) ─────────────────────────────────────────────────

-- The pilot switch. It never touches editions.enabled.
create or replace function public.admin_set_editions_pilot(p_on boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_on is null then raise exception 'on or off' using errcode = '22023'; end if;
  insert into public.admin_config (key, value, category) values ('editions.pilot', case when p_on then 'true' else 'false' end, 'editions')
    on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, case when p_on then 'pilot_switch_on' else 'pilot_switch_off' end, jsonb_build_object('note', p_note));
end $$;

-- Set up the organiser identity for a Hub on its behalf: verified, linked, NO explicit members (the Hub's own owner and committee are the live authority).
-- It does not approve the pilot; that is a separate, explicit step.
create or replace function public.admin_create_edition_organiser_for_hub(p_hub uuid, p_slug text, p_name text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.hubs%rowtype; v_id uuid; v_flag boolean; v_name text;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  select * into h from public.hubs where id = p_hub and is_active;
  if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.edition_organisers o where o.hub_id = p_hub and o.status <> 'rejected') then
    raise exception 'this Hub already has an Editions organiser' using errcode = '23505', hint = 'hub_has_organiser';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 60 then raise exception 'choose a web address of 3 to 60 letters, numbers and hyphens' using errcode = '22023', hint = 'bad_slug'; end if;
  if p_slug in ('new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined') then
    raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), btrim(h.name));
  select exists (select 1 from public.edition_reserved_names r
                  where public.edition_normalise_name(v_name) like '%' || r.pattern || '%' or replace(p_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, reserved_name_flag, created_by, hub_id) values (p_slug, v_name, v_flag, auth.uid(), p_hub) returning id into v_id;
  perform public.admin_decide_edition_organiser(v_id, 'verify', p_note);
  perform public.edition_audit(v_id, null, 'organiser_created_for_hub_by_admin', jsonb_build_object('hub_id', p_hub, 'reserved_name_flag', v_flag));
  return v_id;
end $$;

-- Approve ONE organiser (or Hub-run organiser) for the pilot. A Hub must already be active AND verified (an administrator's separate act); a plain organiser must be verified.
create or replace function public.admin_approve_edition_pilot(p_org uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype; h public.hubs%rowtype; v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'a note is required' using errcode = '23514', hint = 'note_required'; end if;
  select * into o from public.edition_organisers where id = p_org for update;
  if not found then raise exception 'unknown organiser' using errcode = 'P0002'; end if;
  if o.is_test then raise exception 'a test organiser is never shown to the public' using errcode = '23514', hint = 'test_organiser'; end if;
  if o.status <> 'verified' then raise exception 'the organiser must be verified first' using errcode = '23514', hint = 'organiser_not_verified'; end if;
  if o.hub_id is not null then
    select * into h from public.hubs where id = o.hub_id;
    if not found or not h.is_active then raise exception 'the Hub is not active' using errcode = '23514', hint = 'hub_not_active'; end if;
    if not coalesce(h.is_verified, false) then raise exception 'the Hub must be verified by a OneShetland administrator first' using errcode = '23514', hint = 'hub_not_verified'; end if;
  end if;
  if exists (select 1 from public.edition_pilot_approvals a where a.organiser_id = p_org and a.revoked_at is null) then
    raise exception 'already approved for the pilot' using errcode = '23505', hint = 'already_approved';
  end if;
  insert into public.edition_pilot_approvals (organiser_id, approved_by, note) values (p_org, auth.uid(), btrim(p_note)) returning id into v_id;
  perform public.edition_audit(p_org, null, 'pilot_approved', jsonb_build_object('note', btrim(p_note), 'hub_id', o.hub_id));
  return v_id;
end $$;

create or replace function public.admin_revoke_edition_pilot(p_org uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required' using errcode = '23514', hint = 'reason_required'; end if;
  update public.edition_pilot_approvals set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason) where organiser_id = p_org and revoked_at is null;
  if not found then raise exception 'no live pilot approval for that organiser' using errcode = 'P0002'; end if;
  perform public.edition_audit(p_org, null, 'pilot_revoked', jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- A pilot publish entitlement: 90 days by default (never more), only for an approved organiser, built on the existing admin grant (same ledger, same audit, same void).
-- Renewal: call it again once 30 days or fewer remain; the new window starts when the live one ends, so there is never a gap or a stack.
create or replace function public.admin_grant_edition_pilot_publish(p_edition uuid, p_reason text, p_days integer default 90) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_live timestamptz; v_start timestamptz; v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 90 then raise exception 'a pilot grant is 1 to 90 days' using errcode = '22023', hint = 'pilot_days'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'unknown edition' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.edition_pilot_approvals a where a.organiser_id = e.organiser_id and a.revoked_at is null) then
    raise exception 'the organiser is not approved for the pilot' using errcode = '23514', hint = 'not_approved';
  end if;
  select max(n.ends_at) into v_live from public.edition_entitlements n
   where n.edition_id = p_edition and n.feature = 'publish' and n.voided_at is null and n.ends_at > now();
  if v_live is not null and v_live > now() + interval '30 days' then
    raise exception 'this Edition already has a pilot grant running for more than 30 days' using errcode = '23514', hint = 'too_early_to_renew';
  end if;
  v_start := greatest(now(), coalesce(v_live, now()));
  v_id := public.admin_grant_edition_entitlement(p_edition, 'publish', v_start, v_start + make_interval(days => p_days), 'Pilot: ' || coalesce(nullif(btrim(p_reason), ''), 'controlled pilot'));
  return v_id;
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['editions_pilot()', 'edition_pilot_visible(uuid)', 'edition_pilot_approvals_guard()', 'admin_set_editions_pilot(boolean,text)',
    'admin_create_edition_organiser_for_hub(uuid,text,text,text)', 'admin_approve_edition_pilot(uuid,text)', 'admin_revoke_edition_pilot(uuid,text)',
    'admin_grant_edition_pilot_publish(uuid,text,integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- anon must be able to evaluate the public-read policy, exactly like editions_enabled / edition_is_public
  grant execute on function public.edition_pilot_visible(uuid) to anon, authenticated;
  foreach f in array array['admin_set_editions_pilot(boolean,text)', 'admin_create_edition_organiser_for_hub(uuid,text,text,text)', 'admin_approve_edition_pilot(uuid,text)',
    'admin_revoke_edition_pilot(uuid,text)', 'admin_grant_edition_pilot_publish(uuid,text,integer)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.create_edition_organiser(p_name text, p_slug text, p_tagline text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_flag boolean;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if (select count(*) from public.edition_organisers o where o.created_by = auth.uid() and o.status <> 'rejected') >= 5 then
    raise exception 'organiser limit reached' using errcode = '53400', hint = 'organiser_limit';
  end if;
  if p_slug in ('new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined') then
    raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug';
  end if;
  select exists (select 1 from public.edition_reserved_names r
                  where public.edition_normalise_name(p_name) like '%' || r.pattern || '%'
                     or replace(p_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, tagline, description, reserved_name_flag, created_by)
  values (p_slug, btrim(p_name), p_tagline, p_description, v_flag, auth.uid()) returning id into v_id;
  insert into public.edition_organiser_members (organiser_id, user_id, role, invited_by) values (v_id, auth.uid(), 'owner', auth.uid());
  perform public.edition_audit(v_id, null, 'organiser_created', jsonb_build_object('reserved_name_flag', v_flag));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.create_edition_organiser_for_hub(p_hub uuid, p_slug text, p_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare h public.hubs%rowtype; v_id uuid; v_flag boolean; v_name text;
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select * into h from public.hubs where id = p_hub and is_active;
  if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
  if not public.edition_controls_hub(p_hub) then raise exception 'only the Hub''s owner or committee can set up Editions for it' using errcode = '42501'; end if;
  if exists (select 1 from public.edition_organisers o where o.hub_id = p_hub and o.status <> 'rejected') then
    raise exception 'this Hub already has an Editions organiser' using errcode = '23505', hint = 'hub_has_organiser';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 60 then raise exception 'choose a web address of 3 to 60 letters, numbers and hyphens' using errcode = '22023', hint = 'bad_slug'; end if;
  if p_slug in ('new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined') then
    raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), btrim(h.name));
  select exists (select 1 from public.edition_reserved_names r
                  where public.edition_normalise_name(v_name) like '%' || r.pattern || '%' or replace(p_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, reserved_name_flag, created_by, hub_id) values (p_slug, v_name, v_flag, auth.uid(), p_hub) returning id into v_id;
  perform public.edition_audit(v_id, null, 'organiser_created_for_hub', jsonb_build_object('hub_id', p_hub, 'reserved_name_flag', v_flag));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.admin_link_edition_organiser_hub(p_org uuid, p_hub uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  update public.edition_organisers set hub_id = p_hub where id = p_org;
  perform public.edition_audit(p_org, null, 'hub_linked', jsonb_build_object('hub_id', p_hub));
end $function$;

CREATE OR REPLACE FUNCTION public.request_edition_organiser_verification(p_org uuid, p_evidence text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if (select status from public.edition_organisers where id = p_org) = 'verified' then raise exception 'already verified' using errcode = '23505'; end if;
  insert into public.edition_organiser_verifications (organiser_id, evidence, requested_by) values (p_org, p_evidence, auth.uid()) returning id into v_id;
  update public.edition_organisers set status = 'pending' where id = p_org and status in ('rejected');
  perform public.edition_audit(p_org, null, 'verification_requested');
  return v_id;
end $function$;

do $$ declare f text; begin
  foreach f in array array['create_edition_organiser(text,text,text,text)','create_edition_organiser_for_hub(uuid,text,text)','admin_link_edition_organiser_hub(uuid,uuid)','request_edition_organiser_verification(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
insert into public.admin_config (key, value, category) values ('editions.pilot', 'false', 'features') on conflict (key) do nothing;

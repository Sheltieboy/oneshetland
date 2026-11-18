-- OneShetland Editions: the secure hand-off from the native apps to the website's organiser management.
-- Design and threat model: docs/editions/APP_HANDOFF_SECURITY.md (web repo). NOT DEPLOYED. Every switch defaults OFF (editions.app.handoff_ios / handoff_android).
--
-- A code is 256 random bits minted by the edge function; ONLY its SHA-256 is stored here, together with a hash of a 4-digit CHECK NUMBER the app shows its user and the website asks for (three wrong
-- numbers burn the code). A code is bound to one user, one organiser, one allowlisted destination KEY (never a URL),
-- one platform, and lives 60 seconds. Every function below is service-role only: the edge function is the sole caller, so no browser can mint, peek or redeem straight through the API.
-- Role checks reuse the existing edition_org_can (owner, administrator, Hub committee; never an editor), evaluated for the code's user by a transaction-local identity.
-- Expand-only. Rollback: supabase/rollbacks/20270104020000_editions_web_handoff.rollback.sql

create table if not exists public.edition_web_handoff_codes (
  id           uuid primary key default gen_random_uuid(),
  code_hash    text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid not null references auth.users (id) on delete cascade,
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  destination  text not null check (destination in ('dashboard', 'editions', 'edition', 'team', 'profile')),
  edition_id   uuid references public.editions (id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  check_hash   text not null check (check_hash ~ '^[0-9a-f]{64}$'),
  check_fails  smallint not null default 0 check (check_fails between 0 and 3),
  audited_at   timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '60 seconds'),
  check ((destination = 'edition') = (edition_id is not null))
);
create index if not exists edition_web_handoff_codes_user_idx on public.edition_web_handoff_codes (user_id, created_at desc);
alter table public.edition_web_handoff_codes enable row level security;
revoke all on public.edition_web_handoff_codes from public, anon, authenticated;

-- ceilings (read by claim_rate_limits; an unclassified action is denied)
insert into public.rate_limit_policies (action, max_count, window_seconds, note) values
  ('editions_handoff_mint',        10,  600,   'editions-web-handoff: codes minted per signed-in account, per 10 minutes'),
  ('editions_handoff_mint_day',    40,  86400, 'editions-web-handoff: codes minted per signed-in account, per day'),
  ('editions_handoff_redeem_ip',   30,  600,   'editions-web-handoff: redeem attempts per client address, per 10 minutes'),
  ('editions_handoff_redeem_code', 10,  600,   'editions-web-handoff: redeem attempts per code, per 10 minutes'),
  ('editions_handoff_view_ip',     60,  600,   'editions-web-handoff: confirmation-page lookups per verified client address, per 10 minutes'),
  ('editions_handoff_view_code',   30,  600,   'editions-web-handoff: confirmation-page lookups per code, per 10 minutes'),
  ('editions_handoff_secret_fail', 20,  600,   'editions-web-handoff: calls without the website secret, whole endpoint, per 10 minutes')
on conflict (action) do update set max_count = excluded.max_count, window_seconds = excluded.window_seconds, note = excluded.note;

-- Transaction-local identity so the EXISTING role functions (which read auth.uid()) answer for the code's user. Never callable by anyone: only the definer functions below reach it.
create or replace function public.edition_handoff_as(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null then raise exception 'no user' using errcode = '22023'; end if;
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end $$;
revoke all on function public.edition_handoff_as(uuid) from public, anon, authenticated, service_role;

-- slugs that would collide with a website route under /organise/<slug>/... or /organise/<slug>/editions/<slug>
create or replace function public.edition_route_slugs() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['new','admin','api','edit','manage','organisers','organise','editions','account','sign-in','sign-up','dashboard','test','null','undefined',
               'team','profile','packages','package','promote','promotion','promotions','report','members','payments','brand','export','participation','programme','details','updates','sponsors','partners','pages']
$$;
revoke all on function public.edition_route_slugs() from public, anon, authenticated;

create or replace function public.edition_slug_not_a_route() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.slug = any (public.edition_route_slugs()) then raise exception 'that address is reserved' using errcode = '23514', hint = 'reserved_slug'; end if;
  return new;
end $$;
revoke all on function public.edition_slug_not_a_route() from public, anon, authenticated;
drop trigger if exists edition_organisers_slug_not_a_route on public.edition_organisers;
create trigger edition_organisers_slug_not_a_route before insert or update of slug on public.edition_organisers for each row execute function public.edition_slug_not_a_route();
drop trigger if exists editions_slug_not_a_route on public.editions;
create trigger editions_slug_not_a_route before insert or update of slug on public.editions for each row execute function public.edition_slug_not_a_route();

-- the organiser slug generator skips the same names (it only knew the first fifteen); done on the live definition so nothing else in it is restated
do $$ declare v_def text; begin
  select pg_get_functiondef('public.edition_ensure_organiser(text,uuid)'::regprocedure) into v_def;
  if v_def not like '%''promote''%' then
    v_def := replace(replace(v_def, '''undefined''::text]', '''undefined''::text, ''team''::text, ''profile''::text, ''packages''::text, ''package''::text, ''promote''::text, ''promotion''::text, ''promotions''::text, ''report''::text, ''members''::text, ''payments''::text, ''brand''::text, ''export''::text, ''participation''::text, ''organise''::text]'),
                    '''undefined'']', '''undefined'',''team'',''profile'',''packages'',''package'',''promote'',''promotion'',''promotions'',''report'',''members'',''payments'',''brand'',''export'',''participation'',''organise'']');
    if v_def like '%''promote''%' then execute v_def; end if;
  end if;
end $$;

-- the closed destination list: key -> path, built from slugs in the database. Anything else (packages, promote, checkout, payments, participation, members) is not a key and yields null.
create or replace function public.edition_handoff_path(p_dest text, p_org uuid, p_edition uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_dest
    when 'dashboard' then '/organise/' || o.slug
    when 'editions'  then '/organise/' || o.slug || '/editions'
    when 'team'      then '/organise/' || o.slug || '/team'
    when 'profile'   then '/organise/' || o.slug || '/profile'
    when 'edition'   then (select '/organise/' || o.slug || '/editions/' || e.slug from public.editions e where e.id = p_edition and e.organiser_id = o.id)
    else null end
    from public.edition_organisers o where o.id = p_org and not (o.slug = any (public.edition_route_slugs()))
      and (p_dest <> 'edition' or not exists (select 1 from public.editions e where e.id = p_edition and e.slug = any (public.edition_route_slugs())))
$$;
revoke all on function public.edition_handoff_path(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.edition_handoff_path(text, uuid, uuid) to service_role;

-- why a user may not use the hand-off right now (null = allowed). Runs as the user, so it must be called after edition_handoff_as.
create or replace function public.edition_handoff_refusal(p_user uuid, p_org uuid, p_platform text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.editions_enabled() then return 'feature_off'; end if;
  if public.edition_commerce_cfg('editions.app.handoff_' || p_platform, 'off') <> 'on' then return 'handoff_off'; end if;
  if exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is not null) then return 'account_closed'; end if;
  if not exists (select 1 from public.edition_organisers o where o.id = p_org and o.status <> 'suspended') then return 'organiser_unavailable'; end if;
  if not public.edition_org_can(p_org, 'admin') then return 'not_allowed'; end if;
  return null;
end $$;
revoke all on function public.edition_handoff_refusal(uuid, uuid, text) from public, anon, authenticated, service_role;

-- mint: records the hash of a code the edge function generated. Raises with a hint on refusal (nothing is stored then).
create or replace function public.edition_handoff_mint(p_user uuid, p_org uuid, p_destination text, p_edition uuid, p_platform text, p_code_hash text, p_check_hash text) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_why text; v_expires timestamptz;
begin
  if p_user is null or p_org is null or p_platform not in ('ios', 'android') or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_check_hash is null or p_check_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bad request' using errcode = '22023', hint = 'bad_request';
  end if;
  perform public.edition_handoff_as(p_user);
  v_why := public.edition_handoff_refusal(p_user, p_org, p_platform);
  if v_why is not null then raise exception 'not available' using errcode = '42501', hint = v_why; end if;
  if public.edition_handoff_path(p_destination, p_org, p_edition) is null then raise exception 'not available' using errcode = '42501', hint = 'bad_destination'; end if;
  if (select count(*) from public.edition_web_handoff_codes c where c.user_id = p_user and c.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'too many' using errcode = '54000', hint = 'too_many';
  end if;
  delete from public.edition_web_handoff_codes where created_at < now() - interval '1 day';
  v_expires := now() + interval '60 seconds';
  insert into public.edition_web_handoff_codes (code_hash, check_hash, user_id, organiser_id, destination, edition_id, platform, expires_at)
    values (p_code_hash, p_check_hash, p_user, p_org, p_destination, case when p_destination = 'edition' then p_edition end, p_platform, v_expires);
  perform public.edition_audit(p_org, case when p_destination = 'edition' then p_edition end, 'app_handoff_minted', jsonb_build_object('destination', p_destination, 'platform', p_platform));
  return v_expires;
end $$;
revoke all on function public.edition_handoff_mint(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.edition_handoff_mint(uuid, uuid, text, uuid, text, text, text) to service_role;

-- peek: for the confirmation page. Consumes nothing. Returns the code's user while it is still valid, else no rows.
create or replace function public.edition_handoff_peek(p_code_hash text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select c.user_id from public.edition_web_handoff_codes c where c.code_hash = p_code_hash and c.used_at is null and c.expires_at > now()
$$;
revoke all on function public.edition_handoff_peek(text) from public, anon, authenticated;
grant execute on function public.edition_handoff_peek(text) to service_role;

-- redeem: the row is locked, the CHECK NUMBER is compared (hashes), and a wrong number counts against the code: the third wrong number burns it. Only then is the code consumed (one UPDATE
-- ... WHERE used_at IS NULL), and everything is re-checked for the code's user. Refusals RETURN (never raise) so consumption and counters persist. A success writes NO audit row here: the
-- website calls edition_handoff_finish after the session exists, so "redeemed" is only ever recorded for a hand-off that completed.
create or replace function public.edition_handoff_redeem(p_code_hash text, p_check_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_web_handoff_codes%rowtype; v_why text; v_path text; v_fails smallint;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_check_hash is null or p_check_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into r from public.edition_web_handoff_codes where code_hash = p_code_hash and used_at is null and expires_at > now() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.check_hash <> p_check_hash then
    v_fails := r.check_fails + 1;
    update public.edition_web_handoff_codes set check_fails = v_fails, used_at = case when v_fails >= 3 then now() end, audited_at = case when v_fails >= 3 then now() end where id = r.id;
    if v_fails >= 3 then
      perform public.edition_handoff_as(r.user_id);
      perform public.edition_audit(r.organiser_id, r.edition_id, 'app_handoff_refused', jsonb_build_object('reason', 'check_number_burned', 'platform', r.platform));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'bad_number', 'left', 3 - v_fails);
  end if;
  update public.edition_web_handoff_codes set used_at = now() where id = r.id and used_at is null;
  perform public.edition_handoff_as(r.user_id);
  v_why := public.edition_handoff_refusal(r.user_id, r.organiser_id, r.platform);
  v_path := public.edition_handoff_path(r.destination, r.organiser_id, r.edition_id);
  if v_why is null and v_path is null then v_why := 'bad_destination'; end if;
  if v_why is not null then
    update public.edition_web_handoff_codes set audited_at = now() where id = r.id;
    perform public.edition_audit(r.organiser_id, r.edition_id, 'app_handoff_refused', jsonb_build_object('reason', v_why, 'platform', r.platform));
    return jsonb_build_object('ok', false, 'reason', v_why);
  end if;
  return jsonb_build_object('ok', true, 'user_id', r.user_id, 'path', v_path);
end $$;
revoke all on function public.edition_handoff_redeem(text, text) from public, anon, authenticated;
grant execute on function public.edition_handoff_redeem(text, text) to service_role;

-- finish: the outcome of a redeemed code, written once, after the account checks and the session exchange. Only a consumed, not-yet-audited code can be finished.
create or replace function public.edition_handoff_finish(p_code_hash text, p_ok boolean, p_reason text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_web_handoff_codes%rowtype;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or (not p_ok and (p_reason is null or p_reason !~ '^[a-z_]{1,30}$')) then return false; end if;
  update public.edition_web_handoff_codes set audited_at = now() where code_hash = p_code_hash and used_at is not null and audited_at is null returning * into r;
  if not found then return false; end if;
  perform public.edition_handoff_as(r.user_id);
  if p_ok then perform public.edition_audit(r.organiser_id, r.edition_id, 'app_handoff_redeemed', jsonb_build_object('destination', r.destination, 'platform', r.platform));
  else perform public.edition_audit(r.organiser_id, r.edition_id, 'app_handoff_refused', jsonb_build_object('reason', p_reason, 'platform', r.platform)); end if;
  return true;
end $$;
revoke all on function public.edition_handoff_finish(text, boolean, text) from public, anon, authenticated;
grant execute on function public.edition_handoff_finish(text, boolean, text) to service_role;

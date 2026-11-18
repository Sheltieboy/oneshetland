-- Editions launch, stage 1: the two switches, a catalogue an administrator can actually run, and the free introductory package.
--
-- WHY. The Editions journey is complete in code but an organiser cannot finish it, because nothing downstream of "choose a package" is reachable:
-- no Edition package has ever been active, and none has ever been free. The only way past is an administrator granting a publish entitlement by
-- hand, which bypasses edition_fulfil_order — and edition_fulfil_order is also the only thing that creates promotion rights from a package's
-- grants. One empty catalogue is therefore the whole of "manual publishing entitlements and separate promotional rights".
--
-- This migration changes no rule about who may do what, and no rule about what is public. It:
--
--   1. splits ONE overloaded switch into TWO. editions.enabled has always meant both "visitors may discover published Editions" AND "any signed-in
--      user may start Editions for their Business or Hub" (edition_is_public reads the first meaning; the website's access helper read the second).
--      Turning Editions on for the public therefore opened organiser registration to the whole membership on the same day. editions.signup_open now
--      carries the second meaning alone. BOTH default to false, and editions.enabled keeps its existing meaning exactly: nothing becomes public here.
--   2. lets an administrator set those two switches, and retire a package — both of which previously needed SQL;
--   3. adds the free introductory package, INACTIVE. Switching it on is a deliberate act in the admin interface, not a side effect of deploying.
--
-- What an organiser then gets flows through the EXISTING order and fulfilment path (edition_claim_free_package -> edition_fulfil_order), so
-- entitlements are created automatically, audited, and reversible in the ordinary way. Nothing here grants anything to anybody.
--
-- NOTE ON SCOPE. admin_set_edition_commerce_config is deliberately NOT re-created. It carries ~25 validation branches and the launch switches are
-- not commerce settings; re-stating it to add two lines risks silently dropping a rule. The switches get their own small setter below.

-- ── 1. new organiser access, its own switch ──────────────────────────────────────────────────────────────────────────────────────────────────────

-- Whether a person who does not already run Editions may start them for a Business or Hub they control. Fails CLOSED, like editions_enabled().
-- This is NOT who may SEE Editions (editions_enabled), and NOT who may manage an organiser they already belong to (edition_org_role).
create or replace function public.editions_signup_open() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(c.value)) = 'true' from public.admin_config c where c.key = 'editions.signup_open'), false)
$$;

revoke all on function public.editions_signup_open() from public;
grant execute on function public.editions_signup_open() to anon, authenticated;

-- The gate itself. Re-created whole from 20270103000000_editions_business_and_hub_identity.sql (its only definition) with ONE addition, marked
-- below; every other line, including the reserved-name flag and the slug search, is character-for-character what was there.
create or replace function public.edition_ensure_organiser(p_kind text, p_parent uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_org public.edition_organisers%rowtype; v_slug text; v_base text; v_n int := 0; v_flag boolean; v_id uuid;
  v_reserved text[] := array['new','admin','api','edit','manage','organisers','editions','account','sign-in','sign-up','dashboard','test','null','undefined'];
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if p_kind not in ('hub', 'business') then raise exception 'bad kind' using errcode = '22023'; end if;
  if p_kind = 'hub' then
    select h.name into v_name from public.hubs h where h.id = p_parent and h.is_active;
    if not found then raise exception 'Hub not found' using errcode = 'P0002'; end if;
    if not public.edition_controls_hub(p_parent) then raise exception 'only the Hub''s owner or committee can use Editions for it' using errcode = '42501'; end if;
    select * into v_org from public.edition_organisers x where x.hub_id = p_parent and x.status <> 'rejected' order by x.created_at limit 1;
  else
    select b.name into v_name from public.local_businesses b where b.id = p_parent and b.is_active and b.owner_id is not null;
    if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
    if not public.edition_controls_business(p_parent) then raise exception 'only the Business owner can use Editions for it' using errcode = '42501'; end if;
    select * into v_org from public.edition_organisers x where x.business_id = p_parent and x.status <> 'rejected' order by x.created_at limit 1;
  end if;
  -- An existing organiser is ALWAYS returned, whatever the switch says: this function is how the management pages find it, and closing new
  -- registration must never take their own Editions away from the people already running one.
  if v_org.id is not null then return jsonb_build_object('id', v_org.id, 'slug', v_org.slug, 'created', false); end if;
  -- ── THE ONE ADDITION ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  -- Creating a NEW organiser is what the switch governs. Staff are exempt, so OneShetland can set one up for a partner while registration is shut.
  if not (public.editions_signup_open() or public.edition_staff()) then
    raise exception 'Editions is not open for new organisers yet' using errcode = '42501', hint = 'signup_closed';
  end if;
  -- ── end of the addition ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  v_base := coalesce(nullif(public.edition_slugify(v_name), ''), 'organiser');
  if char_length(v_base) < 3 then v_base := v_base || '-editions'; end if;
  v_slug := v_base;
  while v_slug = any (v_reserved) or exists (select 1 from public.edition_organisers x where x.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := left(v_base, 60 - char_length('-editions' || case when v_n > 1 then '-' || v_n else '' end)) || '-editions' || case when v_n > 1 then '-' || v_n else '' end;
    if v_n > 200 then raise exception 'could not choose a web address' using errcode = '23505'; end if;
  end loop;
  select exists (select 1 from public.edition_reserved_names r where public.edition_normalise_name(v_name) like '%' || r.pattern || '%' or replace(v_slug, '-', ' ') like '%' || r.pattern || '%') into v_flag;
  insert into public.edition_organisers (slug, name, reserved_name_flag, created_by, hub_id, business_id)
  values (v_slug, left(btrim(v_name), 120), v_flag, auth.uid(), case when p_kind = 'hub' then p_parent end, case when p_kind = 'business' then p_parent end) returning id into v_id;
  perform public.edition_audit(v_id, null, 'organiser_created_from_' || p_kind, jsonb_build_object('parent', p_parent, 'reserved_name_flag', v_flag));
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'created', true);
end $$;

-- ── 2. an administrator can set the two launch switches ──────────────────────────────────────────────────────────────────────────────────────────
--
-- Its own setter, holding exactly two keys and nothing else: these are not commerce settings, and a separate function cannot disturb the commerce
-- validator. Same shape as that validator — administrators only, whitelist, upsert, audit — so there is one way these values ever change.
create or replace function public.admin_set_editions_switch(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_key not in ('editions.enabled', 'editions.signup_open') then raise exception 'that setting is not a launch switch' using errcode = '22023', hint = 'bad_switch'; end if;
  if p_value not in ('true', 'false') then raise exception 'a switch is true or false' using errcode = '22023', hint = 'bad_switch_value'; end if;
  insert into public.admin_config (key, value, category) values (p_key, p_value, 'editions')
    on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'editions_switch_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

revoke all on function public.admin_set_editions_switch(text, text) from public, anon;
grant execute on function public.admin_set_editions_switch(text, text) to authenticated;

-- ── 3. retiring a package, without a migration ───────────────────────────────────────────────────────────────────────────────────────────────────
--
-- Retiring takes a row off sale for good. Deliberately one-way: admin_upsert_edition_package already refuses to touch a retired row, so this cannot
-- be used to churn the rate card. Orders already placed are untouched — each carries its own package_snapshot — and live entitlements bought from
-- the row keep running to their end date. A reason is required and recorded.
create or replace function public.admin_retire_edition_package(p_code text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  select * into pk from public.edition_packages where code = p_code for update;
  if not found then raise exception 'no such package' using errcode = 'P0002'; end if;
  if pk.retired_at is not null then raise exception 'that package is already retired' using errcode = '23514', hint = 'already_retired'; end if;
  update public.edition_packages set retired_at = now(), active = false, updated_at = now() where code = p_code;
  perform public.edition_audit(null, null, 'package_retired', jsonb_build_object('code', p_code, 'kind', pk.kind, 'reason', btrim(p_reason)));
end $$;

revoke all on function public.admin_retire_edition_package(text, text) from public, anon;
grant execute on function public.admin_retire_edition_package(text, text) to authenticated;

-- ── 4. the free introductory package — ADDED INACTIVE ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Community Launch: free, twelve months, every core publishing and management feature, no member cap, and NO promotion days. The empty `grants` is
-- the point, not an omission: edition_fulfil_order creates promotion rights only from grants, so a free package grants none, and the paid promotion
-- rows on the rate card stay the only route to the homepage and to enhanced discovery.
--
-- active = false. Deploying this offers nothing to anybody; an administrator switches it on when OneShetland is ready.
-- `on conflict (code) do nothing` so a row created ahead of this migration keeps whatever an administrator has already set on it.
insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort, audience, kind, grants, is_free) values
  ('community_launch', 'Community Launch',
   'Publish your Edition free for twelve months, with everything you need to run it: editorial pages, programme, sponsors and partners, updates, memberships, participation fees, offline records, CSV export and payment collection. Promotion on the homepage and in enhanced discovery is separate and optional.',
   0, 365, '["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb, null, false, 5, 'any', 'package', '{}'::jsonb, true)
on conflict (code) do nothing;

-- ── 5. post-checks: nothing became public, nothing went on sale, nobody gained anything ──────────────────────────────────────────────────────────
do $$
declare n integer;
begin
  if public.editions_signup_open() then raise exception 'post-check: new organiser access must be closed after this migration'; end if;
  select count(*) into n from public.edition_packages where code = 'community_launch' and active;
  if n <> 0 then raise exception 'post-check: Community Launch must be added switched off'; end if;
  select count(*) into n from public.edition_packages where code = 'community_launch' and is_free and price_pence = 0 and duration_days = 365 and grants = '{}'::jsonb;
  if n <> 1 then raise exception 'post-check: Community Launch must be free, 365 days, and grant no promotion'; end if;
  -- the publish gate, the public rule and fulfilment are untouched by this migration; prove they are still there
  if to_regprocedure('public.edition_fulfil_order(uuid,text,integer)') is null then raise exception 'post-check: edition_fulfil_order is missing'; end if;
  if to_regprocedure('public.edition_claim_free_package(uuid,uuid,uuid,text)') is null then raise exception 'post-check: edition_claim_free_package is missing'; end if;
  if to_regprocedure('public.edition_is_public(uuid)') is null then raise exception 'post-check: edition_is_public is missing'; end if;
end $$;

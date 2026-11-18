-- OneShetland house promotions: an administrator can feature OneShetland's OWN Editions on the homepage for an
-- extended run, free of charge, without changing the commercial rules anyone else books under.
--
-- WHY. The homepage fairness rule caps any one organiser at editions.promo.homepage_days_per_90 (14) homepage days
-- in any rolling 90 days. That rule exists so paid placement cannot be monopolised, and it must stay exactly as it
-- is for organisers. But OneShetland's own seasonal campaigns — Christmas & New Year, for instance — are editorial,
-- not advertising: they are the platform promoting itself, they carry no money, and they run for a season rather
-- than a fortnight. Under the commercial rule a 49-day Christmas run is impossible.
--
-- WHAT THIS ADDS.
--   edition_organisers.is_house        — this organiser is OneShetland's own. Administrators set it, with a reason,
--                                        and only for a verified, non-test organiser. Nothing else reads it.
--   edition_promo_rights.is_house      — this grant is a house promotion. Set only by the function below.
--   admin_set_edition_organiser_house  — mark or unmark an organiser as OneShetland's own (audited).
--   edition_promo_validate_core        — the existing validation, plus one parameter: p_house.
--   edition_promo_validate             — UNCHANGED signature, now a thin wrapper that passes p_house => false, so
--                                        every existing caller (organiser booking, campaign booking, reschedule,
--                                        admin_promo_feature) keeps the commercial rules untouched.
--   admin_promo_feature_house          — grant and book a house promotion in one transaction.
--
-- WHAT A HOUSE PROMOTION DOES NOT CHANGE. Per-day capacity (3 homepage places) is still enforced, so a house
-- promotion takes one of the three places and can still be refused when a day is full. So are: published and
-- approved, a live publishing period, the publishing window, and one booking per organiser per kind per day. Only
-- the rolling 90-day fairness cap is waived, and only for house bookings: house days are also left OUT of the
-- fairness count, so a house run never eats into what that organiser could otherwise book commercially. Prices,
-- packages, paid entitlements and every other organiser's limits are untouched.
--
-- Expand-only. Rollback: supabase/rollbacks/20270306000000_editions_house_promotions.rollback.sql (the two columns are left in place; see the file).

-- ── 1. who is OneShetland ────────────────────────────────────────────────────────────────────────────────────────
alter table public.edition_organisers add column if not exists is_house boolean not null default false;
comment on column public.edition_organisers.is_house is
  'This organiser is OneShetland itself (an official platform campaign). Only administrators set it, only for a verified non-test organiser, and only admin_promo_feature_house reads it.';

alter table public.edition_promo_rights add column if not exists is_house boolean not null default false;
comment on column public.edition_promo_rights.is_house is
  'A free-of-charge official OneShetland promotion. Exempt from the rolling 90-day homepage fairness cap, and excluded from the fairness count so it never consumes an organiser''s commercial allowance.';

-- Marking an organiser as OneShetland's own is a deliberate, recorded administrative act, not a side effect of
-- booking something. Turning it ON requires a verified, non-test organiser; turning it OFF is always allowed.
create or replace function public.admin_set_edition_organiser_house(p_org uuid, p_house boolean, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  select * into o from public.edition_organisers where id = p_org;
  if not found then raise exception 'organiser not found' using errcode = 'P0002'; end if;
  if p_house and (o.status <> 'verified' or o.is_test) then
    raise exception 'only a verified, non-test organiser can be marked as OneShetland''s own' using errcode = '23514', hint = 'not_verified';
  end if;
  update public.edition_organisers set is_house = coalesce(p_house, false), updated_at = now() where id = p_org;
  perform public.edition_audit(p_org, null, 'organiser_house_set', jsonb_build_object('is_house', coalesce(p_house, false), 'reason', btrim(p_reason)));
end $$;
revoke all on function public.admin_set_edition_organiser_house(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_edition_organiser_house(uuid, boolean, text) to authenticated;

-- ── 2. validation, with one new parameter ────────────────────────────────────────────────────────────────────────
--
-- This is the body that was edition_promo_validate, with two changes and nothing else:
--   * the fairness block is skipped when p_house
--   * the fairness count ignores existing house bookings
create or replace function public.edition_promo_validate_core(p_edition uuid, p_kind text, p_start date, p_days integer, p_exclude uuid, p_timing boolean, p_house boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_today date := public.edition_promo_today(); v_ent timestamptz; v_last_full date; v_from date; v_end date; v_cap integer; v_day date; v_peak integer; v_lim integer;
begin
  if p_start is null or p_days is null or p_days < 1 then raise exception 'choose a start date' using errcode = '22023', hint = 'bad_dates'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.status <> 'published' or e.review_state <> 'approved' then raise exception 'promotion can be scheduled once the Edition is approved and published' using errcode = '23514', hint = 'not_live'; end if;
  select max(n.ends_at) into v_ent from public.edition_entitlements n where n.edition_id = p_edition and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now();
  if v_ent is null then raise exception 'this Edition has no live publishing period' using errcode = '23514', hint = 'no_entitlement'; end if;
  v_last_full := ((v_ent at time zone 'Europe/London') - interval '1 day')::date;
  v_from := greatest((e.published_at at time zone 'Europe/London')::date, case when p_timing then v_today + public.edition_promo_cfg_int('editions.promo.lead_days', 2) else v_today end);
  v_end := p_start + p_days - 1;
  if p_start < v_from then raise exception 'promotion cannot start before %', to_char(v_from, 'FMDD Mon YYYY') using errcode = '23514', hint = 'too_early'; end if;
  if v_end > v_last_full then raise exception 'promotion must finish inside the Edition''s publishing period (last day %)', to_char(v_last_full, 'FMDD Mon YYYY') using errcode = '23514', hint = 'outside_publish_window'; end if;
  if p_timing and p_start > v_today + public.edition_promo_cfg_int('editions.promo.horizon_days', 180) then raise exception 'that is too far ahead to book' using errcode = '23514', hint = 'too_far'; end if;
  -- capacity: every day of the window must have a free place. A house promotion is NOT exempt from this.
  v_cap := public.edition_promo_cfg_int(case p_kind when 'homepage' then 'editions.promo.homepage_capacity' else 'editions.promo.discovery_capacity' end, case p_kind when 'homepage' then 3 else 6 end);
  select g::date into v_day from generate_series(p_start, v_end, interval '1 day') g
   where (select count(*) from public.edition_promo_bookings b where b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and g::date between b.starts_on and b.ends_on) >= v_cap
   order by g limit 1;
  if v_day is not null then raise exception 'no place is free on % for that kind of promotion', to_char(v_day, 'FMDD Mon YYYY') using errcode = '23514', hint = 'full'; end if;
  -- one booking per organiser per kind per day (across all of its Editions)
  if exists (select 1 from public.edition_promo_bookings b where b.organiser_id = e.organiser_id and b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and b.starts_on <= v_end and b.ends_on >= p_start) then
    raise exception 'you already have this kind of promotion booked on some of those days' using errcode = '23514', hint = 'already_booked';
  end if;
  -- fairness: no organiser above the homepage limit in any rolling 90 days. An official OneShetland campaign is
  -- editorial rather than advertising, so it is neither limited by this nor counted towards it.
  if p_kind = 'homepage' and not coalesce(p_house, false) then
    v_lim := public.edition_promo_cfg_int('editions.promo.homepage_days_per_90', 14);
    select coalesce(max(c), 0) into v_peak from (
      select (select count(*) from (
                select generate_series(b.starts_on, b.ends_on, interval '1 day')::date as day from public.edition_promo_bookings b
                 where b.organiser_id = e.organiser_id and b.kind = 'homepage' and b.status = 'booked' and b.id is distinct from p_exclude and b.ends_on >= w.w and b.starts_on <= w.w + 89
                   and not exists (select 1 from public.edition_promo_rights hr where hr.id = b.right_id and hr.is_house)
                union all select generate_series(p_start, v_end, interval '1 day')::date) dd
               where dd.day between w.w and w.w + 89) as c
        from (select g::date as w from generate_series(p_start - 89, v_end, interval '1 day') g) w) x;
    if v_peak > v_lim then raise exception 'that would be more than % homepage days in 90 days', v_lim using errcode = '23514', hint = 'fairness_limit'; end if;
  end if;
end $$;

-- The signature every existing caller uses, unchanged, and still the commercial rules.
create or replace function public.edition_promo_validate(p_edition uuid, p_kind text, p_start date, p_days integer, p_exclude uuid, p_timing boolean) returns void
language sql security definer set search_path = public, pg_temp as $$
  select public.edition_promo_validate_core(p_edition, p_kind, p_start, p_days, p_exclude, p_timing, false)
$$;

revoke all on function public.edition_promo_validate_core(uuid, text, date, integer, uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.edition_promo_validate(uuid, text, date, integer, uuid, boolean) from public, anon, authenticated;

-- ── 3. feature an official OneShetland campaign ──────────────────────────────────────────────────────────────────
--
-- The same shape as admin_promo_feature: one transaction, one lock, grant and book together, fully audited. It
-- differs in exactly three ways — the organiser must be marked as OneShetland's own, the run may be up to 400 days,
-- and the right is stamped is_house so the fairness cap does not apply to it or count it.
create or replace function public.admin_promo_feature_house(p_edition uuid, p_kind text, p_start date, p_days integer, p_reason text)
returns table (right_id uuid, booking_id uuid, starts_on date, ends_on date)
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_right uuid; v_booking uuid; v_end date;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  if p_kind not in ('discovery', 'homepage') then raise exception 'kind must be discovery or homepage' using errcode = '22023'; end if;
  if p_days is null or p_days not between 1 and 400 then raise exception 'a house promotion is for 1 to 400 days' using errcode = '23514', hint = 'bad_days'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  select * into o from public.edition_organisers where id = e.organiser_id;
  if not found or not o.is_house or o.status <> 'verified' or o.is_test then
    raise exception 'a house promotion is only for a verified Edition that OneShetland runs itself' using errcode = '42501', hint = 'not_house';
  end if;

  perform public.edition_promo_lock();
  -- p_timing => false is the existing staff leniency on lead time and horizon; p_house => true waives only the
  -- rolling 90-day fairness cap. Capacity, the publishing window and everything else are enforced in full.
  perform public.edition_promo_validate_core(p_edition, p_kind, p_start, p_days, null, false, true);

  v_end := p_start + p_days - 1;
  insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days, granted_by, reason, is_house)
    values (e.id, e.organiser_id, 'admin_grant', p_kind, p_days, auth.uid(), btrim(p_reason), true)
    returning id into v_right;
  insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on, created_by)
    values (e.id, e.organiser_id, v_right, p_kind, p_start, v_end, auth.uid())
    returning id into v_booking;

  perform public.edition_audit(e.organiser_id, e.id, 'promo_house_featured',
    jsonb_build_object('right', v_right, 'booking', v_booking, 'kind', p_kind, 'starts_on', p_start, 'ends_on', v_end, 'days', p_days, 'reason', btrim(p_reason)));
  return query select v_right, v_booking, p_start, v_end;
end $$;
revoke all on function public.admin_promo_feature_house(uuid, text, date, integer, text) from public, anon;
grant execute on function public.admin_promo_feature_house(uuid, text, date, integer, text) to authenticated;

-- ── 4. the candidate list says which Editions are OneShetland's own ──────────────────────────────────────────────
-- The return type gains a column, so the function is dropped and recreated rather than replaced.
drop function if exists public.admin_edition_promo_candidates();
create or replace function public.admin_edition_promo_candidates()
returns table (edition_id uuid, title text, slug text, organiser_id uuid, organiser_name text, starts_on date, ends_on date, published_at timestamptz, entitlement_ends_at timestamptz, is_public boolean, is_house boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Refuse, rather than filter: an empty list would read as "there is nothing to feature" instead of "this is not
  -- for you", and would make a permissions test pass while proving nothing.
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query
  select e.id, e.title, e.slug, o.id, o.name, e.starts_on, e.ends_on, e.published_at,
         (select max(n.ends_at) from public.edition_entitlements n
           where n.edition_id = e.id and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now()),
         public.edition_is_public(e.id), o.is_house
    from public.editions e
    join public.edition_organisers o on o.id = e.organiser_id
   where e.status = 'published' and e.review_state = 'approved'
     and not e.is_test and not o.is_test and o.status = 'verified'
     and public.edition_parent_live(o.id)
     and exists (select 1 from public.edition_entitlements n
                  where n.edition_id = e.id and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now())
   order by e.starts_on, e.title;
end $$;
revoke all on function public.admin_edition_promo_candidates() from public, anon;
grant execute on function public.admin_edition_promo_candidates() to authenticated;

-- ── post-checks ──────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_lim integer; v_cap integer;
begin
  if to_regprocedure('public.edition_promo_validate(uuid,text,date,integer,uuid,boolean)') is null then raise exception 'post-check: the 6-argument edition_promo_validate must still exist'; end if;
  if to_regprocedure('public.edition_promo_validate_core(uuid,text,date,integer,uuid,boolean,boolean)') is null then raise exception 'post-check: edition_promo_validate_core is missing'; end if;
  if to_regprocedure('public.admin_promo_feature(uuid,text,date,integer,text)') is null then raise exception 'post-check: admin_promo_feature is missing'; end if;
  if to_regprocedure('public.admin_promo_feature_house(uuid,text,date,integer,text)') is null then raise exception 'post-check: admin_promo_feature_house is missing'; end if;
  -- the commercial rules are untouched
  v_lim := public.edition_promo_cfg_int('editions.promo.homepage_days_per_90', 14);
  v_cap := public.edition_promo_cfg_int('editions.promo.homepage_capacity', 3);
  if v_lim <> 14 then raise exception 'post-check: the homepage fairness limit changed (now %)', v_lim; end if;
  if v_cap <> 3 then raise exception 'post-check: the homepage capacity changed (now %)', v_cap; end if;
  -- Nobody is house until an administrator says so, and no existing right silently became a house right. Both are
  -- checked only while no administrator has ever used the feature, so that re-running this migration after it has
  -- been used in earnest does not fail on its own correct data.
  if exists (select 1 from public.edition_organisers where is_house)
     and not exists (select 1 from public.edition_audit_log where action = 'organiser_house_set') then
    raise exception 'post-check: an organiser is already marked as house'; end if;
  if exists (select 1 from public.edition_promo_rights where is_house)
     and not exists (select 1 from public.edition_audit_log where action = 'promo_house_featured') then
    raise exception 'post-check: an existing promotion right was marked as house'; end if;
  -- anon must not reach any of it
  if has_function_privilege('anon', 'public.admin_promo_feature_house(uuid,text,date,integer,text)', 'execute') then raise exception 'post-check: anon must not execute admin_promo_feature_house'; end if;
  if has_function_privilege('anon', 'public.admin_set_edition_organiser_house(uuid,boolean,text)', 'execute') then raise exception 'post-check: anon must not execute admin_set_edition_organiser_house'; end if;
  if has_function_privilege('anon', 'public.admin_edition_promo_candidates()', 'execute') then raise exception 'post-check: anon must not execute admin_edition_promo_candidates'; end if;
  if has_column_privilege('anon', 'public.edition_organisers', 'is_house', 'select') then raise exception 'post-check: anon must not read edition_organisers.is_house'; end if;
end $$;

-- Reverse 20270306000000: no house promotions, the commercial fairness cap applies to everyone again.
--
-- The two is_house columns are deliberately LEFT IN PLACE. They default to false, nothing reads them once the
-- functions below are restored, and dropping edition_promo_rights.is_house would destroy the record of which
-- past promotions were official OneShetland campaigns. Any house booking already made stays booked; cancel it
-- with admin_promo_cancel if that is what is wanted.

drop function if exists public.admin_promo_feature_house(uuid, text, date, integer, text);
drop function if exists public.admin_set_edition_organiser_house(uuid, boolean, text);

-- edition_promo_validate exactly as 20270104010000 defined it (plpgsql, fairness always applied, house bookings counted)
create or replace function public.edition_promo_validate(p_edition uuid, p_kind text, p_start date, p_days integer, p_exclude uuid, p_timing boolean) returns void
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
  v_cap := public.edition_promo_cfg_int(case p_kind when 'homepage' then 'editions.promo.homepage_capacity' else 'editions.promo.discovery_capacity' end, case p_kind when 'homepage' then 3 else 6 end);
  select g::date into v_day from generate_series(p_start, v_end, interval '1 day') g
   where (select count(*) from public.edition_promo_bookings b where b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and g::date between b.starts_on and b.ends_on) >= v_cap
   order by g limit 1;
  if v_day is not null then raise exception 'no place is free on % for that kind of promotion', to_char(v_day, 'FMDD Mon YYYY') using errcode = '23514', hint = 'full'; end if;
  if exists (select 1 from public.edition_promo_bookings b where b.organiser_id = e.organiser_id and b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and b.starts_on <= v_end and b.ends_on >= p_start) then
    raise exception 'you already have this kind of promotion booked on some of those days' using errcode = '23514', hint = 'already_booked';
  end if;
  if p_kind = 'homepage' then
    v_lim := public.edition_promo_cfg_int('editions.promo.homepage_days_per_90', 14);
    select coalesce(max(c), 0) into v_peak from (
      select (select count(*) from (
                select generate_series(b.starts_on, b.ends_on, interval '1 day')::date as day from public.edition_promo_bookings b
                 where b.organiser_id = e.organiser_id and b.kind = 'homepage' and b.status = 'booked' and b.id is distinct from p_exclude and b.ends_on >= w.w and b.starts_on <= w.w + 89
                union all select generate_series(p_start, v_end, interval '1 day')::date) dd
               where dd.day between w.w and w.w + 89) as c
        from (select g::date as w from generate_series(p_start - 89, v_end, interval '1 day') g) w) x;
    if v_peak > v_lim then raise exception 'that would be more than % homepage days in 90 days', v_lim using errcode = '23514', hint = 'fairness_limit'; end if;
  end if;
end $$;
revoke all on function public.edition_promo_validate(uuid, text, date, integer, uuid, boolean) from public, anon, authenticated;

drop function if exists public.edition_promo_validate_core(uuid, text, date, integer, uuid, boolean, boolean);

-- the candidate list as 20270305000000 defined it (no is_house column)
drop function if exists public.admin_edition_promo_candidates();
create or replace function public.admin_edition_promo_candidates()
returns table (edition_id uuid, title text, slug text, organiser_id uuid, organiser_name text, starts_on date, ends_on date, published_at timestamptz, entitlement_ends_at timestamptz, is_public boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query
  select e.id, e.title, e.slug, o.id, o.name, e.starts_on, e.ends_on, e.published_at,
         (select max(n.ends_at) from public.edition_entitlements n
           where n.edition_id = e.id and n.feature = 'publish' and n.voided_at is null and n.starts_at <= now() and n.ends_at > now()),
         public.edition_is_public(e.id)
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

-- OneShetland Editions: promotion booking, featuring, tracking, reporting, admin tools, and promotion-aware orders and refunds (part 2 of 2).
-- Spec: docs/editions/WEB_APP_BUILD_CONTRACT.md. Part 1 (20270104000000) created the catalogue columns, the rate card and the tables.
--
-- Rules enforced here, in the database, under one advisory lock (every promotion write takes the discovery lock then the homepage lock, always in that order, so two organisers
-- racing for the last slot are serialised and a cancel can never interleave with a grouped booking):
--   * the Edition is published, approved and holds a LIVE publish entitlement; the window starts no earlier than the day it was published and today + lead_days, ends inside the publish
--     entitlement (a promotion can never extend publishing) and starts within horizon_days
--   * capacity per day per kind; one booking per organiser per kind per day; no organiser above homepage_days_per_90 homepage days in any rolling 90 days across all its Editions
--   * grouped rights: the homepage window must lie wholly inside the group's discovery window
-- Expand-only. Rollback: supabase/rollbacks/20270104010000_editions_promotion_rpcs.rollback.sql

-- ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_promo_lock() returns void
language sql security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtext('edition_promo:discovery')), pg_advisory_xact_lock(hashtext('edition_promo:homepage'))
$$;

-- Validate one window for one Edition (caller holds the locks). p_timing = false is the administrator path (lead time, horizon and notice are waived; integrity rules are not).
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
  -- capacity: every day of the window must have a free place
  v_cap := public.edition_promo_cfg_int(case p_kind when 'homepage' then 'editions.promo.homepage_capacity' else 'editions.promo.discovery_capacity' end, case p_kind when 'homepage' then 3 else 6 end);
  select g::date into v_day from generate_series(p_start, v_end, interval '1 day') g
   where (select count(*) from public.edition_promo_bookings b where b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and g::date between b.starts_on and b.ends_on) >= v_cap
   order by g limit 1;
  if v_day is not null then raise exception 'no place is free on % for that kind of promotion', to_char(v_day, 'FMDD Mon YYYY') using errcode = '23514', hint = 'full'; end if;
  -- one booking per organiser per kind per day (across all of its Editions)
  if exists (select 1 from public.edition_promo_bookings b where b.organiser_id = e.organiser_id and b.kind = p_kind and b.status = 'booked' and b.id is distinct from p_exclude and b.starts_on <= v_end and b.ends_on >= p_start) then
    raise exception 'you already have this kind of promotion booked on some of those days' using errcode = '23514', hint = 'already_booked';
  end if;
  -- fairness: no organiser above the homepage limit in any rolling 90 days
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

-- cancel one booking (caller holds the locks and has checked who may); a grouped discovery booking takes its group's homepage booking with it
create or replace function public.edition_promo_cancel_core(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.edition_promo_bookings%rowtype; r public.edition_promo_rights%rowtype;
begin
  update public.edition_promo_bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = left(p_reason, 300) where id = p_booking and status = 'booked' returning * into b;
  if not found then raise exception 'that booking is already cancelled' using errcode = '23514', hint = 'not_booked'; end if;
  select * into r from public.edition_promo_rights where id = b.right_id;
  if b.kind = 'discovery' and r.group_id is not null then
    update public.edition_promo_bookings x set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = left(coalesce(p_reason, 'its campaign was cancelled'), 300)
     where x.status = 'booked' and x.kind = 'homepage' and x.right_id in (select y.id from public.edition_promo_rights y where y.group_id = r.group_id and y.kind = 'homepage');
  end if;
  perform public.edition_audit(b.organiser_id, b.edition_id, 'promo_cancelled', jsonb_build_object('booking', b.id, 'kind', b.kind, 'starts_on', b.starts_on, 'ends_on', b.ends_on, 'reason', left(p_reason, 300)));
end $$;

-- move one booking (caller holds the locks and has checked who may and the notice rule)
create or replace function public.edition_promo_reschedule_core(p_booking uuid, p_start date, p_timing boolean, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.edition_promo_bookings%rowtype; r public.edition_promo_rights%rowtype; v_days integer; v_end date; d public.edition_promo_bookings%rowtype; h public.edition_promo_bookings%rowtype;
begin
  select * into b from public.edition_promo_bookings where id = p_booking and status = 'booked' for update;
  if not found then raise exception 'that booking is not active' using errcode = '23514', hint = 'not_booked'; end if;
  select * into r from public.edition_promo_rights where id = b.right_id;
  v_days := r.days; v_end := p_start + v_days - 1;
  perform public.edition_promo_validate(b.edition_id, b.kind, p_start, v_days, b.id, p_timing);
  if r.group_id is not null and b.kind = 'homepage' then
    select x.* into d from public.edition_promo_bookings x join public.edition_promo_rights y on y.id = x.right_id where y.group_id = r.group_id and y.kind = 'discovery' and x.status = 'booked';
    if not found then raise exception 'book the discovery days of this campaign first' using errcode = '23514', hint = 'book_discovery_first'; end if;
    if p_start < d.starts_on or v_end > d.ends_on then raise exception 'the homepage days must sit inside the discovery days of the same campaign' using errcode = '23514', hint = 'outside_discovery'; end if;
  elsif r.group_id is not null and b.kind = 'discovery' then
    select x.* into h from public.edition_promo_bookings x join public.edition_promo_rights y on y.id = x.right_id where y.group_id = r.group_id and y.kind = 'homepage' and x.status = 'booked';
    if found and (h.starts_on < p_start or h.ends_on > v_end) then raise exception 'move the homepage days first: they must stay inside the discovery days' using errcode = '23514', hint = 'homepage_would_fall_outside'; end if;
  end if;
  update public.edition_promo_bookings set starts_on = p_start, ends_on = v_end where id = b.id;
  perform public.edition_audit(b.organiser_id, b.edition_id, 'promo_rescheduled', jsonb_build_object('booking', b.id, 'kind', b.kind, 'from', b.starts_on, 'to', p_start, 'reason', left(p_reason, 300)));
end $$;

-- void what an order granted when it is refunded IN FULL: future bookings are cancelled, unused rights are voided, bookings that have started stay (and so do their rights)
create or replace function public.edition_promo_void_order_rights(p_order uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := public.edition_promo_today();
begin
  perform public.edition_promo_lock();
  update public.edition_promo_bookings b set status = 'cancelled', cancelled_at = now(), cancelled_by = null, cancel_reason = 'order refunded'
    from public.edition_promo_rights r where r.id = b.right_id and r.order_id = p_order and b.status = 'booked' and b.starts_on > v_today;
  update public.edition_promo_rights r set voided_at = now(), void_reason = 'order refunded'
   where r.order_id = p_order and r.voided_at is null and not exists (select 1 from public.edition_promo_bookings b where b.right_id = r.id and b.status = 'booked');
end $$;

-- refuses a PACKAGE while the Edition holds a live un-voided publish entitlement that still has more than renewal_window_days to run
create or replace function public.edition_assert_renewable(p_edition uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_end timestamptz; v_win integer := public.edition_promo_cfg_int('editions.commerce.renewal_window_days', 30);
begin
  select max(n.ends_at) into v_end from public.edition_entitlements n where n.edition_id = p_edition and n.feature = 'publish' and n.voided_at is null and n.ends_at > now();  -- includes a renewal already queued behind the live period
  if v_end is not null and v_end > now() + make_interval(days => v_win) then
    raise exception 'This Edition is already live until %. You can renew it in the last % days.', to_char(v_end at time zone 'Europe/London', 'FMDD FMMonth YYYY'), v_win using errcode = '23514', hint = 'already_live';
  end if;
end $$;

-- ── orders: promotions are bought for an approved, live Edition; fulfilment writes rights; refunds void them ─────────────────────────────────────
create or replace function public.edition_create_order(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an owner or admin can buy a package' using errcode = '42501'; end if;
  if not public.edition_commerce_enabled() then raise exception 'payments are not switched on yet' using errcode = '23514', hint = 'payments_off'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'approved' then raise exception 'a package can be chosen once OneShetland has approved the Edition' using errcode = '23514', hint = 'not_approved'; end if;
  if not public.edition_parent_live(p_org) then raise exception 'the Business or Hub is not active' using errcode = '23514', hint = 'parent_not_live'; end if;
  select * into pk from public.edition_packages where id = p_package and active and retired_at is null;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.is_free then raise exception 'that package is free: claim it instead of paying' using errcode = '23514', hint = 'free_package'; end if;
  if pk.kind = 'promotion' then
    -- a promotion is bought for an Edition that is approved and has a live publishing period; it never creates one
    if not public.edition_entitled(p_edition, 'publish') then raise exception 'promotion can be bought once the Edition has a live publishing period' using errcode = '23514', hint = 'not_live'; end if;
  else
    -- no stacking and no extension product: a package can be bought again only in the last renewal_window_days of the live period (then it starts after the current one ends)
    perform public.edition_assert_renewable(p_edition);
  end if;
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'kind', pk.kind, 'amount', pk.price_pence));
  return v_id;
end $$;

-- a free package: same ledger, no payment. Promotions cannot be claimed this way (an administrator grants promotion days with a reason).
create or replace function public.edition_claim_free_package(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an owner or admin can choose a package' using errcode = '42501'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org for update;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'approved' then raise exception 'a package can be chosen once OneShetland has approved the Edition' using errcode = '23514', hint = 'not_approved'; end if;
  if not public.edition_parent_live(p_org) then raise exception 'the Business or Hub is not active' using errcode = '23514', hint = 'parent_not_live'; end if;
  select * into pk from public.edition_packages where id = p_package and active and retired_at is null and is_free and price_pence = 0 and kind = 'package';
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  perform public.edition_assert_renewable(p_edition);
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), 0, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_fulfil_order(v_id, null, 0);
  perform public.edition_audit(p_org, p_edition, 'free_package_claimed', jsonb_build_object('order', v_id, 'package', pk.code));
  return v_id;
end $$;

-- Service role: the verified payment succeeded. A PACKAGE grants the publish window and the organiser's features (as before) and, when it carries promotion days, the rights for them.
-- A PROMOTION grants rights only: it can never create or extend a publishing period. Idempotent; the amount must match the stored order.
create or replace function public.edition_fulfil_order(p_order uuid, p_payment_intent text, p_amount integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype; v_start timestamptz; v_end timestamptz; f text; pk jsonb; v_kind text; v_disc integer; v_home integer; v_group uuid;
begin
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'unknown order' using errcode = 'P0002'; end if;
  if o.status in ('paid', 'refunded', 'partially_refunded') then return 'already_fulfilled'; end if;
  if p_amount is distinct from o.amount_pence then raise exception 'paid amount does not match the order' using errcode = '23514', hint = 'amount_mismatch'; end if;
  pk := o.package_snapshot; v_kind := coalesce(pk ->> 'kind', 'package');
  if v_kind = 'package' then
    select greatest(now(), coalesce(max(n.ends_at), now())) into v_start from public.edition_entitlements n where n.edition_id = o.edition_id and n.feature = 'publish' and n.voided_at is null and n.ends_at > now();
    v_end := v_start + make_interval(days => (pk ->> 'duration_days')::int);
    insert into public.edition_entitlements (organiser_id, edition_id, feature, starts_at, ends_at, source, order_id, stripe_payment_intent_id, amount_pence)
      values (o.organiser_id, o.edition_id, 'publish', v_start, v_end, 'payment', o.id, p_payment_intent, o.amount_pence);
    for f in select jsonb_array_elements_text(coalesce(pk -> 'features', '[]'::jsonb)) loop
      -- the organiser's abilities start NOW (a later Edition window must not delay them) and last as long as what was bought
      insert into public.edition_organiser_entitlements (organiser_id, feature, max_value, starts_at, ends_at, source, order_id)
        values (o.organiser_id, f, nullif(pk ->> 'max_members', '')::int, now(), v_end, 'payment', o.id);
    end loop;
  end if;
  -- promotion days, from the snapshot taken when the order was made (a later change to the catalogue never changes what was bought)
  v_disc := coalesce(nullif(pk -> 'grants' ->> 'discovery_days', '')::int, 0); v_home := coalesce(nullif(pk -> 'grants' ->> 'homepage_days', '')::int, 0);
  if v_disc > 0 or v_home > 0 then
    v_group := case when coalesce((pk -> 'grants' ->> 'grouped')::boolean, false) and v_disc > 0 and v_home > 0 then gen_random_uuid() end;
    if v_disc > 0 then insert into public.edition_promo_rights (edition_id, organiser_id, order_id, source, kind, days, group_id) values (o.edition_id, o.organiser_id, o.id, 'order', 'discovery', v_disc, v_group); end if;
    if v_home > 0 then insert into public.edition_promo_rights (edition_id, organiser_id, order_id, source, kind, days, group_id) values (o.edition_id, o.organiser_id, o.id, 'order', 'homepage', v_home, v_group); end if;
    perform public.edition_audit(o.organiser_id, o.edition_id, 'promo_rights_created', jsonb_build_object('order', o.id, 'discovery_days', v_disc, 'homepage_days', v_home, 'grouped', v_group is not null));
  end if;
  update public.edition_orders set status = 'paid', paid_at = now(), stripe_payment_intent_id = p_payment_intent where id = o.id;
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_paid', jsonb_build_object('order', o.id, 'amount', o.amount_pence));
  return 'fulfilled';
end $$;

-- Service role: cumulative refund from the provider. Full: voids what the order granted (publish window, features, and unused promotion rights; future bookings are cancelled, started ones stay). Partial: recorded only.
create or replace function public.edition_refund_order(p_order uuid, p_refunded_total integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype;
begin
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'unknown order' using errcode = 'P0002'; end if;
  if o.status not in ('paid', 'partially_refunded', 'refunded') then return 'not_paid'; end if;
  if p_refunded_total <= o.refunded_pence then return 'no_change'; end if;
  if p_refunded_total > o.amount_pence then raise exception 'refund exceeds the order' using errcode = '23514'; end if;
  update public.edition_orders set refunded_pence = p_refunded_total, status = case when p_refunded_total >= o.amount_pence then 'refunded' else 'partially_refunded' end where id = o.id;
  if p_refunded_total >= o.amount_pence then
    update public.edition_entitlements set voided_at = now(), void_reason = 'order refunded' where order_id = o.id and voided_at is null;
    update public.edition_organiser_entitlements set voided_at = now(), void_reason = 'order refunded' where order_id = o.id and voided_at is null;
    perform public.edition_promo_void_order_rights(o.id);
  end if;
  update public.edition_refund_requests set status = 'done', resolved_at = now() where order_id = o.id and status in ('pending', 'submitted');
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_refunded', jsonb_build_object('order', o.id, 'refunded', p_refunded_total));
  return case when p_refunded_total >= o.amount_pence then 'voided' else 'recorded' end;
end $$;

-- ── organisers: see rights, see availability, book, cancel, reschedule ──────────────────────────────────────────────────────────────────────────
-- status: unused | booked | used (the booked days have passed) | void
create or replace function public.edition_my_promo_rights(p_edition uuid)
returns table (right_id uuid, kind text, days integer, group_id uuid, source text, status text, booking_id uuid, starts_on date, ends_on date, created_at timestamptz, void_reason text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_today date := public.edition_promo_today();
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or coalesce(public.is_admin(), false)) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    select r.id, r.kind, r.days, r.group_id, r.source,
           case when r.voided_at is not null then 'void' when b.id is null then 'unused' when b.ends_on < v_today then 'used' else 'booked' end,
           b.id, b.starts_on, b.ends_on, r.created_at, r.void_reason
      from public.edition_promo_rights r
      left join lateral (select x.* from public.edition_promo_bookings x where x.right_id = r.id and x.status = 'booked') b on true
     where r.edition_id = p_edition
     order by r.created_at, r.kind;
end $$;

-- how many places are left each day (no names), for the date picker
create or replace function public.edition_promo_availability(p_kind text, p_from date, p_to date) returns table (day date, capacity integer, booked integer, remaining integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_cap integer;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_kind not in ('discovery', 'homepage') then raise exception 'kind must be discovery or homepage' using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'choose a range of up to 400 days' using errcode = '22023', hint = 'bad_range'; end if;
  v_cap := public.edition_promo_cfg_int(case p_kind when 'homepage' then 'editions.promo.homepage_capacity' else 'editions.promo.discovery_capacity' end, case p_kind when 'homepage' then 3 else 6 end);
  return query
    select g::date, v_cap, c.n, greatest(v_cap - c.n, 0)
      from generate_series(p_from, p_to, interval '1 day') g
      cross join lateral (select count(*)::int as n from public.edition_promo_bookings b where b.kind = p_kind and b.status = 'booked' and g::date between b.starts_on and b.ends_on) c
     order by 1;
end $$;

create or replace function public.edition_promo_book(p_right uuid, p_start date) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_promo_rights%rowtype; v_end date; v_id uuid; d public.edition_promo_bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into r from public.edition_promo_rights where id = p_right;
  if not found or not public.edition_org_can(r.organiser_id, 'admin') then raise exception 'only an owner or admin can schedule promotion' using errcode = '42501'; end if;
  perform public.edition_promo_lock();
  select * into r from public.edition_promo_rights where id = p_right for update;
  if r.voided_at is not null then raise exception 'those promotion days are no longer available' using errcode = '23514', hint = 'right_void'; end if;
  if exists (select 1 from public.edition_promo_bookings b where b.right_id = r.id and b.status = 'booked') then raise exception 'those promotion days are already scheduled' using errcode = '23514', hint = 'right_booked'; end if;
  v_end := p_start + r.days - 1;
  if r.group_id is not null and r.kind = 'homepage' then
    select x.* into d from public.edition_promo_bookings x join public.edition_promo_rights y on y.id = x.right_id where y.group_id = r.group_id and y.kind = 'discovery' and x.status = 'booked';
    if not found then raise exception 'book the discovery days of this campaign first' using errcode = '23514', hint = 'book_discovery_first'; end if;
    if p_start < d.starts_on or v_end > d.ends_on then raise exception 'the homepage days must sit inside the discovery days of the same campaign' using errcode = '23514', hint = 'outside_discovery'; end if;
  end if;
  perform public.edition_promo_validate(r.edition_id, r.kind, p_start, r.days, null, true);
  insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on, created_by) values (r.edition_id, r.organiser_id, r.id, r.kind, p_start, v_end, auth.uid()) returning id into v_id;
  perform public.edition_audit(r.organiser_id, r.edition_id, 'promo_booked', jsonb_build_object('booking', v_id, 'kind', r.kind, 'starts_on', p_start, 'ends_on', v_end));
  return v_id;
end $$;

-- a campaign (a discovery right and a homepage right sharing a group) is booked as one: both succeed or neither does. Returns {discovery_booking, homepage_booking}.
create or replace function public.edition_promo_book_campaign(p_edition uuid, p_group uuid, p_discovery_start date, p_homepage_start date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ed public.editions%rowtype; rd public.edition_promo_rights%rowtype; rh public.edition_promo_rights%rowtype; v_dend date; v_hend date; v_d uuid; v_h uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into ed from public.editions where id = p_edition;
  if not found or not public.edition_org_can(ed.organiser_id, 'admin') then raise exception 'only an owner or admin can schedule promotion' using errcode = '42501'; end if;
  perform public.edition_promo_lock();
  select * into rd from public.edition_promo_rights where group_id = p_group and edition_id = p_edition and kind = 'discovery' for update;
  select * into rh from public.edition_promo_rights where group_id = p_group and edition_id = p_edition and kind = 'homepage' for update;
  if rd.id is null or rh.id is null or rd.voided_at is not null or rh.voided_at is not null then raise exception 'that campaign is not available' using errcode = '23514', hint = 'right_void'; end if;
  if exists (select 1 from public.edition_promo_bookings b where b.right_id in (rd.id, rh.id) and b.status = 'booked') then raise exception 'part of that campaign is already scheduled' using errcode = '23514', hint = 'right_booked'; end if;
  if p_discovery_start is null or p_homepage_start is null then raise exception 'choose both start dates' using errcode = '22023', hint = 'bad_dates'; end if;
  v_dend := p_discovery_start + rd.days - 1; v_hend := p_homepage_start + rh.days - 1;
  if p_homepage_start < p_discovery_start or v_hend > v_dend then raise exception 'the homepage days must sit inside the discovery days of the same campaign' using errcode = '23514', hint = 'outside_discovery'; end if;
  perform public.edition_promo_validate(p_edition, 'discovery', p_discovery_start, rd.days, null, true);
  perform public.edition_promo_validate(p_edition, 'homepage', p_homepage_start, rh.days, null, true);
  insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on, created_by) values (p_edition, rd.organiser_id, rd.id, 'discovery', p_discovery_start, v_dend, auth.uid()) returning id into v_d;
  insert into public.edition_promo_bookings (edition_id, organiser_id, right_id, kind, starts_on, ends_on, created_by) values (p_edition, rh.organiser_id, rh.id, 'homepage', p_homepage_start, v_hend, auth.uid()) returning id into v_h;
  perform public.edition_audit(rd.organiser_id, p_edition, 'promo_campaign_booked', jsonb_build_object('discovery_booking', v_d, 'homepage_booking', v_h, 'discovery_starts_on', p_discovery_start, 'homepage_starts_on', p_homepage_start));
  return jsonb_build_object('discovery_booking', v_d, 'homepage_booking', v_h);
end $$;

-- the owner may cancel or move a booking while it starts at least reschedule_notice_days away; the right then returns to unused
create or replace function public.edition_promo_cancel(p_booking uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.edition_promo_bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into b from public.edition_promo_bookings where id = p_booking;
  if not found or not public.edition_org_can(b.organiser_id, 'admin') then raise exception 'only an owner or admin can change a promotion booking' using errcode = '42501'; end if;
  perform public.edition_promo_lock();
  select * into b from public.edition_promo_bookings where id = p_booking for update;
  if b.status <> 'booked' then raise exception 'that booking is already cancelled' using errcode = '23514', hint = 'not_booked'; end if;
  if b.starts_on < public.edition_promo_today() + public.edition_promo_cfg_int('editions.promo.reschedule_notice_days', 3) then
    raise exception 'a booking can only be changed at least % days before it starts: contact OneShetland', public.edition_promo_cfg_int('editions.promo.reschedule_notice_days', 3) using errcode = '23514', hint = 'too_late';
  end if;
  perform public.edition_promo_cancel_core(p_booking, 'cancelled by the organiser');
end $$;

create or replace function public.edition_promo_reschedule(p_booking uuid, p_start date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.edition_promo_bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into b from public.edition_promo_bookings where id = p_booking;
  if not found or not public.edition_org_can(b.organiser_id, 'admin') then raise exception 'only an owner or admin can change a promotion booking' using errcode = '42501'; end if;
  perform public.edition_promo_lock();
  select * into b from public.edition_promo_bookings where id = p_booking for update;
  if b.status <> 'booked' then raise exception 'that booking is not active' using errcode = '23514', hint = 'not_booked'; end if;
  if b.starts_on < public.edition_promo_today() + public.edition_promo_cfg_int('editions.promo.reschedule_notice_days', 3) then
    raise exception 'a booking can only be changed at least % days before it starts: contact OneShetland', public.edition_promo_cfg_int('editions.promo.reschedule_notice_days', 3) using errcode = '23514', hint = 'too_late';
  end if;
  perform public.edition_promo_reschedule_core(p_booking, p_start, true, 'moved by the organiser');
end $$;

-- ── public: the featured strip and indicative tracking ─────────────────────────────────────────────────────────────────────────────────────────
-- p_kind 'homepage' (strip on the home page) or 'discovery' (the Promoted row on the Editions list). Only Editions that pass edition_is_public (approved, published, entitled, Editions on, parent live,
-- not a test) and have a booking covering today appear; a share of the strip, rotated daily so nobody is permanently first. Counts one 'shown' per row returned.
create or replace function public.edition_featured(p_kind text)
returns table (edition_id uuid, slug text, title text, kind text, starts_on date, ends_on date, summary text, cover_url text, organiser_name text, parent_kind text, parent_slug text)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_today date := public.edition_promo_today(); v_limit integer; v_surface text;
begin
  if p_kind not in ('homepage', 'discovery') then raise exception 'kind must be homepage or discovery' using errcode = '22023'; end if;
  if not public.editions_enabled() then return; end if;
  v_limit := public.edition_promo_cfg_int(case p_kind when 'homepage' then 'editions.promo.homepage_visible' else 'editions.promo.discovery_visible' end, case p_kind when 'homepage' then 3 else 4 end);
  v_surface := case p_kind when 'homepage' then 'home' else 'discovery' end;
  return query
    with picked as materialized (
      select e.id as eid, e.slug as eslug, e.title as etitle, e.kind as ekind, e.starts_on as estart, e.ends_on as eend, e.summary as esummary, e.cover_url as ecover, o.name as oname,
             case when o.hub_id is not null then 'hub' else 'business' end as pkind, coalesce(h.slug, b.slug, b.id::text) as pslug,
             (select k.id from public.edition_promo_bookings k where k.edition_id = e.id and k.kind = p_kind and k.status = 'booked' and v_today between k.starts_on and k.ends_on order by k.starts_on limit 1) as bid
        from public.editions e
        join public.edition_organisers o on o.id = e.organiser_id
        left join public.hubs h on h.id = o.hub_id
        left join public.local_businesses b on b.id = o.business_id
       where e.ends_on >= v_today
         and exists (select 1 from public.edition_promo_bookings k where k.edition_id = e.id and k.kind = p_kind and k.status = 'booked' and v_today between k.starts_on and k.ends_on)
         and public.edition_is_public(e.id)
       order by hashtext(e.id::text || v_today::text), e.id
       limit v_limit),
    bump as (
      insert into public.edition_promo_daily (edition_id, booking_id, day, surface, metric, n)
      select pk.eid, pk.bid, v_today, v_surface, 'shown', 1 from picked pk
      on conflict (edition_id, day, surface, metric) do update set n = public.edition_promo_daily.n + 1)
    select pk.eid, pk.eslug, pk.etitle, pk.ekind, pk.estart, pk.eend, pk.esummary, pk.ecover, pk.oname, pk.pkind, pk.pslug from picked pk order by hashtext(pk.eid::text || v_today::text), pk.eid;
end $$;

-- Indicative counters. Counts only for a PUBLIC Edition with a booking covering today (the surface's own kind for home and discovery; either kind for the Edition page); everything else is silently ignored.
-- A per-key brake (Edition, surface, metric, minute) bounds what anonymous callers can write.
create or replace function public.edition_promo_track(p_edition uuid, p_surface text, p_metric text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_today date := public.edition_promo_today(); v_bid uuid; v_n integer; v_bucket timestamptz := date_trunc('minute', now());
begin
  if p_edition is null or p_surface not in ('home', 'discovery', 'edition_page') or p_metric not in ('shown', 'tap', 'view') then return; end if;
  select k.id into v_bid from public.edition_promo_bookings k
   where k.edition_id = p_edition and k.status = 'booked' and v_today between k.starts_on and k.ends_on
     and (p_surface = 'edition_page' or k.kind = case p_surface when 'home' then 'homepage' else 'discovery' end)
   order by k.starts_on limit 1;
  if v_bid is null or not public.edition_is_public(p_edition) then return; end if;
  insert into public.edition_promo_track_rate (edition_id, surface, metric, bucket, n) values (p_edition, p_surface, p_metric, v_bucket, 1)
  on conflict (edition_id, surface, metric, bucket) do update set n = public.edition_promo_track_rate.n + 1 returning n into v_n;
  if v_n > 120 then return; end if;
  if random() < 0.01 then delete from public.edition_promo_track_rate where bucket < now() - interval '1 hour'; end if;
  insert into public.edition_promo_daily (edition_id, booking_id, day, surface, metric, n) values (p_edition, v_bid, v_today, p_surface, p_metric, 1)
  on conflict (edition_id, day, surface, metric) do update set n = public.edition_promo_daily.n + 1;
end $$;

-- ── reporting (editor and above, or an administrator): follows the bookings; Showcase always has one ────────────────────────────────────────────
create or replace function public.edition_promo_report(p_edition uuid)
returns table (booking_id uuid, kind text, status text, starts_on date, ends_on date, shown bigint, taps bigint, views bigint, saves bigint, plan_adds bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or coalesce(public.is_admin(), false)) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    select b.id, b.kind, b.status, b.starts_on, b.ends_on,
           coalesce((select sum(d.n) from public.edition_promo_daily d where d.edition_id = b.edition_id and d.day between b.starts_on and b.ends_on and d.surface = case b.kind when 'homepage' then 'home' else 'discovery' end and d.metric = 'shown'), 0)::bigint,
           coalesce((select sum(d.n) from public.edition_promo_daily d where d.edition_id = b.edition_id and d.day between b.starts_on and b.ends_on and d.surface = case b.kind when 'homepage' then 'home' else 'discovery' end and d.metric = 'tap'), 0)::bigint,
           coalesce((select sum(d.n) from public.edition_promo_daily d where d.edition_id = b.edition_id and d.day between b.starts_on and b.ends_on and d.surface = 'edition_page' and d.metric = 'view'), 0)::bigint,
           (select count(*) from public.edition_saves s where s.edition_id = b.edition_id and (s.created_at at time zone 'Europe/London')::date between b.starts_on and b.ends_on)::bigint,
           (select count(*) from public.edition_plan_items p where p.edition_id = b.edition_id and (p.created_at at time zone 'Europe/London')::date between b.starts_on and b.ends_on)::bigint
      from public.edition_promo_bookings b where b.edition_id = p_edition order by b.starts_on, b.kind;
end $$;

-- ── administrators ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- one row per day per kind: capacity use and who is booked (names are for staff only)
create or replace function public.admin_edition_promo_calendar(p_from date, p_to date)
returns table (day date, kind text, capacity integer, booked integer, bookings jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'choose a range of up to 400 days' using errcode = '22023', hint = 'bad_range'; end if;
  return query
    select g::date, k.kind,
           public.edition_promo_cfg_int(case k.kind when 'homepage' then 'editions.promo.homepage_capacity' else 'editions.promo.discovery_capacity' end, case k.kind when 'homepage' then 3 else 6 end),
           (select count(*)::int from public.edition_promo_bookings b where b.kind = k.kind and b.status = 'booked' and g::date between b.starts_on and b.ends_on),
           coalesce((select jsonb_agg(jsonb_build_object('booking_id', b.id, 'edition_id', e.id, 'edition_title', e.title, 'organiser_name', o.name, 'starts_on', b.starts_on, 'ends_on', b.ends_on) order by b.starts_on, b.id)
                       from public.edition_promo_bookings b join public.editions e on e.id = b.edition_id join public.edition_organisers o on o.id = b.organiser_id
                      where b.kind = k.kind and b.status = 'booked' and g::date between b.starts_on and b.ends_on), '[]'::jsonb)
      from generate_series(p_from, p_to, interval '1 day') g cross join (values ('discovery'), ('homepage')) k(kind)
     order by 1, 2;
end $$;

-- administrators may always cancel or move a booking (no notice or lead time; the integrity rules still apply); a reason of at least 5 characters is kept in the audit trail
create or replace function public.admin_promo_cancel(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  perform public.edition_promo_lock();
  perform 1 from public.edition_promo_bookings where id = p_booking;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;
  perform public.edition_promo_cancel_core(p_booking, 'cancelled by OneShetland: ' || btrim(p_reason));
end $$;

create or replace function public.admin_promo_reschedule(p_booking uuid, p_start date, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  perform public.edition_promo_lock();
  perform 1 from public.edition_promo_bookings where id = p_booking;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;
  perform public.edition_promo_reschedule_core(p_booking, p_start, false, 'moved by OneShetland: ' || btrim(p_reason));
end $$;

-- grant promotion days with no payment (a goodwill or partnership grant). Booking rules still apply when it is scheduled.
create or replace function public.admin_grant_promo_right(p_edition uuid, p_kind text, p_days integer, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  if p_kind not in ('discovery', 'homepage') then raise exception 'kind must be discovery or homepage' using errcode = '22023'; end if;
  if p_days is null or p_days not between 1 and 120 then raise exception 'a grant is for 1 to 120 days' using errcode = '23514', hint = 'bad_days'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days, granted_by, reason) values (e.id, e.organiser_id, 'admin_grant', p_kind, p_days, auth.uid(), btrim(p_reason)) returning id into v_id;
  perform public.edition_audit(e.organiser_id, e.id, 'promo_right_granted', jsonb_build_object('right', v_id, 'kind', p_kind, 'days', p_days, 'reason', btrim(p_reason)));
  return v_id;
end $$;

-- ── privileges: explicit revoke, then grant. Anonymous visitors: edition_featured and edition_promo_track ONLY. Money-driven functions: service role only. ──
do $$ declare f text; begin
  foreach f in array array[
    'edition_assert_renewable(uuid)', 'edition_promo_lock()', 'edition_promo_validate(uuid,text,date,integer,uuid,boolean)', 'edition_promo_cancel_core(uuid,text)', 'edition_promo_reschedule_core(uuid,date,boolean,text)', 'edition_promo_void_order_rights(uuid)',
    'edition_create_order(uuid,uuid,uuid,text)', 'edition_claim_free_package(uuid,uuid,uuid,text)', 'edition_fulfil_order(uuid,text,integer)', 'edition_refund_order(uuid,integer)',
    'edition_my_promo_rights(uuid)', 'edition_promo_availability(text,date,date)', 'edition_promo_book(uuid,date)', 'edition_promo_book_campaign(uuid,uuid,date,date)', 'edition_promo_cancel(uuid)', 'edition_promo_reschedule(uuid,date)',
    'edition_featured(text)', 'edition_promo_track(uuid,text,text)', 'edition_promo_report(uuid)',
    'admin_edition_promo_calendar(date,date)', 'admin_promo_cancel(uuid,text)', 'admin_promo_reschedule(uuid,date,text)', 'admin_grant_promo_right(uuid,text,integer,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'edition_create_order(uuid,uuid,uuid,text)', 'edition_claim_free_package(uuid,uuid,uuid,text)',
    'edition_my_promo_rights(uuid)', 'edition_promo_availability(text,date,date)', 'edition_promo_book(uuid,date)', 'edition_promo_book_campaign(uuid,uuid,date,date)', 'edition_promo_cancel(uuid)', 'edition_promo_reschedule(uuid,date)',
    'edition_featured(text)', 'edition_promo_track(uuid,text,text)', 'edition_promo_report(uuid)',
    'admin_edition_promo_calendar(date,date)', 'admin_promo_cancel(uuid,text)', 'admin_promo_reschedule(uuid,date,text)', 'admin_grant_promo_right(uuid,text,integer,text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['edition_featured(text)', 'edition_promo_track(uuid,text,text)'] loop
    execute format('grant execute on function public.%s to anon', f);
  end loop;
  foreach f in array array['edition_fulfil_order(uuid,text,integer)', 'edition_refund_order(uuid,integer)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

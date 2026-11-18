-- Rollback of 20270104010000_editions_promotion_rpcs (run BEFORE the part-1 rollback). Re-runnable.
-- Promotion bookings, rights and counters live in the part-1 tables and are discarded by the part-1 rollback; money already taken is unaffected (orders are untouched). Orders for PROMOTION
-- packages keep their rows and snapshot, but the rights they granted are lost with the tables, so an administrator would have to re-grant them by hand after any re-apply.
drop function if exists public.edition_assert_renewable(uuid);
drop function if exists public.edition_promo_lock();
drop function if exists public.edition_promo_validate(uuid, text, date, integer, uuid, boolean);
drop function if exists public.edition_promo_cancel_core(uuid, text);
drop function if exists public.edition_promo_reschedule_core(uuid, date, boolean, text);
drop function if exists public.edition_promo_void_order_rights(uuid);
drop function if exists public.edition_my_promo_rights(uuid);
drop function if exists public.edition_promo_availability(text, date, date);
drop function if exists public.edition_promo_book(uuid, date);
drop function if exists public.edition_promo_book_campaign(uuid, uuid, date, date);
drop function if exists public.edition_promo_cancel(uuid);
drop function if exists public.edition_promo_reschedule(uuid, date);
drop function if exists public.edition_featured(text);
drop function if exists public.edition_promo_track(uuid, text, text);
drop function if exists public.edition_promo_report(uuid);
drop function if exists public.admin_edition_promo_calendar(date, date);
drop function if exists public.admin_promo_cancel(uuid, text);
drop function if exists public.admin_promo_reschedule(uuid, date, text);
drop function if exists public.admin_grant_promo_right(uuid, text, integer, text);

-- the order functions return to their previous bodies (the audience gate returns with them; edition_org_is_hub_run still exists). Skipped when older rollbacks already removed the tables (re-run safe).
do $rb$ begin
  if to_regclass('public.edition_orders') is not null and to_regclass('public.edition_packages') is not null then
    execute $f$
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
  select * into pk from public.edition_packages where id = p_package and active;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.is_free then raise exception 'that package is free: claim it instead of paying' using errcode = '23514', hint = 'free_package'; end if;
  if pk.audience = 'hub' and not public.edition_org_is_hub_run(p_org) then raise exception 'that package is for Hub-run Editions' using errcode = '23514', hint = 'hub_only_package'; end if;
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'amount', pk.price_pence));
  return v_id;
end $$;
    $f$;
    execute $f$
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
  select * into pk from public.edition_packages where id = p_package and active and is_free and price_pence = 0;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.audience = 'hub' and not public.edition_org_is_hub_run(p_org) then raise exception 'that package is for Hub-run Editions' using errcode = '23514', hint = 'hub_only_package'; end if;
  if public.edition_entitled(p_edition, 'publish') then raise exception 'this Edition already has an active package' using errcode = '23514', hint = 'already_entitled'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), 0, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_fulfil_order(v_id, null, 0);
  perform public.edition_audit(p_org, p_edition, 'free_package_claimed', jsonb_build_object('order', v_id, 'package', pk.code));
  return v_id;
end $$;
    $f$;
    execute $f$
create or replace function public.edition_fulfil_order(p_order uuid, p_payment_intent text, p_amount integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype; v_start timestamptz; v_end timestamptz; f text; pk jsonb;
begin
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'unknown order' using errcode = 'P0002'; end if;
  if o.status in ('paid', 'refunded', 'partially_refunded') then return 'already_fulfilled'; end if;
  if p_amount is distinct from o.amount_pence then raise exception 'paid amount does not match the order' using errcode = '23514', hint = 'amount_mismatch'; end if;
  pk := o.package_snapshot;
  select greatest(now(), coalesce(max(n.ends_at), now())) into v_start from public.edition_entitlements n where n.edition_id = o.edition_id and n.feature = 'publish' and n.voided_at is null and n.ends_at > now();
  v_end := v_start + make_interval(days => (pk ->> 'duration_days')::int);
  insert into public.edition_entitlements (organiser_id, edition_id, feature, starts_at, ends_at, source, order_id, stripe_payment_intent_id, amount_pence)
    values (o.organiser_id, o.edition_id, 'publish', v_start, v_end, 'payment', o.id, p_payment_intent, o.amount_pence);
  for f in select jsonb_array_elements_text(coalesce(pk -> 'features', '[]'::jsonb)) loop
    -- the organiser's abilities start NOW (a later Edition window must not delay them) and last as long as what was bought
    insert into public.edition_organiser_entitlements (organiser_id, feature, max_value, starts_at, ends_at, source, order_id)
      values (o.organiser_id, f, nullif(pk ->> 'max_members', '')::int, now(), v_end, 'payment', o.id);
  end loop;
  update public.edition_orders set status = 'paid', paid_at = now(), stripe_payment_intent_id = p_payment_intent where id = o.id;
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_paid', jsonb_build_object('order', o.id, 'amount', o.amount_pence));
  return 'fulfilled';
end $$;
    $f$;
    execute $f$
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
  end if;
  update public.edition_refund_requests set status = 'done', resolved_at = now() where order_id = o.id and status in ('pending', 'submitted');
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_refunded', jsonb_build_object('order', o.id, 'refunded', p_refunded_total));
  return case when p_refunded_total >= o.amount_pence then 'voided' else 'recorded' end;
end $$;
    $f$;
    revoke all on function public.edition_create_order(uuid, uuid, uuid, text), public.edition_claim_free_package(uuid, uuid, uuid, text), public.edition_fulfil_order(uuid, text, integer), public.edition_refund_order(uuid, integer) from public, anon, authenticated;
    grant execute on function public.edition_create_order(uuid, uuid, uuid, text) to authenticated;
    grant execute on function public.edition_claim_free_package(uuid, uuid, uuid, text) to authenticated;
    grant execute on function public.edition_fulfil_order(uuid, text, integer) to service_role;
    grant execute on function public.edition_refund_order(uuid, integer) to service_role;
  end if;
end $rb$;

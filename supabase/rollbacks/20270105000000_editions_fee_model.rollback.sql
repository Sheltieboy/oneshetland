-- Rollback of 20270105000000_editions_fee_model. Re-runnable. Restores the previous (5% flat commission, no processing-cost recovery) behaviour of every function it replaced, from the migrations that defined them.
-- DISCARDS the fee-model facts: the dispute recovery queue, commission/estimate/variance/dispute columns on edition_payments, the commission-refund plan on refund requests, the VAT-readiness columns on edition_orders,
-- and exceptions of the new kinds. Ledger rows themselves (amounts, refunds, fees recorded as platform_fee_pence) are kept.

-- 1) things that must go before the old shapes can come back
drop function if exists public.edition_charge_breakdown(text, integer, text, uuid);
drop function if exists public.edition_fee_calc(text, integer, uuid);
drop function if exists public.edition_commission_rates();
drop function if exists public.edition_fee_parts(text, integer, uuid);
drop function if exists public.admin_edition_fee_statement(timestamptz, timestamptz);
drop function if exists public.edition_org_payments(uuid, timestamptz, timestamptz, text);
drop function if exists public.edition_org_statement(uuid, timestamptz, timestamptz);
drop function if exists public.edition_participation_payment_succeeded(uuid, text, text, integer, integer, integer);
drop function if exists public.admin_set_edition_fee_override(uuid, text, numeric, integer, boolean, text, timestamptz, boolean);
drop function if exists public.admin_edition_variance_report(timestamptz, timestamptz, text);
drop function if exists public.admin_edition_variance_items(timestamptz, timestamptz);
drop function if exists public.admin_edition_fee_model_notes();
drop function if exists public.admin_retry_edition_dispute_recovery(text, text);
drop function if exists public.edition_dispute_event(text, text, text, text, integer, integer, text);
drop function if exists public.edition_dispute_recoveries_next();
drop function if exists public.edition_dispute_recovery_mark(text, text, text, text);
drop function if exists public.edition_dispute_commission_next();
drop function if exists public.edition_dispute_commission_mark(text, text, text);
drop function if exists public.edition_commission_plan_pending();
drop function if exists public.edition_commission_refunds_next();
drop function if exists public.edition_commission_refund_mark(uuid, text, text);
drop function if exists public.edition_payment_note_stripe_fee(uuid, integer);
drop function if exists public.edition_payment_note_app_fee(uuid, integer, integer);
drop table if exists public.edition_dispute_recoveries;
drop trigger if exists edition_refund_request_before on public.edition_refund_requests;
drop function if exists public.edition_refund_request_before();
drop trigger if exists edition_payments_parts_default on public.edition_payments;
drop function if exists public.edition_payments_parts_default();

-- 2) to 4) exceptions, columns and configuration: each guarded, so a second run (or a run after older rollbacks removed the tables) is harmless
do $$ begin
  if to_regclass('public.edition_reconciliation_exceptions') is not null then
    delete from public.edition_reconciliation_exceptions where kind in ('fee_variance', 'commission_refund_mismatch', 'transfer_mismatch', 'dispute_recovery_failed', 'commission_refund_failed');
    perform 1;
    declare c text; begin
      select conname into c from pg_constraint where conrelid = 'public.edition_reconciliation_exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
      if c is not null then execute format('alter table public.edition_reconciliation_exceptions drop constraint %I', c); end if;
      alter table public.edition_reconciliation_exceptions add constraint edition_recon_kind_check check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch',
        'destination_mismatch', 'dispute', 'amount_refused', 'duplicate_payment', 'payment_after_cancel', 'duplicate_subscription', 'refund_failed'));
    end;
  end if;
  if to_regclass('public.edition_payments') is not null then
    alter table public.edition_payments drop constraint if exists edition_payments_commission_refund_cap;
    alter table public.edition_payments drop column if exists commission_pence, drop column if exists recovery_estimate_pence, drop column if exists commission_refunded_pence, drop column if exists application_fee_actual_pence,
      drop column if exists recovery_variance_pence, drop column if exists stripe_fee_refunded_pence, drop column if exists dispute_state, drop column if exists dispute_lost_pence, drop column if exists dispute_recovered_pence;
  end if;
  if to_regclass('public.edition_refund_requests') is not null then
    alter table public.edition_refund_requests drop column if exists refunded_before_pence, drop column if exists commission_refund_pence, drop column if exists commission_refund_status, drop column if exists commission_attempts,
      drop column if exists commission_last_error, drop column if exists commission_next_attempt_at;
  end if;
  if to_regclass('public.edition_orders') is not null then
    alter table public.edition_orders drop column if exists net_pence, drop column if exists vat_pence, drop column if exists vat_rate_percent, drop column if exists buyer_vat_number, drop column if exists billing_name,
      drop column if exists billing_address, drop column if exists vat_note;
  end if;
  if to_regclass('public.edition_commercial_overrides') is not null then alter table public.edition_commercial_overrides drop column if exists recovery_waived; end if;
  -- configuration added by the migration (the commission rows go too: the previous default was 5%)
  delete from public.admin_config where key in ('editions.commerce.participation.stripe_cost_percent', 'editions.commerce.membership.stripe_cost_percent', 'editions.commerce.participation.stripe_cost_fixed_pence',
    'editions.commerce.membership.stripe_cost_fixed_pence', 'editions.commerce.stripe_cost_confirmed', 'editions.commerce.variance_alert_pence', 'editions.commerce.fee_tolerance_pence',
    'editions.commerce.refund_commission_on_dispute', 'platform.vat_registered');
  delete from public.admin_config where key in ('editions.commerce.participation.fee_percent', 'editions.commerce.membership.fee_percent') and value = '2';
end $$;

-- 5) the previous functions, exactly as their migrations defined them
-- admin_set_edition_commerce_config as of 20270104000000_editions_launch_showcase_promotions.sql
-- Skipped when an older rollback has already removed the tables these functions are written against (a second run in reverse order).
do $do$ begin
  if to_regclass('public.edition_payments') is not null and to_regclass('public.edition_commercial_overrides') is not null and to_regclass('public.organiser_memberships') is not null and to_regclass('public.edition_orders') is not null then
    execute $fn$
create or replace function public.admin_set_edition_commerce_config(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  v_ok := case
    when p_key = 'editions.commerce.enabled' then p_value in ('true', 'false')
    when p_key in ('editions.commerce.participation.fee_percent', 'editions.commerce.membership.fee_percent') then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 50
    when p_key in ('editions.commerce.participation.fee_fixed_pence', 'editions.commerce.membership.fee_fixed_pence', 'editions.commerce.participation.fee_min_pence', 'editions.commerce.membership.fee_min_pence')
      then p_value ~ '^[0-9]{1,5}$'
    when p_key in ('editions.commerce.participation.fee_cap_pence', 'editions.commerce.membership.fee_cap_pence') then p_value ~ '^[0-9]{1,7}$' or p_value = ''
    when p_key = 'editions.commerce.fee_payer' then p_value in ('organiser', 'business')
    when p_key = 'editions.commerce.grace_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    when p_key = 'editions.commerce.max_charge_pence' then p_value ~ '^[0-9]{3,7}$'
    when p_key = 'editions.commerce.refund_application_fee' then p_value in ('true', 'false')
    when p_key = 'editions.commerce.vat_rate_percent' then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 30
    when p_key = 'editions.commerce.terms_version' then p_value ~ '^[A-Za-z0-9._-]{1,20}$'
    -- promotions: whole numbers inside sane bounds
    when p_key in ('editions.promo.homepage_capacity', 'editions.promo.discovery_capacity') then p_value ~ '^[0-9]{1,2}$' and p_value::int between 1 and 50
    when p_key in ('editions.promo.homepage_visible', 'editions.promo.discovery_visible') then p_value ~ '^[0-9]{1,2}$' and p_value::int between 1 and 12
    when p_key = 'editions.promo.lead_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 30
    when p_key = 'editions.promo.horizon_days' then p_value ~ '^[0-9]{1,3}$' and p_value::int between 1 and 730
    when p_key = 'editions.promo.homepage_days_per_90' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 90
    when p_key = 'editions.commerce.renewal_window_days' then p_value ~ '^[0-9]{1,3}$' and p_value::int <= 365
    when p_key = 'editions.promo.reschedule_notice_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    -- the one note shown beside a price: plain text only (no markup, no control characters), may be empty
    when p_key = 'editions.commerce.vat_note' then char_length(p_value) <= 300 and p_value !~ '[<>[:cntrl:]]'
    when p_key in ('editions.app.handoff_ios', 'editions.app.handoff_android') then p_value in ('on', 'off')
    else false end;
  if not coalesce(v_ok, false) then raise exception 'that setting or value is not allowed' using errcode = '22023'; end if;
  insert into public.admin_config (key, value, category) values (p_key, p_value, 'editions') on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'commerce_config_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_payments_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'payments cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'status' - 'refunded_pence' - 'stripe_fee_pence' - 'stripe_charge_id') is distinct from (to_jsonb(old) - 'status' - 'refunded_pence' - 'stripe_fee_pence' - 'stripe_charge_id') then
    raise exception 'payments are append-only (only status, refunds and Stripe fee detail may change)' using errcode = '42501';
  end if;
  if new.refunded_pence < old.refunded_pence then raise exception 'a refund cannot be reduced' using errcode = '23514'; end if;
  return new;
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_fee_calc(p_kind text, p_base_pence integer, p_org uuid) returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.edition_commercial_overrides; v_pct numeric; v_fixed integer; v_min integer; v_cap integer; v_fee integer; k text := 'editions.commerce.' || p_kind;
begin
  if p_kind not in ('participation', 'membership') then raise exception 'unknown fee kind' using errcode = '22023'; end if;
  if p_base_pence is null or p_base_pence <= 0 then return 0; end if;
  select * into o from public.edition_commercial_overrides x where x.organiser_id = p_org and x.kind = p_kind and (x.until is null or x.until > now()) order by x.created_at desc limit 1;
  if found and o.waived then return 0; end if;
  v_pct := coalesce(case when found then o.fee_percent end, public.edition_commerce_cfg(k || '.fee_percent', '5')::numeric);
  v_fixed := coalesce(case when found then o.fee_fixed_pence end, public.edition_commerce_cfg(k || '.fee_fixed_pence', '0')::integer);
  v_min := public.edition_commerce_cfg(k || '.fee_min_pence', '0')::integer;
  v_cap := nullif(public.edition_commerce_cfg(k || '.fee_cap_pence', ''), '')::integer;
  v_fee := round(p_base_pence * v_pct / 100.0)::integer + v_fixed;
  v_fee := greatest(v_fee, v_min);
  if v_cap is not null then v_fee := least(v_fee, v_cap); end if;
  return least(v_fee, p_base_pence);
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_charge_breakdown(p_kind text, p_price_pence integer, p_vat_mode text, p_org uuid)
returns table (price_pence integer, vat_pence integer, platform_fee_pence integer, charge_pence integer, net_to_organiser_pence integer, vat_mode text, fee_payer text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rate numeric := public.edition_commerce_cfg('editions.commerce.vat_rate_percent', '20')::numeric; v_reg boolean; v_mode text := coalesce(p_vat_mode, 'none');
        v_vat integer := 0; v_gross integer; v_fee integer; v_payer text := public.edition_commerce_cfg('editions.commerce.fee_payer', 'organiser'); v_charge integer;
begin
  if p_price_pence is null or p_price_pence < 0 then raise exception 'invalid price' using errcode = '22023'; end if;
  select coalesce(a.vat_registered, false) into v_reg from public.edition_payout_accounts a where a.organiser_id = p_org;
  if not coalesce(v_reg, false) then v_mode := 'none'; end if;
  if v_mode = 'inclusive' then v_vat := round(p_price_pence - p_price_pence / (1 + v_rate / 100))::integer; v_gross := p_price_pence;
  elsif v_mode = 'exclusive' then v_vat := round(p_price_pence * v_rate / 100)::integer; v_gross := p_price_pence + v_vat;
  else v_gross := p_price_pence; end if;
  v_fee := public.edition_fee_calc(p_kind, v_gross, p_org);
  v_charge := case when v_payer = 'business' then v_gross + v_fee else v_gross end;
  return query select p_price_pence, v_vat, v_fee, v_charge, (v_charge - v_fee), v_mode, v_payer;
end $$;

    $fn$;
    execute $fn$
create or replace function public.admin_set_edition_fee_override(p_org uuid, p_kind text, p_percent numeric, p_fixed integer, p_waived boolean, p_reason text, p_until timestamptz default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  insert into public.edition_commercial_overrides (organiser_id, kind, fee_percent, fee_fixed_pence, waived, reason, set_by, until)
  values (p_org, p_kind, p_percent, p_fixed, coalesce(p_waived, false), p_reason, auth.uid(), p_until) returning id into v_id;
  perform public.edition_audit(p_org, null, 'fee_override_set', jsonb_build_object('kind', p_kind, 'percent', p_percent, 'fixed', p_fixed, 'waived', p_waived, 'until', p_until, 'reason', p_reason));
  return v_id;
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_participation_payment_succeeded(p_link uuid, p_payment_intent text, p_charge text, p_charge_pence integer, p_stripe_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_participations%rowtype; l public.edition_links%rowtype; e public.editions%rowtype; q record; v_pay uuid; v_dup uuid;
begin
  select * into p from public.edition_participations where link_id = p_link for update;
  if not found then raise exception 'unknown participation' using errcode = 'P0002'; end if;
  select id into v_dup from public.edition_payments where stripe_payment_intent_id = p_payment_intent and stripe_invoice_id is null;
  if v_dup is not null then return 'already_recorded'; end if;
  -- A SECOND card payment for a fee that is already covered (for example a retry that slipped past the provider's idempotency window). Never loop the webhook on it and
  -- never lose it: record an exception for the administrator, who refunds it. Money is not silently kept and the first payment stands.
  if p.status in ('paid', 'waived', 'member_benefit') then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, detail)
    values ((select e2.organiser_id from public.editions e2 where e2.id = p.edition_id), 'duplicate_payment', p_payment_intent, jsonb_build_object('link', p_link, 'charge_pence', p_charge_pence, 'charge', p_charge, 'covered_by', p.status))
    on conflict do nothing;
    return 'duplicate_needs_refund';
  end if;
  if p.status not in ('awaiting_payment', 'refunded') then raise exception 'participation is not awaiting payment (%)', p.status using errcode = '23514'; end if;
  if p_charge_pence is distinct from p.quoted_charge_pence then raise exception 'charged amount does not match the quoted price' using errcode = '23514', hint = 'amount_mismatch'; end if;
  select * into l from public.edition_links where id = p_link; select * into e from public.editions where id = p.edition_id;
  select * into q from public.edition_charge_breakdown('participation', p.quoted_price_pence, (select t.vat_mode from public.edition_participation_terms t where t.edition_id = p.edition_id), e.organiser_id);
  v_pay := public.edition_record_payment_row(e.organiser_id, p.business_id, 'participation', p.id, 'stripe', 'succeeded', q.price_pence, q.vat_pence, q.vat_mode, q.platform_fee_pence, q.charge_pence, q.net_to_organiser_pence,
    p_payment_intent, null, p_charge, null, null, null, null, (select created_by from public.edition_links where id = p_link), null, null);
  if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
  update public.edition_participations set status = 'paid', payment_id = v_pay, updated_at = now() where id = p.id;
  perform public.edition_audit(e.organiser_id, p.edition_id, 'participation_paid', jsonb_build_object('link', p_link, 'charge', p_charge_pence));
  return 'recorded';
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_membership_payment_succeeded(p_membership uuid, p_subscription text, p_payment_intent text, p_invoice text, p_charge text,
  p_period_start timestamptz, p_period_end timestamptz, p_charge_pence integer, p_stripe_fee integer default null, p_platform_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; b record; v_dup uuid; v_pay uuid; v_dead boolean := false;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found then raise exception 'unknown membership' using errcode = 'P0002'; end if;
  if p_invoice is not null then select id into v_dup from public.edition_payments where stripe_invoice_id = p_invoice;
  else select id into v_dup from public.edition_payments where stripe_payment_intent_id = p_payment_intent and stripe_invoice_id is null; end if;
  if v_dup is not null then return 'already_recorded'; end if;
  if m.status not in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end', 'expired', 'cancelled', 'withdrawn', 'declined') then raise exception 'membership is not payable in status %', m.status using errcode = '23514'; end if;
  v_dead := m.status in ('cancelled', 'withdrawn', 'declined');   -- a grace-expired card membership may still be recovered by paying; a cancelled one may not
  select * into b from public.edition_charge_breakdown('membership', m.price_pence, m.vat_mode, m.organiser_id);
  if p_charge_pence is distinct from b.charge_pence then raise exception 'charged amount does not match the membership price' using errcode = '23514', hint = 'amount_mismatch'; end if;
  -- A SECOND provider subscription paid for a membership that already has one (for example a card retry that created a new subscription). The money is recorded so nothing is lost, the
  -- membership keeps its FIRST subscription, an exception is raised for the administrator (refund), and the extra subscription is queued to be cancelled so it never bills again.
  if m.stripe_subscription_id is not null and p_subscription is not null and p_subscription <> m.stripe_subscription_id then
    v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, 'stripe', 'succeeded', b.price_pence, b.vat_pence, b.vat_mode, coalesce(p_platform_fee, b.platform_fee_pence), b.charge_pence,
    b.charge_pence - coalesce(p_platform_fee, b.platform_fee_pence), p_payment_intent, p_invoice, p_charge, p_period_start, p_period_end, null, null, m.owner_user_id, null, null);
    if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (m.organiser_id, 'duplicate_subscription', coalesce(p_invoice, p_payment_intent), v_pay,
      jsonb_build_object('membership', m.id, 'kept', m.stripe_subscription_id, 'extra', p_subscription, 'charge', p_charge_pence)) on conflict do nothing;
    insert into public.edition_stripe_stray_subscriptions (subscription_id, membership_id) values (p_subscription, m.id) on conflict (subscription_id) do update set status = 'pending', updated_at = now();
    perform public.edition_mem_event(m.id, 'duplicate_subscription', jsonb_build_object('extra', p_subscription));
    return 'recorded_duplicate_subscription';
  end if;
  -- Subscriptions can only carry the platform fee as a percentage, so the provider's actual fee is the truth for the ledger; a difference from the computed fee is
  -- surfaced to reconciliation rather than hidden.
  v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, 'stripe', 'succeeded', b.price_pence, b.vat_pence, b.vat_mode, coalesce(p_platform_fee, b.platform_fee_pence), b.charge_pence,
    b.charge_pence - coalesce(p_platform_fee, b.platform_fee_pence), p_payment_intent, p_invoice, p_charge, p_period_start, p_period_end, null, null, m.owner_user_id, null, null);
  if p_platform_fee is not null and p_platform_fee is distinct from b.platform_fee_pence then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (m.organiser_id, 'fee_mismatch', coalesce(p_invoice, p_payment_intent), v_pay, jsonb_build_object('provider', p_platform_fee, 'computed', b.platform_fee_pence)) on conflict do nothing;
  end if;
  if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
  if v_dead then
    -- A payment arrived for a membership that has been cancelled, withdrawn or declined (the provider kept billing). The money is recorded in the ledger so nothing is lost, the membership is
    -- NOT revived, an exception is raised so an administrator can refund it, and the provider subscription is cancelled.
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (m.organiser_id, 'payment_after_cancel', coalesce(p_invoice, p_payment_intent), v_pay, jsonb_build_object('membership', m.id, 'status', m.status, 'charge_pence', p_charge_pence)) on conflict do nothing;
    update public.organiser_memberships set stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id), updated_at = now() where id = m.id;
    perform public.edition_stripe_cancel_enqueue(m.id, 'now');
    update public.edition_stripe_cancel_queue set status = 'pending', updated_at = now() where membership_id = m.id;   -- the provider is billing again: re-open a finished cancel
    perform public.edition_mem_event(m.id, 'payment_after_cancel', jsonb_build_object('charge', p_charge_pence));
    return 'recorded_after_cancel';
  end if;
  update public.organiser_memberships set status = case when status = 'cancel_at_period_end' then 'cancel_at_period_end' else 'active' end, past_due_since = null, stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
    current_period_start = p_period_start, current_period_end = p_period_end, joined_at = coalesce(joined_at, now()), updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, 'payment_succeeded', jsonb_build_object('charge', p_charge_pence, 'period_end', p_period_end));
  return 'recorded';
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_reconcile_apply(p_snapshot jsonb, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; p public.edition_payments%rowtype; a text; v_n int := 0; v_seen text[] := '{}'; v_pi text;
begin
  if jsonb_typeof(coalesce(p_snapshot, '[]'::jsonb)) <> 'array' then raise exception 'snapshot must be an array' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_snapshot) loop
    v_pi := s ->> 'payment_intent'; v_seen := v_seen || v_pi;
    select * into p from public.edition_payments where stripe_payment_intent_id = v_pi order by created_at desc limit 1;
    if not found then
      -- a subscription invoice's charge carries no Edition marker, so the provider snapshot flags it marked=false: it is only compared when the ledger knows it, never reported as missing
      if coalesce(s ->> 'marked', 'true') = 'true' and coalesce(s ->> 'status', 'succeeded') = 'succeeded' then insert into public.edition_reconciliation_exceptions (kind, provider_ref, detail) values ('missing_in_ledger', v_pi, s) on conflict do nothing; v_n := v_n + 1; end if;
      continue;
    end if;
    if (s ->> 'amount')::int is distinct from p.charge_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'amount_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'amount', 'ledger', p.charge_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    if s ? 'application_fee' and (s ->> 'application_fee')::int is distinct from p.platform_fee_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'fee_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'application_fee', 'ledger', p.platform_fee_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    if s ? 'refunded' and (s ->> 'refunded')::int is distinct from p.refunded_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'refund_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'refunded', 'ledger', p.refunded_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    a := public.edition_payout_account_for(p.organiser_id);
    if s ? 'destination' and (s ->> 'destination') is distinct from a then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'destination_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'destination')) on conflict do nothing; v_n := v_n + 1; end if;
  end loop;
  for p in select * from public.edition_payments x where x.source = 'stripe' and x.status in ('succeeded', 'partially_refunded', 'refunded') and x.created_at between p_from and p_to and x.stripe_payment_intent_id is not null and not (x.stripe_payment_intent_id = any (v_seen)) loop
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'missing_at_provider', p.stripe_payment_intent_id, p.id, jsonb_build_object('charge', p.charge_pence)) on conflict do nothing; v_n := v_n + 1;
  end loop;
  return jsonb_build_object('checked', jsonb_array_length(p_snapshot), 'exceptions_raised', v_n);
end $$;

    $fn$;
    execute $fn$
create or replace function public.admin_edition_fee_statement(p_from timestamptz, p_to timestamptz)
returns table (organiser_id uuid, organiser_name text, payments integer, gross_pence bigint, platform_fee_pence bigint, refunded_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select o.id, o.name, count(*)::int, sum(p.charge_pence), sum(p.platform_fee_pence), sum(p.refunded_pence)
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id where p.source = 'stripe' and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by o.id, o.name order by 5 desc;
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_org_payments(p_org uuid, p_from timestamptz default null, p_to timestamptz default null, p_kind text default null)
returns table (payment_id uuid, created_at timestamptz, kind text, business_name text, source text, status text, price_pence integer, vat_pence integer, platform_fee_pence integer, stripe_fee_pence integer, charge_pence integer,
               net_to_organiser_pence integer, refunded_pence integer, method text, period_start timestamptz, period_end timestamptz, note text, ref_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select p.id, p.created_at, p.kind, b.name, p.source, p.status, p.price_pence, p.vat_pence, p.platform_fee_pence, p.stripe_fee_pence, p.charge_pence, p.net_to_organiser_pence, p.refunded_pence, p.method, p.period_start, p.period_end, p.note,
    case p.kind when 'membership' then (select t.name from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id where m.id = p.ref_id)
                else (select e.title from public.edition_participations x join public.editions e on e.id = x.edition_id where x.id = p.ref_id) end
    from public.edition_payments p join public.local_businesses b on b.id = p.business_id
   where p.organiser_id = p_org and (p_from is null or p.created_at >= p_from) and (p_to is null or p.created_at < p_to) and (p_kind is null or p.kind = p_kind) order by p.created_at desc limit 1000;
end $$;

    $fn$;
    execute $fn$
create or replace function public.edition_org_statement(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (month text, payments integer, gross_pence bigint, vat_pence bigint, platform_fee_pence bigint, stripe_fee_pence bigint, net_to_organiser_pence bigint, refunded_pence bigint, offline_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select to_char(date_trunc('month', p.created_at at time zone 'Europe/London'), 'YYYY-MM'), count(*)::int, sum(p.charge_pence) filter (where p.source = 'stripe'), sum(p.vat_pence) filter (where p.source = 'stripe'),
    sum(p.platform_fee_pence) filter (where p.source = 'stripe'), sum(p.stripe_fee_pence) filter (where p.source = 'stripe'), sum(p.net_to_organiser_pence) filter (where p.source = 'stripe'), sum(p.refunded_pence), sum(p.charge_pence) filter (where p.source = 'offline')
    from public.edition_payments p where p.organiser_id = p_org and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by 1 order by 1;
end $$;
    $fn$;
    -- 6) privileges as before
    declare f text; begin
  foreach f in array array['admin_set_edition_commerce_config(text,text)', 'edition_payments_guard()', 'edition_fee_calc(text,integer,uuid)', 'edition_charge_breakdown(text,integer,text,uuid)',
    'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz)', 'edition_participation_payment_succeeded(uuid,text,text,integer,integer)',
    'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)', 'edition_reconcile_apply(jsonb,timestamptz,timestamptz)',
    'admin_edition_fee_statement(timestamptz,timestamptz)', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_org_statement(uuid,timestamptz,timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['admin_set_edition_commerce_config(text,text)', 'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz)', 'edition_charge_breakdown(text,integer,text,uuid)',
    'admin_edition_fee_statement(timestamptz,timestamptz)', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_org_statement(uuid,timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['edition_participation_payment_succeeded(uuid,text,text,integer,integer)', 'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)', 'edition_reconcile_apply(jsonb,timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
    end;
  end if;
end $do$;

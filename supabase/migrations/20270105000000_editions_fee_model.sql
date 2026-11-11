-- Editions fee model and financial safeguards (organiser-collected payments only: participation fees and card memberships). Approved 12 Nov 2026. NOT APPLIED ANYWHERE.
-- Rollback: supabase/rollbacks/20270105000000_editions_fee_model.rollback.sql
--
-- WHAT THIS CHANGES
--   1) OneShetland's commission is 2% of the charge. Stripe's processing cost is ESTIMATED and recovered INSIDE the application fee (F = commission + recovery_estimate), so the organiser bears it and
--      NOTHING is ever added to the customer's total. The option for the business to pay the fee ('fee_payer = business') is removed. The estimate rates are PLACEHOLDERS (1.5% + 20p), not Stripe's
--      confirmed rates: editions.commerce.stripe_cost_confirmed stays 'false' until Darren confirms them (the post-check reports it).
--   2) The ledger (edition_payments) records commission, recovery estimate, commission refunded, the application fee Stripe actually collected, the variance (estimate minus Stripe's actual fee) and dispute amounts.
--   3) Refunds: step 1 refunds the customer with reverse_transfer (refund_application_fee = false), step 2 refunds ONLY the commission share through the application-fee refund API (queued, idempotent).
--   4) Disputes: recorded on created, a lost dispute queues a transfer reversal; an insufficient connected balance blocks the recovery (no loop), raises an exception, and suspends that organiser's collection.
--   5) Reconciliation, statements and a variance report; additive VAT-readiness columns (nothing charges VAT: OneShetland is not VAT registered).
-- Package and promotion orders (flow A) are untouched. Nothing here runs unless the payment functions are deployed and editions.commerce.enabled is true.

-- ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────────

insert into public.admin_config (key, value, category) values
  ('editions.commerce.participation.fee_percent', '2', 'editions'), ('editions.commerce.membership.fee_percent', '2', 'editions'),
  ('editions.commerce.participation.stripe_cost_percent', '1.5', 'editions'), ('editions.commerce.membership.stripe_cost_percent', '1.5', 'editions'),
  ('editions.commerce.participation.stripe_cost_fixed_pence', '20', 'editions'), ('editions.commerce.membership.stripe_cost_fixed_pence', '20', 'editions'),
  ('editions.commerce.stripe_cost_confirmed', 'false', 'editions'),
  ('editions.commerce.variance_alert_pence', '20', 'editions'), ('editions.commerce.fee_tolerance_pence', '1', 'editions'),
  ('editions.commerce.refund_commission_on_dispute', 'false', 'editions'),
  ('platform.vat_registered', 'false', 'platform')
on conflict (key) do nothing;
-- the previous (implicit) default commission was 5%: a row still holding exactly that value is brought to the approved 2%; anything an administrator chose since is left alone
update public.admin_config set value = '2' where key in ('editions.commerce.participation.fee_percent', 'editions.commerce.membership.fee_percent') and value = '5';
-- fee_payer can only be 'organiser' now: a stored 'business' value is meaningless (ignored by the maths) and is removed
delete from public.admin_config where key = 'editions.commerce.fee_payer' and value <> 'organiser';

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
    -- the estimated card processing cost recovered inside the application fee: PLACEHOLDERS until Darren confirms Stripe's rates
    when p_key in ('editions.commerce.participation.stripe_cost_percent', 'editions.commerce.membership.stripe_cost_percent') then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 10
    when p_key in ('editions.commerce.participation.stripe_cost_fixed_pence', 'editions.commerce.membership.stripe_cost_fixed_pence') then p_value ~ '^[0-9]{1,3}$'
    when p_key = 'editions.commerce.stripe_cost_confirmed' then p_value in ('true', 'false')
    when p_key = 'editions.commerce.variance_alert_pence' then p_value ~ '^[0-9]{1,5}$'
    when p_key = 'editions.commerce.fee_tolerance_pence' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 50
    when p_key = 'editions.commerce.refund_commission_on_dispute' then p_value in ('true', 'false')
    when p_key = 'platform.vat_registered' then p_value in ('true', 'false')   -- nothing reads it for charging: OneShetland is not VAT registered
    when p_key = 'editions.commerce.fee_payer' then p_value = 'organiser'   -- the only payer: nothing is ever added to the customer's total
    when p_key = 'editions.commerce.grace_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    when p_key = 'editions.commerce.max_charge_pence' then p_value ~ '^[0-9]{3,7}$'
    when p_key = 'editions.commerce.refund_application_fee' then p_value in ('true', 'false')   -- now: return the COMMISSION share to the organiser on a refund (never the processing-cost estimate)
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
  insert into public.admin_config (key, value, category) values (p_key, p_value, case when p_key like 'platform.%' then 'platform' else 'editions' end) on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'commerce_config_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

-- ── overrides: a waiver applies to the COMMISSION only; recovery of processing cost is waived only by an explicit, audited flag ─────────────────────

alter table public.edition_commercial_overrides add column if not exists recovery_waived boolean not null default false;
drop function if exists public.admin_set_edition_fee_override(uuid, text, numeric, integer, boolean, text, timestamptz);
create or replace function public.admin_set_edition_fee_override(p_org uuid, p_kind text, p_percent numeric, p_fixed integer, p_waived boolean, p_reason text, p_until timestamptz default null, p_recovery_waived boolean default false) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  insert into public.edition_commercial_overrides (organiser_id, kind, fee_percent, fee_fixed_pence, waived, recovery_waived, reason, set_by, until)
  values (p_org, p_kind, p_percent, p_fixed, coalesce(p_waived, false), coalesce(p_recovery_waived, false), p_reason, auth.uid(), p_until) returning id into v_id;
  perform public.edition_audit(p_org, null, 'fee_override_set', jsonb_build_object('kind', p_kind, 'percent', p_percent, 'fixed', p_fixed, 'waived', p_waived, 'recovery_waived', coalesce(p_recovery_waived, false), 'until', p_until, 'reason', p_reason));
  return v_id;
end $$;

-- ── fee and charge maths (integer pence, round half up; the customer pays exactly the price) ──────────────────────────────────────────────────────

-- commission = round(C x pct / 100) + fixed, minimum, cap, never above C (waived override: 0).  recovery = round(C x stripe_cost_percent / 100) + stripe_cost_fixed_pence (explicit recovery_waived: 0).
-- F = commission + recovery; if F would exceed C the recovery is reduced first (recovery_reduced).
create or replace function public.edition_fee_parts(p_kind text, p_base_pence integer, p_org uuid)
returns table (out_commission integer, out_recovery integer, out_fee integer, out_reduced boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.edition_commercial_overrides; v_found boolean; v_pct numeric; v_fixed integer; v_min integer; v_cap integer; v_comm integer; v_rec integer; v_reduced boolean := false; k text := 'editions.commerce.' || p_kind;
begin
  if p_kind not in ('participation', 'membership') then raise exception 'unknown fee kind' using errcode = '22023'; end if;
  if p_base_pence is null or p_base_pence <= 0 then return query select 0, 0, 0, false; return; end if;
  select * into o from public.edition_commercial_overrides x where x.organiser_id = p_org and x.kind = p_kind and (x.until is null or x.until > now()) order by x.created_at desc limit 1;
  v_found := found;
  if v_found and o.waived then v_comm := 0;
  else
    v_pct := coalesce(case when v_found then o.fee_percent end, public.edition_commerce_cfg(k || '.fee_percent', '2')::numeric);
    v_fixed := coalesce(case when v_found then o.fee_fixed_pence end, public.edition_commerce_cfg(k || '.fee_fixed_pence', '0')::integer);
    v_min := public.edition_commerce_cfg(k || '.fee_min_pence', '0')::integer;
    v_cap := nullif(public.edition_commerce_cfg(k || '.fee_cap_pence', ''), '')::integer;
    v_comm := round(p_base_pence * v_pct / 100.0)::integer + v_fixed;
    v_comm := greatest(v_comm, v_min);
    if v_cap is not null then v_comm := least(v_comm, v_cap); end if;
    v_comm := least(v_comm, p_base_pence);
  end if;
  if v_found and o.recovery_waived then v_rec := 0;
  else v_rec := round(p_base_pence * public.edition_commerce_cfg(k || '.stripe_cost_percent', '1.5')::numeric / 100.0)::integer + public.edition_commerce_cfg(k || '.stripe_cost_fixed_pence', '20')::integer; end if;
  if v_comm + v_rec > p_base_pence then v_rec := p_base_pence - v_comm; v_reduced := true; end if;
  return query select v_comm, v_rec, v_comm + v_rec, v_reduced;
end $$;

-- the application fee F (commission + estimated processing cost recovery)
create or replace function public.edition_fee_calc(p_kind text, p_base_pence integer, p_org uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$ select out_fee from public.edition_fee_parts(p_kind, p_base_pence, p_org) $$;

-- The STANDARD published commission rates for the organiser-facing explainer (admin_config is admin-only, so organisers cannot read it). Read from the same config the fee maths uses; a per-organiser
-- override is NOT applied. Exposes only these five fields per kind: no other configuration, and not the processing-cost estimate rates.
create or replace function public.edition_commission_rates() returns table (kind text, percent numeric, fixed_pence integer, min_pence integer, cap_pence integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select k, public.edition_commerce_cfg('editions.commerce.' || k || '.fee_percent', '2')::numeric, public.edition_commerce_cfg('editions.commerce.' || k || '.fee_fixed_pence', '0')::integer,
         public.edition_commerce_cfg('editions.commerce.' || k || '.fee_min_pence', '0')::integer, nullif(public.edition_commerce_cfg('editions.commerce.' || k || '.fee_cap_pence', ''), '')::integer
    from (values ('participation'), ('membership')) v(k) where auth.uid() is not null
$$;

-- What a business is charged and what the organiser receives. The customer ALWAYS pays exactly the (VAT-inclusive for a VAT-registered organiser) price: the fee comes out of the organiser's proceeds.
-- VAT: only when the organiser is VAT registered; 'inclusive' keeps the price, 'exclusive' adds VAT on top (unchanged). Fees are computed on the price incl. VAT.
drop function if exists public.edition_charge_breakdown(text, integer, text, uuid);
create or replace function public.edition_charge_breakdown(p_kind text, p_price_pence integer, p_vat_mode text, p_org uuid)
returns table (price_pence integer, vat_pence integer, platform_fee_pence integer, charge_pence integer, net_to_organiser_pence integer, vat_mode text, fee_payer text, commission_pence integer, recovery_estimate_pence integer, recovery_reduced boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rate numeric := public.edition_commerce_cfg('editions.commerce.vat_rate_percent', '20')::numeric; v_reg boolean; v_mode text := coalesce(p_vat_mode, 'none');
        v_vat integer := 0; v_gross integer; f record;
begin
  if p_price_pence is null or p_price_pence < 0 then raise exception 'invalid price' using errcode = '22023'; end if;
  select coalesce(a.vat_registered, false) into v_reg from public.edition_payout_accounts a where a.organiser_id = p_org;
  if not coalesce(v_reg, false) then v_mode := 'none'; end if;
  if v_mode = 'inclusive' then v_vat := round(p_price_pence - p_price_pence / (1 + v_rate / 100))::integer; v_gross := p_price_pence;
  elsif v_mode = 'exclusive' then v_vat := round(p_price_pence * v_rate / 100)::integer; v_gross := p_price_pence + v_vat;
  else v_gross := p_price_pence; end if;
  select * into f from public.edition_fee_parts(p_kind, v_gross, p_org);
  return query select p_price_pence, v_vat, f.out_fee, v_gross, (v_gross - f.out_fee), v_mode, 'organiser'::text, f.out_commission, f.out_recovery, f.out_reduced;
end $$;

-- ── the ledger: new facts (commission, estimate, Stripe's actuals, variance, disputes) ────────────────────────────────────────────────────────────

alter table public.edition_payments
  add column if not exists commission_pence integer check (commission_pence is null or commission_pence >= 0),
  add column if not exists recovery_estimate_pence integer check (recovery_estimate_pence is null or recovery_estimate_pence >= 0),
  add column if not exists commission_refunded_pence integer not null default 0 check (commission_refunded_pence >= 0),
  add column if not exists application_fee_actual_pence integer check (application_fee_actual_pence is null or application_fee_actual_pence >= 0),
  add column if not exists recovery_variance_pence integer,
  add column if not exists stripe_fee_refunded_pence integer not null default 0 check (stripe_fee_refunded_pence = 0),   -- Stripe never returns its processing fee on a refund: always 0, kept for clarity
  add column if not exists dispute_state text check (dispute_state is null or dispute_state in ('open', 'won', 'lost', 'closed')),
  add column if not exists dispute_lost_pence integer not null default 0 check (dispute_lost_pence >= 0),
  add column if not exists dispute_recovered_pence integer not null default 0 check (dispute_recovered_pence >= 0);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_payments_commission_refund_cap') then
    alter table public.edition_payments add constraint edition_payments_commission_refund_cap check (commission_refunded_pence <= coalesce(commission_pence, platform_fee_pence));
  end if;
end $$;

-- The ledger stays append-only. The new fact columns may be filled once (commission and estimate from null) or advance (refund, dispute and actual-fee facts); nothing may be rewritten or reduced.
create or replace function public.edition_payments_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_mut text[] := array['status', 'refunded_pence', 'stripe_fee_pence', 'stripe_charge_id', 'commission_refunded_pence', 'application_fee_actual_pence', 'recovery_variance_pence', 'dispute_state', 'dispute_lost_pence', 'dispute_recovered_pence'];
begin
  if tg_op = 'DELETE' then raise exception 'payments cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - v_mut - 'commission_pence' - 'recovery_estimate_pence') is distinct from (to_jsonb(old) - v_mut - 'commission_pence' - 'recovery_estimate_pence') then
    raise exception 'payments are append-only (only status, refunds and Stripe fee detail may change)' using errcode = '42501';
  end if;
  if (old.commission_pence is not null and new.commission_pence is distinct from old.commission_pence) or (old.recovery_estimate_pence is not null and new.recovery_estimate_pence is distinct from old.recovery_estimate_pence) then
    raise exception 'payments are append-only (the commission and the processing-fee estimate are fixed once recorded)' using errcode = '42501';
  end if;
  if new.refunded_pence < old.refunded_pence then raise exception 'a refund cannot be reduced' using errcode = '23514'; end if;
  if new.commission_refunded_pence < old.commission_refunded_pence or new.dispute_lost_pence < old.dispute_lost_pence or new.dispute_recovered_pence < old.dispute_recovered_pence then raise exception 'a refund or dispute amount cannot be reduced' using errcode = '23514'; end if;
  return new;
end $$;

-- offline and complimentary rows carry no fee: record that explicitly (card rows get their parts from the payment functions below)
create or replace function public.edition_payments_parts_default() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.commission_pence is null and new.source <> 'stripe' then new.commission_pence := 0; new.recovery_estimate_pence := 0; end if;
  return new;
end $$;
drop trigger if exists edition_payments_parts_default on public.edition_payments;
create trigger edition_payments_parts_default before insert on public.edition_payments for each row execute function public.edition_payments_parts_default();

-- BACKFILL (safe, non-destructive): rows recorded before this model had a single fee, which was all commission. Derived from platform_fee_pence; nothing is overwritten.
update public.edition_payments set commission_pence = platform_fee_pence, recovery_estimate_pence = 0 where commission_pence is null;

-- ── reconciliation kinds ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.edition_reconciliation_exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if c is not null then execute format('alter table public.edition_reconciliation_exceptions drop constraint %I', c); end if;
  alter table public.edition_reconciliation_exceptions add constraint edition_recon_kind_check check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch',
    'destination_mismatch', 'dispute', 'amount_refused', 'duplicate_payment', 'payment_after_cancel', 'duplicate_subscription', 'refund_failed',
    'fee_variance', 'commission_refund_mismatch', 'transfer_mismatch', 'dispute_recovery_failed', 'commission_refund_failed'));
end $$;

-- ── actual-fee facts (internal helpers) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

-- Stripe's actual processing fee for a payment: recorded, the variance (estimate minus actual) computed, and a fee_variance exception raised when it is beyond the alert threshold. No true-up, no refund of variance.
create or replace function public.edition_payment_note_stripe_fee(p_payment uuid, p_fee integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype; v_var integer; v_alert integer := public.edition_commerce_cfg('editions.commerce.variance_alert_pence', '20')::integer;
begin
  if p_fee is null or p_fee < 0 then return; end if;
  select * into p from public.edition_payments where id = p_payment for update;
  if not found or p.source <> 'stripe' then return; end if;
  v_var := case when p.recovery_estimate_pence is not null then p.recovery_estimate_pence - p_fee end;
  update public.edition_payments set stripe_fee_pence = p_fee, recovery_variance_pence = v_var where id = p.id;
  if v_var is not null and abs(v_var) > v_alert then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail)
    values (p.organiser_id, 'fee_variance', coalesce(p.stripe_invoice_id, p.stripe_payment_intent_id, p.id::text), p.id,
      jsonb_build_object('estimate', p.recovery_estimate_pence, 'actual_stripe_fee', p_fee, 'variance', v_var, 'threshold', v_alert, 'note', 'estimate minus actual; no automatic true-up'))
    on conflict do nothing;
  end if;
end $$;

-- the application fee Stripe actually collected, compared with the expected F within a tolerance
create or replace function public.edition_payment_note_app_fee(p_payment uuid, p_actual integer, p_expected integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype; v_tol integer := public.edition_commerce_cfg('editions.commerce.fee_tolerance_pence', '1')::integer;
begin
  if p_actual is null or p_actual < 0 then return; end if;
  select * into p from public.edition_payments where id = p_payment for update;
  if not found then return; end if;
  update public.edition_payments set application_fee_actual_pence = p_actual where id = p.id;
  if abs(p_actual - coalesce(p_expected, p.platform_fee_pence)) > v_tol then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail)
    values (p.organiser_id, 'fee_mismatch', coalesce(p.stripe_invoice_id, p.stripe_payment_intent_id, p.id::text), p.id,
      jsonb_build_object('provider', p_actual, 'computed', coalesce(p_expected, p.platform_fee_pence), 'tolerance', v_tol)) on conflict do nothing;
  end if;
end $$;

-- ── paying: participation (one-off PaymentIntent) ───────────────────────────────────────────────────────────────────────────────────────────────

drop function if exists public.edition_participation_payment_succeeded(uuid, text, text, integer, integer);
create or replace function public.edition_participation_payment_succeeded(p_link uuid, p_payment_intent text, p_charge text, p_charge_pence integer, p_stripe_fee integer default null, p_application_fee integer default null) returns text
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
  update public.edition_payments set commission_pence = q.commission_pence, recovery_estimate_pence = q.recovery_estimate_pence where id = v_pay;
  if p_application_fee is not null then perform public.edition_payment_note_app_fee(v_pay, p_application_fee, q.platform_fee_pence); end if;
  if p_stripe_fee is not null then perform public.edition_payment_note_stripe_fee(v_pay, p_stripe_fee); end if;
  update public.edition_participations set status = 'paid', payment_id = v_pay, updated_at = now() where id = p.id;
  perform public.edition_audit(e.organiser_id, p.edition_id, 'participation_paid', jsonb_build_object('link', p_link, 'charge', p_charge_pence));
  return 'recorded';
end $$;

-- ── paying: membership invoices (Stripe Subscriptions: first invoice and every renewal) ────────────────────────────────────────────────────────────

-- The recorded per-invoice fee is the ACTUAL application_fee_amount Stripe collected (a percentage of a constant invoice amount, so it can differ from the expected F by a penny). The parts always sum to the
-- recorded fee: commission stays the contractual figure, and the rounding residue sits in the recovery estimate. A difference beyond editions.commerce.fee_tolerance_pence raises fee_mismatch.
create or replace function public.edition_membership_payment_succeeded(p_membership uuid, p_subscription text, p_payment_intent text, p_invoice text, p_charge text,
  p_period_start timestamptz, p_period_end timestamptz, p_charge_pence integer, p_stripe_fee integer default null, p_platform_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; b record; v_dup uuid; v_pay uuid; v_dead boolean := false; v_fee integer; v_comm integer;
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
  v_fee := coalesce(p_platform_fee, b.platform_fee_pence);
  v_comm := least(b.commission_pence, v_fee);
  -- A SECOND provider subscription paid for a membership that already has one (for example a card retry that created a new subscription). The money is recorded so nothing is lost, the
  -- membership keeps its FIRST subscription, an exception is raised for the administrator (refund), and the extra subscription is queued to be cancelled so it never bills again.
  if m.stripe_subscription_id is not null and p_subscription is not null and p_subscription <> m.stripe_subscription_id then
    v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, 'stripe', 'succeeded', b.price_pence, b.vat_pence, b.vat_mode, v_fee, b.charge_pence,
      b.charge_pence - v_fee, p_payment_intent, p_invoice, p_charge, p_period_start, p_period_end, null, null, m.owner_user_id, null, null);
    update public.edition_payments set commission_pence = v_comm, recovery_estimate_pence = v_fee - v_comm where id = v_pay;
    if p_platform_fee is not null then perform public.edition_payment_note_app_fee(v_pay, p_platform_fee, b.platform_fee_pence); end if;
    if p_stripe_fee is not null then perform public.edition_payment_note_stripe_fee(v_pay, p_stripe_fee); end if;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (m.organiser_id, 'duplicate_subscription', coalesce(p_invoice, p_payment_intent), v_pay,
      jsonb_build_object('membership', m.id, 'kept', m.stripe_subscription_id, 'extra', p_subscription, 'charge', p_charge_pence)) on conflict do nothing;
    insert into public.edition_stripe_stray_subscriptions (subscription_id, membership_id) values (p_subscription, m.id) on conflict (subscription_id) do update set status = 'pending', updated_at = now();
    perform public.edition_mem_event(m.id, 'duplicate_subscription', jsonb_build_object('extra', p_subscription));
    return 'recorded_duplicate_subscription';
  end if;
  v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, 'stripe', 'succeeded', b.price_pence, b.vat_pence, b.vat_mode, v_fee, b.charge_pence,
    b.charge_pence - v_fee, p_payment_intent, p_invoice, p_charge, p_period_start, p_period_end, null, null, m.owner_user_id, null, null);
  update public.edition_payments set commission_pence = v_comm, recovery_estimate_pence = v_fee - v_comm where id = v_pay;
  if p_platform_fee is not null then perform public.edition_payment_note_app_fee(v_pay, p_platform_fee, b.platform_fee_pence); end if;
  if p_stripe_fee is not null then perform public.edition_payment_note_stripe_fee(v_pay, p_stripe_fee); end if;
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

-- ── refunds: step 2 (the commission share) ───────────────────────────────────────────────────────────────────────────────────────────────────────

alter table public.edition_refund_requests
  add column if not exists refunded_before_pence integer,
  add column if not exists commission_refund_pence integer not null default 0 check (commission_refund_pence >= 0),
  add column if not exists commission_refund_status text not null default 'none' check (commission_refund_status in ('none', 'pending', 'done', 'failed')),
  add column if not exists commission_attempts integer not null default 0,
  add column if not exists commission_last_error text,
  add column if not exists commission_next_attempt_at timestamptz not null default now();

-- The ledger total BEFORE a refund request is captured when the request is created (the single-request-in-flight rule means nothing else can move it in between), so the commission plan below never
-- depends on webhook timing.
create or replace function public.edition_refund_request_before() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.payment_id is not null and new.refunded_before_pence is null then new.refunded_before_pence := (select p.refunded_pence from public.edition_payments p where p.id = new.payment_id); end if;
  return new;
end $$;
drop trigger if exists edition_refund_request_before on public.edition_refund_requests;
create trigger edition_refund_request_before before insert on public.edition_refund_requests for each row execute function public.edition_refund_request_before();
update public.edition_refund_requests r set refunded_before_pence = greatest(0, (select p.refunded_pence from public.edition_payments p where p.id = r.payment_id) - case when r.status = 'done' then r.amount_pence else 0 end) where r.payment_id is not null and r.refunded_before_pence is null;

-- Once the provider has accepted the customer refund (request 'submitted', or confirmed 'done' by the webhook) the commission share still owed is PLANNED, once:
--   delta = round(commission x R_cumulative / C) minus what has been returned and minus what other requests of the same payment have already planned; R_cumulative = refunded_before + this refund.
-- A full refund returns the whole commission. editions.commerce.refund_application_fee = 'false' returns no commission. Called by the cron before it drains the step-2 queue; idempotent.
create or replace function public.edition_commission_plan_pending() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_refund_requests%rowtype; p public.edition_payments%rowtype; v_cum integer; v_comm integer; v_target integer; v_pending integer; v_delta integer; n integer := 0;
begin
  for r in select * from public.edition_refund_requests x where x.payment_id is not null and x.commission_refund_status = 'none' and x.status in ('submitted', 'done') order by x.created_at for update loop
    select * into p from public.edition_payments where id = r.payment_id for update;
    if not found then continue; end if;
    v_cum := least(p.charge_pence, coalesce(r.refunded_before_pence, 0) + r.amount_pence);
    v_comm := coalesce(p.commission_pence, p.platform_fee_pence);
    v_target := case when public.edition_commerce_cfg('editions.commerce.refund_application_fee', 'true') <> 'true' then 0
                     when v_cum >= p.charge_pence then v_comm else least(v_comm, round(v_comm::numeric * v_cum / p.charge_pence)::integer) end;
    select coalesce(sum(x.commission_refund_pence), 0) into v_pending from public.edition_refund_requests x where x.payment_id = p.id and x.id <> r.id and x.commission_refund_status = 'pending';
    v_delta := greatest(v_target - p.commission_refunded_pence - v_pending, 0);
    update public.edition_refund_requests set commission_refund_pence = v_delta, commission_refund_status = case when v_delta > 0 then 'pending' else 'done' end where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- the worker's step-2 queue: commission shares still to be returned (the customer refund was accepted)
create or replace function public.edition_commission_refunds_next() returns table (request_id uuid, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.payment_id, r.commission_refund_pence, p.stripe_payment_intent_id, p.stripe_charge_id
    from public.edition_refund_requests r join public.edition_payments p on p.id = r.payment_id
   where r.commission_refund_status = 'pending' and r.status in ('submitted', 'done') and r.commission_next_attempt_at <= now() order by r.created_at limit 20
$$;
-- p_status: 'done' (the application fee refund succeeded: the ledger advances ONCE), 'retry' (temporary, back-off, six tries), 'failed' (final: an exception for the administrator)
create or replace function public.edition_commission_refund_mark(p_request uuid, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_refund_requests%rowtype; v_pi text;
begin
  select * into r from public.edition_refund_requests where id = p_request for update;
  if not found or r.commission_refund_status <> 'pending' or p_status not in ('done', 'retry', 'failed') then return; end if;
  if p_status = 'retry' and r.commission_attempts + 1 >= 6 then p_status := 'failed'; end if;
  if p_status = 'retry' then
    update public.edition_refund_requests set commission_attempts = commission_attempts + 1, commission_last_error = left(p_error, 300), commission_next_attempt_at = now() + make_interval(mins => (commission_attempts + 1) * (commission_attempts + 1) * 2) where id = r.id;
  elsif p_status = 'done' then
    update public.edition_payments set commission_refunded_pence = least(commission_refunded_pence + r.commission_refund_pence, coalesce(commission_pence, platform_fee_pence)) where id = r.payment_id;
    update public.edition_refund_requests set commission_refund_status = 'done', commission_last_error = null where id = r.id;
    perform public.edition_audit(r.organiser_id, null, 'commission_refunded', jsonb_build_object('request', r.id, 'amount', r.commission_refund_pence));
  else
    update public.edition_refund_requests set commission_refund_status = 'failed', commission_last_error = left(p_error, 300) where id = r.id;
    select stripe_payment_intent_id into v_pi from public.edition_payments where id = r.payment_id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (r.organiser_id, 'commission_refund_failed', coalesce(v_pi, r.payment_id::text) || '#' || left(r.id::text, 8), r.payment_id,
      jsonb_build_object('request', r.id, 'amount', r.commission_refund_pence, 'error', left(p_error, 300))) on conflict do nothing;
  end if;
end $$;

-- ── disputes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.edition_dispute_recoveries (
  id                       uuid primary key default gen_random_uuid(),
  dispute_id               text not null unique check (dispute_id ~ '^(dp|du)_[A-Za-z0-9]+$'),
  payment_id               uuid not null references public.edition_payments (id) on delete restrict,
  organiser_id             uuid not null references public.edition_organisers (id) on delete restrict,
  payment_intent           text,
  amount_pence             integer not null check (amount_pence >= 0),
  fee_pence                integer check (fee_pence is null or fee_pence >= 0),     -- Stripe's dispute fee: recorded and reported, NOT passed to the organiser automatically
  reason                   text,
  state                    text not null default 'open' check (state in ('open', 'won', 'lost', 'closed')),
  recovery_pence           integer not null default 0 check (recovery_pence >= 0),
  status                   text not null default 'none' check (status in ('none', 'pending', 'done', 'failed')),
  blocked                  boolean not null default false,                          -- insufficient connected balance: never retried automatically, an administrator re-queues it
  attempts                 integer not null default 0,
  last_error               text,
  next_attempt_at          timestamptz not null default now(),
  stripe_reversal_id       text,
  commission_refund_pence  integer not null default 0 check (commission_refund_pence >= 0),
  commission_refund_status text not null default 'none' check (commission_refund_status in ('none', 'pending', 'done', 'failed')),
  commission_attempts      integer not null default 0,
  commission_last_error    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  resolved_at              timestamptz
);
create index if not exists edition_dispute_recoveries_queue_idx on public.edition_dispute_recoveries (status, next_attempt_at) where status = 'pending';
create index if not exists edition_dispute_recoveries_payment_idx on public.edition_dispute_recoveries (payment_id);

-- One Stripe dispute = one row (unique on the dispute id), so a repeated or out-of-order event changes nothing. 'created' records and flags; 'closed' with status lost queues the recovery; won / otherwise closed releases the payment.
create or replace function public.edition_dispute_event(p_payment_intent text, p_dispute text, p_event text, p_status text, p_amount integer, p_fee integer, p_reason text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.edition_payments%rowtype; d public.edition_dispute_recoveries%rowtype; v_amt integer; v_rev integer; v_recover integer; v_comm integer; v_cref integer; v_closed boolean;
begin
  select * into p from public.edition_payments where stripe_payment_intent_id = p_payment_intent order by created_at desc limit 1 for update;
  if not found then
    insert into public.edition_reconciliation_exceptions (kind, provider_ref, detail) values ('dispute', p_payment_intent, jsonb_build_object('reason', p_reason, 'dispute', p_dispute)) on conflict do nothing;
    return 'unknown_payment';
  end if;
  v_amt := least(greatest(coalesce(p_amount, 0), 0), p.charge_pence);
  insert into public.edition_dispute_recoveries (dispute_id, payment_id, organiser_id, payment_intent, amount_pence, fee_pence, reason) values (p_dispute, p.id, p.organiser_id, p_payment_intent, v_amt, p_fee, left(p_reason, 100)) on conflict (dispute_id) do nothing;
  select * into d from public.edition_dispute_recoveries where dispute_id = p_dispute for update;
  if d.state <> 'open' then return 'already_closed'; end if;     -- a duplicate, or an out-of-order event after the outcome: nothing changes
  v_closed := p_event = 'closed' or p_status in ('won', 'lost');
  if not v_closed then
    update public.edition_dispute_recoveries set amount_pence = case when v_amt > 0 then v_amt else amount_pence end, fee_pence = coalesce(p_fee, fee_pence), updated_at = now() where id = d.id;
    update public.edition_payments set status = case when status in ('succeeded', 'partially_refunded') then 'disputed' else status end, dispute_state = 'open' where id = p.id and (status in ('succeeded', 'partially_refunded', 'disputed'));
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'dispute', p_payment_intent, p.id, jsonb_build_object('reason', p_reason, 'dispute', p_dispute, 'amount', d.amount_pence)) on conflict do nothing;
    perform public.edition_audit(p.organiser_id, null, 'payment_disputed', jsonb_build_object('payment', p.id, 'dispute', p_dispute));
    return 'recorded';
  end if;
  if p_status = 'lost' then
    -- the transfer can be reversed only up to what is still unreversed: the charge less refunds (each reversed its share) and less earlier recoveries (done or already queued)
    v_rev := greatest(p.charge_pence - p.refunded_pence - p.dispute_recovered_pence - coalesce((select sum(x.recovery_pence) from public.edition_dispute_recoveries x where x.payment_id = p.id and x.dispute_id <> p_dispute and x.status = 'pending'), 0), 0);
    v_recover := least(d.amount_pence, v_rev);
    v_comm := coalesce(p.commission_pence, p.platform_fee_pence);
    -- ASSUMPTION awaiting Darren: OneShetland keeps its commission and the recovery estimate on a lost dispute (editions.commerce.refund_commission_on_dispute = false)
    v_cref := case when public.edition_commerce_cfg('editions.commerce.refund_commission_on_dispute', 'false') = 'true' and p.charge_pence > 0
                   then greatest(least(round(v_comm::numeric * d.amount_pence / p.charge_pence)::integer, v_comm - p.commission_refunded_pence), 0) else 0 end;
    update public.edition_dispute_recoveries set state = 'lost', recovery_pence = v_recover, status = case when v_recover > 0 then 'pending' else 'none' end, next_attempt_at = now(), fee_pence = coalesce(p_fee, fee_pence),
      commission_refund_pence = v_cref, commission_refund_status = case when v_cref > 0 then 'pending' else 'none' end, updated_at = now() where id = d.id;
    update public.edition_payments set status = case when status in ('succeeded', 'partially_refunded') then 'disputed' else status end, dispute_state = 'lost', dispute_lost_pence = least(p.charge_pence, p.dispute_lost_pence + d.amount_pence) where id = p.id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'dispute', p_payment_intent, p.id, jsonb_build_object('reason', p_reason, 'dispute', p_dispute, 'outcome', 'lost', 'recover', v_recover)) on conflict do nothing;
    perform public.edition_audit(p.organiser_id, null, 'dispute_lost', jsonb_build_object('payment', p.id, 'dispute', p_dispute, 'amount', d.amount_pence, 'recovery', v_recover));
    return 'lost';
  end if;
  -- won (or closed some other way, e.g. the charge was refunded): nothing to recover; release the payment unless another dispute on it is still live
  update public.edition_dispute_recoveries set state = case when p_status = 'won' then 'won' else 'closed' end, status = 'none', fee_pence = coalesce(p_fee, fee_pence), updated_at = now(), resolved_at = now() where id = d.id;
  update public.edition_payments set dispute_state = case when p_status = 'won' then 'won' else 'closed' end,
    status = case when status = 'disputed' and not exists (select 1 from public.edition_dispute_recoveries x where x.payment_id = p.id and x.dispute_id <> p_dispute and x.state in ('open', 'lost'))
                  then case when refunded_pence >= charge_pence then 'refunded' when refunded_pence > 0 then 'partially_refunded' else 'succeeded' end else status end where id = p.id;
  perform public.edition_audit(p.organiser_id, null, 'dispute_closed', jsonb_build_object('payment', p.id, 'dispute', p_dispute, 'status', p_status));
  return case when p_status = 'won' then 'won' else 'closed' end;
end $$;

-- the worker's queue of lost disputes still to recover: transfer reversals the platform has not yet made (a blocked one waits for an administrator)
create or replace function public.edition_dispute_recoveries_next() returns table (dispute_id text, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.dispute_id, d.payment_id, d.recovery_pence, p.stripe_payment_intent_id, p.stripe_charge_id
    from public.edition_dispute_recoveries d join public.edition_payments p on p.id = d.payment_id
   where d.status = 'pending' and not d.blocked and d.next_attempt_at <= now() order by d.created_at limit 20
$$;
-- p_status: 'done' (the transfer reversal succeeded), 'retry' (temporary, back-off, six tries), 'insufficient' (the connected account balance could not cover it: NEVER looped; recorded, an exception for the
-- administrator, the organiser's collection suspended, the request stays pending for a manual retry), 'failed' (a final refusal: an exception).
create or replace function public.edition_dispute_recovery_mark(p_dispute text, p_status text, p_error text default null, p_reversal text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.edition_dispute_recoveries%rowtype; v_reason text;
begin
  select * into d from public.edition_dispute_recoveries where dispute_id = p_dispute for update;
  if not found or d.status <> 'pending' or p_status not in ('done', 'retry', 'insufficient', 'failed') then return; end if;
  if p_status = 'retry' and d.attempts + 1 >= 6 then p_status := 'failed'; end if;
  if p_status = 'done' then
    update public.edition_dispute_recoveries set status = 'done', stripe_reversal_id = p_reversal, last_error = null, blocked = false, attempts = attempts + 1, resolved_at = now(), updated_at = now() where id = d.id;
    update public.edition_payments set dispute_recovered_pence = least(charge_pence, dispute_recovered_pence + d.recovery_pence) where id = d.payment_id;
    perform public.edition_audit(d.organiser_id, null, 'dispute_recovered', jsonb_build_object('dispute', d.dispute_id, 'amount', d.recovery_pence));
  elsif p_status = 'retry' then
    update public.edition_dispute_recoveries set attempts = attempts + 1, last_error = left(p_error, 300), next_attempt_at = now() + make_interval(mins => (attempts + 1) * (attempts + 1) * 2), updated_at = now() where id = d.id;
  elsif p_status = 'insufficient' then
    update public.edition_dispute_recoveries set attempts = attempts + 1, last_error = left(p_error, 300), blocked = true, updated_at = now() where id = d.id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (d.organiser_id, 'dispute_recovery_failed', d.dispute_id, d.payment_id,
      jsonb_build_object('dispute', d.dispute_id, 'amount', d.recovery_pence, 'error', left(p_error, 300), 'insufficient_balance', true, 'action', 'collection suspended; retry the recovery manually once the organiser balance is covered')) on conflict do nothing;
    v_reason := 'Dispute recovery could not be collected (insufficient balance): ' || d.dispute_id;
    insert into public.edition_payout_accounts (organiser_id, collection_suspended, suspended_reason) values (d.organiser_id, true, v_reason)
    on conflict (organiser_id) do update set collection_suspended = true, suspended_reason = excluded.suspended_reason, updated_at = now();
    perform public.edition_audit(d.organiser_id, null, 'collection_suspended', jsonb_build_object('reason', v_reason, 'dispute', d.dispute_id));
    perform public.edition_audit(d.organiser_id, null, 'dispute_recovery_blocked', jsonb_build_object('dispute', d.dispute_id, 'amount', d.recovery_pence));
  else
    update public.edition_dispute_recoveries set status = 'failed', attempts = attempts + 1, last_error = left(p_error, 300), resolved_at = now(), updated_at = now() where id = d.id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (d.organiser_id, 'dispute_recovery_failed', d.dispute_id, d.payment_id,
      jsonb_build_object('dispute', d.dispute_id, 'amount', d.recovery_pence, 'error', left(p_error, 300))) on conflict do nothing;
  end if;
end $$;

-- optional (config-gated, default off): return the commission share of a LOST dispute. Queue and mark, exactly like the refund step 2.
create or replace function public.edition_dispute_commission_next() returns table (dispute_id text, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.dispute_id, d.payment_id, d.commission_refund_pence, p.stripe_payment_intent_id, p.stripe_charge_id
    from public.edition_dispute_recoveries d join public.edition_payments p on p.id = d.payment_id
   where d.commission_refund_status = 'pending' and d.status in ('done', 'none') and d.state = 'lost' order by d.created_at limit 20
$$;
create or replace function public.edition_dispute_commission_mark(p_dispute text, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.edition_dispute_recoveries%rowtype;
begin
  select * into d from public.edition_dispute_recoveries where dispute_id = p_dispute for update;
  if not found or d.commission_refund_status <> 'pending' or p_status not in ('done', 'retry', 'failed') then return; end if;
  if p_status = 'retry' and d.commission_attempts + 1 >= 6 then p_status := 'failed'; end if;
  if p_status = 'retry' then update public.edition_dispute_recoveries set commission_attempts = commission_attempts + 1, commission_last_error = left(p_error, 300) where id = d.id;
  elsif p_status = 'done' then
    update public.edition_payments set commission_refunded_pence = least(commission_refunded_pence + d.commission_refund_pence, coalesce(commission_pence, platform_fee_pence)) where id = d.payment_id;
    update public.edition_dispute_recoveries set commission_refund_status = 'done', commission_last_error = null where id = d.id;
  else
    update public.edition_dispute_recoveries set commission_refund_status = 'failed', commission_last_error = left(p_error, 300) where id = d.id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (d.organiser_id, 'commission_refund_failed', d.dispute_id, d.payment_id, jsonb_build_object('dispute', d.dispute_id, 'error', left(p_error, 300))) on conflict do nothing;
  end if;
end $$;

-- an administrator re-queues a blocked or failed recovery once the cause is fixed (audited; it does NOT lift the collection suspension: that is admin_set_edition_collection)
create or replace function public.admin_retry_edition_dispute_recovery(p_dispute text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.edition_dispute_recoveries%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'a note is required' using errcode = '23514'; end if;
  select * into d from public.edition_dispute_recoveries where dispute_id = p_dispute for update;
  if not found or d.state <> 'lost' or d.recovery_pence <= 0 or not ((d.status = 'pending' and d.blocked) or d.status = 'failed') then raise exception 'there is no blocked or failed recovery with that id' using errcode = 'P0002'; end if;
  update public.edition_dispute_recoveries set status = 'pending', blocked = false, attempts = 0, next_attempt_at = now(), resolved_at = null, updated_at = now() where id = d.id;
  perform public.edition_audit(d.organiser_id, null, 'dispute_recovery_retried', jsonb_build_object('dispute', d.dispute_id, 'note', btrim(p_note)));
end $$;

-- ── reconciliation: expected F, actual application fee, refund totals, commission refunded, transfer and reversal totals ─────────────────────────────

-- p_snapshot items (all optional beyond payment_intent/amount): { payment_intent, amount, application_fee, refunded, destination, status, marked, stripe_fee, application_fee_refunded, transfer_amount, transfer_reversed }
create or replace function public.edition_reconcile_apply(p_snapshot jsonb, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; p public.edition_payments%rowtype; a text; v_n int := 0; v_seen text[] := '{}'; v_pi text; v_tol integer := public.edition_commerce_cfg('editions.commerce.fee_tolerance_pence', '1')::integer; v_busy boolean;
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
    if s ? 'application_fee' then
      if abs((s ->> 'application_fee')::int - p.platform_fee_pence) > v_tol then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'fee_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'application_fee', 'ledger', p.platform_fee_pence, 'tolerance', v_tol)) on conflict do nothing; v_n := v_n + 1; end if;
      if p.application_fee_actual_pence is null then update public.edition_payments set application_fee_actual_pence = (s ->> 'application_fee')::int where id = p.id; end if;
    end if;
    -- Stripe's actual processing fee arrives here if the webhook could not read it: the variance (estimate minus actual) is computed and a large one raised
    if s ? 'stripe_fee' and s ->> 'stripe_fee' is not null and p.stripe_fee_pence is null then perform public.edition_payment_note_stripe_fee(p.id, (s ->> 'stripe_fee')::int); end if;
    if s ? 'refunded' and (s ->> 'refunded')::int is distinct from p.refunded_pence then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'refund_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'refunded', 'ledger', p.refunded_pence)) on conflict do nothing; v_n := v_n + 1; end if;
    -- anything still in flight (a refund or a recovery that has not completed) would show a transient difference: compare the money-back figures only when nothing is pending for this payment
    v_busy := exists (select 1 from public.edition_refund_requests r where r.payment_id = p.id and (r.status in ('pending', 'submitted') or r.commission_refund_status = 'pending'))
           or exists (select 1 from public.edition_dispute_recoveries d where d.payment_id = p.id and (d.status = 'pending' or d.commission_refund_status = 'pending' or d.state = 'open'));
    if not v_busy then
      if s ? 'application_fee_refunded' and (s ->> 'application_fee_refunded')::int is distinct from p.commission_refunded_pence then
        insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'commission_refund_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'application_fee_refunded', 'ledger', p.commission_refunded_pence)) on conflict do nothing; v_n := v_n + 1;
      end if;
      if s ? 'transfer_amount' and abs((s ->> 'transfer_amount')::int - p.charge_pence) > v_tol then
        insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'transfer_mismatch', v_pi, p.id, jsonb_build_object('what', 'transfer', 'provider', s ->> 'transfer_amount', 'expected', p.charge_pence)) on conflict do nothing; v_n := v_n + 1;
      end if;
      if s ? 'transfer_reversed' and (s ->> 'transfer_reversed')::int is distinct from p.refunded_pence + p.dispute_recovered_pence then
        insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'transfer_mismatch', v_pi, p.id, jsonb_build_object('what', 'reversed', 'provider', s ->> 'transfer_reversed', 'expected', p.refunded_pence + p.dispute_recovered_pence)) on conflict do nothing; v_n := v_n + 1;
      end if;
    end if;
    a := public.edition_payout_account_for(p.organiser_id);
    if s ? 'destination' and (s ->> 'destination') is distinct from a then insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'destination_mismatch', v_pi, p.id, jsonb_build_object('provider', s ->> 'destination')) on conflict do nothing; v_n := v_n + 1; end if;
  end loop;
  for p in select * from public.edition_payments x where x.source = 'stripe' and x.status in ('succeeded', 'partially_refunded', 'refunded', 'disputed') and x.created_at between p_from and p_to and x.stripe_payment_intent_id is not null and not (x.stripe_payment_intent_id = any (v_seen)) loop
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (p.organiser_id, 'missing_at_provider', p.stripe_payment_intent_id, p.id, jsonb_build_object('charge', p.charge_pence)) on conflict do nothing; v_n := v_n + 1;
  end loop;
  return jsonb_build_object('checked', jsonb_array_length(p_snapshot), 'exceptions_raised', v_n);
end $$;

-- ── statements and reports ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

-- Platform view for the administrator, per organiser and period. Organiser net = what the organiser keeps after the commission, the estimated processing fee, refunds (less the commission returned) and dispute recoveries.
-- Retained processing costs = the estimated processing cost on REFUNDED money that is not returned (Stripe returns none of its fee). commission_vat_pence is always 0: OneShetland is not VAT registered.
drop function if exists public.admin_edition_fee_statement(timestamptz, timestamptz);
create or replace function public.admin_edition_fee_statement(p_from timestamptz, p_to timestamptz)
returns table (organiser_id uuid, organiser_name text, payments integer, gross_pence bigint, platform_fee_pence bigint, refunded_pence bigint,
               commission_pence bigint, commission_refunded_pence bigint, commission_earned_pence bigint, processing_fee_estimate_pence bigint, stripe_fee_actual_pence bigint, variance_pence bigint,
               dispute_lost_pence bigint, dispute_recovered_pence bigint, dispute_fees_pence bigint, organiser_net_pence bigint, retained_processing_costs_pence bigint, commission_vat_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select o.id, o.name, count(*)::int, sum(p.charge_pence)::bigint, sum(p.platform_fee_pence)::bigint, sum(p.refunded_pence)::bigint,
      sum(coalesce(p.commission_pence, p.platform_fee_pence))::bigint, sum(p.commission_refunded_pence)::bigint, sum(coalesce(p.commission_pence, p.platform_fee_pence) - p.commission_refunded_pence)::bigint,
      sum(coalesce(p.recovery_estimate_pence, 0))::bigint, sum(p.stripe_fee_pence) filter (where p.stripe_fee_pence is not null)::bigint, sum(p.recovery_variance_pence)::bigint,
      sum(p.dispute_lost_pence)::bigint, sum(p.dispute_recovered_pence)::bigint,
      coalesce((select sum(d.fee_pence) from public.edition_dispute_recoveries d where d.organiser_id = o.id and d.created_at >= p_from and d.created_at < p_to), 0)::bigint,
      sum(p.charge_pence - p.platform_fee_pence - p.refunded_pence + p.commission_refunded_pence - p.dispute_recovered_pence)::bigint,
      sum(round(coalesce(p.recovery_estimate_pence, 0)::numeric * p.refunded_pence / nullif(p.charge_pence, 0)))::bigint, 0::bigint
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id
   where p.source = 'stripe' and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by o.id, o.name order by 5 desc;
end $$;

-- Variance (estimated processing fee minus Stripe's actual fee) by month or by organiser, with how many payments exceeded the alert threshold. No true-up; the treatment of material variance is a pending commercial decision.
-- NOTE for the report reader: Stripe Connect account and payout overheads are absorbed by OneShetland and are NOT in these figures (tracked separately; no per-payment recovery).
create or replace function public.admin_edition_variance_report(p_from timestamptz, p_to timestamptz, p_group text default 'month')
returns table (group_key text, group_label text, payments integer, estimate_pence bigint, actual_pence bigint, variance_pence bigint, over_threshold integer, over_threshold_variance_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_alert integer := public.edition_commerce_cfg('editions.commerce.variance_alert_pence', '20')::integer;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_group not in ('month', 'organiser') then raise exception 'group by month or organiser' using errcode = '22023'; end if;
  return query select case when p_group = 'month' then to_char(date_trunc('month', p.created_at at time zone 'Europe/London'), 'YYYY-MM') else o.id::text end,
      case when p_group = 'month' then to_char(date_trunc('month', p.created_at at time zone 'Europe/London'), 'YYYY-MM') else o.name end,
      count(*)::int, sum(p.recovery_estimate_pence)::bigint, sum(p.stripe_fee_pence)::bigint, sum(p.recovery_variance_pence)::bigint,
      (count(*) filter (where abs(p.recovery_variance_pence) > v_alert))::int, coalesce(sum(p.recovery_variance_pence) filter (where abs(p.recovery_variance_pence) > v_alert), 0)::bigint
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id
   where p.source = 'stripe' and p.recovery_variance_pence is not null and p.created_at >= p_from and p.created_at < p_to group by 1, 2 order by 1;
end $$;
create or replace function public.admin_edition_variance_items(p_from timestamptz, p_to timestamptz)
returns table (payment_id uuid, created_at timestamptz, organiser_name text, kind text, charge_pence integer, estimate_pence integer, actual_pence integer, variance_pence integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_alert integer := public.edition_commerce_cfg('editions.commerce.variance_alert_pence', '20')::integer;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select p.id, p.created_at, o.name, p.kind, p.charge_pence, p.recovery_estimate_pence, p.stripe_fee_pence, p.recovery_variance_pence
    from public.edition_payments p join public.edition_organisers o on o.id = p.organiser_id
   where p.source = 'stripe' and p.recovery_variance_pence is not null and abs(p.recovery_variance_pence) > v_alert and p.created_at >= p_from and p.created_at < p_to order by abs(p.recovery_variance_pence) desc limit 500;
end $$;
-- the standing notes that belong beside the fee figures
create or replace function public.admin_edition_fee_model_notes() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return jsonb_build_object('processing_fee', 'Estimated card processing fee, reconciled to Stripe''s actual fee. The estimate rates are placeholders until confirmed.',
    'rates_confirmed', public.edition_commerce_cfg('editions.commerce.stripe_cost_confirmed', 'false') = 'true',
    'connect_overheads', 'Stripe Connect account and payout overheads are absorbed by OneShetland and are not recovered per payment; they are tracked outside this report.',
    'dispute_fees', 'Stripe''s dispute fee is recorded but not passed to the organiser automatically.',
    'variance_treatment', 'No automatic true-up and no automatic refund of variance: the treatment of material variance is a pending commercial decision.',
    'vat', 'OneShetland is not VAT registered: commission statements carry VAT of 0.',
    'platform_vat_registered', public.edition_commerce_cfg('platform.vat_registered', 'false') = 'true');
end $$;

-- Organiser views: the commission and the ESTIMATED processing fee are shown separately from the price (never an added customer fee). Stripe's actual fee is OneShetland's own cost and is not shown to organisers.
drop function if exists public.edition_org_payments(uuid, timestamptz, timestamptz, text);
create or replace function public.edition_org_payments(p_org uuid, p_from timestamptz default null, p_to timestamptz default null, p_kind text default null)
returns table (payment_id uuid, created_at timestamptz, kind text, business_name text, source text, status text, price_pence integer, vat_pence integer, platform_fee_pence integer, stripe_fee_pence integer, charge_pence integer,
               net_to_organiser_pence integer, refunded_pence integer, method text, period_start timestamptz, period_end timestamptz, note text, ref_label text,
               commission_pence integer, commission_refunded_pence integer, processing_fee_estimate_pence integer, dispute_recovered_pence integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select p.id, p.created_at, p.kind, b.name, p.source, p.status, p.price_pence, p.vat_pence, p.platform_fee_pence, null::integer, p.charge_pence, p.net_to_organiser_pence, p.refunded_pence, p.method, p.period_start, p.period_end, p.note,
    case p.kind when 'membership' then (select t.name from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id where m.id = p.ref_id)
                else (select e.title from public.edition_participations x join public.editions e on e.id = x.edition_id where x.id = p.ref_id) end,
    coalesce(p.commission_pence, p.platform_fee_pence), p.commission_refunded_pence, coalesce(p.recovery_estimate_pence, 0), p.dispute_recovered_pence
    from public.edition_payments p join public.local_businesses b on b.id = p.business_id
   where p.organiser_id = p_org and (p_from is null or p.created_at >= p_from) and (p_to is null or p.created_at < p_to) and (p_kind is null or p.kind = p_kind) order by p.created_at desc limit 1000;
end $$;

drop function if exists public.edition_org_statement(uuid, timestamptz, timestamptz);
create or replace function public.edition_org_statement(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (month text, payments integer, gross_pence bigint, vat_pence bigint, platform_fee_pence bigint, stripe_fee_pence bigint, net_to_organiser_pence bigint, refunded_pence bigint, offline_pence bigint,
               commission_pence bigint, commission_refunded_pence bigint, processing_fee_estimate_pence bigint, dispute_recovered_pence bigint, net_after_refunds_pence bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'admin') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select to_char(date_trunc('month', p.created_at at time zone 'Europe/London'), 'YYYY-MM'), count(*)::int, sum(p.charge_pence) filter (where p.source = 'stripe'), sum(p.vat_pence) filter (where p.source = 'stripe'),
    sum(p.platform_fee_pence) filter (where p.source = 'stripe'), null::bigint, sum(p.net_to_organiser_pence) filter (where p.source = 'stripe'), sum(p.refunded_pence), sum(p.charge_pence) filter (where p.source = 'offline'),
    sum(coalesce(p.commission_pence, p.platform_fee_pence)) filter (where p.source = 'stripe'), sum(p.commission_refunded_pence) filter (where p.source = 'stripe'), sum(coalesce(p.recovery_estimate_pence, 0)) filter (where p.source = 'stripe'),
    sum(p.dispute_recovered_pence) filter (where p.source = 'stripe'),
    sum(p.charge_pence - p.platform_fee_pence - p.refunded_pence + p.commission_refunded_pence - p.dispute_recovered_pence) filter (where p.source = 'stripe')
    from public.edition_payments p where p.organiser_id = p_org and p.created_at >= p_from and p.created_at < p_to and p.status <> 'failed' group by 1 order by 1;
end $$;

-- ── VAT readiness (additive and nullable: nothing charges VAT; OneShetland is not VAT registered) ─────────────────────────────────────────────────

alter table public.edition_orders
  add column if not exists net_pence integer check (net_pence is null or net_pence >= 0),
  add column if not exists vat_pence integer check (vat_pence is null or vat_pence >= 0),
  add column if not exists vat_rate_percent numeric(5, 2) check (vat_rate_percent is null or vat_rate_percent between 0 and 100),
  add column if not exists buyer_vat_number text check (buyer_vat_number is null or buyer_vat_number ~ '^[A-Z]{2}[A-Z0-9]{2,12}$'),
  add column if not exists billing_name text check (billing_name is null or char_length(billing_name) <= 160),
  add column if not exists billing_address jsonb,
  add column if not exists vat_note text check (vat_note is null or char_length(vat_note) <= 300);

-- ── lock down: new objects are people-proof unless granted below ──────────────────────────────────────────────────────────────────────────────

alter table public.edition_dispute_recoveries enable row level security;
revoke all on public.edition_dispute_recoveries from public, anon, authenticated;
drop policy if exists "edition_dispute_recoveries read" on public.edition_dispute_recoveries;
create policy "edition_dispute_recoveries read" on public.edition_dispute_recoveries for select to authenticated using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
grant select on public.edition_dispute_recoveries to authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'edition_fee_parts(text,integer,uuid)', 'edition_fee_calc(text,integer,uuid)', 'edition_commission_rates()', 'edition_charge_breakdown(text,integer,text,uuid)', 'edition_payments_guard()', 'edition_payments_parts_default()',
    'edition_payment_note_stripe_fee(uuid,integer)', 'edition_payment_note_app_fee(uuid,integer,integer)', 'edition_participation_payment_succeeded(uuid,text,text,integer,integer,integer)',
    'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)', 'edition_refund_request_before()', 'edition_commission_plan_pending()',
    'edition_commission_refunds_next()', 'edition_commission_refund_mark(uuid,text,text)', 'edition_dispute_event(text,text,text,text,integer,integer,text)', 'edition_dispute_recoveries_next()',
    'edition_dispute_recovery_mark(text,text,text,text)', 'edition_dispute_commission_next()', 'edition_dispute_commission_mark(text,text,text)', 'admin_retry_edition_dispute_recovery(text,text)',
    'edition_reconcile_apply(jsonb,timestamptz,timestamptz)', 'admin_edition_fee_statement(timestamptz,timestamptz)', 'admin_edition_variance_report(timestamptz,timestamptz,text)',
    'admin_edition_variance_items(timestamptz,timestamptz)', 'admin_edition_fee_model_notes()', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_org_statement(uuid,timestamptz,timestamptz)',
    'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz,boolean)', 'admin_set_edition_commerce_config(text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- people (signed in): administrators' and owners' actions and read models, exactly as before plus the new reports
  foreach f in array array[
    'edition_charge_breakdown(text,integer,text,uuid)', 'edition_commission_rates()', 'admin_set_edition_commerce_config(text,text)', 'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz,boolean)',
    'admin_edition_fee_statement(timestamptz,timestamptz)', 'admin_edition_variance_report(timestamptz,timestamptz,text)', 'admin_edition_variance_items(timestamptz,timestamptz)', 'admin_edition_fee_model_notes()',
    'admin_retry_edition_dispute_recovery(text,text)', 'edition_org_payments(uuid,timestamptz,timestamptz,text)', 'edition_org_statement(uuid,timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- money in and the workers' queues: service role only (the verified webhook and the cron). Never granted to a person.
  foreach f in array array[
    'edition_participation_payment_succeeded(uuid,text,text,integer,integer,integer)', 'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)',
    'edition_commission_plan_pending()', 'edition_commission_refunds_next()', 'edition_commission_refund_mark(uuid,text,text)', 'edition_dispute_event(text,text,text,text,integer,integer,text)',
    'edition_dispute_recoveries_next()', 'edition_dispute_recovery_mark(text,text,text,text)', 'edition_dispute_commission_next()', 'edition_dispute_commission_mark(text,text,text)',
    'edition_reconcile_apply(jsonb,timestamptz,timestamptz)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

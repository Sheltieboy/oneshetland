-- Rolls back 20270102140000_editions_payment_safeguards_2.sql. Resolve or delete any 'duplicate_subscription' and 'refund_failed' exceptions first (the old check constraint does not allow them).
drop function if exists public.edition_payout_account_disconnected(text);
drop function if exists public.edition_stripe_stray_next();
drop function if exists public.edition_stripe_stray_mark(text, boolean, text);
drop table if exists public.edition_stripe_stray_subscriptions;
drop function if exists public.edition_refund_request_mark(uuid, text, text);
drop function if exists public.edition_refunds_next();
alter table public.edition_refund_requests drop column if exists attempts, drop column if exists last_error, drop column if exists next_attempt_at;

create or replace function public.edition_refunds_next() returns table (request_id uuid, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text, platform_fee_pence integer, refund_application_fee boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.payment_id, r.amount_pence, p.stripe_payment_intent_id, p.stripe_charge_id, p.platform_fee_pence, public.edition_commerce_cfg('editions.commerce.refund_application_fee', 'true') = 'true'
    from public.edition_refund_requests r join public.edition_payments p on p.id = r.payment_id where r.status = 'pending' order by r.created_at limit 20
$$;
create or replace function public.edition_refund_request_mark(p_request uuid, p_status text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_refund_requests set status = p_status, resolved_at = case when p_status in ('done', 'failed') then now() end where id = p_request and status in ('pending', 'submitted') and p_status in ('submitted', 'done', 'failed')
$$;

create or replace function public.edition_membership_pay_prepare(p_membership uuid, p_attempt text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; b record; v_block text; v_max integer;
begin
  select * into m from public.organiser_memberships where id = p_membership;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status not in ('pending_payment', 'past_due') then raise exception 'this membership is not waiting for payment' using errcode = '23514'; end if;
  if m.billing_interval not in ('monthly', 'annual') then raise exception 'this membership is not paid by card' using errcode = '23514'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  -- a person on the organiser's own team cannot pay the organiser (same rule as hubs and tickets)
  if public.edition_org_role(m.organiser_id) is not null then raise exception 'you cannot pay an organiser you are part of; ask them to record it instead' using errcode = '23514', hint = 'self_payment'; end if;
  v_block := public.edition_collect_blocker(m.organiser_id);
  if v_block is not null then raise exception 'this organiser cannot take payments right now (%)', v_block using errcode = '23514', hint = v_block; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  v_max := public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer;
  select * into b from public.edition_charge_breakdown('membership', m.price_pence, m.vat_mode, m.organiser_id);
  if b.charge_pence > v_max then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  return jsonb_build_object('membership_id', m.id, 'organiser_id', m.organiser_id, 'business_id', m.business_id, 'interval', m.billing_interval, 'price_pence', b.price_pence, 'vat_pence', b.vat_pence,
    'platform_fee_pence', b.platform_fee_pence, 'charge_pence', b.charge_pence, 'net_to_organiser_pence', b.net_to_organiser_pence, 'vat_mode', b.vat_mode, 'tier_name', t.name,
    'stripe_price_id', case m.billing_interval when 'monthly' then t.stripe_price_monthly_id else t.stripe_price_annual_id end, 'tier_id', t.id, 'attempt', p_attempt);
end $$;

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

create or replace function public.edition_participation_pay_prepare(p_link uuid, p_attempt text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.edition_links%rowtype; e public.editions%rowtype; t public.edition_participation_terms%rowtype; q record; v_block text; v_taken integer;
begin
  select * into l from public.edition_links where id = p_link;
  if not found or l.kind <> 'business' or not public.edition_biz_owner(l.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if l.state <> 'approved' then raise exception 'accept the invitation first' using errcode = '23514'; end if;
  select * into e from public.editions where id = l.edition_id;
  if e.status in ('suspended', 'archived') then raise exception 'this Edition is not open for new partners' using errcode = '23514'; end if;
  select * into t from public.edition_participation_terms where edition_id = l.edition_id;
  if not found or t.mode <> 'fee_required' then raise exception 'there is no fee for this Edition' using errcode = '23514'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  if t.applications_close is not null and current_date > t.applications_close then raise exception 'participation for this Edition has closed' using errcode = '23514'; end if;
  if exists (select 1 from public.edition_participations p where p.link_id = p_link and p.status in ('paid', 'waived', 'member_benefit')) then raise exception 'already covered' using errcode = '23505'; end if;
  if t.capacity is not null then
    select count(*) into v_taken from public.edition_participations p where p.edition_id = l.edition_id and p.status in ('paid', 'waived', 'member_benefit', 'awaiting_payment') and p.link_id <> p_link;
    if v_taken >= t.capacity then raise exception 'this Edition is full' using errcode = '23514'; end if;
  end if;
  if public.edition_org_role(e.organiser_id) is not null then raise exception 'you cannot pay an organiser you are part of; ask them to record it instead' using errcode = '23514', hint = 'self_payment'; end if;
  v_block := public.edition_collect_blocker(e.organiser_id);
  if v_block is not null then raise exception 'this organiser cannot take payments right now (%)', v_block using errcode = '23514', hint = v_block; end if;
  select * into q from public.edition_participation_quote(p_link);
  if q.price_pence = 0 then raise exception 'your membership covers the fee; claim it instead' using errcode = '23514', hint = 'claim_benefit'; end if;
  if q.charge_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_participations (link_id, edition_id, business_id, status, basis, quoted_price_pence, quoted_charge_pence, discount_pence)
  values (p_link, l.edition_id, l.business_id, 'awaiting_payment', 'fee', q.price_pence, q.charge_pence, q.discount_pence)
  on conflict (link_id) do update set status = 'awaiting_payment', basis = 'fee', quoted_price_pence = excluded.quoted_price_pence, quoted_charge_pence = excluded.quoted_charge_pence, discount_pence = excluded.discount_pence, updated_at = now()
   where public.edition_participations.status in ('awaiting_payment', 'refunded');
  perform public.edition_audit(e.organiser_id, l.edition_id, 'participation_pay_started', jsonb_build_object('link', p_link));
  return jsonb_build_object('link_id', p_link, 'organiser_id', e.organiser_id, 'business_id', l.business_id, 'edition_id', l.edition_id, 'price_pence', q.price_pence, 'vat_pence', q.vat_pence,
    'platform_fee_pence', q.platform_fee_pence, 'charge_pence', q.charge_pence, 'net_to_organiser_pence', q.net_to_organiser_pence, 'vat_mode', q.vat_mode, 'attempt', p_attempt, 'edition_title', e.title);
end $$;

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.edition_reconciliation_exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if c is not null then execute format('alter table public.edition_reconciliation_exceptions drop constraint %I', c); end if;
  alter table public.edition_reconciliation_exceptions add constraint edition_recon_kind_check check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch',
    'destination_mismatch', 'dispute', 'amount_refused', 'duplicate_payment', 'payment_after_cancel'));
end $$;

create or replace function public.edition_set_participation_terms(p_edition uuid, p_mode text, p_fee integer, p_vat_mode text, p_refund_policy text, p_refund_until date, p_capacity integer, p_closes date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_prev public.edition_participation_terms%rowtype;
begin
  select * into e from public.editions where id = p_edition;
  if not found or auth.uid() is null or not public.edition_org_can(e.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_mode = 'fee_required' and not public.edition_org_entitled(e.organiser_id, 'participation_fees') then raise exception 'participation fees are not included in your package' using errcode = '23514', hint = 'no_participation_entitlement'; end if;
  select * into v_prev from public.edition_participation_terms where edition_id = p_edition;
  -- Once anyone has paid, the fee and refund terms they agreed to cannot be changed under them.
  if found and exists (select 1 from public.edition_participations x where x.edition_id = p_edition and x.status in ('paid', 'awaiting_payment', 'refund_pending'))
     and (v_prev.mode, v_prev.fee_pence, v_prev.refund_policy, v_prev.refund_until, v_prev.vat_mode) is distinct from (p_mode, p_fee, p_refund_policy, p_refund_until, coalesce(p_vat_mode, 'none')) then
    raise exception 'the fee and refund terms cannot be changed once businesses have paid or started paying' using errcode = '23514', hint = 'terms_locked';
  end if;
  insert into public.edition_participation_terms (edition_id, mode, fee_pence, vat_mode, refund_policy, refund_until, capacity, applications_close, updated_by)
  values (p_edition, p_mode, case when p_mode = 'fee_required' then p_fee end, coalesce(p_vat_mode, 'none'), coalesce(p_refund_policy, 'none'), case when p_refund_policy = 'until_date' then p_refund_until end, p_capacity, p_closes, auth.uid())
  on conflict (edition_id) do update set mode = excluded.mode, fee_pence = excluded.fee_pence, vat_mode = excluded.vat_mode, refund_policy = excluded.refund_policy, refund_until = excluded.refund_until,
    capacity = excluded.capacity, applications_close = excluded.applications_close, updated_by = excluded.updated_by, updated_at = now();
  perform public.edition_audit(e.organiser_id, p_edition, 'participation_terms_set', jsonb_build_object('mode', p_mode, 'fee', p_fee));
end $$;

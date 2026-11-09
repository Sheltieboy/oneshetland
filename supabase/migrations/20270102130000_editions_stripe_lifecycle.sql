-- R10 Stripe lifecycle (cancellation + subscription reconciliation). Rollback: supabase/rollbacks/20270102130000_editions_stripe_lifecycle.rollback.sql
-- 1) Ending a card membership now ends the Stripe subscription (queued, drained by editions-commerce-cron), and a later provider update cannot revive it.
-- 2) A payment that arrives for an ended membership is recorded and raised for refund instead of failing the webhook forever.
-- 3) Reconciliation understands subscription charges (they carry no marker on the charge itself).
-- Nothing here runs unless the payment functions are deployed and editions.commerce.enabled is true.

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.edition_reconciliation_exceptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if c is not null then execute format('alter table public.edition_reconciliation_exceptions drop constraint %I', c); end if;
  alter table public.edition_reconciliation_exceptions add constraint edition_recon_kind_check check (kind in ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch', 'refund_mismatch', 'destination_mismatch', 'dispute', 'amount_refused', 'duplicate_payment', 'payment_after_cancel'));
end $$;

create table if not exists public.edition_stripe_cancel_queue (
  membership_id   uuid primary key references public.organiser_memberships (id) on delete cascade,
  subscription_id text not null,
  mode            text not null check (mode in ('at_period_end', 'now')),
  status          text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.edition_stripe_cancel_queue enable row level security;
revoke all on public.edition_stripe_cancel_queue from public, anon, authenticated;

-- internal: queue (or escalate) a provider cancellation. 'now' always wins over 'at_period_end'; a finished request is re-opened when escalated.
create or replace function public.edition_stripe_cancel_enqueue(p_membership uuid, p_mode text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sub text;
begin
  select stripe_subscription_id into v_sub from public.organiser_memberships where id = p_membership;
  if v_sub is null then return; end if;
  insert into public.edition_stripe_cancel_queue (membership_id, subscription_id, mode) values (p_membership, v_sub, p_mode)
  on conflict (membership_id) do update set subscription_id = excluded.subscription_id,
    mode = case when public.edition_stripe_cancel_queue.mode = 'now' or excluded.mode = 'now' then 'now' else 'at_period_end' end,
    status = case when public.edition_stripe_cancel_queue.status = 'done' and public.edition_stripe_cancel_queue.mode = 'at_period_end' and excluded.mode = 'now' then 'pending'
                  when public.edition_stripe_cancel_queue.status = 'done' then 'done' else 'pending' end,
    updated_at = now();
end $$;
revoke all on function public.edition_stripe_cancel_enqueue(uuid, text) from public, anon, authenticated;

create or replace function public.edition_membership_stripe_cancel_trg() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stripe_subscription_id is not null and new.status is distinct from old.status then
    if new.status = 'cancel_at_period_end' then perform public.edition_stripe_cancel_enqueue(new.id, 'at_period_end');
    elsif new.status in ('cancelled', 'expired', 'withdrawn', 'declined') then perform public.edition_stripe_cancel_enqueue(new.id, 'now'); end if;
  end if;
  return new;
end $$;
revoke all on function public.edition_membership_stripe_cancel_trg() from public, anon, authenticated;
drop trigger if exists zz_edition_membership_stripe_cancel on public.organiser_memberships;
create trigger zz_edition_membership_stripe_cancel after update of status on public.organiser_memberships for each row execute function public.edition_membership_stripe_cancel_trg();

-- service role (the cron): what still has to be cancelled at the provider, and the result
create or replace function public.edition_stripe_cancels_next() returns table (membership_id uuid, subscription_id text, mode text)
language sql stable security definer set search_path = public, pg_temp as $$
  select q.membership_id, q.subscription_id, q.mode from public.edition_stripe_cancel_queue q where q.status in ('pending', 'failed') and q.attempts < 8 order by q.created_at limit 25
$$;
create or replace function public.edition_stripe_cancel_mark(p_membership uuid, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_stripe_cancel_queue set status = case when p_ok then 'done' else 'failed' end, attempts = attempts + 1, last_error = left(p_error, 300), updated_at = now() where membership_id = p_membership
$$;
revoke all on function public.edition_stripe_cancels_next() from public, anon, authenticated;
revoke all on function public.edition_stripe_cancel_mark(uuid, boolean, text) from public, anon, authenticated;

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

create or replace function public.edition_membership_subscription_changed(p_membership uuid, p_status text, p_cancel_at_period_end boolean, p_period_end timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found then raise exception 'unknown membership' using errcode = 'P0002'; end if;
  -- A later provider update can never bring an ended membership back: it is logged and the provider subscription is cancelled again.
  if m.status in ('cancelled', 'withdrawn', 'declined') and coalesce(p_status, '') <> 'canceled' then
    perform public.edition_mem_event(m.id, 'revival_refused', jsonb_build_object('provider_status', p_status));
    if m.stripe_subscription_id is not null then
      perform public.edition_stripe_cancel_enqueue(m.id, 'now');
      update public.edition_stripe_cancel_queue set status = 'pending', updated_at = now() where membership_id = m.id;   -- the provider says it is alive again: re-open a finished cancel
    end if;
    return;
  end if;
  if p_status = 'canceled' then update public.organiser_memberships set status = 'cancelled', current_period_end = least(coalesce(current_period_end, now()), now()), updated_at = now() where id = m.id and status not in ('cancelled', 'expired');
  elsif m.status in ('active', 'cancel_at_period_end') then
    update public.organiser_memberships set status = case when p_cancel_at_period_end then 'cancel_at_period_end' else 'active' end, current_period_end = coalesce(p_period_end, current_period_end), updated_at = now() where id = m.id;
  end if;
  perform public.edition_mem_event(m.id, 'subscription_' || coalesce(p_status, 'changed'), jsonb_build_object('cancel_at_period_end', p_cancel_at_period_end));
end $$;

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

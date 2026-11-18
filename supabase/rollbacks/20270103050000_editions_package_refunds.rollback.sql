-- Rollback of 20270103050000_editions_package_refunds. Package-order refund REQUESTS are discarded (a refund already sent to Stripe stays refunded there; the webhook path edition_refund_order is restored to its previous form).
drop function if exists public.admin_request_edition_order_refund(uuid, integer, text);
drop function if exists public.admin_edition_order_refunds(uuid);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'edition_refund_requests' and column_name = 'order_id') then
    delete from public.edition_refund_requests where order_id is not null;
  end if;
end $$;
drop index if exists public.refund_requests_one_open_per_order;
alter table public.edition_refund_requests drop constraint if exists edition_refund_requests_one_target;
alter table public.edition_refund_requests drop column if exists order_id;
alter table public.edition_refund_requests alter column payment_id set not null;

drop function if exists public.edition_refunds_next();
create or replace function public.edition_refunds_next() returns table (request_id uuid, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text, platform_fee_pence integer, refund_application_fee boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.payment_id, r.amount_pence, p.stripe_payment_intent_id, p.stripe_charge_id, p.platform_fee_pence, public.edition_commerce_cfg('editions.commerce.refund_application_fee', 'true') = 'true'
    from public.edition_refund_requests r join public.edition_payments p on p.id = r.payment_id where r.status = 'pending' and r.next_attempt_at <= now() order by r.created_at limit 20
$$;
revoke all on function public.edition_refunds_next() from public, anon, authenticated;

create or replace function public.edition_refund_request_mark(p_request uuid, p_status text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.edition_refund_requests%rowtype; v_pi text;
begin
  select * into r from public.edition_refund_requests where id = p_request for update;
  if not found or r.status not in ('pending', 'submitted') or p_status not in ('submitted', 'done', 'failed', 'retry') then return; end if;
  if p_status = 'retry' and r.attempts + 1 >= 6 then p_status := 'failed'; end if;
  if p_status = 'retry' then
    update public.edition_refund_requests set attempts = attempts + 1, last_error = left(p_error, 300), next_attempt_at = now() + make_interval(mins => (attempts + 1) * (attempts + 1) * 2) where id = p_request;
    return;
  end if;
  update public.edition_refund_requests set status = p_status, last_error = coalesce(left(p_error, 300), last_error), resolved_at = case when p_status in ('done', 'failed') then now() end where id = p_request;
  if p_status = 'failed' then
    select stripe_payment_intent_id into v_pi from public.edition_payments where id = r.payment_id;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (r.organiser_id, 'refund_failed', coalesce(v_pi, r.payment_id::text) || '#' || left(r.id::text, 8), r.payment_id,
      jsonb_build_object('request', r.id, 'amount', r.amount_pence, 'error', left(p_error, 300), 'attempts', r.attempts)) on conflict do nothing;
  end if;
end $$;
revoke all on function public.edition_refund_request_mark(uuid, text, text) from public, anon, authenticated;

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
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_refunded', jsonb_build_object('order', o.id, 'refunded', p_refunded_total));
  return case when p_refunded_total >= o.amount_pence then 'voided' else 'recorded' end;
end $$;
revoke all on function public.edition_refund_order(uuid, integer) from public, anon, authenticated;
grant execute on function public.edition_refund_order(uuid, integer) to service_role;

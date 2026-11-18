-- Editions: in-product refunds for PACKAGE orders (an administrator never needs the Stripe dashboard).
--
--   * Reuses the participation refund queue: edition_refund_requests now also holds a request for a package order (order_id instead of payment_id). The existing worker
--     (editions-commerce-cron, action 'refunds') performs the Stripe refund with an idempotency key and retries with back-off; the Stripe `charge.refunded` webhook then calls the
--     EXISTING edition_refund_order, which records the cumulative refund, voids the entitlement on a FULL refund (a partial refund leaves it live) and closes the request.
--   * admin_request_edition_order_refund: administrators only, a paid or partly refunded order, never a free order, never more than is left to refund (counting refunds already in flight),
--     a reason of at least 5 characters, idempotent, audited. It does not touch event moderation, Hub flags, review state or the Edition row.
-- Expand-only. Rollback: supabase/rollbacks/20270103050000_editions_package_refunds.rollback.sql

alter table public.edition_refund_requests alter column payment_id drop not null;
alter table public.edition_refund_requests add column if not exists order_id uuid references public.edition_orders (id) on delete restrict;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_refund_requests_one_target') then
    alter table public.edition_refund_requests add constraint edition_refund_requests_one_target check ((payment_id is null) <> (order_id is null));
  end if;
end $$;
-- one refund in flight per order
create unique index if not exists refund_requests_one_open_per_order on public.edition_refund_requests (order_id) where order_id is not null and status in ('pending', 'submitted');

-- ── the administrator's request ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Returns jsonb: { request_id, order_id, amount_pence, full (this request refunds everything that is left), remaining_after_pence, status ('pending'), already_requested (true on a repeat) }
create or replace function public.admin_request_edition_order_refund(p_order uuid, p_amount_pence integer default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype; v_left integer; v_amount integer; r public.edition_refund_requests%rowtype; v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason of at least 5 characters' using errcode = '23514', hint = 'reason_required'; end if;
  if o.amount_pence = 0 then raise exception 'a free package has nothing to refund' using errcode = '23514', hint = 'free_order'; end if;
  if o.status not in ('paid', 'partially_refunded') then raise exception 'only a paid order can be refunded' using errcode = '23514', hint = 'not_refundable'; end if;
  if o.stripe_payment_intent_id is null then raise exception 'this order has no card payment to refund' using errcode = '23514', hint = 'no_payment'; end if;
  v_left := o.amount_pence - o.refunded_pence;
  v_amount := coalesce(p_amount_pence, v_left);
  -- an identical request already in flight is the same request (a double click or a retry)
  select * into r from public.edition_refund_requests x where x.order_id = o.id and x.status in ('pending', 'submitted');
  if found then
    if r.amount_pence = v_amount then
      return jsonb_build_object('request_id', r.id, 'order_id', o.id, 'amount_pence', r.amount_pence, 'full', r.amount_pence >= v_left, 'remaining_after_pence', v_left - r.amount_pence, 'status', r.status, 'already_requested', true);
    end if;
    raise exception 'a refund is already in progress for this order' using errcode = '23505', hint = 'refund_in_progress';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount > v_left then raise exception 'the refund must be more than nothing and no more than what is left' using errcode = '23514', hint = 'bad_amount'; end if;
  insert into public.edition_refund_requests (order_id, organiser_id, amount_pence, reason, requested_by) values (o.id, o.organiser_id, v_amount, left(btrim(p_reason), 300), auth.uid()) returning id into v_id;
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_refund_requested', jsonb_build_object('order', o.id, 'request', v_id, 'amount', v_amount, 'full', v_amount >= v_left));
  return jsonb_build_object('request_id', v_id, 'order_id', o.id, 'amount_pence', v_amount, 'full', v_amount >= v_left, 'remaining_after_pence', v_left - v_amount, 'status', 'pending', 'already_requested', false);
end $$;

-- the administrator's view of refunds for an order (any status), newest first
create or replace function public.admin_edition_order_refunds(p_order uuid) returns table (request_id uuid, amount_pence integer, reason text, status text, attempts integer, last_error text, created_at timestamptz, resolved_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select r.id, r.amount_pence, r.reason, r.status, r.attempts, r.last_error, r.created_at, r.resolved_at from public.edition_refund_requests r where r.order_id = p_order order by r.created_at desc;
end $$;

-- ── the worker's queue: now carries package-order refunds as well ────────────────────────────────────────────────────────────────────────────────────
drop function if exists public.edition_refunds_next();
create or replace function public.edition_refunds_next() returns table (request_id uuid, payment_id uuid, amount_pence integer, stripe_payment_intent_id text, stripe_charge_id text, platform_fee_pence integer, refund_application_fee boolean, order_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.payment_id, r.amount_pence, coalesce(p.stripe_payment_intent_id, o.stripe_payment_intent_id), p.stripe_charge_id, coalesce(p.platform_fee_pence, 0),
         (r.order_id is null and public.edition_commerce_cfg('editions.commerce.refund_application_fee', 'true') = 'true'), r.order_id
    from public.edition_refund_requests r
    left join public.edition_payments p on p.id = r.payment_id
    left join public.edition_orders o on o.id = r.order_id
   where r.status = 'pending' and r.next_attempt_at <= now() order by r.created_at limit 20
$$;

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
    select coalesce((select stripe_payment_intent_id from public.edition_payments where id = r.payment_id), (select stripe_payment_intent_id from public.edition_orders where id = r.order_id)) into v_pi;
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (r.organiser_id, 'refund_failed', coalesce(v_pi, coalesce(r.payment_id, r.order_id)::text) || '#' || left(r.id::text, 8), r.payment_id,
      jsonb_build_object('request', r.id, 'order', r.order_id, 'amount', r.amount_pence, 'error', left(p_error, 300), 'attempts', r.attempts)) on conflict do nothing;
    if r.order_id is not null then perform public.edition_audit(r.organiser_id, null, 'order_refund_failed', jsonb_build_object('order', r.order_id, 'request', r.id)); end if;
  end if;
end $$;

-- ── what the provider confirms: the existing cumulative path, plus closing the request ───────────────────────────────────────────────────────────────
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

-- ── privileges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['admin_request_edition_order_refund(uuid,integer,text)', 'admin_edition_order_refunds(uuid)', 'edition_refunds_next()', 'edition_refund_request_mark(uuid,text,text)', 'edition_refund_order(uuid,integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['admin_request_edition_order_refund(uuid,integer,text)', 'admin_edition_order_refunds(uuid)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['edition_refunds_next()', 'edition_refund_request_mark(uuid,text,text)', 'edition_refund_order(uuid,integer)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

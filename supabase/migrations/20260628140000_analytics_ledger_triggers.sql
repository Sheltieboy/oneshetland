-- ============================================================================
-- Analytics: transaction events from the ledgers (server-trusted conversions)
--
-- Each money row emits its conversion event the moment it reaches a paid/
-- settled state — straight from the source of truth, so it can't be spoofed or
-- missed, and needs ZERO edge-function changes. Client track() handles the
-- behaviour/intent funnel (views, started, intent); these triggers handle the
-- completions. No double-counting.
--
-- Money amounts are NOT copied here — order_id points at the ledger row.
-- ============================================================================

-- Shared emitter (SECURITY DEFINER so it bypasses analytics_events RLS even when
-- the ledger row was written by an authenticated user, e.g. a free booking).
create or replace function public.analytics_emit(
  p_event text, p_user uuid, p_business uuid, p_hub uuid, p_order uuid,
  p_object_type text, p_object_id text, p_props jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.analytics_events
    (event_name, user_id, business_id, hub_id, order_id, object_type, object_id, platform, user_type, props)
  values
    (p_event, p_user, p_business, p_hub, p_order, p_object_type, p_object_id, 'app', 'user', coalesce(p_props,'{}'::jsonb));
$$;

-- ── event tickets: status → paid ────────────────────────────────────────────
create or replace function public.tg_ae_event_tickets() returns trigger language plpgsql as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    perform public.analytics_emit('event_ticket_purchased', new.buyer_id, null, null, new.id,
      'event', new.event_id::text, jsonb_build_object('tickets_count', new.tickets_count));
  end if;
  return new;
end $$;
drop trigger if exists ae_event_tickets on public.event_ticket_orders;
create trigger ae_event_tickets after update on public.event_ticket_orders
  for each row execute function public.tg_ae_event_tickets();

-- ── unit/pass purchases: row exists = paid ──────────────────────────────────
create or replace function public.tg_ae_unit_purchase() returns trigger language plpgsql as $$
begin
  perform public.analytics_emit('unit_purchase_completed', new.owner_id, new.business_id, null, new.id,
    'unit_item', new.item_id::text, '{}'::jsonb);
  return new;
end $$;
drop trigger if exists ae_unit_purchase on public.book_unit_purchases;
create trigger ae_unit_purchase after insert on public.book_unit_purchases
  for each row execute function public.tg_ae_unit_purchase();

-- ── bookings: confirmed (lead) on insert; deposit paid (transaction) on update ─
create or replace function public.tg_ae_booking() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status = 'confirmed' then
    perform public.analytics_emit('booking_confirmed', new.customer_id, new.business_id, null, new.id,
      'service', new.service_id::text, jsonb_build_object('has_deposit', coalesce(new.deposit_pence,0) > 0));
  elsif tg_op = 'UPDATE' then
    if new.deposit_paid_at is not null and old.deposit_paid_at is null then
      perform public.analytics_emit('booking_paid', new.customer_id, new.business_id, null, new.id,
        'service', new.service_id::text, '{}'::jsonb);
    elsif new.status = 'confirmed' and old.status is distinct from 'confirmed' then
      perform public.analytics_emit('booking_confirmed', new.customer_id, new.business_id, null, new.id,
        'service', new.service_id::text, jsonb_build_object('has_deposit', coalesce(new.deposit_pence,0) > 0));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ae_booking on public.book_bookings;
create trigger ae_booking after insert or update on public.book_bookings
  for each row execute function public.tg_ae_booking();

-- ── gifts: status → sent (paid + delivered) ─────────────────────────────────
create or replace function public.tg_ae_gift() returns trigger language plpgsql as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    perform public.analytics_emit('gift_purchased', new.purchaser_id, new.business_id, null, new.id,
      'gift', new.id::text, jsonb_build_object('kind', new.kind));
  end if;
  return new;
end $$;
drop trigger if exists ae_gift on public.book_gifts;
create trigger ae_gift after update on public.book_gifts
  for each row execute function public.tg_ae_gift();

-- ── hub donations: row exists = settled ─────────────────────────────────────
create or replace function public.tg_ae_donation() returns trigger language plpgsql as $$
begin
  perform public.analytics_emit('hub_donation_completed', new.donor_user_id, null, new.hub_id, new.id,
    'campaign', new.campaign_id::text,
    jsonb_build_object('is_anonymous', new.is_anonymous, 'gift_aid', new.gift_aid));
  return new;
end $$;
drop trigger if exists ae_donation on public.hub_donations;
create trigger ae_donation after insert on public.hub_donations
  for each row execute function public.tg_ae_donation();

-- ── hub memberships: paid (transaction) or free join (lead) ─────────────────
create or replace function public.tg_ae_membership() returns trigger language plpgsql as $$
begin
  if coalesce(new.last_payment_pence,0) > 0 then
    perform public.analytics_emit('hub_membership_paid', new.user_id, null, new.hub_id, new.id,
      'membership_type', new.membership_type_id::text, '{}'::jsonb);
  elsif new.status = 'active' then
    perform public.analytics_emit('hub_membership_joined', new.user_id, null, new.hub_id, new.id,
      'membership_type', new.membership_type_id::text, '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists ae_membership on public.hub_members;
create trigger ae_membership after insert on public.hub_members
  for each row execute function public.tg_ae_membership();

-- ── wallet: top-up (float) and pay-a-business ───────────────────────────────
create or replace function public.tg_ae_wallet() returns trigger language plpgsql as $$
begin
  if new.type = 'topup' then
    perform public.analytics_emit('wallet_topup_completed', new.user_id, null, null, new.id, null, null, '{}'::jsonb);
  elsif new.type = 'spend' then
    perform public.analytics_emit('wallet_payment_completed', new.user_id, new.business_id, null, new.id,
      null, null, jsonb_build_object('cashback', coalesce(new.cashback_pence,0) > 0));
  end if;
  return new;
end $$;
drop trigger if exists ae_wallet on public.local_wallet_transactions;
create trigger ae_wallet after insert on public.local_wallet_transactions
  for each row execute function public.tg_ae_wallet();

-- ── delivery: payment captured ──────────────────────────────────────────────
create or replace function public.tg_ae_delivery() returns trigger language plpgsql as $$
begin
  if new.payment_status = 'captured' and old.payment_status is distinct from 'captured' then
    perform public.analytics_emit('delivery_payment_captured', new.customer_id, null, null, new.id,
      null, null, jsonb_build_object('category', new.category_slug));
  end if;
  return new;
end $$;
drop trigger if exists ae_delivery on public.delivery_requests;
create trigger ae_delivery after update on public.delivery_requests
  for each row execute function public.tg_ae_delivery();

-- ── business boost: status → succeeded ──────────────────────────────────────
create or replace function public.tg_ae_boost() returns trigger language plpgsql as $$
begin
  if new.status = 'succeeded' and old.status is distinct from 'succeeded' then
    perform public.analytics_emit('business_boost_purchased', new.owner_id, new.business_id, null, new.id,
      null, null, jsonb_build_object('weeks', new.weeks));
  end if;
  return new;
end $$;
drop trigger if exists ae_boost on public.local_boost_purchases;
create trigger ae_boost after update on public.local_boost_purchases
  for each row execute function public.tg_ae_boost();

-- ── shift boost: boosted_until set ──────────────────────────────────────────
create or replace function public.tg_ae_shift_boost() returns trigger language plpgsql as $$
begin
  if new.boosted_until is not null and old.boosted_until is distinct from new.boosted_until then
    perform public.analytics_emit('shift_boost_purchased', new.employer_id, new.posted_as_business_id, null, null,
      'shift', new.id::text, '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists ae_shift_boost on public.shifts;
create trigger ae_shift_boost after update on public.shifts
  for each row execute function public.tg_ae_shift_boost();

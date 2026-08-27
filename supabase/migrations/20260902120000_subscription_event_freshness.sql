-- Paygate 10 — an older Stripe event cannot overwrite newer state.
--
-- THE DEFECT
--
-- Fix 2 made a subscription able to change only the entitlement it owns. It did
-- not make the ORDER of events safe, and I argued the wrong thing about it: I
-- said Stripe never transitions active → incomplete, so the case could not
-- arise. That confuses how an event is GENERATED with how it is DELIVERED.
--
-- Stripe generates customer.subscription.created carrying an 'incomplete'
-- snapshot, then customer.subscription.updated carrying 'active'. Delivery of
-- the two is not ordered. If the active one lands first the business is
-- correctly Premium — and then the older created event arrives, still saying
-- 'incomplete', and by then that subscription OWNS the row, so it lapsed it.
-- Reproduced: Premium until 27 September became free with no expiry.
--
-- THE RULE
--
-- Each subscription carries a watermark: the created timestamp of the newest
-- event applied to it. An event older than the watermark is a stale snapshot
-- and changes nothing.
--
-- Stripe stamps event.created in whole SECONDS, so two events for one
-- subscription can share one. A timestamp alone is therefore not a total
-- order, and pretending otherwise would just move the bug. On an equal
-- timestamp the tie is broken by direction: a non-active snapshot may not
-- override a recorded active one. Ties can only ever settle towards the live
-- state, never away from it, whichever order they arrive in.

begin;

create table if not exists public.stripe_subscription_watermarks (
  stripe_subscription_id text primary key,
  last_event_created     bigint not null,
  last_status            text   not null,
  updated_at             timestamptz not null default now()
);

alter table public.stripe_subscription_watermarks enable row level security;
revoke all on public.stripe_subscription_watermarks from anon, authenticated;
grant select, insert, update on public.stripe_subscription_watermarks to service_role;

comment on table public.stripe_subscription_watermarks is
  'Newest Stripe event.created applied per subscription. Server-managed; a late delivery carrying an older snapshot is rejected against this.';

/**
 * Is this event newer than what has already been applied to the subscription?
 * Claims the watermark when it is, so the caller may proceed.
 */
create or replace function public.claim_subscription_event(
  p_sub_id        text,
  p_event_created bigint,
  p_status        text
) returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare
  w public.stripe_subscription_watermarks%rowtype;
  v_active boolean := p_status in ('active', 'trialing');
begin
  if p_sub_id is null or p_event_created is null then
    return true;  -- nothing to compare against; behave as before.
  end if;

  select * into w from public.stripe_subscription_watermarks
   where stripe_subscription_id = p_sub_id for update;

  if not found then
    insert into public.stripe_subscription_watermarks
      (stripe_subscription_id, last_event_created, last_status)
    values (p_sub_id, p_event_created, p_status)
    on conflict (stripe_subscription_id) do nothing;
    return true;
  end if;

  if p_event_created < w.last_event_created then
    return false;                                   -- an older snapshot
  end if;

  if p_event_created = w.last_event_created then
    -- Same second. Only settle towards the live state, never away from it.
    if not v_active and w.last_status in ('active', 'trialing') then
      return false;
    end if;
  end if;

  update public.stripe_subscription_watermarks set
    last_event_created = greatest(last_event_created, p_event_created),
    last_status        = p_status,
    updated_at         = now()
  where stripe_subscription_id = p_sub_id;
  return true;
end;
$function$;

-- ── The entitlement writer, now freshness-aware ─────────────────────────────
drop function if exists public.apply_subscription_state(text, text, text, text, timestamptz, boolean);

create or replace function public.apply_subscription_state(
  p_sub_id               text,
  p_customer             text,
  p_status               text,
  p_tier                 text,
  p_period_end           timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created        bigint default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_active boolean := p_status in ('active', 'trialing');
  v_owned  public.local_businesses%rowtype;
  v_target public.local_businesses%rowtype;
  v_tier   text;
begin
  if p_sub_id is null or btrim(p_sub_id) = '' then
    raise exception 'apply_subscription_state: a subscription id is required' using errcode = '22023';
  end if;

  -- Freshness first: a stale snapshot must not be acted on at all.
  if not public.claim_subscription_event(p_sub_id, p_event_created, p_status) then
    return jsonb_build_object('applied', false, 'reason', 'stale_event', 'status', p_status);
  end if;

  select * into v_owned from public.local_businesses
   where stripe_subscription_id = p_sub_id for update;

  if not v_active then
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'not_owned', 'status', p_status);
    end if;
    update public.local_businesses set
      subscription_tier                 = 'free',
      subscription_until                = null,
      subscription_cancel_at_period_end = false
    where id = v_owned.id;
    return jsonb_build_object('applied', true, 'reason', 'owner_lapsed', 'status', p_status,
                              'business_id', v_owned.id, 'tier_before', v_owned.subscription_tier,
                              'tier_after', 'free');
  end if;

  if found then
    v_target := v_owned;
  else
    select * into v_target from public.local_businesses
     where stripe_customer_id = p_customer for update;
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'no_business', 'status', p_status);
    end if;
  end if;

  v_tier := coalesce(p_tier, v_target.subscription_tier, 'free');

  update public.local_businesses set
    subscription_tier                 = v_tier,
    subscription_until                = p_period_end,
    subscription_cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    stripe_subscription_id            = p_sub_id,
    stripe_customer_id                = p_customer
  where id = v_target.id;

  return jsonb_build_object('applied', true, 'reason', 'active', 'status', p_status,
                            'business_id', v_target.id, 'tier_before', v_target.subscription_tier,
                            'tier_after', v_tier, 'until', p_period_end);
end;
$function$;

-- ── Cancellation, through the same watermark ────────────────────────────────
--
-- Without this an older 'active' delivered after the deletion would find the
-- business it still owned and put the plan back on a subscription Stripe has
-- ended.
create or replace function public.retire_subscription(
  p_sub_id        text,
  p_event_created bigint default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare b public.local_businesses%rowtype;
begin
  if not public.claim_subscription_event(p_sub_id, p_event_created, 'canceled') then
    return jsonb_build_object('applied', false, 'reason', 'stale_event');
  end if;

  select * into b from public.local_businesses
   where stripe_subscription_id = p_sub_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'not_owned');
  end if;

  update public.local_businesses set
    subscription_tier                 = 'free',
    subscription_until                = null,
    subscription_cancel_at_period_end = false,
    -- Clear the dead id: leaving it set made the business unable to buy
    -- anything, because the billing screen took the change-plan path and found
    -- a cancelled subscription still sitting on the Pro price.
    stripe_subscription_id            = null
  where id = b.id;

  return jsonb_build_object('applied', true, 'reason', 'retired', 'business_id', b.id,
                            'owner_id', b.owner_id, 'name', b.name,
                            'tier_before', b.subscription_tier);
end;
$function$;

-- ── Renewal invoices extend; they never shorten ─────────────────────────────
--
-- A stale invoice arriving after a newer one would otherwise pull the expiry
-- backwards. Same ordering hazard, same answer: only ever forwards.
create or replace function public.extend_subscription_period(
  p_sub_id     text,
  p_period_end timestamptz
) returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if p_sub_id is null or p_period_end is null then return false; end if;
  update public.local_businesses set
    subscription_until = greatest(coalesce(subscription_until, p_period_end), p_period_end)
  where stripe_subscription_id = p_sub_id
    and (subscription_until is null or subscription_until < p_period_end);
  return found;
end;
$function$;

revoke execute on function public.claim_subscription_event(text, bigint, text)                                   from anon, authenticated, public;
revoke execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint) from anon, authenticated, public;
revoke execute on function public.retire_subscription(text, bigint)                                              from anon, authenticated, public;
revoke execute on function public.extend_subscription_period(text, timestamptz)                                  from anon, authenticated, public;
grant  execute on function public.claim_subscription_event(text, bigint, text)                                   to service_role;
grant  execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint) to service_role;
grant  execute on function public.retire_subscription(text, bigint)                                              to service_role;
grant  execute on function public.extend_subscription_period(text, timestamptz)                                  to service_role;

commit;

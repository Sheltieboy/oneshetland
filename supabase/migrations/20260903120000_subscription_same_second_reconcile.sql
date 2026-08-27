-- Paygate 10 — a tie is not a chronology, so stop guessing at one.
--
-- THE DEFECT
--
-- The freshness watermark broke ties on equal event.created by preferring the
-- active state: a non-active snapshot could not override a recorded
-- active/trialing one. That is safe in exactly one direction — an old
-- 'incomplete' arriving after 'active' — and wrong in every other.
--
-- Stripe stamps event.created in whole seconds. A subscription that activates
-- and then immediately fails its first renewal, or is cancelled in the same
-- second, produces two events sharing a timestamp where the LATER one is the
-- non-active one. "Prefer active" rejected it. Reproduced:
--
--   active → genuinely later past_due   (same second) → stayed 2026-09-27/pro
--   active → genuinely later unpaid     (same second) → stayed 2026-09-27/pro
--   active → genuinely later deleted    (same second) → stayed 2026-09-27/pro
--
-- A business kept a paid tier it had stopped paying for, and a cancellation
-- did not take effect. A static status preference cannot represent chronology:
-- active → past_due → active is a legitimate sequence, so no permanent ranking
-- of statuses can be right.
--
-- THE RULE
--
-- Strictly newer wins. Strictly older is stale. An equal timestamp carrying a
-- DIFFERENT status is an ambiguity this database cannot resolve, so it does not
-- try: it reports 'conflict', and the webhook asks Stripe what the subscription
-- actually is now and applies THAT. The current authoritative state wins —
-- never a preferred status.
--
-- Ties with the same status are duplicates and apply idempotently, so the
-- normal path costs no extra Stripe call.

begin;

/**
 * fresh    — newer than anything applied, or a harmless duplicate
 * stale    — an older snapshot; change nothing
 * conflict — same second, different status; the caller must reconcile
 */
create or replace function public.claim_subscription_event(
  p_sub_id        text,
  p_event_created bigint,
  p_status        text,
  p_force         boolean default false
) returns text
language plpgsql security definer set search_path to 'public'
as $function$
declare w public.stripe_subscription_watermarks%rowtype;
begin
  if p_sub_id is null or p_event_created is null then
    return 'fresh';   -- nothing to compare against
  end if;

  select * into w from public.stripe_subscription_watermarks
   where stripe_subscription_id = p_sub_id for update;

  if not found then
    insert into public.stripe_subscription_watermarks
      (stripe_subscription_id, last_event_created, last_status)
    values (p_sub_id, p_event_created, p_status)
    on conflict (stripe_subscription_id) do nothing;
    return 'fresh';
  end if;

  -- Reconciled state read straight from Stripe outranks any snapshot.
  if p_force then
    update public.stripe_subscription_watermarks set
      last_event_created = greatest(last_event_created, p_event_created),
      last_status = p_status, updated_at = now()
    where stripe_subscription_id = p_sub_id;
    return 'fresh';
  end if;

  if p_event_created < w.last_event_created then return 'stale'; end if;

  if p_event_created = w.last_event_created
     and p_status is distinct from w.last_status then
    -- Two snapshots, one second, disagreeing. Which came first is not knowable
    -- from here, and guessing is how the previous rule kept a lapsed
    -- subscription alive.
    return 'conflict';
  end if;

  update public.stripe_subscription_watermarks set
    last_event_created = greatest(last_event_created, p_event_created),
    last_status = p_status, updated_at = now()
  where stripe_subscription_id = p_sub_id;
  return 'fresh';
end;
$function$;

drop function if exists public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint);

create or replace function public.apply_subscription_state(
  p_sub_id               text,
  p_customer             text,
  p_status               text,
  p_tier                 text,
  p_period_end           timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created        bigint  default null,
  p_force                boolean default false
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_active  boolean := p_status in ('active', 'trialing');
  v_claim   text;
  v_owned   public.local_businesses%rowtype;
  v_target  public.local_businesses%rowtype;
  v_tier    text;
begin
  if p_sub_id is null or btrim(p_sub_id) = '' then
    raise exception 'apply_subscription_state: a subscription id is required' using errcode = '22023';
  end if;

  v_claim := public.claim_subscription_event(p_sub_id, p_event_created, p_status, p_force);
  if v_claim = 'stale' then
    return jsonb_build_object('applied', false, 'reason', 'stale_event', 'status', p_status);
  end if;
  if v_claim = 'conflict' then
    -- The caller must ask Stripe and come back with p_force.
    return jsonb_build_object('applied', false, 'reason', 'needs_reconcile',
                              'status', p_status, 'subscription_id', p_sub_id);
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

drop function if exists public.retire_subscription(text, bigint);

create or replace function public.retire_subscription(
  p_sub_id        text,
  p_event_created bigint  default null,
  p_force         boolean default false
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare b public.local_businesses%rowtype; v_claim text;
begin
  v_claim := public.claim_subscription_event(p_sub_id, p_event_created, 'canceled', p_force);
  if v_claim = 'stale'    then return jsonb_build_object('applied', false, 'reason', 'stale_event'); end if;
  if v_claim = 'conflict' then
    return jsonb_build_object('applied', false, 'reason', 'needs_reconcile', 'subscription_id', p_sub_id);
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
    stripe_subscription_id            = null
  where id = b.id;

  return jsonb_build_object('applied', true, 'reason', 'retired', 'business_id', b.id,
                            'owner_id', b.owner_id, 'name', b.name,
                            'tier_before', b.subscription_tier);
end;
$function$;

revoke execute on function public.claim_subscription_event(text, bigint, text, boolean)                                   from anon, authenticated, public;
revoke execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint, boolean) from anon, authenticated, public;
revoke execute on function public.retire_subscription(text, bigint, boolean)                                              from anon, authenticated, public;
grant  execute on function public.claim_subscription_event(text, bigint, text, boolean)                                   to service_role;
grant  execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint, boolean) to service_role;
grant  execute on function public.retire_subscription(text, bigint, boolean)                                              to service_role;

commit;

-- The 3-argument version this replaced returned boolean, so the new signature
-- created an OVERLOAD rather than replacing it — leaving the old
-- "prefer active" tie rule sitting in the database, callable. Drop it.
begin;
drop function if exists public.claim_subscription_event(text, bigint, text);
commit;

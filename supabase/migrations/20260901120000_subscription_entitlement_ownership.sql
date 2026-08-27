-- Paygate 10 — a subscription may only change entitlement it owns.
--
-- THE DEFECT
--
-- customer.subscription.created fires the moment a subscription is made, and
-- because the checkout uses payment_behavior: 'default_incomplete' its status
-- is 'incomplete' — nobody has paid anything. The webhook read that as "not
-- active", wrote subscription_tier = 'free' and subscription_until = null
-- against every business matching the customer, and stamped the pending
-- subscription id onto the row.
--
-- So a business holding temporary Boost Pro, or a Premium an admin had
-- granted, lost it by CLICKING Upgrade and closing the tab. Reproduced against
-- a disposable row: Pro until 2 September became free with no expiry, and the
-- id of a subscription that never took a penny was recorded as though it were
-- the business's plan.
--
-- The stamped id did further harm downstream. boost_entitlement_provenance
-- treats a non-null stripe_subscription_id as "a live subscription outranks
-- this", so a boost refund would silently decline to revoke; and
-- local-boost-checkout refuses to sell a boost to a business that appears to
-- be subscribed. An unpaid subscription was granting itself authority it had
-- never earned.
--
-- THE RULE
--
--   A subscription may change only the entitlement it OWNS.
--
-- It owns the entitlement when local_businesses.stripe_subscription_id is its
-- own id — which now happens only once it is genuinely active or trialing.
-- A subscription that has never activated owns nothing, so a non-active status
-- from it changes nothing at all.
--
-- This deliberately keeps the existing lapse behaviour: a subscription that
-- DID pay and then goes past_due, unpaid or canceled still owns the tier it
-- granted, and still takes it away.
--
-- Pending state is not lost by declining to write it here: Fix 1's
-- local_subscription_attempts registry records the pending subscription id
-- durably, and Stripe remains authoritative for its status.

begin;

create or replace function public.apply_subscription_state(
  p_sub_id              text,
  p_customer            text,
  p_status              text,
  p_tier                text,          -- resolved from the Stripe Price, or null if unrecognised
  p_period_end          timestamptz,
  p_cancel_at_period_end boolean
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_active  boolean := p_status in ('active', 'trialing');
  v_owned   public.local_businesses%rowtype;
  v_target  public.local_businesses%rowtype;
  v_tier    text;
begin
  if p_sub_id is null or btrim(p_sub_id) = '' then
    raise exception 'apply_subscription_state: a subscription id is required' using errcode = '22023';
  end if;

  -- Does this subscription already own a business's entitlement?
  select * into v_owned from public.local_businesses
   where stripe_subscription_id = p_sub_id for update;

  if not v_active then
    -- A subscription that never activated owns nothing, and must not touch a
    -- boost, a manual grant, or anybody else's plan.
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'not_owned', 'status', p_status);
    end if;

    -- It DID grant this tier, so it may take it away. Unchanged lapse
    -- behaviour for a subscription that genuinely paid and then stopped.
    update public.local_businesses set
      subscription_tier                 = 'free',
      subscription_until                = null,
      subscription_cancel_at_period_end = false
    where id = v_owned.id;

    return jsonb_build_object('applied', true, 'reason', 'owner_lapsed', 'status', p_status,
                              'business_id', v_owned.id, 'tier_before', v_owned.subscription_tier,
                              'tier_after', 'free');
  end if;

  -- Active or trialing. This is the point at which the subscription becomes
  -- authoritative and may replace a boost or a manual grant.
  if found then
    v_target := v_owned;
  else
    select * into v_target from public.local_businesses
     where stripe_customer_id = p_customer for update;
    if not found then
      return jsonb_build_object('applied', false, 'reason', 'no_business', 'status', p_status);
    end if;
  end if;

  -- An ACTIVE subscription on a price we do not recognise must not be read as
  -- "not paying". Keep whatever tier they had rather than stripping a paying
  -- customer's listing; the webhook shouts about the missing config key.
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

comment on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean) is
  'The single place a Stripe subscription event changes a business plan. A subscription may only change entitlement it owns — it owns it once active/trialing wrote its id — so a never-activated subscription cannot erase a boost or a manual grant. service_role only.';

revoke execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean) from anon, authenticated, public;
grant  execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean) to service_role;

commit;

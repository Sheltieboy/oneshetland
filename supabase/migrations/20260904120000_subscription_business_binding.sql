-- Paygate 10 — a Stripe Customer is the payer, not the business.
--
-- THE DEFECT
--
-- The subscription webhook found the business by asking
-- stripe_customer_id = subscription.customer, and local-subscription-intent
-- consolidated the payer's Customer onto whichever business was being bought
-- for. A partial UNIQUE index on that column then made one Customer belong to
-- at most one business.
--
-- One owner, two businesses, one saved card is an ordinary situation, and it
-- broke all three assumptions at once. Reproduced against disposable rows:
--
--   A already holds cus_U
--   owner subscribes B with the same card
--   → B's consolidation violates the unique index, and the error is not read
--   → B keeps no customer and receives nothing
--   → the webhook resolves cus_U to A, and A RECEIVES B's PREMIUM
--
-- The owner pays for one business and a different one gets the plan.
--
-- THE MODEL
--
--   Stripe Customer     = who pays. May legitimately be shared by every
--                         business the same person owns, using one saved card.
--   Stripe Subscription = the entitlement. Belongs to exactly one business.
--
-- So the Customer stops being an identity and the uniqueness comes off. A
-- subscription is resolved to its business by evidence the server itself
-- wrote, in this order:
--
--   1. local_businesses.stripe_subscription_id — an established subscription,
--      which is also how subscriptions predating the attempt registry stay
--      resolvable without inventing history for them;
--   2. local_subscription_attempts.business_id — written by the checkout
--      against the authenticated owner before Stripe was ever called;
--   3. nothing. Never the customer.
--
-- Stripe's own subscription metadata carries business_id, authored by the same
-- checkout. It is used as a cross-check rather than an authority: if it and the
-- registry disagree, that is not a case to resolve by preference, so it fails
-- closed and the event is left for a person.

begin;

-- ── The Customer is payer information, not identity ─────────────────────────
drop index if exists public.local_businesses_stripe_customer_uniq;
create index if not exists idx_local_businesses_stripe_customer
  on public.local_businesses (stripe_customer_id) where stripe_customer_id is not null;

comment on column public.local_businesses.stripe_customer_id is
  'The Stripe Customer that PAYS for this business. Deliberately not unique: one owner may pay for several businesses with one saved card. Never used to decide which business a subscription entitles.';

create index if not exists idx_local_subscription_attempts_sub
  on public.local_subscription_attempts (stripe_subscription_id)
  where stripe_subscription_id is not null;

/**
 * Which business does this subscription entitle?
 *
 * Returns the business id, or null with a reason. Never guesses, and never
 * looks at the customer.
 */
create or replace function public.resolve_subscription_business(
  p_sub_id        text,
  p_meta_business uuid default null
) returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_established uuid; v_attempt uuid; v_resolved uuid;
begin
  if p_sub_id is null or btrim(p_sub_id) = '' then
    return jsonb_build_object('business_id', null, 'reason', 'no_subscription_id');
  end if;

  select id into v_established from public.local_businesses
   where stripe_subscription_id = p_sub_id;

  select business_id into v_attempt from public.local_subscription_attempts
   where stripe_subscription_id = p_sub_id
   order by created_at desc limit 1;

  -- Established wins: it is the binding this system has already acted on. The
  -- registry is how a subscription that has never activated is found.
  v_resolved := coalesce(v_established, v_attempt);

  if v_resolved is null then
    return jsonb_build_object('business_id', null, 'reason', 'unknown_subscription');
  end if;

  -- Two server-authored records disagreeing is not a preference to express.
  if v_established is not null and v_attempt is not null
     and v_established is distinct from v_attempt then
    return jsonb_build_object('business_id', null, 'reason', 'binding_conflict');
  end if;
  if p_meta_business is not null and p_meta_business is distinct from v_resolved then
    return jsonb_build_object('business_id', null, 'reason', 'metadata_conflict');
  end if;

  return jsonb_build_object('business_id', v_resolved,
                            'reason', case when v_established is not null then 'established' else 'attempt' end);
end;
$function$;

-- ── The entitlement writer, bound to the subscription ───────────────────────
drop function if exists public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint, boolean);

create or replace function public.apply_subscription_state(
  p_sub_id               text,
  p_customer             text,
  p_status               text,
  p_tier                 text,
  p_period_end           timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created        bigint  default null,
  p_force                boolean default false,
  p_meta_business        uuid    default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_active   boolean := p_status in ('active', 'trialing');
  v_claim    text;
  v_bind     jsonb;
  v_biz_id   uuid;
  v_target   public.local_businesses%rowtype;
  v_tier     text;
begin
  if p_sub_id is null or btrim(p_sub_id) = '' then
    raise exception 'apply_subscription_state: a subscription id is required' using errcode = '22023';
  end if;

  v_claim := public.claim_subscription_event(p_sub_id, p_event_created, p_status, p_force);
  if v_claim = 'stale' then
    return jsonb_build_object('applied', false, 'reason', 'stale_event', 'status', p_status);
  end if;
  if v_claim = 'conflict' then
    return jsonb_build_object('applied', false, 'reason', 'needs_reconcile',
                              'status', p_status, 'subscription_id', p_sub_id);
  end if;

  v_bind := public.resolve_subscription_business(p_sub_id, p_meta_business);
  v_biz_id := nullif(v_bind->>'business_id', '')::uuid;

  if v_biz_id is null then
    -- A customer we happen to know is not a reason to entitle anybody.
    return jsonb_build_object('applied', false, 'reason', v_bind->>'reason', 'status', p_status);
  end if;

  select * into v_target from public.local_businesses where id = v_biz_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_business', 'status', p_status);
  end if;

  if not v_active then
    -- Only a subscription that actually granted this tier may take it away.
    if v_target.stripe_subscription_id is distinct from p_sub_id then
      return jsonb_build_object('applied', false, 'reason', 'not_owned', 'status', p_status);
    end if;
    update public.local_businesses set
      subscription_tier                 = 'free',
      subscription_until                = null,
      subscription_cancel_at_period_end = false
    where id = v_target.id;
    return jsonb_build_object('applied', true, 'reason', 'owner_lapsed', 'status', p_status,
                              'business_id', v_target.id, 'tier_before', v_target.subscription_tier,
                              'tier_after', 'free');
  end if;

  v_tier := coalesce(p_tier, v_target.subscription_tier, 'free');

  update public.local_businesses set
    subscription_tier                 = v_tier,
    subscription_until                = p_period_end,
    subscription_cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    stripe_subscription_id            = p_sub_id,
    stripe_customer_id                = coalesce(p_customer, stripe_customer_id)
  where id = v_target.id;

  return jsonb_build_object('applied', true, 'reason', 'active', 'status', p_status,
                            'business_id', v_target.id, 'tier_before', v_target.subscription_tier,
                            'tier_after', v_tier, 'until', p_period_end,
                            'bound_by', v_bind->>'reason');
end;
$function$;

revoke execute on function public.resolve_subscription_business(text, uuid) from anon, authenticated, public;
grant  execute on function public.resolve_subscription_business(text, uuid) to service_role;
revoke execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint, boolean, uuid) from anon, authenticated, public;
grant  execute on function public.apply_subscription_state(text, text, text, text, timestamptz, boolean, bigint, boolean, uuid) to service_role;

commit;

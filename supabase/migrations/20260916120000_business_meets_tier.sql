-- ═══════════════════════════════════════════════════════════════════════════
-- Does this business currently meet a required subscription tier?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One primitive, no consumers. Paid-tier entitlement is presently enforced by
-- the web redirecting and the app not drawing the button — which is not a
-- boundary. When enforcement is added at activation and transaction points,
-- every one of those points needs the same answer to the same question, and it
-- should be answered once.
--
-- ── What it deliberately does NOT decide ───────────────────────────────────
--
-- Ownership. Commercial terms. Whether the business is active. Whether a
-- product is active. Capability intent, configuration or public visibility.
-- Those compose around it: a later activation guard reads roughly
--
--     owner AND business_may_transact(...) AND business_meets_tier(..., 'pro')
--
-- and each half stays independently testable. This function knows about
-- subscriptions and nothing else.
--
-- ── Why a tier and not a feature key ───────────────────────────────────────
--
-- The obvious shape was business_has_feature(business, 'products'). That would
-- put the feature→tier map in the database as a third copy beside the web and
-- mobile TIER_FEATURES, and three copies of a mapping is how the four that
-- disagreed before listing-tiers.ts came about. Each enforcement point already
-- knows which tier it needs; it can say so.
--
-- ── Effective, not recorded ────────────────────────────────────────────────
--
-- subscription_tier alone is not entitlement. It is written by
-- apply_subscription_state from Stripe webhooks and by apply_boost_entitlement
-- from boost purchases, and both set subscription_until alongside it. Nothing
-- sweeps expiry: there is no scheduled reconciler, so a webhook that never
-- arrives leaves a business recorded as 'pro' indefinitely past the period it
-- paid for. Reading the expiry here answers the question correctly without
-- needing a job that can itself fall behind, and gives cancel-at-period-end
-- its intended meaning for free — the tier is retained until the paid period
-- actually ends.
--
-- A paid tier with subscription_until IS NULL is therefore NOT entitled. This
-- was checked rather than assumed: both writers set an expiry whenever they
-- grant a paid tier, and the only such row in production is a seeded demo
-- fixture. If an operator grant with no end date is ever wanted, it needs a
-- deliberate representation — not the absence of a value.
create or replace function public.business_meets_tier(
  p_business_id   uuid,
  p_required_tier text
) returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_required int;
  v_actual   int;
  v_tier     text;
  v_until    timestamptz;
begin
  -- An unknown tier is a programming mistake, and the one thing it must never
  -- do is quietly behave like 'free' and wave everything through. Same shape
  -- as the other argument checks in this schema.
  v_required := case p_required_tier
                  when 'free'    then 0
                  when 'pro'     then 1
                  when 'premium' then 2
                end;
  if v_required is null then
    raise exception 'business_meets_tier: unknown tier %, expected free, pro or premium',
      coalesce(p_required_tier, '(null)') using errcode = '22023';
  end if;

  if p_business_id is null then
    return false;
  end if;

  select subscription_tier, subscription_until
    into v_tier, v_until
    from public.local_businesses
   where id = p_business_id;

  if not found then
    return false;
  end if;

  -- Every real business meets free, whatever it is paying.
  if v_required = 0 then
    return true;
  end if;

  v_actual := case v_tier
                when 'premium' then 2
                when 'pro'     then 1
                else 0
              end;

  if v_actual < v_required then
    return false;
  end if;

  -- Recorded high enough; is it still live?
  return v_until is not null and v_until > now();
end;
$$;

comment on function public.business_meets_tier(uuid, text) is
  'True when the business currently meets the required subscription tier (free < pro < premium), counting a paid tier only while subscription_until is still in the future. Decides subscriptions ONLY — not ownership, commercial terms, business active state or feature configuration; those compose around it. Raises on an unknown tier so a typo cannot silently grant entitlement.';

-- Callable by authenticated because the enforcement points that will consume
-- it are RLS policies and BEFORE triggers, which run as the calling user and
-- require EXECUTE — measured during W3I, not assumed. It discloses only
-- whether a business meets a tier, which its public listing already reflects.
-- No anon grant: nothing signed out has a reason to ask.
revoke execute on function public.business_meets_tier(uuid, text) from public;
grant  execute on function public.business_meets_tier(uuid, text) to authenticated, service_role;

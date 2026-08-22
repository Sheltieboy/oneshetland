-- Paygate 2 — the marketplace can be seen, and its sellers can be paid.
--
-- TWO FAULTS, BOTH ALREADY SEEN ELSEWHERE.
--
-- 1. PRODUCTS WERE INVISIBLE TO SIGNED-OUT VISITORS
--
-- Exactly the events defect: an anonymous read of public.products or
-- public.product_variants failed outright with
--
--     42501: permission denied for table local_businesses
--
-- because their RLS policies check ownership and business activity by reading
-- local_businesses AS THE CALLER, and Step 8 withheld owner_id from anon.
-- lib/shop-data.ts wraps its queries in try/catch and returns [], so a hard
-- refusal rendered as "No products yet".
--
-- Same fix as the events policies: ask a SECURITY DEFINER predicate instead of
-- reading the table. Granting anon SELECT on owner_id would also have worked,
-- by publishing which user owns which business. Not that.
--
-- 2. NO SHOP COULD TAKE PAYMENT AT ALL
--
-- create-product-order-intent refused every basket with "This shop isn't quite
-- ready to take payments yet." It required business_stripe_account_id AND
-- business_stripe_payouts_enabled — a column pair that is set on ZERO
-- businesses in production. Not a problem with one shop: the whole marketplace
-- was unpurchasable, and it had no fallback to the owner's central account.
--
-- The product model, already settled for event tickets, is that a business uses
-- its owner's central bank unless it has explicitly been given its own.
-- _business_payout_resolve is that rule, in one place, and the event resolver
-- now calls it too so a business cannot be paid one way for a ticket and
-- another way for a jumper.

begin;

-- ── Predicates, so a policy need not read local_businesses as the caller ────
create or replace function public.is_business_active(p_business uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active); $$;

create or replace function public.is_product_business_owner(p_product uuid, p_user uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.products p
      join public.local_businesses b on b.id = p.business_id
     where p.id = p_product and b.owner_id = p_user
  );
$$;

revoke all on function public.is_business_active(uuid)              from public;
revoke all on function public.is_product_business_owner(uuid, uuid) from public;
grant execute on function public.is_business_active(uuid)              to anon, authenticated, service_role;
grant execute on function public.is_product_business_owner(uuid, uuid) to anon, authenticated, service_role;

-- ── One payout rule for a business, whatever it is selling ─────────────────
create or replace function public._business_payout_resolve(p_business uuid)
returns table (account_id text, is_demo boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select
    case
      -- The business overrides only when it has BEEN GIVEN its own payout
      -- account and that account works. use_business_payout is the explicit
      -- switch the business settings screen writes.
      --
      -- Two column pairs exist. stripe_account_id/payout_enabled is the one
      -- carrying real data; business_stripe_account_id/business_stripe_payouts_
      -- enabled is a parallel set that is populated on no business at all, and
      -- requiring it is what made every shop unpayable. Either counts.
      when coalesce(b.use_business_payout, false)
       and coalesce(b.payout_enabled, false)
       and b.stripe_account_id is not null
        then b.stripe_account_id
      when coalesce(b.use_business_payout, false)
       and coalesce(b.business_stripe_payouts_enabled, false)
       and b.business_stripe_account_id is not null
        then b.business_stripe_account_id
      -- Otherwise inherit the owner's central account, from profiles or from
      -- driver_profiles where the Fetch onboarding historically wrote it.
      else (
        select coalesce(
          case when pr.stripe_payouts_enabled and pr.stripe_account_id is not null then pr.stripe_account_id end,
          case when d.stripe_payouts_enabled  and d.stripe_account_id  is not null then d.stripe_account_id  end)
          from public.profiles pr
          left join public.driver_profiles d on d.id = pr.id
         where pr.id = b.owner_id
      )
    end as account_id,
    coalesce(b.slug, '') like 'demo-%' as is_demo
  from public.local_businesses b
  where b.id = p_business;
$$;

-- Safe for any viewer: one boolean, no identifiers.
create or replace function public.business_payout_ready(p_business uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select coalesce((select r.account_id is not null from public._business_payout_resolve(p_business) r), false); $$;

-- Returns a raw Stripe account id, so it is server-only.
create or replace function public.business_payout_destination(p_business uuid)
returns table (account_id text, is_demo boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$ select r.account_id, r.is_demo from public._business_payout_resolve(p_business) r; $$;

revoke all on function public._business_payout_resolve(uuid)   from public, anon, authenticated;
revoke all on function public.business_payout_destination(uuid) from public, anon, authenticated;
revoke all on function public.business_payout_ready(uuid)       from public;
grant execute on function public._business_payout_resolve(uuid)   to service_role;
grant execute on function public.business_payout_destination(uuid) to service_role;
grant execute on function public.business_payout_ready(uuid)       to anon, authenticated, service_role;

-- The event resolver now defers to the same rule for a business organiser, so a
-- business cannot be paid one way for a ticket and another way for a jumper.
create or replace function public._event_payout_resolve(p_event_id uuid)
returns table (account_id text, is_demo boolean, all_free boolean)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_acct  text := null;
  v_demo  boolean := false;
  v_free  boolean := false;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then
    return query select null::text, false, false;
    return;
  end if;

  -- A wholly free event needs no payout route at all.
  select coalesce(bool_and(t.price_pence = 0), false) into v_free
    from public.event_ticket_types t
   where t.event_id = p_event_id and t.is_active;

  if v_event.organiser_hub_id is not null then
    select case when h.payout_enabled and h.stripe_account_id is not null
                then h.stripe_account_id else null end,
           coalesce(h.slug, '') like 'demo-%'
      into v_acct, v_demo
      from public.hubs h
     where h.id = v_event.organiser_hub_id;

  elsif v_event.organiser_business_id is not null then
    select r.account_id, r.is_demo into v_acct, v_demo
      from public._business_payout_resolve(v_event.organiser_business_id) r;
  end if;

  return query select v_acct, coalesce(v_demo, false), coalesce(v_free, false);
end;
$$;

-- ── products / product_variants: stop reading local_businesses as the caller ─
alter policy "public reads live products" on public.products
  using (is_active AND public.is_business_active(business_id));

alter policy "owner manages products" on public.products
  using (public.is_business_owner(business_id, auth.uid()))
  with check (public.is_business_owner(business_id, auth.uid()));

alter policy "owner manages variants" on public.product_variants
  using (public.is_product_business_owner(product_id, auth.uid()))
  with check (public.is_product_business_owner(product_id, auth.uid()));

commit;

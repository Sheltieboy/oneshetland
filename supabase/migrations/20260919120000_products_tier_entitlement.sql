-- ═══════════════════════════════════════════════════════════════════════════
-- Selling is Premium, and the Shop stops taking the client's word for it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Products are Premium. Until now that was a redirect on one page and a button
-- the app declined to draw. Nothing below the UI asked: the public read policy
-- is `is_active and is_business_active(...)`, and create-product-order-intent
-- checked the product was active and the business existed. A business could
-- lapse and keep selling.
--
-- ── Where the boundary goes ────────────────────────────────────────────────
--
-- EXPOSURE     the public read policy. Six separate loaders on the website
--              read products — shop browse, related items, the individual
--              product, the home shelf, the visiting planner, the OG image —
--              plus the app. Filtering in each of them would be six places to
--              forget and a seventh when someone adds a loader. The policy is
--              one place, and it covers direct links, search and every future
--              caller for nothing.
--
-- ACTIVATION   a product may only BE active while its business is entitled.
--
-- PURCHASE     checked again at the order, because an active row is not proof
--              of anything by the time somebody clicks buy.
--
-- ── Terms are already handled ──────────────────────────────────────────────
--
-- Unlike accepts_bookings, products ARE one of W3I's nine guarded tables:
-- commercial_terms_guard already requires current acceptance for every insert
-- and every update except a pure withdrawal. So this guard adds tier only, and
-- the two compose by name — commercial_terms_guard sorts before
-- products_tier_guard, so an owner who has done neither is told about the
-- terms first.
--
-- ── What stays open ────────────────────────────────────────────────────────
--
-- Withdrawal. is_active true → false needs no plan, exactly as W3I needs no
-- terms for it. Never trap an owner with something publicly for sale.
--
-- Drafts. A product that is not active can be created and edited below
-- Premium, which is what the later setup-before-upgrade flow needs. W3I still
-- requires terms for those writes; tier does not.

-- ── 1. Exposure ────────────────────────────────────────────────────────────
--
-- anon needs EXECUTE because this policy is evaluated for signed-out readers.
-- The foundation slice granted authenticated and service_role only, on the
-- grounds that nothing signed out had a reason to ask. It does now, and it
-- discloses nothing new: whether a business meets Premium is exactly what the
-- visibility of its products already tells you.
grant execute on function public.business_meets_tier(uuid, text) to anon;

alter policy "public reads live products" on public.products
  using (
    is_active
    and public.is_business_active(business_id)
    and public.business_meets_tier(business_id, 'premium')
  );

-- ── 2. Activation ──────────────────────────────────────────────────────────
create or replace function public.products_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  -- Not active: a draft. Below Premium this is exactly what we want to allow,
  -- and W3I still decides whether the owner may write it at all.
  if new.is_active is not true then
    return new;
  end if;

  if TG_OP = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return new;                       -- nothing changed
  end if;

  if v_uid is null then
    return new;                       -- service role, webhooks, scheduled jobs
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;                       -- platform staff, deliberately
  end if;

  if not public.business_meets_tier(new.business_id, 'premium') then
    raise exception 'Selling needs a Premium plan. Your product is saved — publish it once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.products_tier_guard() is
  'A product may only be active while its business currently meets Premium. Inactive products — drafts — are untouched, and withdrawing an active one is always allowed. Terms are not checked here: products are a W3I-guarded table, so commercial_terms_guard already requires current acceptance.';

drop trigger if exists products_tier_guard on public.products;
create trigger products_tier_guard
  before insert or update on public.products
  for each row execute function public.products_tier_guard();

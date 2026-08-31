-- ═══════════════════════════════════════════════════════════════════════════
-- Passes are Premium too — but what somebody already bought is theirs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Third and last of the Premium/Pro sales surfaces. Passes and packs live in
-- book_unit_items, are 'premium' in TIER_FEATURES on both clients, and were
-- enforced by the same two things as the others: a redirect on the web and a
-- button the app declined to draw.
--
-- ── The line this one has to get right ─────────────────────────────────────
--
-- A pass is not like a product. A product is a thing for sale; a pass is a
-- thing for sale AND a promise already made to somebody who paid. Those need
-- opposite treatment when a subscription lapses:
--
--   selling new passes    stops
--   passes already sold   keep working, in full, on their original terms
--
-- So the guards go on book_unit_items — the thing being offered — and NOTHING
-- goes on book_unit_purchases. A customer with three swims left has three
-- swims left, and the business must still be able to redeem them. The
-- redemption path is an UPDATE on book_unit_purchases by the business, and it
-- is deliberately left alone; a test asserts it stays that way.
--
-- ── Where the boundary goes ────────────────────────────────────────────────
--
-- EXPOSURE     the public arm of the read policy. Same reasoning as products:
--              one place rather than every loader, and it covers direct links
--              and the app for nothing. The owner's arm is untouched, so a
--              business always sees its own configuration.
--
-- ACTIVATION   a pass may only BE active while the business is entitled.
--
-- PURCHASE     checked in create-unit-purchase-intent, BEFORE the
--              PaymentIntent. Deliberately NOT in confirm-unit-purchase: that
--              runs after Stripe has already taken the money, and refusing
--              there would charge somebody and withhold the pass. If a
--              business lapses between the two, the customer paid and is owed
--              what they bought.
--
-- ── Terms ──────────────────────────────────────────────────────────────────
--
-- book_unit_items is already one of W3I's nine guarded tables, so acceptance
-- is required for every write except a pure withdrawal. This adds tier only,
-- and the two compose by name — commercial_terms_guard sorts before
-- unit_items_tier_guard.

-- ── 1. Exposure ────────────────────────────────────────────────────────────
alter policy "Anyone can read active unit items" on public.book_unit_items
  using (
    (is_active = true and public.business_meets_tier(business_id, 'premium'))
    or public.is_business_owner(business_id, auth.uid())
  );

-- ── 2. Activation ──────────────────────────────────────────────────────────
create or replace function public.book_unit_items_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if new.is_active is not true then
    return new;                       -- unpublished; the later draft flow needs this
  end if;

  if TG_OP = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return new;
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
    raise exception 'Selling passes needs a Premium plan. Your pass is saved — put it back on sale once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.book_unit_items_tier_guard() is
  'A pass may only be on sale while its business currently meets Premium. Unpublished passes are untouched and withdrawal is always allowed. Nothing here touches book_unit_purchases: units already bought are the customer''s, and stay redeemable whatever the seller''s plan does later.';

drop trigger if exists book_unit_items_tier_guard on public.book_unit_items;
create trigger book_unit_items_tier_guard
  before insert or update on public.book_unit_items
  for each row execute function public.book_unit_items_tier_guard();

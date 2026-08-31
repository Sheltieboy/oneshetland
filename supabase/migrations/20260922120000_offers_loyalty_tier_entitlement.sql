-- Offers and Loyalty are Pro. The last two paid capabilities to get a real
-- server boundary, and the pair where the two halves must be held apart
-- hardest: a business stops running its programme, but the stamps a customer
-- already walked in and earned are not the business's to take back.
--
-- Four enforcement points, and one silent skip:
--
--   local_offers_tier_guard            creating or commercially editing a live Offer
--   local_loyalty_programs_tier_guard  creating or commercially editing a live programme
--   local_loyalty_cards_tier_guard     the authoritative store of customer value
--   local_loyalty_transactions_...     the ledger, as defence in depth
--   tg_loyalty_earn_points             skips the award instead of aborting a payment
--
-- Terms are NOT re-checked here. commercial_terms_guard already sits on both
-- local_offers and local_loyalty_programs with the withdrawal spec
-- 'is_active=false', and fires first (triggers run in alphabetical order, and
-- 'c' precedes 'l'). Tier composes on top of W3I; it does not restate it.

-- ── Offers ──────────────────────────────────────────────────────────────────
create or replace function public.local_offers_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Never wired to DELETE. If it ever is, a BEFORE DELETE reading NEW would
  -- return null and silently skip the row instead of refusing it.
  if TG_OP = 'DELETE' then return old; end if;

  -- Server paths hold no JWT and are not the seller. Safe here because the
  -- RLS write policy on this table independently requires is_business_owner(),
  -- so anon cannot reach this trigger with a write at all.
  if v_uid is null then return new; end if;

  if exists (select 1 from public.profiles p
              where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text]))
  then return new; end if;

  if TG_OP = 'UPDATE' then
    -- Withdrawn, or being withdrawn. Always allowed, with or without a plan.
    -- Nobody gets trapped with an Offer customers can still see.
    if new.is_active is not true then return new; end if;

    -- Still active, and nothing commercial moved. Redemption counting lives
    -- here, and a customer redeeming is not the business trading up a tier.
    if old.is_active is true
       and new.title           is not distinct from old.title
       and new.description     is not distinct from old.description
       and new.image_url       is not distinct from old.image_url
       and new.discount_type   is not distinct from old.discount_type
       and new.discount_value  is not distinct from old.discount_value
       and new.valid_from      is not distinct from old.valid_from
       and new.valid_until     is not distinct from old.valid_until
       and new.terms           is not distinct from old.terms
       and new.max_redemptions is not distinct from old.max_redemptions
    then return new; end if;
  end if;

  if not public.business_meets_tier(new.business_id, 'pro') then
    raise exception 'Offers need a Pro plan. Your offer is saved — publish it once your plan is active.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists local_offers_tier_guard on public.local_offers;
create trigger local_offers_tier_guard
  before insert or update on public.local_offers
  for each row execute function public.local_offers_tier_guard();

-- ── Loyalty programme ───────────────────────────────────────────────────────
create or replace function public.local_loyalty_programs_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if TG_OP = 'DELETE' then return old; end if;
  if v_uid is null then return new; end if;

  if exists (select 1 from public.profiles p
              where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text]))
  then return new; end if;

  if TG_OP = 'UPDATE' then
    if new.is_active is not true then return new; end if;   -- stopping is free
    if old.is_active is true
       and new.type             is not distinct from old.type
       and new.stamps_required  is not distinct from old.stamps_required
       and new.stamp_reward     is not distinct from old.stamp_reward
       and new.points_per_pound is not distinct from old.points_per_pound
       and new.points_for_pound is not distinct from old.points_for_pound
       and new.reward_tiers     is not distinct from old.reward_tiers
    then return new; end if;
  end if;

  if not public.business_meets_tier(new.business_id, 'pro') then
    raise exception 'Loyalty needs a Pro plan. Your programme is saved — start it once your plan is active.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists local_loyalty_programs_tier_guard on public.local_loyalty_programs;
create trigger local_loyalty_programs_tier_guard
  before insert or update on public.local_loyalty_programs
  for each row execute function public.local_loyalty_programs_tier_guard();

-- ── Customer loyalty value ──────────────────────────────────────────────────
-- Deliberately NOT bypassed for the service role. There is no INSERT or UPDATE
-- policy on this table for any client role, so every write already arrives from
-- a server path: the Till, NFC, stamp-collect, and the wallet-spend trigger.
-- The server path IS the award path, so exempting it would exempt everything.
--
-- Only an INCREASE is gated. Redemption, correction and remediation all move
-- the balance down or leave it alone, and none of them needs a plan.
create or replace function public.local_loyalty_cards_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then return old; end if;

  if TG_OP = 'INSERT' then
    if coalesce(new.stamps_collected, 0) <= 0
       and coalesce(new.points_balance, 0) <= 0
    then return new; end if;                       -- an empty card holds nothing
  else
    if coalesce(new.stamps_collected, 0) <= coalesce(old.stamps_collected, 0)
       and coalesce(new.points_balance, 0) <= coalesce(old.points_balance, 0)
    then return new; end if;                       -- unchanged, or spent
  end if;

  if public.business_meets_tier(new.business_id, 'pro') then return new; end if;

  -- Says nothing about a plan, a bill or an expiry date. The customer is not
  -- owed the shop's subscription state.
  raise exception 'This business is not currently running its loyalty programme'
    using errcode = '42501';
end;
$$;

drop trigger if exists local_loyalty_cards_tier_guard on public.local_loyalty_cards;
create trigger local_loyalty_cards_tier_guard
  before insert or update on public.local_loyalty_cards
  for each row execute function public.local_loyalty_cards_tier_guard();

-- The ledger, as defence in depth. Earning types only; 'reward' and 'redeem'
-- are a customer spending what they hold and are never gated.
create or replace function public.local_loyalty_transactions_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then return old; end if;
  if new.type is null or new.type not in ('stamp', 'points_earn') then return new; end if;
  if public.business_meets_tier(new.business_id, 'pro') then return new; end if;
  raise exception 'This business is not currently running its loyalty programme'
    using errcode = '42501';
end;
$$;

drop trigger if exists local_loyalty_transactions_tier_guard on public.local_loyalty_transactions;
create trigger local_loyalty_transactions_tier_guard
  before insert on public.local_loyalty_transactions
  for each row execute function public.local_loyalty_transactions_tier_guard();

-- ── The wallet-spend award path ─────────────────────────────────────────────
-- This is an AFTER INSERT trigger on local_wallet_transactions. It must SKIP
-- the award rather than raise: raising here would roll back the customer's
-- payment because their shop's loyalty plan lapsed. The money is not the thing
-- being gated.
create or replace function public.tg_loyalty_earn_points()
 returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  prog   record;
  pts    integer;
  cardid uuid;
begin
  if new.type <> 'spend' or new.business_id is null or coalesce(new.amount_pence, 0) <= 0 then
    return new;
  end if;

  -- No plan, no new loyalty value. Silently, so the payment still completes.
  if not public.business_meets_tier(new.business_id, 'pro') then
    return new;
  end if;

  select * into prog from public.local_loyalty_programs
    where business_id = new.business_id and is_active = true and type = 'points'
    limit 1;
  if not found then return new; end if;

  pts := floor((new.amount_pence / 100.0) * coalesce(prog.points_per_pound, 0));
  if pts <= 0 then return new; end if;

  select id into cardid from public.local_loyalty_cards
    where user_id = new.user_id and program_id = prog.id
    limit 1;

  if cardid is null then
    insert into public.local_loyalty_cards (user_id, program_id, business_id, points_balance, last_stamp_at)
    values (new.user_id, prog.id, new.business_id, pts, now())
    returning id into cardid;
  else
    update public.local_loyalty_cards
       set points_balance = coalesce(points_balance, 0) + pts, last_stamp_at = now()
     where id = cardid;
  end if;

  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
    values (cardid, new.user_id, new.business_id, 'points_earn', pts, 'Earned on spend');

  return new;
end $$;

-- ── Customer-facing presentation ────────────────────────────────────────────
-- One authoritative boundary each, in the data layer. No client recomputes an
-- expiry date, and a listing of any size still costs one query. Owners keep
-- their own configuration through the separate owner policies.
drop policy if exists "Anyone can read active offers" on public.local_offers;
create policy "Anyone can read active offers" on public.local_offers
  for select using (
    (is_active = true and public.business_meets_tier(business_id, 'pro'))
    or public.is_business_owner(business_id, auth.uid())
  );

drop policy if exists "Anyone can read active loyalty programs" on public.local_loyalty_programs;
create policy "Anyone can read active loyalty programs" on public.local_loyalty_programs
  for select using (
    is_active = true and public.business_meets_tier(business_id, 'pro')
  );

-- The NFC tile is SECURITY DEFINER and answers past RLS, so the policy above
-- cannot reach it. Only the loyalty half is changed here.
create or replace function public.resolve_nfc_tile(p_token text)
 returns table(business_id uuid, business_name text, accepts_wallet boolean, payout_ready boolean,
               cashback_percent numeric, has_loyalty boolean, program_type text, stamp_reward text)
 language sql stable security definer set search_path to 'public' as $$
  SELECT b.id,
         b.name,
         coalesce(b.accepts_wallet, false),
         (b.stripe_account_id IS NOT NULL AND coalesce(b.payout_enabled, false)),
         b.cashback_percent,
         (p.id IS NOT NULL),
         p.type,
         p.stamp_reward
  FROM public.local_businesses b
  LEFT JOIN public.local_loyalty_programs p
    ON p.business_id = b.id AND p.is_active = true
   AND public.business_meets_tier(b.id, 'pro')
  WHERE b.nfc_token = p_token
  LIMIT 1;
$$;

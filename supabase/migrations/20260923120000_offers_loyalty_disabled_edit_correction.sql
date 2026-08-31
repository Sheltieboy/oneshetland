-- Reduction-only withdrawal for Offers and Loyalty.
--
-- The guards shipped in 20260922120000 asked only whether the RESULTING row was
-- inactive. That let an under-tier owner rewrite a stopped Offer or programme
-- in full and simply switch it back on the day their plan returned, which is
-- the setup-before-upgrade path GATE BEFORE SETUP exists to close. It also let
-- a commercial change ride along inside the same statement as a deactivation.
--
-- Only two updates are now free of tier:
--
--   1. a genuine withdrawal: active -> inactive, with no commercial field
--      moving in the same statement;
--   2. a statement that moves no commercial field and does not touch is_active
--      at all -- server bookkeeping such as local_offers.redemption_count.
--
-- Everything else -- creating, editing while live, editing while stopped,
-- reactivating -- needs effective Pro. This mirrors W3I's own shape, where
-- withdrawal is permitted and commercial mutation is not; W3I itself is
-- unchanged, still fires first, and is still independently required.
--
-- Customer value is untouched by this migration. local_loyalty_cards and
-- local_loyalty_transactions keep exactly the guards they already had:
-- new value cannot be minted below Pro, and redemption, reward-honouring and
-- downward correction stay open regardless of any plan.

create or replace function public.local_offers_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_commercial_changed boolean;
begin
  if TG_OP = 'DELETE' then return old; end if;

  -- Server paths hold no JWT and are not the seller. Safe because the RLS write
  -- policy on this table independently requires is_business_owner().
  if v_uid is null then return new; end if;

  if exists (select 1 from public.profiles p
              where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text]))
  then return new; end if;

  if TG_OP = 'UPDATE' then
    v_commercial_changed :=
         new.business_id     is distinct from old.business_id
      or new.title           is distinct from old.title
      or new.description     is distinct from old.description
      or new.image_url       is distinct from old.image_url
      or new.discount_type   is distinct from old.discount_type
      or new.discount_value  is distinct from old.discount_value
      or new.valid_from      is distinct from old.valid_from
      or new.valid_until     is distinct from old.valid_until
      or new.terms           is distinct from old.terms
      or new.max_redemptions is distinct from old.max_redemptions;

    if not v_commercial_changed then
      -- A genuine withdrawal, and nothing rode along with it.
      if old.is_active is true and new.is_active is not true then
        return new;
      end if;
      -- Touches no commercial field and does not move is_active: redemption
      -- counting, and nothing that prepares the Offer for a future launch.
      if new.is_active is not distinct from old.is_active then
        return new;
      end if;
    end if;
  end if;

  if not public.business_meets_tier(new.business_id, 'pro') then
    raise exception 'Offers need a Pro plan. Your offer is saved — you can take it down now, or change it once your plan is active.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.local_loyalty_programs_tier_guard()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_commercial_changed boolean;
begin
  if TG_OP = 'DELETE' then return old; end if;
  if v_uid is null then return new; end if;

  if exists (select 1 from public.profiles p
              where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text]))
  then return new; end if;

  if TG_OP = 'UPDATE' then
    v_commercial_changed :=
         new.business_id     is distinct from old.business_id
      or new.type            is distinct from old.type
      or new.stamps_required is distinct from old.stamps_required
      or new.stamp_reward    is distinct from old.stamp_reward
      or new.points_per_pound is distinct from old.points_per_pound
      or new.points_for_pound is distinct from old.points_for_pound
      or new.reward_tiers    is distinct from old.reward_tiers;

    if not v_commercial_changed then
      if old.is_active is true and new.is_active is not true then
        return new;
      end if;
      if new.is_active is not distinct from old.is_active then
        return new;
      end if;
    end if;
  end if;

  if not public.business_meets_tier(new.business_id, 'pro') then
    raise exception 'Loyalty needs a Pro plan. Your programme is saved — you can stop it now, or change it once your plan is active.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

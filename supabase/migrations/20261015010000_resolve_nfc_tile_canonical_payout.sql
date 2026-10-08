-- resolve_nfc_tile's payout_ready column read stripe_account_id/payout_enabled
-- directly, which has no owner-central-account fallback. A business that only
-- sells through its owner's central account (fully payable via products, event
-- tickets and, as of this migration, passes/gifts/Wallet) was told by the NFC
-- tile that Wallet payout was not ready, even though it genuinely was.
--
-- business_payout_ready(uuid) is that one rule, already shared by events and
-- products, and — as of this migration — every other business money-moving
-- path. Nothing else in the tile changes: routing, cashback, loyalty and the
-- business lookup are all untouched, and the returned column keeps its name
-- and position.

create or replace function public.resolve_nfc_tile(p_token text)
 returns table(business_id uuid, business_name text, accepts_wallet boolean, payout_ready boolean,
               cashback_percent numeric, has_loyalty boolean, program_type text, stamp_reward text)
 language sql stable security definer set search_path to 'public' as $$
  SELECT b.id,
         b.name,
         coalesce(public.wallet_live(b), false),
         public.business_payout_ready(b.id),
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

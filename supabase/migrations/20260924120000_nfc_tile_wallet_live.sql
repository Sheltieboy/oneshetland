-- The NFC tile answers whether Wallet is available NOW, not whether a flag was
-- once set.
--
-- resolve_nfc_tile is SECURITY DEFINER, so it answers past the RLS and computed
-- column boundaries that carry Wallet presentation everywhere else. It returned
-- coalesce(b.accepts_wallet, false) raw, which meant a tapped tile could still
-- advertise Wallet for a business whose stored flag stayed true after its Pro
-- entitlement expired. The payment itself was always refused by
-- executeWalletPayment, so this was a presentation inconsistency and never a
-- funds or entitlement bypass -- but the tile was still making an offer the
-- platform would not honour.
--
-- The fix reuses wallet_live(local_businesses), which is the same server truth
-- the directory, the browse list and the business detail screen already read:
-- the stored flag AND the business being active AND business_meets_tier(id,
-- 'pro'). Nothing here restates that rule or does expiry arithmetic of its own,
-- so the tile cannot drift from the rest of Wallet presentation.
--
-- The returned column keeps its name and position. Callers see the same shape;
-- only the answer gets more honest. The Loyalty entitlement added in
-- 20260922120000 is carried through unchanged, and nothing else in the tile --
-- routing, payout readiness, cashback, the business lookup -- is touched.

create or replace function public.resolve_nfc_tile(p_token text)
 returns table(business_id uuid, business_name text, accepts_wallet boolean, payout_ready boolean,
               cashback_percent numeric, has_loyalty boolean, program_type text, stamp_reward text)
 language sql stable security definer set search_path to 'public' as $$
  SELECT b.id,
         b.name,
         coalesce(public.wallet_live(b), false),
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

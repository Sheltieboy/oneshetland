-- resolve_nfc_tile — turn a tapped NFC tile token into the business + what it
-- offers, so the tile landing can show "You're at <business>" with the right
-- actions (collect stamp / pay). SECURITY DEFINER because nfc_token isn't a
-- public column; returns only non-sensitive display info.

CREATE OR REPLACE FUNCTION public.resolve_nfc_tile(p_token text)
RETURNS TABLE (
  business_id      uuid,
  business_name    text,
  accepts_wallet   boolean,
  payout_ready     boolean,
  cashback_percent numeric,
  has_loyalty      boolean,
  program_type     text,
  stamp_reward     text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
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
  WHERE b.nfc_token = p_token
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_nfc_tile(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_nfc_tile(text) TO authenticated;

-- ── 033_wallet_transaction_fee.sql ──────────────────────────────────────────
--
-- Surfaces incoming wallet payments to the business owner who received them.
--
-- Two parts:
--   1. Add platform_fee_pence to local_wallet_transactions so the historical
--      fee is preserved. The fee is computed at payment time (see
--      _shared/commission.ts) and would silently drift if we re-derived it
--      from the current admin_config — so we store it at write time.
--      Nullable: legacy rows from before this migration stay NULL and the UI
--      shows "—" for them.
--
--   2. SECURITY DEFINER RPC get_business_wallet_receipts(business_id, limit)
--      that returns the data the business dashboard needs. This avoids
--      widening the profiles RLS surface — the function runs as definer and
--      returns only the safe customer fields (first name, no email/phone).
--      Authorisation: caller must own the business.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.local_wallet_transactions
  ADD COLUMN IF NOT EXISTS platform_fee_pence INT
    CHECK (platform_fee_pence IS NULL OR platform_fee_pence >= 0);

-- Receipts are filtered by business; index supports the common path:
-- "show this business's recent spend transactions".
CREATE INDEX IF NOT EXISTS idx_local_wallet_transactions_business_spend
  ON public.local_wallet_transactions(business_id, created_at DESC)
  WHERE type = 'spend';

CREATE OR REPLACE FUNCTION public.get_business_wallet_receipts(
  p_business_id UUID,
  p_limit       INT DEFAULT 20
)
RETURNS TABLE (
  id                   UUID,
  created_at           TIMESTAMPTZ,
  gross_pence          INT,      -- abs(amount_pence) — what the customer paid from their wallet
  fee_pence            INT,      -- NULL for legacy rows
  net_pence            INT,      -- gross − fee; NULL for legacy rows
  customer_first_name  TEXT,
  stripe_transfer_id   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Without this directive Postgres treats the RETURNS TABLE column names
-- (id, created_at, ...) as variables that shadow column references like
-- t.id and p.id, raising "column reference id is ambiguous".
#variable_conflict use_column
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  -- Caller must own the business
  IF NOT EXISTS (
    SELECT 1 FROM public.local_businesses
     WHERE id = p_business_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'not_business_owner';
  END IF;

  RETURN QUERY
    SELECT
      t.id,
      t.created_at,
      ABS(t.amount_pence)                                       AS gross_pence,
      t.platform_fee_pence                                      AS fee_pence,
      CASE WHEN t.platform_fee_pence IS NULL
           THEN NULL
           ELSE ABS(t.amount_pence) - t.platform_fee_pence
      END                                                       AS net_pence,
      NULLIF(split_part(COALESCE(p.full_name, ''), ' ', 1), '') AS customer_first_name,
      t.stripe_transfer_id
    FROM public.local_wallet_transactions t
    LEFT JOIN public.profiles p ON p.id = t.user_id
    WHERE t.business_id = p_business_id
      AND t.type        = 'spend'
    ORDER BY t.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_business_wallet_receipts(UUID, INT) TO authenticated;

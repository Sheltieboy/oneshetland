-- ── 034_wallet_cashback_business_funded.sql ─────────────────────────────────
--
-- Cashback is now BUSINESS-FUNDED, not platform-funded.
--
-- Before this migration: the customer got the cashback as a wallet credit but
-- it was implicitly subsidised by the platform — the business's transfer was
-- not reduced. That made every cashback rate a direct cost to OneShetland.
--
-- After this migration:
--   transfer_to_business = amount − platform_fee − cashback
-- The business pays for the loyalty incentive they set, the platform retains
-- only its commission, and the customer's wallet still gets the credit.
--
-- This file:
--   1. Adds local_wallet_transactions.cashback_pence so the historical
--      cashback on each row is preserved (same reasoning as platform_fee_pence
--      in migration 033 — admin rate can drift).
--   2. Updates the get_business_wallet_receipts RPC so the dashboard surfaces
--      cashback alongside fee, and net = gross − fee − cashback.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.local_wallet_transactions
  ADD COLUMN IF NOT EXISTS cashback_pence INT
    CHECK (cashback_pence IS NULL OR cashback_pence >= 0);

-- The function's RETURNS TABLE shape grows here (adds cashback_pence) — Postgres
-- doesn't allow CREATE OR REPLACE to change the row type, so drop the prior
-- definition first.
DROP FUNCTION IF EXISTS public.get_business_wallet_receipts(UUID, INT);

CREATE OR REPLACE FUNCTION public.get_business_wallet_receipts(
  p_business_id UUID,
  p_limit       INT DEFAULT 20
)
RETURNS TABLE (
  id                   UUID,
  created_at           TIMESTAMPTZ,
  gross_pence          INT,      -- abs(amount_pence) — what the customer paid from their wallet
  fee_pence            INT,      -- platform commission retained; NULL for pre-033 rows
  cashback_pence       INT,      -- cashback the business funded; NULL for pre-034 rows
  net_pence            INT,      -- gross − fee − cashback; NULL if fee unknown
  customer_first_name  TEXT,
  stripe_transfer_id   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

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
      t.cashback_pence                                          AS cashback_pence,
      CASE WHEN t.platform_fee_pence IS NULL
           THEN NULL
           ELSE ABS(t.amount_pence) - t.platform_fee_pence - COALESCE(t.cashback_pence, 0)
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

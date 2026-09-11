-- Wallet charge-by-scan: let the merchant cancel a still-pending request
-- server-side, so "Cancel" in the till actually kills it instead of only
-- hiding it on the merchant's own screen while the customer could still
-- approve it — see supabase/functions/wallet-charge-cancel.
--
-- 'cancelled' joins the existing pending/charging/paid/declined/expired/failed
-- set. Nothing else about the state machine changes: wallet-charge-approve's
-- own claim-to-charging step (`update ... where status = 'pending'`) already
-- refuses any request whose status has moved on — cancelled included, the
-- moment it's a value Postgres will accept. No RLS change: only the service
-- role writes this table (see 20260729030000_wallet_charge_requests.sql),
-- and wallet-charge-cancel runs as service role, exactly like the two
-- existing charge-by-scan functions.

ALTER TABLE public.wallet_charge_requests
  DROP CONSTRAINT wallet_charge_requests_status_check,
  ADD CONSTRAINT wallet_charge_requests_status_check
    CHECK (status IN ('pending','charging','paid','declined','expired','failed','cancelled'));

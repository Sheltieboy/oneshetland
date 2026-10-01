-- Scan-to-charge: a liquidity preflight refusal is not a payment failure.
--
-- A merchant's £1.00 scan-to-charge request, approved by the customer while
-- the platform was in Critical liquidity state, was correctly declined BEFORE
-- any debit — no spend row, no refund row, no transfer attempt. But
-- wallet-charge-approve settled the request to the same generic 'failed'
-- status a genuine Stripe transfer rejection gets, so both screens rendered
-- it as a destructive red "Payment failed (not charged)" / customer error —
-- indistinguishable from a real failure, even though nothing failed: the
-- system correctly refused to even try.
--
-- This widens wallet_charge_requests' own status enum with a distinct value
-- so the two cases are never collapsed into one on this table either,
-- matching the equally distinct 'liquidity_unavailable' reason
-- executeWalletPayment already returns (see wallet-pay.ts).
--
-- No existing status value, no column, no other constraint changes.

alter table public.wallet_charge_requests
  drop constraint wallet_charge_requests_status_check;

alter table public.wallet_charge_requests
  add constraint wallet_charge_requests_status_check
  check (status = ANY (ARRAY['pending'::text, 'charging'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'failed'::text, 'cancelled'::text, 'liquidity_unavailable'::text]));

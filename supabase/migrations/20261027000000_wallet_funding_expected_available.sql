-- When Stripe says a received funding transfer becomes transferable. Shown to
-- the operator while a session is pending_at_stripe. Additive and nullable.
alter table public.wallet_liquidity_funding_sessions
  add column if not exists expected_available_at timestamptz;

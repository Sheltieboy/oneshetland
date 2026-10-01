-- Admin-controlled Wallet reserve funding, 1 Oct 2026.
--
-- The operator should be able to manage Local Wallet liquidity from Admin
-- rather than hand-calculating amounts and navigating Stripe. This adds:
--
--   1. A configurable "desired spend headroom" on top of the reserve — the
--      recommended funding target is reserve + headroom, not merely the
--      reserve itself (reaching the reserve alone still permits no
--      transfer — see the earlier wallet-liquidity reporting fix).
--   2. A ledger of every funding attempt (wallet_liquidity_topups), which
--      doubles as the admin audit trail: who initiated it, for how much,
--      against what reserve/headroom target, and what Stripe said.
--
-- wallet.liquidity.funding_enabled defaults to 'false'. A live capability
-- check (read-only: GET /v1/account, GET /v1/topups, no POST) found no
-- external bank-account source on the platform account, no topup-related
-- capability flag, and zero prior topups — strong evidence against
-- programmatic Topup creation being set up today, but this cannot be
-- PROVEN without either a real POST (explicitly out of scope) or Stripe
-- support confirming it. Admin Configuration stays the switch: flip this to
-- 'true' only once that is confirmed with Stripe directly.
--
-- Nothing about the Wallet preflight, the reservation mechanism, or any
-- payment/transfer/refund path changes.

insert into public.admin_config (key, value, description, category)
values
  ('wallet.liquidity.desired_headroom_pence', '5000',
   'Local Wallet liquidity — spendable headroom ABOVE the reserve that OneShetland aims to keep funded, in pence (5000 = £50.00). The recommended funding amount targets reserve + this headroom, not merely the reserve — reaching the reserve alone still permits no transfer.',
   'fees'),
  ('wallet.liquidity.funding_enabled', 'false',
   'Local Wallet liquidity — "true" enables the admin "Fund Wallet reserve" action, which creates a real Stripe Topup. Leave "false" until Stripe has confirmed programmatic Topup creation is actually enabled for this platform account — a live capability check found no external bank-account source and no topup capability flag, but could not prove it either way without a real POST. While false, Admin shows funding instructions for the Stripe Dashboard instead.',
   'fees')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, category = excluded.category;

-- ── The funding ledger / audit trail ─────────────────────────────────────
--
-- client_request_id is the idempotency key: a duplicate submission (a
-- double-tap, a retried request) hits the UNIQUE constraint and the
-- function returns the EXISTING row rather than creating a second Stripe
-- Topup. The same value is also sent to Stripe as its own Idempotency-Key
-- header, so even a request that reached Stripe but lost its response
-- replays to the same Topup rather than creating a second one.
create table if not exists public.wallet_liquidity_topups (
  id                     uuid primary key default gen_random_uuid(),
  client_request_id      text not null,
  stripe_topup_id        text,
  amount_pence           integer not null check (amount_pence > 0),
  status                 text not null default 'creating'
                           check (status in ('creating', 'pending', 'succeeded', 'failed', 'canceled', 'reversed', 'error')),
  initiated_by           uuid not null references auth.users(id),
  reserve_target_pence   integer not null,
  desired_headroom_pence integer not null,
  failure_message        text,
  expected_availability_date date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists idx_wallet_liquidity_topups_client_request_id
  on public.wallet_liquidity_topups (client_request_id);

create index if not exists idx_wallet_liquidity_topups_created_at
  on public.wallet_liquidity_topups (created_at desc);

revoke all on public.wallet_liquidity_topups from public, anon, authenticated;
alter table public.wallet_liquidity_topups enable row level security;
-- No policies: service_role (used only by the admin-gated Edge Functions)
-- bypasses RLS; everyone else is default-denied. Never queried directly by
-- any client — always through wallet-liquidity-snapshot /
-- wallet-liquidity-fund, which check admin status themselves.

-- Wallet reserve funding by PUSH bank transfer.
--
-- Stripe's live Dashboard offers this GB platform account only "Transfer from
-- your bank" (FPS ~2h / BACS 2-3 days) for the Payments balance — no linked
-- bank debit — so POST /v1/topups cannot initiate funding. The operator sends
-- the transfer from the OneShetland business bank; OneShetland calculates the
-- amount, holds the Stripe-provided beneficiary details, records the
-- operator's intent, and detects arrival itself.
--
-- wallet.liquidity.funding_enabled stays 'false' (programmatic Topups remain
-- built behind that flag, untouched).
--
-- Everything below is service_role only: RLS on, no policies, all grants
-- revoked. Only admin-gated Edge Functions read or write these tables.

insert into public.admin_config (key, value, description, category) values
  ('wallet.liquidity.funding_session_expiry_hours', '168',
   'Wallet reserve funding — how long an "awaiting_funds" session waits for the bank transfer to show up at Stripe before it is marked expired/unresolved. BACS can take 2-3 business days, so the default is 7 days.',
   'fees')
on conflict (key) do update
  set value = excluded.value, description = excluded.description, category = excluded.category;

-- ── Stripe push-funding beneficiary details ─────────────────────────────────
-- Stripe exposes no API for the platform's own Payments-balance funding bank
-- details, so an admin enters them once. Singleton row (id is always true).
create table if not exists public.wallet_funding_bank_details (
  id             boolean primary key default true check (id),
  beneficiary    text not null check (char_length(beneficiary) between 1 and 120),
  account_number text not null check (account_number ~ '^[0-9]{8}$'),
  sort_code      text not null check (sort_code ~ '^[0-9]{6}$'),
  instructions   text check (instructions is null or char_length(instructions) <= 600),
  updated_by     uuid not null references auth.users(id),
  updated_at     timestamptz not null default now()
);

-- Audit trail of edits. Deliberately stores WHO and WHICH FIELDS changed plus
-- the last four digits of the account number — never the full details.
create table if not exists public.wallet_funding_bank_details_audit (
  id                    uuid primary key default gen_random_uuid(),
  changed_by            uuid not null references auth.users(id),
  changed_at            timestamptz not null default now(),
  changed_fields        text[] not null,
  account_number_last4  text
);
create index if not exists idx_wallet_funding_bank_details_audit_changed_at
  on public.wallet_funding_bank_details_audit (changed_at desc);

-- ── Funding sessions ───────────────────────────────────────────────────────
-- A session records the operator's INTENT ("I'm sending this transfer") so
-- OneShetland can recognise the money when it lands. It moves no money and
-- touches no customer Wallet balance.
create table if not exists public.wallet_liquidity_funding_sessions (
  id                         uuid primary key default gen_random_uuid(),
  client_request_id          text not null,
  requested_amount_pence     integer not null check (requested_amount_pence > 0),
  target_available_pence     integer not null,
  baseline_available_pence   integer not null,
  baseline_pending_pence     integer not null,
  reserve_target_pence       integer not null,
  desired_headroom_pence     integer not null,
  initiated_by               uuid not null references auth.users(id),
  status                     text not null default 'awaiting_funds'
                               check (status in ('awaiting_funds', 'pending_at_stripe', 'available', 'expired', 'cancelled', 'failed')),
  matched_ref                text,
  matched_kind               text check (matched_kind is null or matched_kind in ('topup', 'balance_transaction')),
  received_amount_pence      integer,
  received_at                timestamptz,
  available_at               timestamptz,
  resolution_note            text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- Double-submit protection.
create unique index if not exists idx_wallet_funding_sessions_client_request_id
  on public.wallet_liquidity_funding_sessions (client_request_id);

-- At most ONE open session at a time, so an arriving credit can only ever be
-- attributed to a single intent.
create unique index if not exists idx_wallet_funding_sessions_one_open
  on public.wallet_liquidity_funding_sessions ((true))
  where status in ('awaiting_funds', 'pending_at_stripe');

-- One Stripe object can satisfy at most one session.
create unique index if not exists idx_wallet_funding_sessions_matched_ref
  on public.wallet_liquidity_funding_sessions (matched_ref)
  where matched_ref is not null;

create index if not exists idx_wallet_funding_sessions_created_at
  on public.wallet_liquidity_funding_sessions (created_at desc);

revoke all on public.wallet_funding_bank_details from public, anon, authenticated;
revoke all on public.wallet_funding_bank_details_audit from public, anon, authenticated;
revoke all on public.wallet_liquidity_funding_sessions from public, anon, authenticated;
alter table public.wallet_funding_bank_details enable row level security;
alter table public.wallet_funding_bank_details_audit enable row level security;
alter table public.wallet_liquidity_funding_sessions enable row level security;

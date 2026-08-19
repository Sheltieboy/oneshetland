-- ============================================================================
-- A double-tap at the till could debit the wallet twice.
--
-- executeWalletPayment debits BEFORE it transfers, and wallet_debit is atomic
-- but not idempotent. wallet-charge-approve is safe because it claims its
-- charge-request row (pending -> charging) before spending, and passes that row
-- id to Stripe as the idempotency key. local-wallet-pay — the till-code and
-- NFC-tile path — has no row to claim, and passed a fresh random idempotency
-- key each time. Two taps, or one tap and an automatic retry after a slow
-- response, therefore meant two debits and two transfers.
--
-- Note that a Stripe idempotency key alone would not have fixed this: the debit
-- happens first, so a deduplicated transfer would have left the customer down
-- twice with the business paid once. The claim has to be taken before the money
-- moves, which is what this table is for.
--
-- Keyed on a client-generated id per payment ATTEMPT, so a genuine second
-- payment of the same amount at the same business a minute later carries a
-- different id and goes through. That is the difference between this and a
-- time-window heuristic, which cannot tell a double-tap from a second round.
--
-- The result is stored so a retry returns what the first call returned rather
-- than an error — from the customer's side the payment simply succeeded.
-- ============================================================================

create table if not exists public.wallet_payment_claims (
  client_request_id text        primary key,
  user_id           uuid        not null references public.profiles(id) on delete cascade,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  result            jsonb
);

create index if not exists wallet_payment_claims_user_idx
  on public.wallet_payment_claims (user_id, created_at desc);

-- Written only by the edge function on the service role, which bypasses RLS.
-- No policy is created, so a client holding the anon key can neither read
-- another person's claims nor forge one to block their payments.
alter table public.wallet_payment_claims enable row level security;

comment on table public.wallet_payment_claims is
  'One row per wallet payment attempt, claimed before the wallet is debited so a double-tap or retry cannot pay twice. client_request_id is generated per attempt by the caller.';

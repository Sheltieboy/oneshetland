-- Reconciliation ledger for the rare "paid but not fulfilled" case.
--
-- A few wallet purchases move money (debit the wallet + transfer to the hub /
-- business) and THEN grant the entitlement (membership, purchase, donation
-- record). If that final grant fails, the handler now automatically reverses the
-- transfer and refunds the wallet — and writes a row here either way:
--   • resolved = true  → money was fully returned, no action needed (audit trail)
--   • resolved = false → the auto-reversal itself failed; needs manual attention
--     so a customer is never silently left out of pocket.
--
-- Written to only by edge functions using the service-role key; RLS on with no
-- policies (an admin screen can read it via the service role later).

create table if not exists public.failed_fulfilments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  purpose           text not null,             -- hub_donation | hub_membership | unit_purchase
  recipient_id      uuid,                       -- hub or business id
  amount_pence      integer not null,           -- amount debited from the wallet
  transfer_id       text,                        -- Stripe transfer that was made (if any)
  transfer_reversed boolean not null default false,
  wallet_refunded   boolean not null default false,
  resolved          boolean not null default false,
  error             text,
  detail            jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists failed_fulfilments_unresolved_idx
  on public.failed_fulfilments (created_at desc) where resolved = false;

alter table public.failed_fulfilments enable row level security;

-- Generic idempotency ledger for client-confirmed Stripe PaymentIntents.
--
-- Some flows are finalised by a client call after Stripe succeeds (rather than
-- purely by the webhook). Recording the PaymentIntent id here — with the id as
-- the PRIMARY KEY — lets those handlers claim a payment exactly once: a replay
-- (double-tap, lost-response retry, or re-using an old succeeded payment) hits a
-- unique violation and is refused, so a single payment can never be redeemed for
-- more than one entitlement.
--
-- Written to only by edge functions using the service-role key. RLS is enabled
-- with no policies, so anon/authenticated clients cannot read or write it.

create table if not exists public.consumed_payment_intents (
  payment_intent_id text primary key,
  purpose           text not null,
  user_id           uuid references auth.users(id) on delete set null,
  consumed_at       timestamptz not null default now()
);

alter table public.consumed_payment_intents enable row level security;

-- Migration 003: Payment method tracking on profiles
-- Adds has_payment_method flag so customers must set up payment before requesting deliveries.
-- In MVP this is a simple boolean; a future migration will add stripe_customer_id
-- once Stripe Connect is wired up.

alter table profiles
  add column if not exists has_payment_method boolean not null default false,
  add column if not exists stripe_customer_id text;

-- Customers can update their own payment flag
create policy "Customers can update own payment flag"
  on profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Note: run this in the Supabase SQL Editor for the nkrtmakxygkvxuxriiil project

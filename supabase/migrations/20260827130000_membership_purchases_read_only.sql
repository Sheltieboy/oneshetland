-- The receipt table is read-only to clients at the privilege layer too.
--
-- Supabase grants every new table in `public` full DML to anon and
-- authenticated by default and relies on RLS to be the gate. That holds here —
-- hub_membership_purchases has a SELECT policy and no write policy, so writes
-- are refused — but a financial record should not depend on a single layer.
-- Only service_role, which fulfilment runs as, may write one.

begin;

revoke insert, update, delete, truncate, references, trigger
  on public.hub_membership_purchases from anon, authenticated;

grant select on public.hub_membership_purchases to authenticated;

commit;

-- Boost purchases become visible to the people entitled to see them.
--
-- local_boost_purchases has been written by the checkout and the webhook since
-- the product existed, and read by nothing: a business paid £7 and the payment
-- left no trace it could point at. The row already holds every fact the owner
-- needs — duration, amount, when, and the expiry it bought — so this adds no
-- columns. It only opens the reading of them.
--
-- Two changes, both narrow:
--   * a platform admin may read boost purchases, for support and disputes, the
--     same way they may read membership purchases;
--   * the table is made read-only to clients at the privilege layer as well as
--     the policy layer. Supabase grants every new table full DML to anon and
--     authenticated by default and leans on RLS; that holds here — there is no
--     write policy — but a financial record should not rest on one layer.

begin;

drop policy if exists "boost purchases admin read" on public.local_boost_purchases;
create policy "boost purchases admin read" on public.local_boost_purchases
  for select to authenticated
  using (public.is_admin());

revoke insert, update, delete, truncate, references, trigger
  on public.local_boost_purchases from anon, authenticated;

grant select on public.local_boost_purchases to authenticated;

commit;

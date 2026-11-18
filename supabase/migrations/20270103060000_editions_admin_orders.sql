-- Editions: the administrator can see an Edition's package orders (to refund or explain them). Read-only, admin-only. The orders table stays owner-only for everyone else.
-- Expand-only. Rollback: supabase/rollbacks/20270103060000_editions_admin_orders.rollback.sql
create or replace function public.admin_edition_orders(p_edition uuid) returns table (order_id uuid, package_name text, status text, amount_pence integer, refunded_pence integer, free boolean, created_at timestamptz, paid_at timestamptz, buyer_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select o.id, o.package_snapshot ->> 'name', o.status, o.amount_pence, o.refunded_pence, coalesce((o.package_snapshot ->> 'is_free')::boolean, false), o.created_at, o.paid_at,
                      (select p.full_name from public.profiles p where p.id = o.buyer_id)
                 from public.edition_orders o where o.edition_id = p_edition order by o.created_at desc;
end $$;
revoke all on function public.admin_edition_orders(uuid) from public, anon, authenticated;
grant execute on function public.admin_edition_orders(uuid) to authenticated;
